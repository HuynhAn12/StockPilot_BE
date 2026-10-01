export const RESERVED_TENANT_CODES = new Set(['www', 'api', 'admin', 'app', 'auth', 'static']);

const TENANT_CODE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])$/;

export function normalizeTenantCode(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidTenantCode(value: string): boolean {
  const normalized = normalizeTenantCode(value);
  return TENANT_CODE_PATTERN.test(normalized) && !RESERVED_TENANT_CODES.has(normalized);
}

export function getTenantLookupCodes(canonicalTenantCode: string): string[] {
  const normalized = normalizeTenantCode(canonicalTenantCode);
  const legacyUnderscoreCode = normalized.replace(/-/g, '_');
  return Array.from(new Set([normalized, legacyUnderscoreCode]));
}

export function toTenantSlugFromStoreCode(storeCode: string): string {
  return normalizeTenantCode(storeCode).replace(/_/g, '-');
}
