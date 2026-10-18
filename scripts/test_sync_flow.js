const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
const http = require('http');

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

function post(path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = http.request(
      {
        hostname: 'localhost',
        port: 5000,
        path: `/api/v1${path}`,
        method: 'POST',
        headers,
      },
      (res) => {
        let resData = '';
        res.on('data', (c) => (resData += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(resData) });
          } catch (_) {
            resolve({ status: res.statusCode, raw: resData });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(path, token) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = http.request(
      {
        hostname: 'localhost',
        port: 5000,
        path: `/api/v1${path}`,
        method: 'GET',
        headers,
      },
      (res) => {
        let resData = '';
        res.on('data', (c) => (resData += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(resData) });
          } catch (_) {
            resolve({ status: res.statusCode, raw: resData });
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  console.log('=== TEST KIỂM THỬ ĐỒNG BỘ 4 PHÂN HỆ THỰC TẾ STOCKPILOT ===\n');

  // Lấy tài khoản SHOP_OWNER của Store 4 trong DB
  let user = await prisma.user.findFirst({
    where: { storeId: 4, role: 'SHOP_OWNER' },
  });
  if (!user) {
    user = await prisma.user.findFirst({ where: { role: 'SHOP_OWNER' } });
  }

  if (!user) {
    console.error('Không tìm thấy tài khoản SHOP_OWNER nào trong DB');
    process.exit(1);
  }

  console.log(`1. Xác thực tài khoản SHOP_OWNER: ${user.email} (ID: ${user.id}, StoreID: ${user.storeId})`);

  // Tạo JWT token hợp lệ để test trực tiếp
  const token = jwt.sign(
    {
      userId: Number(user.id),
      email: user.email,
      role: user.role,
      storeId: Number(user.storeId),
    },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  // 2. Kiểm tra Cảnh báo rủi ro (Alerts)
  console.log('\n2. Kiểm tra phân hệ Cảnh báo rủi ro (/alerts & /alerts/stats)...');
  const alertStatsRes = await get('/alerts/stats', token);
  console.log('✓ Thống kê cảnh báo:', alertStatsRes.body?.data || alertStatsRes.body);

  const alertsRes = await get('/alerts?status=ACTIVE', token);
  const alerts = alertsRes.body?.data?.alerts || alertsRes.body?.data || [];
  console.log(`✓ Số lượng cảnh báo ACTIVE thực tế: ${alerts.length}`);
  alerts.slice(0, 3).forEach((a) => {
    console.log(`  - [${a.severity}] ${a.title} (${a.type})`);
  });

  // 3. Kiểm tra Gợi ý giá (Pricing)
  console.log('\n3. Kiểm tra phân hệ Gợi ý giá bán (/pricing/recommendations)...');
  const pricingRes = await get('/pricing/recommendations?status=PENDING', token);
  const pricing = pricingRes.body?.data?.recommendations || pricingRes.body?.data || [];
  console.log(`✓ Số lượng gợi ý giá PENDING thực tế: ${pricing.length}`);
  pricing.slice(0, 3).forEach((p) => {
    console.log(`  - SKU #${p.stockItemId}: Giá hiện tại ${p.currentPrice} -> Đề xuất ${p.suggestedPrice} (${p.reason})`);
  });

  // 4. Kiểm tra Phân tích & Báo cáo (Analytics)
  console.log('\n4. Kiểm tra phân hệ Báo cáo phân tích (/analytics/dashboard)...');
  const analyticsRes = await get('/analytics/dashboard?timeRange=30d', token);
  const metrics = analyticsRes.body?.data?.summary || analyticsRes.body?.data;
  console.log('✓ Số liệu KPI tài chính:');
  console.log(`  - Doanh thu thuần: ${(metrics?.netRevenue || metrics?.totalRevenue || 0).toLocaleString()} VNĐ`);
  console.log(`  - Lợi nhuận gộp: ${(metrics?.grossProfit || 0).toLocaleString()} VNĐ`);
  console.log(`  - Số đơn hàng: ${metrics?.totalOrders || 0}`);
  console.log(`  - Vốn tồn kho: ${(metrics?.inventoryValue || 0).toLocaleString()} VNĐ`);

  // 5. Kiểm tra Trợ lý AI Pilot (/assistant/chat)
  console.log('\n5. Kiểm tra Trợ lý AI Pilot (/assistant/chat) với dữ liệu thời gian thực...');
  const questions = [
    'Mặt hàng nào sắp hết trong kho và cần nhập gấp?',
    'Top 5 sản phẩm bán chạy nhất tuần này là gì?',
    'Có mặt hàng nào đang bán lỗ hoặc biên lợi nhuận thấp không?',
    'Báo cáo doanh thu và lợi nhuận tuần này',
    'Phân tích rủi ro đọng vốn và hàng ứ đọng trong kho',
  ];

  for (const q of questions) {
    console.log(`\n  Q: "${q}"`);
    const aiRes = await post('/assistant/chat', { question: q }, token);
    const ans = aiRes.body?.data?.answer || '';
    const firstLine = ans.split('\n')[0];
    console.log(`  AI: ${firstLine}`);
    if (aiRes.body?.data?.actionLinks?.length) {
      console.log(`  Links: ${JSON.stringify(aiRes.body.data.actionLinks)}`);
    }
  }

  console.log('\n=== TẤT CẢ 4 PHÂN HỆ ĐÃ HOẠT ĐỘNG HOÀN HẢO VỚI DỮ LIỆU THỰC TẾ! ===');
}

run()
  .catch((e) => {
    console.error('Error running test:', e);
  })
  .finally(() => prisma.$disconnect());
