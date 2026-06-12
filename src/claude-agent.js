// Claude Agent — analizează bug, propune fix structurat (raport 7 puncte + descriere fix).
//
// Mod ASCULTAR (iter 1):
//   - NU face commit/push autonom
//   - NU păstrează codul-source pe VPS (read prin GitHub API → niciun mirror al repo-ului privat)
//   - Tool-urile read_file / grep_repo / list_files folosesc Octokit pe luxuria-travel
//   - La final, returnează propunerea ca JSON pentru salvare + ntfy + aprobare web

import Anthropic from '@anthropic-ai/sdk';
import { Octokit } from '@octokit/rest';
import { logInfo, logWarn, logError } from './logger.js';

let anthropic = null;
function aclient() {
  if (anthropic) return anthropic;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY lipsește');
  anthropic = new Anthropic({ apiKey: key });
  return anthropic;
}

let octokit = null;
function gclient() {
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

const SYSTEM_PROMPT = `Ești agentul Claude pe VPS-ul Luxuria Travel — primești bug-uri raportate de colegii lui Dan (Aleksander, Georgiana, Tina) din admin platformei.

REGULA #0 — STÂRPEȘTE CAUZA, NU SIMPTOMUL
- Reproducere DETERMINISTĂ înainte să propui fix
- Caută în TOATE locurile cu același pattern (grep_repo)
- NU patch la simptom (try/catch gol, condiționale defensive, mock-uri)
- Dacă fix-ul corect cere refactor mare → marchezi „FIX TACTIC" + follow-up 24-48h
- Include scenariu test minim care reproduce bug-ul

REGULA #1 — DOMENIU LIMITAT
- Lucrezi DOAR pe repo luxuria-travel (citit prin GitHub API, NU clonat local)
- NU rulezi migrări DB autonom — scrii SQL-ul ca propunere, Dan o aplică manual
- NU atingi credențiale, env-uri Vercel, RLS Supabase
- NU faci commit/push autonom — propui, Dan aprobă, atunci se face PR

REGULA #2 — CITEȘTE CONTEXTUL ÎNAINTE SĂ PROPUI
- ÎNTÂI citește CLAUDE.md (instrucțiuni proiect + lecții istorice) cu read_file
- Citește bugs/INDEX.md dacă există (post-mortem-uri anterioare)
- Verifică fișierele cu cod relevant înainte să afirmi cauza
- Folosește grep_repo pentru a căuta același pattern în alte locuri

REGULA #3 — RAPORT 7 PUNCTE OBLIGATORIU
La final returnezi JSON STRICT (FĂRĂ markdown wrapping, FĂRĂ comentariu — DOAR JSON valid):
{
  "bug_titlu": "...",
  "reproducere": "...",        // pași concreți + cod/query relevant
  "cauza": "...",              // fișier:linie + de ce produce simptomul
  "alte_locuri": ["..."],      // pattern global — fișiere:linii cu același pattern
  "fix_propus": "...",         // descriere precisă a modificării (fără diff complet — Dan aplică manual din descriere)
  "test": "...",               // scenariu minim de reproducere + verdict așteptat
  "fix_tactic": false,         // dacă DA: include câmpul "follow_up" cu descriere
  "fisiere_modificate": ["src/path/file.ts:linie"], // listă fișiere afectate
  "increderea": "alta|medie|mica" // cât de sigur ești de propunere
}

REGULA #4 — DACĂ NU POȚI ACȚIONA
- Bug ambiguu / lipsesc date → returnezi { "blocat": true, "ai_nevoie_de": ["..."] }
- NU inventa fix-uri când nu ești sigur — confidence "mica" e acceptat`;

const TOOL_DEFS = [
  {
    name: 'read_file',
    description: 'Citește un fișier din repo luxuria-travel (GitHub Contents API, branch main).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Cale relativă la repo, ex: "src/app/api/chat/route.ts" sau "CLAUDE.md"' },
      },
      required: ['path'],
    },
  },
  {
    name: 'grep_repo',
    description: 'Search pattern în repo luxuria-travel (GitHub Code Search API). Returnează fișierele care conțin pattern-ul.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Query Code Search — keyword sau text exact. Pentru exact match folosește ghilimele.' },
        path:  { type: 'string', description: 'Filtrează după path (ex: "src/app/api"). Opțional.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_files',
    description: 'Listă fișiere într-un director din repo (GitHub Contents API).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Director, ex: "src/app/api/chat" sau "" pentru root.' },
      },
      required: ['path'],
    },
  },
];

