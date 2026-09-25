import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const root = process.cwd();

const requiredFiles = [
  'README.md',
  '.env.example',
  'prisma/schema.prisma',
  'docs/api.md',
  'docs/HANDOFF.md',
  'docs/RUNBOOK.md',
  'docs/TESTING.md',
  'docs/KNOWN_LIMITATIONS.md',
  'docs/postman/StockPilot.postman_collection.json',
];

const requiredEnvKeys = [
  'NODE_ENV',
  'PORT',
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'CORS_ORIGIN',
  'APP_TIMEZONE',
];

function fail(message: string): never {
  console.error(`HANDOFF_CHECK_FAILED: ${message}`);
  process.exit(1);
}

for (const file of requiredFiles) {
  if (!existsSync(join(root, file))) {
    fail(`missing required file ${file}`);
  }
}

const envExample = readFileSync(join(root, '.env.example'), 'utf8');
for (const key of requiredEnvKeys) {
  if (!envExample.includes(`${key}=`)) {
    fail(`.env.example missing ${key}`);
  }
}

if (existsSync(join(root, '.env')) || existsSync(join(root, '.env.local'))) {
  console.warn('HANDOFF_CHECK_WARNING: local .env file exists; keep it untracked and do not commit secrets.');
}

const migrationCount = readdirSync(join(root, 'prisma/migrations'), { withFileTypes: true }).filter((entry) =>
  entry.isDirectory()
).length;

if (migrationCount < 11) {
  fail(`expected at least 11 migrations, found ${migrationCount}`);
}

console.log(`HANDOFF_CHECK_OK: required files present, env example has required keys, migrations=${migrationCount}`);
