import Anthropic from '@anthropic-ai/sdk';
import referenceBank from '@/data/reference-bank.json';
import { env } from '@/lib/env';
import type { Question } from '@/types';
import { detectExplanationAnswerMismatch } from './answer-key-check';
import { verifyEvidenceSpan } from './validation';
import { dedupQuestions } from './dedup';

type RawClaudeQuestion = {
  level?: unknown;
  topic?: unknown;
  stem?: unknown;
  options?: unknown;
  answer?: unknown;
  source_quote?: unknown;
  explanation?: unknown;
};

type ReferenceExample = {
  stem?: string;
  options?: Array<{ letter?: string; text?: string }>;
  correctLetter?: string;
  explanation?: string;
  level?: string;
};

const TOKENS_PER_SEGMENT = 140_000;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : sorted[mid] ?? 0;
}

function findEvidenceOffsets(quote: string, pdfText: string): { start: number; end: number } {
  if (!quote) return { start: 0, end: 0 };
  const exact = pdfText.indexOf(quote);
  if (exact >= 0) return { start: exact, end: exact + quote.length };

  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
  const normalizedQuote = normalize(quote);
  const normalizedText = normalize(pdfText);
  const normalizedStart = normalizedText.indexOf(normalizedQuote);
  if (normalizedStart < 0) return { start: 0, end: 0 };
  return { start: normalizedStart, end: normalizedStart + normalizedQuote.length };
}

function parseClaudeJson(text: string): RawClaudeQuestion[] {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('Claude response JSON was not an array');
    return parsed as RawClaudeQuestion[];
  } catch (firstError) {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) throw firstError;
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) throw new Error('Claude response JSON was not an array');
    return parsed as RawClaudeQuestion[];
  }
}

function randomExample(level: 'L1' | 'L2' | 'L3'): ReferenceExample {
  const examples = (referenceBank as ReferenceExample[]).filter(example => example.level === level);
  if (!examples.length) return {};
  return examples[Math.floor(Math.random() * examples.length)] ?? examples[0] ?? {};
}

function formatFewShot(example: ReferenceExample): string {
  const correctLetter = example.correctLetter ?? '';
  const optionLines = (example.options ?? []).map(option => {
    const letter = option.letter ?? '';
    const marker = letter === correctLetter ? ' ★ (correct)' : '';
    return `${letter}) ${option.text ?? ''}${marker}`;
  });

  return [
    `Stem: ${example.stem ?? ''}`,
    ...optionLines,
    `Explanation: ${example.explanation ?? ''}`,
  ].join('\n');
}

function buildPrompt(pdfText: string, targetCount: number): string {
  const fewShotL1 = formatFewShot(randomExample('L1'));
  const fewShotL2 = formatFewShot(randomExample('L2'));
  const fewShotL3 = formatFewShot(randomExample('L3'));

  return `You are a medical education expert creating board-style MCQs.

STEP 1 — COVERAGE MAP (do this silently before generating any questions):
Read the entire text. Identify every major section or topic. Count them.
Divide ${targetCount} questions proportionally across those sections so no single
section receives more than 30% of the total questions. Keep this map in mind
throughout generation.

STEP 2 — GENERATE the questions according to these requirements:
1. Distribute questions across the ENTIRE document per your coverage map — late sections must be represented equally to early ones
2. Mix: ~40% 1st-order (recall of specific values/facts), ~35% 2nd-order (comprehension/application), ~25% 3rd-order (analysis/clinical reasoning/calculation)
3. LOW DISCRIMINABILITY — answer choices must be intentionally similar (e.g. nearby numbers, related mechanisms, related anatomical structures). This is the most important requirement.
4. EQUAL OPTION LENGTH — all answer choices must be within ±20% of each other in word count. The correct answer must NEVER be the longest option. If the correct answer requires detail, make the distractors equally detailed/specific. A student should not be able to identify the correct answer by length alone.
5. Each question MUST include a verbatim quote (≥10 words) from the text body (NOT from the references or bibliography section) that directly supports the correct answer
6. Include a brief explanation (2 sentences: why correct, why closest wrong answer fails)
7. 1st-order questions: 5 options (A–E). 2nd/3rd-order: 4 or 5 options
8. No 'All of the above' / 'None of the above'

--- EXAMPLES OF THE EXACT QUALITY REQUIRED ---

1st-order example:
${fewShotL1}

2nd-order example:
${fewShotL2}

3rd-order example:
${fewShotL3}

--- END EXAMPLES ---

Return ONLY a JSON array (no markdown, no wrapper):
[{
  "level": 1,
  "topic": "brief topic label (3–6 words)",
  "stem": "question stem",
  "options": ["...", "...", "...", "...", "..."],
  "answer": 0,
  "source_quote": "exact verbatim quote from the text body",
  "explanation": "why correct + why closest distractor fails"
}]

--- MEDICAL TEXT ---
${pdfText}`;
}

