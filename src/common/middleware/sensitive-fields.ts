import { Request, Response, NextFunction } from 'express';

const SENSITIVE_KEYS = new Set([
  'costPrice',
  'costPriceSnapshot',
  'cost_price',
  'cost_price_snapshot',
  'totalCostPrice',
  'profitMargin',
  'margin',
  'profit',
]);

/**
 * Recursively deep-sanitizes sensitive fields (cost price, profit margins)
 * for non-owner/non-admin roles across any nested object or array structure.
 */
export function maskSensitiveFields(data: any, role?: string): any {
  if (data === null || data === undefined) return data;
  if (role === 'SHOP_OWNER' || role === 'ADMIN') return data;

  if (Array.isArray(data)) {
    return data.map((item) => maskSensitiveFields(item, role));
  }

  if (typeof data === 'object') {
    // Handle Date, Decimal, Buffer, etc. which shouldn't be plain-object mapped
    if (data instanceof Date || (data.constructor && data.constructor.name === 'Decimal')) {
      return data;
    }

    const sanitized: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      if (SENSITIVE_KEYS.has(key)) {
        continue;
      }
      sanitized[key] = maskSensitiveFields(value, role);
    }
    return sanitized;
  }

  return data;
}

export function sensitiveFieldsMiddleware(req: Request, res: Response, next: NextFunction) {
  const originalJson = res.json.bind(res);

  res.json = function (body: any) {
    const role = req.user?.role;
    const sanitizedBody = maskSensitiveFields(body, role);
    return originalJson(sanitizedBody);
  };

  next();
}
