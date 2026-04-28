import Anthropic from '@anthropic-ai/sdk';
import { jsonrepair } from 'jsonrepair';
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
  sourceQuote?: unknown;
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

function stripTrailingLengthTellClause(text: string): string {
  const trimmed = text.trim();
  const sentenceParts = trimmed.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentenceParts.length > 1) {
    return sentenceParts.slice(0, -1).join(' ').trim();
  }

  return trimmed
    .replace(
      /(?:\s*[,;:]\s*|\s+-\s+|\s+)(?:because|which|allowing|while|since|as|so that)\b[\s\S]*$/i,
      '',
    )
    .replace(/[\s,;:.-]+$/g, '')
    .trim();
}

function isWithinLengthTellThreshold(correctOption: string, otherOptions: string[]): boolean {
  const medianOtherLength = median(otherOptions.map(wordCount));
  return medianOtherLength > 0 && wordCount(correctOption) <= medianOtherLength * 1.4;
}

function trimLengthTell(question: Question): Question {
  const flags = question.option_set_flags ?? [];
  if (!flags.includes('LENGTH_TELL')) return question;

  const correctOption = question.options[question.answer];
  if (typeof correctOption !== 'string') return question;

  const otherOptions = question.options.filter((_, index) => index !== question.answer);
  const trimmedCorrectOption = stripTrailingLengthTellClause(correctOption);
  if (!trimmedCorrectOption || trimmedCorrectOption === correctOption.trim()) return question;
  if (!isWithinLengthTellThreshold(trimmedCorrectOption, otherOptions)) return question;

  const nextFlags = flags.filter(flag => flag !== 'LENGTH_TELL');
  const nextOptions = [...question.options];
  nextOptions[question.answer] = trimmedCorrectOption;

  return {
    ...question,
    options: nextOptions,
    option_set_flags: nextFlags.length ? nextFlags : null,
    flagged: nextFlags.length > 0 || question.flag_reason !== null,
  };
}

function findEvidenceOffsets(quote: string, pdfText: string): { start: number | null; end: number | null } {
  if (!quote) return { start: null, end: null };
  const exact = pdfText.indexOf(quote);
  if (exact >= 0) return { start: exact, end: exact + quote.length };

  const normalizedQuote = normalizeEvidenceForSearch(quote);
  if (!normalizedQuote) return { start: null, end: null };

  const normalizedText = buildNormalizedEvidenceIndex(pdfText);
  const normalizedStart = normalizedText.text.indexOf(normalizedQuote);
  if (normalizedStart >= 0) {
    const normalizedEnd = normalizedStart + normalizedQuote.length;
    const start = normalizedText.originalIndices[normalizedStart] ?? null;
    const endBase = normalizedText.originalIndices[normalizedEnd - 1] ?? null;
    if (start !== null && endBase !== null) {
      return { start, end: endBase + 1 };
    }
  }

  return { start: null, end: null };
}

function normalizeEvidenceChar(char: string): string {
  if (/[\u2018\u2019\u201A\u201B\u2032\u2035]/.test(char)) return "'";
  if (/[\u201C\u201D\u201E\u201F\u2033\u2036]/.test(char)) return '"';
  if (/[\u2013\u2014\u2015]/.test(char)) return '-';
  return char.toLowerCase();
}

function normalizeEvidenceForSearch(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2013\u2014\u2015]/g, '-')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

function buildNormalizedEvidenceIndex(text: string): { text: string; originalIndices: number[] } {
  let normalized = '';
  const originalIndices: number[] = [];
  let pendingWhitespaceIndex: number | null = null;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (/\s/.test(char)) {
      if (normalized.length > 0) pendingWhitespaceIndex = pendingWhitespaceIndex ?? index;
      continue;
    }

    if (pendingWhitespaceIndex !== null) {
      normalized += ' ';
      originalIndices.push(pendingWhitespaceIndex);
      pendingWhitespaceIndex = null;
    }

    normalized += normalizeEvidenceChar(char);
    originalIndices.push(index);
  }

  const trimmedNormalized = normalized.trimEnd();
  return { text: trimmedNormalized, originalIndices: originalIndices.slice(0, trimmedNormalized.length) };
}

