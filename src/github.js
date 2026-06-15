// GitHub helper — creează PR pe luxuria-travel din propunerea Claude.
//
// Dan 15 iun (B+C): VPS Claude trece de la PR PLACEHOLDER → PR REAL CU COD.
// Propunerea conține acum `edits: [{ path, search, replace, create_new? }]`.
// applyEditsToBranch() aplică modificările direct pe ramură, NU mai e commit gol.
//
// Auto-merge se face în approval.js dacă bug-ul îndeplinește criteriile safe.

import { Octokit } from '@octokit/rest';
import { logInfo, logWarn } from './logger.js';

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

/**
 * Aplică edits[] real pe o ramură: citește fiecare fișier, face search/replace,
 * creează blob-uri noi, tree nou cu modificările, commit + update ref.
 * Returnează { applied: number, failed: [{path, reason}] }.
 */
export async function applyEditsToBranch(owner, repo, branchName, baseSha, edits, bugTitle) {
  const gh = client();
  const applied = [];
  const failed = [];

  // Citim tree-ul curent al base-ului (main HEAD) ca să avem SHA-urile de fișiere existente
  const { data: baseCommit } = await gh.git.getCommit({ owner, repo, commit_sha: baseSha });
  const baseTreeSha = baseCommit.tree.sha;

  // Pentru fiecare edit, facem blob nou + îl adăugăm în lista tree-ului
  const treeChanges = [];
  for (const edit of edits) {
    try {
      let newContent;
      if (edit.create_new) {
        // Fișier nou — conținutul vine direct din "replace"
        newContent = edit.replace ?? '';
      } else {
        // Fișier existent — citim, aplicăm search/replace
        let fileContent;
        try {
          const { data } = await gh.repos.getContent({ owner, repo, path: edit.path, ref: branchName });
          if (Array.isArray(data) || data.type !== 'file') {
            failed.push({ path: edit.path, reason: 'nu e fișier (e director sau special)' });
            continue;
          }
          fileContent = Buffer.from(data.content, 'base64').toString('utf-8');
        } catch (err) {
          if (err.status === 404) {
            failed.push({ path: edit.path, reason: 'fișier inexistent — folosește create_new: true pentru fișier nou' });
            continue;
          }
          throw err;
        }

        // Verific că "search" există în fișier
        if (!edit.search || edit.search.length === 0) {
          failed.push({ path: edit.path, reason: '"search" gol pentru fișier existent' });
          continue;
        }
        if (!fileContent.includes(edit.search)) {
          // Încerc normalizare CRLF → LF
          const normalizedFile = fileContent.replace(/\r\n/g, '\n');
          const normalizedSearch = edit.search.replace(/\r\n/g, '\n');
          if (!normalizedFile.includes(normalizedSearch)) {
            failed.push({ path: edit.path, reason: `"search" nu există în fișier (verificat și cu CRLF→LF). Primele 80 caractere: "${edit.search.slice(0, 80).replace(/\n/g, '\\n')}"` });
            continue;
          }
          fileContent = normalizedFile;
        }
        // Verific că "search" e unic (altfel replace pe primul match e ambiguu)
        const occurrences = fileContent.split(edit.search).length - 1;
        if (occurrences > 1) {
          failed.push({ path: edit.path, reason: `"search" apare de ${occurrences} ori în fișier — ambiguu. Adaugă context.` });
          continue;
        }
        newContent = fileContent.replace(edit.search, edit.replace ?? '');
      }

      // Creez blob nou pe GitHub
      const { data: blob } = await gh.git.createBlob({
        owner,
        repo,
        content: Buffer.from(newContent, 'utf-8').toString('base64'),
        encoding: 'base64',
      });

      treeChanges.push({
        path: edit.path,
        mode: '100644',
        type: 'blob',
        sha: blob.sha,
      });
      applied.push(edit.path);
      logInfo('edit applied', { path: edit.path, branch: branchName });
    } catch (err) {
      logWarn('edit failed', { path: edit.path, error: err.message });
      failed.push({ path: edit.path, reason: err.message });
    }
  }

  if (treeChanges.length === 0) {
    // Niciun edit nu s-a putut aplica — întoarcem ca să facem PR placeholder mai jos
    return { applied: 0, failed, treeSha: null, commitSha: null };
  }

  // Tree nou bazat pe baseTreeSha + modificări
  const { data: newTree } = await gh.git.createTree({
    owner,
    repo,
    base_tree: baseTreeSha,
    tree: treeChanges,
  });

  // Commit real cu modificările
  const { data: commit } = await gh.git.createCommit({
    owner,
    repo,
    message: `fix(claude-vps): ${bugTitle}\n\nFix automat propus de Claude pe VPS și aplicat în ${applied.length} fișier(e).${failed.length > 0 ? `\n\nEditări eșuate: ${failed.length} (vezi log PR)` : ''}`,
    tree: newTree.sha,
    parents: [baseSha],
  });

  // Update ref-ul ramurii la commit-ul nou
  await gh.git.updateRef({ owner, repo, ref: `heads/${branchName}`, sha: commit.sha, force: true });

  return { applied: treeChanges.length, failed, treeSha: newTree.sha, commitSha: commit.sha };
}

