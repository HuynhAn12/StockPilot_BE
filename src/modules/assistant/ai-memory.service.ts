import fs from 'fs';
import path from 'path';
import { logger } from '../../common/logger';

export interface KnowledgeItem {
  id: string;
  question: string;
  normalizedQuestion: string;
  answer: string;
  category: 'static_faq' | 'general';
  hitCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemorySearchResult {
  item: KnowledgeItem;
  score: number;
  breakdown: {
    jaccard: number;
    dice: number;
    unaccented: number;
  };
}

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
 * E.g.: "kết nối máy quét" -> "ket noi may quet"
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
 * Checks whether a question is asking for real-time / dynamic store context.
 * Dynamic queries must never be answered with stale cache and must never be persisted as static knowledge.
 */
export function isDynamicStoreQuery(question: string): boolean {
  if (!question || typeof question !== 'string') return false;
  const raw = question.toLowerCase().trim();
  const unaccented = removeVietnameseAccents(raw);

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
    /\bthống tóm\b/i, /\bthang tam\b/i,
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
    /\bđơn hàng mới\b/i, /\bdon hang moi\b/i,
    /\bbán chạy\b/i, /\bban chay\b/i, /\bbón chạy\b/i, /\bbon chay\b/i,
    /\bhết hàng\b/i, /\bhet hang\b/i,
    /\bsắp hết\b/i, /\bsap het\b/i,
    /\btồn kho\b/i, /\bton kho\b/i,
    /\bứ đọng\b/i, /\bu dong\b/i,
    /\bcảnh báo\b/i, /\bcanh bao\b/i,
    /\brủi ro\b/i, /\brui ro\b/i,
    /\bnhập thêm\b/i, /\bnhap them\b/i,
    /\bcần nhập\b/i, /\bcan nhap\b/i,
  ];

  for (const pattern of timePatterns) {
    if (pattern.test(raw) || pattern.test(unaccented)) return true;
  }
  for (const pattern of metricPatterns) {
    if (pattern.test(raw) || pattern.test(unaccented)) return true;
  }

  return false;
}

/**
 * Calculates Jaccard Word Similarity between two texts: |A ∩ B| / |A ∪ B|.
 * Blends with Overlap Coefficient (|A ∩ B| / min(|A|, |B|)) so short queries that are
 * subsets of a longer FAQ title are appropriately matched.
 */
export function calculateJaccardSimilarity(textA: string, textB: string): number {
  const wordsA = new Set(textA.split(/\s+/).filter(Boolean));
  const wordsB = new Set(textB.split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 && wordsB.size === 0) return 1.0;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) {
      intersection++;
    }
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  const jaccard = union === 0 ? 0 : intersection / union;
  const minSize = Math.min(wordsA.size, wordsB.size);
  const overlap = minSize === 0 ? 0 : intersection / minSize;

  return 0.6 * jaccard + 0.4 * overlap;
}

/**
 * Calculates Character Bigram Dice's Coefficient: 2 * |Bigrams(A) ∩ Bigrams(B)| / (|Bigrams(A)| + |Bigrams(B)|).
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
    if (bigramsB.has(bg)) {
      intersection++;
    }
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
 * Computes Hybrid Similarity matching the specification:
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

  // If one query has no accents (user typed non-accented text), compare in unaccented domain
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

  const score = 0.5 * jaccard + 0.3 * dice + 0.2 * unaccented;

  return {
    score: Math.min(1.0, Math.max(0, score)),
    breakdown: { jaccard, dice, unaccented },
  };
}

/**
 * Resolves the absolute path to `backend/data/ai-knowledge.json` dynamically across dev/prod environments.
 */
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
 * AI Memory Service (Self-Learning Semantic Cache).
 * - Fast in-memory lookup (< 5ms)
 * - Persistent async JSON storage in `backend/data/ai-knowledge.json`
 * - Vietnamese NLP with Hybrid Similarity (Jaccard 50%, Dice 30%, Unaccented 20%)
 * - Smart real-time metric bypass filter
 * - High-confidence lookup (>= 75%) and resilient offline fallback (>= 55%)
 */
export class AiMemoryService {
  private readonly filePath: string;
  private readonly items: Map<string, KnowledgeItem> = new Map();
  private isSaving = false;
  private pendingSave = false;

  constructor(customFilePath?: string) {
    this.filePath = customFilePath || resolveKnowledgeFilePath();
    this.loadKnowledgeSync();
  }

  /**
   * Loads knowledge synchronously during initialization so cache is immediately ready on startup.
   */
  private loadKnowledgeSync(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(this.filePath, JSON.stringify([], null, 2), 'utf-8');
        logger.info('ai_memory_initialized_empty', { path: this.filePath });
        return;
      }

      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed: KnowledgeItem[] = JSON.parse(raw);
      this.items.clear();

      for (const item of parsed) {
        if (item && item.id && item.question && item.answer) {
          if (!item.normalizedQuestion) {
            item.normalizedQuestion = normalizeVietnamese(item.question);
          }
          this.items.set(item.id, item);
        }
      }

