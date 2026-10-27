import crypto from 'crypto';
import { PrismaClient, Prisma, AlertType, AlertSeverity, AlertStatus, Role } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { ConflictError, NotFoundError } from '../../common/errors/app-error';
import { AuditLogService } from '../../common/services/audit-log.service';
import { canViewFinancials } from '../../common/utils/role-access';
import { logger } from '../../common/logger';
import { classifyRisk } from '../decision-engine/risk-classification';

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
  /** Store risk bands (engine config); defaults match DEFAULT_ENGINE_CONFIG. */
  highRiskThreshold?: number;
  criticalRiskThreshold?: number;
}

/**
 * Human lifecycle metadata stored under `reasonJson.lifecycle`. The engine rewrites the rest of
 * reasonJson on every evaluation, so this key must be carried over explicitly.
 */
export interface AlertLifecycleMeta {
  acknowledgedById?: number | null;
  acknowledgedAt?: string;
  acknowledgementNote?: string | null;
  resolvedBy?: 'USER' | 'ENGINE';
  resolvedById?: number | null;
}

export interface AcknowledgeAlertOptions {
  note?: string;
  actorRole?: Role;
}

export function readAlertLifecycle(reasonJson: Prisma.JsonValue | null | undefined): AlertLifecycleMeta {
  if (reasonJson && typeof reasonJson === 'object' && !Array.isArray(reasonJson)) {
    const lifecycle = (reasonJson as Record<string, unknown>).lifecycle;
    if (lifecycle && typeof lifecycle === 'object' && !Array.isArray(lifecycle)) {
      return lifecycle as AlertLifecycleMeta;
    }
  }
  return {};
}

function withAlertLifecycle(reasonJson: Prisma.JsonValue | null | undefined, lifecycle: AlertLifecycleMeta): Prisma.InputJsonValue {
  const base =
    reasonJson && typeof reasonJson === 'object' && !Array.isArray(reasonJson)
      ? (reasonJson as Record<string, unknown>)
      : {};
  return { ...base, lifecycle } as unknown as Prisma.InputJsonValue;
}

export class AlertService {
  constructor(private readonly prisma: PrismaClient = defaultPrisma) {}

