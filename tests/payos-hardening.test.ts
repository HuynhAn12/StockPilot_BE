import crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { PrismaClient, Role, PaymentProvider, PaymentMethod, PaymentStatus } from '@prisma/client';
import { PosPayosService } from '../src/modules/pos/pos-payos.service';
import { SecretEncryptionService } from '../src/common/services/secret-encryption.service';
import { StockLedgerService } from '../src/modules/inventory/stock-ledger.service';
import { BusinessSyncService } from '../src/common/services/business-sync.service';
import { ValidationError, NotFoundError } from '../src/common/errors/app-error';

const rawDbUrl = process.env.TEST_DATABASE_URL;

function isSafeTestDatabase(url?: string): boolean {
  if (!url) return false;
  try {
    const sanitized = url.replace(/^mysql:\/\//, 'http://');
    const parsed = new URL(sanitized);
    const dbName = parsed.pathname.replace(/^\//, '').toLowerCase();

    if (
      dbName.includes('production') ||
      dbName.includes('prod') ||
      dbName.includes('_dev') ||
      dbName.includes('dev_')
    ) {
      return false;
    }

    return (
      dbName.includes('_test') ||
      dbName.includes('test_') ||
      dbName.includes('_ci') ||
      dbName.includes('ci_')
    );
  } catch {
    return false;
  }
}

const isLiveDb = Boolean(rawDbUrl && isSafeTestDatabase(rawDbUrl));

(isLiveDb ? describe : describe.skip)('PayOS Multi-Tenant Integration Hardening Tests', () => {
  let prisma: PrismaClient;
  let service: PosPayosService;
  const createdStoreIds: number[] = [];

  const TEST_CLIENT_ID = 'test-client-id-xyz';
  const TEST_API_KEY = 'test-api-key-xyz';
  const TEST_CHECKSUM_KEY = 'test-checksum-key-1234567890123456';

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: rawDbUrl });
    await prisma.$connect();
    service = new PosPayosService(prisma);
  });

  afterAll(async () => {
    for (const storeId of createdStoreIds.reverse()) {
      await prisma.store.delete({ where: { id: storeId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  async function createStoreWithPayosFixture(prefix: string) {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const store = await prisma.store.create({
      data: {
        name: `${prefix} Store ${suffix}`,
        code: `${prefix.toLowerCase()}-${suffix}`.replace(/_/g, '-'),
      },
    });
    createdStoreIds.push(store.id);

    const user = await prisma.user.create({
      data: {
        storeId: store.id,
        email: `${prefix.toLowerCase()}-${suffix}@example.test`,
        passwordHash: 'test-hash',
        fullName: `${prefix} User`,
        role: Role.SHOP_OWNER,
      },
    });

    const warehouse = await prisma.warehouse.create({
      data: {
        storeId: store.id,
        name: `${prefix} Warehouse`,
        isDefault: true,
      },
    });

    const product = await prisma.product.create({
      data: {
        storeId: store.id,
        name: `${prefix} Product`,
        code: `PRD_${suffix}`,
      },
    });

    const stockItem = await prisma.stockItem.create({
      data: {
        storeId: store.id,
        productId: product.id,
        sku: `SKU_${suffix}`,
        name: `${prefix} SKU`,
        costPrice: 30000,
        sellingPrice: 50000,
      },
    });

    await prisma.inventoryBalance.create({
      data: {
        storeId: store.id,
        warehouseId: warehouse.id,
        stockItemId: stockItem.id,
        quantity: 100,
      },
    });

    // Configure PayOS credentials for the store
    await prisma.storePaymentConfig.create({
      data: {
        storeId: store.id,
        provider: 'PAYOS',
        clientIdEncrypted: SecretEncryptionService.encrypt(TEST_CLIENT_ID),
        apiKeyEncrypted: SecretEncryptionService.encrypt(TEST_API_KEY),
        checksumKeyEncrypted: SecretEncryptionService.encrypt(TEST_CHECKSUM_KEY),
        isActive: true,
      },
    });

    return { store, user, warehouse, product, stockItem };
  }

  describe('1. Cross-Tenant OrderCode Uniqueness and Database Lookup', () => {
    it('enforces database-level uniqueness on provider and providerReference across all stores', async () => {
      const fixture1 = await createStoreWithPayosFixture('StoreA');
      const fixture2 = await createStoreWithPayosFixture('StoreB');

      const sharedOrderCode = '99998888777711';

      const order1 = await prisma.order.create({
        data: {
          storeId: fixture1.store.id,
          orderNumber: `ORDER-1-${Date.now()}`,
          status: 'DRAFT',
          subtotalAmount: 50000,
          totalAmount: 50000,
        },
      });

      const order2 = await prisma.order.create({
        data: {
          storeId: fixture2.store.id,
          orderNumber: `ORDER-2-${Date.now()}`,
          status: 'DRAFT',
          subtotalAmount: 50000,
          totalAmount: 50000,
        },
      });

      // Insert payment for Store 1 with sharedOrderCode
      await prisma.payment.create({
        data: {
          storeId: fixture1.store.id,
          orderId: order1.id,
          provider: PaymentProvider.PAYOS,
          method: PaymentMethod.PAYOS,
          amount: 50000,
          currency: 'VND',
          status: PaymentStatus.PENDING,
          providerReference: sharedOrderCode,
        },
      });

      // Attempt to insert payment for Store 2 with SAME providerReference
      // Must fail with unique constraint violation (P2002) at DB level!
      await expect(
        prisma.payment.create({
          data: {
            storeId: fixture2.store.id,
            orderId: order2.id,
            provider: PaymentProvider.PAYOS,
            method: PaymentMethod.PAYOS,
            amount: 50000,
            currency: 'VND',
            status: PaymentStatus.PENDING,
            providerReference: sharedOrderCode,
          },
        })
      ).rejects.toThrow();
    });

    it('generates partitioned unique orderCodes that check database for existing collisions', async () => {
      const fixture = await createStoreWithPayosFixture('GenCode');
      const code = await service.generateUniqueOrderCode(fixture.store.id);

      expect(typeof code).toBe('number');
      expect(code).toBeGreaterThan(0);
      expect(code).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);

      // Verify length is safe (14 digits)
      const codeStr = String(code);
      expect(codeStr.length).toBeGreaterThanOrEqual(13);
      expect(codeStr.length).toBeLessThanOrEqual(15);
    });
  });

  describe('2. Authoritative Backend Pricing Calculation', () => {
    it('calculates order total strictly from DB sellingPrice, ignoring client price & totalAmount overrides', async () => {
      const fixture = await createStoreWithPayosFixture('Pricing');

      // Mock PayOS client creation to avoid external HTTP call
      const mockPayosClient = {
        paymentRequests: {
          create: jest.fn<any>().mockResolvedValue({
            bin: '970407',
            accountNumber: '12345678',
            accountName: 'TEST MERCHANT',
            qrCode: '000201010212...',
            checkoutUrl: 'https://pay.payos.vn/web/test',
          }),
        },
      };

      const customService = new PosPayosService(prisma, () => mockPayosClient);

      // Malicious client tries to buy 2 units of 50,000 VND item for 1,000 VND total
      const result = await customService.createPaymentLink(fixture.store.id, fixture.user.id, {
        items: [
          {
            stockItemId: fixture.stockItem.id,
            quantity: 2,
            ...({ price: 100, unitPrice: 100 } as any), // Client attempts to override unit price
          },
        ],
        ...({ totalAmount: 1000 } as any), // Client attempts to override totalAmount
      });

      // Expected subtotal: 2 * 50,000 = 100,000 VND
      expect(result.amount).toBe(100000);

      // Check DB order values
      const dbOrder = await prisma.order.findUnique({
        where: { id: result.orderId },
        include: { items: true, payments: true },
      });

      expect(Number(dbOrder?.subtotalAmount)).toBe(100000);
      expect(Number(dbOrder?.totalAmount)).toBe(100000);
      expect(Number(dbOrder?.items[0].unitPriceSnapshot)).toBe(50000);
      expect(Number(dbOrder?.payments[0].amount)).toBe(100000);
    });

    it('rejects negative discount and excessive discount with ValidationError', async () => {
      const fixture = await createStoreWithPayosFixture('Discount');

      // Negative discount
      await expect(
        service.createPaymentLink(fixture.store.id, fixture.user.id, {
          discountAmount: -10000,
          items: [{ stockItemId: fixture.stockItem.id, quantity: 1 }],
        })
      ).rejects.toThrow(ValidationError);

      // Excessive discount (> subtotal)
      await expect(
        service.createPaymentLink(fixture.store.id, fixture.user.id, {
          discountAmount: 100000, // item is 50,000
          items: [{ stockItemId: fixture.stockItem.id, quantity: 1 }],
        })
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('3. PayOS Signature Verification', () => {
    it('verifies valid HMAC-SHA256 signature and rejects tampered payloads', () => {
      const payloadData = {
        orderCode: 123456789,
        amount: 100000,
        description: 'POS 123456789',
        accountNumber: '11223344',
        reference: 'REF1234',
        transactionDateTime: '2026-10-21 12:00:00',
        currency: 'VND',
        paymentLinkId: 'link-abc-123',
        code: '00',
        desc: 'success',
        counterAccountBankId: null, // Test null normalization
        counterAccountName: null,
      };

      // Generate signature using method under test
      const sortedKeys = Object.keys(payloadData).sort();
      const signData = sortedKeys
        .map((k) => `${k}=${(payloadData as any)[k] === null ? '' : (payloadData as any)[k]}`)
        .join('&');
      const validSig = crypto.createHmac('sha256', TEST_CHECKSUM_KEY).update(signData).digest('hex');

      // 1. Valid signature passes
      expect(service.verifyPayosSignature(payloadData, validSig, TEST_CHECKSUM_KEY)).toBe(true);

      // 2. Corrupted signature fails
      expect(service.verifyPayosSignature(payloadData, 'invalid' + validSig.slice(7), TEST_CHECKSUM_KEY)).toBe(false);

      // 3. Tampered payload amount fails
      const tamperedData = { ...payloadData, amount: 50000 };
      expect(service.verifyPayosSignature(tamperedData, validSig, TEST_CHECKSUM_KEY)).toBe(false);

      // 4. Wrong checksumKey fails
      expect(service.verifyPayosSignature(payloadData, validSig, 'wrong-key-abcdef1234567890')).toBe(false);
    });
  });

  describe('4. Webhook and Polling Settlement & Concurrency Protection', () => {
    it('rejects webhook when amount does not match order amount', async () => {
      const fixture = await createStoreWithPayosFixture('AmountMismatch');
      const orderCode = await service.generateUniqueOrderCode(fixture.store.id);

      // Create order & pending payment of 50,000 VND
      await prisma.order.create({
        data: {
          storeId: fixture.store.id,
          orderNumber: `POS-PAYOS-${orderCode}`,
          status: 'DRAFT',
          subtotalAmount: 50000,
          totalAmount: 50000,
          payments: {
            create: {
              storeId: fixture.store.id,
              provider: PaymentProvider.PAYOS,
              method: PaymentMethod.PAYOS,
              amount: 50000,
              currency: 'VND',
              status: PaymentStatus.PENDING,
              providerReference: String(orderCode),
            },
          },
        },
      });

      // Webhook payload claiming payment of only 30,000 VND
      const webhookData = {
        orderCode,
        amount: 30000, // Mismatched!
        code: '00',
        desc: 'success',
      };

      const signData = `amount=30000&code=00&desc=success&orderCode=${orderCode}`;
      const signature = crypto.createHmac('sha256', TEST_CHECKSUM_KEY).update(signData).digest('hex');

      await expect(
        service.handleWebhook({
          data: webhookData,
          signature,
        })
      ).rejects.toThrow('Số tiền thanh toán không khớp với đơn hàng');
    });

    it('prevents double deduction and duplicate side effects under concurrent webhook & polling', async () => {
      const fixture = await createStoreWithPayosFixture('Concurrency');
      const orderCode = await service.generateUniqueOrderCode(fixture.store.id);

      const order = await prisma.order.create({
        data: {
          storeId: fixture.store.id,
          orderNumber: `POS-PAYOS-${orderCode}`,
          status: 'DRAFT',
          subtotalAmount: 50000,
          totalAmount: 50000,
          items: {
            create: {
              storeId: fixture.store.id,
              stockItemId: fixture.stockItem.id,
              skuSnapshot: fixture.stockItem.sku,
              nameSnapshot: fixture.stockItem.name,
              unitPriceSnapshot: 50000,
              costPriceSnapshot: 30000,
              quantity: 2,
              refundableAmount: 50000,
              refundedAmount: 0,
              returnedQuantity: 0,
              subtotal: 50000,
            },
          },
          payments: {
            create: {
              storeId: fixture.store.id,
              provider: PaymentProvider.PAYOS,
              method: PaymentMethod.PAYOS,
              amount: 50000,
              currency: 'VND',
              status: PaymentStatus.PENDING,
              providerReference: String(orderCode),
            },
          },
        },
      });

      // Initial stock quantity is 100
      const initialBalance = await prisma.inventoryBalance.findUnique({
        where: {
          warehouseId_stockItemId: {
            warehouseId: fixture.warehouse.id,
            stockItemId: fixture.stockItem.id,
          },
        },
      });
      expect(initialBalance?.quantity).toBe(100);

      // Spy on StockLedgerService.atomicDeduct & BusinessSyncService.syncAfterSale
      const atomicDeductSpy = jest.spyOn(StockLedgerService, 'atomicDeduct');
      const syncAfterSaleSpy = jest.spyOn(BusinessSyncService.prototype, 'syncAfterSale').mockResolvedValue(undefined as any);

      // Prepare webhook payload
      const webhookData = {
        orderCode,
        amount: 50000,
        code: '00',
        desc: 'success',
      };
      const signData = `amount=50000&code=00&desc=success&orderCode=${orderCode}`;
      const signature = crypto.createHmac('sha256', TEST_CHECKSUM_KEY).update(signData).digest('hex');

      // Mock PayOS polling client returning PAID
      const mockPayosClient = {
        paymentRequests: {
          get: jest.fn<any>().mockResolvedValue({
            orderCode,
            amount: 50000,
            status: 'PAID',
          }),
        },
      };
      const concurrentService = new PosPayosService(prisma, () => mockPayosClient);

      // Fire BOTH webhook AND polling simultaneously
      const [webhookRes, pollingRes] = await Promise.all([
        concurrentService.handleWebhook({ data: webhookData, signature }),
        concurrentService.checkPaymentStatus(fixture.store.id, orderCode),
      ]);

      expect(webhookRes.success).toBe(true);
      expect(pollingRes.isPaid).toBe(true);

      // Verify stock deducted EXACTLY ONCE (100 - 2 = 98)
      const finalBalance = await prisma.inventoryBalance.findUnique({
        where: {
          warehouseId_stockItemId: {
            warehouseId: fixture.warehouse.id,
            stockItemId: fixture.stockItem.id,
          },
        },
      });
      expect(finalBalance?.quantity).toBe(98);

      // atomicDeduct was called exactly once for this order
      const deductCallsForOrder = atomicDeductSpy.mock.calls.filter(
        (call: any) => (call[1] as any).idempotencyKey === `POS_PAYOS_DEDUCT_${order.id}`
      );
      expect(deductCallsForOrder.length).toBe(1);

      // syncAfterSale was called exactly once
      expect(syncAfterSaleSpy).toHaveBeenCalledTimes(1);

      atomicDeductSpy.mockRestore();
      syncAfterSaleSpy.mockRestore();
    });

    it('ensures duplicate webhook calls are idempotent and do not trigger extra deductions', async () => {
      const fixture = await createStoreWithPayosFixture('DuplicateWebhook');
      const orderCode = await service.generateUniqueOrderCode(fixture.store.id);

      await prisma.order.create({
        data: {
          storeId: fixture.store.id,
          orderNumber: `POS-PAYOS-${orderCode}`,
          status: 'DRAFT',
          subtotalAmount: 50000,
          totalAmount: 50000,
          items: {
            create: {
              storeId: fixture.store.id,
              stockItemId: fixture.stockItem.id,
              skuSnapshot: fixture.stockItem.sku,
              nameSnapshot: fixture.stockItem.name,
              unitPriceSnapshot: 50000,
              costPriceSnapshot: 30000,
              quantity: 1,
              refundableAmount: 50000,
              refundedAmount: 0,
              returnedQuantity: 0,
              subtotal: 50000,
            },
          },
          payments: {
            create: {
              storeId: fixture.store.id,
              provider: PaymentProvider.PAYOS,
              method: PaymentMethod.PAYOS,
              amount: 50000,
              currency: 'VND',
              status: PaymentStatus.PENDING,
              providerReference: String(orderCode),
            },
          },
        },
      });

      const webhookPayload = {
        data: {
          orderCode,
          amount: 50000,
          code: '00',
          desc: 'success',
        },
        signature: '',
      };
      const signData = `amount=50000&code=00&desc=success&orderCode=${orderCode}`;
      webhookPayload.signature = crypto.createHmac('sha256', TEST_CHECKSUM_KEY).update(signData).digest('hex');

      // First webhook: transitions to PAID & FULFILLED
      const res1 = await service.handleWebhook(webhookPayload);
      expect(res1.success).toBe(true);

      // Second duplicate webhook: returns already fulfilled without error
      const res2 = await service.handleWebhook(webhookPayload);
      expect(res2.success).toBe(true);
      expect(res2.message).toBe('Already fulfilled');

      // Third duplicate webhook
      const res3 = await service.handleWebhook(webhookPayload);
      expect(res3.success).toBe(true);
      expect(res3.message).toBe('Already fulfilled');

      // Stock should only be deducted by 1 (100 - 1 = 99)
      const balance = await prisma.inventoryBalance.findUnique({
        where: {
          warehouseId_stockItemId: {
            warehouseId: fixture.warehouse.id,
            stockItemId: fixture.stockItem.id,
          },
        },
      });
      expect(balance?.quantity).toBe(99);
    });
  });

  describe('5. Error Handling and Orphaned Draft Cleanup', () => {
    it('deletes draft order and pending payment if PayOS explicitly rejects with 4xx', async () => {
      const fixture = await createStoreWithPayosFixture('PayosReject');

      // Mock PayOS client that throws 400 BadRequestError
      const rejectionError: any = new Error('PayOS BadRequest: Invalid description');
      rejectionError.status = 400;

      const mockRejectingPayosClient = {
        paymentRequests: {
          create: jest.fn<any>().mockRejectedValue(rejectionError),
        },
      };

      const failingService = new PosPayosService(prisma, () => mockRejectingPayosClient);

      const ordersBefore = await prisma.order.count({ where: { storeId: fixture.store.id } });

      await expect(
        failingService.createPaymentLink(fixture.store.id, fixture.user.id, {
          items: [{ stockItemId: fixture.stockItem.id, quantity: 1 }],
        })
      ).rejects.toThrow(ValidationError);

      // Verify draft order and pending payment were cleanly deleted
      const ordersAfter = await prisma.order.count({ where: { storeId: fixture.store.id } });
      expect(ordersAfter).toBe(ordersBefore);

      const payments = await prisma.payment.findMany({ where: { storeId: fixture.store.id } });
      expect(payments.length).toBe(0);
    });

    it('does NOT delete payment on uncertain timeout, preserving order for reconciliation', async () => {
      const fixture = await createStoreWithPayosFixture('PayosTimeout');

      // Mock PayOS client that times out and reconciliation get() also fails
      const timeoutError: any = new Error('ConnectionTimeoutError: ETIMEDOUT');
      timeoutError.name = 'ConnectionTimeoutError';

      const mockTimeoutPayosClient = {
        paymentRequests: {
          create: jest.fn<any>().mockRejectedValue(timeoutError),
          get: jest.fn<any>().mockRejectedValue(new Error('Still unreachable')),
        },
      };

      const timeoutService = new PosPayosService(prisma, () => mockTimeoutPayosClient);

      await expect(
        timeoutService.createPaymentLink(fixture.store.id, fixture.user.id, {
          items: [{ stockItemId: fixture.stockItem.id, quantity: 1 }],
        })
      ).rejects.toThrow(ValidationError);

      // Payment and order MUST BE PRESERVED so webhook reverse lookup will find it if customer pays!
      const pendingPayment = await prisma.payment.findFirst({
        where: { storeId: fixture.store.id, status: PaymentStatus.PENDING },
      });
      expect(pendingPayment).not.toBeNull();
      expect((pendingPayment?.metadataJson as any)?.reconciliationRequired).toBe(true);
    });

    it('recovers gracefully if link was created on PayOS despite an initial network drop', async () => {
      const fixture = await createStoreWithPayosFixture('PayosReconcile');

      const mockReconcilingPayosClient = {
        paymentRequests: {
          create: jest.fn<any>().mockRejectedValue(new Error('Network drop (ECONNRESET)')),
          get: jest.fn<any>().mockImplementation((code: any) =>
            Promise.resolve({
              orderCode: code,
              bin: '970407',
              accountNumber: '99887766',
              accountName: 'RECONCILED STORE',
              qrCode: '000201010212...',
              checkoutUrl: 'https://pay.payos.vn/web/reconciled',
            })
          ),
        },
      };

      const reconcileService = new PosPayosService(prisma, () => mockReconcilingPayosClient);

      const res = await reconcileService.createPaymentLink(fixture.store.id, fixture.user.id, {
        items: [{ stockItemId: fixture.stockItem.id, quantity: 1 }],
      });

      expect(res.accountNumber).toBe('99887766');
      expect(res.status).toBe('PENDING');
    });

    it('cancels pending payment and order when webhook reports failure code (code !== 00)', async () => {
      const fixture = await createStoreWithPayosFixture('PayosCancelWebhook');
      const orderCode = await service.generateUniqueOrderCode(fixture.store.id);

      const order = await prisma.order.create({
        data: {
          storeId: fixture.store.id,
          orderNumber: `POS-PAYOS-${orderCode}`,
          status: 'DRAFT',
          subtotalAmount: 50000,
          totalAmount: 50000,
          payments: {
            create: {
              storeId: fixture.store.id,
              provider: PaymentProvider.PAYOS,
              method: PaymentMethod.PAYOS,
              amount: 50000,
              currency: 'VND',
              status: PaymentStatus.PENDING,
              providerReference: String(orderCode),
            },
          },
        },
      });

      const failedWebhookData = {
        orderCode,
        amount: 50000,
        code: '01', // User cancelled or transaction failed!
        desc: 'Buyer cancelled transaction',
      };
      const signData = `amount=50000&code=01&desc=Buyer cancelled transaction&orderCode=${orderCode}`;
      const signature = crypto.createHmac('sha256', TEST_CHECKSUM_KEY).update(signData).digest('hex');

      const webhookRes = await service.handleWebhook({
        data: failedWebhookData,
        signature,
      });

      expect(webhookRes.success).toBe(true);

      // Verify payment and order are updated to CANCELED
      const updatedPayment = await prisma.payment.findFirst({ where: { orderId: order.id } });
      const updatedOrder = await prisma.order.findUnique({ where: { id: order.id } });
      expect(updatedPayment?.status).toBe(PaymentStatus.CANCELED);
      expect(updatedOrder?.status).toBe('CANCELED');
    });

    it('enforces tenant authorization: Store B cannot poll or view Store A payment status', async () => {
      const storeA = await createStoreWithPayosFixture('TenantA');
      const storeB = await createStoreWithPayosFixture('TenantB');

      const orderCode = await service.generateUniqueOrderCode(storeA.store.id);

      await prisma.order.create({
        data: {
          storeId: storeA.store.id,
          orderNumber: `POS-PAYOS-${orderCode}`,
          status: 'DRAFT',
          subtotalAmount: 50000,
          totalAmount: 50000,
          payments: {
            create: {
              storeId: storeA.store.id,
              provider: PaymentProvider.PAYOS,
              method: PaymentMethod.PAYOS,
              amount: 50000,
              currency: 'VND',
              status: PaymentStatus.PENDING,
              providerReference: String(orderCode),
            },
          },
        },
      });

      // Store B attempts to check payment status of Store A's orderCode
      await expect(
        service.checkPaymentStatus(storeB.store.id, orderCode)
      ).rejects.toThrow(NotFoundError);
    });
  });
});
