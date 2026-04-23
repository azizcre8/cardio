import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PageRecord } from '@/types';

const PDF_DIR = 'data/reference-pdfs';
const OUT_PATH = 'data/reference-bank.json';
const CHUNK_SIZE = 10;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env.local');

function loadEnvFile() {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const rawValue = trimmed.slice(eqIndex + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

export type RefEntry = {
  id: string;
  source: string;
  unit: string | null;
  number: number;
  stem: string;
  options: Array<{ letter: string; text: string }>;
  correctLetter: string;
  explanation: string;
  citation: string;
  level: 'L1' | 'L2' | 'L3';
  levelRationale: string;
  topic: string;
};

type Section = { unit: string | null; questionsText: string; answersText: string; firstPage: number };

type GenerationModule = typeof import('@/lib/pipeline/generation');
type CostTrackerModule = typeof import('@/lib/pipeline/offline-comparison');
type IngestionModule = typeof import('@/lib/pipeline/ingestion');

let generationModule: Promise<GenerationModule> | null = null;
let costTrackerModule: Promise<CostTrackerModule> | null = null;
let ingestionModule: Promise<IngestionModule> | null = null;

function getGenerationModule() {
  generationModule ??= import('@/lib/pipeline/generation');
  return generationModule;
}

function getCostTrackerModule() {
  costTrackerModule ??= import('@/lib/pipeline/offline-comparison');
  return costTrackerModule;
}

function getIngestionModule() {
  ingestionModule ??= import('@/lib/pipeline/ingestion');
  return ingestionModule;
}

function classifyPage(text: string): 'q' | 'a' | 'empty' {
  const hasAnswersHeader = /(^|\n)\s*ANSWERS\s*(\n|$)/.test(text);
  const citationHits = (text.match(/\b(TMP13|PBD9|BP9|PBD8|BP8)\s+(p\.?\s*)?\d+/g) ?? []).length;
  const answerStartsPeriod = (text.match(/(?:^|\n)\s*\d+\.\s+[A-H]\)\s+[A-Z]/g) ?? []).length;
  const answerStartsSpace = (text.match(/(?:^|\n)\s*\d+\s+[A-H]\s+[A-Z][a-z]/g) ?? []).length;
  const answerStarts = answerStartsPeriod + answerStartsSpace;
  // Option lines: "A) Foo" or "A Foo" — both styles, letters A-H.
  const optionLines = (text.match(/(?:^|\n)\s*[A-H](?:\)|\s)\s*[A-Z]/g) ?? []).length;
  // Question stem starts: "12. Foo" or bare "12 Foo" with no option-letter immediately after.
  const qStartsDot = (text.match(/(?:^|\n)\s*\d+\.\s+[A-Z][a-z]/g) ?? []).length;
  const qStartsSpace = (text.match(/(?:^|\n)\s*\d+\s+[A-Z](?:[a-z]|\s[a-z]|\s\d|\s[A-Z])/g) ?? []).length;
  const questionStarts = qStartsDot + qStartsSpace;
  if (hasAnswersHeader) return 'a';
  if (citationHits >= 5 && answerStarts >= 3) return 'a';
  if (answerStarts >= 6) return 'a';
  // Q pages: many option lines, no/few citations.
  if (optionLines >= 8 && citationHits < 3) return 'q';
  if (questionStarts >= 3 && citationHits < 3) return 'q';
  return 'empty';
}

function detectUnit(text: string): string | null {
  const unit = text.match(/Unit\s+[IVX]+\s+[A-Za-z][A-Za-z ]+/);
  if (unit) return unit[0].replace(/\s+/g, ' ').trim();
  // "CHAPTER\nBlood Vessels" or "C H A P T E R \d+\nBlood Vessels"
  const m = text.match(/(?:^|\n)\s*(?:CHAPTER|C\s*H\s*A\s*P\s*T\s*E\s*R)\s*\d*\s*\n\s*([A-Z][A-Za-z ]{2,50}?)\s*(?:\n|$)/);
  if (m) return m[1].trim();
  // "C H A P T E R 1 1 Blood Vessels" (all inline, running header style)
  const inline = text.match(/C\s*H\s*A\s*P\s*T\s*E\s*R\s+\d[\d ]*\s+([A-Z][A-Za-z][A-Za-z ]{2,40})/);
  if (inline) return inline[1].trim();
  return null;
}

