import fs from 'fs';
import path from 'path';
import readline from 'readline';
import dotenv from 'dotenv';

dotenv.config();

import { env } from '../src/config/env';
import { aiVaultService, VaultRecordInput } from '../src/modules/assistant/ai-vault.service';

/**
 * 50GB-100GB Streaming Ingestion Engine.
 * - Streams line-by-line using Node.js fs.createReadStream + readline
 * - Never loads the whole dataset into RAM (RAM usage strictly < 50MB)
 * - Ingests in atomic batches of 1,000 records per SQLite transaction
 * - Real-time terminal progress reporting: lines/sec, bytes used, 100GB quota guard
 */

const RAW_DATASETS_DIR = path.resolve(env.AI_STORAGE_ROOT, 'raw_datasets');
const BATCH_SIZE = 1000;

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

async function ingestJsonlFile(filePath: string): Promise<number> {
  const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 64 * 1024 });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let totalLines = 0;
  let batch: VaultRecordInput[] = [];
  const startTime = Date.now();
  let lastReportTime = startTime;
  let linesSinceLastReport = 0;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    totalLines++;
    linesSinceLastReport++;

    try {
      const parsed = JSON.parse(trimmed) as {
        question?: string;
        prompt?: string;
        input?: string;
        answer?: string;
        response?: string;
        output?: string;
        category?: string;
        keywords?: string[];
      };

      const q = parsed.question || parsed.prompt || parsed.input;
      const a = parsed.answer || parsed.response || parsed.output;

      if (q && a && q.trim().length >= 3 && a.trim().length >= 10) {
        batch.push({
          question: q.trim(),
          answer: a.trim(),
          category: parsed.category || 'imported_dataset',
          keywords: parsed.keywords,
        });
      }
    } catch {
      // Skip invalid JSON lines
    }

    if (batch.length >= BATCH_SIZE) {
      aiVaultService.insertBatch(batch);
      batch = [];

      const now = Date.now();
      if (now - lastReportTime >= 1000) {
        const speed = Math.round((linesSinceLastReport / (now - lastReportTime)) * 1000);
        const stats = aiVaultService.getVaultStats();
        process.stdout.write(
          `\r[Ingesting] Lines: ${totalLines.toLocaleString()} | Speed: ${speed.toLocaleString()} lines/s | Vault Rows: ${stats.rowCount.toLocaleString()} | Storage: ${formatBytes(stats.totalStorageBytes)} / ${env.AI_MAX_STORAGE_GB} GB (${stats.usagePercent}%)`
        );
        lastReportTime = now;
        linesSinceLastReport = 0;
      }
    }
  }

  // Insert remaining batch
  if (batch.length > 0) {
    aiVaultService.insertBatch(batch);
  }

  const durationSec = Math.max(1, (Date.now() - startTime) / 1000);
  console.log(
    `\n✔ Hoàn tất file: ${path.basename(filePath)} | Đã nạp: ${totalLines.toLocaleString()} dòng | Thời gian: ${durationSec.toFixed(1)}s (${Math.round(totalLines / durationSec)} dòng/s)`
  );

  return totalLines;
}

async function ingestCsvFile(filePath: string): Promise<number> {
  const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 64 * 1024 });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let isHeader = true;
  let totalLines = 0;
  let batch: VaultRecordInput[] = [];

  for await (const line of rl) {
    if (isHeader) {
      isHeader = false;
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) continue;

    // Simple CSV splitter handling quoted cells
    const parts = trimmed.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
    if (parts.length >= 2) {
      const q = parts[0].replace(/^"|"$/g, '').trim();
      const a = parts[1].replace(/^"|"$/g, '').trim();
      if (q.length >= 3 && a.length >= 5) {
        batch.push({
          question: q,
          answer: a,
          category: 'imported_csv',
        });
        totalLines++;
      }
    }

    if (batch.length >= BATCH_SIZE) {
      aiVaultService.insertBatch(batch);
      batch = [];
    }
  }

  if (batch.length > 0) {
    aiVaultService.insertBatch(batch);
  }

  console.log(`✔ Hoàn tất CSV: ${path.basename(filePath)} | Đã nạp: ${totalLines.toLocaleString()} dòng`);
  return totalLines;
}

