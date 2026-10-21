import crypto from 'crypto';
import { PrismaClient, Prisma, AlertType, AlertSeverity, AlertStatus } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { NotFoundError } from '../../common/errors/app-error';
import { AuditLogService } from '../../common/services/audit-log.service';

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
      isSlowMoving,
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
        title: `Hết hàng: ${sku} (${productName})`,
        message: `Sản phẩm ${sku} hiện có sẵn 0 sản phẩm trong kho. Cần nhập hàng khẩn cấp.`,
        reasonJson: { availableStock, reorderPoint, stockoutScore: 100 },
      };
    } else if (availableStock <= reorderPoint || stockoutScore >= 50) {
      const sev: AlertSeverity =
        stockoutSeverity === 'CRITICAL' ? 'CRITICAL' : stockoutSeverity === 'HIGH' ? 'WARNING' : 'INFO';
      stockoutTrigger = {
        type: 'LOW_STOCK',
        severity: sev,
        riskScore: stockoutScore,
        title: `Cảnh báo tồn kho thấp: ${sku}`,
        message: `Sản phẩm ${sku} chỉ còn ${availableStock} đơn vị khả dụng, dưới điểm đặt hàng ${reorderPoint}.`,
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
        title: `Hàng tồn kho ứ đọng: ${sku}`,
        message: `Sản phẩm ${sku} không có giao dịch bán hàng trong ${daysSinceLastSale ?? 90} ngày qua. Cần xem xét giảm giá xả hàng.`,
        reasonJson: { daysSinceLastSale, overstockScore, deadStockSeverity },
      };
    } else if (overstockScore >= 50) {
      overstockTrigger = {
        type: 'OVERSTOCK',
        severity: overstockScore >= 75 ? 'WARNING' : 'INFO',
        riskScore: overstockScore,
        title: `Cảnh báo thừa hàng: ${sku}`,
        message: `Sản phẩm ${sku} có mức tồn kho vượt ngưỡng an toàn so với tốc độ tiêu thụ hiện tại.`,
        reasonJson: { overstockScore, availableStock },
      };
    }

    let slowMovingTrigger: {
      type: AlertType;
      severity: AlertSeverity;
      riskScore: number;
      title: string;
      message: string;
      reasonJson: Record<string, unknown>;
    } | null = null;

    if (!isDeadStock && isSlowMoving) {
      slowMovingTrigger = {
        type: 'SLOW_MOVING',
        severity: 'WARNING',
        riskScore: 0,
        title: `Hàng bán chậm: ${sku}`,
        message: `Sản phẩm ${sku} không ghi nhận doanh số bán trong ${daysSinceLastSale ?? 'nhiều'} ngày.`,
        reasonJson: { isSlowMoving, daysSinceLastSale, overstockScore },
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
        title: `Nhu cầu bất thường: ${sku}`,
        message:
          unusualDemand.type === 'NEW_DEMAND_SPIKE'
            ? `Sản phẩm ${sku} bất ngờ phát sinh lượt bán mới sau thời gian dài không có nhu cầu.`
            : `Sản phẩm ${sku} có biến động nhu cầu đột biến (Độ lệch chuẩn Z: ${unusualDemand.zScore}).`,
        reasonJson: unusualDemand,
      };
    }

    const triggers = [stockoutTrigger, overstockTrigger, slowMovingTrigger, anomalyTrigger].filter(Boolean) as Array<
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
        const createdAlert = await this.prisma.alert.create({
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

        try {
          const storeUsers = await this.prisma.user.findMany({
            where: { OR: [{ storeId }, { role: 'ADMIN' }], isActive: true },
            select: { id: true },
          });
          if (storeUsers.length > 0) {
            await this.prisma.notification.createMany({
              data: storeUsers.map((u) => ({
                storeId,
                userId: u.id,
                type: 'alert',
                title: trigger.title,
                message: trigger.message,
                entityType: 'ALERT',
                entityId: String(createdAlert.id),
                isRead: false,
              })),
            });
          }
        } catch (_) {}
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

  async getStats(storeId: number) {
    const [criticalCount, warningCount, infoCount, openCount, acknowledgedCount, resolvedCount, totalCount] =
      await Promise.all([
        this.prisma.alert.count({ where: { storeId, status: { in: ['OPEN', 'ACKNOWLEDGED'] }, severity: 'CRITICAL' } }),
        this.prisma.alert.count({ where: { storeId, status: { in: ['OPEN', 'ACKNOWLEDGED'] }, severity: 'WARNING' } }),
        this.prisma.alert.count({ where: { storeId, status: { in: ['OPEN', 'ACKNOWLEDGED'] }, severity: 'INFO' } }),
        this.prisma.alert.count({ where: { storeId, status: 'OPEN' } }),
        this.prisma.alert.count({ where: { storeId, status: 'ACKNOWLEDGED' } }),
        this.prisma.alert.count({ where: { storeId, status: 'RESOLVED' } }),
        this.prisma.alert.count({ where: { storeId } }),
      ]);

    return {
      criticalCount,
      warningCount,
      infoCount,
      openCount,
      acknowledgedCount,
      resolvedCount,
      totalCount,
      activeCount: openCount + acknowledgedCount,
    };
  }

  async getAlertStats(storeId: number) {
    return this.getStats(storeId);
  }

  async acknowledgeAlert(storeId: number, alertId: number, userId?: number) {
    return this.prisma.$transaction(async (tx) => {
    const alert = await tx.alert.findUnique({
      where: { id: alertId },
    });

    if (!alert || alert.storeId !== storeId) {
      throw new NotFoundError('Không tìm thấy cảnh báo');
    }

    const updated = await tx.alert.update({
      where: { id: alertId },
      data: { status: 'ACKNOWLEDGED' },
    });

    await AuditLogService.create(tx, {
      storeId,
      userId: userId ?? null,
      action: 'ALERT_ACKNOWLEDGED',
      entityType: 'ALERT',
      entityId: alertId,
      beforeJson: { status: alert.status },
      afterJson: {
        status: updated.status,
        type: updated.type,
        stockItemId: updated.stockItemId,
      },
    });

    return updated;
    });
  }

  async resolveAlert(storeId: number, alertId: number, userId?: number) {
    return this.prisma.$transaction(async (tx) => {
    const alert = await tx.alert.findUnique({
      where: { id: alertId },
    });

    if (!alert || alert.storeId !== storeId) {
      throw new NotFoundError('Không tìm thấy cảnh báo');
    }

    const updated = await tx.alert.update({
      where: { id: alertId },
      data: { status: 'RESOLVED', resolvedAt: new Date() },
    });

    await AuditLogService.create(tx, {
      storeId,
      userId: userId ?? null,
      action: 'ALERT_RESOLVED',
      entityType: 'ALERT',
      entityId: alertId,
      beforeJson: { status: alert.status },
      afterJson: {
        status: updated.status,
        type: updated.type,
        stockItemId: updated.stockItemId,
        resolvedAt: updated.resolvedAt,
      },
    });

    return updated;
    });
  }
}
