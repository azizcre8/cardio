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

const APPLY = process.argv.includes('--apply');

function readArg(name: string): string | null {
  const prefix = `${name}=`;
  const match = process.argv.find(arg => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

const PDF_ID = readArg('--pdf-id');
const USER_ID = readArg('--user-id');
const LIMIT = Number(readArg('--limit') ?? '0') || null;
const FLAG_REASON = 'Explanation supports a different option than the stored answer key.';

type QuestionRow = {
  id: string;
  pdf_id: string;
  user_id: string;
  concept_id: string;
  stem: string;
  options: string[];
  answer: number;
  explanation: string;
  flagged: boolean;
  flag_reason: string | null;
  concepts?: { name?: string } | { name?: string }[] | null;
};

type FlaggedQuestionRow = {
  question_id: string | null;
};

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripOptionLabel(text: string): string {
  return text.replace(/^\s*[A-Ea-e][.)]\s*/, '').trim();
}

function normalizeOptionAlias(text: string): string {
  return normalizeText(stripOptionLabel(text));
}

function singularizeToken(token: string): string {
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith('ses') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss') && token.length > 3) return token.slice(0, -1);
  return token;
}

function buildOptionAliases(option: string): string[] {
  const aliases = new Set<string>();
  const cleaned = stripOptionLabel(option);
  const normalized = normalizeOptionAlias(cleaned);
  if (normalized) aliases.add(normalized);

  const noParens = cleaned.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const normalizedNoParens = normalizeText(noParens);
  if (normalizedNoParens) aliases.add(normalizedNoParens);

  for (const match of cleaned.matchAll(/\(([^)]+)\)/g)) {
    const inner = normalizeText(match[1] ?? '');
    if (inner) aliases.add(inner);
  }

  for (const alias of Array.from(aliases)) {
    const singular = alias
      .split(' ')
      .map(singularizeToken)
      .join(' ')
      .trim();
    if (singular) aliases.add(singular);
  }

  return Array.from(aliases).filter(Boolean);
}

function explanationMentionsAlias(explanation: string, alias: string): boolean {
  if (!alias) return false;
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(explanation);
}

function detectExplanationAnswerMismatch(
  options: string[],
  answer: number,
  explanation: string,
): string | null {
  const normalizedExplanation = normalizeText(explanation);
  if (!normalizedExplanation) return null;

  const firstSentence = explanation.split(/(?<=[.!?])\s+/)[0] ?? explanation;
  const positiveCue = /\b(is correct|correct because|best answer|primarily responsible|primarily explains|directly affects|defined as|refers to)\b/i;
  const negativeCue = /\b(tempting|fails because|incorrect|wrong|whereas|however|unlike|in contrast|not because)\b/i;

  const optionMatches = options.map((option, idx) => {
    const aliases = buildOptionAliases(option);
    const mentionedEarly = aliases.some(alias => explanationMentionsAlias(firstSentence, alias));
    const startsExplanation = aliases.some(alias => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      return new RegExp(`^${escaped}\\b`, 'i').test(firstSentence);
    });
    return { idx, option, mentionedEarly, startsExplanation };
  });

  const correctMatch = optionMatches[answer];
  if (!correctMatch) return null;

  const incorrectLead = optionMatches.find(match =>
    match.idx !== answer &&
    (match.startsExplanation || (match.mentionedEarly && positiveCue.test(firstSentence))) &&
    !negativeCue.test(firstSentence),
  );

  if (incorrectLead && !correctMatch.mentionedEarly) {
    return `Explanation appears to justify a different answer choice than the keyed correct answer (${incorrectLead.option}).`;
  }

  return null;
}

function getSupabaseAdmin() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl) throw new Error('Missing required environment variable: NEXT_PUBLIC_SUPABASE_URL');
  if (!serviceRoleKey) throw new Error('Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY');

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

function extractConceptName(row: QuestionRow): string {
  const concepts = row.concepts;
  if (Array.isArray(concepts)) return concepts[0]?.name ?? '';
  return concepts?.name ?? '';
}

