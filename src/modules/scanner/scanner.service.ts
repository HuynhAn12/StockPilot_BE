import { Response } from 'express';
import { prisma } from '../../config/db';
import { NotFoundError, ForbiddenError, ValidationError } from '../../common/errors/app-error';
import * as fs from 'fs';
import * as path from 'path';

// In-memory store: sessionCode → SSE client response objects
// Structure: Map<sessionCode, { res: Response, storeId: number }[]>
const sseClients = new Map<string, Array<{ res: Response; storeId: number }>>();

// In-memory store: sessionCode → session metadata
// Structure: Map<sessionCode, ScanSession>
interface ScanSession {
  code: string;
  storeId: number;
  userId: number;
  label?: string;
  createdAt: Date;
  expiresAt: Date;
  scanCount: number;
}
const activeSessions = new Map<string, ScanSession>();

// 30 ngày TTL — session tồn tại lâu dài, không cần ghép nối lại
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion

// ─── File persistence ────────────────────────────────────────────────────────
// Lưu sessions xuống file JSON để survive server restart
const SESSIONS_FILE = path.join(process.cwd(), 'data', 'scanner-sessions.json');

function ensureDataDir() {
  const dir = path.dirname(SESSIONS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function persistSessions() {
  try {
    ensureDataDir();
    const data = Array.from(activeSessions.values()).map((s) => ({
      ...s,
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
    }));
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[Scanner] Không thể lưu sessions:', err);
  }
}

function loadPersistedSessions() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return;
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8');
    const data: any[] = JSON.parse(raw);
    const now = new Date();
    let loaded = 0;
    for (const s of data) {
      const expiresAt = new Date(s.expiresAt);
      if (expiresAt > now) {
        activeSessions.set(s.code, {
          code: s.code,
          storeId: s.storeId,
          userId: s.userId,
          label: s.label,
          createdAt: new Date(s.createdAt),
          expiresAt,
          scanCount: s.scanCount || 0,
        });
        loaded++;
      }
    }
    if (loaded > 0) {
      console.log(`[Scanner] Đã khôi phục ${loaded} phiên ghép nối từ file`);
    }
  } catch (err) {
    console.warn('[Scanner] Không thể đọc file sessions:', err);
  }
}

// Khôi phục sessions ngay khi module load
loadPersistedSessions();

// ─────────────────────────────────────────────────────────────────────────────

function generateCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

// Clean expired sessions every 60 minutes
const cleanupInterval = setInterval(() => {
  const now = new Date();
  let changed = false;
  for (const [code, session] of activeSessions.entries()) {
    if (session.expiresAt < now) {
      activeSessions.delete(code);
      changed = true;
      // Close any lingering SSE clients
      const clients = sseClients.get(code);
      if (clients) {
        for (const client of clients) {
          try {
            client.res.write('event: expired\ndata: {"message":"Session expired"}\n\n');
            client.res.end();
          } catch (_error) {
            //
          }
        }
        sseClients.delete(code);
      }
    }
  }
  if (changed) persistSessions();
}, 60 * 60 * 1000);
cleanupInterval.unref?.();

export class ScannerService {
  /**
   * Create a new scan session for the requesting user.
   * Nếu store đã có session active → trả về session đó thay vì tạo mới.
   * TTL 30 ngày → không cần ghép nối lại thường xuyên.
   */
  async createSession(storeId: number, userId: number, label?: string): Promise<ScanSession> {
    // Verify store exists and is active
    const store = await prisma.store.findFirst({
      where: { id: storeId, isActive: true },
      select: { id: true },
    });
    if (!store) throw new NotFoundError('Store not found or inactive');

    // Nếu đã có session active cho store này → tái sử dụng
    const existing = this.listSessions(storeId)[0];
    if (existing) {
      return existing;
    }

    // Generate a unique code
    let code: string;
    let attempts = 0;
    do {
      code = generateCode();
      attempts++;
      if (attempts > 20) throw new ValidationError('Could not generate unique session code, try again');
    } while (activeSessions.has(code));

    const now = new Date();
    const session: ScanSession = {
      code,
      storeId,
      userId,
      label,
      createdAt: now,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      scanCount: 0,
    };

    activeSessions.set(code, session);
    persistSessions();
    return session;
  }

  /**
   * Get an active session by code, validating storeId ownership.
   */
  getSession(code: string, storeId: number): ScanSession {
    const session = activeSessions.get(code.toUpperCase());
    if (!session) throw new NotFoundError('Scan session not found or expired');
    if (session.storeId !== storeId) throw new ForbiddenError('Access denied to this scan session');
    if (session.expiresAt < new Date()) {
      activeSessions.delete(code);
      persistSessions();
      throw new NotFoundError('Scan session has expired');
    }
    return session;
  }

