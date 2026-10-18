const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  const storeId = 4;
  console.log('Store ID for staff:', storeId);

  const hash = await bcrypt.hash('Password123!', 10);

  // 1. Admin
  const admin = await prisma.user.upsert({
    where: { email: 'admin@stockpilot.vn' },
    update: { role: 'ADMIN', isActive: true, fullName: 'Hệ thống Quản trị viên (Admin)' },
    create: {
      email: 'admin@stockpilot.vn',
      fullName: 'Hệ thống Quản trị viên (Admin)',
      passwordHash: hash,
      role: 'ADMIN',
      storeId: null,
      isActive: true,
    },
  });
  console.log('Admin user:', admin.email, admin.role);

  // 2. Staff
  const staff = await prisma.user.upsert({
    where: { email: 'staff@stockpilot.vn' },
    update: { storeId, role: 'WAREHOUSE_STAFF', isActive: true, fullName: 'Trần Thị Mai (Nhân viên)' },
    create: {
      email: 'staff@stockpilot.vn',
      fullName: 'Trần Thị Mai (Nhân viên)',
      passwordHash: hash,
      role: 'WAREHOUSE_STAFF',
      storeId,
      isActive: true,
    },
  });
  console.log('Staff user:', staff.email, staff.role, 'storeId:', staff.storeId);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
