/**
 * Rewrites L1 questions that use the definition-matching template:
 *   "In the source passage, which named concept is described by '...'?"
 *
 * For each matched question, calls GPT to generate a better stem while
 * preserving the options, answer, and explanation unchanged.
 *
 * Also deletes identified near-duplicate pairs.
 *
 * Usage:
 *   npx tsx scripts/rewrite-template-questions.ts --pdf-id=<id>
 *   npx tsx scripts/rewrite-template-questions.ts --pdf-id=<id> --apply
 *   npx tsx scripts/rewrite-template-questions.ts --pdf-id=<id> --apply --limit=5
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env.local');

if (fs.existsSync(envPath)) {
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

function readArg(name: string): string | null {
  const prefix = `${name}=`;
  const match = process.argv.find(arg => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

const PDF_ID = readArg('--pdf-id');
const APPLY = process.argv.includes('--apply');
const LIMIT = Number(readArg('--limit') ?? '0') || null;
const MODEL = 'gpt-4o-mini';
const TEMPLATE_PATTERN = /^In the source passage, which named concept is described by ["'"]/i;

// ── Near-duplicate pairs to delete (one from each pair) ─────────────────────
// These are identified by analysis — the second ID in each pair is deleted.
// Populated at runtime from DB query by concept+level similarity; also handles
// the two hardcoded duplicate pairs from the April 20 run.
const KNOWN_DUPLICATE_STEMS: Array<[string, string]> = [
  // Both ask about "produce the nephrotic syndrome" vs "virtually always produce..."
  ['produce the nephrotic syndrome', 'virtually always produce the nephrotic syndrome'],
  // Both are corticosteroid + MCD clinical vignettes
  ['Corticosteroid Therapy', 'Corticosteroids'],
];

type QuestionRow = {
  id: string;
  pdf_id: string;
  user_id: string;
  concept_id: string;
  concept_name: string | null;
  level: number;
  stem: string;
  options: string[];
  answer: number;
  explanation: string;
  source_quote: string | null;
  deciding_clue: string | null;
  chunk_id: string | null;
  concepts: { name: string } | { name: string }[] | null;
};

type ChunkRow = { id: string; text: string };

function getSupabaseAdmin() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL');
  if (!serviceRoleKey) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function getOpenAI() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('Missing OPENAI_API_KEY');
  return new OpenAI({ apiKey: key });
}

function conceptName(row: QuestionRow): string {
  if (row.concept_name) return row.concept_name;
  const c = row.concepts;
  if (!c) return '(unknown)';
  if (Array.isArray(c)) return c[0]?.name ?? '(unknown)';
  return c.name ?? '(unknown)';
}

function letterOf(idx: number): string {
  return String.fromCharCode(65 + idx);
}

function extractClue(stem: string): string {
  const m = stem.match(/described by ["'"'](.+?)["'"'][\s?]*$/i);
  return m?.[1] ?? stem;
}

async function rewriteStem(
  openai: OpenAI,
  concept: string,
  clue: string,
  sourceQuote: string,
  options: string[],
  correctIdx: number,
): Promise<string | null> {
  const correctOption = options[correctIdx] ?? concept;
  const optionList = options.map((o, i) => `${letterOf(i)}. ${o}`).join('\n');

  const prompt = `You are a USMLE/COMLEX Writer Agent. Rewrite the stem of this L1 question.

CONCEPT BEING TESTED: ${concept}
CORRECT ANSWER: ${correctOption}
OPTIONS:
${optionList}

SOURCE QUOTE (verbatim from textbook):
"${sourceQuote}"

ORIGINAL STEM (bad — uses definition-matching template):
"In the source passage, which named concept is described by '${clue}'"

Write a NEW stem that:
1. Is a real clinical, mechanistic, or recognition question — NOT "In the source passage, which named concept is described by..."
2. Is specific enough that an expert could answer it before seeing the options
3. Is answerable using the SOURCE QUOTE as evidence
4. Keeps the same concept (${concept}) as the correct answer
5. Acceptable formats: short clinical vignette ("A 40-year-old presents with..."), characteristic/mechanism question ("Which condition is characterized by..."), or direct recall ("A patient with X presents with hematuria and hearing loss — which hereditary condition...?")

Return ONLY a JSON object with the new stem: {"stem": "..."}`;

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 256,
      temperature: 0.3,
      response_format: { type: 'json_object' },
    });
    const text = response.choices[0]?.message?.content ?? '';
    const parsed = JSON.parse(text) as { stem?: string };
    const stem = parsed.stem?.trim();
    if (!stem || stem.length < 20) return null;
    // Reject if GPT still produced the template
    if (TEMPLATE_PATTERN.test(stem)) return null;
    return stem;
  } catch {
    return null;
  }
}

async function loadTemplateQuestions(db: ReturnType<typeof getSupabaseAdmin>): Promise<QuestionRow[]> {
  let query = db
    .from('questions')
    .select('id,pdf_id,user_id,concept_id,concept_name,level,stem,options,answer,explanation,source_quote,deciding_clue,chunk_id,concepts(name)')
    .eq('level', 1)
    .order('concept_name', { ascending: true });

  if (PDF_ID) query = query.eq('pdf_id', PDF_ID);
  if (LIMIT) query = query.limit(LIMIT);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load questions: ${error.message}`);

  return ((data ?? []) as QuestionRow[]).filter(q => TEMPLATE_PATTERN.test(q.stem));
}

async function loadChunkText(db: ReturnType<typeof getSupabaseAdmin>, chunkId: string): Promise<string> {
  const { data } = await db.from('chunks').select('id,text').eq('id', chunkId).single();
  return (data as ChunkRow | null)?.text ?? '';
}

async function findNearDuplicates(
  db: ReturnType<typeof getSupabaseAdmin>,
): Promise<string[]> {
  if (!PDF_ID) return [];

  const { data } = await db
    .from('questions')
    .select('id,concept_name,level,stem')
    .eq('pdf_id', PDF_ID)
    .eq('level', 1);

  const rows = (data ?? []) as Array<{ id: string; concept_name: string | null; level: number; stem: string }>;
  const toDelete: string[] = [];

  for (const [keyA, keyB] of KNOWN_DUPLICATE_STEMS) {
    const groupA = rows.filter(r => r.stem.toLowerCase().includes(keyA.toLowerCase()) || (r.concept_name ?? '').toLowerCase().includes(keyA.toLowerCase()));
    const groupB = rows.filter(r => r.stem.toLowerCase().includes(keyB.toLowerCase()) || (r.concept_name ?? '').toLowerCase().includes(keyB.toLowerCase()));

    if (groupA.length > 0 && groupB.length > 0) {
      // Delete the second group (keep groupA)
      toDelete.push(...groupB.map(r => r.id));
    }
  }

  // Also find Nephrotic Syndrome L1 duplicates: two questions with identical concept+level
  const byConceptLevel = new Map<string, string[]>();
  for (const r of rows) {
    const key = `${r.concept_name ?? ''}::${r.level}`;
    if (!byConceptLevel.has(key)) byConceptLevel.set(key, []);
    byConceptLevel.get(key)!.push(r.id);
  }
  for (const [, ids] of byConceptLevel) {
    if (ids.length > 1) {
      // Keep first, delete the rest
      toDelete.push(...ids.slice(1));
    }
  }

  return [...new Set(toDelete)];
}

async function main() {
  if (!PDF_ID) {
    console.error('Usage: npx tsx scripts/rewrite-template-questions.ts --pdf-id=<id> [--apply] [--limit=N]');
    process.exit(1);
  }

  const db = getSupabaseAdmin();
  const openai = getOpenAI();

  // ── 1. Find and delete near-duplicates ─────────────────────────────────────
  const dupIds = await findNearDuplicates(db);
  if (dupIds.length > 0) {
    console.log(`\nNear-duplicates to delete: ${dupIds.length}`);
    for (const id of dupIds) console.log(`  DELETE ${id}`);

    if (APPLY) {
      const { error } = await db.from('questions').delete().in('id', dupIds);
      if (error) throw new Error(`Failed to delete duplicates: ${error.message}`);
      console.log(`  ✓ Deleted ${dupIds.length} near-duplicate questions`);
    }
  }

  // ── 2. Load template L1 questions ──────────────────────────────────────────
  const questions = await loadTemplateQuestions(db);
  console.log(`\nTemplate L1 questions to rewrite: ${questions.length}`);

  if (questions.length === 0) {
    console.log('Nothing to rewrite.');
    return;
  }

  let rewrote = 0;
  let skipped = 0;

  for (const q of questions) {
    const cn = conceptName(q);
    const clue = extractClue(q.stem);
    const sourceQuote = q.source_quote ?? q.deciding_clue ?? clue;

    // Get extra context from chunk if available
    let chunkText = '';
    if (q.chunk_id) {
      chunkText = await loadChunkText(db, q.chunk_id);
    }
    const effectiveSource = chunkText.length > 60
      ? chunkText.slice(0, 600)
      : sourceQuote;

    console.log(`\n[${cn}] ${q.id.slice(0, 8)}`);
    console.log(`  OLD: ${q.stem.slice(0, 80)}…`);

    const newStem = await rewriteStem(openai, cn, clue, effectiveSource, q.options, q.answer);

    if (!newStem) {
      console.log(`  SKIP: GPT returned null or template`);
      skipped++;
      continue;
    }

    console.log(`  NEW: ${newStem.slice(0, 100)}${newStem.length > 100 ? '…' : ''}`);

    if (APPLY) {
      const { error } = await db
        .from('questions')
        .update({ stem: newStem })
        .eq('id', q.id);

      if (error) {
        console.log(`  ERROR: ${error.message}`);
        skipped++;
      } else {
        console.log(`  ✓ Updated`);
        rewrote++;
      }
    } else {
      rewrote++;
    }
  }

  console.log(`\n${'─'.repeat(56)}`);
  console.log(`  Rewritten : ${rewrote}`);
  console.log(`  Skipped   : ${skipped}`);
  if (!APPLY) {
    console.log('\nDry run — pass --apply to write changes to Supabase.');
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
