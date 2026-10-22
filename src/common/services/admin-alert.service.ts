import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { logger } from '../logger';
import { sendPlatformEmail } from './email.service';

/**
 * Tells the platform team about events that need a human (new lead, new or answered support ticket).
 * Fire-and-forget: never throws and never delays the request that triggered it.
 */
export const AdminAlertService = {
  notify(subject: string, lines: string[], path: string) {
    if (env.NODE_ENV === 'test') return;
    void (async () => {
      try {
        const admins = await prisma.user.findMany({ where: { role: 'ADMIN', isActive: true }, select: { email: true } });
        const appUrl = (process.env.APP_PUBLIC_URL || process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');
        const link = `${appUrl}${path}`;
        await sendPlatformEmail({
          to: admins.map((a) => a.email),
          subject: `[StockPilot Admin] ${subject}`,
          text: [...lines, '', `Xem chi tiết: ${link}`].join('\n'),
        });
      } catch (err: any) {
        logger.warn('admin_alert_failed', { subject, message: err?.message });
      }
    })();
  },
};
