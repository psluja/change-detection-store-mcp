import { fileURLToPath } from 'node:url';

import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { Construct as BaseConstruct } from 'constructs';

import type { ChangeDetectionTableConstruct } from '../storage/change-detection-table-construct.js';

export interface McpFunctionProps {
  readonly table: ChangeDetectionTableConstruct;
  /** Cognito wiring for the runtime env (non-secret identifiers only). */
  readonly userPoolId: string;
  readonly cognitoDomainUrl: string;
  readonly requiredGroupName: string;
  /** Deterministic name of the client-credentials secret (see CognitoAuthConstruct). */
  readonly clientCredentialsSecretName: string;
  /** Shared stack CMK: encrypts logs; the function needs decrypt for the secret. */
  readonly encryptionKey: kms.IKey;
}

/**
 * Infrastructure metrics (Lambda) plus DOMAIN metrics emitted by the
 * application itself via CloudWatch EMF — dashboards/alarms consume these,
 * never raw resources or raw namespaces.
 */
export interface McpFunctionMetrics {
  readonly invocations: () => cloudwatch.IMetric;
  readonly errors: () => cloudwatch.IMetric;
  readonly throttles: () => cloudwatch.IMetric;
  readonly durationP95: () => cloudwatch.IMetric;
  /** All tool invocations (success or not), service-level rollup. */
  readonly toolCalls: () => cloudwatch.IMetric;
  /** Per-tool call series (SEARCH expression — dashboards only, not alarms). */
  readonly toolCallsByTool: () => cloudwatch.IMetric;
  /** Typed, client-fixable domain errors returned by tools. */
  readonly toolErrors: () => cloudwatch.IMetric;
  /** Unexpected errors masked as INTERNAL_ERROR — bugs; expected zero. */
  readonly internalErrors: () => cloudwatch.IMetric;
  /** Patch calls that wrote a new version. */
  readonly changesDetected: () => cloudwatch.IMetric;
  /** Patch calls that found nothing new (the cheap, desired outcome). */
  readonly unchangedCalls: () => cloudwatch.IMetric;
  /** Share of patch calls that wrote, in percent. */
  readonly changeRate: () => cloudwatch.IMetric;
  /** OAuth gate rejections: invalid token (401). */
  readonly authUnauthorized: () => cloudwatch.IMetric;
  /** OAuth gate rejections: valid user without the required group (403). */
  readonly authForbidden: () => cloudwatch.IMetric;
}

/** Keep in sync with NAMESPACE in app/src/infrastructure/telemetry/emf-telemetry.ts. */
const APP_METRICS_NAMESPACE = 'ChangeDetectionStore';

/** Hard concurrency ceiling: cost/DoS bound for a Function URL without WAF. */
const RESERVED_CONCURRENCY = 10;

/**
 * The single application Lambda behind a Function URL (no API Gateway, per
 * specification): serves MCP, the OAuth proxy endpoints and the JWT gate.
 * AuthType is NONE because authorization happens in-app (OAuth 2.0 — the
 * Cowork connector cannot sign SigV4). The construct owns every permission
 * the function needs: table access, secret read, KMS decrypt.
 */
export class McpFunctionConstruct extends BaseConstruct {
  readonly fn: NodejsFunction;
  readonly functionUrl: lambda.FunctionUrl;

  constructor(scope: Construct, id: string, props: McpFunctionProps) {
    super(scope, id);

    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: logs.RetentionDays.ONE_YEAR,
      encryptionKey: props.encryptionKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // The secret is created AFTER this function (its value contains the app
    // client created after the Function URL), so referencing the secret
    // resource here would form a CloudFormation cycle. The IAM grant uses a
    // name-based ARN pattern; the runtime uses the plain NAME as SecretId —
    // a partial ARN (without the random suffix) FAILS IAM evaluation on
    // GetSecretValue (verified empirically), a name resolves correctly.
    const stack = cdk.Stack.of(this);
    const secretArnPattern = `arn:${stack.partition}:secretsmanager:${stack.region}:${stack.account}:secret:${props.clientCredentialsSecretName}*`;

    this.fn = new NodejsFunction(this, 'Handler', {
      entry: fileURLToPath(new URL('../../../../app/src/lambda.ts', import.meta.url)),
      depsLockFilePath: fileURLToPath(new URL('../../../../package-lock.json', import.meta.url)),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: RESERVED_CONCURRENCY,
      logGroup,
      environment: {
        CDS_TABLE_NAME: props.table.table.tableName,
        CDS_USER_POOL_ID: props.userPoolId,
        CDS_COGNITO_DOMAIN: props.cognitoDomainUrl,
        CDS_CLIENT_SECRET_ID: props.clientCredentialsSecretName,
        CDS_REQUIRED_GROUP: props.requiredGroupName,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        format: OutputFormat.CJS,
        target: 'node22',
        sourceMap: true,
        externalModules: [], // bundle everything, including the AWS SDK — reproducible artifacts
      },
    });

    // Permissions this function needs — and nothing else.
    props.table.grantReadWrite(this.fn);
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ReadCognitoClientCredentialsSecret',
        actions: ['secretsmanager:GetSecretValue'],
        resources: [secretArnPattern],
      }),
    );
    props.encryptionKey.grantDecrypt(this.fn);

    this.functionUrl = this.fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.BUFFERED,
    });
  }

  metrics(): McpFunctionMetrics {
    const period = cdk.Duration.minutes(5);
    const app = (metricName: string, label: string, color?: string): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: APP_METRICS_NAMESPACE,
        metricName,
        statistic: 'sum',
        period,
        label,
        ...(color === undefined ? {} : { color }),
      });
    const changesDetected = (): cloudwatch.Metric =>
      app('ChangesDetected', 'Changes detected', cloudwatch.Color.GREEN);
    const unchangedCalls = (): cloudwatch.Metric =>
      app('UnchangedCalls', 'Unchanged (no write)', cloudwatch.Color.GREY);
    return {
      invocations: () => this.fn.metricInvocations({ statistic: 'sum', period }),
      errors: () => this.fn.metricErrors({ statistic: 'sum', period, color: cloudwatch.Color.RED }),
      throttles: () =>
        this.fn.metricThrottles({ statistic: 'sum', period, color: cloudwatch.Color.ORANGE }),
      durationP95: () => this.fn.metricDuration({ statistic: 'p95', period, label: 'p95' }),
      toolCalls: () => app('ToolCalls', 'Tool calls'),
      toolCallsByTool: () =>
        new cloudwatch.MathExpression({
          expression: `SEARCH('{${APP_METRICS_NAMESPACE},Tool} MetricName="ToolCalls"', 'Sum')`,
          usingMetrics: {},
          label: '',
          period,
        }),
      toolErrors: () => app('ToolErrors', 'Tool errors (typed)', cloudwatch.Color.ORANGE),
      internalErrors: () => app('InternalErrors', 'Internal errors', cloudwatch.Color.RED),
      changesDetected,
      unchangedCalls,
      changeRate: () =>
        new cloudwatch.MathExpression({
          expression: '100 * changes / (changes + unchanged)',
          usingMetrics: { changes: changesDetected(), unchanged: unchangedCalls() },
          label: 'Change rate %',
          color: cloudwatch.Color.GREEN,
          period,
        }),
      authUnauthorized: () => app('AuthUnauthorized', '401 invalid token', cloudwatch.Color.ORANGE),
      authForbidden: () => app('AuthForbidden', '403 no group', cloudwatch.Color.RED),
    };
  }
}
