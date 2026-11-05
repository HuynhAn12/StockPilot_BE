import { env } from '../../config/env';
import { logger } from '../../common/logger';

/**
 * Calculates Cosine Similarity between two dense vectors.
 * Returns a value between -1.0 and 1.0 (typically 0.0 to 1.0 for normalized text embeddings).
 * Pure TypeScript implementation, zero external dependencies, highly optimized.
 */
export function cosineSimilarity(
  vecA: number[] | Float32Array,
  vecB: number[] | Float32Array
): number {
  if (!vecA || !vecB || vecA.length === 0 || vecA.length !== vecB.length) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i];
    const b = vecB[i];
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Converts a JS number array into a compact binary Buffer (Float32Array) for SQLite BLOB storage.
 * 768 dimensions * 4 bytes = 3,072 bytes per vector.
 */
export function vectorToBlob(embedding: number[] | Float32Array): Buffer {
  const f32 = embedding instanceof Float32Array ? embedding : new Float32Array(embedding);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/**
 * Converts a binary Buffer back to a Float32Array for fast cosine similarity computation.
 */
export function blobToVector(blob: Buffer): Float32Array {
  const byteOffset = blob.byteOffset;
  const byteLength = blob.byteLength;
  return new Float32Array(blob.buffer.slice(byteOffset, byteOffset + byteLength));
}

export class VectorEmbeddingService {
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly targetDimensions = 768;

  constructor() {
    this.apiKey = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
    this.model = process.env.GEMINI_EMBEDDING_MODEL || 'models/gemini-embedding-001';
  }

  /**
   * Generates a 768-dimensional vector embedding for text using Google Gemini Embedding API.
   * Includes strict timeout protection (3500ms) and automatic fallback (returns null).
   */
  async generateEmbedding(text: string): Promise<number[] | null> {
    if (!text || typeof text !== 'string' || !this.apiKey) {
      return null;
    }

    const cleanText = text.replace(/\s+/g, ' ').trim().slice(0, 2048);
    if (cleanText.length < 2) {
      return null;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/${this.model}:embedContent?key=${this.apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          content: { parts: [{ text: cleanText }] },
          outputDimensionality: this.targetDimensions,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        logger.debug('gemini_embedding_failed', { status: response.status });
        return null;
      }

      const data = (await response.json()) as { embedding?: { values?: number[] } };
      const values = data?.embedding?.values;

      if (Array.isArray(values) && values.length === this.targetDimensions) {
        return values;
      }

      return null;
    } catch {
      // Abort or network drop - gracefully return null so Hybrid Search falls back to Lexical
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export const vectorEmbeddingService = new VectorEmbeddingService();