async function handleTool(name, input) {
  const { owner, repo } = repoCoords();
  const gh = gclient();
  try {
    if (name === 'read_file') {
      const { data } = await gh.repos.getContent({ owner, repo, path: input.path });
      if (Array.isArray(data)) return { error: `${input.path} e director, nu fișier` };
      if (data.type !== 'file') return { error: `${input.path} nu e fișier` };
      // GitHub returnează base64
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      // Linii numerotate (utile pentru a referenția linia X)
      const lines = content.split('\n');
      const MAX_LINES = 1500;
      const trimmed = lines.length > MAX_LINES
        ? lines.slice(0, MAX_LINES).map((l, i) => `${i + 1}\t${l}`).join('\n') + `\n…[trunchiat la ${MAX_LINES}/${lines.length} linii]`
        : lines.map((l, i) => `${i + 1}\t${l}`).join('\n');
      return { content: trimmed, total_lines: lines.length };
    }
    if (name === 'grep_repo') {
      const q = `${input.query} repo:${owner}/${repo}` + (input.path ? ` path:${input.path}` : '');
      const { data } = await gh.search.code({ q, per_page: 30 });
      return {
        total_count: data.total_count,
        matches: data.items.slice(0, 30).map((it) => ({
          path: it.path,
          url: it.html_url,
          score: it.score,
        })),
      };
    }
    if (name === 'list_files') {
      const path = input.path || '';
      const { data } = await gh.repos.getContent({ owner, repo, path });
      if (!Array.isArray(data)) return { error: `${path} nu e director` };
      return {
        files: data.map((it) => ({ name: it.name, type: it.type, path: it.path, size: it.size })),
      };
    }
    return { error: `tool necunoscut: ${name}` };
  } catch (err) {
    logError('tool failed', { name, error: err.message, status: err.status });
    return { error: err.message, status: err.status };
  }
}

export async function proposeBugFix(bug) {
  const userMessage = `BUG nou raportat de ${bug.reporter_email ?? 'coleg'}:

TITLU: ${bug.title}

DESCRIERE:
${bug.description}

${bug.screenshot_url ? `Screenshot: ${bug.screenshot_url}` : ''}
${bug.page_url ? `Pagina admin: ${bug.page_url}` : ''}

INSTRUCȚIUNI:
1. Citește mai întâi CLAUDE.md (instrucțiuni proiect) + bugs/INDEX.md dacă există
2. Investighează cauza la rădăcină cu read_file + grep_repo
3. Caută același pattern în alte fișiere
4. Returnează JSON valid (fără markdown wrapping) cu cele 9 câmpuri din REGULA #3`;

  logInfo('claude-agent: starting analysis', { bugId: bug.id, title: bug.title });

  const messages = [{ role: 'user', content: userMessage }];
  let iter = 0;
  const MAX_ITER = 15;

  while (iter++ < MAX_ITER) {
    const resp = await aclient().messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-7',
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      tools: TOOL_DEFS,
      messages,
    });

    if (resp.stop_reason === 'end_turn' || resp.stop_reason === 'stop_sequence') {
      const textBlock = resp.content.find((b) => b.type === 'text');
      const text = textBlock?.text ?? '';
      // Înlăturăm eventuale markdown-fences ```json ... ```
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      try {
        const json = JSON.parse(cleaned);
        logInfo('claude-agent: proposal ready', { bugId: bug.id, iters: iter });
        return json;
      } catch {
        logWarn('claude-agent: response not JSON, returning raw', { bugId: bug.id, preview: text.slice(0, 200) });
        return { raw_response: text };
      }
    }

    if (resp.stop_reason === 'tool_use') {
      const toolUses = resp.content.filter((b) => b.type === 'tool_use');
      messages.push({ role: 'assistant', content: resp.content });
      const toolResults = await Promise.all(toolUses.map(async (tu) => ({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(await handleTool(tu.name, tu.input)),
      })));
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    logWarn('claude-agent: unexpected stop_reason', { stop: resp.stop_reason });
    break;
  }

  return { error: 'max iterations reached', iters: iter };
}
