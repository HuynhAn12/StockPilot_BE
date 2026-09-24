import { PrismaClient, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';

export interface ResolvedEngineConfig {
  leadTimeDays: number;
  safetyDays: number;
  serviceLevel: number;
  targetCoverageDays: number;
  slowMovingDays: number;
  deadStockDays: number;
  minimumHistoryDays: number;
  minimumMarginPct: number;
  maxMarkdownPct: number;
  maxMarkupPct: number;
  lowRiskThreshold: number;
  highRiskThreshold: number;
  criticalRiskThreshold: number;
  engineVersion: string;
  source: 'DEFAULT' | 'CUSTOM';
}

export const DEFAULT_ENGINE_CONFIG: ResolvedEngineConfig = {
  leadTimeDays: 7,
  safetyDays: 3,
  serviceLevel: 0.95,
  targetCoverageDays: 30,
  slowMovingDays: 60,
  deadStockDays: 90,
  minimumHistoryDays: 14,
  minimumMarginPct: 0.20,
  maxMarkdownPct: 0.30,
  maxMarkupPct: 0.20,
  lowRiskThreshold: 25,
  highRiskThreshold: 50,
  criticalRiskThreshold: 75,
  engineVersion: 'DECISION_ENGINE_V1',
  source: 'DEFAULT',
};

export class EngineConfigService {
  constructor(private readonly prisma: PrismaClient = defaultPrisma) {}

  async getConfig(storeId: number): Promise<ResolvedEngineConfig> {
    const config = await this.prisma.engineConfig.findUnique({
      where: { storeId },
    });

    if (!config) {
      return { ...DEFAULT_ENGINE_CONFIG };
    }

    return {
      leadTimeDays: config.leadTimeDays,
      safetyDays: config.safetyDays,
      serviceLevel: Number(config.serviceLevel),
      targetCoverageDays: config.targetCoverageDays,
      slowMovingDays: config.slowMovingDays,
      deadStockDays: config.deadStockDays,
      minimumHistoryDays: config.minimumHistoryDays,
      minimumMarginPct: Number(config.minimumMarginPct),
      maxMarkdownPct: Number(config.maxMarkdownPct),
      maxMarkupPct: Number(config.maxMarkupPct),
      lowRiskThreshold: config.lowRiskThreshold,
      highRiskThreshold: config.highRiskThreshold,
      criticalRiskThreshold: config.criticalRiskThreshold,
      engineVersion: config.engineVersion,
      source: 'CUSTOM',
    };
  }

  async upsertConfig(
    storeId: number,
    data: {
      leadTimeDays?: number;
      safetyDays?: number;
      serviceLevel?: number;
      targetCoverageDays?: number;
      slowMovingDays?: number;
      deadStockDays?: number;
      minimumHistoryDays?: number;
      minimumMarginPct?: number;
      maxMarkdownPct?: number;
      maxMarkupPct?: number;
      lowRiskThreshold?: number;
      highRiskThreshold?: number;
      criticalRiskThreshold?: number;
    }
  ): Promise<ResolvedEngineConfig> {
    const updated = await this.prisma.engineConfig.upsert({
      where: { storeId },
      update: {
        ...(data.leadTimeDays !== undefined ? { leadTimeDays: data.leadTimeDays } : {}),
        ...(data.safetyDays !== undefined ? { safetyDays: data.safetyDays } : {}),
        ...(data.serviceLevel !== undefined ? { serviceLevel: new Prisma.Decimal(data.serviceLevel) } : {}),
        ...(data.targetCoverageDays !== undefined ? { targetCoverageDays: data.targetCoverageDays } : {}),
        ...(data.slowMovingDays !== undefined ? { slowMovingDays: data.slowMovingDays } : {}),
        ...(data.deadStockDays !== undefined ? { deadStockDays: data.deadStockDays } : {}),
        ...(data.minimumHistoryDays !== undefined ? { minimumHistoryDays: data.minimumHistoryDays } : {}),
        ...(data.minimumMarginPct !== undefined ? { minimumMarginPct: new Prisma.Decimal(data.minimumMarginPct) } : {}),
        ...(data.maxMarkdownPct !== undefined ? { maxMarkdownPct: new Prisma.Decimal(data.maxMarkdownPct) } : {}),
        ...(data.maxMarkupPct !== undefined ? { maxMarkupPct: new Prisma.Decimal(data.maxMarkupPct) } : {}),
        ...(data.lowRiskThreshold !== undefined ? { lowRiskThreshold: data.lowRiskThreshold } : {}),
        ...(data.highRiskThreshold !== undefined ? { highRiskThreshold: data.highRiskThreshold } : {}),
        ...(data.criticalRiskThreshold !== undefined ? { criticalRiskThreshold: data.criticalRiskThreshold } : {}),
      },
      create: {
        storeId,
        leadTimeDays: data.leadTimeDays ?? DEFAULT_ENGINE_CONFIG.leadTimeDays,
        safetyDays: data.safetyDays ?? DEFAULT_ENGINE_CONFIG.safetyDays,
        serviceLevel: new Prisma.Decimal(data.serviceLevel ?? DEFAULT_ENGINE_CONFIG.serviceLevel),
        targetCoverageDays: data.targetCoverageDays ?? DEFAULT_ENGINE_CONFIG.targetCoverageDays,
        slowMovingDays: data.slowMovingDays ?? DEFAULT_ENGINE_CONFIG.slowMovingDays,
        deadStockDays: data.deadStockDays ?? DEFAULT_ENGINE_CONFIG.deadStockDays,
        minimumHistoryDays: data.minimumHistoryDays ?? DEFAULT_ENGINE_CONFIG.minimumHistoryDays,
        minimumMarginPct: new Prisma.Decimal(data.minimumMarginPct ?? DEFAULT_ENGINE_CONFIG.minimumMarginPct),
        maxMarkdownPct: new Prisma.Decimal(data.maxMarkdownPct ?? DEFAULT_ENGINE_CONFIG.maxMarkdownPct),
        maxMarkupPct: new Prisma.Decimal(data.maxMarkupPct ?? DEFAULT_ENGINE_CONFIG.maxMarkupPct),
        lowRiskThreshold: data.lowRiskThreshold ?? DEFAULT_ENGINE_CONFIG.lowRiskThreshold,
        highRiskThreshold: data.highRiskThreshold ?? DEFAULT_ENGINE_CONFIG.highRiskThreshold,
        criticalRiskThreshold: data.criticalRiskThreshold ?? DEFAULT_ENGINE_CONFIG.criticalRiskThreshold,
        engineVersion: DEFAULT_ENGINE_CONFIG.engineVersion,
      },
    });

    return {
      leadTimeDays: updated.leadTimeDays,
      safetyDays: updated.safetyDays,
      serviceLevel: Number(updated.serviceLevel),
      targetCoverageDays: updated.targetCoverageDays,
      slowMovingDays: updated.slowMovingDays,
      deadStockDays: updated.deadStockDays,
      minimumHistoryDays: updated.minimumHistoryDays,
      minimumMarginPct: Number(updated.minimumMarginPct),
      maxMarkdownPct: Number(updated.maxMarkdownPct),
      maxMarkupPct: Number(updated.maxMarkupPct),
      lowRiskThreshold: updated.lowRiskThreshold,
      highRiskThreshold: updated.highRiskThreshold,
      criticalRiskThreshold: updated.criticalRiskThreshold,
      engineVersion: updated.engineVersion,
      source: 'CUSTOM',
    };
  }
}
