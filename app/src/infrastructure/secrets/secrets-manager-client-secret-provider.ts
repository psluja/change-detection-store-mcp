import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

export interface CognitoClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * Loads the Cognito app client credentials stored as JSON
 * `{"clientId": "...", "clientSecret": "..."}` in one Secrets Manager secret.
 *
 * Both values live in the secret (not in Lambda env) on purpose: the app
 * client is created AFTER the Function URL (its callback URL points at it),
 * so wiring clientId through env would create a CloudFormation resource
 * cycle. The composition root loads this once per container.
 */
export class SecretsManagerClientCredentialsLoader {
  constructor(
    private readonly client: SecretsManagerClient,
    private readonly secretId: string,
  ) {}

  async load(): Promise<CognitoClientCredentials> {
    const output = await this.client.send(new GetSecretValueCommand({ SecretId: this.secretId }));
    if (output.SecretString === undefined || output.SecretString === '') {
      throw new Error('Cognito client credentials secret is missing its string value');
    }
    const parsed: unknown = JSON.parse(output.SecretString);
    const candidate = parsed as { clientId?: unknown; clientSecret?: unknown };
    if (
      typeof candidate.clientId !== 'string' ||
      candidate.clientId === '' ||
      typeof candidate.clientSecret !== 'string' ||
      candidate.clientSecret === ''
    ) {
      throw new Error('Cognito client credentials secret must contain clientId and clientSecret');
    }
    return { clientId: candidate.clientId, clientSecret: candidate.clientSecret };
  }
}
