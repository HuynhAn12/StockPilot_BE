import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../config/db';
import { generateAccessToken } from '../../common/utils/jwt';
import { scannerService } from './scanner.service';

export class ScannerController {
  /**
   * POST /api/v1/scanner/pair
   * Direct pairing endpoint: accepts a 6-character code generated on Web POS.
   * If valid and unexpired, returns a scoped token so the mobile device can immediately pair and scan.
   */
  async pairSession(req: Request, res: Response, next: NextFunction) {
    try {
      const code = (req.body?.code || '').toUpperCase().trim();
      if (!code || code.length !== 6) {
        return res.status(400).json({ success: false, error: { message: 'Vui lòng nhập đúng 6 ký tự mã ghép nối.' } });
      }

      const session = scannerService.findActiveSession(code);
      if (!session) {
        return res.status(404).json({ success: false, error: { message: 'Mã ghép nối không hợp lệ hoặc đã hết hạn.' } });
      }

      const store = await prisma.store.findUnique({
        where: { id: session.storeId },
        select: { id: true, name: true, code: true },
      });

      const user = await prisma.user.findUnique({
        where: { id: session.userId },
        select: { id: true, email: true, fullName: true, role: true, storeId: true },
      });

      const token = generateAccessToken({
        userId: session.userId,
        email: user?.email || 'scanner@stockpilot.vn',
        role: user?.role || 'WAREHOUSE_STAFF',
        storeId: session.storeId,
      });

      return res.status(200).json({
        success: true,
        data: {
          token,
          code: session.code,
          label: session.label,
          expiresAt: session.expiresAt,
          store: store || { id: session.storeId, name: 'Cửa hàng POS', code: 'STORE' },
          user: user || { id: session.userId, email: 'scanner@stockpilot.vn', fullName: 'Thiết bị quét', role: 'WAREHOUSE_STAFF' },
        },
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/scanner/sessions
   * Create a new pairing session. Returns the 6-char code.
   */
  async createSession(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId, storeId } = req.user!;
      if (!storeId) {
        return res.status(403).json({ success: false, error: { message: 'User is not associated with a store' } });
      }
      const label = req.body?.label as string | undefined;
      const session = await scannerService.createSession(storeId, userId, label);

      return res.status(201).json({
        success: true,
        data: {
          code: session.code,
          label: session.label,
          expiresAt: session.expiresAt,
          scanCount: session.scanCount,
        },
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/scanner/sessions
   * List active sessions for this store.
   */
  listSessions(req: Request, res: Response, next: NextFunction) {
    try {
      const { storeId } = req.user!;
      if (!storeId) {
        return res.status(403).json({ success: false, error: { message: 'User is not associated with a store' } });
      }
      const sessions = scannerService.listSessions(storeId);
      return res.json({
        success: true,
        data: sessions.map((s) => ({
          code: s.code,
          label: s.label,
          expiresAt: s.expiresAt,
          scanCount: s.scanCount,
          createdAt: s.createdAt,
        })),
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/scanner/sessions/:code
   * Check if a specific session is valid.
   */
  getSession(req: Request, res: Response, next: NextFunction) {
    try {
      const { storeId } = req.user!;
      if (!storeId) {
        return res.status(403).json({ success: false, error: { message: 'User is not associated with a store' } });
      }
      const { code } = req.params;
      const session = scannerService.getSession(code.toUpperCase(), storeId);
      return res.json({
        success: true,
        data: {
          code: session.code,
          label: session.label,
          expiresAt: session.expiresAt,
          scanCount: session.scanCount,
          createdAt: session.createdAt,
        },
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/scanner/sessions/:code/events
   * SSE endpoint — web browser subscribes here to receive scan events in real time.
   */
  subscribeToSession(req: Request, res: Response, next: NextFunction) {
    try {
      const { storeId } = req.user!;
      if (!storeId) {
        return res.status(403).json({ success: false, error: { message: 'User is not associated with a store' } });
      }
      const { code } = req.params;

      // Set SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
      res.flushHeaders();

      // Send initial connected event
      res.write(`event: connected\ndata: ${JSON.stringify({ code, message: 'Scanner session connected' })}\n\n`);

      // Register this SSE client
      scannerService.registerSseClient(code.toUpperCase(), storeId, res);

      // Send heartbeat every 25s to keep connection alive
      const heartbeat = setInterval(() => {
        try {
          res.write(': heartbeat\n\n');
        } catch (_) {
          clearInterval(heartbeat);
        }
      }, 25000);

      // Clean up when client disconnects
      req.on('close', () => {
        clearInterval(heartbeat);
        scannerService.removeSseClient(code.toUpperCase(), res);
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/scanner/sessions/:code/scan
   * Mobile app submits a scanned barcode. Backend looks up product and pushes to SSE clients.
   */
  async processScan(req: Request, res: Response, next: NextFunction) {
    try {
      const { storeId } = req.user!;
      if (!storeId) {
        return res.status(403).json({ success: false, error: { message: 'User is not associated with a store' } });
      }
      const { code } = req.params;
      const { barcode } = req.body;

      const result = await scannerService.processScan(code.toUpperCase(), barcode, storeId);

      return res.json({
        success: true,
        data: result,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * DELETE /api/v1/scanner/sessions/:code
   * Close/invalidate a scan session.
   */
  closeSession(req: Request, res: Response, next: NextFunction) {
    try {
      const { storeId } = req.user!;
      if (!storeId) {
        return res.status(403).json({ success: false, error: { message: 'User is not associated with a store' } });
      }
      const { code } = req.params;
      scannerService.closeSession(code.toUpperCase(), storeId);

      return res.json({ success: true, data: { message: 'Session closed' } });
    } catch (err) {
      return next(err);
    }
  }
}
