import { parseArgs } from 'node:util';

import {
  DEFAULT_REGION,
  DEFAULT_STACK_NAME,
  readStackOutputs,
  requireOutput,
} from './stack-outputs.js';

/**
 * Prints everything needed to connect the deployed MCP server to Claude:
 *   npm run connection-info --workspace scripts
 */

const { values } = parseArgs({
  options: {
    stack: { type: 'string', default: DEFAULT_STACK_NAME },
    region: { type: 'string', default: DEFAULT_REGION },
  },
});

const outputs = await readStackOutputs(values.stack, values.region);
const mcpEndpoint = requireOutput(outputs, 'McpEndpoint');
const clientId = requireOutput(outputs, 'CoworkClientId');
const hostedDomain = requireOutput(outputs, 'CognitoHostedDomain');
const alarmTopic = outputs.AlarmTopicArn ?? '(missing)';

console.log('Change Detection Store MCP — connection info');
console.log('=============================================');
console.log('');
console.log(`MCP server URL:   ${mcpEndpoint}`);
console.log(`OAuth Client ID:  ${clientId}`);
console.log(`Cognito login UI: ${hostedDomain}`);
console.log('');
console.log('Connect from Claude (Cowork):');
console.log('  1. Settings -> Connectors -> Add custom connector');
console.log(`  2. URL: ${mcpEndpoint}`);
console.log(`  3. Advanced settings -> OAuth Client ID: ${clientId}`);
console.log('  4. Connect -> sign in with a user created by create-user.ts');
console.log('');
console.log(`Alarms SNS topic (subscribe your email): ${alarmTopic}`);
