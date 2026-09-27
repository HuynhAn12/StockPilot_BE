#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');

function getArg(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : undefined;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const databaseUrl = getArg('url') || process.env.DATABASE_URL;
const inputFile = getArg('file');

if (!databaseUrl) {
  fail('DATABASE_URL is required for restore.');
}

if (!inputFile || !fs.existsSync(inputFile)) {
  fail('A readable --file=/path/to/backup.sql is required for restore.');
}

let parsedUrl;
try {
  parsedUrl = new URL(databaseUrl);
} catch {
  fail('DATABASE_URL must be a valid MySQL connection URL.');
}

const databaseName = parsedUrl.pathname.replace(/^\//, '');
if (!databaseName) {
  fail('DATABASE_URL must include a database name.');
}

const safeTargetPattern = /(test|staging|stage|dev|restore|backup)/i;
const confirmedProductionRestore = hasFlag('confirm-production-restore') && process.env.ALLOW_PRODUCTION_RESTORE === 'true';

if (!safeTargetPattern.test(databaseName) && !confirmedProductionRestore) {
  fail(
    'Refusing destructive restore to a database name that does not look non-production. Set ALLOW_PRODUCTION_RESTORE=true and pass --confirm-production-restore only after an approved production rollback plan.'
  );
}

const args = [
  '-h',
  parsedUrl.hostname,
  '-P',
  parsedUrl.port || '3306',
  '-u',
  decodeURIComponent(parsedUrl.username),
  `-p${decodeURIComponent(parsedUrl.password)}`,
  databaseName,
];

const input = fs.createReadStream(inputFile);
const child = spawn('mysql', args, { stdio: ['pipe', 'inherit', 'pipe'] });

input.pipe(child.stdin);
child.stderr.on('data', (chunk) => process.stderr.write(chunk));
child.on('error', (error) => fail(`Failed to run mysql: ${error.message}`));
child.on('close', (code) => {
  if (code !== 0) {
    fail(`mysql exited with code ${code}.`);
  }

  process.stdout.write(`Restore completed into ${databaseName}\n`);
});
