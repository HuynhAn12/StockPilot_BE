import crypto from 'crypto';

/**
 * Minimal TOTP (RFC 6238 / HOTP RFC 4226, HMAC-SHA1, 6 digits, 30 s step) built on Node's crypto —
 * compatible with Google Authenticator, Microsoft Authenticator, Authy... No third-party dependency.
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('INVALID_BASE32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 160-bit random secret, base32-encoded (what authenticator apps expect). */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secret).update(message).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totpStep(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);
}

export function totpCode(secretBase32: string, now: Date = new Date()): string {
  return hotp(base32Decode(secretBase32), totpStep(now));
}

/**
 * Returns the matched time step, or null. Accepts ±`window` steps for clock drift and rejects any
 * step <= `lastUsedStep`, so the same code cannot be replayed.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  options: { now?: Date; window?: number; lastUsedStep?: number | null } = {}
): number | null {
  const normalized = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) return null;
  const secret = base32Decode(secretBase32);
  const current = totpStep(options.now);
  const window = options.window ?? 1;
  for (let offset = -window; offset <= window; offset += 1) {
    const step = current + offset;
    if (options.lastUsedStep !== undefined && options.lastUsedStep !== null && step <= options.lastUsedStep) continue;
    const expected = Buffer.from(hotp(secret, step));
    const given = Buffer.from(normalized);
    if (expected.length === given.length && crypto.timingSafeEqual(expected, given)) return step;
  }
  return null;
}

/** otpauth:// URI — render as a QR code on the frontend (never send the secret anywhere else). */
export function buildOtpAuthUrl(issuer: string, accountName: string, secretBase32: string): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}
