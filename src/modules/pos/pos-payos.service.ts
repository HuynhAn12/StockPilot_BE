import crypto from 'crypto';
import { PaymentMethod, PaymentProvider, PaymentStatus, Prisma, PrismaClient } from '@prisma/client';
import { PayOS } from '@payos/node';
import { prisma as defaultPrisma } from '../../config/db';
import { NotFoundError, ValidationError } from '../../common/errors/app-error';
import { SecretEncryptionService } from '../../common/services/secret-encryption.service';
import { PAYOS_CONFIG_UNREADABLE_MESSAGE } from '../store-payment-config/store-payment-config.service';
import { StockLedgerService } from '../inventory/stock-ledger.service';
import { BusinessSyncService } from '../../common/services/business-sync.service';

export interface CreatePayosLinkItem {
  stockItemId: number;
  quantity: number;
}

export interface CreatePayosLinkInput {
  warehouseId?: number;
  customerName?: string;
  customerPhone?: string;
  discountAmount?: number;
  taxAmount?: number;
  note?: string;
  items: CreatePayosLinkItem[];
}

export class PosPayosService {
  constructor(
    private readonly db: PrismaClient = defaultPrisma,
    private readonly payosClientFactory: (options: any) => any = (opts) => new PayOS(opts)
  ) {}

  /**
   * Lấy cấu hình PayOS đã được giải mã của store
   */
  async getStorePayosCredentials(storeId: number) {
    const config = await this.db.storePaymentConfig.findUnique({
      where: { storeId_provider: { storeId, provider: 'PAYOS' } },
    });

    if (!config || !config.isActive) {
      return null;
    }

    try {
      const clientId = SecretEncryptionService.decrypt(config.clientIdEncrypted);
      const apiKey = SecretEncryptionService.decrypt(config.apiKeyEncrypted);
      const checksumKey = SecretEncryptionService.decrypt(config.checksumKeyEncrypted);

      return { clientId, apiKey, checksumKey };
    } catch (err) {
      // Configured but unreadable (encryption key changed): say so instead of "not configured".
      console.error(`[PayOS] Không thể giải mã credentials cho storeId ${storeId}:`, err);
      throw new ValidationError(PAYOS_CONFIG_UNREADABLE_MESSAGE);
    }
  }

  /**
   * Sinh orderCode độc nhất có phân vùng store và kiểm tra trùng lặp trong Database
   * PayOS yêu cầu orderCode là số nguyên dương <= 9007199254740991 (Number.MAX_SAFE_INTEGER)
   * Định dạng 15 chữ số: "1" + 4 số mã store partition + 7 số timestamp (ms) + 3 số ngẫu nhiên
   * (fallback: "2" + 9 số timestamp + 5 số ngẫu nhiên)
   */
  async generateUniqueOrderCode(storeId: number): Promise<number> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const storePart = String(Math.abs(storeId) % 10000).padStart(4, '0');
      const timePart = Date.now().toString().slice(-7);
      const randPart = Math.floor(Math.random() * 900 + 100).toString();
      // Leading "1" keeps the zero-padded store partition when converted to a number, so codes
      // are always 15 digits (max 199999999999999 < Number.MAX_SAFE_INTEGER).
      const candidateCode = Number(`1${storePart}${timePart}${randPart}`);

      // Kiểm tra xung đột trên toàn hệ thống bằng provider_providerReference
      const existing = await this.db.payment.findUnique({
        where: {
          provider_providerReference: {
            provider: PaymentProvider.PAYOS,
            providerReference: String(candidateCode),
          },
        } as any,
        select: { id: true },
      });

