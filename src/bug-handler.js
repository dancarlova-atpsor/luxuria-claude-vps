// Bug handler — primește webhook, apelează Claude Agent, salvează propunerea, trimite ntfy.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getBug, updateBugStatus } from './supabase.js';
import { proposeBugFix } from './claude-agent.js';
import { createPrFromProposal, mergePr } from './github.js';
import { notify } from './ntfy.js';
import { sendEmailViaLuxuria } from './email.js';
import { logInfo, logWarn, logError } from './logger.js';

const CRITICAL_PATH_PREFIXES = [
  'src/lib/netopia/',
  'src/lib/smartbill/',
  'src/app/api/cron/',
  'src/app/api/internal/',
  'src/app/api/netopia/',
  'src/app/api/smartbill/',
  'src/app/api/webhook/',
  'middleware.ts',
  'next.config',
  '.env',
  'package.json',
  'pnpm-lock.yaml',
];

function shouldAutoMerge(bug, proposal, prResult) {
  const reasons = [];
  const severity = String(bug.severity ?? 'normal').toLowerCase();
  if (!['low', 'normal'].includes(severity)) reasons.push(`severity=${severity}`);
  if (prResult.is_placeholder) reasons.push('placeholder PR');
  if ((prResult.edits_applied ?? 0) === 0) reasons.push('0 edits aplicate');
  if ((prResult.edits_applied ?? 0) > 2) reasons.push(`${prResult.edits_applied} fișiere (max 2)`);
  if (prResult.edits_failed && prResult.edits_failed.length > 0) reasons.push(`${prResult.edits_failed.length} edits eșuate`);
  if (proposal.increderea !== 'alta') reasons.push(`incredere=${proposal.increderea}`);
  if (proposal.fix_tactic === true) reasons.push('fix_tactic=true');
  for (const e of proposal.edits ?? []) {
    if (CRITICAL_PATH_PREFIXES.some((prefix) => e.path.startsWith(prefix))) {
      reasons.push(`path critic: ${e.path}`);
    }
  }
  return { safe: reasons.length === 0, reasons };
}

const PROPOSALS_DIR = '/var/luxuria-claude/proposals';

function ensureProposalsDir() {
  try { mkdirSync(PROPOSALS_DIR, { recursive: true }); } catch {}
}

function renderProposalMd(bug, proposal) {
  const dt = new Date().toISOString();
  const reporter = bug.reporter_name ?? bug.reporter_email ?? '?';
  return `# Propunere fix bug ${bug.id}

> Generat de Claude la ${dt}

## Bug
- Titlu: ${bug.title}
- Raportat de: ${reporter}${bug.reporter_role ? ` (${bug.reporter_role})` : ''}
- Pagina: ${bug.page_url ?? '?'}
- Descriere:
${bug.description}

## Raport Claude

- **Reproducere:** ${proposal.reproducere ?? '(lipsă)'}
- **Cauza:** ${proposal.cauza ?? '(lipsă)'}
- **Alte locuri cu același pattern:** ${(proposal.alte_locuri ?? []).join(', ') || 'niciunul'}
- **Fix propus:**

\`\`\`
${proposal.fix_propus ?? '(lipsă)'}
\`\`\`

- **Test:** ${proposal.test ?? '(lipsă)'}
- **Fix tactic?** ${proposal.fix_tactic ? 'DA — ' + (proposal.follow_up ?? 'follow-up necesar') : 'NU'}
- **Fișiere care vor fi modificate:** ${(proposal.fisiere_modificate ?? []).join(', ') || '(lipsă)'}
- **Încrederea:** ${proposal.increderea ?? '?'}

---

## Status
PENDING APROBARE — deschide \`${process.env.PUBLIC_URL}/aprobare/${bug.id}\` ca să aprobi/respingi.
`;
}

