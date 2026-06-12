// Bug handler — primește webhook, apelează Claude Agent, salvează propunerea, trimite ntfy.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getBug, updateBugStatus } from './supabase.js';
import { proposeBugFix } from './claude-agent.js';
import { notify } from './ntfy.js';
import { logInfo, logError } from './logger.js';

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
    await notify({
      title: 'Claude pe VPS - eroare la analiza',
      body: `🔴 Bug "${bug.title}" nu a putut fi analizat: ${err.message}. Te rog tratează manual.`,
      tags: ['rotating_light'],
      priority: 'high',
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

  // ntfy push spre Dan — TITLU FĂRĂ caractere non-ASCII (Node fetch headers acceptă doar ByteString)
  const approvalUrl = `${process.env.PUBLIC_URL}/aprobare/${bugId}`;
  await notify({
    title: 'Claude pe VPS - propunere fix pentru bug',
    body: `🤖 Bug "${bug.title}"\nCauza: ${proposal.cauza ?? '(necunoscută)'}\nÎncredere: ${proposal.increderea ?? '?'}\n\nDeschide: ${approvalUrl}`,
    tags: ['robot'],
  });

  logInfo('proposal ready', { bugId, mdPath, approvalUrl });
  return { ok: true, bug_id: bugId, proposal_md: mdPath, approval_url: approvalUrl };
}