export async function createPrFromProposal(bug, proposal) {
  const { owner, repo } = repoCoords();
  const gh = client();
  if (!bug.reporter_display) bug.reporter_display = bug.reporter_name ?? bug.reporter_email ?? '?';

  // 1. SHA HEAD main
  const { data: mainRef } = await gh.git.getRef({ owner, repo, ref: 'heads/main' });
  const mainSha = mainRef.object.sha;

  // 2. Ramură nouă
  const branchName = `claude-vps/bug-${shortId(bug.id)}`;
  try {
    await gh.git.createRef({ owner, repo, ref: `refs/heads/${branchName}`, sha: mainSha });
  } catch (err) {
    if (err.status !== 422) throw err;
    logInfo('branch already exists, reusing', { branchName });
  }

  // 3. Aplic EDIT-urile reale (Dan 15 iun B+C)
  const edits = Array.isArray(proposal.edits) ? proposal.edits : [];
  let editResult = { applied: 0, failed: [], commitSha: null };
  let isPlaceholder = false;

  if (edits.length > 0) {
    editResult = await applyEditsToBranch(owner, repo, branchName, mainSha, edits, bug.title);
    logInfo('edits applied', { applied: editResult.applied, failed: editResult.failed.length });
  }

  // Dacă niciun edit nu a fost aplicat (proposal placeholder sau toate au eșuat),
  // facem commit gol ca PR-ul să fie deschis oricum (vezi propunerea).
  if (editResult.applied === 0) {
    isPlaceholder = true;
    const { data: commit } = await gh.git.createCommit({
      owner,
      repo,
      message: `chore(bug-${shortId(bug.id)}): propunere Claude — ${bug.title}\n\nPlaceholder PR — nu s-a aplicat cod (vezi propunerea în descriere).`,
      tree: (await gh.git.getCommit({ owner, repo, commit_sha: mainSha })).data.tree.sha,
      parents: [mainSha],
    });
    await gh.git.updateRef({ owner, repo, ref: `heads/${branchName}`, sha: commit.sha, force: true });
  }

  // 4. PR
  const isDraft = isPlaceholder; // Cu edits aplicate → PR non-draft, deschis pentru review
  const body = renderPrBody(bug, proposal, editResult, isPlaceholder);
  const { data: pr } = await gh.pulls.create({
    owner,
    repo,
    title: `[bug ${shortId(bug.id)}] ${bug.title}`,
    head: branchName,
    base: 'main',
    body,
    draft: isDraft,
  });

  logInfo('PR created', { url: pr.html_url, number: pr.number, isPlaceholder, applied: editResult.applied });
  return {
    url: pr.html_url,
    number: pr.number,
    branch: branchName,
    is_placeholder: isPlaceholder,
    edits_applied: editResult.applied,
    edits_failed: editResult.failed,
  };
}

/**
 * Auto-merge PR dacă e configurat să o facă (chemat din approval.js).
 * Returnează { merged: boolean, reason?: string }.
 */
export async function mergePr(prNumber, mergeMethod = 'squash') {
  const { owner, repo } = repoCoords();
  const gh = client();
  try {
    // Mai întâi îl scoatem din draft
    const { data: pr } = await gh.pulls.get({ owner, repo, pull_number: prNumber });
    if (pr.draft) {
      // GraphQL pentru ready_for_review
      await gh.graphql(`
        mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }
      `, { id: pr.node_id });
    }

    const { data: merged } = await gh.pulls.merge({
      owner,
      repo,
      pull_number: prNumber,
      merge_method: mergeMethod,
    });
    logInfo('PR auto-merged', { prNumber, sha: merged.sha });
    return { merged: true, sha: merged.sha };
  } catch (err) {
    logWarn('PR auto-merge failed', { prNumber, error: err.message, status: err.status });
    return { merged: false, reason: err.message };
  }
}

function renderPrBody(bug, proposal, editResult, isPlaceholder) {
  const alteLocuri = (proposal.alte_locuri ?? []).map((x) => `- \`${x}\``).join('\n') || '_niciun alt loc găsit_';
  const fisiere = (proposal.fisiere_modificate ?? []).map((x) => `- \`${x}\``).join('\n') || '_(neprecizate)_';

  const editsList = (proposal.edits ?? []).map((e, i) => `${i + 1}. \`${e.path}\`${e.create_new ? ' (FIȘIER NOU)' : ''}`).join('\n') || '_niciun edit_';
  const failedList = (editResult.failed ?? []).map((f) => `- \`${f.path}\` — ${f.reason}`).join('\n');

  return `## 🐞 Bug raportat de coleg

- **Raportat de:** ${bug.reporter_name ?? bug.reporter_email ?? '?'}${bug.reporter_role ? ` (${bug.reporter_role})` : ''}
- **Pagina:** ${bug.page_url ?? '?'}
- **Descriere:** ${bug.description ?? ''}
${bug.screenshot_path ? `- **Screenshot:** ${bug.screenshot_path}` : ''}

## 📋 Propunere Claude

### Reproducere
${proposal.reproducere ?? '_(lipsă)_'}

### Cauza root
${proposal.cauza ?? '_(lipsă)_'}

### Alte locuri cu același pattern
${alteLocuri}

### Fișiere care vor fi modificate
${fisiere}

### Fix propus (descriere)
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

## 🤖 Status aplicare cod

${isPlaceholder
  ? `⚠️ **PR PLACEHOLDER** — niciun edit nu s-a putut aplica automat.

**Edits propuse:**
${editsList}

${failedList ? `**Edits eșuate:**\n${failedList}` : ''}

Aplică manual modificările sau redeschide bug-ul pentru re-analiză.`
  : `✅ **PR CU COD APLICAT** — ${editResult.applied} fișier(e) modificat(e) automat.

**Edits aplicate:**
${editsList}

${failedList ? `**⚠️ Edits eșuate (${editResult.failed.length}):**\n${failedList}\n\nVerifică manual aceste fișiere.` : ''}

Revizuiește diff-ul în tab-ul "Files changed" și aprobă (sau cere modificări).`}

> Bug ID: \`${bug.id}\` · Generat pe \`${new Date().toISOString()}\` de luxuria-claude-vps
`;
}
