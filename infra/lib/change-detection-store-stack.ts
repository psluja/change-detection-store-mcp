import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as appregistry from 'aws-cdk-lib/aws-servicecatalogappregistry';
import type { Construct } from 'constructs';

import { McpFunctionConstruct } from './constructs/api/mcp-function-construct.js';
import { CognitoAuthConstruct } from './constructs/auth/cognito-auth-construct.js';
import { ServiceMonitoringConstruct } from './constructs/monitoring/service-monitoring-construct.js';
import { ChangeDetectionTableConstruct } from './constructs/storage/change-detection-table-construct.js';

const ALLOWED_GROUP_NAME = 'cds-allowed';

/**
 * Change Detection Store: a change-detecting JSON store exposed as an MCP
 * server for the Claude Cowork connector.
 *
 *   Cowork ── MCP + OAuth 2.0 ──▶ Lambda (Function URL) ──▶ DynamoDB (PK+SK)
 *                                   │
 *                                   ├─▶ Cognito (hosted UI, group authz)
 *                                   └─▶ Secrets Manager (client credentials)
 *
 * The stack only wires constructs together; every construct owns its own
 * permissions and boundaries and exposes domain metrics via `metrics()`.
 */
export class ChangeDetectionStoreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('Project', 'ChangeDetectionStoreMCP');
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('SecurityProfile', 'ProdGrade');

    // AWS myApplications / AppRegistry: groups every resource of this stack
    // into one "application" with its own cost view in Cost Explorer (filter
    // by the awsApplication tag). The application resource itself must be
    // excluded from the tag aspect — tagging it with its own tag value would
    // be a self-referential dependency.
    const application = new appregistry.CfnApplication(this, 'Application', {
      name: 'ChangeDetectionStore',
      description: 'Change-detection JSON store exposed as an MCP server (Cowork connector)',
    });
    cdk.Tags.of(this).add('awsApplication', application.attrApplicationTagValue, {
      excludeResourceTypes: ['AWS::ServiceCatalogAppRegistry::Application'],
    });

    // Shared CMK with auto-rotation for the table, logs and the credentials
    // secret. Data key — never auto-deleted.
    const sharedKey = new kms.Key(this, 'SharedKey', {
      description: 'Shared CMK for Change Detection Store: DynamoDB, logs, secrets',
      enableKeyRotation: true,
      alias: 'alias/cds/shared',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    // CloudWatch Logs must be able to use the key for encrypted log groups.
    sharedKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchLogsToUseKey',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
        actions: [
          'kms:Encrypt*',
          'kms:Decrypt*',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:Describe*',
        ],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': `arn:${this.partition}:logs:${this.region}:${this.account}:*`,
          },
        },
      }),
    );

    const storage = new ChangeDetectionTableConstruct(this, 'Storage', {
      encryptionKey: sharedKey,
    });

    const auth = new CognitoAuthConstruct(this, 'Auth', {
      domainPrefix: `cds-auth-${this.account}`,
      allowedGroupName: ALLOWED_GROUP_NAME,
      encryptionKey: sharedKey,
    });

    const api = new McpFunctionConstruct(this, 'Api', {
      table: storage,
      userPoolId: auth.userPool.userPoolId,
      cognitoDomainUrl: auth.hostedDomainUrl,
      requiredGroupName: ALLOWED_GROUP_NAME,
      clientCredentialsSecretName: CognitoAuthConstruct.CLIENT_CREDENTIALS_SECRET_NAME,
      encryptionKey: sharedKey,
    });

    // The app client needs the Function URL as its callback — attach it now.
    // (Function URL attributes end with a trailing slash.)
    auth.attachCoworkClient(`${api.functionUrl.url}auth/callback`);

    const monitoring = new ServiceMonitoringConstruct(this, 'Monitoring', {
      api,
      table: storage,
    });

    // --- Outputs: everything needed to connect from Cowork ---
    new cdk.CfnOutput(this, 'McpEndpoint', {
      value: `${api.functionUrl.url}mcp`,
      description: 'MCP server URL — paste into Cowork custom connector',
    });
    new cdk.CfnOutput(this, 'CoworkClientId', {
      value: auth.coworkClient.userPoolClientId,
      description: 'OAuth Client ID — paste into Cowork Advanced settings',
    });
    new cdk.CfnOutput(this, 'CognitoUserPoolId', {
      value: auth.userPool.userPoolId,
      description: 'Cognito user pool ID (user management scripts)',
    });
    new cdk.CfnOutput(this, 'CognitoHostedDomain', {
      value: auth.hostedDomainUrl,
      description: 'Cognito hosted UI base URL',
    });
    new cdk.CfnOutput(this, 'ClientCredentialsSecretName', {
      value: CognitoAuthConstruct.CLIENT_CREDENTIALS_SECRET_NAME,
      description: 'Secrets Manager secret with the app client credentials',
    });
    new cdk.CfnOutput(this, 'AlarmTopicArn', {
      value: monitoring.alarmTopic.topicArn,
      description: 'SNS topic for alarms — subscribe your email',
    });
    new cdk.CfnOutput(this, 'AwsApplicationArn', {
      value: application.attrArn,
      description: 'AppRegistry application (myApplications dashboard + per-app cost view)',
    });
  }
}