  /**
   * Find an active session by code (without requiring storeId upfront).
   */
  findActiveSession(code: string): ScanSession | null {
    const upper = code.toUpperCase().trim();
    const session = activeSessions.get(upper);
    if (!session) return null;
    if (session.expiresAt < new Date()) {
      activeSessions.delete(upper);
      persistSessions();
      return null;
    }
    return session;
  }

  /**
   * Register an SSE client (web browser) to listen for scan events on a session.
   */
  registerSseClient(code: string, storeId: number, res: Response): void {
    // Validate session first
    this.getSession(code, storeId);

    if (!sseClients.has(code)) {
      sseClients.set(code, []);
    }
    sseClients.get(code)!.push({ res, storeId });
  }

  /**
   * Remove an SSE client when connection is closed.
   */
  removeSseClient(code: string, res: Response): void {
    const clients = sseClients.get(code);
    if (!clients) return;
    const filtered = clients.filter((c) => c.res !== res);
    if (filtered.length === 0) {
      sseClients.delete(code);
    } else {
      sseClients.set(code, filtered);
    }
  }

  /**
   * Process a barcode scan from the mobile app.
   * Looks up the StockItem by barcode (scoped to store), then pushes SSE event to all web clients.
   */
  async processScan(code: string, barcode: string, scannerStoreId: number): Promise<{
    stockItemId: number;
    sku: string;
    name: string;
    sellingPrice: number;
    productName: string;
    productCode: string;
    barcode: string;
  }> {
    const session = this.getSession(code, scannerStoreId);

    // Look up stock item by barcode, scoped to store
    const stockItem = await prisma.stockItem.findFirst({
      where: {
        storeId: session.storeId,
        barcode: barcode.trim(),
        isActive: true,
        product: { isActive: true },
      },
      include: {
        product: {
          select: { id: true, name: true, code: true, imageUrl: true },
        },
      },
    });

    if (!stockItem) {
      // Also try lookup by SKU as fallback
      const bySku = await prisma.stockItem.findFirst({
        where: {
          storeId: session.storeId,
          sku: barcode.trim(),
          isActive: true,
          product: { isActive: true },
        },
        include: {
          product: {
            select: { id: true, name: true, code: true, imageUrl: true },
          },
        },
      });

      if (!bySku) {
        throw new NotFoundError(`Không tìm thấy sản phẩm với mã vạch: ${barcode}`);
      }

      // Use bySku result
      return this._pushAndReturn(session, code, bySku, barcode);
    }

    return this._pushAndReturn(session, code, stockItem, barcode);
  }

  private _pushAndReturn(
    session: ScanSession,
    code: string,
    stockItem: any,
    barcode: string
  ) {
    const payload = {
      stockItemId: stockItem.id,
      productId: stockItem.product?.id ?? stockItem.productId,
      sku: stockItem.sku,
      name: stockItem.name,
      sellingPrice: Number(stockItem.sellingPrice),
      productName: stockItem.product?.name ?? stockItem.name,
      productCode: stockItem.product?.code ?? stockItem.sku,
      imageUrl: stockItem.product?.imageUrl ?? null,
      barcode,
      scannedAt: new Date().toISOString(),
    };

    // Increment scan count
    session.scanCount += 1;

    // Push to all registered SSE clients for this session
    const clients = sseClients.get(code) ?? [];
    const deadClients: Response[] = [];

    for (const client of clients) {
      try {
        client.res.write(`event: scan\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch (_) {
        deadClients.push(client.res);
      }
    }

    // Clean up dead clients
    if (deadClients.length > 0) {
      const alive = clients.filter((c) => !deadClients.includes(c.res));
      if (alive.length === 0) {
        sseClients.delete(code);
      } else {
        sseClients.set(code, alive);
      }
    }

    return payload;
  }

  /**
   * Invalidate/close a scan session.
   */
  closeSession(code: string, storeId: number): void {
    const session = this.getSession(code, storeId);
    activeSessions.delete(session.code);
    persistSessions();

    const clients = sseClients.get(code) ?? [];
    for (const client of clients) {
      try {
        client.res.write('event: closed\ndata: {"message":"Session closed by host"}\n\n');
        client.res.end();
      } catch (_) {
        //ko co gi
      }
    }
    sseClients.delete(code);
  }

  /**
   * List active sessions for a store (for display in POS UI).
   */
  listSessions(storeId: number): ScanSession[] {
    const now = new Date();
    const result: ScanSession[] = [];
    for (const session of activeSessions.values()) {
      if (session.storeId === storeId && session.expiresAt > now) {
        result.push(session);
      }
    }
    return result;
  }
}

export const scannerService = new ScannerService();
