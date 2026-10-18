import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  const tables = await prisma.$queryRaw<Array<{ TABLE_NAME: string }>>`
    SELECT table_name AS TABLE_NAME 
    FROM information_schema.tables 
    WHERE table_schema = 'stockpilot'
    ORDER BY table_name ASC
  `;

  console.log('--- TABLE ROW COUNTS ---');
  for (const t of tables) {
    const res: any = await prisma.$queryRawUnsafe(`SELECT COUNT(*) as c FROM \`${t.TABLE_NAME}\``);
    console.log(`${t.TABLE_NAME.padEnd(28)}: ${Number(res[0].c)} rows`);
  }
}

run()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
