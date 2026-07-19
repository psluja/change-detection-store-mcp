import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';
import { Construct as BaseConstruct } from 'constructs';

import type { McpFunctionConstruct } from '../api/mcp-function-construct.js';
import type { ChangeDetectionTableConstruct } from '../storage/change-detection-table-construct.js';

export interface ServiceMonitoringProps {
  readonly api: McpFunctionConstruct;
  readonly table: ChangeDetectionTableConstruct;
}

/**
 * Alarms + the `cds-health` dashboard: consumes EXCLUSIVELY the `metrics()`
 * of other constructs — never raw resources.
 * Every section carries a short English explanation of what the graphs mean
 * and how to read them together; the header explains the holistic read.
 * Alarms notify an SNS topic (ARN in stack outputs — subscribe your email).
 */
export class ServiceMonitoringConstruct extends BaseConstruct {
  readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: ServiceMonitoringProps) {
    super(scope, id);

    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      displayName: 'Change Detection Store alarms',
    });
    const notify = new cloudwatchActions.SnsAction(this.alarmTopic);

    const api = props.api.metrics();
    const table = props.table.metrics();

    // --- Alarms: the basics that should never fire on a healthy service ---
    const alarmDefaults = {
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    };
    const alarms = [
      new cloudwatch.Alarm(this, 'InternalErrors', {
        ...alarmDefaults,
        metric: api.internalErrors(),
        alarmDescription:
          'The application hit an unexpected error (masked to the client as INTERNAL_ERROR). This is a bug — expected zero. Check the Lambda log group for the tool_failure entry.',
      }),
      new cloudwatch.Alarm(this, 'LambdaErrors', {
        ...alarmDefaults,
        metric: api.errors(),
        alarmDescription:
          'The MCP Lambda crashed before producing a response (tool-level failures do NOT count here). Check the Lambda log group.',
      }),
      new cloudwatch.Alarm(this, 'LambdaThrottles', {
        ...alarmDefaults,
        metric: api.throttles(),
        alarmDescription:
          'Requests were rejected because the reserved-concurrency ceiling (10) was hit — sustained load or abuse of the public Function URL.',
      }),
      new cloudwatch.Alarm(this, 'LambdaSlow', {
        metric: api.durationP95(),
        threshold: cdk.Duration.seconds(5).toMilliseconds(),
        evaluationPeriods: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription:
          'p95 duration above 5 s for 15 minutes — look at DynamoDB throttles and large delete_store batches first.',
      }),
      new cloudwatch.Alarm(this, 'TableThrottles', {
        ...alarmDefaults,
        metric: table.throttledRequests(),
        alarmDescription:
          'DynamoDB throttled requests despite on-demand mode — usually a hot key under very heavy writes.',
      }),
      new cloudwatch.Alarm(this, 'TableSystemErrors', {
        ...alarmDefaults,
        metric: table.systemErrors(),
        alarmDescription: 'DynamoDB reported internal (5xx) errors — an AWS-side incident.',
      }),
    ];
    for (const alarm of alarms) {
      alarm.addAlarmAction(notify);
    }

    // --- Dashboard ---
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: 'cds-health',
    });

    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        width: 24,
        height: 4,
        markdown: [
          '# Change Detection Store — service health',
          '',
          '**Read top to bottom.** ① Alarm bar: all green → skim and move on. ② Change detection: is the store doing its job — calls flowing, changes detected at a believable rate. ③ Errors & auth: anything here usually explains a sick domain row. ④ Plumbing (Lambda, DynamoDB): flat and boring is perfect.',
          '',
          '**Read spikes together, not alone.** Change rate pinned at 100% with steady tool calls → clients hash unstably (e.g. array order), not a fast-changing world. Tool calls flat at zero → producers stopped. Rising 403s → someone signs in without the required group.',
        ].join('\n'),
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.AlarmStatusWidget({
        title: 'Alarms — all green means healthy',
        alarms,
        width: 24,
        height: 2,
      }),
    );

    const section = (markdown: string): void => {
      dashboard.addWidgets(new cloudwatch.TextWidget({ markdown, width: 24, height: 2 }));
    };

    section(
      '## ① Change detection — the domain\n' +
        '**Changes detected** = new versions written; **unchanged** = polls that found nothing new (the cheap, desired outcome — no write happened). **Change rate** is their ratio: slow-moving sources typically sit in low single digits. A gap in the rate line just means no patch traffic in that period.',
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Changes vs unchanged',
        left: [api.changesDetected(), api.unchangedCalls()],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'Change rate (%)',
        left: [api.changeRate()],
        leftYAxis: { min: 0, max: 100 },
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'Tool calls by tool',
        left: [api.toolCallsByTool()],
        width: 8,
      }),
    );

    section(
      '## ② Errors & auth\n' +
        '**Tool errors** are typed, client-fixable rejections (bad key, value too large) — fine in small numbers; the ErrorCode lives in the log entry. **Internal errors** are bugs (alarmed; expect zero). **401** = invalid/expired token — a small trickle is normal; **403** = a valid sign-in WITHOUT the cds-allowed group — investigate if persistent.',
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Tool errors (client-fixable)',
        left: [api.toolErrors()],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'Internal errors (bugs — expect 0)',
        left: [api.internalErrors()],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'Auth rejections at the MCP gate',
        left: [api.authUnauthorized(), api.authForbidden()],
        width: 8,
      }),
    );

    section(
      '## ③ Service — Lambda\n' +
        '**Invocations** should mirror tool calls plus OAuth traffic. **Errors** are crashes (alarmed; tool failures do NOT count here). **Throttles** mean the reserved-concurrency ceiling (10) was hit. **p95** above 5 s for 15 min trips an alarm; isolated spikes are cold starts.',
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Traffic & failures',
        left: [api.invocations(), api.errors(), api.throttles()],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Duration p95 (ms)',
        left: [api.durationP95()],
        width: 12,
      }),
    );

    section(
      '## ④ Storage — DynamoDB\n' +
        '**Consumed capacity** is the cost driver and should track write traffic — reads stay low because unchanged polls never write. **Throttles** and **system errors** are alarmed; expect flat zero.',
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Consumed capacity (RCU / WCU)',
        left: [table.consumedReads(), table.consumedWrites()],
        width: 8,
      }),
      // Per-operation throttle/system-error metrics are math expressions
      // sharing inner metric ids — they must live in separate widgets.
      new cloudwatch.GraphWidget({
        title: 'Throttled requests (expect 0)',
        left: [table.throttledRequests()],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'System errors (expect 0)',
        left: [table.systemErrors()],
        width: 8,
      }),
    );
  }
}
