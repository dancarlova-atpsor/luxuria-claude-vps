// Trimite email via endpoint Luxuria production (foloseste Brevo deja configurat).
// VPS NU duplicheaza Brevo API key — apeleaza endpoint intern protejat cu secret.

import { logError, logInfo } from './logger.js';

export async function sendEmailViaLuxuria({ subject, body, to }) {
  const secret = process.env.VPS_NOTIFY_SECRET;
  if (!secret) {
    logError('VPS_NOTIFY_SECRET lipseste — email NU se trimite');
    return { ok: false, error: 'VPS_NOTIFY_SECRET missing' };
  }
  const luxuriaBase = process.env.LUXURIA_SITE_URL || 'https://luxuriatravel.ro';
  try {
    const res = await fetch(`${luxuriaBase}/api/internal/notify-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': secret,
      },
      body: JSON.stringify({ subject, body, to }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      logError('notify-email failed', { status: res.status, body: txt.slice(0, 200) });
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const j = await res.json().catch(() => ({}));
    logInfo('notify-email ok', { to: j.to });
    return { ok: true };
  } catch (err) {
    logError('notify-email fetch failed', { error: err.message });
    return { ok: false, error: err.message };
  }
}
