import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

export const DEFAULT_STACK_NAME = 'ChangeDetectionStore';
export const DEFAULT_REGION = 'eu-central-1';

/** Reads the deployed stack's outputs — the single source of deployment facts. */
export async function readStackOutputs(
  stackName: string,
  region: string,
): Promise<Record<string, string>> {
  const client = new CloudFormationClient({ region });
  const response = await client.send(new DescribeStacksCommand({ StackName: stackName }));
  const stack = response.Stacks?.[0];
  if (stack === undefined) {
    throw new Error(`Stack ${stackName} not found in ${region} — deploy it first`);
  }
  const outputs: Record<string, string> = {};
  for (const output of stack.Outputs ?? []) {
    if (output.OutputKey !== undefined && output.OutputValue !== undefined) {
      outputs[output.OutputKey] = output.OutputValue;
    }
  }
  return outputs;
}

export function requireOutput(outputs: Record<string, string>, key: string): string {
  const value = outputs[key];
  if (value === undefined || value === '') {
    throw new Error(`Stack output ${key} is missing — is the stack fully deployed?`);
  }
  return value;
}
