import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { PaymentMethod, PaymentProvider, PaymentStatus, Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../config/db';
import { NotFoundError, ValidationError } from '../../common/errors/app-error';
import { StockLedgerService } from '../inventory/stock-ledger.service';
import { BusinessSyncService } from '../../common/services/business-sync.service';

export interface CreateMomoLinkItem {
  stockItemId: number;
  quantity: number;
  price?: number;
  unitPrice?: number;
}

export interface CreateMomoLinkInput {
  warehouseId?: number;
  customerName?: string;
  customerPhone?: string;
  discountAmount?: number;
  taxAmount?: number;
  note?: string;
  totalAmount?: number;
  items: CreateMomoLinkItem[];
}

export class PosMomoService {
  constructor(private readonly db: PrismaClient = defaultPrisma) {}

  /**
   * Tạo yêu cầu thanh toán MoMo QR Code
   */
  async createPayment(storeId: number, userId: number, input: CreateMomoLinkInput) {
    // 1. Tìm kho hàng
    const warehouse = input.warehouseId
      ? await this.db.warehouse.findFirst({ where: { id: input.warehouseId, storeId, isActive: true } })
      : await this.db.warehouse.findFirst({ where: { storeId, isDefault: true, isActive: true } });

    if (!warehouse) {
      throw new NotFoundError('Không tìm thấy kho hàng hoạt động');
    }

    // 2. Chuẩn hóa sản phẩm và tính tiền
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

    // Kiểm tra tồn kho khả dụng
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
      const p = item.price !== undefined ? item.price : item.unitPrice;
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
    if (input.totalAmount !== undefined && Number(input.totalAmount) > 0) {
      totalAmount = new Prisma.Decimal(input.totalAmount).toDecimalPlaces(2);
    }
    const totalNumber = Math.round(Number(totalAmount));

    if (totalNumber <= 0) {
      throw new ValidationError('Số tiền thanh toán phải lớn hơn 0 để tạo mã MoMo');
    }

    // 3. Mã đơn hàng MoMo
    const momoOrderId = `MOMO_${Date.now()}_${Math.floor(Math.random() * 900 + 100)}`;
    const orderNumber = `POS-${momoOrderId}`;

    // 4. Chuẩn bị chi tiết Order items
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

    // 5. Tạo đơn hàng ở trạng thái PENDING
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
        note: input.note || `Thanh toán qua Ví MoMo #${momoOrderId}`,
        createdById: userId,
        items: {
          create: orderItemsData,
        },
        payments: {
          create: {
            storeId,
            provider: PaymentProvider.PAYOS, // Tận dụng enum DB sẵn có
            method: PaymentMethod.PAYOS,
            amount: totalAmount,
            currency: 'VND',
            status: PaymentStatus.PENDING,
            providerReference: momoOrderId,
            metadataJson: {
              wallet: 'MOMO',
              momoOrderId,
              source: 'POS_MOMO',
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

    // 6. Lấy cấu hình tài khoản MoMo Doanh Nghiệp của cửa hàng
    const momoRaw = this.getRawMomoConfig(storeId);
    if (!momoRaw || !momoRaw.partnerCode || !momoRaw.accessKey || !momoRaw.secretKey) {
      throw new ValidationError('Cửa hàng chưa cấu hình cổng thanh toán MoMo. Vui lòng vào Cài đặt để thiết lập Partner Code, Access Key và Secret Key.');
    }
    const partnerCode = momoRaw.partnerCode;
    const accessKey = momoRaw.accessKey;
    const secretKey = momoRaw.secretKey;
    const businessName = momoRaw.businessName || momoRaw.merchantName || 'STOCKPILOT';

    let momoGatewayPayUrl = '';
    let momoGatewayQrUrl = '';

    // Gọi API Cổng thanh toán MoMo Gateway chính thức (Doanh nghiệp)
    try {
      const orderInfo = `Thanh toan don hang ${order.orderNumber}`;
      const redirectUrl = 'http://localhost:5173/pos';
      const publicBase = process.env.PUBLIC_API_URL ? process.env.PUBLIC_API_URL.replace(/\/+$/, '') : 'http://localhost:5000';
      const ipnUrl = `${publicBase}/api/v1/pos/momo/ipn`;
      const rawSignature = `accessKey=${accessKey}&amount=${totalNumber}&extraData=&ipnUrl=${ipnUrl}&orderId=${momoOrderId}&orderInfo=${orderInfo}&partnerCode=${partnerCode}&redirectUrl=${redirectUrl}&requestId=${momoOrderId}&requestType=captureWallet`;
      const signature = crypto.createHmac('sha256', secretKey).update(rawSignature).digest('hex');

      const endpoint = momoRaw.endpoint || 'https://payment.momo.vn/v2/gateway/api/create';
      const momoRes = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          partnerCode,
          partnerName: businessName,
          storeId: 'StockPilotPOS',
          requestId: momoOrderId,
          amount: totalNumber,
          orderId: momoOrderId,
          orderInfo,
          redirectUrl,
          ipnUrl,
          lang: 'vi',
          extraData: '',
          requestType: 'captureWallet',
          signature,
        }),
      });

      if (momoRes.ok) {
        const momoData = (await momoRes.json()) as any;
        if (momoData.resultCode === 0 && (momoData.payUrl || momoData.qrCodeUrl)) {
          momoGatewayPayUrl = momoData.payUrl || '';
          momoGatewayQrUrl = momoData.qrCodeUrl || `https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=${encodeURIComponent(momoGatewayPayUrl)}`;
        }
      }
    } catch (apiErr) {
      console.warn('MoMo Gateway create API warning:', apiErr);
    }

    // Mã QR Cổng MoMo Doanh Nghiệp & Điểm bán
    const storeQrId = momoRaw.storeQrId || '';
    const merchantAccount = momoRaw.merchantAccount || '';
    const merchantQrCode = momoRaw.merchantQrCode || '';
    const qrImageUrl = momoRaw.qrImageUrl || '';
    const vietQrUrl = merchantAccount
      ? `https://api.vietqr.io/image/971025-${merchantAccount}-compact2.png?amount=${totalNumber}&addInfo=${encodeURIComponent(momoOrderId)}&accountName=${encodeURIComponent(businessName)}`
      : (momoGatewayQrUrl || `https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=${encodeURIComponent(`momo://?action=payWithApp&partnerCode=${partnerCode}&orderId=${momoOrderId}&amount=${totalNumber}`)}`);
    const qrCodeUrl = momoGatewayQrUrl || qrImageUrl || vietQrUrl;
    const payUrl = momoGatewayPayUrl || `momo://?action=payWithApp&partnerCode=${partnerCode}&orderId=${momoOrderId}&amount=${totalNumber}`;

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      momoOrderId,
      amount: totalNumber,
      description: `Thanh toan MoMo Doanh Nghiep #${momoOrderId}`,
      qrCodeUrl,
      momoGatewayQrUrl: momoGatewayQrUrl || qrCodeUrl,
      vietQrUrl,
      qrImageUrl,
      merchantQrCode,
      storeQrId,
      merchantAccount,
      payUrl,
      partnerCode,
      businessName,
      status: 'PENDING',
    };
  }

  /**
   * Kiểm tra trạng thái thanh toán MoMo
   */
  async checkPaymentStatus(storeId: number, momoOrderId: string) {
    const order = await this.db.order.findFirst({
      where: {
        storeId,
        orderNumber: { contains: momoOrderId },
      },
      include: {
        items: true,
        payments: true,
        store: true,
      },
    });

    if (!order) {
      throw new NotFoundError(`Không tìm thấy đơn hàng với mã MoMo ${momoOrderId}`);
    }

    // Nếu đơn hàng đã hoàn tất trước đó
    if (order.status === 'FULFILLED') {
      return {
        isPaid: true,
        status: 'PAID',
        orderNumber: order.orderNumber,
        orderId: order.id,
      };
    }

    const payment = order.payments.find((p) => p.providerReference === momoOrderId) || order.payments[0];

    if (payment && payment.status === PaymentStatus.PAID) {
      return {
        isPaid: true,
        status: 'PAID',
        orderNumber: order.orderNumber,
        orderId: order.id,
      };
    }

    // Tự động kiểm tra trực tiếp từ máy chủ Cổng thanh toán MoMo Gateway
    try {
      const momoRaw = this.getRawMomoConfig(storeId);
      if (momoRaw && momoRaw.partnerCode && momoRaw.accessKey && momoRaw.secretKey) {
        const partnerCode = momoRaw.partnerCode;
        const accessKey = momoRaw.accessKey;
        const secretKey = momoRaw.secretKey;

        const rawSignature = `accessKey=${accessKey}&orderId=${momoOrderId}&partnerCode=${partnerCode}&requestId=${momoOrderId}`;
        const signature = crypto.createHmac('sha256', secretKey).update(rawSignature).digest('hex');

        const queryEndpoint = momoRaw.queryEndpoint || 'https://payment.momo.vn/v2/gateway/api/query';
      const queryRes = await fetch(queryEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          partnerCode,
          requestId: momoOrderId,
          orderId: momoOrderId,
          lang: 'vi',
          signature,
        }),
      });

      if (queryRes.ok) {
        const queryData = (await queryRes.json()) as any;
        if (queryData.resultCode === 0) {
          // MoMo Gateway báo đã thanh toán thành công!
          await this.confirmPaymentSuccess(storeId, momoOrderId);
          return {
            isPaid: true,
            status: 'PAID',
            orderNumber: order.orderNumber,
            orderId: order.id,
            transId: queryData.transId,
          };
        }
      }
      }
    } catch (queryErr) {
      // Fallback
    }

    return {
      isPaid: false,
      status: 'PENDING',
    };
  }

  /**
   * Xác nhận thanh toán MoMo thành công (dùng cho Webhook IPN hoặc khi nhận được tín hiệu từ MoMo)
   */
  async confirmPaymentSuccess(storeId: number, momoOrderId: string) {
    const order = await this.db.order.findFirst({
      where: {
        storeId,
        orderNumber: { contains: momoOrderId },
      },
      include: {
        items: true,
        payments: true,
      },
    });

    if (!order) {
      throw new NotFoundError(`Không tìm thấy đơn hàng ${momoOrderId}`);
    }

    if (order.status === 'FULFILLED') {
      return {
        isPaid: true,
        status: 'PAID',
        orderNumber: order.orderNumber,
        orderId: order.id,
      };
    }

    const now = new Date();
    const payment = order.payments.find((p) => p.providerReference === momoOrderId) || order.payments[0];
    const warehouse = await this.db.warehouse.findFirst({ where: { storeId, isDefault: true, isActive: true } });

    await this.db.$transaction(async (tx) => {
      // 1. Cập nhật Payment sang PAID
      if (payment) {
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.PAID,
            paidAt: now,
          },
        });
      }

      // 2. Cập nhật Order CONFIRMED
      await tx.order.update({
        where: { id: order.id },
        data: { status: 'CONFIRMED', confirmedAt: now },
      });

      // 3. Trừ tồn kho thực tế
      if (warehouse) {
        await StockLedgerService.atomicDeduct(
          tx,
          {
            storeId,
            warehouseId: warehouse.id,
            userId: order.createdById ?? null,
            referenceType: 'POS_SALE',
            referenceId: order.orderNumber,
            note: `Thanh toán thành công qua Ví MoMo #${momoOrderId}`,
          },
          'ORDER_FULFILL',
          order.items.map((it) => ({ stockItemId: it.stockItemId, quantity: it.quantity }))
        );
      }

      // 4. Cập nhật Order FULFILLED
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

  /**
   * Đọc cấu hình MoMo thô (bao gồm secretKey) cho các xử lý nội bộ backend
   */
  getRawMomoConfig(storeId: number): any {
    const configPath = path.resolve(process.cwd(), 'data', 'momo-wallet-configs.json');
    if (!fs.existsSync(configPath)) {
      return null;
    }
    try {
      const configs = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const cfg = configs[String(storeId)];
      if (cfg && cfg.partnerCode && cfg.accessKey && cfg.secretKey) {
        return cfg;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Lấy cấu hình Ví MoMo của cửa hàng (Không bao giờ trả secretKey ra API)
   */
  async getMomoConfig(storeId: number) {
    const raw = this.getRawMomoConfig(storeId);
    if (!raw) {
      return {
        partnerCode: '',
        accessKey: '',
        businessName: '',
        endpoint: 'https://payment.momo.vn/v2/gateway/api/create',
        queryEndpoint: 'https://payment.momo.vn/v2/gateway/api/query',
        posEndpoint: 'https://payment.momo.vn/v2/gateway/api/pos',
        storeQrId: '',
        merchantAccount: '',
        qrImageUrl: '',
        isConfigured: false,
        hasSecretKey: false,
      };
    }

    return {
      partnerCode: raw.partnerCode,
      accessKey: raw.accessKey,
      businessName: raw.businessName || raw.merchantName || '',
      endpoint: raw.endpoint || 'https://payment.momo.vn/v2/gateway/api/create',
      queryEndpoint: raw.queryEndpoint || 'https://payment.momo.vn/v2/gateway/api/query',
      posEndpoint: raw.posEndpoint || 'https://payment.momo.vn/v2/gateway/api/pos',
      storeQrId: raw.storeQrId || '',
      merchantAccount: raw.merchantAccount || '',
      qrImageUrl: raw.qrImageUrl || '',
      isConfigured: true,
      hasSecretKey: true,
    };
  }

  /**
   * Lưu cấu hình Cổng MoMo Doanh Nghiệp cho cửa hàng.
   * Nếu ô secretKey để trống thì tự động giữ lại khóa bí mật cũ.
   */
  async saveMomoConfig(storeId: number, input: any) {
    const existing = this.getRawMomoConfig(storeId);

    const partnerCode = (input.partnerCode || '').trim() || existing?.partnerCode || '';
    const accessKey = (input.accessKey || '').trim() || existing?.accessKey || '';
    let secretKey = (input.secretKey || '').trim();

    // Khi lưu mà để trống ô secret thì giữ khóa cũ
    if (!secretKey && existing?.secretKey) {
      secretKey = existing.secretKey;
    }

    if (!partnerCode || !accessKey || !secretKey) {
      throw new ValidationError('Cửa hàng chưa cấu hình cổng MoMo. Vui lòng điền đầy đủ Partner Code, Access Key và Secret Key.');
    }

    const businessName = (input.businessName || input.merchantName || existing?.businessName || 'STOCKPILOT').trim();

    const dataDir = path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const configPath = path.resolve(dataDir, 'momo-wallet-configs.json');
    let configs: Record<string, any> = {};
    if (fs.existsSync(configPath)) {
      try {
        configs = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch {
        configs = {};
      }
    }

    const updatedConfig = {
      partnerCode,
      accessKey,
      secretKey,
      endpoint: input.endpoint || existing?.endpoint || 'https://payment.momo.vn/v2/gateway/api/create',
      queryEndpoint: input.queryEndpoint || existing?.queryEndpoint || 'https://payment.momo.vn/v2/gateway/api/query',
      posEndpoint: input.posEndpoint || existing?.posEndpoint || 'https://payment.momo.vn/v2/gateway/api/pos',
      publicKey: input.publicKey || existing?.publicKey || '',
      storeQrId: input.storeQrId || existing?.storeQrId || '',
      merchantAccount: input.merchantAccount || existing?.merchantAccount || '',
      merchantQrCode: input.merchantQrCode || existing?.merchantQrCode || '',
      qrImageUrl: input.qrImageUrl || existing?.qrImageUrl || '',
      businessName,
      merchantName: businessName,
      isConfigured: true,
    };

    configs[String(storeId)] = updatedConfig;
    fs.writeFileSync(configPath, JSON.stringify(configs, null, 2), 'utf8');

    // Trả kết quả an toàn ra API không chứa secretKey
    return {
      partnerCode,
      accessKey,
      businessName,
      endpoint: updatedConfig.endpoint,
      queryEndpoint: updatedConfig.queryEndpoint,
      posEndpoint: updatedConfig.posEndpoint,
      isConfigured: true,
      hasSecretKey: true,
    };
  }
}
