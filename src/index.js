// Webhook listener Luxuria Claude VPS — Dan 2026-06-11 noapte.
//
// Flow:
//   1. Supabase INSERT pe bug_reports → trigger pg_net.http_post → POST aici
//   2. Verificăm header `x-webhook-secret`
//   3. Citim bug-ul complet din Supabase (titlu + descriere + screenshot URL)
//   4. Apelăm Claude Agent SDK (mod ASCULTAR — propune fix, NU face PR)
//   5. Salvăm propunerea în `proposals/<bug-id>.md` + în Supabase `bug_reports.metadata.proposed_fix`
//   6. Trimitem ntfy push cu link `/aprobare/<bug-id>`
//   7. Dan deschide link, vede raport 7 puncte + diff propus, dă DA/NU
//   8. La DA: creăm PR draft pe GitHub
//   9. La NU: marcăm rejected în DB

import express from 'express';
import { handleBugWebhook } from './bug-handler.js';
import { renderApprovalPage, handleApproval } from './approval.js';
import { logInfo, logError } from './logger.js';

const app = express();
app.use(express.json({ limit: '5mb' }));

// --- Health check ---
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'luxuria-claude-vps',
    version: '0.1.0',
    mode: 'ASCULTAR',
    time: new Date().toISOString(),
  });
});

// --- Webhook bug nou (Supabase trigger) ---
app.post('/api/bug-nou', async (req, res) => {
  const secret = req.header('x-webhook-secret');
  if (!secret || secret !== process.env.WEBHOOK_SECRET) {
    logError('webhook unauthorized', { ip: req.ip });
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const result = await handleBugWebhook(req.body);
    res.json(result);
  } catch (err) {
    logError('webhook failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// --- Pagină aprobare (HTML cu raport 7 puncte + butoane DA/NU) ---
app.get('/aprobare/:bugId', async (req, res) => {
  try {
    const html = await renderApprovalPage(req.params.bugId);
    res.type('html').send(html);
  } catch (err) {
    logError('approval page render failed', { bugId: req.params.bugId, error: err.message });
    res.status(500).type('html').send(`<h1>Eroare</h1><p>${err.message}</p>`);
  }
});

// --- POST aprobare (click DA/NU) ---
app.post('/aprobare/:bugId/:action', async (req, res) => {
  const { bugId, action } = req.params;
  if (action !== 'da' && action !== 'nu') {
    return res.status(400).json({ error: 'invalid action — folosește da/nu' });
  }
  try {
    const result = await handleApproval(bugId, action);
    res.json(result);
  } catch (err) {
    logError('approval action failed', { bugId, action, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, '127.0.0.1', () => {
  logInfo(`luxuria-claude-vps started`, { port, mode: 'ASCULTAR' });
});