export async function handleBugWebhook(payload) {
  ensureProposalsDir();

  // Supabase trimite în `record` la INSERT trigger
  const record = payload?.record ?? payload;
  const bugId = record?.id;
  if (!bugId) throw new Error('payload fără id');

  // Re-citim din DB (sursă autoritară)
  const bug = await getBug(bugId);
  if (!bug) throw new Error(`bug ${bugId} nu există în DB`);

  // Marchez în analiză
  await updateBugStatus(bugId, 'analyzing', { analysis_started_at: new Date().toISOString() });

  // Apel Claude
  let proposal;
  try {
    proposal = await proposeBugFix(bug);
  } catch (err) {
    logError('claude failed', { bugId, error: err.message });
    await updateBugStatus(bugId, 'received', { last_error: err.message });
    const errBody = `🔴 Bug "${bug.title}" nu a putut fi analizat: ${err.message}. Te rog tratează manual.`;
    await notify({
      title: 'Claude pe VPS - eroare la analiza',
      body: errBody,
      tags: ['rotating_light'],
      priority: 'high',
    });
    void sendEmailViaLuxuria({
      subject: `Claude pe VPS — EROARE la bug "${bug.title}"`,
      body: errBody,
    });
    return { ok: false, error: err.message };
  }

  // Salvez propunerea
  const md = renderProposalMd(bug, proposal);
  const mdPath = join(PROPOSALS_DIR, `${bugId}.md`);
  writeFileSync(mdPath, md, 'utf-8');

  await updateBugStatus(bugId, 'proposal_ready', {
    proposed_fix: proposal,
    proposal_md_path: mdPath,
    proposed_at: new Date().toISOString(),
  });

  // Dan 15 iun B+C: dacă propunerea conține edits[], facem PR REAL automat
  // (NU mai așteptăm aprobare web pentru a deschide PR-ul).
  const reporterLine = bug.reporter_name
    ? `${bug.reporter_name}${bug.reporter_role ? ` (${bug.reporter_role})` : ''}`
    : (bug.reporter_email ?? '?');

  if (Array.isArray(proposal.edits) && proposal.edits.length > 0 && !proposal.blocat) {
    try {
      const prResult = await createPrFromProposal(bug, proposal);
      await updateBugStatus(bugId, 'pr_created', {
        pr_url: prResult.url,
        pr_number: prResult.number,
        pr_branch: prResult.branch,
        pr_is_placeholder: prResult.is_placeholder,
        pr_edits_applied: prResult.edits_applied,
        pr_edits_failed: prResult.edits_failed,
        pr_created_at: new Date().toISOString(),
      });

      // Auto-merge dacă bug-ul îndeplinește criteriile safe
      const verdict = shouldAutoMerge(bug, proposal, prResult);
      let mergeResult = null;
      if (verdict.safe) {
        logInfo('auto-merge eligible', { bugId, prNumber: prResult.number });
        mergeResult = await mergePr(prResult.number, 'squash');
        if (mergeResult.merged) {
          await updateBugStatus(bugId, 'fixed', {
            fix_commit_sha: mergeResult.sha,
            auto_merged: true,
            auto_merged_at: new Date().toISOString(),
            resolved_at: new Date().toISOString(),
            resolution_notes: `Auto-merge VPS Claude. PR ${prResult.url}`,
          });
          const successBody = `✅ Bug "${bug.title}"\nRaportat: ${reporterLine}\nFix AUTO-APLICAT (Vercel va face deploy în ~2min)\nFișiere: ${prResult.edits_applied}\nCauza: ${proposal.cauza ?? '?'}\n\nPR: ${prResult.url}`;
          await notify({ title: 'Bug AUTO-REZOLVAT', body: successBody, tags: ['robot', 'white_check_mark'] });
          void sendEmailViaLuxuria({ subject: `Claude pe VPS — AUTO-FIX: ${bug.title}`, body: successBody });
          logInfo('bug auto-fixed end-to-end', { bugId, sha: mergeResult.sha });
          return { ok: true, bug_id: bugId, pr_url: prResult.url, auto_merged: true, sha: mergeResult.sha };
        }
        logWarn('auto-merge failed despite safe verdict', { bugId, reason: mergeResult.reason });
      } else {
        logInfo('auto-merge skipped (not safe)', { bugId, reasons: verdict.reasons });
      }

      // PR creat, dar NU auto-merged → cere aprobare web
      const approvalUrl = `${process.env.PUBLIC_URL}/aprobare/${bugId}`;
      const notifyBody = `🤖 Bug "${bug.title}"\nRaportat: ${reporterLine}\nPR creat: ${prResult.url}\nMotiv NU auto-merge: ${verdict.reasons.join(', ')}\nCauza: ${proposal.cauza ?? '?'}\nÎncredere: ${proposal.increderea ?? '?'}\n\nAprobă: ${approvalUrl}`;
      await notify({ title: 'Claude pe VPS - PR creat, asteapta aprobare', body: notifyBody, tags: ['robot', 'eye'] });
      void sendEmailViaLuxuria({ subject: `Claude pe VPS — PR creat: ${bug.title}`, body: notifyBody });
      return { ok: true, bug_id: bugId, pr_url: prResult.url, auto_merged: false, reasons: verdict.reasons };
    } catch (prErr) {
      logError('PR creation failed in webhook', { bugId, error: prErr.message });
      // Cad înapoi pe flow-ul vechi (notif + aprobare manuală)
    }
  }

  // Flow vechi: doar propunere, fără PR — așteaptă aprobare web
  const approvalUrl = `${process.env.PUBLIC_URL}/aprobare/${bugId}`;
  const notifyBody = `🤖 Bug "${bug.title}"\nRaportat de: ${reporterLine}\nPagina: ${bug.page_url ?? '?'}\nCauza: ${proposal.cauza ?? '(necunoscută)'}\nÎncredere: ${proposal.increderea ?? '?'}\n${proposal.edits?.length === 0 || proposal.blocat ? '\nBLOCAT / fără edits — verifică manual' : ''}\n\nDeschide: ${approvalUrl}`;
  await notify({
    title: 'Claude pe VPS - propunere fix pentru bug',
    body: notifyBody,
    tags: ['robot'],
  });
  void sendEmailViaLuxuria({
    subject: `Claude pe VPS — propunere fix: ${bug.title}`,
    body: notifyBody,
  });

  logInfo('proposal ready (no edits)', { bugId, mdPath, approvalUrl });
  return { ok: true, bug_id: bugId, proposal_md: mdPath, approval_url: approvalUrl };
}