function splitTextIntoSegments(pdfText: string): string[] {
  const lines = pdfText.split(/\n/);
  const headingIndices: number[] = [];
  const headingPattern = /^\s*(?:[IVXLCDM]+\b[.)-]?|[A-Z][A-Z0-9 ,:;()/-]{5,})\s*$/;

  lines.forEach((line, index) => {
    if (headingPattern.test(line.trim())) headingIndices.push(index);
  });

  const segments: string[] = [];
  if (headingIndices.length) {
    for (let i = 0; i < headingIndices.length; i += 1) {
      const start = headingIndices[i] ?? 0;
      const end = headingIndices[i + 1] ?? lines.length;
      const segment = lines.slice(start, end).join('\n').trim();
      if (segment) segments.push(segment);
    }
  }

  const sourceSegments = segments.length ? segments : [pdfText];
  const maxChars = TOKENS_PER_SEGMENT * 4;
  const boundedSegments: string[] = [];
  for (const segment of sourceSegments) {
    if (estimateTokens(segment) <= TOKENS_PER_SEGMENT) {
      boundedSegments.push(segment);
      continue;
    }
    for (let start = 0; start < segment.length; start += maxChars) {
      boundedSegments.push(segment.slice(start, start + maxChars));
    }
  }

  return boundedSegments;
}

async function callClaude(prompt: string): Promise<{ rawQuestions: RawClaudeQuestion[]; costUSD: number }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable is not set');
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: env.GENERATION_MODEL,
    max_tokens: 16000,
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content[0];
  const text = textBlock && 'text' in textBlock ? textBlock.text : '';
  const rawQuestions = parseClaudeJson(text);
  const INPUT_COST_PER_M = env.GENERATION_MODEL.includes('opus') ? 15 : 3;
  const OUTPUT_COST_PER_M = env.GENERATION_MODEL.includes('opus') ? 75 : 15;
  const costUSD = (response.usage.input_tokens / 1_000_000) * INPUT_COST_PER_M
    + (response.usage.output_tokens / 1_000_000) * OUTPUT_COST_PER_M;

  return { rawQuestions, costUSD };
}

function toQuestion(raw: RawClaudeQuestion, pdfText: string, pdfId: string, userId: string): Question {
  const options = Array.isArray(raw.options)
    ? raw.options.filter((option): option is string => typeof option === 'string')
    : [];
  const answer = typeof raw.answer === 'number' ? raw.answer : 0;
  const sourceQuote = typeof raw.source_quote === 'string' ? raw.source_quote : '';
  const offsets = findEvidenceOffsets(sourceQuote, pdfText);
  const evidenceResult = verifyEvidenceSpan(sourceQuote, offsets.start, offsets.end, pdfText);

  let flagged = false;
  let flagReason: string | null = null;
  let optionSetFlags: string[] | null = null;

  const explanation = typeof raw.explanation === 'string' ? raw.explanation : '';
  const mismatch = detectExplanationAnswerMismatch(options, answer, explanation);
  if (mismatch) {
    flagged = true;
    flagReason = 'ANSWER_KEY_MISMATCH';
  }

  if (evidenceResult.evidenceMatchType === 'none') {
    flagged = true;
    flagReason = flagReason ?? 'QUOTE_NOT_FOUND';
  }

  const correctOption = options[answer] ?? '';
  const optionLengths = options.map(wordCount);
  const medianOptionLength = median(optionLengths);
  if (medianOptionLength > 0 && wordCount(correctOption) > medianOptionLength * 1.2) {
    optionSetFlags = ['LENGTH_TELL'];
    flagged = true;
  }

  return {
    id: crypto.randomUUID(),
    pdf_id: pdfId,
    user_id: userId,
    concept_id: null,
    level: raw.level === 2 || raw.level === 3 ? raw.level : 1,
    stem: typeof raw.stem === 'string' ? raw.stem : '',
    options,
    answer,
    source_quote: sourceQuote,
    explanation,
    evidence_match_type: evidenceResult.evidenceMatchType ?? 'none',
    evidence_start: offsets.start,
    evidence_end: offsets.end,
    chunk_id: null,
    flagged,
    decision_target: null,
    deciding_clue: null,
    most_tempting_distractor: null,
    why_tempting: null,
    why_fails: null,
    option_set_flags: optionSetFlags,
    flag_reason: flagReason,
    option_explanations: null,
    created_at: new Date().toISOString(),
  };
}

export async function generateQuestionsWithClaude(
  pdfText: string,
  targetCount: number,
  pdfId: string,
  userId: string,
  onProgress?: (msg: string) => void,
): Promise<{ questions: Question[]; costUSD: number }> {
  const totalTokens = estimateTokens(pdfText);
  const segments = totalTokens <= TOKENS_PER_SEGMENT ? [pdfText] : splitTextIntoSegments(pdfText);
  const segmentTokens = segments.map(estimateTokens);
  const tokenDenominator = segmentTokens.reduce((sum, tokens) => sum + tokens, 0) || totalTokens || 1;

  let costUSD = 0;
  const questions: Question[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] ?? '';
    const segmentTarget = segments.length === 1
      ? targetCount
      : Math.max(1, Math.round(targetCount * (segmentTokens[i] ?? 0) / tokenDenominator));
    onProgress?.(`Generating questions for segment ${i + 1}/${segments.length}…`);

    const result = await callClaude(buildPrompt(segment, segmentTarget));
    costUSD += result.costUSD;
    questions.push(...result.rawQuestions.map(raw => toQuestion(raw, pdfText, pdfId, userId)));
  }

  const dedupResult = await dedupQuestions(questions, {});
  return {
    questions: dedupResult.kept.map(question => ({
      ...question,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
    })),
    costUSD,
  };
}
