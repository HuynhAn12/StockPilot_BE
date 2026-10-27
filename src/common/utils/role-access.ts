import { Role } from '@prisma/client';

/**
 * D9: only SHOP_OWNER may see cost price, price floors, margins, capital values, and pricing
 * recommendations. Platform ADMIN never reaches store-scoped APIs (see requireStoreScope).
 */
export function canViewFinancials(role?: Role | string | null): boolean {
  return role === 'SHOP_OWNER';
}
