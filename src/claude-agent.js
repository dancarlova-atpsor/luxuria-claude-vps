// Claude Agent — analizează bug, propune fix structurat (raport 7 puncte + diff).
// Mod ASCULTAR: NU face commit/push autonom. Doar întoarce propunerea, salvată ulterior.

import Anthropic from '@anthropic-ai/sdk';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { logInfo, logWarn } from './logger.js';

let anthropic = null;
function client() {
  if (anthropic) return anthropic;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY lipsește');
  anthropic = new Anthropic({ apiKey: key });
  return anthropic;
}

const SYSTEM_PROMPT = `Ești agentul Claude pe VPS-ul Luxuria Travel — primești bug-uri raportate de colegii lui Dan (Aleksander, Georgiana, Tina) din admin platformei.

REGULA #0 — STÂRPEȘTE CAUZA, NU SIMPTOMUL
- Reproducere DETERMINISTĂ înainte să propui fix
- Caută în TOATE locurile cu același pattern (grep global)
- NU patch la simptom (try/catch gol, condiționale defensive, mock-uri)
- Dacă fix-ul corect cere refactor mare → marchezi „FIX TACTIC" + follow-up 24-48h
- Include scenariu test minim care reproduce bug-ul

REGULA #1 — DOMENIU LIMITAT
- Lucrezi DOAR pe repo luxuria-travel (clone read-only la \${LUXURIA_REPO_PATH})
- NU rulezi migrări DB autonom — scrii SQL-ul ca propunere, Dan o aplică manual
- NU atingi credențiale, env-uri Vercel, RLS Supabase
- NU faci commit/push autonom — propui, Dan aprobă, atunci se face PR

REGULA #2 — RAPORT 7 PUNCTE OBLIGATORIU
Pentru fiecare bug, returnezi JSON:
{
  "bug_titlu": "...",
  "reproducere": "...",        // pași concreți + cod/query relevant
  "cauza": "...",              // fișier:linie + de ce produce simptomul
  "alte_locuri": ["..."],      // grep global pentru același pattern
  "fix_propus": "...",         // diff scurt sau descriere precisă
  "test": "...",               // scenariu minim de reproducere + verdict
  "fix_tactic": false,         // dacă DA: descrie follow-up
  "fisiere_modificate": ["src/path/file.ts"], // listă cu căile (relative la repo)
  "increderea": "alta|medie|mica" // cât de sigur ești
}

REGULA #3 — CITEȘTE CONTEXTUL ÎNAINTE SĂ PROPUI
- Citește CLAUDE.md (instrucțiuni proiect + lecții istorice)
- Citește bugs/INDEX.md (post-mortem-uri anterioare)
- Verifică fișierele relevante înainte să afirmi cauza

REGULA #4 — DACĂ NU POȚI ACȚIONA
- Bug ambiguu / lipsesc date → returnezi { "blocat": true, "ai_nevoie_de": ["..."] }
- NU inventa fix-uri când nu ești sigur — confidence "mica" e accept`;

const TOOL_DEFS = [
  {
    name: 'read_file',
    description: 'Citește un fișier din clona luxuria-travel (read-only).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Cale relativă la repo, ex: "src/app/api/chat/route.ts"' },
        offset: { type: 'number', description: 'Linie start (1-indexat). Default 1.' },
        limit:  { type: 'number', description: 'Câte linii citești. Default 200.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'grep_repo',
    description: 'Grep în clona luxuria-travel — caută pattern în cod.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern (egrep-compatible)' },
        path:    { type: 'string', description: 'Subpath (ex: "src/app") — opțional, default toate' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'list_files',
    description: 'Listă fișiere care match un glob în repo.',
    input_schema: {
      type: 'object',
      properties: {
        glob: { type: 'string', description: 'Pattern glob ex: "src/**/*.ts"' },
      },
      required: ['glob'],
    },
  },
];

function repoPath() {
  return process.env.LUXURIA_REPO_PATH || '/var/luxuria-claude/luxuria-travel';
}

