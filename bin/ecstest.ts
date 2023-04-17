#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { EcstestStack } from '../lib/ecstest-stack';

const app = new cdk.App();
new EcstestStack(app, 'TestEcsStack', {
  vpcId: 'vpc-yourvpc',
  instanceType: "c6a.large",
  minCapacity: 1,
  maxCapacity: 2,
  codeDeployServiceRoleArn: 'arn:aws:iam::yourrole:role/ecsCodeDeployRole',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }
});