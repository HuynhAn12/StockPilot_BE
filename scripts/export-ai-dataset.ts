import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenv.config();

import { env } from '../src/config/env';
import { aiVaultService } from '../src/modules/assistant/ai-vault.service';

const OUTPUT_FILE = path.resolve(__dirname, '../data/fine-tune-dataset.jsonl');
const SYSTEM_PROMPT =
  'Bạn là Trợ lý AI Cố vấn Bán lẻ thông minh của StockPilot. Hãy tư vấn chính xác, chuyên nghiệp, hỗ trợ tối ưu tồn kho và quản lý cửa hàng hiệu quả.';

interface FineTuneMessage {
  messages: [
    { role: 'system'; content: string },
    { role: 'user'; content: string },
    { role: 'assistant'; content: string }
  ];
}

async function main() {
  console.log('================================================================');
  console.log('🎓 STOCKPILOT ENTERPRISE AI DATASET EXPORTER (FINE-TUNING PIPELINE)');
  console.log(`📁 Đường dẫn file xuất: ${OUTPUT_FILE}`);
  console.log('================================================================\n');

  const outDir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const writeStream = fs.createWriteStream(OUTPUT_FILE, { encoding: 'utf-8' });
  const seenPairs = new Set<string>();
  let totalExported = 0;

  function writeSample(question: string, answer: string): boolean {
    const q = question.trim();
    const a = answer.trim();

    if (q.length < 5 || a.length < 15) return false;
    // Skip system error responses
    if (/xin lỗi|lỗi hệ thống|không thể xử lý|timeout/i.test(a)) return false;

    const signature = `${q}:::${a.slice(0, 50)}`;
    if (seenPairs.has(signature)) return false;
    seenPairs.add(signature);

    const record: FineTuneMessage = {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: q },
        { role: 'assistant', content: a },
      ],
    };

    writeStream.write(JSON.stringify(record) + '\n');
    totalExported++;
    return true;
  }

  // 1. Export from In-Memory Hot Cache (data/ai-knowledge.json)
  const hotCacheFile = path.resolve(__dirname, '../data/ai-knowledge.json');
  if (fs.existsSync(hotCacheFile)) {
    try {
      const items = JSON.parse(fs.readFileSync(hotCacheFile, 'utf-8'));
      let hotCount = 0;
      for (const item of items) {
        if (item.question && item.answer) {
          if (writeSample(item.question, item.answer)) hotCount++;
        }
      }
      console.log(`✔ Đã trích xuất ${hotCount} cặp câu hỏi-đáp từ Hot Cache (${path.basename(hotCacheFile)})`);
    } catch (err) {
      console.warn('Lỗi đọc hot cache:', err);
    }
  }

  // 2. Export from SQLite Massive Vault (D:/AI_Memory/db/ai-brain.sqlite)
  if (aiVaultService.isReady()) {
    try {
      // Use internal SQLite prepare
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(env.AI_SQLITE_DB_PATH, { readonly: true });
      const rows = db.prepare('SELECT question, answer FROM knowledge_vault LIMIT 50000').all() as Array<{
        question: string;
        answer: string;
      }>;
      db.close();

      let vaultCount = 0;
      for (const row of rows) {
        if (writeSample(row.question, row.answer)) vaultCount++;
      }
      console.log(`✔ Đã trích xuất ${vaultCount} cặp câu hỏi-đáp từ SQLite Vault (${env.AI_SQLITE_DB_PATH})`);
    } catch (err) {
      console.warn('Lỗi đọc SQLite vault:', err);
    }
  }

  // 3. Export from MySQL Production History (table ai_interactions)
  const prisma = new PrismaClient();
  try {
    const interactions = await prisma.aiInteraction.findMany({
      where: {
        status: 'SUCCESS',
        questionText: { not: null },
        responseText: { not: null },
      },
      select: {
        questionText: true,
        responseText: true,
      },
      take: 10000,
      orderBy: { createdAt: 'desc' },
    });

    let mysqlCount = 0;
    for (const inter of interactions) {
      if (inter.questionText && inter.responseText) {
        if (writeSample(inter.questionText, inter.responseText)) mysqlCount++;
      }
    }
    console.log(`✔ Đã trích xuất ${mysqlCount} mẫu tương tác thực tế từ MySQL (bảng ai_interactions)`);
  } catch (err) {
    console.warn('Lỗi đọc MySQL ai_interactions:', err);
  } finally {
    await prisma.$disconnect();
  }

  writeStream.end();

  console.log('\n================================================================');
  console.log(`🎉 HOÀN TẤT XUẤT TẬP DỮ LIỆU HUẤN LUYỆN (DATASET)`);
  console.log(`Tổng số mẫu hội thoại (JSONL): ${totalExported.toLocaleString()}`);
  console.log(`Định dạng: Chuẩn OpenAI / Gemini / Qwen Chat Completion (messages: system, user, assistant)`);
  console.log(`Tập tin đã sẵn sàng tại: ${OUTPUT_FILE}`);
  console.log('================================================================\n');
}

main().catch((err) => {
  console.error('❌ Lỗi khi xuất dataset:', err);
  process.exit(1);
});

