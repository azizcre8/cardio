import { NextRequest } from 'next/server';
import OpenAI from 'openai';
import { buildDeterministicQuestionValidation } from '@/lib/pipeline/question-validation';
import type { Question, Chunk } from '@/types';
import { requireUser } from '@/lib/auth';
import { env } from '@/lib/env';
import { jsonBadRequest, jsonNotFound, jsonOk, parseJsonBody } from '@/lib/api';

type ValidatePayload = {
  pdfId?: string;
  questionId?: string;
  stem?: string;
  options?: string[];
  answer?: number;
  explanation?: string;
  sourceQuote?: string;
};

type Confidence = 'high' | 'medium' | 'low';

type ValidatorResponse = {
  isValid: boolean;
  issues: string[];
  suggestedFix: string;
  confidence: Confidence;
};

type QuestionRow = Pick<
  Question,
  | 'id'
  | 'pdf_id'
  | 'concept_id'
  | 'level'
  | 'stem'
  | 'options'
  | 'answer'
  | 'explanation'
  | 'source_quote'
  | 'evidence_start'
  | 'evidence_end'
  | 'chunk_id'
  | 'decision_target'
  | 'deciding_clue'
  | 'most_tempting_distractor'
  | 'option_set_flags'
>;

type ConceptRow = {
  id: string;
  name: string;
  category: string;
  chunk_ids: string[] | null;
};

export const runtime = 'nodejs';
export const maxDuration = 30;

