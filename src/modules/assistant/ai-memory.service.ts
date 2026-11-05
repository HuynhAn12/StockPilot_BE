import fs from 'fs';
import path from 'path';
import { logger } from '../../common/logger';
import {
  vectorEmbeddingService,
  cosineSimilarity,
} from './vector-embedding.service';
import { aiVaultService, VaultSearchResult } from './ai-vault.service';

export interface KnowledgeItem {
  id: string;
  question: string;
  normalizedQuestion: string;
  answer: string;
  category: 'static_faq' | 'general';
  keywords?: string[];
  embedding?: number[];
  hitCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemorySearchResult {
  item: KnowledgeItem;
  score: number;
  source: 'RAM_HOT_CACHE_HYBRID' | 'RAM_HOT_CACHE_LEXICAL' | 'VAULT_VECTOR_HYBRID' | 'VAULT_FTS_LEXICAL';
  breakdown: {
    jaccard: number;
    dice: number;
    unaccented: number;
    cosine?: number;
  };
}

export type QueryIntent = 'DYNAMIC_REALTIME' | 'STATIC_KNOWLEDGE' | 'LOW_QUALITY_OR_AMBIGUOUS';

/**
 * Common Vietnamese stop words and fillers that do not carry semantic weight.
 */
const VIETNAMESE_STOP_WORDS = new Set([
  'cho', 'toi', 'tôi', 'minh', 'mình', 'em', 'anh', 'chi', 'chị', 'ban', 'bạn',
  'hoi', 'hỏi', 'voi', 'với', 'a', 'ạ', 'nhe', 'nhé', 'nha', 'la', 'là',
  'gi', 'gì', 'sao', 'cach', 'cách', 'the', 'thế', 'nao', 'nào',
  'oi', 'ơi', 'vay', 'vậy', 'giup', 'giúp', 'duoc', 'được', 'khong', 'không',
  'hay', 'hãy', 'xin', 'can', 'cần', 'ở', 'o', 'nhỉ', 'nhi', 'trong', 'về', 've',
  'để', 'de', 'và', 'va', 'ra', 'vào', 'vao', 'của', 'cua', 'như', 'nhu'
]);

/**
 * Multi-word filler phrases commonly spoken or typed in chat.
 */
const FILLER_PHRASES = [
  'làm thế nào để', 'làm thế nào', 'như thế nào', 'làm sao để', 'làm sao',
  'hướng dẫn cách', 'hướng dẫn cho', 'hướng dẫn', 'cho tôi hỏi', 'cho em hỏi',
  'cho mình hỏi', 'vui lòng cho', 'vui lòng', 'giúp tôi với', 'giúp tôi',
  'giúp em với', 'giúp em', 'chỉ tôi với', 'chỉ tôi', 'chỉ em với', 'chỉ em'
];

/**
 * Removes tone marks/accents from Vietnamese text.
 */
export function removeVietnameseAccents(str: string): string {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

/**
 * Normalizes Vietnamese queries by lowercasing, stripping punctuation,
 * stripping conversational filler phrases, and filtering stop words.
 */
export function normalizeVietnamese(text: string): string {
  if (!text || typeof text !== 'string') return '';

  let cleaned = text
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()?'"“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  for (const phrase of FILLER_PHRASES) {
    cleaned = cleaned.split(phrase).join(' ');
  }

  const tokens = cleaned
    .split(/\s+/)
    .filter((word) => word.length > 0 && !VIETNAMESE_STOP_WORDS.has(word));

  return tokens.length > 0 ? tokens.join(' ') : cleaned.replace(/\s+/g, ' ').trim();
}

/**
 * Smart Guardrails: Intent Classifier.
 * Classifies input into DYNAMIC_REALTIME, STATIC_KNOWLEDGE, or LOW_QUALITY_OR_AMBIGUOUS.
 */
export function classifyQueryIntent(question: string): QueryIntent {
  if (!question || typeof question !== 'string') return 'LOW_QUALITY_OR_AMBIGUOUS';

  const raw = question.toLowerCase().trim();
  const unaccented = removeVietnameseAccents(raw);
  const normalized = normalizeVietnamese(raw);

  // Check 1: Low quality / greeting / too short
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 && raw.length < 8) {
    return 'LOW_QUALITY_OR_AMBIGUOUS';
  }

