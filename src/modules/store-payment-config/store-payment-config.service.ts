import { PaymentProvider, PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db';
import { AuditLogService } from '../../common/services/audit-log.service';
import { SecretEncryptionService } from '../../common/services/secret-encryption.service';
import { NotFoundError } from '../../common/errors/app-error';

export interface UpsertPayosConfigInput {
  clientId: string;
  apiKey: string;
  checksumKey: string;
  isActive?: boolean;
}

export class StorePaymentConfigService {
  constructor(private readonly db: PrismaClient = prisma) {}

  async getPayosStatus(storeId: number) {
    const config = await this.db.storePaymentConfig.findUnique({
      where: { storeId_provider: { storeId, provider: PaymentProvider.PAYOS } },
    });

    if (!config) {
      return {
        provider: PaymentProvider.PAYOS,
        configured: false,
        active: false,
      };
    }

    const clientId = SecretEncryptionService.decrypt(config.clientIdEncrypted);

    return {
      provider: config.provider,
      configured: true,
      active: config.isActive,
      clientIdMasked: maskSecret(clientId),
      configuredAt: config.configuredAt,
      updatedAt: config.updatedAt,
    };
  }

  async upsertPayosConfig(storeId: number, actorUserId: number, input: UpsertPayosConfigInput) {
    const encryptedPayload = {
      clientIdEncrypted: SecretEncryptionService.encrypt(input.clientId),
      apiKeyEncrypted: SecretEncryptionService.encrypt(input.apiKey),
      checksumKeyEncrypted: SecretEncryptionService.encrypt(input.checksumKey),
      isActive: input.isActive ?? true,
      configuredAt: new Date(),
    };

    const config = await this.db.$transaction(async (tx) => {
      const existing = await tx.storePaymentConfig.findUnique({
        where: { storeId_provider: { storeId, provider: PaymentProvider.PAYOS } },
        select: { id: true, isActive: true },
      });

      const saved = await tx.storePaymentConfig.upsert({
        where: { storeId_provider: { storeId, provider: PaymentProvider.PAYOS } },
        create: {
          storeId,
          provider: PaymentProvider.PAYOS,
          ...encryptedPayload,
        },
        update: encryptedPayload,
      });

      const wasUpdated = Boolean(existing);

      await AuditLogService.create(tx, {
        storeId,
        userId: actorUserId,
        action: wasUpdated ? 'PAYMENT_CONFIG_UPDATED' : 'PAYMENT_CONFIG_CREATED',
        entityType: 'STORE_PAYMENT_CONFIG',
        entityId: saved.id,
        beforeJson: wasUpdated
          ? {
              provider: PaymentProvider.PAYOS,
              active: existing!.isActive,
            }
          : undefined,
        afterJson: {
          provider: saved.provider,
          active: saved.isActive,
          configuredAt: saved.configuredAt,
        },
      });

      return saved;
    });

    const clientId = SecretEncryptionService.decrypt(config.clientIdEncrypted);

    return {
      provider: config.provider,
      configured: true,
      active: config.isActive,
      clientIdMasked: maskSecret(clientId),
      configuredAt: config.configuredAt,
      updatedAt: config.updatedAt,
    };
  }

  async deactivatePayosConfig(storeId: number, actorUserId: number) {
    const existing = await this.db.storePaymentConfig.findUnique({
      where: { storeId_provider: { storeId, provider: PaymentProvider.PAYOS } },
      select: { id: true, isActive: true },
    });

    if (!existing) {
      throw new NotFoundError('Payment configuration was not found');
    }

    const config = await this.db.$transaction(async (tx) => {
      const saved = await tx.storePaymentConfig.update({
        where: { id: existing.id },
        data: { isActive: false },
      });

      await AuditLogService.create(tx, {
        storeId,
        userId: actorUserId,
        action: 'PAYMENT_CONFIG_DISABLED',
        entityType: 'STORE_PAYMENT_CONFIG',
        entityId: saved.id,
        beforeJson: {
          provider: PaymentProvider.PAYOS,
          active: existing.isActive,
        },
        afterJson: {
          provider: saved.provider,
          active: saved.isActive,
        },
      });

      return saved;
    });

    return {
      provider: config.provider,
      configured: true,
      active: config.isActive,
      configuredAt: config.configuredAt,
      updatedAt: config.updatedAt,
    };
  }
}

function maskSecret(value: string): string {
  if (value.length <= 6) {
    return `${value.slice(0, 1)}***${value.slice(-1)}`;
  }

  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}