function splitIntoSections(pages: PageRecord[]): Section[] {
  const tagged = pages.map(p => ({
    ...p,
    kind: classifyPage(p.text),
    rawUnit: detectUnit(p.text),
  }));

  const sections: Section[] = [];
  let qBuf: typeof tagged = [];
  let aBuf: typeof tagged = [];
  let state: 'q' | 'a' | 'idle' = 'idle';

  const sectionUnit = (buf: typeof tagged): string | null => {
    // Prefer a unit label found ON a Q-page; among multiple, take the one seen
    // most often to avoid picking a stray running header.
    const counts = new Map<string, number>();
    for (const p of buf) if (p.rawUnit) counts.set(p.rawUnit, (counts.get(p.rawUnit) ?? 0) + 1);
    let best: string | null = null;
    let bestCount = 0;
    for (const [u, c] of counts) if (c > bestCount) { best = u; bestCount = c; }
    return best;
  };

  const flush = () => {
    if (qBuf.length && aBuf.length) {
      sections.push({
        unit: sectionUnit(qBuf) ?? sectionUnit(aBuf),
        questionsText: qBuf.map(p => p.text).join('\n\n'),
        answersText: aBuf.map(p => p.text).join('\n\n'),
        firstPage: qBuf[0].page,
      });
    }
    qBuf = [];
    aBuf = [];
  };

  for (const p of tagged) {
    if (p.kind === 'q') {
      if (state === 'a') { flush(); }
      qBuf.push(p);
      state = 'q';
    } else if (p.kind === 'a') {
      aBuf.push(p);
      state = 'a';
    }
  }
  flush();
  return sections;
}

function countAnswerEntries(text: string): number {
  const nums = new Set<number>();
  for (const m of text.matchAll(/(?:^|\n)\s*(\d+)(?:\.\s+[A-H]\)|\s+[A-H]\b)/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 500) nums.add(n);
  }
  return nums.size ? Math.max(...nums) : 0;
}

function buildExtractionPrompt(
  source: string,
  unit: string | null,
  questionsText: string,
  answersText: string,
  rangeStart: number,
  rangeEnd: number,
): string {
  return `You are extracting reference medical board-exam questions from a source PDF.

SOURCE: ${source}
UNIT/CHAPTER: ${unit ?? '(none)'}
QUESTION-NUMBER RANGE TO EXTRACT: ${rangeStart}-${rangeEnd} inclusive.

You are given (a) the raw text of the question section and (b) the raw text of the corresponding answer section. Question numbers in the answer section match the question numbers in the question section. Each answer entry begins with the question number, then the correct option letter, then an explanation, and ends with a bibliographic citation (e.g. "TMP13 p. 135" or "PBD9 490 BP9 333 PBD8 495 BP8 356").

For each question numbered ${rangeStart} through ${rangeEnd} that you can fully reconstruct (stem + all options + correct letter + explanation + citation), output one JSON object. Skip any number that is not present in both sections. Do NOT hallucinate — if the explanation or citation is missing, skip that entry.

For each entry also classify:
- level: "L1" = single-fact recall (asks for a definition or one fact stated verbatim in a textbook); "L2" = mechanism/integration/calculation (requires linking concepts or applying a formula); "L3" = clinical vignette requiring differential reasoning from patient presentation.
- topic: short 2-5 word tag (e.g. "cardiac cycle", "atherosclerosis", "baroreceptor reflex").
- levelRationale: one short sentence justifying the level.

Output strictly this JSON shape:
{"entries": [
  {
    "number": <int>,
    "stem": "<question stem, no option letters>",
    "options": [{"letter": "A", "text": "..."}, ...],
    "correctLetter": "<A-H>",
    "explanation": "<full explanation text, whitespace-normalized>",
    "citation": "<bibliographic citation as-is>",
    "level": "L1" | "L2" | "L3",
    "levelRationale": "<1 sentence>",
    "topic": "<short tag>"
  }
]}

Normalize whitespace (collapse multiple spaces/newlines, remove hyphenation at line breaks like "ventricu-\\nlar" -> "ventricular"). Keep all other text verbatim.

========== QUESTION SECTION ==========
${questionsText}

========== ANSWER SECTION ==========
${answersText}
========== END ==========

Return JSON only.`;
}

function extractRelevantRange(text: string, rangeStart: number, rangeEnd: number): string {
  // Extract only lines for questions in the range, plus a reasonable margin for context
  const lines = text.split(/\n/);
  const relevant: string[] = [];
  let captureStarted = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(\d+)(?:\.|[\s\-])/);

    if (match) {
      const num = Number(match[1]);
      if (num >= rangeStart && num <= rangeEnd) {
        captureStarted = true;
        relevant.push(line);
      } else if (num > rangeEnd && captureStarted) {
        // Stop when we hit a question after the range
        break;
      }
    } else if (captureStarted) {
      // Include continuation lines (options, explanations, etc.)
      relevant.push(line);
    }
  }

  return relevant.join('\n');
}