  const greetings = ['alo', 'xin chao', 'chao em', 'chao ban', 'hello', 'hi', 'test', 'ok', 'cam on', 'thank'];
  if (greetings.some((g) => unaccented === g || unaccented.startsWith(g + ' '))) {
    return 'LOW_QUALITY_OR_AMBIGUOUS';
  }

  // Check 2: Define Patterns
  const timePatterns = [
    /\bhôm nay\b/i, /\bhom nay\b/i,
    /\bhôm qua\b/i, /\bhom qua\b/i,
    /\bbây giờ\b/i, /\bbay gio\b/i,
    /\bhiện tại\b/i, /\bhien tai\b/i,
    /\bvừa xong\b/i, /\bvua xong\b/i,
    /\bvừa rồi\b/i, /\bvua roi\b/i,
    /\bmới nhất\b/i, /\bmoi nhat\b/i,
    /\bgần đây\b/i, /\bgan day\b/i,
    /\btuần này\b/i, /\btuan nay\b/i,
    /\btuần trước\b/i, /\btuan truoc\b/i,
    /\btháng này\b/i, /\bthang nay\b/i,
    /\btháng trước\b/i, /\bthang truoc\b/i,
    /\btháng sau\b/i, /\bthang sau\b/i,
    /\bnăm nay\b/i, /\bnam nay\b/i,
    /\bngày mấy\b/i, /\bngay may\b/i,
    /\bmấy giờ\b/i, /\bmay gio\b/i,
    /\btháng\s*\d{1,2}\b/i, /\bthang\s*\d{1,2}\b/i,
    /\b\d+\s*(ngày|ngay|tuần|tuan|tháng|thang)\s*(qua|trước|truoc|gần đây|gan day)?\b/i,
    /\b7\s*ngày\b/i, /\b7\s*ngay\b/i,
    /\b30\s*ngày\b/i, /\b30\s*ngay\b/i,
    /\bdữ liệu thế\b/i, /\bdu lieu the\b/i,
    /\btình hình kinh tế\b/i, /\btinh hinh kinh te\b/i,
    /\btổng hợp tình hình\b/i, /\btong hop tinh hinh\b/i,
    /\btổng quan\b/i, /\btong quan\b/i,
  ];

  const metricPatterns = [
    /\bdoanh thu\b/i, /\bdoanh so\b/i, /\bdoanh số\b/i,
    /\blợi nhuận\b/i, /\bloi nhuan\b/i,
    /\btiền lãi\b/i, /\btien lai\b/i,
    /\blãi gộp\b/i, /\blai gop\b/i,
    /\bbiên lợi nhuận\b/i, /\bbien loi nhuan\b/i,
    /\bgiá vốn\b/i, /\bgia von\b/i,
    /\bvốn đọng\b/i, /\bvon dong\b/i,
    /\bcòn bao nhiêu\b/i, /\bcon bao nhieu\b/i,
    /\bvừa bán\b/i, /\bvua ban\b/i,
    /\bđơn hàng\b/i, /\bdon hang\b/i,
    /\bhóa đơn\b/i, /\bhoa don\b/i,
    /\bđơn mới\b/i, /\bdon moi\b/i,
    /\bbán chạy\b/i, /\bban chay\b/i, /\bbón chạy\b/i, /\bbon chay\b/i,
    /\bhết hàng\b/i, /\bhet hang\b/i,
    /\bhàng hết\b/i, /\bhang het\b/i,
    /\bsắp hết\b/i, /\bsap het\b/i,
    /\bhàng sắp hết\b/i, /\bhang sap het\b/i,
    /\bsắp hết hàng\b/i, /\bsap het hang\b/i,
    /\btồn kho\b/i, /\bton kho\b/i,
    /\bquản lý kho\b/i, /\bquan ly kho\b/i,
    /\bthông tin kho\b/i, /\bthong tin kho\b/i,
    /\btình trạng kho\b/i, /\btinh trang kho\b/i,
    /\bkho hàng\b/i, /\bkho hang\b/i,
    /\btổng kho\b/i, /\btong kho\b/i,
    /\btầm kho\b/i, /\btam kho\b/i,
    /\btồn nhiều\b/i, /\bton nhieu\b/i,
    /\bnhiều tồn\b/i, /\bnhieu ton\b/i,
    /\btồn thấp\b/i, /\bton thap\b/i,
    /\bgiá trị tồn\b/i, /\bgia tri ton\b/i,
    /\btổng vốn trong kho\b/i, /\btong von trong kho\b/i,
    /\bứ đọng\b/i, /\bu dong\b/i,
    /\bcảnh báo\b/i, /\bcanh bao\b/i,
    /\brủi ro\b/i, /\brui ro\b/i,
    /\bnhập thêm\b/i, /\bnhap them\b/i,
    /\bcần nhập\b/i, /\bcan nhap\b/i,
    /\bbao nhiêu sản phẩm\b/i, /\bbao nhieu san pham\b/i,
    /\bnhân viên\b/i, /\bnhan vien\b/i,
    /\bnhân sự\b/i, /\bnhan su\b/i,
    /\bhiệu suất\b/i, /\bhieu suat\b/i,
    /\bthu ngân\b/i, /\bthu ngan\b/i,
    /\bthanh toán\b/i, /\bthanh toan\b/i,
    /\bpos\b/i,
    /\bkhách hàng\b/i, /\bkhach hang\b/i,
    /\bsp\d+\b/i,
    /\b(trong kho|còn hàng|con hang|còn ko|con ko|còn không|con khong)\b/i,
    /\b(gợi ý giá|goi y gia|đề xuất giá|de xuat gia|chờ duyệt|cho duyet|phê duyệt|phe duyet|tăng giá|tang gia|giảm giá|giam gia)\b/i,
    /\b(thừa hàng|thua hang|tồn nhiều|ton nhieu|nhiều tồn|nhieu ton|tồn thấp|ton thap|bán chậm|ban cham|chậm luân chuyển|cham luan chuyen)\b/i,
  ];

