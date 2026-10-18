import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const alerts = await prisma.alert.findMany();
  console.log(`Found ${alerts.length} alerts in database.`);

  let updatedCount = 0;
  for (const a of alerts) {
    let newTitle = a.title;
    let newMessage = a.message;

    // Replace "SKU SP" with "SP" or "SKU " with "SP "
    newTitle = newTitle.replace(/\bSKU\s+SP/gi, 'SP').replace(/\bSKU\s+/gi, 'SP ');
    newMessage = newMessage
      .replace(/\bSKU\s+SP/gi, 'SP')
      .replace(/\bSKU\s+/gi, 'SP ')
      .replace(/\(Z-Score:\s*([^)]+)\)/gi, '(Độ lệch chuẩn Z: $1)');

    if (newTitle !== a.title || newMessage !== a.message) {
      await prisma.alert.update({
        where: { id: a.id },
        data: {
          title: newTitle,
          message: newMessage,
        },
      });
      updatedCount++;
    }
  }

  console.log(`Updated ${updatedCount} alerts in database.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