      logger.info('ai_memory_loaded', { count: this.items.size, path: this.filePath });
    } catch (err) {
      logger.error('ai_memory_load_failed', { path: this.filePath, error: err });
    }
  }

  /**
   * Asynchronously saves current in-memory items to JSON without blocking the event loop.
   */
  async saveKnowledge(): Promise<void> {
    if (this.isSaving) {
      this.pendingSave = true;
      return;
    }

    this.isSaving = true;
    try {
      const dir = path.dirname(this.filePath);
      await fs.promises.mkdir(dir, { recursive: true });
      const data = JSON.stringify(Array.from(this.items.values()), null, 2);
      await fs.promises.writeFile(this.filePath, data, 'utf-8');
    } catch (err) {
      logger.error('ai_memory_save_failed', { path: this.filePath, error: err });
    } finally {
      this.isSaving = false;
      if (this.pendingSave) {
        this.pendingSave = false;
        await this.saveKnowledge();
      }
    }
  }

  /**
   * Finds a cached answer for a question if similarity is >= threshold (default 75%).
   * Bypasses immediately if question asks for dynamic / realtime store metrics.
   */
  async findSimilarAnswer(question: string, threshold = 0.75): Promise<MemorySearchResult | null> {
    if (!question || typeof question !== 'string') return null;

    // Filter dynamic store questions (do not serve stale cache for live figures)
    if (isDynamicStoreQuery(question)) {
      return null;
    }

    const start = performance.now();
    let bestMatch: MemorySearchResult | null = null;
    let highestScore = -1;

    for (const item of this.items.values()) {
      // Compare with both raw question and normalized question to get optimal score
      const simQuestion = calculateHybridSimilarity(question, item.question);
      const simNormalized = calculateHybridSimilarity(question, item.normalizedQuestion);

      const maxScore = Math.max(simQuestion.score, simNormalized.score);
      const bestBreakdown = simQuestion.score >= simNormalized.score ? simQuestion.breakdown : simNormalized.breakdown;

      if (maxScore > highestScore) {
        highestScore = maxScore;
        bestMatch = {
          item,
          score: maxScore,
          breakdown: bestBreakdown,
        };
      }
    }

    const elapsedMs = performance.now() - start;

    if (bestMatch && highestScore >= threshold) {
      // Increment hit count in memory and persist asynchronously
      bestMatch.item.hitCount += 1;
      bestMatch.item.updatedAt = new Date().toISOString();
      this.saveKnowledge().catch((err) => {
        logger.warn('ai_memory_persist_hit_failed', { error: err });
      });

      logger.debug('ai_memory_cache_hit_timing', { elapsedMs, score: highestScore, id: bestMatch.item.id });
      return bestMatch;
    }

    return null;
  }

  /**
   * Resilient fallback search with lowered threshold (default 55%) for when Gemini API fails.
   */
  async findFallbackAnswer(question: string, threshold = 0.55): Promise<MemorySearchResult | null> {
    return this.findSimilarAnswer(question, threshold);
  }

  /**
   * Automatically learns a new Q&A pair and persists it.
   * Skips learning if question is a dynamic realtime store query.
   */
  async learn(
    question: string,
    answer: string,
    category: 'static_faq' | 'general' = 'general'
  ): Promise<KnowledgeItem | null> {
    if (!question || !answer || typeof question !== 'string' || typeof answer !== 'string') {
      return null;
    }

    // Never learn dynamic store queries (prevent saving today's inventory/revenue as static truth)
    if (isDynamicStoreQuery(question)) {
      return null;
    }

    const normalized = normalizeVietnamese(question);
    if (normalized.length < 3) {
      return null;
    }

    // Check if an almost identical question already exists in memory
    for (const existing of this.items.values()) {
      const sim = calculateHybridSimilarity(question, existing.question);
      if (sim.score >= 0.90) {
        // Already known; refresh answer and timestamp
        existing.answer = answer.trim();
        existing.updatedAt = new Date().toISOString();
        this.saveKnowledge().catch((err) => logger.warn('ai_memory_save_failed', { err }));
        return existing;
      }
    }

    const newItem: KnowledgeItem = {
      id: `learned-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      question: question.trim(),
      normalizedQuestion: normalized,
      answer: answer.trim(),
      category,
      hitCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.items.set(newItem.id, newItem);
    logger.info('ai_memory_learned_new_item', { id: newItem.id, question: newItem.question, category });

    // Non-blocking asynchronous save
    this.saveKnowledge().catch((err) => {
      logger.warn('ai_memory_async_save_failed', { error: err });
    });

    return newItem;
  }

  getAllKnowledge(): KnowledgeItem[] {
    return Array.from(this.items.values());
  }

  getKnowledgeCount(): number {
    return this.items.size;
  }
}

/** Singleton instance exported for application-wide use */
export const aiMemoryService = new AiMemoryService();