  // Check 2: Strong Static Guide / How-To indicators take precedence over isolated metric words
  // E.g. "Hướng dẫn xuất báo cáo tồn kho ra file excel" is a tutorial, not asking for live inventory balance.
  const guidePatterns = [
    /\b(cách|huong dan|hướng dẫn|làm thế nào|lam the nao|làm sao|lam sao|quy trình|quy trinh)\b/i,
    /(xuất|xuat|tải|tai).*(excel|file|báo cáo|bao cao)/i,
    /\b(xuất excel|xuat excel|báo cáo excel|bao cao excel|tải file|tai file|xuất file|xuat file)\b/i,
    /\b(cài đặt|cai dat|kết nối|ket noi|cấu hình|cau hinh|tích hợp|tich hop)\b/i,
    /\b(phân quyền|phan quyen|rbac|vai trò|vai tro|chức năng|chuc nang)\b/i,
    /\b(chính sách|chinh sach|công thức|cong thuc|luật thuế|luat thue)\b/i,
  ];

  const isGuide = guidePatterns.some((p) => p.test(raw) || p.test(unaccented));

  // If asking for a guide / tutorial, treat as static knowledge unless explicitly tied to live moments
  if (isGuide) {
    const hasLiveMoment = [
      /\bhôm nay\b/i, /\bhom nay\b/i,
      /\bbây giờ\b/i, /\bbay gio\b/i,
      /\bvừa xong\b/i, /\bvua xong\b/i,
    ].some((p) => p.test(raw) || p.test(unaccented));

    if (!hasLiveMoment) {
      return 'STATIC_KNOWLEDGE';
    }
  }

  for (const pattern of timePatterns) {
    if (pattern.test(raw) || pattern.test(unaccented)) return 'DYNAMIC_REALTIME';
  }
  for (const pattern of metricPatterns) {
    if (pattern.test(raw) || pattern.test(unaccented)) return 'DYNAMIC_REALTIME';
  }

  return 'STATIC_KNOWLEDGE';
}
export function isDynamicStoreQuery(question: string): boolean {
  return classifyQueryIntent(question) === 'DYNAMIC_REALTIME';
}

/**
 * Calculates Jaccard Word Similarity between two texts: |A ∩ B| / |A ∪ B|.
 */
export function calculateJaccardSimilarity(textA: string, textB: string): number {
  const wordsA = new Set(textA.split(/\s+/).filter(Boolean));
  const wordsB = new Set(textB.split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 && wordsB.size === 0) return 1.0;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  const jaccard = union === 0 ? 0 : intersection / union;
  const minSize = Math.min(wordsA.size, wordsB.size);
  const overlap = minSize === 0 ? 0 : intersection / minSize;

  return 0.6 * jaccard + 0.4 * overlap;
}

/**
 * Calculates Character Bigram Dice's Coefficient.
 */
