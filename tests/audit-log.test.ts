import { Prisma } from '@prisma/client';
import { AuditLogService } from '../src/common/services/audit-log.service';

describe('AuditLogService', () => {
  it('sanitizes secrets, tokens and credentials before persistence', async () => {
    const create = jest.fn().mockResolvedValue({ id: 1n });
    const client = { auditLog: { create } } as any;

    await AuditLogService.create(client, {
      storeId: 1,
      userId: 10,
      action: 'USER_CREATED',
      entityType: 'USER',
      entityId: 20,
      beforeJson: {
        password: 'plain',
        passwordHash: 'hashed',
        refreshToken: 'refresh',
        nested: {
          apiSecret: 'secret',
          safeValue: 'kept',
        },
      },
      afterJson: {
        amount: new Prisma.Decimal('12.50'),
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        storeId: 1,
        userId: 10,
        action: 'USER_CREATED',
        entityType: 'USER',
        entityId: '20',
        beforeJson: {
          nested: {
            safeValue: 'kept',
          },
        },
        afterJson: {
          amount: '12.50',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    });
  });
});
