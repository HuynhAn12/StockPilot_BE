import crypto from 'crypto';
import { env, isValidAes256Key } from '../../config/env';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const VERSION = 'v1';

export class SecretEncryptionService {
  static encrypt(plaintext: string): string {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
  }

  static decrypt(serialized: string): string {
    try {
      const [version, ivBase64, tagBase64, ciphertextBase64] = serialized.split(':');
      if (version !== VERSION || !ivBase64 || !tagBase64 || !ciphertextBase64) {
        throw new Error('Invalid encrypted secret format');
      }

      const key = getEncryptionKey();
      const iv = Buffer.from(ivBase64, 'base64');
      const tag = Buffer.from(tagBase64, 'base64');
      const ciphertext = Buffer.from(ciphertextBase64, 'base64');

      if (iv.length !== IV_LENGTH_BYTES || tag.length !== 16 || ciphertext.length === 0) {
        throw new Error('Invalid encrypted secret payload');
      }

      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('SECRET_DECRYPTION_FAILED');
    }
  }
}

function getEncryptionKey(): Buffer {
  const key = env.PAYMENT_CONFIG_ENCRYPTION_KEY;
  if (!isValidAes256Key(key)) {
    throw new Error('PAYMENT_CONFIG_ENCRYPTION_KEY_INVALID');
  }

  return /^[a-f0-9]{64}$/i.test(key) ? Buffer.from(key, 'hex') : Buffer.from(key, 'base64');
}
