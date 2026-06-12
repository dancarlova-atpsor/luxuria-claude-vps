// Pagina de aprobare + acțiune.

import { getBug, updateBugStatus } from './supabase.js';
import { createPrFromProposal } from './github.js';
import { notify } from './ntfy.js';
import { sendEmailViaLuxuria } from './email.js';
import { logInfo } from './logger.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function renderApprovalPage(bugId) {
  const bug = await getBug(bugId);
  if (!bug) return `<h1>Bug ${esc(bugId)} nu există</h1>`;
  const prop = bug.metadata?.proposed_fix;

  const statusBadge = bug.status === 'pr_created'
    ? '<span style="background:#16a34a;color:#fff;padding:4px 10px;border-radius:6px">PR CREAT ✓</span>'
    : bug.status === 'rejected'
      ? '<span style="background:#dc2626;color:#fff;padding:4px 10px;border-radius:6px">RESPINS</span>'
      : bug.status === 'proposal_ready'
        ? '<span style="background:#0284c7;color:#fff;padding:4px 10px;border-radius:6px">AȘTEAPTĂ APROBARE</span>'
        : `<span style="background:#475569;color:#fff;padding:4px 10px;border-radius:6px">${esc(bug.status)}</span>`;

  if (!prop) {
    return `<!DOCTYPE html><html lang="ro"><head><meta charset="utf-8"><title>Bug ${esc(bugId)}</title><style>body{font-family:system-ui;max-width:800px;margin:40px auto;padding:0 20px;color:#0f172a}</style></head><body>
<h1>Bug ${esc(bugId)}</h1>
<p><strong>Status:</strong> ${statusBadge}</p>
<p>Nu există încă propunere de fix. Claude analizează sau a întâmpinat o eroare. Verifică ntfy / logs.</p>
<pre>${esc(JSON.stringify(bug.metadata ?? {}, null, 2))}</pre>
</body></html>`;
  }

  const alteLocuri = Array.isArray(prop.alte_locuri) && prop.alte_locuri.length > 0
    ? `<ul>${prop.alte_locuri.map((x) => `<li><code>${esc(x)}</code></li>`).join('')}</ul>`
    : '<em>niciun alt loc găsit</em>';

  const fisiere = Array.isArray(prop.fisiere_modificate) && prop.fisiere_modificate.length > 0
    ? `<ul>${prop.fisiere_modificate.map((x) => `<li><code>${esc(x)}</code></li>`).join('')}</ul>`
    : '<em>(neprecizate)</em>';

  const showButtons = bug.status === 'proposal_ready';

  return `<!DOCTYPE html><html lang="ro"><head><meta charset="utf-8"><title>Bug ${esc(bugId)} — aprobare</title>
<style>
body{font-family:system-ui;max-width:900px;margin:24px auto;padding:0 20px;color:#0f172a;line-height:1.55}
h1{color:#0f172a;border-bottom:2px solid #e2e8f0;padding-bottom:10px}
.row{display:grid;grid-template-columns:200px 1fr;gap:12px;padding:10px 0;border-bottom:1px solid #f1f5f9}
.row strong{color:#475569}
pre{background:#0f172a;color:#e2e8f0;padding:14px;border-radius:8px;overflow-x:auto;font-size:13px}
.actions{margin-top:32px;padding:20px;background:#f8fafc;border-radius:10px;display:flex;gap:12px;justify-content:center}
button{font-size:16px;padding:14px 28px;border-radius:8px;border:0;cursor:pointer;font-weight:600}
.btn-da{background:#16a34a;color:#fff}
.btn-nu{background:#dc2626;color:#fff}
.confidence-alta{color:#16a34a;font-weight:600}
.confidence-medie{color:#ea580c;font-weight:600}
.confidence-mica{color:#dc2626;font-weight:600}
.tactic{background:#fef3c7;padding:8px 12px;border-radius:6px;border-left:4px solid #f59e0b}
</style></head>
<body>
<h1>🐞 Bug ${esc(bugId)}</h1>
<p style="font-size:18px"><strong>${esc(bug.title)}</strong></p>
<p>Status: ${statusBadge}</p>

<div class="row"><strong>Raportat de</strong><span>${esc(bug.reporter_name ?? bug.reporter_email ?? '?')}${bug.reporter_role ? ` <em style="color:#94a3b8">(${esc(bug.reporter_role)})</em>` : ''}</span></div>
<div class="row"><strong>Pagina</strong><span>${esc(bug.page_url ?? '?')}</span></div>
<div class="row"><strong>Descriere</strong><span>${esc(bug.description ?? '')}</span></div>
${bug.screenshot_path ? `<div class="row"><strong>Screenshot</strong><span><a href="${esc(bug.screenshot_path)}" target="_blank">deschide</a></span></div>` : ''}

<h2>📋 Propunere Claude</h2>
<div class="row"><strong>Reproducere</strong><span>${esc(prop.reproducere ?? '?')}</span></div>
<div class="row"><strong>Cauza root</strong><span>${esc(prop.cauza ?? '?')}</span></div>
<div class="row"><strong>Alte locuri cu pattern</strong><span>${alteLocuri}</span></div>
<div class="row"><strong>Fișiere modificate</strong><span>${fisiere}</span></div>
<div class="row"><strong>Test</strong><span>${esc(prop.test ?? '?')}</span></div>
<div class="row"><strong>Fix tactic?</strong><span>${prop.fix_tactic ? `<div class="tactic">⚠️ DA — follow-up: ${esc(prop.follow_up ?? '?')}</div>` : 'NU (fix la rădăcină)'}</span></div>
<div class="row"><strong>Încredere</strong><span class="confidence-${esc(prop.increderea ?? 'medie')}">${esc(prop.increderea ?? '?')}</span></div>

<h3>Fix propus (diff / descriere):</h3>
<pre>${esc(prop.fix_propus ?? '(lipsă)')}</pre>

${showButtons ? `
<div class="actions">
  <button class="btn-da" onclick="act('da')">✅ DA — fă PR draft</button>
  <button class="btn-nu" onclick="act('nu')">❌ NU — respinge</button>
