import { PrismaClient, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';

export interface ResolvedStockPolicy {
  leadTimeDays: number;
  safetyDays: number;
  serviceLevel: number;
  targetCoverageDays: number;
  deadStockDays: number;
  minimumMarginPct: number;
  source: 'DEFAULT' | 'CUSTOM';
}

export const DEFAULT_STOCK_POLICY: ResolvedStockPolicy = {
  leadTimeDays: 7,
  safetyDays: 3,
  serviceLevel: 0.95,
  targetCoverageDays: 30,
  deadStockDays: 90,
  minimumMarginPct: 0.1,
  source: 'DEFAULT',
};

export class PolicyService {
  constructor(private readonly prisma: PrismaClient = defaultPrisma) {}

  async getPolicy(storeId: number, stockItemId: number): Promise<ResolvedStockPolicy> {
    const policy = await this.prisma.stockPolicy.findUnique({
      where: {
        storeId_stockItemId: {
          storeId,
          stockItemId,
        },
      },
    });

    if (!policy) {
      return { ...DEFAULT_STOCK_POLICY };
    }

    return {
      leadTimeDays: policy.leadTimeDays,
      safetyDays: policy.safetyDays,
      serviceLevel: Number(policy.serviceLevel),
      targetCoverageDays: policy.targetCoverageDays,
      deadStockDays: policy.deadStockDays,
      minimumMarginPct: Number(policy.minimumMarginPct),
      source: 'CUSTOM',
    };
  }

  async upsertPolicy(
    storeId: number,
    stockItemId: number,
    data: {
      leadTimeDays?: number;
      safetyDays?: number;
      serviceLevel?: number;
      targetCoverageDays?: number;
      deadStockDays?: number;
      minimumMarginPct?: number;
    }
  ): Promise<ResolvedStockPolicy> {
    const updated = await this.prisma.stockPolicy.upsert({
      where: {
        storeId_stockItemId: {
          storeId,
          stockItemId,
        },
      },
      update: {
        ...(data.leadTimeDays !== undefined ? { leadTimeDays: data.leadTimeDays } : {}),
        ...(data.safetyDays !== undefined ? { safetyDays: data.safetyDays } : {}),
        ...(data.serviceLevel !== undefined ? { serviceLevel: new Prisma.Decimal(data.serviceLevel) } : {}),
        ...(data.targetCoverageDays !== undefined ? { targetCoverageDays: data.targetCoverageDays } : {}),
        ...(data.deadStockDays !== undefined ? { deadStockDays: data.deadStockDays } : {}),
        ...(data.minimumMarginPct !== undefined ? { minimumMarginPct: new Prisma.Decimal(data.minimumMarginPct) } : {}),
      },
      create: {
        storeId,
        stockItemId,
        leadTimeDays: data.leadTimeDays ?? DEFAULT_STOCK_POLICY.leadTimeDays,
        safetyDays: data.safetyDays ?? DEFAULT_STOCK_POLICY.safetyDays,
        serviceLevel: new Prisma.Decimal(data.serviceLevel ?? DEFAULT_STOCK_POLICY.serviceLevel),
        targetCoverageDays: data.targetCoverageDays ?? DEFAULT_STOCK_POLICY.targetCoverageDays,
        deadStockDays: data.deadStockDays ?? DEFAULT_STOCK_POLICY.deadStockDays,
        minimumMarginPct: new Prisma.Decimal(data.minimumMarginPct ?? DEFAULT_STOCK_POLICY.minimumMarginPct),
      },
    });

    return {
      leadTimeDays: updated.leadTimeDays,
      safetyDays: updated.safetyDays,
      serviceLevel: Number(updated.serviceLevel),
      targetCoverageDays: updated.targetCoverageDays,
      deadStockDays: updated.deadStockDays,
      minimumMarginPct: Number(updated.minimumMarginPct),
      source: 'CUSTOM',
    };
  }
}
