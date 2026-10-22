import { PaymentConfigProvider, PrismaClient } from '@prisma/client';
import { PayOS } from '@payos/node';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { AuditLogService } from '../../common/services/audit-log.service';
import { SecretEncryptionService } from '../../common/services/secret-encryption.service';
import { NotFoundError, ValidationError } from '../../common/errors/app-error';

/** Shown when stored credentials were encrypted with a different PAYMENT_CONFIG_ENCRYPTION_KEY. */
export const PAYOS_CONFIG_UNREADABLE_MESSAGE =
  'Không đọc được cấu hình PayOS đã lưu vì khóa mã hóa trên máy chủ đã thay đổi. Chủ cửa hàng cần vào Cài đặt và nhập lại Client ID, API Key và Checksum Key.';

function canDecrypt(serialized: string): boolean {
  try {
    SecretEncryptionService.decrypt(serialized);
    return true;
  } catch {
    return false;
  }
}

export interface UpsertPayosConfigInput {
  clientId?: string;
  apiKey?: string;
  checksumKey?: string;
  isActive?: boolean;
}

export function resolvePayosWebhookUrl(reqOrigin?: string): {
  webhookUrl: string;
  webhookPath: string;
  isPublicDomain: boolean;
} {
  const webhookPath = '/api/v1/pos/payos/webhook';
  let origin = '';

  if (process.env.PUBLIC_API_URL && env.NODE_ENV !== 'test') {
    origin = process.env.PUBLIC_API_URL.trim().replace(/\/+$/, '');
  } else if (env.NODE_ENV === 'production') {
    origin = `https://${env.TENANT_ROOT_DOMAIN}`;
  } else if (reqOrigin) {
    origin = reqOrigin.trim().replace(/\/+$/, '');
  } else if (process.env.PUBLIC_API_URL) {
    origin = process.env.PUBLIC_API_URL.trim().replace(/\/+$/, '');
  } else {
    origin = `http://localhost:${env.PORT}`;
  }

  const webhookUrl = `${origin}${webhookPath}`;
  const isPublicDomain =
    webhookUrl.startsWith('https://') &&
    !webhookUrl.includes('localhost') &&
    !webhookUrl.includes('127.0.0.1');

  return { webhookUrl, webhookPath, isPublicDomain };
}

export class StorePaymentConfigService {
  constructor(
    private readonly db: PrismaClient = prisma,
    private readonly payosClientFactory: (options: any) => any = (opts) => new PayOS(opts)
  ) {}

  async getPayosStatus(storeId: number, reqOrigin?: string) {
    const config = await this.db.storePaymentConfig.findUnique({
      where: { storeId_provider: { storeId, provider: PaymentConfigProvider.PAYOS } },
    });

    const urlInfo = resolvePayosWebhookUrl(reqOrigin);

    if (!config) {
      return {
        provider: PaymentConfigProvider.PAYOS,
        configured: false,
        active: false,
        ...urlInfo,
      };
    }

    // Still return the status when secrets are unreadable so the owner can open settings and re-enter them.
    let clientIdMasked: string | null = null;
    let needsReentry = false;
    try {
      clientIdMasked = maskSecret(SecretEncryptionService.decrypt(config.clientIdEncrypted));
    } catch {
      needsReentry = true;
    }

    return {
      provider: config.provider,
      configured: true,
      active: config.isActive,
      clientIdMasked,
      needsReentry,
      ...(needsReentry ? { message: PAYOS_CONFIG_UNREADABLE_MESSAGE } : {}),
      configuredAt: config.configuredAt,
      updatedAt: config.updatedAt,
      ...urlInfo,
    };
  }

