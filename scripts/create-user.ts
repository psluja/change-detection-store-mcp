import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';

import {
  DEFAULT_REGION,
  DEFAULT_STACK_NAME,
  readStackOutputs,
  requireOutput,
} from './stack-outputs.js';

/**
 * Creates (or completes) a Cognito user authorized to use the MCP:
 *   npm run create-user --workspace scripts -- --email you@example.com
 *
 * Options:
 *   --email <address>       required
 *   --password <password>   optional — a strong one is generated when omitted
 *   --group <name>          default cds-allowed
 *   --stack <name>          default ChangeDetectionStore
 *   --region <region>       default eu-central-1
 */

/** Generated passwords satisfy the pool policy: 12+ chars, all four classes. */
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*()-_=+';
  const bytes = randomBytes(24);
  const body = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
  return `Aa1!${body}`;
}

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    password: { type: 'string' },
    group: { type: 'string', default: 'cds-allowed' },
    stack: { type: 'string', default: DEFAULT_STACK_NAME },
    region: { type: 'string', default: DEFAULT_REGION },
  },
});

const email = values.email;
if (email === undefined || email === '') {
  console.error('Usage: npm run create-user --workspace scripts -- --email you@example.com');
  process.exit(1);
}

const outputs = await readStackOutputs(values.stack, values.region);
const userPoolId = requireOutput(outputs, 'CognitoUserPoolId');
const client = new CognitoIdentityProviderClient({ region: values.region });

const password = values.password ?? generatePassword();
const generated = values.password === undefined;

let alreadyExisted = false;
try {
  await client.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: email,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
      ],
      MessageAction: 'SUPPRESS', // no invitation email — password is set below
    }),
  );
} catch (error) {
  if (error instanceof UsernameExistsException) {
    alreadyExisted = true;
  } else {
    throw error;
  }
}

await client.send(
  new AdminSetUserPasswordCommand({
    UserPoolId: userPoolId,
    Username: email,
    Password: password,
    Permanent: true,
  }),
);

await client.send(
  new AdminAddUserToGroupCommand({
    UserPoolId: userPoolId,
    Username: email,
    GroupName: values.group,
  }),
);

console.log(alreadyExisted ? `Updated existing user ${email}:` : `Created user ${email}:`);
console.log(
  `  - password ${generated ? 'generated' : 'set'}${generated ? ` (shown once): ${password}` : ''}`,
);
console.log(`  - added to group "${values.group}" (authorizes MCP access)`);
console.log('The user can now sign in during the Cowork OAuth flow.');