async function loadQuestions(): Promise<QuestionRow[]> {
  const supabaseAdmin = getSupabaseAdmin();

  let query = supabaseAdmin
    .from('questions')
    .select(`
      id,
      pdf_id,
      user_id,
      concept_id,
      stem,
      options,
      answer,
      explanation,
      flagged,
      flag_reason,
      concepts(name)
    `)
    .order('created_at', { ascending: true });

  if (PDF_ID) query = query.eq('pdf_id', PDF_ID);
  if (USER_ID) query = query.eq('user_id', USER_ID);
  if (LIMIT) query = query.limit(LIMIT);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load questions: ${error.message}`);
  return (data ?? []) as QuestionRow[];
}

async function loadExistingMismatchFlags(questionIds: string[]): Promise<Set<string>> {
  if (questionIds.length === 0) return new Set<string>();
  const supabaseAdmin = getSupabaseAdmin();
  const { data, error } = await supabaseAdmin
    .from('flagged_questions')
    .select('question_id')
    .in('question_id', questionIds)
    .eq('reason', FLAG_REASON);

  if (error) throw new Error(`Failed to load existing mismatch flags: ${error.message}`);
  return new Set(
    ((data ?? []) as FlaggedQuestionRow[])
      .map(row => row.question_id)
      .filter((value): value is string => Boolean(value)),
  );
}

async function applyFlags(matches: Array<QuestionRow & { mismatch: string }>): Promise<void> {
  if (matches.length === 0) return;
  const supabaseAdmin = getSupabaseAdmin();

  const existingFlaggedQuestions = await loadExistingMismatchFlags(matches.map(match => match.id));

  for (const match of matches) {
    const nextFlagReason = match.flag_reason?.includes(FLAG_REASON)
      ? match.flag_reason
      : [match.flag_reason, FLAG_REASON].filter(Boolean).join(' | ');

    const { error: updateError } = await supabaseAdmin
      .from('questions')
      .update({
        flagged: true,
        flag_reason: nextFlagReason,
      })
      .eq('id', match.id);

    if (updateError) {
      throw new Error(`Failed to flag question ${match.id}: ${updateError.message}`);
    }

    if (!existingFlaggedQuestions.has(match.id)) {
      const { error: insertError } = await supabaseAdmin
        .from('flagged_questions')
        .insert({
          pdf_id: match.pdf_id,
          user_id: match.user_id,
          question_id: match.id,
          reason: FLAG_REASON,
          raw_json: {
            mismatch: match.mismatch,
            answer: match.answer,
            keyedOption: match.options[match.answer] ?? null,
            options: match.options,
            explanation: match.explanation,
          },
        });

      if (insertError) {
        throw new Error(`Failed to insert flagged_questions row for ${match.id}: ${insertError.message}`);
      }
    }
  }
}

async function main() {
  const questions = await loadQuestions();
  const matches = questions
    .map(question => {
      const mismatch = detectExplanationAnswerMismatch(
        question.options ?? [],
        question.answer,
        question.explanation ?? '',
      );

      return mismatch
        ? {
            ...question,
            mismatch,
          }
        : null;
    })
    .filter((value): value is QuestionRow & { mismatch: string } => value !== null);

  console.log(`Scanned ${questions.length} question(s).`);
  console.log(`Found ${matches.length} explanation/answer mismatch(es).`);

  if (matches.length > 0) {
    for (const match of matches) {
      const conceptName = extractConceptName(match);
      const keyedOption = match.options[match.answer] ?? '(missing option)';
      console.log('');
      console.log(`Question ${match.id}`);
      console.log(`PDF: ${match.pdf_id}`);
      if (conceptName) console.log(`Concept: ${conceptName}`);
      console.log(`Keyed answer: [${match.answer}] ${keyedOption}`);
      console.log(`Mismatch: ${match.mismatch}`);
      console.log(`Stem: ${match.stem}`);
    }
  }

  if (APPLY && matches.length > 0) {
    await applyFlags(matches);
    console.log('');
    console.log(`Applied flags to ${matches.length} question(s).`);
  } else if (!APPLY) {
    console.log('');
    console.log('Dry run only. Re-run with --apply to flag these questions in Supabase.');
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