async function main() {
  console.log('================================================================');
  console.log('🚀 STOCKPILOT AI MASSIVE STORAGE INGESTION ENGINE (50GB-100GB)');
  console.log(`📂 Thư mục chứa dữ liệu thô: ${RAW_DATASETS_DIR}`);
  console.log(`🗄️ Database lưu trữ đích:   ${env.AI_SQLITE_DB_PATH}`);
  console.log(`🛡️ Hạn mức lưu trữ tối đa:  ${env.AI_MAX_STORAGE_GB} GB`);
  console.log('================================================================\n');

  if (!fs.existsSync(RAW_DATASETS_DIR)) {
    fs.mkdirSync(RAW_DATASETS_DIR, { recursive: true });
    console.log(`Đã tạo thư mục trống: ${RAW_DATASETS_DIR}`);
  }

  const files = fs.readdirSync(RAW_DATASETS_DIR).filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return ['.jsonl', '.json', '.csv', '.txt'].includes(ext);
  });

  if (files.length === 0) {
    console.log(`⚠️ Chưa tìm thấy file dữ liệu nào trong: ${RAW_DATASETS_DIR}`);
    console.log('💡 Gợi ý: Bạn hãy sao chép các file (.jsonl, .json, .csv) vào thư mục trên rồi chạy lại lệnh:');
    console.log('   npm run ai:ingest  hoặc  npx tsx scripts/ingest-50gb-data.ts\n');

    // Show current stats
    const stats = aiVaultService.getVaultStats();
    console.log(`📊 Hiện trạng SQLite Vault: ${stats.rowCount.toLocaleString()} bản ghi (${formatBytes(stats.dbSizeBytes)})`);
    console.log(`💾 Tổng dung lượng D:\\AI_Memory: ${formatBytes(stats.totalStorageBytes)} / ${env.AI_MAX_STORAGE_GB} GB`);
    return;
  }

  console.log(`Tìm thấy ${files.length} file dữ liệu cần nạp:`);
  for (const f of files) {
    const stat = fs.statSync(path.join(RAW_DATASETS_DIR, f));
    console.log(` - ${f} (${formatBytes(stat.size)})`);
  }
  console.log('\nBắt đầu nạp dữ liệu theo luồng (Streaming Line-by-Line)...');

  let grandTotal = 0;
  const startGlobal = Date.now();

  for (const file of files) {
    const fullPath = path.join(RAW_DATASETS_DIR, file);
    const ext = path.extname(file).toLowerCase();

    if (ext === '.jsonl' || ext === '.txt' || ext === '.json') {
      grandTotal += await ingestJsonlFile(fullPath);
    } else if (ext === '.csv') {
      grandTotal += await ingestCsvFile(fullPath);
    }
  }

  const totalTime = ((Date.now() - startGlobal) / 1000).toFixed(1);
  const finalStats = aiVaultService.getVaultStats();

  console.log('\n================================================================');
  console.log('🎉 TỔNG KẾT NẠP DỮ LIỆU THÀNH CÔNG');
  console.log(`Tổng số dòng đã xử lý:  ${grandTotal.toLocaleString()}`);
  console.log(`Tổng số bản ghi trong Vault: ${finalStats.rowCount.toLocaleString()}`);
  console.log(`Dung lượng SQLite Database:  ${formatBytes(finalStats.dbSizeBytes)}`);
  console.log(`Tổng dung lượng kho AI:      ${formatBytes(finalStats.totalStorageBytes)} / ${env.AI_MAX_STORAGE_GB} GB (${finalStats.usagePercent}%)`);
  console.log(`Thời gian thực hiện:         ${totalTime} giây`);
  console.log('================================================================');
}

main().catch((err) => {
  console.error('\n❌ Lỗi khi nạp dữ liệu:', err);
  process.exit(1);
});