      if (!existing) {
        return candidateCode;
      }
    }

    // Fallback an toàn nếu vòng lặp thử lại vượt ngưỡng
    const fallbackTime = Date.now().toString().slice(-9);
    const fallbackRand = Math.floor(Math.random() * 90000 + 10000).toString();
    // Leading "2" keeps 15 digits and can never collide with the "1"-prefixed partitioned codes.
    return Number(`2${fallbackTime}${fallbackRand}`);
  }

  /**
   * Kiểm tra chữ ký số Webhook PayOS (HMAC-SHA256) chuẩn PayOS
   * Chuẩn hóa: Sắp xếp keys theo alphabet, null/undefined chuyển thành rỗng ("")
   */
  verifyPayosSignature(data: Record<string, any>, signature: string, checksumKey: string): boolean {
    try {
      if (!data || !signature || !checksumKey) {
        return false;
      }

      const sortedKeys = Object.keys(data).sort();
      const signData = sortedKeys
        .filter((key) => data[key] !== undefined)
        .map((key) => {
          let val = data[key];
          if (Array.isArray(val)) {
            val = JSON.stringify(val);
          } else if (typeof val === 'object' && val !== null) {
            val = JSON.stringify(val);
          }
          if (val === null || val === undefined || val === 'undefined' || val === 'null') {
            val = '';
          }
          return `${key}=${val}`;
        })
        .join('&');

      const computedSig = crypto.createHmac('sha256', checksumKey).update(signData).digest('hex');
      if (computedSig.length !== signature.length) {
        return false;
      }
      return crypto.timingSafeEqual(Buffer.from(computedSig, 'utf8'), Buffer.from(signature, 'utf8'));
    } catch {
      return false;
    }
  }

  /**
   * Tạo link thanh toán PayOS VietQR cho đơn hàng POS
   * Giá bán và tổng tiền được tính toán ĐỘC QUYỀN trên backend từ Database
   */
  async createPaymentLink(storeId: number, userId: number, input: CreatePayosLinkInput) {
    // 1. Kiểm tra cấu hình PayOS của cửa hàng
    const creds = await this.getStorePayosCredentials(storeId);
    if (!creds) {
      throw new ValidationError(
        'Cửa hàng chưa kích hoạt cấu hình cổng PayOS. Vui lòng vào Cài đặt để nhập Client ID, API Key và Checksum Key.'
      );
    }

    // 2. Tìm kho hàng hoạt động
    const warehouse = input.warehouseId
      ? await this.db.warehouse.findFirst({ where: { id: input.warehouseId, storeId, isActive: true } })
      : await this.db.warehouse.findFirst({ where: { storeId, isDefault: true, isActive: true } });

    if (!warehouse) {
      throw new NotFoundError('Không tìm thấy kho hàng hoạt động');
    }

    // 3. Chuẩn hóa sản phẩm
    const aggregatedItems = StockLedgerService.normalizeItems(input.items);
    if (aggregatedItems.length === 0) {
      throw new ValidationError('Danh sách sản phẩm không được để trống');
    }

    const itemIds = aggregatedItems.map((item) => item.stockItemId);
    const stockItems = await this.db.stockItem.findMany({
      where: {
        storeId,
        id: { in: itemIds },
        isActive: true,
      },
    });

    if (stockItems.length !== itemIds.length) {
      throw new NotFoundError('Một hoặc nhiều sản phẩm không tồn tại hoặc đã ngừng hoạt động');
    }

    // 4. Kiểm tra sơ bộ tồn kho khả dụng
    for (const item of aggregatedItems) {
      const balance = await this.db.inventoryBalance.findUnique({
        where: {
          warehouseId_stockItemId: {
            warehouseId: warehouse.id,
            stockItemId: item.stockItemId,
          },
        },
      });
      const currentQty = balance ? balance.quantity : 0;
      if (currentQty < item.quantity) {
        const si = stockItems.find((s) => s.id === item.stockItemId);
        throw new ValidationError(
          `Sản phẩm ${si?.name || si?.sku} tồn kho không đủ (Hiện có: ${currentQty}, Yêu cầu: ${item.quantity})`
        );
      }
    }

    // 5. Tính toán giá cả có thẩm quyền (Authoritative Backend Pricing)
    // TUYỆT ĐỐI KHÔNG dùng giá hoặc tổng tiền từ client
    const itemMap = new Map(stockItems.map((si) => [si.id, si]));
    let subtotalAmount = new Prisma.Decimal(0);
    const rawLines = aggregatedItems.map((item) => {
      const stockItem = itemMap.get(item.stockItemId)!;
      const unitPrice = new Prisma.Decimal(stockItem.sellingPrice);
      const costPrice = new Prisma.Decimal(stockItem.costPrice);
      const subtotal = unitPrice.mul(item.quantity).toDecimalPlaces(2);
      subtotalAmount = subtotalAmount.plus(subtotal);
      return { item, stockItem, unitPrice, costPrice, subtotal };
    });

    const discountAmount = new Prisma.Decimal(input.discountAmount || 0).toDecimalPlaces(2);
    if (discountAmount.isNegative()) {
      throw new ValidationError('Tiền giảm giá không được âm');
    }
    if (discountAmount.gt(subtotalAmount)) {
      throw new ValidationError('Tiền giảm giá không được vượt quá tổng tiền hàng');
    }

    const taxAmount = new Prisma.Decimal(input.taxAmount || 0).toDecimalPlaces(2);
    if (taxAmount.isNegative()) {
      throw new ValidationError('Tiền thuế không được âm');
    }

    const totalAmount = subtotalAmount.minus(discountAmount).plus(taxAmount).toDecimalPlaces(2);
    const totalNumber = Math.round(Number(totalAmount));

    if (totalNumber <= 0) {
      throw new ValidationError('Số tiền thanh toán phải lớn hơn 0 để tạo mã QR PayOS');
    }

    // 6. Sinh orderCode duy nhất cho PayOS
    const orderCode = await this.generateUniqueOrderCode(storeId);
    const orderNumber = `POS-PAYOS-${orderCode}`;

    // 7. Chuẩn bị order items snapshot
    const orderItemsData: Prisma.OrderItemUncheckedCreateWithoutOrderInput[] = [];
    let allocatedRefundableSum = new Prisma.Decimal(0);

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      const isLastLine = i === rawLines.length - 1;
      let refundableAmount: Prisma.Decimal;

      if (isLastLine) {
        refundableAmount = totalAmount.minus(allocatedRefundableSum).toDecimalPlaces(2);
      } else {
        const lineDiscount = discountAmount.mul(line.subtotal).div(subtotalAmount).toDecimalPlaces(2);
        const lineTax = taxAmount.mul(line.subtotal).div(subtotalAmount).toDecimalPlaces(2);
        refundableAmount = line.subtotal.minus(lineDiscount).plus(lineTax).toDecimalPlaces(2);
        allocatedRefundableSum = allocatedRefundableSum.plus(refundableAmount);
      }

      orderItemsData.push({
        storeId,
        stockItemId: line.stockItem.id,
        skuSnapshot: line.stockItem.sku,
        nameSnapshot: line.stockItem.name,
        unitPriceSnapshot: line.unitPrice,
        costPriceSnapshot: line.costPrice,
        quantity: line.item.quantity,
        refundableAmount,
        refundedAmount: new Prisma.Decimal(0),
        returnedQuantity: 0,
        subtotal: line.subtotal,
      });
    }

    // 8. Tạo đơn hàng ở trạng thái DRAFT kèm Payment PENDING
    const order = await this.db.order.create({
      data: {
        storeId,
        orderNumber,
        status: 'DRAFT',
        customerName: input.customerName || 'Khách lẻ',
        customerPhone: input.customerPhone,
        subtotalAmount,
        discountAmount,
        taxAmount,
        totalAmount,
        note: input.note || `Thanh toán VietQR PayOS #${orderCode}`,
        createdById: userId,
        items: {
          create: orderItemsData,
        },
        payments: {
          create: {
            storeId,
            provider: PaymentProvider.PAYOS,
            method: PaymentMethod.PAYOS,
            amount: totalAmount,
            currency: 'VND',
            status: PaymentStatus.PENDING,
            providerReference: String(orderCode),
            metadataJson: {
              orderCode,
              source: 'POS_PAYOS',
              warehouseId: warehouse.id,
            },
          },
        },
      },
      include: {
        items: true,
        payments: true,
      },
    });

    // 9. Gọi PayOS tạo Payment Link bằng SDK chính thức (timeout 10s)
    const description = `POS ${orderCode}`.slice(0, 25);
    const cancelUrl = 'https://stockpilot.vn/pos/cancel';
    const returnUrl = 'https://stockpilot.vn/pos/success';

    let payosData: any;
    let createError: any = null;
    const payOS = this.payosClientFactory({
      clientId: creds.clientId,
      apiKey: creds.apiKey,
      checksumKey: creds.checksumKey,
      timeout: 10000,
    });

    try {
      payosData = await payOS.paymentRequests.create({
        orderCode,
        amount: totalNumber,
        description,
        cancelUrl,
        returnUrl,
        items: rawLines.map((line) => ({
          name: line.stockItem.name,
          quantity: line.item.quantity,
          price: Math.round(Number(line.unitPrice)),
        })),
      });
    } catch (err: any) {
      createError = err;
    }

    if (createError) {
      // Kiểm tra xem lỗi có phải do timeout hoặc gián đoạn mạng không
      const isNetworkOrTimeout =
        createError.name === 'ConnectionTimeoutError' ||
        createError.name === 'ConnectionError' ||
        createError.message?.toLowerCase().includes('timeout') ||
        createError.message?.toLowerCase().includes('network') ||
        createError.code === 'ETIMEDOUT' ||
        createError.code === 'ECONNRESET' ||
        (createError.status && createError.status >= 500);

      if (isNetworkOrTimeout) {
        // Thử đối soát ngay lập tức với PayOS để kiểm tra xem link đã được tạo chưa
        let reconciledData: any = null;
        try {
          reconciledData = await payOS.paymentRequests.get(orderCode);
        } catch {
          // Bỏ qua lỗi đối soát tức thời
        }

        if (reconciledData && Number(reconciledData.orderCode) === orderCode) {
          const recQrImageUrl = reconciledData.qrCode
            ? `https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=${encodeURIComponent(reconciledData.qrCode)}`
            : '';
          return {
            orderId: order.id,
            orderNumber: order.orderNumber,
            orderCode,
            amount: totalNumber,
            description,
            bin: reconciledData.bin,
            accountNumber: reconciledData.accountNumber,
            accountName: reconciledData.accountName,
            qrCode: reconciledData.qrCode,
            qrImageUrl: recQrImageUrl,
            checkoutUrl: reconciledData.checkoutUrl,
            status: 'PENDING',
          };
        }

        // Khi kết quả từ PayOS là không chắc chắn: KHÔNG XÓA đơn hàng/payment để tránh mất dấu giao dịch nếu khách hàng quét mã hoặc Webhook đến sau!
        await this.db.payment.updateMany({
          where: { orderId: order.id, provider: PaymentProvider.PAYOS },
          data: {
            metadataJson: {
              reconciliationRequired: true,
              lastError: createError.message || 'Payment link timeout/uncertain outcome',
              recordedAt: new Date().toISOString(),
            },
          },
        }).catch(() => {});

        console.error(`[PayOS] Hết thời gian chờ tạo link order ${order.orderNumber}. Giữ trạng thái PENDING để đối soát an toàn.`);
        throw new ValidationError(
          `Kết nối đến PayOS bị gián đoạn hoặc hết thời gian chờ: ${createError.message || 'ETIMEDOUT'}. Đơn hàng được giữ lại để đối soát tự động.`
        );
      }

      // Nếu PayOS từ chối dứt khoát (HTTP 4xx: tham số sai, chữ ký sai, etc.): Xóa an toàn draft order
      await this.db.payment.deleteMany({ where: { orderId: order.id } }).catch(() => {});
      await this.db.orderItem.deleteMany({ where: { orderId: order.id } }).catch(() => {});
      await this.db.order.delete({ where: { id: order.id } }).catch(() => {});

      console.error(`[PayOS] Tạo Payment Link bị từ chối rõ ràng cho order ${order.orderNumber}:`, createError?.message);
      throw new ValidationError(`PayOS từ chối yêu cầu: ${createError?.message || 'Không thể tạo link thanh toán'}`);
    }

    const qrImageUrl = payosData.qrCode
      ? `https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=${encodeURIComponent(payosData.qrCode)}`
      : (payosData.bin && payosData.accountNumber
          ? `https://img.vietqr.io/image/${payosData.bin}-${payosData.accountNumber}-compact2.png?amount=${totalNumber}&addInfo=${encodeURIComponent(description)}&accountName=${encodeURIComponent(payosData.accountName)}`
          : '');

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      orderCode,
      amount: totalNumber,
      description,
      bin: payosData.bin,
      accountNumber: payosData.accountNumber,
      accountName: payosData.accountName,
      qrCode: payosData.qrCode,
      qrImageUrl,
      checkoutUrl: payosData.checkoutUrl,
      status: 'PENDING',
    };
  }

  /**
   * Kiểm tra trạng thái thanh toán từ PayOS (gọi từ Short-Polling của POS)
   * Ngăn chặn cross-tenant polling và xử lý concurrency an toàn
   */
  async checkPaymentStatus(storeId: number, orderCode: number) {
    const creds = await this.getStorePayosCredentials(storeId);
    if (!creds) {
      throw new ValidationError('Cửa hàng chưa kích hoạt cấu hình cổng PayOS');
    }

    // 1. Tìm bản ghi Payment bằng unique index provider_providerReference
    const payment = (await this.db.payment.findUnique({
      where: {
        provider_providerReference: {
          provider: PaymentProvider.PAYOS,
          providerReference: String(orderCode),
        },
      } as any,
      include: {
        order: {
          include: {
            items: true,
          },
        },
      },
    })) as any;

    // Xác thực quyền sở hữu của tenant: ngăn cửa hàng A kiểm tra giao dịch của cửa hàng B
    if (!payment || payment.storeId !== storeId || !payment.order) {
      throw new NotFoundError(`Không tìm thấy đơn hàng với mã giao dịch PayOS ${orderCode}`);
    }

    const order = payment.order;

    // Nếu đơn hàng đã hoàn tất trước đó rồi (Idempotency)
    if (order.status === 'FULFILLED' && payment.status === PaymentStatus.PAID) {
      return {
        isPaid: true,
        status: 'PAID',
        orderNumber: order.orderNumber,
        orderId: order.id,
      };
    }

    // 2. Gọi API PayOS kiểm tra trạng thái thực tế
    let payosRes: any;
    try {
      const payOS = this.payosClientFactory({
        clientId: creds.clientId,
        apiKey: creds.apiKey,
        checksumKey: creds.checksumKey,
        timeout: 10000,
      });

      payosRes = await payOS.paymentRequests.get(orderCode);
    } catch (err: any) {
      console.error(`[PayOS Polling] Lỗi kiểm tra trạng thái orderCode ${orderCode}:`, err?.message);
      return { isPaid: false, status: payment.status, error: err?.message };
    }

    const payosStatus = payosRes?.status;
    const payosAmount = payosRes?.amount;

    // Xử lý đơn hàng bị CANCELLED hoặc EXPIRED phía PayOS
    if (payosStatus === 'CANCELLED' || payosStatus === 'EXPIRED') {
      await this.db.$transaction([
        this.db.payment.updateMany({
          where: { id: payment.id, status: PaymentStatus.PENDING },
          data: { status: PaymentStatus.CANCELED },
        }),
        this.db.order.updateMany({
          where: { id: order.id, status: 'DRAFT' },
          data: { status: 'CANCELED' },
        }),
      ]);
      return { isPaid: false, status: payosStatus };
    }

    // 3. Nếu PayOS báo đã thanh toán thành công (PAID)
    if (payosStatus === 'PAID') {
      // Đối soát số tiền thanh toán nghiêm ngặt
      if (payosAmount !== undefined && Number(payosAmount) !== Math.round(Number(payment.amount))) {
        throw new ValidationError(
          `Số tiền thanh toán PayOS (${payosAmount}) không khớp với đơn hàng (${payment.amount})`
        );
      }

      const now = new Date();
      const warehouse = await this.db.warehouse.findFirst({ where: { storeId, isDefault: true, isActive: true } });

      if (!warehouse) {
        throw new NotFoundError('Không tìm thấy kho hàng mặc định đang hoạt động để xuất kho');
      }

      let isTransitioned = false;

      try {
        await this.db.$transaction(async (tx) => {
          // Atomic update có điều kiện: chỉ update khi status đang là PENDING
          const updateResult = await tx.payment.updateMany({
            where: {
              id: payment.id,
              status: PaymentStatus.PENDING,
            },
            data: {
              status: PaymentStatus.PAID,
              paidAt: now,
              metadataJson: payosRes || undefined,
            },
          });

          if (updateResult.count === 0) {
            // Đã có luồng khác (Webhook hoặc Polling song song) gạch nợ thành công
            return;
          }

          isTransitioned = true;

          // Cập nhật Order CONFIRMED
          await tx.order.update({
            where: { id: order.id },
            data: { status: 'CONFIRMED', confirmedAt: now },
          });

          // Trừ tồn kho thực tế với Idempotency Key duy nhất
          await StockLedgerService.atomicDeduct(
            tx,
            {
              storeId,
              warehouseId: warehouse.id,
              userId: order.createdById || 1,
              referenceType: 'POS_SALE',
              referenceId: order.orderNumber,
              idempotencyKey: `POS_PAYOS_DEDUCT_${order.id}`,
              note: `Thanh toán tự động qua PayOS #${orderCode}`,
            },
            'ORDER_FULFILL',
            order.items.map((it: any) => ({ stockItemId: it.stockItemId, quantity: it.quantity }))
          );

          // Cập nhật Order FULFILLED
          await tx.order.update({
            where: { id: order.id },
            data: { status: 'FULFILLED', fulfilledAt: now },
          });
        });
      } catch (transErr: any) {
        console.warn(`[PayOS Polling] Xung đột xử lý đơn ${order.orderNumber}:`, transErr?.message);
      }

      // Kích hoạt đồng bộ rủi ro & doanh thu CHỈ KHI luồng này thực sự chuyển trạng thái
      if (isTransitioned) {
        BusinessSyncService.getInstance(this.db)
          .syncAfterSale(storeId, order.items.map((it: any) => it.stockItemId))
          .catch((err) => console.error('[PayOS Polling] syncAfterSale error:', err));
      }

      return {
        isPaid: true,
        status: 'PAID',
        orderNumber: order.orderNumber,
        orderId: order.id,
        paidAt: now,
      };
    }

    return {
      isPaid: false,
      status: payosStatus || 'PENDING',
    };
  }

  /**
   * Xử lý Webhook gửi từ PayOS (Multi-Tenant Webhook Receiver)
   * Thực hiện:
   * 1. Tra cứu ngược đơn hàng bằng unique constraint (provider, providerReference)
   * 2. Lấy secret của đúng store đó để xác thực chữ ký
   * 3. Đối soát số tiền, trạng thái giao dịch
   * 4. Gạch nợ & trừ kho nguyên tử an toàn concurrency
   */
  async handleWebhook(payload: any) {
    if (
      payload &&
      (payload.webhookUrl ||
        payload.test === true ||
        payload.data?.orderCode === 123 ||
        payload.data?.description === 'VQRIO123')
    ) {
      return { success: true, message: 'Webhook URL verified' };
    }

    if (!payload || !payload.data || !payload.signature) {
      throw new ValidationError('Payload Webhook không hợp lệ');
    }

    const { orderCode, amount, code } = payload.data;
    const signature = payload.signature;

    if (!orderCode) {
      throw new ValidationError('Thiếu orderCode trong dữ liệu Webhook');
    }

    // 1. Reverse lookup: tìm Payment bằng unique index provider_providerReference
    const payment = (await this.db.payment.findUnique({
      where: {
        provider_providerReference: {
          provider: PaymentProvider.PAYOS,
          providerReference: String(orderCode),
        },
      } as any,
      include: {
        order: {
          include: {
            items: true,
          },
        },
      },
    })) as any;

    if (!payment || !payment.order) {
      console.warn(`[PayOS Webhook] Không tìm thấy Payment với orderCode ${orderCode}`);
      return { success: false, message: 'Payment not found' };
    }

    const storeId = payment.storeId;
    const order = payment.order;

    // 2. Lấy cấu hình Checksum Key của đúng Store đó
    const creds = await this.getStorePayosCredentials(storeId);
    if (!creds) {
      console.error(`[PayOS Webhook] Store ${storeId} chưa cấu hình hoặc đã tắt PayOS`);
      throw new ValidationError('Cửa hàng chưa kích hoạt cấu hình cổng PayOS');
    }

    // 3. Xác thực chữ ký số bằng Checksum Key của Cửa hàng
    const isValidSignature = this.verifyPayosSignature(payload.data, signature, creds.checksumKey);
    if (!isValidSignature) {
      console.error(`[PayOS Webhook] Chữ ký không hợp lệ cho Store ${storeId}, orderCode: ${orderCode}`);
      throw new ValidationError('Chữ ký số Webhook không hợp lệ');
    }

    // 4. Nếu code !== '00', giao dịch thanh toán không thành công hoặc khách hàng hủy thanh toán
    if (code !== '00') {
      if (payment.status === PaymentStatus.PENDING) {
        await this.db.$transaction([
          this.db.payment.updateMany({
            where: { id: payment.id, status: PaymentStatus.PENDING },
            data: { status: PaymentStatus.CANCELED },
          }),
          this.db.order.updateMany({
            where: { id: order.id, status: 'DRAFT' },
            data: { status: 'CANCELED' },
          }),
        ]);
      }
      return { success: true, message: 'Payment not successful code' };
    }

    // 4b. Nếu đơn hàng đã bị hủy trước đó mà lại nhận được Webhook báo thành công
    if (payment.status === PaymentStatus.CANCELED || order.status === 'CANCELED') {
      console.warn(`[PayOS Webhook] Nhận được thanh toán cho đơn hàng đã bị hủy: ${order.orderNumber}`);
      return { success: true, message: 'Payment received for canceled order' };
    }

    // 5. Đối soát số tiền giao dịch
    const expectedAmount = Math.round(Number(payment.amount));
    if (amount !== undefined && Number(amount) !== expectedAmount) {
      console.error(`[PayOS Webhook] Lệch số tiền: PayOS báo ${amount}, đơn hàng yêu cầu ${expectedAmount}`);
      throw new ValidationError('Số tiền thanh toán không khớp với đơn hàng');
    }

    // 6. Nếu đơn hàng đã hoàn tất, trả về thành công ngay lập tức (Idempotent)
    if (payment.status === PaymentStatus.PAID && order.status === 'FULFILLED') {
      return { success: true, message: 'Already fulfilled' };
    }

    // 7. Atomic transaction cập nhật trạng thái & trừ kho an toàn concurrency
    const now = new Date();
    const warehouse = await this.db.warehouse.findFirst({ where: { storeId, isDefault: true, isActive: true } });

    if (!warehouse) {
      throw new NotFoundError('Không tìm thấy kho hàng mặc định để xuất kho');
    }

    let isTransitioned = false;

    try {
      await this.db.$transaction(async (tx) => {
        const updateResult = await tx.payment.updateMany({
          where: {
            id: payment.id,
            status: PaymentStatus.PENDING,
          },
          data: {
            status: PaymentStatus.PAID,
            paidAt: now,
            metadataJson: payload.data,
          },
        });

        if (updateResult.count === 0) {
          // Luồng khác đã gạch nợ trước, thoát êm ái
          return;
        }

        isTransitioned = true;

        await tx.order.update({
          where: { id: order.id },
          data: { status: 'CONFIRMED', confirmedAt: now },
        });

        await StockLedgerService.atomicDeduct(
          tx,
          {
            storeId,
            warehouseId: warehouse.id,
            userId: order.createdById || 1,
            referenceType: 'POS_SALE',
            referenceId: order.orderNumber,
            idempotencyKey: `POS_PAYOS_DEDUCT_${order.id}`,
            note: `Thanh toán VietQR PayOS Webhook #${orderCode}`,
          },
          'ORDER_FULFILL',
          order.items.map((it: any) => ({ stockItemId: it.stockItemId, quantity: it.quantity }))
        );

        await tx.order.update({
          where: { id: order.id },
          data: { status: 'FULFILLED', fulfilledAt: now },
        });
      });
    } catch (transErr: any) {
      console.warn(`[PayOS Webhook] Trùng thanh toán hoặc xung đột đơn ${order.orderNumber}:`, transErr?.message);
    }

    // Kích hoạt đồng bộ rủi ro & doanh thu CHỈ KHI luồng này thực sự chuyển đổi trạng thái
    if (isTransitioned) {
      BusinessSyncService.getInstance(this.db)
        .syncAfterSale(storeId, order.items.map((it: any) => it.stockItemId))
        .catch((err) => console.error('[PayOS Webhook] syncAfterSale error:', err));
    }

    return { success: true, orderNumber: order.orderNumber };
  }
}
