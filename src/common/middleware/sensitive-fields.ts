import { Request, Response, NextFunction } from 'express';

export function maskSensitiveFields(data: any, role?: string): any {
  if (!data || typeof data !== 'object') return data;
  if (role === 'SHOP_OWNER' || role === 'ADMIN') return data;

  if (Array.isArray(data)) {
    return data.map((item) => maskSensitiveFields(item, role));
  }

  const masked = { ...data };
  // Remove cost price & margin snapshots
  delete masked.costPrice;
  delete masked.costPriceSnapshot;
  delete masked.cost_price;
  delete masked.cost_price_snapshot;
  delete masked.totalCostPrice;
  delete masked.profitMargin;

  // Mask children fields
  if (masked.items && Array.isArray(masked.items)) {
    masked.items = masked.items.map((i: any) => maskSensitiveFields(i, role));
  }
  if (masked.stockItems && Array.isArray(masked.stockItems)) {
    masked.stockItems = masked.stockItems.map((i: any) => maskSensitiveFields(i, role));
  }
  if (masked.orderItems && Array.isArray(masked.orderItems)) {
    masked.orderItems = masked.orderItems.map((i: any) => maskSensitiveFields(i, role));
  }

  return masked;
}
