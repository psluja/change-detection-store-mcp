import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as kms from 'aws-cdk-lib/aws-kms';
import type { Construct } from 'constructs';
import { Construct as BaseConstruct } from 'constructs';

export interface ChangeDetectionTableProps {
  /** Shared stack CMK; the table is encrypted with it. */
  readonly encryptionKey: kms.IKey;
}

/** Domain metrics contract — dashboards/alarms consume these, never raw resources. */
export interface ChangeDetectionTableMetrics {
  readonly consumedReads: () => cloudwatch.IMetric;
  readonly consumedWrites: () => cloudwatch.IMetric;
  readonly throttledRequests: () => cloudwatch.IMetric;
  readonly systemErrors: () => cloudwatch.IMetric;
}

const MONITORED_OPERATIONS = [
  dynamodb.Operation.GET_ITEM,
  dynamodb.Operation.QUERY,
  dynamodb.Operation.PUT_ITEM,
  dynamodb.Operation.UPDATE_ITEM,
  dynamodb.Operation.TRANSACT_WRITE_ITEMS,
];

/**
 * The single-table store (PK + SK only — no GSI/LSI, by specification):
 * on-demand billing, TTL-driven physical deletion (soft deletes and history
 * retention), point-in-time recovery, CMK encryption, deletion protection.
 * Owns its own data-safety posture; consumers get access via grantReadWrite().
 */
export class ChangeDetectionTableConstruct extends BaseConstruct {
  readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: ChangeDetectionTableProps) {
    super(scope, id);

    this.table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: props.encryptionKey,
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }

  /** Full item access for the application (includes the CMK grants). */
  grantReadWrite(grantee: cdk.aws_iam.IGrantable): void {
    this.table.grantReadWriteData(grantee);
  }

  metrics(): ChangeDetectionTableMetrics {
    const period = cdk.Duration.minutes(5);
    return {
      consumedReads: () => this.table.metricConsumedReadCapacityUnits({ period, statistic: 'sum' }),
      consumedWrites: () =>
        this.table.metricConsumedWriteCapacityUnits({ period, statistic: 'sum' }),
      throttledRequests: () =>
        this.table.metricThrottledRequestsForOperations({
          operations: MONITORED_OPERATIONS,
          period,
        }),
      systemErrors: () =>
        this.table.metricSystemErrorsForOperations({
          operations: MONITORED_OPERATIONS,
          period,
        }),
    };
  }
}
