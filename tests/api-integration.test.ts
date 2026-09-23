import request from 'supertest';
import { createApp } from '../src/app';
import { generateAccessToken } from '../src/common/utils/jwt';

describe('API Integration & Cross-Store Security', () => {
  const app = createApp();

  const tokenStore1Owner = generateAccessToken({
    userId: 1,
    email: 'owner1@store1.com',
    role: 'SHOP_OWNER',
    storeId: 1,
  });

  const tokenStore2Staff = generateAccessToken({
    userId: 2,
    email: 'staff2@store2.com',
    role: 'WAREHOUSE_STAFF',
    storeId: 2,
  });

  it('GET /api/v1/health trả về 200 OK', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OK');
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('Yêu cầu không có Bearer token trả về 401 UNAUTHENTICATED', async () => {
    const res = await request(app).get('/api/v1/products');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('Warehouse Staff truy cập endpoint Dashboard (yêu cầu Shop Owner/Admin) trả về 403 FORBIDDEN', async () => {
    const res = await request(app)
      .get('/api/v1/analytics/dashboard')
      .set('Authorization', `Bearer ${tokenStore2Staff}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