function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const withoutOpen = trimmed.replace(/^```[a-z]*\s*/i, '');
  const withoutClose = withoutOpen.replace(/\s*```\s*$/i, '');
  return withoutClose.trim();
}

function extractFirstJsonArray(text: string): string | null {
  const start = text.indexOf('[');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '[') depth += 1;
    if (char === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return null;
}

function prepareClaudeJsonForRepair(text: string): string {
  let prepared = '';
  let inString = false;
  let escaped = false;
  const stack: string[] = [];

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      prepared += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      prepared += char;
      escaped = inString;
      continue;
    }

    if (char === '"') {
      if (inString) {
        const nextJsonChar = text.slice(index + 1).match(/\S/)?.[0] ?? '';
        if (nextJsonChar && ![',', '}', ']', ':'].includes(nextJsonChar)) {
          prepared += '\\"';
          continue;
        }
      }

      inString = !inString;
      prepared += char;
      continue;
    }

    if (!inString) {
      if (char === '[' || char === '{') stack.push(char);
      if (char === ']' && stack.at(-1) === '[') stack.pop();
      if (char === '}' && stack.at(-1) === '{') stack.pop();
    }

    prepared += char;
  }

  if (inString) prepared += '"';

  while (stack.length) {
    const opener = stack.pop();
    prepared += opener === '[' ? ']' : '}';
  }

  return prepared;
}

