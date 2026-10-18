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
    const momoConfig = await this.getMomoConfig(storeId);
    const partnerCode = (momoConfig as any).partnerCode || 'MOMOVA0I20261015';
    const accessKey = (momoConfig as any).accessKey || 'sjqZwImFcjxZBhHF';
    const secretKey = (momoConfig as any).secretKey || 'OK6GwHc66ZBSdqyuR5RXKTx0xA718DKh';
    const businessName = (momoConfig as any).businessName || (momoConfig as any).merchantName || 'STOCKPILOT';

    let momoGatewayPayUrl = '';
    let momoGatewayQrUrl = '';

    // Gọi API Cổng thanh toán MoMo Gateway chính thức (Doanh nghiệp)
    try {
      const orderInfo = `Thanh toan don hang ${order.orderNumber}`;
      const redirectUrl = 'http://localhost:5173/pos';
      const ipnUrl = 'http://localhost:5000/api/v1/pos/momo/ipn';
      const rawSignature = `accessKey=${accessKey}&amount=${totalNumber}&extraData=&ipnUrl=${ipnUrl}&orderId=${momoOrderId}&orderInfo=${orderInfo}&partnerCode=${partnerCode}&redirectUrl=${redirectUrl}&requestId=${momoOrderId}&requestType=captureWallet`;
      const signature = crypto.createHmac('sha256', secretKey).update(rawSignature).digest('hex');

      const endpoint = (momoConfig as any).endpoint || 'https://payment.momo.vn/v2/gateway/api/create';
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

    // Mã QR Cổng MoMo Doanh Nghiệp & Điểm bán STOCKPILOT (COM-QRC ID: 4032108)
    const storeQrId = (momoConfig as any).storeQrId || '4032108';
    const merchantAccount = (momoConfig as any).merchantAccount || 'PMC2628818000000003';
    const merchantQrCode = (momoConfig as any).merchantQrCode || '00020101021126220007vn.momo0207403210838630010A000000727013300069710250119PMC26288180000000030208QRIBFTTA53037045802VN6304CB72';
    const qrImageUrl = (momoConfig as any).qrImageUrl || '/momo-merchant-qr.png';
    const vietQrUrl = `https://api.vietqr.io/image/971025-${merchantAccount}-compact2.png?amount=${totalNumber}&addInfo=${encodeURIComponent(momoOrderId)}&accountName=${encodeURIComponent(businessName)}`;
    const qrCodeUrl = momoGatewayQrUrl || qrImageUrl;
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
      const momoConfig = await this.getMomoConfig(storeId);
      const partnerCode = (momoConfig as any).partnerCode || 'MOMOVA0I20261015_TEST';
      const accessKey = (momoConfig as any).accessKey || 'zaJf1FrjfFLOkogx';
      const secretKey = (momoConfig as any).secretKey || 'KhziNCbaF2oaETNAvlnDc1REp7J6e1by';

      const rawSignature = `accessKey=${accessKey}&orderId=${momoOrderId}&partnerCode=${partnerCode}&requestId=${momoOrderId}`;
      const signature = crypto.createHmac('sha256', secretKey).update(rawSignature).digest('hex');

      const queryEndpoint = (momoConfig as any).queryEndpoint || 'https://payment.momo.vn/v2/gateway/api/query';
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
            userId: order.createdById || 1,
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
   * Lấy cấu hình Ví MoMo nhận tiền của cửa hàng
   */
  async getMomoConfig(storeId: number) {
    const configPath = path.resolve(process.cwd(), 'data', 'momo-wallet-configs.json');
    let configs: Record<string, any> = {};
    if (fs.existsSync(configPath)) {
      try {
        configs = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch (e) {
        configs = {};
      }
    }

    if (configs[String(storeId)]) {
      return {
        ...configs[String(storeId)],
        isConfigured: true,
      };
    }

    if (configs['default']) {
      return {
        ...configs['default'],
        isConfigured: true,
      };
    }

    // Mặc định thông tin MoMo Doanh Nghiệp chính thức của người dùng
    return {
      partnerCode: 'MOMOVA0I20261015',
      accessKey: 'sjqZwImFcjxZBhHF',
      secretKey: 'OK6GwHc66ZBSdqyuR5RXKTx0xA718DKh',
      publicKey: 'MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEA0bdyiSaX+Ab/seENKgN9NwIcPSYw6GlwRZjh3ZfqFuEKr7ecohIc8PkPPimJzjE8L2e2ihnNvfri1YVTS29v7se1BqWI/hfb8Mrlz5P8jl8vQUZtT/osQYY8EZluJy3vc5GbVvvCt4PN0nw3qbITri25uyMLqR4zcJHLidLs1TBcuDoJggxkG23d0wtBQJu4saAGcmY3YhWJ09UaMtdJB+fdZiYdzuDwTYoINmSC9oegeawU7Zc580W+2RDrgxdJDUrmommhjgoyg0LCCtp4xcz0mpSUmn0wIey79fDRqH5soaxVaF763IdSvmUrxBM4e9NpFvziOa58VDTf618aMlMGU06TLlrg09GPlVMxLV+xn1xZ4hBBvqEH5mz8I9y34zGA7Q89ksnwaSPJECc6GBo3Vc2ajOTYhDB9NaQktx7fQGDA9hkdF/qwP2vq3+HgGB5LZx40vSDunFGLDePj87tU18Y4YgQZXk9gRUpRaoQpSriTVLQGV1Fe3QKLG4DSKlBO79myk0TUcq3Iydcx1RKvzFJSHGEwEX6rm3/bBPtPHU4CVWpa0Z1QWKKwB0GHehwtmbf599QNMNg67MT2qOVF/iLbiGv3ZkTJ4F1/zJ9O94choP/0afmoGd3J+QTes4588Tiq71ifUoRe98ed9cIXtNiKhIOqOnOlTBSox2ECAwEAAQ==',
      endpoint: 'https://payment.momo.vn/v2/gateway/api/create',
      queryEndpoint: 'https://payment.momo.vn/v2/gateway/api/query',
      posEndpoint: 'https://payment.momo.vn/v2/gateway/api/pos',
      businessName: 'STOCKPILOT',
      merchantName: 'STOCKPILOT',
      isConfigured: true,
    };
  }

  /**
   * Lưu cấu hình Cổng MoMo Doanh Nghiệp cho cửa hàng
   */
  async saveMomoConfig(storeId: number, input: any) {
    const partnerCode = (input.partnerCode || '').trim() || 'MOMOVA0I20261015';
    const accessKey = (input.accessKey || '').trim() || 'sjqZwImFcjxZBhHF';
    const secretKey = (input.secretKey || '').trim() || 'OK6GwHc66ZBSdqyuR5RXKTx0xA718DKh';
    const businessName = (input.businessName || input.merchantName || 'STOCKPILOT').trim();

    const dataDir = path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const configPath = path.resolve(dataDir, 'momo-wallet-configs.json');
    let configs: Record<string, any> = {};
    if (fs.existsSync(configPath)) {
      try {
        configs = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch (e) {
        configs = {};
      }
    }

    const updatedConfig = {
      partnerCode,
      accessKey,
      secretKey,
      endpoint: input.endpoint || 'https://payment.momo.vn/v2/gateway/api/create',
      queryEndpoint: input.queryEndpoint || 'https://payment.momo.vn/v2/gateway/api/query',
      posEndpoint: input.posEndpoint || 'https://payment.momo.vn/v2/gateway/api/pos',
      publicKey: input.publicKey || configs['default']?.publicKey || '',
      businessName,
      merchantName: businessName,
      isConfigured: true,
    };

    configs[String(storeId)] = updatedConfig;
    configs['default'] = updatedConfig;

    fs.writeFileSync(configPath, JSON.stringify(configs, null, 2), 'utf8');

    return updatedConfig;
  }
}
