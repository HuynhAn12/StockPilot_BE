/**
 * Re-encrypts every StorePaymentConfig secret from one AES-256-GCM key to another.
 *
 * Usage (keys are read from the environment so they never appear in shell history):
 *   OLD_PAYMENT_CONFIG_ENCRYPTION_KEY=<old> NEW_PAYMENT_CONFIG_ENCRYPTION_KEY=<new> npx tsx scripts/rotate-payment-config-key.ts
 *
 * After it succeeds, set PAYMENT_CONFIG_ENCRYPTION_KEY=<new> in .env and restart the backend.
 * The whole rotation runs in one transaction and every value is decrypted with the new key
 * before commit, so a failure leaves the database untouched.
 */
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { isValidAes256Key } from '../src/config/env';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const VERSION = 'v1';
const FIELDS = ['clientIdEncrypted', 'apiKeyEncrypted', 'checksumKeyEncrypted'] as const;

function toKey(raw: string | undefined, name: string): Buffer {
  if (!raw || !isValidAes256Key(raw)) {
    throw new Error(`${name} is missing or not a 32-byte base64 / 64-char hex key`);
  }
  return /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
}

function encrypt(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}

function decrypt(serialized: string, key: Buffer): string {
  const [version, iv, tag, ciphertext] = serialized.split(':');
  if (version !== VERSION || !iv || !tag || !ciphertext) {
    throw new Error('Invalid encrypted secret format');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

async function main() {
  const oldKey = toKey(process.env.OLD_PAYMENT_CONFIG_ENCRYPTION_KEY, 'OLD_PAYMENT_CONFIG_ENCRYPTION_KEY');
  const newKey = toKey(process.env.NEW_PAYMENT_CONFIG_ENCRYPTION_KEY, 'NEW_PAYMENT_CONFIG_ENCRYPTION_KEY');
  if (oldKey.equals(newKey)) {
    throw new Error('Old and new keys are identical; nothing to rotate');
  }

  const prisma = new PrismaClient();
  try {
    const rotated = await prisma.$transaction(async (tx) => {
      const configs = await tx.storePaymentConfig.findMany();
      for (const config of configs) {
        const data: Record<string, string> = {};
        for (const field of FIELDS) {
          const plaintext = decrypt(config[field], oldKey);
          const reEncrypted = encrypt(plaintext, newKey);
          if (decrypt(reEncrypted, newKey) !== plaintext) {
            throw new Error(`Round-trip check failed for config ${config.id}.${field}`);
          }
          data[field] = reEncrypted;
        }
        await tx.storePaymentConfig.update({ where: { id: config.id }, data });
      }
      return configs.length;
    });
    console.log(`Rotated ${rotated} store payment config(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`Rotation aborted, database unchanged: ${error.message}`);
  process.exit(1);
});
