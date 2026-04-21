import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

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

const PDF_NAME_FILTER = readArg('--pdf-name') ?? '20a';
const PDF_ID_FILTER = readArg('--pdf-id');

function getSupabaseAdmin() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL');
  if (!serviceRoleKey) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

type PdfRow = { id: string; name: string; created_at: string };

type QuestionRow = {
  id: string;
  pdf_id: string;
  concept_id: string;
  level: number;
  stem: string;
  options: string[];
  answer: number;
  explanation: string;
  source_quote: string | null;
  option_set_flags: string[] | null;
  flagged: boolean;
  flag_reason: string | null;
  concept_name: string | null;
  concepts: { name: string } | { name: string }[] | null;
};

type FlaggedRow = {
  id: string;
  question_id: string | null;
  reason: string;
  raw_json: Record<string, unknown> | null;
};

function letterOf(idx: number): string {
  return String.fromCharCode(65 + idx);
}

function conceptName(row: QuestionRow): string {
  if (row.concept_name) return row.concept_name;
  const c = row.concepts;
  if (!c) return '(unknown)';
  if (Array.isArray(c)) return c[0]?.name ?? '(unknown)';
  return c.name ?? '(unknown)';
}

function freq(items: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[item] = (out[item] ?? 0) + 1;
  return out;
}

function printFreq(label: string, counts: Record<string, number>) {
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) { console.log(`  ${label}: (none)`); return; }
  console.log(`  ${label}:`);
  for (const [key, n] of sorted) console.log(`    ${n.toString().padStart(4)}  ${key}`);
}