export function calculateDiceCoefficient(textA: string, textB: string): number {
  const cleanA = textA.replace(/\s+/g, '');
  const cleanB = textB.replace(/\s+/g, '');

  if (cleanA === cleanB) return 1.0;
  if (cleanA.length < 2 || cleanB.length < 2) {
    return cleanA === cleanB ? 1.0 : 0;
  }

  const bigramsA = new Set<string>();
  for (let i = 0; i < cleanA.length - 1; i++) {
    bigramsA.add(cleanA.slice(i, i + 2));
  }

  const bigramsB = new Set<string>();
  for (let i = 0; i < cleanB.length - 1; i++) {
    bigramsB.add(cleanB.slice(i, i + 2));
  }

  if (bigramsA.size === 0 && bigramsB.size === 0) return 1.0;
  if (bigramsA.size === 0 || bigramsB.size === 0) return 0;

  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }

  return (2 * intersection) / (bigramsA.size + bigramsB.size);
}

/**
 * Computes unaccented similarity by combining unaccented Jaccard and unaccented Dice.
 */
export function calculateUnaccentedSimilarity(textA: string, textB: string): number {
  const unaccentA = removeVietnameseAccents(textA);
  const unaccentB = removeVietnameseAccents(textB);
  const jaccard = calculateJaccardSimilarity(unaccentA, unaccentB);
  const dice = calculateDiceCoefficient(unaccentA, unaccentB);
  return (jaccard + dice) / 2;
}

/**
 * Computes Hybrid Lexical Similarity matching the specification:
 * - 50% Jaccard Word Similarity
 * - 30% Character Bigram / Dice's Coefficient
 * - 20% Unaccented Similarity
 */
export function calculateHybridSimilarity(queryA: string, queryB: string): {
  score: number;
  breakdown: { jaccard: number; dice: number; unaccented: number };
} {
  const normA = normalizeVietnamese(queryA);
  const normB = normalizeVietnamese(queryB);

  const unaccentA = removeVietnameseAccents(normA);
  const unaccentB = removeVietnameseAccents(normB);

  const isAUnaccented = removeVietnameseAccents(queryA) === queryA;
  const isBUnaccented = removeVietnameseAccents(queryB) === queryB;
  const compareUnaccentedDomain = isAUnaccented || isBUnaccented;

  const jaccard = compareUnaccentedDomain
    ? calculateJaccardSimilarity(unaccentA, unaccentB)
    : calculateJaccardSimilarity(normA, normB);

  const dice = compareUnaccentedDomain
    ? calculateDiceCoefficient(unaccentA, unaccentB)
    : calculateDiceCoefficient(normA, normB);

  const unaccented = calculateUnaccentedSimilarity(normA, normB);

  // Token inclusion ratio (Độ bao phủ câu hỏi ngắn trong câu hỏi dài của Vault)
  const tokensA = (compareUnaccentedDomain ? unaccentA : normA).split(/\s+/).filter(Boolean);
  const setB = new Set((compareUnaccentedDomain ? unaccentB : normB).split(/\s+/).filter(Boolean));
  const matchedTokens = tokensA.filter((t) => setB.has(t)).length;
  const inclusion = tokensA.length >= 2 ? matchedTokens / tokensA.length : 0;

  const standardScore = 0.5 * jaccard + 0.3 * dice + 0.2 * unaccented;
  const score = Math.max(standardScore, inclusion >= 0.85 ? inclusion * 0.95 : 0);

  return {
    score: Math.min(1.0, Math.max(0, score)),
    breakdown: { jaccard, dice, unaccented },
  };
}

function resolveKnowledgeFilePath(): string {
  const candidate1 = path.resolve(process.cwd(), 'data/ai-knowledge.json');
  const candidate2 = path.resolve(process.cwd(), 'backend/data/ai-knowledge.json');
  const candidate3 = path.resolve(__dirname, '../../../data/ai-knowledge.json');

  if (fs.existsSync(candidate1)) return candidate1;
  if (fs.existsSync(candidate2)) return candidate2;
  if (fs.existsSync(candidate3)) return candidate3;

  return process.cwd().endsWith('backend') ? candidate1 : candidate2;
}