function getOpenAI(): OpenAI {
  return new OpenAI({ apiKey: env.openAiApiKey });
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactIssue(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function canonicalizeIssue(text: string): string {
  const normalized = normalizeText(text);

  if (normalized.includes('key distinction') && (normalized.includes('missing') || normalized.includes('lacks'))) {
    return 'missing_key_distinction';
  }

  if (
    (normalized.includes('contrast') || normalized.includes('distractor')) &&
    (normalized.includes('explanation does not') || normalized.includes('explanation lacks'))
  ) {
    return 'missing_distractor_contrast';
  }

  if (
    normalized.includes('source quote') &&
    (normalized.includes('could not be verified') || normalized.includes('does not provide specific evidence'))
  ) {
    return 'source_quote_not_verified';
  }

  if (
    normalized.includes('correct answer') &&
    (normalized.includes('not clearly supported') || normalized.includes('does not support'))
  ) {
    return 'correct_answer_not_supported';
  }

  if (normalized.includes('fabricated distractor')) {
    return 'fabricated_distractor';
  }

  return normalized;
}

function takeUnique(items: string[], limit = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items.map(compactIssue)) {
    const canonical = canonicalizeIssue(item);
    if (!item || seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function scoreChunk(text: string, queryTerms: string[]): number {
  const normalized = normalizeText(text);
  return queryTerms.reduce((score, term) => {
    if (!term) return score;
    return normalized.includes(term) ? score + Math.max(1, term.length / 8) : score;
  }, 0);
}

function selectRelevantChunks(
  chunks: Array<Pick<Chunk, 'id' | 'text' | 'start_page' | 'end_page'>>,
  query: string,
  limit = 4,
): Array<Pick<Chunk, 'id' | 'text' | 'start_page' | 'end_page'>> {
  const queryTerms = Array.from(
    new Set(
      normalizeText(query)
        .split(' ')
        .filter(term => term.length >= 4),
    ),
  );

  return [...chunks]
    .map(chunk => ({ chunk, score: scoreChunk(chunk.text, queryTerms) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(entry => entry.chunk);
}

// Issues from the deterministic validator that are structural/metadata,
// not factual — suppress these from the user-facing fact-check result.
const STRUCTURAL_ISSUE_PATTERNS = [
  /whyTempting/i,
  /whyFails/i,
  /why_tempting/i,
  /why_fails/i,
  /missing.*rationale/i,
  /rationale.*missing/i,
  /item.design/i,
  /option.count/i,
  /exactly \d+ choice/i,
];

function isStructuralIssue(issue: string): boolean {
  return STRUCTURAL_ISSUE_PATTERNS.some(re => re.test(issue));
}

function buildProgrammaticIssues(
  question: QuestionRow,
  conceptName: string | null,
  evidenceCorpus: string,
): { issues: string[]; evidenceOk: boolean } {
  const result = buildDeterministicQuestionValidation(
    {
      ...question,
      user_id: '',
      evidence_match_type: null,
      why_tempting: null,
      why_fails: null,
      flagged: false,
      flag_reason: null,
    },
    conceptName,
    evidenceCorpus,
  );
  const factualIssues = takeUnique(result.issues.filter(i => !isStructuralIssue(i)));
  return { issues: factualIssues, evidenceOk: result.evidenceOk };
}

function buildFallbackResponse(programmaticIssues: string[], evidenceOk: boolean): ValidatorResponse {
  const issues = takeUnique(programmaticIssues);
  return {
    isValid: issues.length === 0 && evidenceOk,
    issues,
    suggestedFix: issues[0] ?? 'Question aligns with the current PDF-grounding and answer-choice checks.',
    confidence: evidenceOk ? 'medium' : 'low',
  };
}

export async function POST(req: NextRequest) {
  const parsedBody = await parseJsonBody<ValidatePayload>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;

  const pdfId = String(body.pdfId ?? '').trim();
  const questionId = String(body.questionId ?? '').trim();

  if (!pdfId || !questionId) {
    return jsonBadRequest('pdfId and questionId are required.');
  }

  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const { supabase, userId } = auth;

  const { data: questionData, error: questionError } = await supabase
    .from('questions')
    .select(`
      id,
      pdf_id,
      concept_id,
      level,
      stem,
      options,
      answer,
      explanation,
      source_quote,
      evidence_start,
      evidence_end,
      chunk_id,
      decision_target,
      deciding_clue,
      most_tempting_distractor,
      option_set_flags
    `)
    .eq('id', questionId)
    .eq('pdf_id', pdfId)
    .eq('user_id', userId)
    .single();

  if (questionError || !questionData) return jsonNotFound('Question not found.');

  const question = questionData as QuestionRow;

  const { data: conceptData } = await supabase
    .from('concepts')
    .select('id, name, category, chunk_ids')
    .eq('id', question.concept_id)
    .eq('pdf_id', pdfId)
    .eq('user_id', userId)
    .single();

  const concept = (conceptData ?? null) as ConceptRow | null;

  let chunkQuery = supabase
    .from('chunks')
    .select('id, text, start_page, end_page')
    .eq('pdf_id', pdfId)
    .eq('user_id', userId);

  if (question.chunk_id) {
    chunkQuery = chunkQuery.eq('id', question.chunk_id);
  } else if (concept?.chunk_ids?.length) {
    chunkQuery = chunkQuery.in('id', concept.chunk_ids.slice(0, 12));
  } else {
    chunkQuery = chunkQuery.limit(12);
  }

  const { data: chunkData } = await chunkQuery;
  const candidateChunks = (chunkData ?? []) as Array<Pick<Chunk, 'id' | 'text' | 'start_page' | 'end_page'>>;
  const relevantChunks = selectRelevantChunks(
    candidateChunks,
    [
      question.stem,
      question.source_quote,
      concept?.name ?? '',
      question.deciding_clue ?? '',
    ].join(' '),
  );
  const evidenceCorpus = relevantChunks.map(chunk => chunk.text).join('\n');

  const programmatic = buildProgrammaticIssues(question, concept?.name ?? null, evidenceCorpus);
  const fallback = buildFallbackResponse(programmatic.issues, programmatic.evidenceOk);

  if (!env.openAiApiKey) {
    return jsonOk(fallback);
  }

  const prompt = `
You are a medical fact-checker. Your job is to fact-check a multiple-choice question and all its answer choices against the provided source text from the original PDF.

Return valid JSON only in this exact shape:
{
  "isValid": boolean,
  "issues": string[],
  "suggestedFix": string,
  "confidence": "high" | "medium" | "low"
}

Fact-check each part of this question against the source text from the PDF.

Check in order:
1. Is the correct answer directly supported by the source text?
2. Are all factual claims in the question stem accurate per the source text?
3. Is each wrong answer choice clearly incorrect — not ambiguously correct, and not containing false medical facts that aren't grounded in the source?
4. Does the source quote actually support the correct answer?

Known source-grounding findings:
${programmatic.issues.length ? programmatic.issues.map(issue => `- ${issue}`).join('\n') : '- none'}

Question:
Concept: ${concept?.name ?? 'unknown'}
Stem: ${question.stem}
Answer choices:
${question.options.map((opt, i) => `  ${String.fromCharCode(65 + i)}. ${opt}${i === question.answer ? ' ← CORRECT' : ''}`).join('\n')}
Explanation: ${question.explanation}
Source quote: ${question.source_quote ?? 'none'}

Source text from PDF:
${relevantChunks.length
  ? relevantChunks.map((chunk, i) => `[Excerpt ${i + 1}, pages ${chunk.start_page}–${chunk.end_page}]\n${chunk.text.slice(0, 1800)}`).join('\n\n')
  : 'No source text available.'}

Output rules:
- issues must be an array of strings. Each string must be a complete sentence describing a specific factual problem, e.g. "Choice B states X but the source text says Y." or "The stem claims X which is not supported by the source."
- Do NOT put bare labels like "stem" or "A" as issue strings — every issue must be a complete sentence.
- isValid = true only if the correct answer and stem are fully supported and no wrong choice is ambiguously correct.
- suggestedFix: one complete sentence naming the single most important factual correction.
- confidence: "high" if source text directly addresses the question, "medium" if partial, "low" if insufficient.
- Max 4 issues.
`.trim();

  try {
    const openai = getOpenAI();
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 480,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return jsonOk(fallback);

    const rawContent = content.trim().replace(/^```[a-z]*\s*/i, '').replace(/\s*```\s*$/i, '');
    const parsed = JSON.parse(rawContent) as Partial<ValidatorResponse>;

    // Guard: LLM sometimes returns issues as an object {stem: "...", A: "..."} instead of array
    let llmIssues: string[] = [];
    if (Array.isArray(parsed.issues)) {
      llmIssues = parsed.issues.map(item => String(item)).filter(s => s.length > 10);
    } else if (parsed.issues && typeof parsed.issues === 'object') {
      llmIssues = Object.values(parsed.issues as Record<string, unknown>)
        .map(v => String(v))
        .filter(s => s.length > 10);
    }

    const mergedIssues = takeUnique([...programmatic.issues, ...llmIssues]);

    const isValid =
      Boolean(parsed.isValid) &&
      mergedIssues.length === 0 &&
      programmatic.evidenceOk;

    const confidence = (parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low')
      ? parsed.confidence
      : fallback.confidence;

    return jsonOk({
      isValid,
      issues: mergedIssues,
      suggestedFix: String(parsed.suggestedFix ?? fallback.suggestedFix),
      confidence,
    } satisfies ValidatorResponse);
  } catch (error) {
    console.error('[questions/validate] validation failed:', error);
    return jsonOk(fallback);
  }
}