</div>
<script>
async function act(action) {
  const ok = confirm(action === 'da' ? 'Creez PR draft pe luxuria-travel?' : 'Marchez ca respins?');
  if (!ok) return;
  const res = await fetch('/aprobare/${esc(bugId)}/' + action, { method: 'POST' });
  const j = await res.json();
  if (j.ok) {
    alert('OK — ' + (j.message ?? 'gata'));
    location.reload();
  } else {
    alert('Eroare: ' + (j.error ?? 'necunoscută'));
  }
}
</script>` : '<p style="text-align:center;color:#64748b;margin-top:32px"><em>Bug-ul a fost deja procesat — fără acțiuni disponibile.</em></p>'}

</body></html>`;
}

export async function handleApproval(bugId, action) {
  const bug = await getBug(bugId);
  if (!bug) throw new Error(`bug ${bugId} nu există`);
  if (bug.status !== 'proposal_ready') {
    throw new Error(`bug în status ${bug.status} — nu se poate aproba/respinge`);
  }

  if (action === 'nu') {
    await updateBugStatus(bugId, 'rejected', {
      rejected_at: new Date().toISOString(),
      rejected_by: 'Dan (web approval)',
    });
    logInfo('bug rejected', { bugId });
    return { ok: true, message: 'Marcat ca respins.' };
  }

  // DA → PR draft
  const proposal = bug.metadata?.proposed_fix;
  if (!proposal) throw new Error('propunere lipsă în metadata');

  const pr = await createPrFromProposal(bug, proposal);
  await updateBugStatus(bugId, 'pr_created', {
    pr_url: pr.url,
    pr_number: pr.number,
    pr_created_at: new Date().toISOString(),
  });

  const prBody = `✅ Bug "${bug.title}" → ${pr.url}\nRevizuiește și merge când ești gata.`;
  await notify({
    title: 'PR draft creat din bug-fix Claude',
    body: prBody,
    tags: ['white_check_mark'],
  });
  void sendEmailViaLuxuria({
    subject: `Claude pe VPS — PR draft creat: ${bug.title}`,
    body: prBody,
  });

  return { ok: true, message: `PR creat: ${pr.url}`, pr_url: pr.url };
}
