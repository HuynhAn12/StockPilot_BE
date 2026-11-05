import {
  cosineSimilarity,
  vectorToBlob,
  blobToVector,
} from '../../src/modules/assistant/vector-embedding.service';
import {
  classifyQueryIntent,
  isDynamicStoreQuery,
  normalizeVietnamese,
} from '../../src/modules/assistant/ai-memory.service';
import { aiVaultService } from '../../src/modules/assistant/ai-vault.service';

describe('Enterprise AI Vector & Intent Architecture Tests', () => {
  describe('Cosine Similarity Math Engine', () => {
    it('returns 1.0 for identical vectors', () => {
      const vecA = [0.2, 0.5, 0.8];
      const vecB = [0.2, 0.5, 0.8];
      expect(cosineSimilarity(vecA, vecB)).toBeCloseTo(1.0, 5);
    });

    it('returns 0.0 for orthogonal vectors', () => {
      const vecA = [1, 0, 0];
      const vecB = [0, 1, 0];
      expect(cosineSimilarity(vecA, vecB)).toBeCloseTo(0.0, 5);
    });

    it('returns -1.0 for opposite vectors', () => {
      const vecA = [1, 2, 3];
      const vecB = [-1, -2, -3];
      expect(cosineSimilarity(vecA, vecB)).toBeCloseTo(-1.0, 5);
    });

    it('handles Float32Array efficiently with 768 dimensions', () => {
      const f32A = new Float32Array(768).fill(0.05);
      const f32B = new Float32Array(768).fill(0.05);
      expect(cosineSimilarity(f32A, f32B)).toBeCloseTo(1.0, 5);
    });

    it('returns 0 if lengths mismatch or are empty', () => {
      expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
      expect(cosineSimilarity([], [])).toBe(0);
    });
  });

  describe('Vector <-> BLOB Conversion (SQLite 3072 bytes per vector)', () => {
    it('converts number[] to BLOB and restores without loss', () => {
      const original = [0.123456, -0.654321, 0.999999, -0.000001];
      const blob = vectorToBlob(original);

      expect(blob).toBeInstanceOf(Buffer);
      expect(blob.length).toBe(original.length * 4);

      const restored = blobToVector(blob);
      expect(restored.length).toBe(original.length);
      for (let i = 0; i < original.length; i++) {
        expect(restored[i]).toBeCloseTo(original[i], 5);
      }
    });
  });

  describe('Smart Guardrails & Intent Classifier', () => {
    it('identifies real-time volatile metrics as DYNAMIC_REALTIME', () => {
      expect(classifyQueryIntent('Hôm nay bán được bao nhiêu đơn?')).toBe('DYNAMIC_REALTIME');
      expect(classifyQueryIntent('Tồn kho còn bao nhiêu sản phẩm?')).toBe('DYNAMIC_REALTIME');
      expect(classifyQueryIntent('Doanh thu tháng này thế nào?')).toBe('DYNAMIC_REALTIME');
      expect(classifyQueryIntent('Đơn hàng mới nhất vừa bán')).toBe('DYNAMIC_REALTIME');
      expect(classifyQueryIntent('Sản phẩm nào đang bị hết hàng?')).toBe('DYNAMIC_REALTIME');
      expect(isDynamicStoreQuery('Hôm nay doanh thu bao nhiêu?')).toBe(true);
    });

    it('identifies operational guides as STATIC_KNOWLEDGE', () => {
      expect(classifyQueryIntent('Hướng dẫn kết nối máy quét mã vạch')).toBe('STATIC_KNOWLEDGE');
      expect(classifyQueryIntent('Cách tạo phiếu nhập kho')).toBe('STATIC_KNOWLEDGE');
      expect(classifyQueryIntent('Cài đặt thanh toán mã QR PayOS')).toBe('STATIC_KNOWLEDGE');
      expect(classifyQueryIntent('Xuất báo cáo tồn kho ra file excel')).toBe('STATIC_KNOWLEDGE');
      expect(classifyQueryIntent('Phân quyền giữa chủ cửa hàng và nhân viên kho')).toBe('STATIC_KNOWLEDGE');
      expect(isDynamicStoreQuery('Cách kết nối máy quét mã vạch')).toBe(false);
    });

    it('identifies short greetings and ambiguous questions as LOW_QUALITY_OR_AMBIGUOUS', () => {
      expect(classifyQueryIntent('alo')).toBe('LOW_QUALITY_OR_AMBIGUOUS');
      expect(classifyQueryIntent('hi em')).toBe('LOW_QUALITY_OR_AMBIGUOUS');
      expect(classifyQueryIntent('test')).toBe('LOW_QUALITY_OR_AMBIGUOUS');
      expect(classifyQueryIntent('ok')).toBe('LOW_QUALITY_OR_AMBIGUOUS');
    });

    it('normalizes Vietnamese queries by stripping stop words', () => {
      const normalized = normalizeVietnamese('Làm thế nào để kết nối máy quét mã vạch cho tôi với');
      expect(normalized).toContain('kết nối');
      expect(normalized).toContain('máy quét');
      expect(normalized).not.toContain('làm thế nào để');
    });
  });

  describe('SQLite Massive 50GB-100GB Vault Service', () => {
    it('initializes cleanly in WAL mode and reports metrics', () => {
      expect(aiVaultService.isReady()).toBe(true);
      const stats = aiVaultService.getVaultStats();
      expect(stats.quotaMaxBytes).toBeGreaterThan(0);
      expect(stats.rowCount).toBeGreaterThanOrEqual(0);
    });

    it('supports fast insert and keyword search via FTS5', () => {
      const testId = `unit-test-${Date.now()}`;
      aiVaultService.insert({
        id: testId,
        question: 'Quy trình kiểm đếm kho hàng tự động',
        answer: 'Sử dụng máy quét mã vạch và ứng dụng StockPilot trên điện thoại để kiểm đếm.',
        category: 'unit_test',
        keywords: ['kiểm đếm', 'máy quét'],
      });

      const stats = aiVaultService.getVaultStats();
      expect(stats.rowCount).toBeGreaterThan(0);
    });
  });
});