export function parseClaudeJson(text: string): RawClaudeQuestion[] {
  const trimmed = text.trim();
  const prosePrefix = trimmed.slice(0, 20).toLowerCase();
  if (
    prosePrefix.startsWith('i ') ||
    prosePrefix.startsWith("i'") ||
    prosePrefix.startsWith('sorry') ||
    prosePrefix.startsWith('as an ai')
  ) {
    throw new Error('Claude returned prose instead of JSON: ' + text);
  }

  const stripped = stripMarkdownFence(text);

  let firstError: unknown;

  try {
    const parsed = JSON.parse(stripped);
    if (!Array.isArray(parsed)) throw new Error('Claude response JSON was not an array');
    return parsed as RawClaudeQuestion[];
  } catch (error) {
    firstError = error;
  }

  const arrayText = extractFirstJsonArray(stripped);
  if (arrayText) {
    try {
      const parsed = JSON.parse(arrayText);
      if (!Array.isArray(parsed)) throw new Error('Claude response JSON was not an array');
      return parsed as RawClaudeQuestion[];
    } catch {
      // Continue to jsonrepair fallback below.
    }
  }

  if (arrayText) {
    try {
      const repaired = jsonrepair(arrayText);
      const parsed = JSON.parse(repaired);
      if (!Array.isArray(parsed)) throw new Error('Claude response JSON was not an array');
      return parsed as RawClaudeQuestion[];
    } catch {
      // Continue to full-response jsonrepair fallback below.
    }
  }

  try {
    const repaired = jsonrepair(prepareClaudeJsonForRepair(stripped));
    const parsed = JSON.parse(repaired);
    if (!Array.isArray(parsed)) throw new Error('Claude response JSON was not an array');
    return parsed as RawClaudeQuestion[];
  } catch {
    throw firstError;
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

STEP 1 — COVERAGE MAP (do this silently before generating):
Read the entire text. Identify every major section or topic. Divide ${targetCount} questions proportionally across those sections so no single section receives more than 30% of the total questions.

STEP 2 — GENERATE the questions:
1. Distribute questions across the ENTIRE document per your coverage map — late sections must be covered equally to early ones
2. Level mix: ≤15% 1st-order (recall of specific values/facts), ≥40% 2nd-order (mechanism, cause-effect, application), ≥45% 3rd-order (clinical vignette). Every 3rd-order question MUST open with a patient scenario: "A [age]-year-old [sex] presents with..." then ask about mechanism, diagnosis, or physiological consequence
3. LOW DISCRIMINABILITY — answer choices must be intentionally similar (e.g. nearby numbers, related mechanisms, related anatomical structures). This is the most important requirement.
4. EQUAL OPTION LENGTH — all answer choices must be approximately the same length. The correct answer must NEVER be the longest option. If the correct answer needs detail, make all distractors equally detailed.
5. Each question MUST include a verbatim quote (≥10 words) from the text body (NOT from references or bibliography) that directly supports the correct answer
6. Include a brief explanation (2 sentences: why correct, why the closest wrong answer fails)
7. 1st-order questions: 5 options (A–E). 2nd/3rd-order: 4 or 5 options
8. No 'All of the above' / 'None of the above' / negatively worded stems (do not use "which is NOT..." or "which does NOT...")
9. RANDOMISE CORRECT ANSWER POSITION — distribute the correct answer index roughly evenly across positions 0–4. Aim for each position to be correct ~20% of the time.

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

// Returns the instruction-only portion of the L1/L2 prompt (no PDF text).
// The PDF text is passed as a separate cached context block in callClaude.
function buildL1L2Instructions(targetCount: number): string {
  const fewShotL1 = formatFewShot(randomExample('L1'));
  const fewShotL2 = formatFewShot(randomExample('L2'));

  return `You are a medical education expert creating board-style MCQs from the provided medical text.

STEP 1 — COVERAGE MAP (do this silently before generating):
Identify every major section or topic in the provided medical text. Divide ${targetCount} questions proportionally across those sections so no single section receives more than 30% of the total questions.

STEP 2 — GENERATE only 1st-order and 2nd-order questions:
1. Distribute questions across the ENTIRE document per your coverage map
2. Level mix: ~25% 1st-order (recall of specific values/facts), ~75% 2nd-order (mechanism, cause-effect, application). Do NOT generate any 3rd-order questions.
3. LOW DISCRIMINABILITY — answer choices must be intentionally similar (e.g. nearby numbers, related mechanisms, related anatomical structures). This is the most important requirement.
4. EQUAL OPTION LENGTH — all answer choices must be approximately the same length. The correct answer must NEVER be the longest option.
5. Each question MUST include a verbatim quote (≥10 words) from the text body (NOT from references or bibliography) that directly supports the correct answer
6. Include a brief explanation (2 sentences: why correct, why the closest wrong answer fails)
7. 1st-order questions: 5 options (A–E). 2nd-order: 4 or 5 options
8. No 'All of the above' / 'None of the above' / negatively worded stems (do not use "which is NOT..." or "which does NOT...")
9. RANDOMISE CORRECT ANSWER POSITION — distribute the correct answer index roughly evenly across positions 0–4.

--- EXAMPLES ---

1st-order example:
${fewShotL1}

2nd-order example:
${fewShotL2}

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

IMPORTANT: You MUST respond with a valid JSON array only. If you cannot generate any questions, respond with an empty array: []. Never explain, apologise, or return prose — return JSON exclusively.`;
}

// Returns the instruction-only portion of the L3 prompt (no PDF text).
function buildL3Instructions(targetCount: number): string {
  const fewShotL3 = formatFewShot(randomExample('L3'));

  return `You are a medical education expert creating board-style clinical vignette MCQs from the provided medical text.

STEP 1 — COVERAGE MAP (do this silently before generating):
Identify every major clinical concept, mechanism, or syndrome in the provided medical text. Divide ${targetCount} questions across those concepts so each is represented.

STEP 2 — GENERATE only 3rd-order clinical vignette questions:
1. When the text contains or implies clinical content, open questions with a patient scenario ('A [age]-year-old [sex] presents with...'). When the text is purely basic science, write 3rd-order questions that require multi-step reasoning or synthesis across concepts instead.
2. Cover different clinical scenarios — vary patient age, sex, and presenting complaint across questions
3. LOW DISCRIMINABILITY — answer choices must be intentionally similar (related mechanisms, related diagnoses). This is the most important requirement.
4. EQUAL OPTION LENGTH — all answer choices must be approximately the same length. The correct answer must NEVER be the longest option.
5. Each question MUST include a verbatim quote (≥10 words) from the text body (NOT from references or bibliography) that directly supports the correct answer
6. Include a brief explanation (2 sentences: why correct, why the closest wrong answer fails)
7. 4 or 5 options per question
8. No 'All of the above' / 'None of the above' / negatively worded stems
9. RANDOMISE CORRECT ANSWER POSITION across positions 0–3 or 0–4.

--- EXAMPLE ---

3rd-order example:
${fewShotL3}

--- END EXAMPLE ---

Return ONLY a JSON array (no markdown, no wrapper):
[{
  "level": 3,
  "topic": "brief topic label (3–6 words)",
  "stem": "question stem",
  "options": ["...", "...", "...", "...", "..."],
  "answer": 0,
  "source_quote": "exact verbatim quote from the text body",
  "explanation": "why correct + why closest distractor fails"
}]

IMPORTANT: You MUST respond with a valid JSON array only. If you cannot generate any questions, respond with an empty array: []. Never explain, apologise, or return prose — return JSON exclusively.`;
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
    const preamble = lines.slice(0, headingIndices[0] ?? 0).join('\n').trim();
    if (preamble) segments.push(preamble);

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

function extractSections(text: string): Array<{ heading: string; content: string }> {
  const lines = text.split(/\n/);
  const headingIndices: number[] = [];
  const headingPattern = /^\s*(?:[IVXLCDM]+\b[.)-]?|[A-Z][A-Z0-9 ,:;()/-]{5,})\s*$/;

  lines.forEach((line, index) => {
    if (headingPattern.test(line.trim())) headingIndices.push(index);
  });

  return headingIndices
    .map((start, index) => {
      const end = headingIndices[index + 1] ?? lines.length;
      const heading = (lines[start] ?? '').trim();
      const content = lines.slice(start, end).join('\n').trim();
      return { heading, content };
    })
    .filter(section => section.heading && section.content);
}

function allocateTargetsByTokens(texts: string[], targetCount: number): number[] {
  if (!texts.length || targetCount <= 0) return [];

  const tokenCounts = texts.map(text => Math.max(0, estimateTokens(text.trim())));
  if (tokenCounts.every(tokens => tokens === 0)) return texts.map(() => 0);

  const denominator = tokenCounts.reduce((sum, tokens) => sum + tokens, 0) || 1;
  const rawTargets = tokenCounts.map(tokens => (targetCount * tokens) / denominator);
  const targets = rawTargets.map(raw => Math.floor(raw));
  let delta = targetCount - targets.reduce((sum, target) => sum + target, 0);

  const fractionalOrder = rawTargets
    .map((raw, index) => ({ index, fraction: raw - Math.floor(raw) }))
    .filter(entry => (tokenCounts[entry.index] ?? 0) > 0)
    .sort((a, b) => b.fraction - a.fraction || (tokenCounts[b.index] ?? 0) - (tokenCounts[a.index] ?? 0));

  for (let i = 0; delta > 0 && fractionalOrder.length; i += 1, delta -= 1) {
    const targetIndex = fractionalOrder[i % fractionalOrder.length]?.index ?? 0;
    targets[targetIndex] = (targets[targetIndex] ?? 0) + 1;
  }

  return targets;
}

function getClaudeCostRates(model: string): { inputCostPerM: number; outputCostPerM: number } {
  const normalized = model.toLowerCase();
  if (normalized.includes('opus')) return { inputCostPerM: 15, outputCostPerM: 75 };
  if (normalized.includes('haiku')) return { inputCostPerM: 0.8, outputCostPerM: 4 };
  if (normalized.includes('sonnet')) return { inputCostPerM: 3, outputCostPerM: 15 };

  console.warn('Unknown Claude generation model "' + model + '", using Sonnet pricing fallback.');
  return { inputCostPerM: 3, outputCostPerM: 15 };
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof Anthropic.AuthenticationError) return false;
  if (error instanceof Anthropic.PermissionDeniedError) return false;
  if (error instanceof Anthropic.InvalidRequestError) return false;
  if (error instanceof Anthropic.APIStatusError && error.status < 500) return false;
  if (error instanceof Anthropic.APIConnectionError) return true;
  if (error instanceof Anthropic.APIConnectionTimeoutError) return true;
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    msg.includes('network error') ||
    msg.includes('fetch failed') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('econnrefused') ||
    msg.includes('socket hang up') ||
    msg.includes('und_err_socket') ||
    msg.includes('connection error')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// context   — the PDF segment text, sent as a cached content block (same across all batches
//             for a given segment, so batches 2-N pay only 10% of normal input cost).
// instructions — the task-specific prompt (question count, few-shot examples); not cached.
async function callClaude(
  context: string,
  instructions: string,
  model?: string,
): Promise<{ rawQuestions: RawClaudeQuestion[]; costUSD: number }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable is not set');
  const client = new Anthropic({ apiKey });
  const normalizedInstructions = instructions
    .replace(/the medical text above/g, 'the provided medical text')
    .replace(/the text above/g, 'the provided medical text');
  const MAX_RETRIES = 3;
  let response: Anthropic.Message | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const stream = client.messages.stream({
        model: model ?? env.GENERATION_MODEL,
        max_tokens: 14000,
        messages: [{
          role: 'user',
          content: [
            // The PDF segment is the large stable block — mark it for caching.
            { type: 'text', text: `--- MEDICAL TEXT ---\n${context}`, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: normalizedInstructions },
          ],
        }],
      });
      response = await stream.finalMessage();
      break;
    } catch (error) {
      if (attempt >= MAX_RETRIES || !isRetryableError(error)) {
        throw error;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      const waitMs = attempt * 1000;
      console.warn(`callClaude: retrying Anthropic stream after attempt ${attempt} failed: ${errorMessage}`);
      await sleep(waitMs);
    }
  }

  if (!response) {
    throw new Error('Claude returned no response');
  }

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock || !('text' in textBlock) || !textBlock.text.trim()) {
    throw new Error(`Claude returned no text content (stop_reason: ${response.stop_reason})`);
  }
  const text = textBlock.text;
  const rawQuestions = parseClaudeJson(text);
  const usedModel = model ?? env.GENERATION_MODEL;
  const { inputCostPerM, outputCostPerM } = getClaudeCostRates(usedModel);
  const usage = response.usage as {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  // Cache write costs 1.25× normal; cache read costs 0.1× normal.
  const costUSD =
    (usage.input_tokens / 1_000_000) * inputCostPerM +
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * inputCostPerM * 1.25 +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * inputCostPerM * 0.1 +
    (usage.output_tokens / 1_000_000) * outputCostPerM;

  return { rawQuestions, costUSD };
}

