/**
 * seed.ts - Them du lieu mau cho StockPilot
 * Chay bang: npx tsx scripts/seed.ts
 */

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("Bat dau them du lieu mau...");

  // 1. STORE
  const store = await prisma.store.upsert({
    where: { code: "SP-001" },
    update: {},
    create: {
      name: "Tap Hoa Thanh Cong",
      code: "SP-001",
      phone: "0901234567",
      address: "123 Nguyen Hue, Quan 1, TP.HCM",
      isActive: true,
    },
  });
  console.log("Store OK:", store.id);

  // 2. USERS
  const passwordHash = await bcrypt.hash("Admin@123", 10);
  const staffHash = await bcrypt.hash("Staff@123", 10);

  const owner = await prisma.user.upsert({
    where: { email: "owner@stockpilot.vn" },
    update: {},
    create: {
      email: "owner@stockpilot.vn",
      passwordHash,
      fullName: "Nguyen Van Thanh",
      role: "SHOP_OWNER",
      storeId: store.id,
      isActive: true,
    },
  });

  await prisma.user.upsert({
    where: { email: "staff@stockpilot.vn" },
    update: {},
    create: {
      email: "staff@stockpilot.vn",
      passwordHash: staffHash,
      fullName: "Tran Thi Mai",
      role: "WAREHOUSE_STAFF",
      storeId: store.id,
      isActive: true,
    },
  });
  console.log("Users OK");

  // 3. WAREHOUSE
  let warehouse = await prisma.warehouse.findFirst({ where: { storeId: store.id, isDefault: true } });
  if (!warehouse) {
    warehouse = await prisma.warehouse.create({
      data: {
        storeId: store.id,
        name: "Kho chinh - Quan 1",
        location: "123 Nguyen Hue, Q1, TP.HCM",
        isDefault: true,
        isActive: true,
      },
    });
  }
  console.log("Warehouse OK:", warehouse.id);

  // 4. ENGINE CONFIG
  await prisma.engineConfig.upsert({
    where: { storeId: store.id },
    update: {},
    create: {
      storeId: store.id,
      leadTimeDays: 5,
      safetyDays: 3,
      serviceLevel: 0.95,
      targetCoverageDays: 30,
      slowMovingDays: 45,
      deadStockDays: 90,
      minimumHistoryDays: 14,
      minimumMarginPct: 0.20,
      maxMarkdownPct: 0.30,
      maxMarkupPct: 0.25,
    },
  });

  // 5. CATEGORIES
  const catDefs = [
    { code: "TPCN", name: "Thuc pham & Do an", description: "Thuc pham tuoi song, dong goi" },
    { code: "DRINK", name: "Do uong & Ca phe", description: "Nuoc giai khat, ca phe, tra" },
    { code: "SPICE", name: "Gia vi & Thuc pham kho", description: "Gia vi, mi goi, bot" },
    { code: "HOUSE", name: "Do dung gia dinh", description: "Dung cu bep, ve sinh" },
    { code: "CARE", name: "Cham soc ca nhan", description: "My pham, ve sinh co the" },
    { code: "MISC", name: "Tieu dung khac", description: "Van phong pham, phu kien" },
  ];

  const cats: Record<string, any> = {};
  for (const c of catDefs) {
    const cat = await prisma.category.upsert({
      where: { storeId_code: { storeId: store.id, code: c.code } },
      update: {},
      create: { storeId: store.id, ...c },
    });
    cats[c.code] = cat;
  }
  console.log("Categories OK");

  // 6. PRODUCTS & STOCK ITEMS
  const productDefs = [
    { cat: "TPCN", name: "Banh mi que Da Lat", code: "TP-BM-001", sku: "BM-DL-250G", cost: 8000, price: 12000, stock: 120, min: 20, max: 200 },
    { cat: "TPCN", name: "Xuc xich Duc Viet 500g", code: "TP-XX-001", sku: "XX-DV-500G", cost: 55000, price: 72000, stock: 80, min: 10, max: 150 },
    { cat: "TPCN", name: "Pho mai con bo cuoi 8 vien", code: "TP-PM-001", sku: "PM-BC-8V", cost: 32000, price: 42000, stock: 60, min: 10, max: 100 },
    { cat: "TPCN", name: "Sua chua Vinamilk 100g (loc 4)", code: "TP-SC-001", sku: "SC-VM-L4", cost: 24000, price: 32000, stock: 150, min: 30, max: 300 },
    { cat: "TPCN", name: "Trung ga sach Ba Huan (hop 10)", code: "TP-TG-001", sku: "TG-BH-H10", cost: 38000, price: 49000, stock: 40, min: 10, max: 80 },
    { cat: "DRINK", name: "Ca phe Arabica Da Lat 500g", code: "DK-CF-001", sku: "CF-DL-500G", cost: 85000, price: 125000, stock: 55, min: 10, max: 100 },
    { cat: "DRINK", name: "Tra O Long Thai Nguyen 200g", code: "DK-TR-001", sku: "TR-TN-200G", cost: 45000, price: 68000, stock: 40, min: 5, max: 80 },
    { cat: "DRINK", name: "Nuoc suoi Aquafina 500ml (thung 24)", code: "DK-NS-001", sku: "NS-AQ-T24", cost: 110000, price: 145000, stock: 30, min: 5, max: 60 },
    { cat: "DRINK", name: "Coca Cola 330ml (loc 6)", code: "DK-CL-001", sku: "CL-CC-L6", cost: 52000, price: 72000, stock: 45, min: 10, max: 100 },
    { cat: "DRINK", name: "Sua tuoi Vinamilk 1L (hop)", code: "DK-ST-001", sku: "ST-VM-1L", cost: 28000, price: 38000, stock: 90, min: 20, max: 180 },
    { cat: "SPICE", name: "Mi tom Hao Hao (thung 30 goi)", code: "SP-MT-001", sku: "MT-HH-T30", cost: 95000, price: 135000, stock: 25, min: 5, max: 50 },
    { cat: "SPICE", name: "Nuoc mam Phu Quoc 40 do 500ml", code: "SP-NM-001", sku: "NM-PQ-500", cost: 42000, price: 58000, stock: 35, min: 5, max: 70 },
    { cat: "SPICE", name: "Dau an Tuong An 1L", code: "SP-DA-001", sku: "DA-TA-1L", cost: 38000, price: 52000, stock: 50, min: 10, max: 100 },
    { cat: "SPICE", name: "Muoi tinh Ima 1kg", code: "SP-MU-001", sku: "MU-IM-1KG", cost: 8000, price: 12000, stock: 70, min: 10, max: 150 },
    { cat: "SPICE", name: "Bot ngot Ajinomoto 400g", code: "SP-BN-001", sku: "BN-AJ-400G", cost: 25000, price: 35000, stock: 45, min: 5, max: 90 },
    { cat: "HOUSE", name: "Nuoc rua chen Sunlight 750ml", code: "HH-NRC-001", sku: "NRC-SL-750", cost: 22000, price: 32000, stock: 60, min: 10, max: 120 },
    { cat: "HOUSE", name: "Nuoc giat Omo 3kg", code: "HH-NG-001", sku: "NG-OM-3KG", cost: 95000, price: 135000, stock: 25, min: 5, max: 50 },
    { cat: "HOUSE", name: "Giay ve sinh Pulppy (loc 10)", code: "HH-GV-001", sku: "GV-PP-L10", cost: 52000, price: 72000, stock: 40, min: 10, max: 80 },
    { cat: "HOUSE", name: "Tui rac den 65x80 (50 tui)", code: "HH-TR-001", sku: "TR-65X80-50", cost: 18000, price: 28000, stock: 55, min: 10, max: 100 },
    { cat: "HOUSE", name: "Nhang tram huong Sach vong 2h", code: "HH-NTH-001", sku: "NTH-TH-2H", cost: 15000, price: 25000, stock: 30, min: 5, max: 60 },
    { cat: "CARE", name: "Dau goi Clear Men 380ml", code: "CS-DG-001", sku: "DG-CM-380", cost: 68000, price: 92000, stock: 35, min: 5, max: 70 },
    { cat: "CARE", name: "Kem danh rang PS 230g", code: "CS-KDR-001", sku: "KDR-PS-230", cost: 22000, price: 35000, stock: 50, min: 10, max: 100 },
    { cat: "CARE", name: "Sua tam Dove duong am 500ml", code: "CS-ST-001", sku: "ST-DV-500", cost: 75000, price: 105000, stock: 30, min: 5, max: 60 },
    { cat: "CARE", name: "Bang ve sinh Kotex 8 mieng", code: "CS-BVS-001", sku: "BVS-KX-8", cost: 22000, price: 32000, stock: 45, min: 10, max: 90 },
    { cat: "CARE", name: "Khan giay Pulppy hop 180 to", code: "CS-KG-001", sku: "KG-PP-180", cost: 28000, price: 42000, stock: 55, min: 10, max: 110 },
    { cat: "MISC", name: "Pin AA Duracell (vi 4)", code: "MS-PIN-001", sku: "PIN-DR-AA4", cost: 38000, price: 55000, stock: 20, min: 5, max: 40 },
    { cat: "MISC", name: "Bang dinh trong 48mm x 45m", code: "MS-BD-001", sku: "BD-TR-4845", cost: 15000, price: 25000, stock: 30, min: 5, max: 60 },
    { cat: "MISC", name: "Khau trang y te 4 lop (hop 50)", code: "MS-KT-001", sku: "KT-YT-H50", cost: 45000, price: 65000, stock: 15, min: 5, max: 30 },
    { cat: "MISC", name: "O cam dien 6 lo co day", code: "MS-OC-001", sku: "OC-6L-2M", cost: 55000, price: 85000, stock: 10, min: 2, max: 20 },
    { cat: "MISC", name: "Keo 502 sieu dinh (lo 3g)", code: "MS-KEO-001", sku: "KEO-502-3G", cost: 8000, price: 15000, stock: 25, min: 5, max: 50 },
  ];

  const stockItems: Record<string, any> = {};

  for (const pd of productDefs) {
    const product = await prisma.product.upsert({
      where: { storeId_code: { storeId: store.id, code: pd.code } },
      update: {},
      create: {
        storeId: store.id,
        categoryId: cats[pd.cat].id,
        name: pd.name,
        code: pd.code,
        isActive: true,
      },
    });

    const si = await prisma.stockItem.upsert({
      where: { storeId_sku: { storeId: store.id, sku: pd.sku } },
      update: {},
      create: {
        storeId: store.id,
        productId: product.id,
        sku: pd.sku,
        name: pd.name,
        costPrice: pd.cost,
        sellingPrice: pd.price,
        minStockLevel: pd.min,
        maxStockLevel: pd.max,
        isActive: true,
      },
    });
    stockItems[pd.sku] = si;

    await prisma.inventoryBalance.upsert({
      where: { warehouseId_stockItemId: { warehouseId: warehouse.id, stockItemId: si.id } },
      update: { quantity: pd.stock },
      create: {
        storeId: store.id,
        warehouseId: warehouse.id,
        stockItemId: si.id,
        quantity: pd.stock,
        reservedQuantity: 0,
      },
    });

    const idempKey = `seed-inflow-${si.id}-${warehouse.id}`;
    const existMv = await prisma.stockMovement.findUnique({ where: { idempotencyKey: idempKey } });
    if (!existMv) {
      await prisma.stockMovement.create({
        data: {
          storeId: store.id,
          warehouseId: warehouse.id,
          stockItemId: si.id,
          type: "INFLOW",
          delta: pd.stock,
          beforeQuantity: 0,
          afterQuantity: pd.stock,
          referenceType: "SEED",
          referenceId: `SEED-${si.id}`,
          idempotencyKey: idempKey,
          note: "Nhap hang ban dau (seed)",
          createdById: owner.id,
        },
      });
    }
  }
  console.log("Products & Inventory OK:", productDefs.length);

  // 7. ORDERS & PAYMENTS
  const itemSkus = Object.keys(stockItems);
  const pmethods = [
    { provider: "CASH", method: "CASH" },
    { provider: "CASH", method: "CASH" },
    { provider: "CASH", method: "CASH" },
    { provider: "PAYOS", method: "BANK_TRANSFER" },
    { provider: "PAYOS", method: "PAYOS" },
  ] as const;

  const customers = [
    { name: "Nguyen Thi Lan", phone: "0901111111" },
    { name: "Tran Van Binh", phone: "0902222222" },
    { name: "Le Thi Hoa", phone: "0903333333" },
    { name: "Pham Quoc Hung", phone: "0904444444" },
    { name: "Vo Thi Thu", phone: "0905555555" },
    { name: null, phone: null },
  ];

  let orderCount = 0;
  for (let i = 1; i <= 30; i++) {
    const orderNum = `ORD-${String(i).padStart(4, "0")}`;
    const existOrd = await prisma.order.findUnique({
      where: { storeId_orderNumber: { storeId: store.id, orderNumber: orderNum } },
    });
    if (existOrd) continue;

    const customer = customers[i % customers.length];
    const numItems = Math.floor(Math.random() * 3) + 1;
    const shuffled = [...itemSkus].sort(() => Math.random() - 0.5).slice(0, numItems);

    let subtotal = 0;
    const lines = shuffled.map((sku) => {
      const si = stockItems[sku];
      const qty = Math.floor(Math.random() * 3) + 1;
      const price = Number(si.sellingPrice);
      const cost = Number(si.costPrice);
      const sub = price * qty;
      subtotal += sub;
      return { si, qty, price, cost, sub };
    });

    const daysAgo = Math.floor(Math.random() * 30);
    const orderDate = new Date();
    orderDate.setDate(orderDate.getDate() - daysAgo);
    orderDate.setHours(7 + Math.floor(Math.random() * 12), Math.floor(Math.random() * 60), 0);

    const order = await prisma.order.create({
      data: {
        storeId: store.id,
        orderNumber: orderNum,
        status: "FULFILLED",
        customerName: customer.name,
        customerPhone: customer.phone,
        subtotalAmount: subtotal,
        discountAmount: 0,
        taxAmount: 0,
        totalAmount: subtotal,
        confirmedAt: orderDate,
        fulfilledAt: orderDate,
        createdById: owner.id,
        createdAt: orderDate,
        updatedAt: orderDate,
      },
    });

    for (const l of lines) {
      await prisma.orderItem.create({
        data: {
          storeId: store.id,
          orderId: order.id,
          stockItemId: l.si.id,
          skuSnapshot: l.si.sku,
          nameSnapshot: l.si.name,
          unitPriceSnapshot: l.price,
          costPriceSnapshot: l.cost,
          quantity: l.qty,
          refundableAmount: l.sub,
          refundedAmount: 0,
          returnedQuantity: 0,
          subtotal: l.sub,
          createdAt: orderDate,
        },
      });
    }

    const pm = pmethods[i % pmethods.length];
    await prisma.payment.create({
      data: {
        storeId: store.id,
        orderId: order.id,
        provider: pm.provider,
        method: pm.method,
        amount: subtotal,
        currency: "VND",
        status: "PAID",
        paidAt: orderDate,
        createdAt: orderDate,
        updatedAt: orderDate,
      },
    });
    orderCount++;
  }
  console.log("Orders OK:", orderCount);

  // 8. ALERTS
  const alertDefs = [
    { sku: "KT-YT-H50", type: "LOW_STOCK" as const, severity: "WARNING" as const, title: "Khau trang gan het hang", message: "Ton kho con 15, thap hon muc toi thieu. Can dat them." },
    { sku: "OC-6L-2M", type: "LOW_STOCK" as const, severity: "WARNING" as const, title: "O cam dien 6 lo ton thap", message: "Ton kho con 10. Theo doi." },
    { sku: "MT-HH-T30", type: "SLOW_MOVING" as const, severity: "INFO" as const, title: "Mi tom Hao Hao ban cham", message: "Khong co don hang trong 15 ngay. Khuyen mai?" },
  ];

  for (const al of alertDefs) {
    const si = stockItems[al.sku];
    if (!si) continue;
    const fp = `${al.type}-${si.id}-${store.id}`;
    await prisma.alert.upsert({
      where: { storeId_fingerprint: { storeId: store.id, fingerprint: fp } },
      update: {},
      create: {
        storeId: store.id,
        stockItemId: si.id,
        type: al.type,
        severity: al.severity,
        status: "OPEN",
        title: al.title,
        message: al.message,
        reasonJson: { auto: true },
        fingerprint: fp,
      },
    });
  }
  console.log("Alerts OK");

  // 9. NOTIFICATIONS
  const notifDefs = [
    { type: "LOW_STOCK", title: "Canh bao hang ton thap", message: "Khau trang y te sap het, can dat them hang." },
    { type: "ORDER_CREATED", title: "Don hang moi", message: "5 don hang duoc tao hom nay." },
    { type: "PAYMENT_SUCCESS", title: "Thanh toan thanh cong", message: "Don ORD-0030 da duoc thanh toan qua chuyen khoan." },
  ];

  for (const n of notifDefs) {
    await prisma.notification.create({
      data: {
        storeId: store.id,
        userId: owner.id,
        type: n.type,
        title: n.title,
        message: n.message,
        isRead: false,
      },
    });
  }
  console.log("Notifications OK");

  console.log("\n=== SEED HOAN TAT ===");
  console.log("Login: owner@stockpilot.vn / Admin@123");
  console.log("Staff: staff@stockpilot.vn / Staff@123");
}

main()
  .catch((e) => {
    console.error("Seed loi:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