async function extractChunk(
  source: string,
  unit: string | null,
  section: Section,
  rangeStart: number,
  rangeEnd: number,
  onCost: (cost: number) => void,
): Promise<RefEntry[]> {
  try {
    const { callOpenAI, parseJSON } = await getGenerationModule();
    const qText = extractRelevantRange(section.questionsText, rangeStart, rangeEnd);
    const aText = extractRelevantRange(section.answersText, rangeStart, rangeEnd);
    const prompt = buildExtractionPrompt(source, unit, qText, aText, rangeStart, rangeEnd);
    const { text } = await callOpenAI(prompt, 2048, 'gpt-4o-mini', onCost, {
      temperature: 0,
    });

    // Extract JSON from response (may have preamble)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error(`  Failed to extract JSON for ${rangeStart}-${rangeEnd}`);
      return [];
    }

    const parsed = parseJSON(jsonMatch[0]) as { entries?: Array<Omit<RefEntry, 'id' | 'source' | 'unit'>> };
    const entries = parsed.entries ?? [];
    return entries.map(e => ({
      id: `${source}__${unit ? unit.replace(/\s+/g, '_') : 'main'}__${e.number}`,
      source,
      unit,
      ...e,
    }));
  } catch (err) {
    console.error(`  Error extracting ${rangeStart}-${rangeEnd}: ${(err as Error).message}`);
    return [];
  }
}

async function parsePdf(
  pdfPath: string,
  sourceId: string,
  onCost: (cost: number) => void,
): Promise<{ entries: RefEntry[]; errors: string[] }> {
  const { extractTextServer } = await getIngestionModule();
  const buffer = await fsp.readFile(pdfPath);
  const pages = await extractTextServer(buffer);
  const sections = splitIntoSections(pages);
  console.log(`  sections: ${sections.length}`);
  const all: RefEntry[] = [];
  const errors: string[] = [];
  for (const section of sections) {
    const total = countAnswerEntries(section.answersText);
    console.log(`    section "${section.unit ?? '(none)'}" starting p${section.firstPage}: ~${total} questions`);
    for (let start = 1; start <= total; start += CHUNK_SIZE) {
      const end = Math.min(start + CHUNK_SIZE - 1, total);
      process.stdout.write(`      extracting ${start}-${end}... `);
      try {
        const entries = await extractChunk(sourceId, section.unit, section, start, end, onCost);
        all.push(...entries);
        console.log(`got ${entries.length}`);
      } catch (err) {
        const message = (err as Error).message;
        errors.push(`${sourceId} ${section.unit ?? '(none)'} ${start}-${end}: ${message}`);
        console.log(`ERROR: ${message}`);
      }
    }
  }
  return { entries: all, errors };
}

async function dryRun() {
  const { extractTextServer } = await getIngestionModule();
  const files = (await fsp.readdir(PDF_DIR)).filter(f => f.toLowerCase().endsWith('.pdf'));
  for (const f of files) {
    console.log(`\n[dry] ${f}`);
    const pages = await extractTextServer(await fsp.readFile(path.join(PDF_DIR, f)));
    const sections = splitIntoSections(pages);
    for (const s of sections) {
      const qCount = countAnswerEntries(s.answersText);
      console.log(`  unit="${s.unit ?? '(none)'}" firstPage=${s.firstPage} qChars=${s.questionsText.length} aChars=${s.answersText.length} est=${qCount} questions`);
    }
  }
}

async function main() {
  loadEnvFile();
  if (process.argv.includes('--dry')) return dryRun();
  const { createCostTracker } = await getCostTrackerModule();
  const tracker = createCostTracker();
  const files = (await fsp.readdir(PDF_DIR)).filter(f => f.toLowerCase().endsWith('.pdf'));
  if (!files.length) throw new Error(`No PDFs in ${PDF_DIR}`);
  const all: RefEntry[] = [];
  const errors: string[] = [];
  for (const f of files) {
    const sourceId = path.basename(f, path.extname(f));
    console.log(`[parse] ${f}`);
    const result = await parsePdf(path.join(PDF_DIR, f), sourceId, tracker.recordCost);
    console.log(`  -> ${result.entries.length} entries`);
    all.push(...result.entries);
    errors.push(...result.errors);
  }
  if (errors.length) {
    throw new Error(`Reference parse encountered ${errors.length} chunk errors.\n${errors.slice(0, 10).join('\n')}`);
  }
  await fsp.writeFile(OUT_PATH, JSON.stringify(all, null, 2));
  console.log(`\nWrote ${all.length} entries to ${OUT_PATH}`);
  console.log(`Total cost: $${tracker.getTotalCostUSD().toFixed(4)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
