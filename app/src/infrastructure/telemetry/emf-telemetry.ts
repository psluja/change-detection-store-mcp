import type { Telemetry } from '../../interface/telemetry.js';

/**
 * Keep in sync with APP_METRICS_NAMESPACE in
 * infra/lib/constructs/api/mcp-function-construct.ts (dashboard + alarms).
 */
const NAMESPACE = 'ChangeDetectionStore';

interface MetricValue {
  readonly name: string;
  readonly value: number;
}

/**
 * CloudWatch Embedded Metric Format: one structured log line per event that
 * CloudWatch turns into metrics asynchronously — no SDK calls, no latency on
 * the request path. Dimensioned metrics also publish a dimensionless rollup
 * so service-level graphs and alarms need no SEARCH expressions.
 */
export class EmfTelemetry implements Telemetry {
  toolCalled(tool: string): void {
    this.emit([{ name: 'ToolCalls', value: 1 }], { Tool: tool });
  }

  toolErrored(tool: string, code: string): void {
    this.emit([{ name: 'ToolErrors', value: 1 }], { Tool: tool }, { ErrorCode: code });
  }

  internalError(tool: string): void {
    this.emit([{ name: 'InternalErrors', value: 1 }], { Tool: tool });
  }

  changeOutcomes(changed: number, unchanged: number): void {
    this.emit([
      { name: 'ChangesDetected', value: changed },
      { name: 'UnchangedCalls', value: unchanged },
    ]);
  }

  authRejected(outcome: 'unauthorized' | 'forbidden'): void {
    this.emit([
      { name: outcome === 'unauthorized' ? 'AuthUnauthorized' : 'AuthForbidden', value: 1 },
    ]);
  }

  private emit(
    metrics: readonly MetricValue[],
    dimensions: Record<string, string> = {},
    properties: Record<string, string> = {},
  ): void {
    const dimensionNames = Object.keys(dimensions);
    const dimensionSets = dimensionNames.length > 0 ? [dimensionNames, []] : [[]];
    console.log(
      JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: NAMESPACE,
              Dimensions: dimensionSets,
              Metrics: metrics.map((metric) => ({ Name: metric.name, Unit: 'Count' })),
            },
          ],
        },
        ...dimensions,
        ...properties,
        ...Object.fromEntries(metrics.map((metric) => [metric.name, metric.value])),
      }),
    );
  }
}
