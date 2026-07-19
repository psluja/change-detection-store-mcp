import * as cdk from 'aws-cdk-lib';

import { ChangeDetectionStoreStack } from '../lib/change-detection-store-stack.js';

const app = new cdk.App();

new ChangeDetectionStoreStack(app, 'ChangeDetectionStore', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'eu-central-1' },
});
