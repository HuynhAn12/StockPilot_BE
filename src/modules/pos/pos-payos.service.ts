import crypto from 'crypto';
import { PaymentMethod, PaymentProvider, PaymentStatus, Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { NotFoundError, ValidationError } from '../../common/errors/app-error';
import { SecretEncryptionService } from '../../common/services/secret-encryption.service';
import { StockLedgerService } from '../inventory/stock-ledger.service';
import { BusinessSyncService } from '../../common/services/business-sync.service';
import { AuditLogService } from '../../common/services/audit-log.service';

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
  constructor(private readonly db: PrismaClient = defaultPrisma) {}

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
      console.error('Failed to decrypt PayOS credentials:', err);
      return null;
    }
  }

  /**
   * Tạo link thanh toán PayOS VietQR cho đơn hàng POS
   */
  async createPaymentLink(storeId: number, userId: number, input: CreatePayosLinkInput) {
    // 1. Kiểm tra cấu hình PayOS của cửa hàng
    const creds = await this.getStorePayosCredentials(storeId);
    if (!creds) {
      throw new ValidationError(
        'Cửa hàng chưa kích hoạt cấu hình cổng PayOS. Vui lòng vào Cài đặt để nhập Client ID, API Key và Checksum Key.'
      );
    }

    // 2. Tìm kho hàng
    const warehouse = input.warehouseId
      ? await this.db.warehouse.findFirst({ where: { id: input.warehouseId, storeId, isActive: true } })
      : await this.db.warehouse.findFirst({ where: { storeId, isDefault: true, isActive: true } });

    if (!warehouse) {
      throw new NotFoundError('Không tìm thấy kho hàng hoạt động');
    }

    // 3. Chuẩn hóa sản phẩm và tính tiền
    const aggregatedItems = StockLedgerService.normalizeItems(input.items);
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

    // Kiểm tra sơ bộ tồn kho khả dụng
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

    const customPriceMap = new Map<number, number>();
    for (const item of input.items) {
      const p = (item as any).price !== undefined ? (item as any).price : (item as any).unitPrice;
      if (p !== undefined && p !== null && !isNaN(Number(p)) && Number(p) >= 0) {
        customPriceMap.set(item.stockItemId, Number(p));
      }
    }

    const itemMap = new Map(stockItems.map((si) => [si.id, si]));
    let subtotalAmount = new Prisma.Decimal(0);
    const rawLines = aggregatedItems.map((item) => {
      const stockItem = itemMap.get(item.stockItemId)!;
      const customPrice = customPriceMap.get(item.stockItemId);
      const unitPrice = customPrice !== undefined
        ? new Prisma.Decimal(customPrice)
        : new Prisma.Decimal(stockItem.sellingPrice);
      const costPrice = new Prisma.Decimal(stockItem.costPrice);
      const subtotal = unitPrice.mul(item.quantity).toDecimalPlaces(2);
      subtotalAmount = subtotalAmount.plus(subtotal);
      return { item, stockItem, unitPrice, costPrice, subtotal };
    });

    const discountAmount = new Prisma.Decimal(input.discountAmount || 0).toDecimalPlaces(2);
    const taxAmount = new Prisma.Decimal(input.taxAmount || 0).toDecimalPlaces(2);
    let totalAmount = subtotalAmount.minus(discountAmount).plus(taxAmount).toDecimalPlaces(2);
    if ((input as any).totalAmount !== undefined && Number((input as any).totalAmount) > 0) {
      totalAmount = new Prisma.Decimal((input as any).totalAmount).toDecimalPlaces(2);
    }
    const totalNumber = Math.round(Number(totalAmount));

    if (totalNumber <= 0) {
      throw new ValidationError('Số tiền thanh toán phải lớn hơn 0 để tạo mã QR PayOS');
    }

    // 4. Sinh orderCode cho PayOS (số nguyên duy nhất, ví dụ: 6-8 chữ số)
    const orderCode = Number(`${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 90 + 10)}`);
    const orderNumber = `POS-PAYOS-${orderCode}`;

    // 5. Chuẩn bị order items snapshot
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

    // 6. Tạo đơn hàng ở trạng thái PENDING_PAYMENT
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

    // 7. Gọi API PayOS để tạo payment link
    const description = `POS ${orderCode}`.slice(0, 25);
    const cancelUrl = 'https://stockpilot.vn/pos/cancel';
    const returnUrl = 'https://stockpilot.vn/pos/success';

    // Tạo chữ ký HMAC-SHA256
    // Chuỗi ký: amount=${amount}&cancelUrl=${cancelUrl}&description=${description}&orderCode=${orderCode}&returnUrl=${returnUrl}
    const signatureData = `amount=${totalNumber}&cancelUrl=${cancelUrl}&description=${description}&orderCode=${orderCode}&returnUrl=${returnUrl}`;
    const signature = crypto.createHmac('sha256', creds.checksumKey).update(signatureData).digest('hex');

    const payosPayload = {
      orderCode,
      amount: totalNumber,
      description,
      cancelUrl,
      returnUrl,
      signature,
    };

    let payosResData: any;
    try {
      const response = await fetch('https://api-merchant.payos.vn/v2/payment-requests', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-client-id': creds.clientId,
          'x-api-key': creds.apiKey,
        },
        body: JSON.stringify(payosPayload),
      });

      payosResData = await response.json();
    } catch (err: any) {
      console.error('Call PayOS API error:', err);
      throw new ValidationError(`Lỗi kết nối PayOS: ${err?.message || 'Không thể gửi yêu cầu'}`);
    }

    if (payosResData?.code !== '00') {
      console.error('PayOS error response:', payosResData);
      throw new ValidationError(`PayOS từ chối yêu cầu: ${payosResData?.desc || 'Mã lỗi ' + payosResData?.code}`);
    }

    const payosData = payosResData.data;

    // Tạo link ảnh VietQR trực tiếp để đảm bảo hiển thị đẹp trên mọi trình duyệt
    const qrImageUrl = `https://api.vietqr.io/image/${payosData.bin}-${payosData.accountNumber}-compact2.png?amount=${totalNumber}&addInfo=${encodeURIComponent(description)}&accountName=${encodeURIComponent(payosData.accountName)}`;

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
   * Kiểm tra trạng thái thanh toán từ PayOS
   */
  async checkPaymentStatus(storeId: number, orderCode: number) {
    const creds = await this.getStorePayosCredentials(storeId);
    if (!creds) {
      throw new ValidationError('Cửa hàng chưa kích hoạt cấu hình cổng PayOS');
    }

    // 1. Tìm đơn hàng tương ứng trong DB
    const order = await this.db.order.findFirst({
      where: {
        storeId,
        orderNumber: { contains: String(orderCode) },
      },
      include: {
        items: true,
        payments: true,
        store: true,
      },
    });

    if (!order) {
      throw new NotFoundError(`Không tìm thấy đơn hàng với mã giao dịch PayOS ${orderCode}`);
    }

    // Nếu đơn hàng đã hoàn tất trước đó rồi
    if (order.status === 'FULFILLED') {
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
      const response = await fetch(`https://api-merchant.payos.vn/v2/payment-requests/${orderCode}`, {
        method: 'GET',
        headers: {
          'x-client-id': creds.clientId,
          'x-api-key': creds.apiKey,
        },
      });
      payosRes = await response.json();
    } catch (err: any) {
      console.error('Call PayOS check status error:', err);
      return { isPaid: false, status: 'PENDING', error: err?.message };
    }

    const payosStatus = payosRes?.data?.status;

    // 3. Nếu PayOS báo đã thanh toán thành công (PAID)
    if (payosStatus === 'PAID') {
      const now = new Date();
      const payment = order.payments[0];
      const warehouse = await this.db.warehouse.findFirst({ where: { storeId, isDefault: true, isActive: true } });

      await this.db.$transaction(async (tx) => {
        // Cập nhật Payment sang PAID
        if (payment) {
          await tx.payment.update({
            where: { id: payment.id },
            data: {
              status: PaymentStatus.PAID,
              paidAt: now,
            },
          });
        }

        // Cập nhật Order CONFIRMED
        await tx.order.update({
          where: { id: order.id },
          data: { status: 'CONFIRMED', confirmedAt: now },
        });

        // Trừ tồn kho thực tế
        if (warehouse) {
          await StockLedgerService.atomicDeduct(
            tx,
            {
              storeId,
              warehouseId: warehouse.id,
              userId: order.createdById || 1,
              referenceType: 'POS_SALE',
              referenceId: order.orderNumber,
              note: `Thanh toán tự động qua PayOS #${orderCode}`,
            },
            'ORDER_FULFILL',
            order.items.map((it) => ({ stockItemId: it.stockItemId, quantity: it.quantity }))
          );
        }

        // Cập nhật Order FULFILLED
        await tx.order.update({
          where: { id: order.id },
          data: { status: 'FULFILLED', fulfilledAt: now },
        });
      });

      // Kích hoạt đồng bộ rủi ro & doanh thu
      BusinessSyncService.getInstance(this.db)
        .syncAfterSale(storeId, order.items.map((it) => it.stockItemId))
        .catch(() => {});

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
}