const GENERATION_BATCH_SIZE = 30;

async function callClaudeInBatches(
  buildInstructionsFn: (count: number) => string,
  segment: string,
  totalTarget: number,
  model: string,
  deadlineMs?: number,
): Promise<{ rawQuestions: RawClaudeQuestion[]; costUSD: number; errors: unknown[] }> {
  if (totalTarget <= 0) return { rawQuestions: [], costUSD: 0, errors: [] };

  const batches: number[] = [];
  let remaining = totalTarget;
  while (remaining > 0) {
    batches.push(Math.min(GENERATION_BATCH_SIZE, remaining));
    remaining -= GENERATION_BATCH_SIZE;
  }

  const CONCURRENCY = 4;
  let costUSD = 0;
  const allQuestions: RawClaudeQuestion[] = [];
  const errors: unknown[] = [];

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    if (deadlineMs && Date.now() > deadlineMs) {
      console.warn('callClaudeInBatches: deadline reached after ' + allQuestions.length + ' questions, stopping');
      break;
    }
    const group = batches.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      // segment is the cached context; instructions vary per batch size.
      group.map(size => callClaude(segment, buildInstructionsFn(size), model)),
    );
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        allQuestions.push(...result.value.rawQuestions);
        costUSD += result.value.costUSD;
      } else {
        errors.push(result.reason);
        console.warn('callClaudeInBatches: batch failed, skipping:', result.reason);
      }
    }
  }

  return { rawQuestions: allQuestions, costUSD, errors };
}

