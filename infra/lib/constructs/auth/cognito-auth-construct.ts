import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import { Construct as BaseConstruct } from 'constructs';

export interface CognitoAuthProps {
  /** Globally unique hosted-UI domain prefix, e.g. `cds-auth-<account>`. */
  readonly domainPrefix: string;
  /** Cognito group whose members are authorized to use the MCP (claim cognito:groups). */
  readonly allowedGroupName: string;
  /** Shared stack CMK; encrypts the client-credentials secret. */
  readonly encryptionKey: kms.IKey;
}

export interface CognitoAuthMetrics {
  /** Hosted-UI sign-in successes (populated when Cognito threat protection is enabled). */
  readonly signInSuccesses: () => cloudwatch.IMetric;
}

/**
 * OAuth 2.0 authorization server for the MCP connector: hosted UI with
 * email+password sign-in only, no self-signup, no external IdPs;
 * authorization is group membership, so granting access means adding a user
 * to the group (helper script), never a code change.
 *
 * The app client is attached in a second step (`attachCoworkClient`) because
 * its callback URL points at the Function URL, which does not exist yet when
 * this construct is created. The client credentials (id + secret) land in ONE
 * deterministically named Secrets Manager secret that the Lambda reads at
 * runtime — deliberately not in Lambda env, which would close a
 * CloudFormation resource cycle (client → function URL → function → client).
 */
export class CognitoAuthConstruct extends BaseConstruct {
  /** Deterministic secret name, known before any resource exists. */
  static readonly CLIENT_CREDENTIALS_SECRET_NAME = 'cds/cognito-cowork-client';

  readonly userPool: cognito.UserPool;
  readonly domain: cognito.UserPoolDomain;
  readonly allowedGroupName: string;

  private coworkClientInternal: cognito.UserPoolClient | undefined;

  constructor(scope: Construct, id: string, props: CognitoAuthProps) {
    super(scope, id);
    this.allowedGroupName = props.allowedGroupName;
    this.encryptionKey = props.encryptionKey;

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      mfa: cognito.Mfa.OPTIONAL,
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.domain = this.userPool.addDomain('HostedDomain', {
      cognitoDomain: { domainPrefix: props.domainPrefix },
    });

    new cognito.CfnUserPoolGroup(this, 'AllowedGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: props.allowedGroupName,
      description: 'Members are authorized to use the Change Detection Store MCP',
    });
  }

  private readonly encryptionKey: kms.IKey;

  /**
   * Creates the Cowork app client once the public callback URL is known,
   * and stores its credentials as JSON in the deterministic secret.
   */
  attachCoworkClient(callbackUrl: string): void {
    if (this.coworkClientInternal !== undefined) {
      throw new Error('Cowork client is already attached');
    }
    this.coworkClientInternal = this.userPool.addClient('CoworkClient', {
      generateSecret: true,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [callbackUrl],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      accessTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      preventUserExistenceErrors: true,
    });

    new secretsmanager.Secret(this, 'ClientCredentialsSecret', {
      secretName: CognitoAuthConstruct.CLIENT_CREDENTIALS_SECRET_NAME,
      description:
        'Cognito Cowork app client credentials (clientId + clientSecret) for the MCP Lambda',
      encryptionKey: this.encryptionKey,
      secretObjectValue: {
        clientId: cdk.SecretValue.unsafePlainText(this.coworkClientInternal.userPoolClientId),
        clientSecret: this.coworkClientInternal.userPoolClientSecret,
      },
    });
  }

  get coworkClient(): cognito.UserPoolClient {
    if (this.coworkClientInternal === undefined) {
      throw new Error('Call attachCoworkClient() first');
    }
    return this.coworkClientInternal;
  }

  /** Hosted UI base URL, e.g. https://<prefix>.auth.<region>.amazoncognito.com */
  get hostedDomainUrl(): string {
    return this.domain.baseUrl();
  }

  metrics(): CognitoAuthMetrics {
    const period = cdk.Duration.minutes(5);
    return {
      signInSuccesses: () =>
        new cloudwatch.Metric({
          namespace: 'AWS/Cognito',
          metricName: 'SignInSuccesses',
          dimensionsMap: {
            UserPool: this.userPool.userPoolId,
            UserPoolClient: this.coworkClient.userPoolClientId,
          },
          statistic: 'sum',
          period,
        }),
    };
  }
}