  public static computeFingerprint(storeId: number, stockItemId: number, type: AlertType): string {
    const raw = `${storeId}|${stockItemId}|${type}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  /**
   * Evaluates analysis result and syncs deduplicated Alert records.
   * Pass the caller's transaction client so alerts, notifications, recommendations, and the
   * decision snapshot of one recomputation commit atomically (see DecisionEngineService.recomputeSku).
   */
  async syncAlertsForSku(input: AlertEvaluationInput, db: Prisma.TransactionClient | PrismaClient = this.prisma): Promise<void> {
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
      highRiskThreshold = 50,
      criticalRiskThreshold = 75,
    } = input;

    // Same categories as the Decision Engine overview (see risk-classification.ts).
    const classification = classifyRisk({
      availableStock,
      reorderPoint,
      stockoutScore,
      overstockScore,
      isDeadStock,
      highRiskThreshold,
    });

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

    if (classification.outOfStock) {
      stockoutTrigger = {
        type: 'STOCKOUT',
        severity: 'CRITICAL',
        riskScore: 100,
        title: `Hết hàng: ${sku} (${productName})`,
        message: `Sản phẩm ${sku} hiện có sẵn 0 sản phẩm trong kho. Cần nhập hàng khẩn cấp.`,
        reasonJson: { availableStock, reorderPoint, stockoutScore: 100 },
      };
    } else if (classification.stockoutRisk) {
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
    } else if (classification.overstockRisk) {
      overstockTrigger = {
        type: 'OVERSTOCK',
        severity: overstockScore >= criticalRiskThreshold ? 'WARNING' : 'INFO',
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
      const existing = await db.alert.findUnique({
        where: { storeId_fingerprint: { storeId, fingerprint } },
      });

      if (!existing) {
        const createdAlert = await db.alert.create({
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

        await this.notifyStoreUsers(db, storeId, createdAlert.id, trigger.title, trigger.message);
      } else {
        // Edge-triggered: an alert the owner resolved by hand stays resolved while its condition
        // persists; it reopens only after the engine has seen the condition clear (resolvedBy ENGINE).
        if (existing.status === 'RESOLVED' && readAlertLifecycle(existing.reasonJson).resolvedBy === 'USER') {
          continue;
        }

        const shouldReopen = existing.status === 'RESOLVED';
        await db.alert.update({
          where: { id: existing.id },
          data: {
            severity: trigger.severity,
            riskScore: new Prisma.Decimal(trigger.riskScore),
            confidence: new Prisma.Decimal(confidenceScore),
            title: trigger.title,
            message: trigger.message,
            reasonJson: withAlertLifecycle(
              trigger.reasonJson as Prisma.JsonValue,
              shouldReopen ? {} : readAlertLifecycle(existing.reasonJson)
            ),
            engineVersion,
            ...(shouldReopen ? { status: 'OPEN', openedAt: new Date(), resolvedAt: null } : {}),
          },
        });

        if (shouldReopen) {
          await this.notifyStoreUsers(db, storeId, existing.id, trigger.title, trigger.message);
        }
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
        await db.alert.updateMany({
          where: { storeId, fingerprint: fp, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
          data: { status: 'RESOLVED', resolvedAt: new Date() },
        });
      } else if (!activeTriggerTypes.has(type)) {
        const fp = AlertService.computeFingerprint(storeId, stockItemId, type);
        await db.alert.updateMany({
          where: { storeId, fingerprint: fp, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
          data: { status: 'RESOLVED', resolvedAt: new Date() },
        });
      }
    }

    // The condition of every inactive type has cleared: hand user-resolved alerts back to the engine
    // so a future occurrence reopens them.
    const inactiveFingerprints = allPossibleTypes
      .filter((type) => !activeTriggerTypes.has(type))
      .map((type) => AlertService.computeFingerprint(storeId, stockItemId, type));
    if (inactiveFingerprints.length > 0) {
      await db.$executeRaw`
        UPDATE alerts
        SET reasonJson = JSON_SET(reasonJson, '$.lifecycle.resolvedBy', 'ENGINE')
        WHERE storeId = ${storeId}
          AND fingerprint IN (${Prisma.join(inactiveFingerprints)})
          AND status = 'RESOLVED'
          AND JSON_UNQUOTE(JSON_EXTRACT(reasonJson, '$.lifecycle.resolvedBy')) = 'USER'`;
    }
  }

  /**
   * Notifies this store's operators about a new or reopened alert. Tenant isolation: alert content
   * (SKU, product name) never goes to platform ADMIN accounts. A dispatch failure is logged and does
   * not block the alert itself.
   */
  private async notifyStoreUsers(
    db: Prisma.TransactionClient | PrismaClient,
    storeId: number,
    alertId: number,
    title: string,
    message: string
  ) {
    try {
      const storeUsers = await db.user.findMany({
        where: { storeId, isActive: true, role: { in: ['SHOP_OWNER', 'WAREHOUSE_STAFF'] } },
        select: { id: true },
      });
      if (storeUsers.length > 0) {
        await db.notification.createMany({
          data: storeUsers.map((u) => ({
            storeId,
            userId: u.id,
            type: 'alert',
            title,
            message,
            entityType: 'ALERT',
            entityId: String(alertId),
            isRead: false,
          })),
        });
      }
    } catch (err) {
      // Ignore notification dispatch error so alert creation is not blocked
      logger.warn('alert_notification_dispatch_failed', { storeId, alertId, error: err });
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
    },
    role?: Role
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
              // D9: cost is not even read for staff; the response middleware is only a second layer.
              costPrice: canViewFinancials(role),
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

  /**
   * Store operators (owner or staff) acknowledge an alert to report "seen / escalated".
   * When staff acknowledge, every active owner of the store is notified in the same transaction.
   * Allowed transitions: OPEN -> ACKNOWLEDGED; repeating on ACKNOWLEDGED is a no-op.
   */
  async acknowledgeAlert(storeId: number, alertId: number, userId?: number, options: AcknowledgeAlertOptions = {}) {
    return this.prisma.$transaction(async (tx) => {
      const alert = await tx.alert.findFirst({
        where: { id: alertId, storeId },
      });

      if (!alert) {
        throw new NotFoundError('Không tìm thấy cảnh báo');
      }

      if (alert.status === 'RESOLVED') {
        throw new ConflictError('ALERT_ALREADY_RESOLVED');
      }

      if (alert.status === 'ACKNOWLEDGED' && !options.note) {
        return alert;
      }

      const note = options.note?.trim() || null;
      const lifecycle: AlertLifecycleMeta = {
        ...readAlertLifecycle(alert.reasonJson),
        acknowledgedById: userId ?? null,
        acknowledgedAt: new Date().toISOString(),
        acknowledgementNote: note,
      };

      const updated = await tx.alert.update({
        where: { id: alert.id },
        data: {
          status: 'ACKNOWLEDGED',
          reasonJson: withAlertLifecycle(alert.reasonJson, lifecycle),
        },
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
          note,
        },
      });

      if (options.actorRole === 'WAREHOUSE_STAFF') {
        await this.notifyOwnersOfAcknowledgement(tx, storeId, updated, userId, note);
      }

      return updated;
    });
  }

  /**
   * Owner-only manual resolution. The engine will not immediately reopen a user-resolved alert
   * while its condition persists. Resolving an already resolved alert is an idempotent no-op.
   */
  async resolveAlert(storeId: number, alertId: number, userId?: number) {
    return this.prisma.$transaction(async (tx) => {
      const alert = await tx.alert.findFirst({
        where: { id: alertId, storeId },
      });

      if (!alert) {
        throw new NotFoundError('Không tìm thấy cảnh báo');
      }

      if (alert.status === 'RESOLVED') {
        return alert;
      }

      const updated = await tx.alert.update({
        where: { id: alert.id },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          reasonJson: withAlertLifecycle(alert.reasonJson, {
            ...readAlertLifecycle(alert.reasonJson),
            resolvedBy: 'USER',
            resolvedById: userId ?? null,
          }),
        },
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

  private async notifyOwnersOfAcknowledgement(
    tx: Prisma.TransactionClient,
    storeId: number,
    alert: { id: number; title: string },
    userId: number | undefined,
    note: string | null
  ) {
    const [owners, actor] = await Promise.all([
      tx.user.findMany({
        where: { storeId, role: 'SHOP_OWNER', isActive: true },
        select: { id: true },
      }),
      userId
        ? tx.user.findFirst({ where: { id: userId, storeId }, select: { fullName: true, email: true } })
        : Promise.resolve(null),
    ]);

    if (owners.length === 0) {
      return;
    }

    const actorName = actor?.fullName || actor?.email || 'Nhân viên kho';
    await tx.notification.createMany({
      data: owners.map((owner) => ({
        storeId,
        userId: owner.id,
        type: 'alert_ack',
        title: `${actorName} đã xác nhận cảnh báo`,
        message: note ? `${alert.title}. Ghi chú: ${note}` : alert.title,
        entityType: 'ALERT',
        entityId: String(alert.id),
        isRead: false,
      })),
    });
  }
}
