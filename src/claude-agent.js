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
Răspunsul tău FINAL (după ce ai folosit toate tool-urile necesare) trebuie să fie EXACT un obiect JSON valid, NIMIC ALTCEVA.
- NU începe cu „Analiza este..." sau „Iată raportul..."
- NU folosi markdown code fences (nici cu json, nici fără)
- NU adăuga text înainte sau după
- DOAR caractere care încep cu { și se termină cu }

Schema OBLIGATORIE (folosește exact aceste chei):
{
  "bug_titlu": "...",
  "reproducere": "...",
  "cauza": "...",
  "alte_locuri": ["..."],
  "fix_propus": "...",
  "test": "...",
  "fix_tactic": false,
  "fisiere_modificate": ["src/path/file.ts:linie"],
  "increderea": "alta|medie|mica"
}

REGULA #4 — DACĂ NU POȚI ACȚIONA
- Bug ambiguu / lipsesc date → returnezi JSON: { "blocat": true, "ai_nevoie_de": ["..."], "increderea": "mica" }
- Bug fals (nu reproduc nimic) → returnezi JSON cu increderea="mica" + fix_propus="(nu am identificat un bug real în cod)" + completezi celelalte câmpuri cu observațiile tale

REGULA #5 — JSON FALLBACK
Dacă ai răspuns deja cu text liber și acum primești mesaj „Reformatează ca JSON", răspunzi DOAR cu JSON valid (vezi schema #3). Nu mai explici, nu mai adaugi text.`;

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
  const MAX_ITER = 25;

  while (iter++ < MAX_ITER) {
    // La penultima iterație forțez Claude să dea verdict — fără tool-uri.
    const isLastChance = iter >= MAX_ITER - 1;
    const resp = await aclient().messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-7',
      max_tokens: 8000,
      system: isLastChance
        ? SYSTEM_PROMPT + '\n\nATENȚIE: Ai folosit deja multe tool-uri. ACUM dă verdictul FINAL ca JSON STRICT (vezi REGULA #3). NU mai folosi tool_use. Cu ce ai aflat — dă cea mai bună propunere posibilă. Dacă nu ești sigur, increderea="mica" + observații.'
        : SYSTEM_PROMPT,
      tools: isLastChance ? [] : TOOL_DEFS,
      messages,
    });

    if (resp.stop_reason === 'end_turn' || resp.stop_reason === 'stop_sequence') {
      const textBlock = resp.content.find((b) => b.type === 'text');
      const text = textBlock?.text ?? '';
      const parsed = tryParseJson(text);
      if (parsed) {
        logInfo('claude-agent: proposal ready', { bugId: bug.id, iters: iter });
        return parsed;
      }
      // Fallback: cer Claude să REFORMATEZE răspunsul ca JSON valid (1 round extra)
      logWarn('claude-agent: response not JSON, retrying with reformat request', { bugId: bug.id, preview: text.slice(0, 200) });
      messages.push({ role: 'assistant', content: resp.content });
      messages.push({
        role: 'user',
        content: 'Răspunsul anterior nu este JSON valid. Reformatează DOAR ca JSON pur (fără markdown fences, fără text înainte/după) folosind schema din REGULA #3. Începe direct cu { și termină cu }. Dacă nu ai identificat un bug real, folosește increderea="mica" + fix_propus="(nu am identificat bug real în cod)" + completezi celelalte câmpuri cu observațiile tale.',
      });
      const retry = await aclient().messages.create({
        model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-7',
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages,
      });
      const retryText = retry.content.find((b) => b.type === 'text')?.text ?? '';
      const retryParsed = tryParseJson(retryText);
      if (retryParsed) {
        logInfo('claude-agent: proposal ready after reformat', { bugId: bug.id });
        return retryParsed;
      }
      logWarn('claude-agent: still not JSON after reformat, wrapping raw', { bugId: bug.id });
      return wrapRawAsProposal(bug, text);
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

function tryParseJson(text) {
  if (!text || typeof text !== 'string') return null;
  // Înlăturăm markdown fences ```json ... ``` + text înainte/după primul { ... ultimul }
  let cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const first = cleaned.indexOf('{');
  const last  = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) cleaned = cleaned.slice(first, last + 1);
  try { return JSON.parse(cleaned); } catch { return null; }
}

function wrapRawAsProposal(bug, text) {
  // Fallback ultim: împachetăm răspunsul brut într-o propunere cu confidence mica.
  return {
    bug_titlu: bug.title,
    reproducere: '(Claude nu a putut returna raport structurat — vezi text brut în fix_propus)',
    cauza: '(neidentificată — răspuns nestructurat)',
    alte_locuri: [],
    fix_propus: text || '(răspuns gol)',
    test: '(neprecizat)',
    fix_tactic: false,
    fisiere_modificate: [],
    increderea: 'mica',
    raw_response: text,
  };
}