function parseAnswerIndex(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value !== 'string') return 0;

  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  const letter = trimmed.toUpperCase();
  if (/^[A-E]$/.test(letter)) return letter.charCodeAt(0) - 65;

  return 0;
}

function parseQuestionLevel(value: unknown): Question['level'] {
  if (value === 2 || value === '2' || value === 'L2') return 2;
  if (value === 3 || value === '3' || value === 'L3') return 3;
  return 1;
}

function toQuestion(raw: RawClaudeQuestion, pdfText: string, pdfId: string, userId: string): Question {
  const options = Array.isArray(raw.options)
    ? raw.options
      .map(option => {
        if (typeof option === 'string') return option.trim();
        if (typeof option === 'number' || typeof option === 'boolean') return String(option);
        return '';
      })
      .filter(option => option.length > 0)
    : [];
  const rawAnswer = parseAnswerIndex(raw.answer);
  const answer = rawAnswer >= 0 && rawAnswer < options.length ? rawAnswer : 0;
  const sourceQuote = typeof raw.source_quote === 'string'
    ? raw.source_quote
    : typeof raw.sourceQuote === 'string'
      ? raw.sourceQuote
      : '';
  let offsets = findEvidenceOffsets(sourceQuote, pdfText);
  const evidenceResult = verifyEvidenceSpan(sourceQuote, offsets.start ?? 0, offsets.end ?? 0, pdfText);
  if (
    offsets.start === null &&
    evidenceResult.evidenceMatchType !== 'none' &&
    evidenceResult.evidenceMatchedText
  ) {
    offsets = findEvidenceOffsets(evidenceResult.evidenceMatchedText, pdfText);
  }

  let flagged = false;
  let flagReason: string | null = null;
  let optionSetFlags: string[] | null = null;

  const explanation = typeof raw.explanation === 'string' ? raw.explanation : '';
  const mismatch = detectExplanationAnswerMismatch(options, answer, explanation);
  if (mismatch) {
    flagged = true;
    flagReason = 'ANSWER_KEY_MISMATCH';
  }

  if (rawAnswer !== answer || !options.length) {
    flagged = true;
    flagReason = flagReason ?? 'INVALID_ANSWER';
  }

  const isCalculation = options.length >= 4 && options.every(opt =>
    /^[+\-]?\d+(\.\d+)?(\s*(mm\s*Hg|ml\/min|L\/day|%|mg\/dL|mEq\/L|mmol\/L))?$/.test(opt.trim())
  );
  if (evidenceResult.evidenceMatchType === 'none' && !isCalculation) {
    flagged = true;
    flagReason = flagReason ?? 'QUOTE_NOT_FOUND';
  }

  const correctOption = options[answer] ?? '';
  const optionLengths = options.map(wordCount);
  const medianOptionLength = median(optionLengths);
  if (medianOptionLength > 0 && wordCount(correctOption) > medianOptionLength * 1.4) {
    optionSetFlags = ['LENGTH_TELL'];
    flagged = true;
  }

  return {
    id: crypto.randomUUID(),
    pdf_id: pdfId,
    user_id: userId,
    concept_id: null,
    concept_name: typeof raw.topic === 'string' && raw.topic.trim() ? raw.topic.trim() : undefined,
    level: parseQuestionLevel(raw.level),
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
  requestStartMs?: number,
): Promise<{ questions: Question[]; costUSD: number }> {
  const totalTokens = estimateTokens(pdfText);
  const singleSegmentSections = totalTokens <= TOKENS_PER_SEGMENT ? extractSections(pdfText) : [];
  const useSections = singleSegmentSections.length >= 2;
  const segments = totalTokens <= TOKENS_PER_SEGMENT
    ? (useSections ? singleSegmentSections.map(section => section.content) : [pdfText])
    : splitTextIntoSegments(pdfText);
  if (!segments.length || segments.every(s => !s.trim())) {
    throw new Error('No text segments to generate questions from');
  }
  const GENERATION_DEADLINE_MS = (requestStartMs ?? Date.now()) + 120_000;
  const segmentTargets = segments.length === 1
    ? [Math.max(0, targetCount)]
    : allocateTargetsByTokens(segments, targetCount);

  let costUSD = 0;
  const questions: Question[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    if (Date.now() > GENERATION_DEADLINE_MS) {
      onProgress?.(`Generation time limit reached — saving ${questions.length} questions generated so far`);
      break;
    }

    const segment = segments[i] ?? '';
    const segmentTarget = segmentTargets[i] ?? 0;
    if (segmentTarget <= 0 || !segment.trim()) continue;

    const section = useSections ? singleSegmentSections[i] : null;
    onProgress?.(
      section
        ? `Generating questions for section ${i + 1}/${segments.length}: ${section.heading}…`
        : `Generating questions for segment ${i + 1}/${segments.length}…`,
    );

    const l3Target = segmentTarget >= 2 ? Math.max(1, Math.round(segmentTarget * 0.45)) : 0;
    const l1l2Target = Math.max(0, segmentTarget - l3Target);

    const [l1l2Settled, l3Settled] = await Promise.allSettled([
      callClaudeInBatches(
        buildL1L2Instructions,
        segment,
        l1l2Target,
        'claude-haiku-4-5-20251001',
        GENERATION_DEADLINE_MS,
      ),
      callClaudeInBatches(buildL3Instructions, segment, l3Target, env.GENERATION_MODEL, GENERATION_DEADLINE_MS),
    ]);

    let segCost = 0;
    const rawAll: RawClaudeQuestion[] = [];

    if (l1l2Settled.status === 'fulfilled') {
      rawAll.push(...l1l2Settled.value.rawQuestions);
      segCost += l1l2Settled.value.costUSD;
    } else {
      console.warn('L1L2 generation failed for segment:', l1l2Settled.reason);
    }
    if (l3Settled.status === 'fulfilled') {
      rawAll.push(...l3Settled.value.rawQuestions);
      segCost += l3Settled.value.costUSD;
    } else {
      console.warn('L3 generation failed for segment:', l3Settled.reason);
    }
    if (!rawAll.length) {
      if (l1l2Settled.status === 'rejected' && l3Settled.status === 'rejected') {
        throw l1l2Settled.reason;
      }
      const firstError = [l1l2Settled, l3Settled]
        .map(result => result.status === 'fulfilled' ? result.value.errors[0] : result.reason)
        .find(error => error !== undefined && error !== null);
      if (firstError instanceof Error) {
        throw firstError;
      }
      throw new Error(
        typeof firstError === 'string'
          ? firstError
          : firstError
            ? String(firstError)
            : 'Claude generation returned no questions',
      );
    }
    if (l1l2Settled.status === 'rejected' || (l1l2Settled.status === 'fulfilled' && !l1l2Settled.value.rawQuestions.length)) {
      console.warn('[generation] L1L2 generation returned no questions for segment');
    }
    if (l3Settled.status === 'rejected' || (l3Settled.status === 'fulfilled' && !l3Settled.value.rawQuestions.length)) {
      console.warn('[generation] L3 generation returned no questions for segment');
    }
    costUSD += segCost;
    const mapped = rawAll.map(raw => trimLengthTell(toQuestion(raw, pdfText, pdfId, userId)));
    const valid = mapped.filter(q => q.stem.trim().length > 0 && q.options.length >= 2);
    if (valid.length < mapped.length) {
      console.warn(`[generation] Filtered ${mapped.length - valid.length} malformed questions (empty stem or <2 options)`);
    }
    questions.push(...valid);
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
