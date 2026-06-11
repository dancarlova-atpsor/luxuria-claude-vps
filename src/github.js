// GitHub helper — creează PR draft pe luxuria-travel din propunerea Claude.
// Mod minimalist pentru noaptea asta: PR-ul conține DOAR descrierea propunerii ca summary
// + lista fișierelor afectate. Modificările efective de cod se aplică în iterația viitoare
// (când avem un loop sigur de „cere diff strict + scrie pe ramură").

import { Octokit } from '@octokit/rest';
import { logInfo } from './logger.js';

let octokit = null;
function client() {
  if (octokit) return octokit;
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN lipsește');
  octokit = new Octokit({ auth: token });
  return octokit;
}

function repoCoords() {
  return {
    owner: process.env.GITHUB_OWNER || 'dancarlova-atpsor',
    repo:  process.env.GITHUB_REPO  || 'luxuria-travel',
  };
}

function shortId(uuid) {
  return String(uuid).slice(0, 8);
}

export async function createPrFromProposal(bug, proposal) {
  const { owner, repo } = repoCoords();
  const gh = client();

  // 1. Obținem SHA-ul HEAD-ului main
  const { data: mainRef } = await gh.git.getRef({ owner, repo, ref: 'heads/main' });
  const mainSha = mainRef.object.sha;

  // 2. Ramură nouă
  const branchName = `claude-vps/bug-${shortId(bug.id)}`;
  try {
    await gh.git.createRef({ owner, repo, ref: `refs/heads/${branchName}`, sha: mainSha });
  } catch (err) {
    if (err.status !== 422) throw err; // 422 = ramură există deja
    logInfo('branch already exists, reusing', { branchName });
  }

  // 3. Comit gol cu mesaj „chore(bug): X" pe ramură
  //    (Octokit nu poate face commit gol direct; folosim createCommit cu tree-ul lui main.)
  const { data: commit } = await gh.git.createCommit({
    owner,
    repo,
    message: `chore(bug-${shortId(bug.id)}): propunere Claude — ${bug.title}\n\nNon-empty commit placeholder. Vezi descrierea PR-ului pentru raportul complet.`,
    tree: (await gh.git.getCommit({ owner, repo, commit_sha: mainSha })).data.tree.sha,
    parents: [mainSha],
  });
  await gh.git.updateRef({ owner, repo, ref: `heads/${branchName}`, sha: commit.sha, force: true });

  // 4. PR draft
  const body = renderPrBody(bug, proposal);
  const { data: pr } = await gh.pulls.create({
    owner,
    repo,
    title: `[bug ${shortId(bug.id)}] ${bug.title}`,
    head: branchName,
    base: 'main',
    body,
    draft: true,
  });

  logInfo('PR created', { url: pr.html_url, number: pr.number });
  return { url: pr.html_url, number: pr.number, branch: branchName };
}

function renderPrBody(bug, proposal) {
  const alteLocuri = (proposal.alte_locuri ?? []).map((x) => `- \`${x}\``).join('\n') || '_niciun alt loc găsit_';
  const fisiere = (proposal.fisiere_modificate ?? []).map((x) => `- \`${x}\``).join('\n') || '_(neprecizate)_';
  return `## 🐞 Bug raportat de coleg

- **Raportat de:** ${bug.reporter_email ?? '?'}
- **Pagina:** ${bug.page_url ?? '?'}
- **Descriere:** ${bug.description ?? ''}
${bug.screenshot_url ? `- **Screenshot:** ${bug.screenshot_url}` : ''}

## 📋 Propunere Claude (mod ASCULTAR — analizată dar NU aplicată)

### Reproducere
${proposal.reproducere ?? '_(lipsă)_'}

### Cauza root
${proposal.cauza ?? '_(lipsă)_'}

### Alte locuri cu același pattern
${alteLocuri}

### Fișiere care vor fi modificate
${fisiere}

### Fix propus
\`\`\`
${proposal.fix_propus ?? '_(lipsă)_'}
\`\`\`

### Test minim de reproducere
${proposal.test ?? '_(lipsă)_'}

### Fix tactic?
${proposal.fix_tactic ? `⚠️ DA — follow-up: ${proposal.follow_up ?? '?'}` : '✅ NU (fix la rădăcină)'}

### Încredere
**${proposal.increderea ?? '?'}**

---

> **Notă:** acest PR e DRAFT. Aplică efectiv modificările manual sau pe baza propunerii, apoi marchează „Ready for review" și merge.
> Bug ID: \`${bug.id}\` · Generat pe \`${new Date().toISOString()}\` de luxuria-claude-vps
`;
}
