import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import { CreateStoreHandler } from '../application/create-store/handler.js';
import { DeleteItemHandler } from '../application/delete-item/handler.js';
import { DeleteStoreHandler } from '../application/delete-store/handler.js';
import { GetItemHandler } from '../application/get-item/handler.js';
import { GetItemHistoryHandler } from '../application/get-item-history/handler.js';
import { ListItemsHandler } from '../application/list-items/handler.js';
import { ListStoresHandler } from '../application/list-stores/handler.js';
import { PatchItemHandler } from '../application/patch-item/handler.js';
import { PatchItemsHandler } from '../application/patch-items/handler.js';
import type { Clock } from '../application/ports/clock.js';
import type { ContentHasher } from '../application/ports/content-hasher.js';
import type { IdGenerator } from '../application/ports/id-generator.js';
import type { ItemRepository } from '../application/ports/item-repository.js';
import type { StoreRepository } from '../application/ports/store-repository.js';
import { CognitoAccessTokenVerifier } from '../infrastructure/cognito/cognito-access-token-verifier.js';
import {
  createDynamoDbDocumentClient,
  DynamoDbStorage,
} from '../infrastructure/dynamodb/dynamo-db-storage.js';
import { JcsContentHasher } from '../infrastructure/jcs-content-hasher.js';
import { SecretsManagerClientCredentialsLoader } from '../infrastructure/secrets/secrets-manager-client-secret-provider.js';
import { SystemClock } from '../infrastructure/system-clock.js';
import { EmfTelemetry } from '../infrastructure/telemetry/emf-telemetry.js';
import { UlidIdGenerator } from '../infrastructure/ulid-id-generator.js';
import type { OAuthConfig } from '../interface/oauth/config.js';
import type { AccessTokenVerifier } from '../interface/oauth/ports.js';
import { TokenProxy } from '../interface/oauth/token-proxy.js';
import type { Telemetry } from '../interface/telemetry.js';

export interface AppDependencies {
  readonly stores: StoreRepository;
  readonly items: ItemRepository;
  readonly hasher: ContentHasher;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface AppHandlers {
  readonly createStore: CreateStoreHandler;
  readonly listStores: ListStoresHandler;
  readonly deleteStore: DeleteStoreHandler;
  readonly patchItem: PatchItemHandler;
  readonly patchItems: PatchItemsHandler;
  readonly getItem: GetItemHandler;
  readonly listItems: ListItemsHandler;
  readonly getItemHistory: GetItemHistoryHandler;
  readonly deleteItem: DeleteItemHandler;
}

/** Manual composition root — constructor injection, no DI framework. */
export function buildHandlers(deps: AppDependencies): AppHandlers {
  const patchItem = new PatchItemHandler(
    deps.stores,
    deps.items,
    deps.hasher,
    deps.clock,
    deps.ids,
  );
  return {
    createStore: new CreateStoreHandler(deps.stores, deps.clock),
    listStores: new ListStoresHandler(deps.stores, deps.clock),
    deleteStore: new DeleteStoreHandler(deps.stores, deps.items, deps.clock),
    patchItem,
    patchItems: new PatchItemsHandler(patchItem),
    getItem: new GetItemHandler(deps.stores, deps.items, deps.clock),
    listItems: new ListItemsHandler(deps.stores, deps.items, deps.clock),
    getItemHistory: new GetItemHistoryHandler(deps.stores, deps.items, deps.clock),
    deleteItem: new DeleteItemHandler(deps.stores, deps.items, deps.clock),
  };
}

/** OAuth disabled — local development only; the router logs a loud warning. */
export interface AuthDisabled {
  readonly kind: 'disabled';
}

/** Full Cognito OAuth wiring (production). */
export interface AuthCognito {
  readonly kind: 'cognito';
  readonly config: OAuthConfig;
  readonly verifier: AccessTokenVerifier;
  readonly tokenProxy: TokenProxy;
}

export type AuthRuntime = AuthDisabled | AuthCognito;

/** Everything the Lambda router needs, built once per container. */
export interface AppRuntime {
  readonly handlers: AppHandlers;
  readonly auth: AuthRuntime;
  readonly telemetry: Telemetry;
}

const DEFAULT_ALLOWED_REDIRECT_URIS =
  'https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

/** Production wiring: DynamoDB storage, system clock, monotonic ULIDs, JCS hasher. */
export function buildProductionHandlers(): AppHandlers {
  const storage = new DynamoDbStorage(
    createDynamoDbDocumentClient(new DynamoDBClient({})),
    requireEnv('CDS_TABLE_NAME'),
  );
  return buildHandlers({
    stores: storage,
    items: storage,
    hasher: new JcsContentHasher(),
    clock: new SystemClock(),
    ids: new UlidIdGenerator(),
  });
}

/**
 * Production runtime: handlers + Cognito OAuth (unless explicitly disabled).
 * Async because the app client credentials (clientId + clientSecret) live in
 * one Secrets Manager secret, loaded once per container — see the loader for
 * why clientId cannot come from env.
 */
export async function buildProductionRuntime(): Promise<AppRuntime> {
  const handlers = buildProductionHandlers();
  const telemetry = new EmfTelemetry();
  if (process.env.CDS_AUTH_DISABLED === 'true') {
    console.warn(
      JSON.stringify({
        event: 'auth_disabled',
        message: 'OAuth gate is OFF - acceptable only for local development',
      }),
    );
    return { handlers, auth: { kind: 'disabled' }, telemetry };
  }

  const credentials = await new SecretsManagerClientCredentialsLoader(
    new SecretsManagerClient({}),
    // The secret NAME, not an ARN: a partial ARN as SecretId fails IAM
    // evaluation on GetSecretValue (see the api construct for the full story).
    requireEnv('CDS_CLIENT_SECRET_ID'),
  ).load();

  const config: OAuthConfig = {
    userPoolId: requireEnv('CDS_USER_POOL_ID'),
    clientId: credentials.clientId,
    cognitoDomain: requireEnv('CDS_COGNITO_DOMAIN'),
    requiredGroup: process.env.CDS_REQUIRED_GROUP ?? 'cds-allowed',
    allowedRedirectUris: (process.env.CDS_ALLOWED_REDIRECT_URIS ?? DEFAULT_ALLOWED_REDIRECT_URIS)
      .split(',')
      .map((uri) => uri.trim())
      .filter((uri) => uri !== ''),
  };
  return {
    handlers,
    telemetry,
    auth: {
      kind: 'cognito',
      config,
      verifier: new CognitoAccessTokenVerifier({
        userPoolId: config.userPoolId,
        clientId: config.clientId,
        requiredGroup: config.requiredGroup,
      }),
      tokenProxy: new TokenProxy(
        config,
        { getClientSecret: () => Promise.resolve(credentials.clientSecret) },
        fetch,
      ),
    },
  };
}
