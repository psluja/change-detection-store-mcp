import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';

import { ChangeDetectionStoreStack } from '../lib/change-detection-store-stack.js';

let template: Template;

beforeAll(() => {
  // Same feature flags as `cdk synth` uses, for template parity.
  const cdkJson = JSON.parse(
    readFileSync(fileURLToPath(new URL('../cdk.json', import.meta.url)), 'utf8'),
  ) as { context: Record<string, unknown> };

  const app = new cdk.App({ context: cdkJson.context });
  const stack = new ChangeDetectionStoreStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'eu-central-1' },
  });
  template = Template.fromStack(stack);
});

describe('DynamoDB table', () => {
  it('is single-table PK+SK, on-demand, TTL-enabled, PITR, CMK, deletion-protected', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      SSESpecification: { SSEEnabled: true, KMSMasterKeyId: Match.anyValue() },
      DeletionProtectionEnabled: true,
    });
  });

  it('has no GSI or LSI', () => {
    const tables = template.findResources('AWS::DynamoDB::Table');
    for (const table of Object.values(tables)) {
      const properties = table.Properties as Record<string, unknown>;
      expect(properties.GlobalSecondaryIndexes).toBeUndefined();
      expect(properties.LocalSecondaryIndexes).toBeUndefined();
    }
  });

  it('is retained on stack deletion', () => {
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });
});

describe('Cognito', () => {
  it('disables self-signup and enforces a strong password policy', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      Policies: {
        PasswordPolicy: Match.objectLike({
          MinimumLength: 12,
          RequireLowercase: true,
          RequireUppercase: true,
          RequireNumbers: true,
          RequireSymbols: true,
        }),
      },
    });
  });

  it('creates the authorization group and a code-flow client with a secret', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
      GroupName: 'cds-allowed',
    });
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: true,
      AllowedOAuthFlows: ['code'],
      AllowedOAuthScopes: Match.arrayWith(['openid', 'email', 'profile']),
      SupportedIdentityProviders: ['COGNITO'],
    });
  });

  it('stores the client credentials in the deterministic secret', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'cds/cognito-cowork-client',
      KmsKeyId: Match.anyValue(),
    });
  });
});

describe('MCP Lambda', () => {
  it('runs Node 22 on ARM with a reserved-concurrency ceiling and the expected env', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      ReservedConcurrentExecutions: 10,
      Environment: {
        Variables: Match.objectLike({
          CDS_TABLE_NAME: Match.anyValue(),
          CDS_USER_POOL_ID: Match.anyValue(),
          CDS_COGNITO_DOMAIN: Match.anyValue(),
          CDS_CLIENT_SECRET_ID: 'cds/cognito-cowork-client',
          CDS_REQUIRED_GROUP: 'cds-allowed',
        }),
      },
    });
  });

  it('exposes a Function URL without IAM auth (OAuth happens in-app)', () => {
    template.hasResourceProperties('AWS::Lambda::Url', {
      AuthType: 'NONE',
      InvokeMode: 'BUFFERED',
    });
  });

  it('keeps encrypted logs for one year', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 365,
      KmsKeyId: Match.anyValue(),
    });
  });

  it('can read only the client-credentials secret from Secrets Manager', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const statements = Object.values(policies).flatMap((policy) => {
      const document = (policy.Properties as { PolicyDocument: { Statement: unknown[] } })
        .PolicyDocument;
      return document.Statement as { Action: unknown; Resource?: unknown }[];
    });
    const secretStatements = statements.filter((statement) =>
      JSON.stringify(statement.Action).includes('secretsmanager'),
    );
    expect(secretStatements).toHaveLength(1);
    expect(JSON.stringify(secretStatements[0]?.Resource)).toContain('cds/cognito-cowork-client');
  });
});

describe('monitoring', () => {
  it('creates the alarms, the dashboard and the alarm topic', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 6);
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    template.resourceCountIs('AWS::SNS::Topic', 1);
  });

  it('alarms on application-level internal errors (domain metric)', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Threshold: 1,
      Metrics: Match.arrayWith([
        Match.objectLike({
          MetricStat: Match.objectLike({
            Metric: Match.objectLike({
              Namespace: 'ChangeDetectionStore',
              MetricName: 'InternalErrors',
            }),
          }),
        }),
      ]),
    });
  });

  it('documents how to read the dashboard, holistically and per section', () => {
    const body = JSON.stringify(template.toJSON());
    for (const phrase of [
      'Read top to bottom',
      'Read spikes together, not alone',
      'Change detection — the domain',
      'Errors & auth',
      'Service — Lambda',
      'Storage — DynamoDB',
    ]) {
      expect(body).toContain(phrase);
    }
  });
});

describe('encryption', () => {
  it('provisions the shared CMK with rotation, retained on deletion', () => {
    template.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
    template.hasResource('AWS::KMS::Key', { DeletionPolicy: 'Retain' });
  });
});

describe('application grouping and billing tags', () => {
  it('registers the AppRegistry application for myApplications', () => {
    template.hasResourceProperties('AWS::ServiceCatalogAppRegistry::Application', {
      Name: 'ChangeDetectionStore',
    });
  });

  it('tags resources with the project and awsApplication tags', () => {
    // CDK renders tags sorted case-insensitively; arrayWith matches a subsequence.
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      Tags: Match.arrayWith([
        Match.objectLike({ Key: 'awsApplication' }),
        { Key: 'ManagedBy', Value: 'CDK' },
        { Key: 'Project', Value: 'ChangeDetectionStoreMCP' },
        { Key: 'SecurityProfile', Value: 'ProdGrade' },
      ]),
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Tags: Match.arrayWith([Match.objectLike({ Key: 'awsApplication' })]),
    });
  });
});

describe('outputs', () => {
  it('exports everything needed to connect from Cowork', () => {
    for (const name of [
      'McpEndpoint',
      'CoworkClientId',
      'CognitoUserPoolId',
      'CognitoHostedDomain',
      'ClientCredentialsSecretName',
      'AlarmTopicArn',
      'AwsApplicationArn',
    ]) {
      template.hasOutput(name, Match.anyValue());
    }
  });
});