  async upsertPayosConfig(
    storeId: number,
    actorUserId: number,
    input: UpsertPayosConfigInput,
    reqOrigin?: string
  ) {
    const existing = await this.db.storePaymentConfig.findUnique({
      where: { storeId_provider: { storeId, provider: PaymentConfigProvider.PAYOS } },
      select: {
        id: true,
        isActive: true,
        clientIdEncrypted: true,
        apiKeyEncrypted: true,
        checksumKeyEncrypted: true,
      },
    });

    const hasNewClientId = Boolean(input.clientId && input.clientId.trim());
    const hasNewApiKey = Boolean(input.apiKey && input.apiKey.trim());
    const hasNewChecksumKey = Boolean(input.checksumKey && input.checksumKey.trim());

    if (!existing) {
      if (!hasNewClientId || !hasNewApiKey || !hasNewChecksumKey) {
        throw new ValidationError(
          'Vui lòng cung cấp đầy đủ Client ID, API Key và Checksum Key cho lần cấu hình đầu tiên.'
        );
      }
    } else {
      // Fields left blank keep their stored value, which only works if that value is still readable.
      const keptUnreadable =
        (!hasNewClientId && !canDecrypt(existing.clientIdEncrypted)) ||
        (!hasNewApiKey && !canDecrypt(existing.apiKeyEncrypted)) ||
        (!hasNewChecksumKey && !canDecrypt(existing.checksumKeyEncrypted));
      if (keptUnreadable) {
        throw new ValidationError(
          'Cấu hình PayOS cũ không còn đọc được (khóa mã hóa trên máy chủ đã thay đổi). Vui lòng nhập lại đầy đủ Client ID, API Key và Checksum Key.'
        );
      }
    }

    const clientIdEncrypted = hasNewClientId
      ? SecretEncryptionService.encrypt(input.clientId!.trim())
      : existing!.clientIdEncrypted;

    const apiKeyEncrypted = hasNewApiKey
      ? SecretEncryptionService.encrypt(input.apiKey!.trim())
      : existing!.apiKeyEncrypted;

    const checksumKeyEncrypted = hasNewChecksumKey
      ? SecretEncryptionService.encrypt(input.checksumKey!.trim())
      : existing!.checksumKeyEncrypted;

    const encryptedPayload = {
      clientIdEncrypted,
      apiKeyEncrypted,
      checksumKeyEncrypted,
      isActive: input.isActive ?? (existing ? existing.isActive : true),
      configuredAt: new Date(),
    };

    const config = await this.db.$transaction(async (tx) => {
      const saved = await tx.storePaymentConfig.upsert({
        where: { storeId_provider: { storeId, provider: PaymentConfigProvider.PAYOS } },
        create: {
          storeId,
          provider: PaymentConfigProvider.PAYOS,
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
              provider: PaymentConfigProvider.PAYOS,
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
    const apiKey = SecretEncryptionService.decrypt(config.apiKeyEncrypted);
    const checksumKey = SecretEncryptionService.decrypt(config.checksumKeyEncrypted);
    const urlInfo = resolvePayosWebhookUrl(reqOrigin);

    if (urlInfo.isPublicDomain && config.isActive) {
      try {
        const payOS = this.payosClientFactory({
          clientId,
          apiKey,
          checksumKey,
          timeout: 8000,
        });
        if (typeof payOS?.webhooks?.confirm === 'function') {
          await payOS.webhooks.confirm(urlInfo.webhookUrl);
        }
      } catch (confirmErr: any) {
        console.warn('[PayOS Webhook] Không thể xác nhận webhook tự động khi lưu:', confirmErr?.message);
      }
    }

    return {
      provider: config.provider,
      configured: true,
      active: config.isActive,
      clientIdMasked: maskSecret(clientId),
      needsReentry: false,
      configuredAt: config.configuredAt,
      updatedAt: config.updatedAt,
      ...urlInfo,
    };
  }

  async testPayosConnection(
    storeId: number,
    credsOverride?: { clientId?: string; apiKey?: string; checksumKey?: string },
    reqOrigin?: string
  ): Promise<{ success: boolean; message: string; code?: string; account?: any }> {
    let clientId = credsOverride?.clientId?.trim();
    let apiKey = credsOverride?.apiKey?.trim();
    let checksumKey = credsOverride?.checksumKey?.trim();

    if (!clientId || !apiKey || !checksumKey) {
      const config = await this.db.storePaymentConfig.findUnique({
        where: { storeId_provider: { storeId, provider: PaymentConfigProvider.PAYOS } },
      });

      if (!config) {
        return {
          success: false,
          code: 'NOT_CONFIGURED',
          message: 'Chưa có thông tin kết nối PayOS để kiểm tra. Vui lòng nhập đầy đủ thông tin.',
        };
      }

      try {
        clientId = clientId || SecretEncryptionService.decrypt(config.clientIdEncrypted);
        apiKey = apiKey || SecretEncryptionService.decrypt(config.apiKeyEncrypted);
        checksumKey = checksumKey || SecretEncryptionService.decrypt(config.checksumKeyEncrypted);
      } catch {
        return {
          success: false,
          code: 'DECRYPTION_FAILED',
          message: 'Không thể giải mã khóa bảo mật đã lưu. Vui lòng nhập lại thông tin mới.',
        };
      }
    }

    if (!clientId || !apiKey || !checksumKey) {
      return {
        success: false,
        code: 'INCOMPLETE_CREDENTIALS',
        message: 'Thông tin kết nối chưa đầy đủ. Vui lòng kiểm tra lại Client ID, API Key và Checksum Key.',
      };
    }

    let payOS: any;
    try {
      payOS = this.payosClientFactory({
        clientId,
        apiKey,
        checksumKey,
        timeout: 8000,
      });

      await payOS.paymentRequests.get(999999999);

      return {
        success: true,
        code: 'SUCCESS',
        message: 'Xác thực cổng thanh toán PayOS thành công! Hệ thống sẵn sàng tạo mã VietQR.',
      };
    } catch (err: any) {
      const status = err?.status || err?.statusCode;
      const code = String(err?.code || err?.error?.code || '');
      const desc = String(err?.desc || err?.error?.desc || '');
      const errName = err?.name || '';
      const errMsg = String(err?.message || '');

      // 404, code 20, or code 101 (Mã thanh toán không tồn tại) means PayOS authenticated credentials
      // and successfully queried for order 999999999
      const isNotFoundOrder =
        status === 404 ||
        code === '20' ||
        code === '101' ||
        errName === 'NotFoundError' ||
        errMsg.toLowerCase().includes('not found') ||
        errMsg.toLowerCase().includes('không tìm thấy') ||
        errMsg.toLowerCase().includes('không tồn tại') ||
        desc.toLowerCase().includes('không tồn tại') ||
        desc.toLowerCase().includes('không tìm thấy') ||
        errMsg.includes('DATA_NOT_FOUND');

      if (isNotFoundOrder) {
        let confirmedAccountInfo = '';
        let accountData: any = null;
        const urlInfo = resolvePayosWebhookUrl(reqOrigin);

        if (urlInfo.isPublicDomain && payOS && typeof payOS.webhooks?.confirm === 'function') {
          try {
            const confirmRes = await payOS.webhooks.confirm(urlInfo.webhookUrl);
            if (confirmRes) {
              accountData = confirmRes;
              const bankStr = [confirmRes.shortName || confirmRes.name, confirmRes.accountName, confirmRes.accountNumber]
                .filter(Boolean)
                .join(' - ');
              if (bankStr) {
                confirmedAccountInfo = ` (${bankStr})`;
              }
            }
          } catch (confirmErr: any) {
            console.warn('[PayOS Webhook] Không thể xác nhận webhook tự động:', confirmErr?.message);
          }
        }

        return {
          success: true,
          code: 'SUCCESS',
          message: `Xác thực kết nối PayOS thành công! Kênh thanh toán hợp lệ${confirmedAccountInfo}.`,
          account: accountData,
        };
      }

      // Authentication / authorization failure
      if (
        status === 401 ||
        status === 403 ||
        code === '401' ||
        code === '403' ||
        code === '214' ||
        errName === 'UnauthorizedError' ||
        errName === 'ForbiddenError' ||
        errMsg.toLowerCase().includes('unauthorized') ||
        errMsg.toLowerCase().includes('forbidden') ||
        errMsg.toLowerCase().includes('sai thông tin') ||
        errMsg.toLowerCase().includes('không tồn tại hoặc đã tạm dừng') ||
        desc.toLowerCase().includes('không tồn tại hoặc đã tạm dừng')
      ) {
        return {
          success: false,
          code: 'AUTH_FAILED',
          message:
            'Thông tin kết nối không chính xác hoặc kênh thanh toán PayOS chưa được kích hoạt. Vui lòng kiểm tra lại Client ID, API Key và Checksum Key trên PayOS Dashboard.',
        };
      }

      // Timeout or network error
      if (
        errName === 'ConnectionTimeoutError' ||
        errName === 'ConnectionError' ||
        code === 'ETIMEDOUT' ||
        code === 'ECONNREFUSED'
      ) {
        return {
          success: false,
          code: 'TIMEOUT',
          message: 'Không thể kết nối đến máy chủ PayOS. Vui lòng kiểm tra đường truyền mạng và thử lại.',
        };
      }

      return {
        success: false,
        code: 'CONNECTION_FAILED',
        message: `Chưa thể xác minh kết nối PayOS (${desc || errMsg || 'Lỗi không xác định'}). Vui lòng kiểm tra lại thông tin cấu hình.`,
      };
    }
  }

  async deactivatePayosConfig(storeId: number, actorUserId: number) {
    const existing = await this.db.storePaymentConfig.findUnique({
      where: { storeId_provider: { storeId, provider: PaymentConfigProvider.PAYOS } },
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
          provider: PaymentConfigProvider.PAYOS,
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

  async togglePayosConfig(storeId: number, actorUserId: number, active: boolean) {
    const existing = await this.db.storePaymentConfig.findUnique({
      where: { storeId_provider: { storeId, provider: PaymentConfigProvider.PAYOS } },
      select: { id: true, isActive: true },
    });

    if (!existing) {
      throw new NotFoundError('Chưa cấu hình thông tin PayOS');
    }

    const saved = await this.db.storePaymentConfig.update({
      where: { id: existing.id },
      data: { isActive: active },
    });

    return {
      provider: saved.provider,
      configured: true,
      active: saved.isActive,
      updatedAt: saved.updatedAt,
    };
  }
}

function maskSecret(value: string): string {
  if (value.length <= 6) {
    return `${value.slice(0, 1)}***${value.slice(-1)}`;
  }

  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}