function safePath(rel) {
  const base = repoPath();
  const target = join(base, rel);
  if (!target.startsWith(base)) throw new Error('path traversal blocked');
  return target;
}

function execInRepo(cmd) {
  return execSync(cmd, { cwd: repoPath(), encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 });
}

function handleTool(name, input) {
  if (name === 'read_file') {
    const p = safePath(input.path);
    if (!existsSync(p)) return { error: `nu există: ${input.path}` };
    const raw = readFileSync(p, 'utf-8').split('\n');
    const offset = Math.max(1, Number(input.offset ?? 1));
    const limit  = Math.max(1, Math.min(2000, Number(input.limit ?? 200)));
    const slice = raw.slice(offset - 1, offset - 1 + limit);
    return { content: slice.map((l, i) => `${offset + i}\t${l}`).join('\n'), total_lines: raw.length };
  }
  if (name === 'grep_repo') {
    const pat = String(input.pattern).replace(/'/g, "'\\''");
    const sub = input.path ? String(input.path).replace(/[^A-Za-z0-9_./\-]/g, '') : '.';
    try {
      const out = execInRepo(`grep -rn --include='*.ts' --include='*.tsx' --include='*.md' --include='*.mjs' -E '${pat}' ${sub} 2>/dev/null | head -50`);
      return { matches: out };
    } catch (err) {
      // exit 1 = no matches (e.g. grep), not error
      return { matches: '' };
    }
  }
  if (name === 'list_files') {
    const glob = String(input.glob).replace(/[^A-Za-z0-9_./\-*]/g, '');
    try {
      const out = execInRepo(`find . -type f -path './${glob}' 2>/dev/null | head -50`);
      return { files: out };
    } catch (err) {
      return { files: '' };
    }
  }
  return { error: `tool necunoscut: ${name}` };
}

export async function proposeBugFix(bug) {
  const userMessage = `BUG nou raportat de ${bug.reporter_email ?? 'coleg'}:

TITLU: ${bug.title}

DESCRIERE:
${bug.description}

${bug.screenshot_url ? `Screenshot: ${bug.screenshot_url}` : ''}
${bug.page_url ? `Pagina admin: ${bug.page_url}` : ''}

Analizează cauza la rădăcină. Citește CLAUDE.md + bugs/INDEX.md + fișierele relevante. Folosește grep_repo pentru a căuta pattern-uri identice în alte fișiere. Returnează raportul de 7 puncte în JSON STRICT (FĂRĂ markdown, FĂRĂ comentariu — doar JSON valid).`;

  logInfo('claude-agent: starting analysis', { bugId: bug.id, title: bug.title });

  const messages = [{ role: 'user', content: userMessage }];
  let iter = 0;
  const MAX_ITER = 15;

  while (iter++ < MAX_ITER) {
    const resp = await client().messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-7',
      max_tokens: 8000,
      system: SYSTEM_PROMPT.replace('${LUXURIA_REPO_PATH}', repoPath()),
      tools: TOOL_DEFS,
      messages,
    });

    if (resp.stop_reason === 'end_turn' || resp.stop_reason === 'stop_sequence') {
      const textBlock = resp.content.find((b) => b.type === 'text');
      const text = textBlock?.text ?? '';
      try {
        const json = JSON.parse(text);
        logInfo('claude-agent: proposal ready', { bugId: bug.id, iters: iter });
        return json;
      } catch {
        logWarn('claude-agent: response not JSON, returning as text', { bugId: bug.id });
        return { raw_response: text };
      }
    }

    if (resp.stop_reason === 'tool_use') {
      const toolUses = resp.content.filter((b) => b.type === 'tool_use');
      messages.push({ role: 'assistant', content: resp.content });
      const toolResults = toolUses.map((tu) => ({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(handleTool(tu.name, tu.input)),
      }));
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    logWarn('claude-agent: unexpected stop_reason', { stop: resp.stop_reason });
    break;
  }

  return { error: 'max iterations reached', iters: iter };
}
