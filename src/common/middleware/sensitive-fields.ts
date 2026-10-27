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
  'totalInventoryValue',
  'totalValue',
  'netRevenue',
  'grossRevenue',
  'grossProfit',
  'cogs',
  'tiedCapital',
  'capital',
  // Decision Engine / pricing derivatives: floor price and minimum margin allow back-solving cost (D9).
  'minimumPrice',
  'minimumMarginPct',
  'maxMarkdownPct',
  'maxMarkupPct',
  'expectedMarginPct',
  'curMargin',
  'lossPerUnit',
  'costValue',
  'deadStockCostValue',
  'totalDeadStockCostValue',
  'totalEstimateCost',
  'totalTiedCapital',
  'pricingEvaluation',
  'pricingRecommendation',
]);

/**
 * Recursively deep-sanitizes sensitive fields (cost price, profit margins)
 * for non-owner/non-admin roles across any nested object or array structure.
 * Converts Prisma Decimal instances to JavaScript numbers.
 */
export function maskSensitiveFields(data: any, role?: string): any {
  if (data === null || data === undefined) return data;

  // 1. Primitive types
  if (typeof data !== 'object') {
    return data;
  }

  // 2. Dates and Buffers
  if (data instanceof Date || Buffer.isBuffer(data)) {
    return data;
  }

  // 3. Prisma Decimal or Decimal.js: convert to number so JSON serialization is clean
  if (
    typeof (data as any).toNumber === 'function' ||
    (data.constructor && (data.constructor.name === 'Decimal' || data.constructor.name === 'Decimal128')) ||
    (Array.isArray((data as any).d) && typeof (data as any).s === 'number' && typeof (data as any).e === 'number')
  ) {
    try {
      if (typeof (data as any).toNumber === 'function') {
        return (data as any).toNumber();
      }
      if (typeof (data as any).toString === 'function') {
        const num = Number((data as any).toString());
        return isNaN(num) ? 0 : num;
      }
      if (Array.isArray((data as any).d) && (data as any).d.length > 0) {
        return Number((data as any).d[0]) * ((data as any).s < 0 ? -1 : 1);
      }
    } catch (_) {
      return 0;
    }
    return 0;
  }

  // 4. Arrays
  if (Array.isArray(data)) {
    return data.map((item) => maskSensitiveFields(item, role));
  }

  // 5. Objects: Strip sensitive fields if user is staff / non-privileged
  const isOwnerOrAdmin = role === 'SHOP_OWNER' || role === 'ADMIN';

  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!isOwnerOrAdmin && SENSITIVE_KEYS.has(key)) {
      continue;
    }
    sanitized[key] = maskSensitiveFields(value, role);
  }
  return sanitized;
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
