import crypto from 'crypto';
import { PrismaClient, Prisma, AlertType, AlertSeverity, AlertStatus } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { NotFoundError } from '../../common/errors/app-error';

export interface AlertEvaluationInput {
  storeId: number;
  stockItemId: number;
  sku: string;
  productName: string;
  availableStock: number;
  reorderPoint: number;
  stockoutScore: number;
  stockoutSeverity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  overstockScore: number;
  overstockSeverity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  isSlowMoving: boolean;
  isDeadStock: boolean;
  deadStockSeverity: 'NONE' | 'WARNING' | 'CRITICAL';
  daysSinceLastSale: number | null;
  confidenceScore: number;
  engineVersion?: string;
  unusualDemand: {
    isAnomaly: boolean;
    type: 'NONE' | 'CRITICAL_SPIKE' | 'HIGH_SPIKE' | 'DEMAND_DROP' | 'NEW_DEMAND_SPIKE';
    zScore: number;
  };
}

export class AlertService {
  constructor(private readonly prisma: PrismaClient = defaultPrisma) {}

  public static computeFingerprint(storeId: number, stockItemId: number, type: AlertType): string {
    const raw = `${storeId}|${stockItemId}|${type}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  /**
   * Evaluates analysis result and syncs deduplicated Alert records.
   */
  async syncAlertsForSku(input: AlertEvaluationInput): Promise<void> {
    const {
      storeId,
      stockItemId,
      sku,
      productName,
      availableStock,
      reorderPoint,
      stockoutScore,
      stockoutSeverity,
      overstockScore,
      isDeadStock,
      deadStockSeverity,
      daysSinceLastSale,
      confidenceScore,
      engineVersion = 'DECISION_ENGINE_V1',
      unusualDemand,
    } = input;

    // 1. Determine active alert triggers
    // Priority: STOCKOUT supersedes LOW_STOCK (mutually exclusive)
    let stockoutTrigger: {
      type: AlertType;
      severity: AlertSeverity;
      riskScore: number;
      title: string;
      message: string;
      reasonJson: Record<string, unknown>;
    } | null = null;

    if (availableStock <= 0) {
      stockoutTrigger = {
        type: 'STOCKOUT',
        severity: 'CRITICAL',
        riskScore: 100,
        title: `Hết hàng: SKU ${sku} (${productName})`,
        message: `SKU ${sku} hiện có sẵn 0 sản phẩm trong kho. Cần nhập hàng khẩn cấp.`,
        reasonJson: { availableStock, reorderPoint, stockoutScore: 100 },
      };
    } else if (availableStock <= reorderPoint || stockoutScore >= 50) {
      const sev: AlertSeverity =
        stockoutSeverity === 'CRITICAL' ? 'CRITICAL' : stockoutSeverity === 'HIGH' ? 'WARNING' : 'INFO';
      stockoutTrigger = {
        type: 'LOW_STOCK',
        severity: sev,
        riskScore: stockoutScore,
        title: `Cảnh báo tồn kho thấp: SKU ${sku}`,
        message: `SKU ${sku} chỉ còn ${availableStock} đơn vị khả dụng, dưới điểm đặt hàng ${reorderPoint}.`,
        reasonJson: { availableStock, reorderPoint, stockoutScore },
      };
    }

    // Overstock / Deadstock Trigger
    let overstockTrigger: {
      type: AlertType;
      severity: AlertSeverity;
      riskScore: number;
      title: string;
      message: string;
      reasonJson: Record<string, unknown>;
    } | null = null;

    if (isDeadStock) {
      const sev: AlertSeverity = deadStockSeverity === 'CRITICAL' ? 'CRITICAL' : 'WARNING';
      overstockTrigger = {
        type: 'DEAD_STOCK',
        severity: sev,
        riskScore: overstockScore,
        title: `Hàng tồn kho ứ đọng (Dead Stock): SKU ${sku}`,
        message: `SKU ${sku} không có giao dịch bán hàng trong ${daysSinceLastSale ?? 90} ngày qua. Cần xem xét giảm giá xả hàng.`,
        reasonJson: { daysSinceLastSale, overstockScore, deadStockSeverity },
      };
    } else if (overstockScore >= 50) {
      overstockTrigger = {
        type: 'OVERSTOCK',
        severity: overstockScore >= 75 ? 'WARNING' : 'INFO',
        riskScore: overstockScore,
        title: `Cảnh báo thừa hàng: SKU ${sku}`,
        message: `SKU ${sku} có mức tồn kho vượt ngưỡng an toàn so với tốc độ tiêu thụ hiện tại.`,
        reasonJson: { overstockScore, availableStock },
      };
    }

    // Unusual Demand Trigger
    let anomalyTrigger: {
      type: AlertType;
      severity: AlertSeverity;
      riskScore: number;
      title: string;
      message: string;
      reasonJson: Record<string, unknown>;
    } | null = null;

    if (unusualDemand.isAnomaly) {
      const sev: AlertSeverity = unusualDemand.type === 'CRITICAL_SPIKE' ? 'CRITICAL' : 'WARNING';
      anomalyTrigger = {
        type: 'UNUSUAL_DEMAND',
        severity: sev,
        riskScore: Math.min(100, Math.round(Math.abs(unusualDemand.zScore) * 20)),
        title: `Nhu cầu bất thường: SKU ${sku}`,
        message:
          unusualDemand.type === 'NEW_DEMAND_SPIKE'
            ? `SKU ${sku} bất ngờ phát sinh lượt bán mới sau thời gian dài không có nhu cầu.`
            : `SKU ${sku} có biến động nhu cầu đột biến (Z-Score: ${unusualDemand.zScore}).`,
        reasonJson: unusualDemand,
      };
    }

    const triggers = [stockoutTrigger, overstockTrigger, anomalyTrigger].filter(Boolean) as Array<
      NonNullable<typeof stockoutTrigger>
    >;

    const activeTriggerTypes = new Set<AlertType>(triggers.map((t) => t.type));

    // Upsert or reopen triggers
    for (const trigger of triggers) {
      const fingerprint = AlertService.computeFingerprint(storeId, stockItemId, trigger.type);
      const existing = await this.prisma.alert.findUnique({
        where: { storeId_fingerprint: { storeId, fingerprint } },
      });

      if (!existing) {
        await this.prisma.alert.create({
          data: {
            storeId,
            stockItemId,
            type: trigger.type,
            severity: trigger.severity,
            status: 'OPEN',
            riskScore: new Prisma.Decimal(trigger.riskScore),
            confidence: new Prisma.Decimal(confidenceScore),
            title: trigger.title,
            message: trigger.message,
            reasonJson: trigger.reasonJson as Prisma.InputJsonValue,
            fingerprint,
            engineVersion,
            openedAt: new Date(),
          },
        });
      } else {
        const shouldReopen = existing.status === 'RESOLVED';
        await this.prisma.alert.update({
          where: { id: existing.id },
          data: {
            severity: trigger.severity,
            riskScore: new Prisma.Decimal(trigger.riskScore),
            confidence: new Prisma.Decimal(confidenceScore),
            title: trigger.title,
            message: trigger.message,
            reasonJson: trigger.reasonJson as Prisma.InputJsonValue,
            engineVersion,
            ...(shouldReopen ? { status: 'OPEN', openedAt: new Date(), resolvedAt: null } : {}),
          },
        });
      }
    }

    // Auto-resolve alerts of types that are no longer active
    const allPossibleTypes: AlertType[] = [
      'LOW_STOCK',
      'STOCKOUT',
      'OVERSTOCK',
      'SLOW_MOVING',
      'DEAD_STOCK',
      'UNUSUAL_DEMAND',
    ];
    for (const type of allPossibleTypes) {
      // If STOCKOUT is active, make sure LOW_STOCK is resolved
      if (type === 'LOW_STOCK' && activeTriggerTypes.has('STOCKOUT')) {
        const fp = AlertService.computeFingerprint(storeId, stockItemId, 'LOW_STOCK');
        await this.prisma.alert.updateMany({
          where: { storeId, fingerprint: fp, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
          data: { status: 'RESOLVED', resolvedAt: new Date() },
        });
      } else if (!activeTriggerTypes.has(type)) {
        const fp = AlertService.computeFingerprint(storeId, stockItemId, type);
        await this.prisma.alert.updateMany({
          where: { storeId, fingerprint: fp, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
          data: { status: 'RESOLVED', resolvedAt: new Date() },
        });
      }
    }
  }

  async listAlerts(
    storeId: number,
    query: {
      status?: AlertStatus;
      type?: AlertType;
      severity?: AlertSeverity;
      stockItemId?: number;
      page: number;
      limit: number;
    }
  ) {
    const where: Prisma.AlertWhereInput = {
      storeId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.severity ? { severity: query.severity } : {}),
      ...(query.stockItemId ? { stockItemId: query.stockItemId } : {}),
    };

    const [total, items] = await Promise.all([
      this.prisma.alert.count({ where }),
      this.prisma.alert.findMany({
        where,
        orderBy: [{ openedAt: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          stockItem: {
            select: {
              id: true,
              sku: true,
              name: true,
              costPrice: true,
              sellingPrice: true,
            },
          },
        },
      }),
    ]);

    return {
      items,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  async acknowledgeAlert(storeId: number, alertId: number) {
    const alert = await this.prisma.alert.findUnique({
      where: { id: alertId },
    });

    if (!alert || alert.storeId !== storeId) {
      throw new NotFoundError('Không tìm thấy cảnh báo');
    }

    const updated = await this.prisma.alert.update({
      where: { id: alertId },
      data: { status: 'ACKNOWLEDGED' },
    });

    return updated;
  }

  async resolveAlert(storeId: number, alertId: number) {
    const alert = await this.prisma.alert.findUnique({
      where: { id: alertId },
    });

    if (!alert || alert.storeId !== storeId) {
      throw new NotFoundError('Không tìm thấy cảnh báo');
    }

    const updated = await this.prisma.alert.update({
      where: { id: alertId },
      data: { status: 'RESOLVED', resolvedAt: new Date() },
    });

    return updated;
  }
}
