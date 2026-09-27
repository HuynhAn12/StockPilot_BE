#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function getArg(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : undefined;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const databaseUrl = getArg('url') || process.env.DATABASE_URL;
if (!databaseUrl) {
  fail('DATABASE_URL is required for backup.');
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

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputPath = path.resolve(getArg('output') || path.join('backups', `${databaseName}-${timestamp}.sql`));
fs.mkdirSync(path.dirname(outputPath), { recursive: true });

const args = [
  '--single-transaction',
  '--routines',
  '--triggers',
  '--events',
  '--set-gtid-purged=OFF',
  '-h',
  parsedUrl.hostname,
  '-P',
  parsedUrl.port || '3306',
  '-u',
  decodeURIComponent(parsedUrl.username),
  `-p${decodeURIComponent(parsedUrl.password)}`,
  databaseName,
];

const output = fs.createWriteStream(outputPath, { flags: 'wx' });
const child = spawn('mysqldump', args, { stdio: ['ignore', 'pipe', 'pipe'] });

child.stdout.pipe(output);
child.stderr.on('data', (chunk) => process.stderr.write(chunk));
child.on('error', (error) => fail(`Failed to run mysqldump: ${error.message}`));
child.on('close', (code) => {
  output.close();
  if (code !== 0) {
    fs.rmSync(outputPath, { force: true });
    fail(`mysqldump exited with code ${code}.`);
  }

  process.stdout.write(`Backup written to ${outputPath}\n`);
});