async function main() {
  const db = getSupabaseAdmin();

  // ── 1. Find target PDF ───────────────────────────────────────────────────────
  let pdfId: string;
  let pdfName: string;

  if (PDF_ID_FILTER) {
    const { data, error } = await db.from('pdfs').select('id,name,created_at').eq('id', PDF_ID_FILTER).single();
    if (error || !data) throw new Error(`PDF not found for id=${PDF_ID_FILTER}: ${error?.message}`);
    pdfId = data.id;
    pdfName = data.name;
  } else {
    const { data, error } = await db.from('pdfs').select('id,name,created_at').ilike('name', `%${PDF_NAME_FILTER}%`).order('created_at', { ascending: false });
    if (error) throw new Error(`Failed to query pdfs: ${error.message}`);
    const rows = (data ?? []) as PdfRow[];
    if (rows.length === 0) {
      console.error(`No PDFs found matching name '%${PDF_NAME_FILTER}%'.`);
      console.error('Available PDFs:');
      const { data: all } = await db.from('pdfs').select('id,name,created_at').order('created_at', { ascending: false }).limit(20);
      for (const r of (all ?? []) as PdfRow[]) console.error(`  ${r.id}  ${r.name}  (${r.created_at.slice(0, 10)})`);
      process.exit(1);
    }
    if (rows.length > 1) {
      console.error(`Multiple PDFs match '%${PDF_NAME_FILTER}%'. Pass --pdf-id=<id> to select one:`);
      for (const r of rows) console.error(`  ${r.id}  ${r.name}  (${r.created_at.slice(0, 10)})`);
      process.exit(1);
    }
    pdfId = rows[0].id;
    pdfName = rows[0].name;
  }

  console.log(`\nAnalyzing: "${pdfName}"  (${pdfId})\n`);

  // ── 2. Fetch accepted questions ──────────────────────────────────────────────
  const { data: qData, error: qErr } = await db
    .from('questions')
    .select('id,pdf_id,concept_id,level,stem,options,answer,explanation,source_quote,option_set_flags,flagged,flag_reason,concept_name,concepts(name)')
    .eq('pdf_id', pdfId)
    .order('concept_name', { ascending: true });

  if (qErr) throw new Error(`Failed to fetch questions: ${qErr.message}`);
  const questions = (qData ?? []) as QuestionRow[];

  // ── 3. Fetch flagged_questions ───────────────────────────────────────────────
  const { data: fData, error: fErr } = await db
    .from('flagged_questions')
    .select('id,question_id,reason,raw_json')
    .eq('pdf_id', pdfId);

  if (fErr) throw new Error(`Failed to fetch flagged_questions: ${fErr.message}`);
  const flagged = (fData ?? []) as FlaggedRow[];

  // ── 4. Compute stats ─────────────────────────────────────────────────────────
  const total = questions.length + flagged.length;
  const acceptanceRate = total > 0 ? ((questions.length / total) * 100).toFixed(1) : 'N/A';

  const byLevel = freq(questions.map(q => `L${q.level}`));
  const byConcept: Record<string, number> = {};
  for (const q of questions) {
    const cn = conceptName(q);
    byConcept[cn] = (byConcept[cn] ?? 0) + 1;
  }
  const allFlags = questions.flatMap(q => q.option_set_flags ?? []);
  const flagReasons = flagged.map(f => {
    const criterion = (f.raw_json as Record<string, unknown> | null)?.criterion;
    return typeof criterion === 'string' ? criterion : f.reason;
  });

  console.log('══════════════════════════════════════════════════════════');
  console.log('  QUALITY REVIEW');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  Accepted questions : ${questions.length}`);
  console.log(`  Flagged/rejected   : ${flagged.length}`);
  console.log(`  Total generated    : ${total}`);
  console.log(`  Acceptance rate    : ${acceptanceRate}%`);
  console.log('');
  printFreq('By difficulty level', byLevel);
  console.log('');
  printFreq('By concept', byConcept);
  console.log('');
  printFreq('Option-set flags (accepted Qs)', freq(allFlags));
  console.log('');
  printFreq('Rejection reasons (flagged_questions)', freq(flagReasons));
  console.log('══════════════════════════════════════════════════════════\n');

  // ── 5. Dump questions to markdown ────────────────────────────────────────────
  const outPath = path.join(__dirname, '..', `tmp-analysis-${pdfId.slice(0, 8)}.md`);
  const lines: string[] = [];
  lines.push(`# Question Bank: ${pdfName}`);
  lines.push(`**PDF ID:** ${pdfId}`);
  lines.push(`**Accepted:** ${questions.length}  |  **Flagged:** ${flagged.length}  |  **Acceptance rate:** ${acceptanceRate}%`);
  lines.push('');

  // Group by concept → level
  const groups: Record<string, Record<number, QuestionRow[]>> = {};
  for (const q of questions) {
    const cn = conceptName(q);
    if (!groups[cn]) groups[cn] = {};
    if (!groups[cn][q.level]) groups[cn][q.level] = [];
    groups[cn][q.level].push(q);
  }

  for (const cn of Object.keys(groups).sort()) {
    lines.push(`## ${cn}`);
    for (const lvl of [1, 2, 3]) {
      const qs = groups[cn][lvl];
      if (!qs?.length) continue;
      lines.push(`### Level ${lvl}`);
      for (const q of qs) {
        lines.push(`**Q:** ${q.stem}`);
        for (let i = 0; i < q.options.length; i++) {
          const marker = i === q.answer ? '**✓**' : '   ';
          lines.push(`${marker} ${letterOf(i)}. ${q.options[i]}`);
        }
        if (q.explanation) lines.push(`> *${q.explanation}*`);
        if (q.source_quote) lines.push(`> Source: "${q.source_quote}"`);
        if (q.option_set_flags?.length) lines.push(`> ⚠ flags: ${q.option_set_flags.join(', ')}`);
        lines.push('');
      }
    }
  }

  if (flagged.length > 0) {
    lines.push('---');
    lines.push('## Flagged / Rejected');
    for (const f of flagged) {
      const criterion = (f.raw_json as Record<string, unknown> | null)?.criterion ?? f.reason;
      lines.push(`- **${criterion}** — question_id: ${f.question_id ?? '(deleted)'}`);
      const critique = (f.raw_json as Record<string, unknown> | null)?.critique;
      if (typeof critique === 'string') lines.push(`  > ${critique}`);
    }
    lines.push('');
  }

  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`Full question dump written to:\n  ${outPath}\n`);
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
