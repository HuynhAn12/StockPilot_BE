import { AuthService } from '../src/modules/auth/auth.service';
import { prisma } from '../src/config/db';
import { ConflictError, UnauthenticatedError } from '../src/common/errors/app-error';

jest.mock('../src/config/db', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    store: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    warehouse: {
      create: jest.fn(),
    },
    $transaction: jest.fn((callback) => callback(prisma)),
  },
}));

describe('AuthService - Shop Owner Registration & Login', () => {
  let authService: AuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    authService = new AuthService();
  });

  it('phải tạo User (Shop Owner), Store và Default Warehouse trong cùng một Transaction', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.store.findUnique as jest.Mock).mockResolvedValue(null);

    const mockStore = { id: 1, name: 'Cửa hàng Test', code: 'STORE_TEST' };
    const mockWh = { id: 10, storeId: 1, name: 'Kho Mặc Định', isDefault: true };
    const mockUser = { id: 100, email: 'owner@test.com', fullName: 'Chủ Shop', role: 'SHOP_OWNER', storeId: 1 };

    (prisma.store.create as jest.Mock).mockResolvedValue(mockStore);
    (prisma.warehouse.create as jest.Mock).mockResolvedValue(mockWh);
    (prisma.user.create as jest.Mock).mockResolvedValue(mockUser);

    const result = await authService.registerOwner({
      fullName: 'Chủ Shop',
      email: 'owner@test.com',
      password: 'password123',
      storeName: 'Cửa hàng Test',
      storeCode: 'STORE_TEST',
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(result.user.role).toBe('SHOP_OWNER');
    expect(result.store.code).toBe('STORE_TEST');
    expect(result.warehouse.isDefault).toBe(true);
    expect(result.tokens.accessToken).toBeDefined();
  });

  it('phải ném lỗi ConflictError nếu email đã tồn tại', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 1, email: 'owner@test.com' });

    await expect(
      authService.registerOwner({
        fullName: 'Chủ Shop',
        email: 'owner@test.com',
        password: 'password123',
        storeName: 'Cửa hàng Test',
        storeCode: 'STORE_TEST',
      })
    ).rejects.toThrow(ConflictError);
  });

  it('phải ném lỗi UnauthenticatedError nếu mật khẩu không đúng khi đăng nhập', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: 1,
      email: 'owner@test.com',
      passwordHash: '$2a$10$invalidhashstringhere12345678901234567890',
      isActive: true,
      role: 'SHOP_OWNER',
      storeId: 1,
    });

    await expect(
      authService.login({
        email: 'owner@test.com',
        password: 'wrongpassword',
      })
    ).rejects.toThrow(UnauthenticatedError);
  });
});