/**
 * Enterprise Hybrid Vector & Self-Learning Memory Service.
 * - Tier 1: In-Memory Hot Cache (~1ms, top ~500 FAQ items)
 * - Tier 2: 50GB-100GB Disk Vault via SQLite WAL & FTS5 (5-15ms)
 * - Vector Embeddings: 768-dim Google Gemini Dense Vector + Cosine Similarity
 * - Blended Scoring: 0.65 * Vector + 0.35 * Lexical (with 100% graceful offline fallback)
 * - Smart Guardrails: Intent Classification (Dynamic vs Static vs Ambiguous)
 * - Atomic File Write & Debounce Queue
 * - Background Vector Backfill & Storage Quota Guard
 */
export class AiMemoryService {
  private readonly filePath: string;
  private readonly items: Map<string, KnowledgeItem> = new Map();
  private isSaving = false;
  private pendingSave = false;
  private saveDebounceTimer: NodeJS.Timeout | null = null;
  private isBackfilling = false;

  constructor(customFilePath?: string) {
    this.filePath = customFilePath || resolveKnowledgeFilePath();
    this.loadKnowledgeSync();
    // Launch non-blocking background vector backfill
    this.scheduleBackgroundBackfill();
  }

  private loadKnowledgeSync(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(this.filePath, JSON.stringify([], null, 2), 'utf-8');
        return;
      }

      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed: KnowledgeItem[] = JSON.parse(raw);
      this.items.clear();

      let sanitizedCount = 0;
      for (const item of parsed) {
        if (item && item.id && item.question && item.answer) {
          if (!item.normalizedQuestion) {
            item.normalizedQuestion = normalizeVietnamese(item.question);
          }

          // Smart Guardrail Sanitization: Purge dynamically learned queries that slipped in
          const intent = classifyQueryIntent(item.question);
          const containsLiveMoney = /(?:\d{1,3}(?:\.\d{3})+|\d+)\s*(?:đ|vnd|triệu|nghìn)/i.test(item.answer);
          const isStaleLearned = item.id.startsWith('learned-') && (intent === 'DYNAMIC_REALTIME' || containsLiveMoney);

          if (isStaleLearned) {
            sanitizedCount++;
            if (aiVaultService.isReady()) {
              aiVaultService.delete(item.id);
            }
            continue;
          }

          this.items.set(item.id, item);

          // Seed into SQLite Vault if available
          if (aiVaultService.isReady()) {
            aiVaultService.insert({
              id: item.id,
              question: item.question,
              normalizedQuestion: item.normalizedQuestion,
              answer: item.answer,
              category: item.category,
              keywords: item.keywords,
              embedding: item.embedding,
            });
          }
        }
      }

      if (sanitizedCount > 0) {
        logger.info('ai_memory_sanitized_stale_learned_items', { count: sanitizedCount });
        this.saveKnowledge().catch(() => {});
      }

