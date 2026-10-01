import { NextFunction, Request, Response } from 'express';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { ForbiddenError, NotFoundError } from '../errors/app-error';
import { getTenantLookupCodes, RESERVED_TENANT_CODES, toTenantSlugFromStoreCode } from '../utils/tenant-slug';

export interface TenantContext {
  storeId: number;
  storeCode: string;
  hostname: string;
}

declare global {
  namespace Express {
    interface Request {
      tenant?: TenantContext;
    }
  }
}

const LOCALHOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export async function tenantResolverMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantCode = resolveTenantCode(req);
    if (!tenantCode) {
      return next();
    }

    const store = await findStoreByTenantCode(tenantCode);

    if (!store) {
      return next(new NotFoundError('Store tenant was not found'));
    }

    if (!store.isActive) {
      return next(new ForbiddenError('Store tenant is inactive'));
    }

    req.tenant = {
      storeId: store.id,
      storeCode: toTenantSlugFromStoreCode(store.code),
      hostname: normalizeHostname(req.hostname || req.headers.host || ''),
    };
    return next();
  } catch (error) {
    return next(error);
  }
}

async function findStoreByTenantCode(tenantCode: string) {
  const [canonicalCode, ...legacyCodes] = getTenantLookupCodes(tenantCode);
  const select = { id: true, code: true, isActive: true };

  const canonicalStore = await prisma.store.findUnique({
    where: { code: canonicalCode },
    select,
  });

  if (canonicalStore || legacyCodes.length === 0) {
    return canonicalStore;
  }

  return prisma.store.findFirst({
    where: { code: { in: legacyCodes } },
    select,
  });
}

export function resolveTenantCode(req: Request): string | null {
  const hostname = normalizeHostname(req.hostname || req.headers.host || '');

  if (LOCALHOSTS.has(hostname)) {
    if (env.NODE_ENV !== 'production') {
      const devTenantCode = req.header('x-tenant-code')?.trim().toLowerCase();
      return devTenantCode || null;
    }
    return null;
  }

  const rootDomain = env.TENANT_ROOT_DOMAIN.trim().toLowerCase();
  if (!rootDomain || hostname === rootDomain || !hostname.endsWith(`.${rootDomain}`)) {
    return null;
  }

  const subdomain = hostname.slice(0, -(rootDomain.length + 1));
  if (!subdomain || subdomain.includes('.')) {
    return null;
  }

  if (RESERVED_TENANT_CODES.has(subdomain)) {
    return null;
  }

  return subdomain.toLowerCase();
}

function normalizeHostname(rawHost: string): string {
  const normalized = rawHost.trim().toLowerCase();
  if (normalized === '::1') {
    return normalized;
  }

  if (normalized.startsWith('[')) {
    const closingBracketIndex = normalized.indexOf(']');
    return closingBracketIndex >= 0 ? normalized.slice(1, closingBracketIndex) : normalized;
  }

  return normalized.replace(/:\d+$/, '');
}
