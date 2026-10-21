const { prisma } = require('./dist/config/db');

async function main() {
  const storeId = 4;
  console.log('=== CHECKING STORE 4 DATA IN MYSQL (NAVİCAT DATABASE) ===\n');

  const tables = [
    { name: 'products', query: `SELECT COUNT(*) as cnt FROM products WHERE storeId = ${storeId}` },
    { name: 'categories', query: `SELECT COUNT(*) as cnt FROM categories WHERE storeId = ${storeId}` },
    { name: 'stock_items', query: `SELECT COUNT(*) as cnt FROM stock_items WHERE storeId = ${storeId}` },
    { name: 'inventory_balances', query: `SELECT COUNT(*) as cnt, COALESCE(SUM(quantity), 0) as totalQty FROM inventory_balances WHERE storeId = ${storeId}` },
    { name: 'stock_movements', query: `SELECT COUNT(*) as cnt FROM stock_movements WHERE storeId = ${storeId}` },
    { name: 'warehouses', query: `SELECT COUNT(*) as cnt FROM warehouses WHERE storeId = ${storeId}` },
    { name: 'orders', query: `SELECT COUNT(*) as cnt, COALESCE(SUM(totalAmount), 0) as totalRev FROM orders WHERE storeId = ${storeId}` },
    { name: 'order_items', query: `SELECT COUNT(*) as cnt, COALESCE(SUM(subtotal), 0) as totalItemsRev FROM order_items WHERE storeId = ${storeId}` },
    { name: 'return_orders', query: `SELECT COUNT(*) as cnt, COALESCE(SUM(totalRefundAmount), 0) as totalRefund FROM return_orders WHERE storeId = ${storeId}` },
    { name: 'return_items', query: `SELECT COUNT(*) as cnt FROM return_items WHERE storeId = ${storeId}` },
    { name: 'alerts', query: `SELECT COUNT(*) as cnt, COUNT(CASE WHEN status='OPEN' THEN 1 END) as openCnt FROM alerts WHERE storeId = ${storeId}` },
    { name: 'pricing_recommendations', query: `SELECT COUNT(*) as cnt, COUNT(CASE WHEN status='PENDING' THEN 1 END) as pendingCnt FROM pricing_recommendations WHERE storeId = ${storeId}` },
    { name: 'price_histories', query: `SELECT COUNT(*) as cnt FROM price_histories WHERE storeId = ${storeId}` },
    { name: 'daily_sales_summaries', query: `SELECT COUNT(*) as cnt FROM daily_sales_summaries WHERE storeId = ${storeId}` },
    { name: 'historical_sales', query: `SELECT COUNT(*) as cnt FROM historical_sales WHERE storeId = ${storeId}` },
    { name: 'stock_takes', query: `SELECT COUNT(*) as cnt FROM stock_takes WHERE storeId = ${storeId}` },
    { name: 'stock_take_items', query: `SELECT COUNT(*) as cnt FROM stock_take_items WHERE storeId = ${storeId}` },
    { name: 'notifications', query: `SELECT COUNT(*) as cnt FROM notifications WHERE storeId = ${storeId}` },
    { name: 'engine_configs', query: `SELECT COUNT(*) as cnt FROM engine_configs WHERE storeId = ${storeId}` },
    { name: 'store_payment_configs', query: `SELECT COUNT(*) as cnt FROM store_payment_configs WHERE storeId = ${storeId}` },
  ];

  for (const t of tables) {
    try {
      const rows = await prisma.$queryRawUnsafe(t.query);
      console.log(`[TABLE] ${t.name.padEnd(25)}:`, rows[0]);
    } catch (err) {
      console.error(`[ERROR] ${t.name}:`, err.message);
    }
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
