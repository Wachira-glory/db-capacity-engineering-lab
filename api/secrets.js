'use strict';

// =============================================================================
// secrets.js — resolve DB credentials from AWS Secrets Manager at boot.
// =============================================================================

const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

let cached = null;
let cachedSource = null;

function buildClient() {
  const config = { region: process.env.AWS_REGION || 'eu-west-3' };
  // On real AWS, AWS_ENDPOINT_URL is unset and the SDK talks to AWS directly.
  // No isLocalStack branch -- the endpoint override is the only difference.
  if (process.env.AWS_ENDPOINT_URL) {
    config.endpoint = process.env.AWS_ENDPOINT_URL;
  }
  return new SecretsManagerClient(config);
}

async function loadDbCredentials() {
  if (cached) {
    return cached;
  }

  const arn = process.env.DB_SECRET_ARN;

  if (!arn) {
    // Plain local runs (no Secrets Manager configured) fall back to env vars.
    cached = {
      engine: 'mysql',
      username: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || 'labpassword',
      host: process.env.MYSQL_HOST || 'mysql-db',
      port: Number(process.env.MYSQL_PORT || 3306),
      dbname: process.env.MYSQL_DATABASE || 'capacity_lab',
    };
    cachedSource = { arn: 'env', versionId: 'n/a' };
    // eslint-disable-next-line no-console
    console.log('[secrets] DB_SECRET_ARN not set, using MYSQL_* env vars', cachedSource);
    return cached;
  }

  const client = buildClient();
  const response = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  const envelope = JSON.parse(response.SecretString);

  cached = {
    engine: envelope.engine,
    username: envelope.username,
    password: envelope.password,
    host: envelope.host,
    port: Number(envelope.port),
    dbname: envelope.dbname,
  };
  cachedSource = { arn: response.ARN, versionId: response.VersionId };

  // Log ONLY the ARN + version -- never the password.
  // eslint-disable-next-line no-console
  console.log('[secrets] loaded DB credentials', cachedSource);

  return cached;
}

function getSecretSource() {
  return cachedSource || { arn: 'unresolved', versionId: 'n/a' };
}

module.exports = { loadDbCredentials, getSecretSource };
