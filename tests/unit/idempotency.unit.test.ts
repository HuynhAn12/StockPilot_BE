import { idempotency } from '../../src/common/middleware/idempotency';

function createMockResponse() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader: jest.fn(function (this: any, key: string, value: string) {
      this.headers[key] = value;
    }),
    status: jest.fn(function (this: any, statusCode: number) {
      this.statusCode = statusCode;
      return this;
    }),
    json: jest.fn(function (this: any) {
      return this;
    }),
    send: jest.fn(function (this: any) {
      return this;
    }),
  };
}

describe('idempotency middleware', () => {
  it('rejects P2002 recovery when concurrent record has a different requestHash', async () => {
    const prisma = {
      idempotencyRequest: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({
            id: 'idem-1',
            requestHash: 'different-hash',
            status: 'COMPLETED',
            statusCode: 200,
            responseJson: { success: true },
          }),
        create: jest.fn().mockRejectedValue({ code: 'P2002' }),
      },
    };
    const req = {
      method: 'POST',
      baseUrl: '/api/v1/orders',
      path: '/100/confirm',
      params: { id: '100' },
      query: {},
      body: {},
      headers: { 'idempotency-key': 'same-key' },
      user: { storeId: 1 },
      app: { get: jest.fn().mockReturnValue(prisma) },
    } as any;
    const res = createMockResponse() as any;
    const next = jest.fn();

    await idempotency({ operation: 'ORDER_CONFIRM' })(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 409,
        message: expect.stringContaining('IDEMPOTENCY_KEY_REUSED'),
      })
    );
    expect(res.json).not.toHaveBeenCalled();
  });

  it('replays P2002 completed response only when requestHash matches', async () => {
    const matchingRecord = {
      id: 'idem-1',
      requestHash: '',
      status: 'COMPLETED',
      statusCode: 201,
      responseJson: { success: true, data: { id: 123 } },
    };
    const prisma = {
      idempotencyRequest: {
        findUnique: jest.fn().mockResolvedValueOnce(null).mockImplementation(async () => matchingRecord),
        create: jest.fn().mockRejectedValue({ code: 'P2002' }),
      },
    };
    const req = {
      method: 'POST',
      baseUrl: '/api/v1/orders',
      path: '/',
      params: {},
      query: {},
      body: { items: [{ stockItemId: 1, quantity: 1 }] },
      headers: { 'idempotency-key': 'same-key' },
      user: { storeId: 1 },
      app: { get: jest.fn().mockReturnValue(prisma) },
    } as any;
    const res = createMockResponse() as any;
    const next = jest.fn();

    const crypto = await import('crypto');
    const { canonicalJsonStringify } = await import('../../src/common/middleware/idempotency');
    matchingRecord.requestHash = crypto
      .createHash('sha256')
      .update(
        canonicalJsonStringify({
          method: 'POST',
          path: '/api/v1/orders/',
          params: {},
          query: {},
          body: { items: [{ stockItemId: 1, quantity: 1 }] },
        })
      )
      .digest('hex');

    await idempotency({ operation: 'ORDER_CREATE' })(req, res, next);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { id: 123 } });
    expect(next).not.toHaveBeenCalled();
  });

  it('does not rerun the handler or duplicate audit work on completed replay', async () => {
    const completedResponse = { success: true, data: { id: 123 } };
    const prisma = {
      idempotencyRequest: {
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'idem-1' }),
        update: jest.fn().mockResolvedValue({ id: 'idem-1' }),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: 1n }),
      },
    };

    const makeReq = () =>
      ({
        method: 'POST',
        baseUrl: '/api/v1/audit-test',
        path: '/',
        params: {},
        query: {},
        body: { value: 1 },
        headers: { 'idempotency-key': 'same-key' },
        user: { storeId: 1 },
        app: { get: jest.fn().mockReturnValue(prisma) },
      } as any);

    const handler = jest.fn(async (_req: any, res: any) => {
      await prisma.auditLog.create({ data: { action: 'AUDIT_TEST_MUTATION' } });
      res.status(201).json(completedResponse);
    });

    prisma.idempotencyRequest.findUnique.mockResolvedValueOnce(null);
    const firstReq = makeReq();
    const firstRes = createMockResponse() as any;
    const firstNext = jest.fn();

    await idempotency({ operation: 'AUDIT_TEST' })(firstReq, firstRes, firstNext);
    expect(firstNext).toHaveBeenCalledWith();
    await handler(firstReq, firstRes);
    await Promise.resolve();

    const completedRecord = {
      id: 'idem-1',
      requestHash: firstReq.idempotencyContext.requestHash,
      status: 'COMPLETED',
      statusCode: 201,
      responseJson: completedResponse,
    };
    prisma.idempotencyRequest.findUnique.mockResolvedValueOnce(completedRecord);

    const secondReq = makeReq();
    const secondRes = createMockResponse() as any;
    const secondNext = jest.fn();

    await idempotency({ operation: 'AUDIT_TEST' })(secondReq, secondRes, secondNext);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(secondNext).not.toHaveBeenCalled();
    expect(secondRes.status).toHaveBeenCalledWith(201);
    expect(secondRes.json).toHaveBeenCalledWith(completedResponse);
  });
});