      logger.info('ai_memory_hot_cache_loaded', { count: this.items.size, path: this.filePath });
    } catch (err) {
      logger.error('ai_memory_load_failed', { path: this.filePath, error: err });
    }
  }

  /**
   * Atomic File Save with Debounce Queue:
   * Writes to a temporary file, then performs atomic rename.
   */
  async saveKnowledge(): Promise<void> {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }

    return new Promise((resolve) => {
      this.saveDebounceTimer = setTimeout(async () => {
        if (this.isSaving) {
          this.pendingSave = true;
          resolve();
          return;
        }

        this.isSaving = true;
        try {
          const dir = path.dirname(this.filePath);
          await fs.promises.mkdir(dir, { recursive: true });

          const tmpFile = `${this.filePath}.tmp.${Date.now()}`;
          const data = JSON.stringify(Array.from(this.items.values()), null, 2);

          await fs.promises.writeFile(tmpFile, data, 'utf-8');
          await fs.promises.rename(tmpFile, this.filePath);
        } catch (err) {
          logger.error('ai_memory_atomic_save_failed', { error: err });
        } finally {
          this.isSaving = false;
          if (this.pendingSave) {
            this.pendingSave = false;
            this.saveKnowledge().catch(() => {});
          }
          resolve();
        }
      }, 300);
    });
  }

  /**
   * 3-Tier Multi-Tier Lookup:
   * 1. Smart Guardrails: Reject dynamic realtime queries immediately.
   * 2. Tier 1 (Hot RAM Cache - ~1ms): Hybrid Vector (65%) + Lexical (35%).
   * 3. Tier 2 (Disk SQLite 50GB-100GB Vault - 5-15ms): FTS5 + BLOB Vector scan.
   * 4. Offline/Degraded Fallback: 100% Lexical matching if vector API drops.
   */
  async findSimilarAnswer(question: string, threshold = 0.78): Promise<MemorySearchResult | null> {
    if (!question || typeof question !== 'string') return null;

    // Guardrail: Skip dynamic / real-time queries immediately
    const intent = classifyQueryIntent(question);
    if (intent === 'DYNAMIC_REALTIME') {
      return null;
    }

    const start = performance.now();

    // Generate query embedding in parallel (with 3500ms timeout)
    const queryEmbedding = await vectorEmbeddingService.generateEmbedding(question).catch(() => null);

    // ==========================================
    // TIER 1: In-Memory Hot Cache (~1ms)
    // ==========================================
    let bestMatch: MemorySearchResult | null = null;
    let highestScore = -1;

    for (const item of this.items.values()) {
      const lexicalQ = calculateHybridSimilarity(question, item.question);
      const lexicalNorm = calculateHybridSimilarity(question, item.normalizedQuestion);
      const lexicalScore = Math.max(lexicalQ.score, lexicalNorm.score);
      const breakdown = lexicalQ.score >= lexicalNorm.score ? lexicalQ.breakdown : lexicalNorm.breakdown;

      let finalScore = lexicalScore;
      let cosine: number | undefined;

      if (queryEmbedding && item.embedding && item.embedding.length > 0) {
        cosine = cosineSimilarity(queryEmbedding, item.embedding);
        // Blended Hybrid Score: 65% Dense Vector + 35% Lexical
        finalScore = 0.65 * cosine + 0.35 * lexicalScore;
      }

      if (finalScore > highestScore) {
        highestScore = finalScore;
        bestMatch = {
          item,
          score: finalScore,
          source: queryEmbedding && item.embedding ? 'RAM_HOT_CACHE_HYBRID' : 'RAM_HOT_CACHE_LEXICAL',
          breakdown: {
            ...breakdown,
            cosine,
          },
        };
      }
    }

    if (bestMatch && highestScore >= threshold) {
      bestMatch.item.hitCount += 1;
      bestMatch.item.updatedAt = new Date().toISOString();
      this.saveKnowledge().catch(() => {});
      logger.debug('ai_memory_hot_cache_hit', {
        score: highestScore,
        source: bestMatch.source,
        elapsedMs: Math.round(performance.now() - start),
      });
      return bestMatch;
    }

    // ==========================================
    // TIER 2: Massive 50GB-100GB SQLite Vault (5-15ms)
    // ==========================================
    if (aiVaultService.isReady()) {
      const lexicalFn = (q1: string, q2: string) => calculateHybridSimilarity(q1, q2).score;
      const vaultMatch: VaultSearchResult | null = aiVaultService.searchHybrid(
        question,
        queryEmbedding,
        lexicalFn,
        threshold
      );

      if (vaultMatch) {
        logger.debug('ai_memory_vault_hit', {
          score: vaultMatch.score,
          source: vaultMatch.source,
          elapsedMs: Math.round(performance.now() - start),
        });

        return {
          item: {
            id: vaultMatch.item.id,
            question: vaultMatch.item.question,
            normalizedQuestion: vaultMatch.item.normalizedQuestion,
            answer: vaultMatch.item.answer,
            category: (vaultMatch.item.category as 'static_faq' | 'general') || 'general',
            keywords: vaultMatch.item.keywords,
            hitCount: vaultMatch.item.hitCount,
            createdAt: vaultMatch.item.createdAt,
            updatedAt: vaultMatch.item.updatedAt,
          },
          score: vaultMatch.score,
          source: vaultMatch.source === 'VAULT_VECTOR_HYBRID' ? 'VAULT_VECTOR_HYBRID' : 'VAULT_FTS_LEXICAL',
          breakdown: {
            jaccard: vaultMatch.score,
            dice: vaultMatch.score,
            unaccented: vaultMatch.score,
            cosine: vaultMatch.cosineScore,
          },
        };
      }
    }

    return null;
  }

  /**
   * Resilient fallback search with lowered threshold (default 55%) for when Cloud LLM fails.
   */
  async findFallbackAnswer(question: string, threshold = 0.55): Promise<MemorySearchResult | null> {
    return this.findSimilarAnswer(question, threshold);
  }

  /**
   * Auto-Learn Loop:
   * Saves newly answered Q&A into SQLite Vault and (if high value) Hot Cache.
   */
  async learn(
    question: string,
    answer: string,
    category: 'static_faq' | 'general' = 'general'
  ): Promise<KnowledgeItem | null> {
    if (!question || !answer || typeof question !== 'string' || typeof answer !== 'string') {
      return null;
    }

    // Guardrail: Never learn dynamic realtime queries or ambiguous/error messages
    const intent = classifyQueryIntent(question);
    if (intent === 'DYNAMIC_REALTIME' || intent === 'LOW_QUALITY_OR_AMBIGUOUS') {
      return null;
    }

    if (answer.trim().length < 15 || /xin lỗi|lỗi hệ thống|không thể xử lý/i.test(answer)) {
      return null;
    }

    // Additional Guardrail: If answer contains dynamic currency amounts, warehouse metrics, or staff lists, do NOT save as permanent knowledge
    const containsLiveMoney = /(?:\d{1,3}(?:\.\d{3})+|\d+)\s*(?:đ|vnd|triệu|nghìn)/i.test(answer);
    const containsWarehouseMetrics = /(?:hết hàng|sắp hết hàng|tồn nhiều|vốn trong kho|giá trị tồn kho|sản phẩm vật lý)/i.test(answer);
    const containsStaffList = /(?:nhân sự:|chủ shop|nhân viên - tạm khóa)/i.test(answer);
    if (containsLiveMoney || containsWarehouseMetrics || containsStaffList) {
      return null;
    }

    const normalized = normalizeVietnamese(question);

    // Generate 768-dim Vector Embedding for newly learned knowledge
    const embedding = await vectorEmbeddingService.generateEmbedding(question).catch(() => null);

    const newItem: KnowledgeItem = {
      id: `learned-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      question: question.trim(),
      normalizedQuestion: normalized,
      answer: answer.trim(),
      category,
      embedding: embedding || undefined,
      hitCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // 1. Save to SQLite Vault (50GB-100GB Massive Storage)
    if (aiVaultService.isReady()) {
      aiVaultService.insert({
        id: newItem.id,
        question: newItem.question,
        normalizedQuestion: newItem.normalizedQuestion,
        answer: newItem.answer,
        category: newItem.category,
        embedding: newItem.embedding,
      });
      // Check storage quota guard
      aiVaultService.enforceStorageQuota();
    }

    // 2. If static FAQ or Hot Cache has room (< 500 items), keep in RAM Hot Cache
    if (category === 'static_faq' || this.items.size < 500) {
      this.items.set(newItem.id, newItem);
      this.saveKnowledge().catch(() => {});
    }

    logger.info('ai_memory_learned_knowledge', {
      id: newItem.id,
      question: newItem.question,
      hasVector: Boolean(embedding),
      category,
    });

    return newItem;
  }

  /**
   * Background Vector Backfill:
   * Generates 768-dim embeddings for existing static FAQ items that lack them.
   */
  private scheduleBackgroundBackfill(): void {
    if (process.env.NODE_ENV === 'test') return;

    setTimeout(async () => {
      if (this.isBackfilling) return;
      this.isBackfilling = true;

      try {
        let updatedCount = 0;
        for (const item of this.items.values()) {
          if (!item.embedding || item.embedding.length !== 768) {
            const vec = await vectorEmbeddingService.generateEmbedding(item.question);
            if (vec && vec.length === 768) {
              item.embedding = vec;
              updatedCount++;

              if (aiVaultService.isReady()) {
                aiVaultService.insert({
                  id: item.id,
                  question: item.question,
                  normalizedQuestion: item.normalizedQuestion,
                  answer: item.answer,
                  category: item.category,
                  keywords: item.keywords,
                  embedding: vec,
                });
              }

              // Polite delay between Gemini Embedding API calls
              await new Promise((r) => setTimeout(r, 250));
            }
          }
        }

        if (updatedCount > 0) {
          await this.saveKnowledge();
          logger.info('ai_memory_embeddings_backfilled', { updatedCount });
        }
      } catch (err) {
        logger.warn('ai_memory_backfill_failed', { error: err });
      } finally {
        this.isBackfilling = false;
      }
    }, 2000);
  }

  getAllKnowledge(): KnowledgeItem[] {
    return Array.from(this.items.values());
  }

  getKnowledgeCount(): number {
    return this.items.size;
  }
}

export const aiMemoryService = new AiMemoryService();
