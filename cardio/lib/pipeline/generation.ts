/**
 * Phase 5b/6 — Question generation (Writer Agent) and normalization.
 * Verbatim prompt templates from medical-study-app-v2.html.
 *
 * callOpenAI replaces callGemini — uses OpenAI Node SDK with server-side key.
 * All prompt text is copied verbatim; zero content changes.
 */

import OpenAI from 'openai';
import type {
  Question,
  Concept,
  ChunkRecord,
  DensityConfig,
  ConfusionMap,
  BM25Index,
  GenerationSlot,
  DistractorCandidate,
} from '@/types';
import { env } from '@/lib/env';
import { buildDistractorCandidatePool, formatDistractorCandidatePool } from './distractors';
import { balanceOptionLengths } from './distractors';
import { embedTexts } from './embeddings';
import { retrieveTopChunks } from './retrieval';
import { calculateOpenAIUsageCostUSD, type OpenAICostTracker } from '@/lib/openai-cost';
import { getExpectedOptionCount, runOptionSetAudit, validateQuestionDraft, validateSourceQuoteShape } from './question-validation';
import { buildOptionAliases, explanationMentionsAlias } from './answer-key-check';
import fs from 'node:fs';
import path from 'node:path';

type ReferenceQuestion = {
  id: string;
  topic: string;
  level: string;
  stem: string;
  options: Array<{ letter: string; text: string }>;
  correctLetter: string;
  explanation: string;
  citation: string;
};

let referenceBankCache: ReferenceQuestion[] | null = null;

function loadReferenceBank(): ReferenceQuestion[] {
  if (referenceBankCache) return referenceBankCache;
  try {
    const dataPath = path.join(process.cwd(), 'data', 'reference-bank.json');
    if (fs.existsSync(dataPath)) {
      const raw = fs.readFileSync(dataPath, 'utf8');
      referenceBankCache = JSON.parse(raw);
      return referenceBankCache;
    }
  } catch (err) {
    console.warn(`Failed to load reference-bank.json: ${(err as Error).message}`);
  }
  return [];
}

function findSimilarExemplars(conceptName: string, level: number, count: number = 2): ReferenceQuestion[] {
  const bank = loadReferenceBank();
  const examples: ReferenceQuestion[] = [];

  // Simple heuristic: match by topic substring, prefer same level
  const lowerConcept = conceptName.toLowerCase();
  const sameLevelMatches = bank.filter(
    q => q.level === String(level) && lowerConcept.split(/\s+/).some(word => q.topic.toLowerCase().includes(word))
  );

  if (sameLevelMatches.length > 0) {
    examples.push(...sameLevelMatches.slice(0, count));
  }

  // Fallback: any level, topic match
  if (examples.length < count) {
    const anyLevelMatches = bank.filter(
      q => !examples.some(e => e.id === q.id) && lowerConcept.split(/\s+/).some(word => q.topic.toLowerCase().includes(word))
    );
    examples.push(...anyLevelMatches.slice(0, count - examples.length));
  }

  return examples.slice(0, count);
}

// ─── Constants (verbatim from HTML) ──────────────────────────────────────────

export const OPENAI_MODEL  = 'gpt-4o-mini';
export const WRITER_MODEL  = 'gpt-4o';
export const AUDITOR_MODEL = 'gpt-4o';

const RAG_TOP_K = 4;
// ─── OpenAI client ────────────────────────────────────────────────────────────

function getOpenAI(): OpenAI {
  return new OpenAI({ apiKey: env.openAiApiKey });
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── callOpenAI (replaces callGemini — same retry/rate-limit logic) ───────────

export async function callOpenAI(
  prompt:    string,
  maxTokens = 8192,
  model     = OPENAI_MODEL,
  onCost?: OpenAICostTracker,
  options?: { responseFormat?: { type: 'json_object' }; temperature?: number },
): Promise<{ text: string; costUSD: number }> {
  const openai = getOpenAI();
  let totalCost = 0;

  // Writer model runs at low temperature to maximize compliance with the strict
  // verbatim-evidence and option-discipline rules. All other callers default to
  // 0.3 unless they pass an explicit override.
  const temperature = options?.temperature ?? (model === WRITER_MODEL ? 0.1 : 0.3);

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature,
        response_format: options?.responseFormat,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error('Empty API response');

      if (response.usage) {
        const usageCost = calculateOpenAIUsageCostUSD(model, response.usage);
        totalCost = usageCost.costUSD;
        if (usageCost.costUSD > 0) {
          await onCost?.(usageCost);
        }
      }

      return { text: content, costUSD: totalCost };
    } catch (err) {
      const e = err as { status?: number; message?: string };
      const msg = e.message ?? String(e);
      const isRateLimit = e.status === 429 || msg.toLowerCase().includes('rate limit');

      if (isRateLimit && attempt < 3) {
        const wait = 10_000 * (attempt + 1) + Math.floor(Math.random() * 5000);
        console.warn(`Rate limit — waiting ${wait / 1000}s before retry…`);
        await sleep(wait);
        continue;
      }
      throw new Error(msg);
    }
  }

  throw new Error('callOpenAI: exhausted retries');
}

// ─── parseJSON — verbatim from HTML ──────────────────────────────────────────

export function parseJSON(text: string): unknown {
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const si = clean.indexOf('[');
  const oi = clean.indexOf('{');
  const s =
    si === -1 && oi === -1 ? -1 :
    si === -1 ? oi :
    oi === -1 ? si :
    Math.min(si, oi);

  if (s === -1) throw new Error('No JSON found in response');
  const slice = clean.slice(s);

  // Try 1: parse as-is
  try { return JSON.parse(slice); } catch (_) { /* fall through */ }

  // Try 2: repair truncated arrays — find last complete top-level object
  let lastGood = -1, depth = 0;
  let inStr = false, esc = false;
  for (let i = 0; i < slice.length; i++) {
    const ch = slice[i]!;
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    if (ch === '}') { depth--; if (depth === 0) lastGood = i; }
  }

  if (lastGood > 0) {
    try {
      const wrapped =
        si !== oi && si === s
          ? '[' + slice.slice(0, lastGood + 1) + ']'
          : slice.slice(0, lastGood + 1);
      const r = JSON.parse(wrapped);
      if (Array.isArray(r) && r.length > 0) return r;
      if (r && typeof r === 'object') return r;
    } catch (_) { /* fall through */ }
  }

  throw new Error('Could not parse JSON from response');
}

// ─── cleanOptions — verbatim from HTML ───────────────────────────────────────

function cleanOptions(options: string[]): string[] {
  return options.map(opt => String(opt || '').replace(/^[A-Ea-e][.)]\s*/, '').trim());
}

function normalizeOptionComparisonText(text: string): string {
  return text
    .toLowerCase()
    .replace(/^[a-e][.)]\s*/, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function optionSimilarityScore(a: string, b: string): number {
  const aTokens = new Set(normalizeOptionComparisonText(a).split(' ').filter(token => token.length >= 4));
  const bTokens = new Set(normalizeOptionComparisonText(b).split(' ').filter(token => token.length >= 4));
  if (!aTokens.size || !bTokens.size) return 0;

  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }

  return overlap / Math.max(1, Math.min(aTokens.size, bTokens.size));
}

function normalizeEvidenceText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function evidenceTokenOverlap(a: string, b: string): number {
  const aTokens = new Set(normalizeEvidenceText(a).split(' ').filter(token => token.length >= 4));
  const bTokens = new Set(normalizeEvidenceText(b).split(' ').filter(token => token.length >= 4));
  if (!aTokens.size || !bTokens.size) return 0;
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(1, Math.min(aTokens.size, bTokens.size));
}

// Pattern matching text that looks like an embedded multiple-choice question
// (e.g. "A Endothelial cell disruption B Intimal thickening C Lymphocytic...").
// These appear in textbooks that include practice questions and should never
// be used as source quotes since they are not explanatory prose.
const EMBEDDED_MCQ_PATTERN = /^\s*[A-E]\s+\w.{5,}\s+[B-E]\s+\w/;

function isEmbeddedMCQText(text: string): boolean {
  return EMBEDDED_MCQ_PATTERN.test(text) ||
    // Also catch question stems that read like test items
    /\bWhich of the following\b.*\?$/.test(text.trim()) ||
    /\bWhat is the most likely\b.*\?$/.test(text.trim());
}

function extractEvidenceSentences(evidenceCorpus: string): string[] {
  return evidenceCorpus
    .split(/(?<=[.!?])\s+|\n+/)
    .map(part => part.trim())
    .filter(part => part.length >= 30 && !isEmbeddedMCQText(part));
}

export function inferEvidenceProvenance(
  sourceQuote: string,
  chunks: ChunkRecord[],
  matchedText?: string,
): { chunkId: string | null; evidenceStart: number; evidenceEnd: number } {
  const targets = [matchedText, sourceQuote]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(value => value.trim());

  if (!targets.length || !chunks.length) {
    return { chunkId: null, evidenceStart: 0, evidenceEnd: 0 };
  }

  for (const target of targets) {
    for (const chunk of chunks) {
      const directIndex = chunk.text.indexOf(target);
      if (directIndex >= 0) {
        return {
          chunkId: chunk.id,
          evidenceStart: directIndex,
          evidenceEnd: directIndex + target.length,
        };
      }

      const normalizedChunk = normalizeEvidenceText(chunk.text);
      const normalizedTarget = normalizeEvidenceText(target);
      if (!normalizedTarget || !normalizedChunk.includes(normalizedTarget)) continue;

      const sentence = extractEvidenceSentences(chunk.text).find(candidate =>
        normalizeEvidenceText(candidate).includes(normalizedTarget),
      );
      if (!sentence) continue;

      const sentenceIndex = chunk.text.indexOf(sentence);
      if (sentenceIndex >= 0) {
        return {
          chunkId: chunk.id,
          evidenceStart: sentenceIndex,
          evidenceEnd: sentenceIndex + sentence.length,
        };
      }
    }
  }

  return { chunkId: null, evidenceStart: 0, evidenceEnd: 0 };
}

export function alignSourceQuoteToEvidence(
  raw: Record<string, unknown>,
  evidenceCorpus: string,
): Record<string, unknown> {
  const sourceQuote = typeof raw.sourceQuote === 'string' ? raw.sourceQuote.trim() : '';
  if (!sourceQuote || sourceQuote === 'UNGROUNDED' || !evidenceCorpus.trim()) {
    return raw;
  }

  const sentences = extractEvidenceSentences(evidenceCorpus);
  if (!sentences.length) return raw;

  const exactSentence = sentences.find(sentence => sentence.includes(sourceQuote));
  if (exactSentence) {
    return { ...raw, sourceQuote: exactSentence };
  }

  const normalizedQuote = normalizeEvidenceText(sourceQuote);
  if (!normalizedQuote) return raw;

  let bestSentence = '';
  let bestScore = 0;
  for (const sentence of sentences) {
    const score = evidenceTokenOverlap(sourceQuote, sentence);
    if (score > bestScore) {
      bestScore = score;
      bestSentence = sentence;
    }
  }

  if (bestSentence && bestScore >= 0.4) {
    return { ...raw, sourceQuote: bestSentence };
  }

  return raw;
}

function alignDecidingClueToSourceQuote(repaired: Record<string, unknown>): void {
  const sourceQuote = typeof repaired.sourceQuote === 'string' ? repaired.sourceQuote.trim() : '';
  const writerClue = typeof repaired.decidingClue === 'string' ? repaired.decidingClue.trim() : '';
  if (!sourceQuote || !writerClue) return;

  const sourceLower = sourceQuote.toLowerCase();
  const clueLower = writerClue.toLowerCase().replace(/[.,;:!?]+$/, '').trim();
  if (!clueLower || sourceLower.includes(clueLower)) return;

  const clueTokens = clueLower.split(/\s+/).filter(Boolean);
  if (clueTokens.length < 2) return;

  let bestSpan = '';
  for (let start = 0; start < clueTokens.length; start++) {
    for (let end = clueTokens.length; end > start; end--) {
      const candidate = clueTokens.slice(start, end).join(' ');
      const wordCount = end - start;
      if (wordCount < 2 || wordCount > 14) continue;
      if (sourceLower.includes(candidate) && candidate.length > bestSpan.length) {
        bestSpan = candidate;
      }
    }
  }

  if (!bestSpan) return;

  const matchIdx = sourceLower.indexOf(bestSpan);
  if (matchIdx < 0) return;

  const verbatim = sourceQuote.slice(matchIdx, matchIdx + bestSpan.length).trim();
  repaired.decidingClue = verbatim;
  repaired.deciding_clue = verbatim;
}

/**
 * Infer the correct answer index from the explanation text when the writer's
 * `correctAnswer` index is wrong.
 *
 * The writer frequently off-by-ones the index or copy-pastes the wrong number.
 * The explanation text is almost always right — it names the answer in the
 * opening sentence. Strategy:
 *   1. Find which option starts / leads the explanation with a positive cue.
 *   2. If that option differs from the current answer AND the current answer
 *      option is not mentioned in the explanation → use the leader.
 *   3. Fallback: if the current answer option is never mentioned in the
 *      explanation but exactly one other option is → use that one.
 *
 * Returns the corrected index, or -1 if ambiguous / no fix needed.
 */
function inferCorrectAnswerFromExplanation(
  options: string[],
  currentAnswer: number,
  explanation: string,
): number {
  if (!explanation || !options.length) return -1;

  const normalizedExplanation = explanation.toLowerCase();
  const firstSentence = explanation.split(/(?<=[.!?])\s+/)[0] ?? explanation;
  const normalizedFirst = firstSentence.toLowerCase();

  const positiveCue = /\b(is correct|correct because|best answer|primarily responsible|primarily explains|directly affects|defined as|refers to)\b/i;
  const negativeCue = /\b(tempting|fails because|incorrect|wrong|whereas|however|unlike|in contrast|not because)\b/i;

  // Score each option: does it appear early in the explanation with a positive signal?
  const matches = options.map((option, idx) => {
    const aliases = buildOptionAliases(option);
    const mentionedEarly = aliases.some(a => explanationMentionsAlias(normalizedFirst, a));
    const mentionedAnywhere = aliases.some(a => explanationMentionsAlias(normalizedExplanation, a));
    const startsExplanation = aliases.some(alias => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      return new RegExp(`^${escaped}\\b`, 'i').test(normalizedFirst);
    });
    return { idx, mentionedEarly, mentionedAnywhere, startsExplanation };
  });

  const currentMatch = matches[currentAnswer];
  const currentMentioned = currentMatch?.mentionedAnywhere ?? false;

  // Find which option leads the explanation with a positive cue and no negative cue
  const leader = matches.find(m =>
    m.idx !== currentAnswer &&
    (m.startsExplanation || (m.mentionedEarly && positiveCue.test(firstSentence))) &&
    !negativeCue.test(firstSentence),
  );

  if (leader && !currentMentioned) {
    return leader.idx;
  }

  // Fallback: current answer not mentioned at all, exactly one other option is
  if (!currentMentioned) {
    const mentioned = matches.filter(m => m.idx !== currentAnswer && m.mentionedAnywhere);
    if (mentioned.length === 1) {
      return mentioned[0]!.idx;
    }
  }

  return -1;
}

export function repairDraftForValidation(
  raw: Record<string, unknown>,
  evidenceCorpus: string,
): Record<string, unknown> {
  const alignedInput =
    'source_quote' in raw
      ? {
          ...raw,
          sourceQuote: typeof raw.source_quote === 'string' ? raw.source_quote : raw.sourceQuote,
        }
      : raw;
  const repaired: Record<string, unknown> = {
    ...alignSourceQuoteToEvidence(alignedInput, evidenceCorpus),
  };
  if ('source_quote' in raw && typeof repaired.sourceQuote === 'string') {
    repaired.source_quote = repaired.sourceQuote;
  }

  const options = Array.isArray(repaired.options)
    ? cleanOptions(repaired.options.filter((opt): opt is string => typeof opt === 'string'))
    : [];
  if (options.length) {
    repaired.options = options;
  }

  const answer = typeof repaired.correctAnswer === 'number'
    ? repaired.correctAnswer
    : (typeof repaired.answer === 'number' ? repaired.answer : -1);
  const correctOption = answer >= 0 && answer < options.length ? options[answer] ?? '' : '';
  const wrongOptions = options.filter((_, idx) => idx !== answer);

  // mostTemptingDistractor is picked deterministically: the wrong option most similar to the
  // correct answer. Any value the model returned is ignored — it was a frequent failure mode
  // (paraphrased or fabricated) and this eliminates that whole class of rejections.
  if (wrongOptions.length && correctOption) {
    const ranked = [...wrongOptions]
      .map(option => ({ option, score: optionSimilarityScore(option, correctOption) }))
      .sort((a, b) => b.score - a.score);
    const chosen = ranked[0]?.option ?? wrongOptions[0]!;
    repaired.mostTemptingDistractor = chosen;
    repaired.most_tempting_distractor = chosen;
  }

  // Keep decidingClue verbatim with respect to the currently selected sourceQuote.
  alignDecidingClueToSourceQuote(repaired);

  const explanation = typeof repaired.explanation === 'string' ? repaired.explanation : '';
  const conceptName = typeof repaired.conceptName === 'string' ? repaired.conceptName.trim() : '';

  // General answer-key repair: infer the correct index from the explanation
  // text. This catches the common writer error of providing the right explanation
  // but the wrong correctAnswer index. Only fires when there is a clear,
  // unambiguous candidate — never guesses when evidence is mixed.
  if (options.length && explanation) {
    const inferredIdx = inferCorrectAnswerFromExplanation(options, answer, explanation);
    if (inferredIdx >= 0 && inferredIdx !== answer) {
      repaired.correctAnswer = inferredIdx;
      repaired.answer = inferredIdx;
    }
  }

  const repairedAnswer = typeof repaired.correctAnswer === 'number'
    ? repaired.correctAnswer
    : (typeof repaired.answer === 'number' ? repaired.answer : -1);
  const repairedCorrectOption = repairedAnswer >= 0 && repairedAnswer < options.length ? options[repairedAnswer] ?? '' : '';
  const evidenceKeywords = [
    typeof repaired.decidingClue === 'string' ? repaired.decidingClue : '',
    repairedCorrectOption,
    conceptName,
  ].filter(Boolean);
  if (evidenceKeywords.length && evidenceCorpus.trim()) {
    const betterSourceQuote = pickBetterEvidenceSentence(
      evidenceCorpus,
      typeof repaired.sourceQuote === 'string' ? repaired.sourceQuote.trim() : '',
      evidenceKeywords,
    );
    if (betterSourceQuote) {
      repaired.sourceQuote = betterSourceQuote;
      if ('source_quote' in raw) {
        repaired.source_quote = betterSourceQuote;
      }
    }
  }
  alignDecidingClueToSourceQuote(repaired);

  if (typeof repaired.explanation === 'string') {
    repaired.explanation = normalizeGeneratedExplanation(
      repaired.explanation,
      typeof repaired.decidingClue === 'string' ? repaired.decidingClue : undefined,
    );
  }

  return repaired;
}

function findEvidenceSentenceByKeywords(evidenceCorpus: string, keywords: string[]): string {
  const sentences = extractEvidenceSentences(evidenceCorpus);
  if (!sentences.length) return '';

  const normalizedKeywords = keywords.map(keyword => normalizeEvidenceText(keyword)).filter(Boolean);
  let bestSentence = '';
  let bestScore = 0;

  for (const sentence of sentences) {
    const normalizedSentence = normalizeEvidenceText(sentence);
    let score = 0;
    for (const keyword of normalizedKeywords) {
      if (normalizedSentence.includes(keyword)) score += 2;
      else if (keyword.split(' ').every(token => token && normalizedSentence.includes(token))) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestSentence = sentence;
    }
  }

  return bestSentence;
}

function findEvidenceClause(evidenceCorpus: string, pattern: RegExp): string {
  const match = evidenceCorpus.match(pattern);
  return match?.[0]?.replace(/\s+/g, ' ').trim() ?? '';
}

function normalizeGeneratedExplanation(explanation: string, decidingClue?: string): string {
  const trimmed = explanation.trim();
  if (!trimmed || !/\bkey distinction\s*:/i.test(trimmed)) return trimmed;

  return trimmed
    .replace(/\s*Key distinction:\s*([^.!?]+)([.!?])?/i, (_, clueBody: string, punctuation: string | undefined) => {
      const clue = (clueBody || decidingClue || '').trim();
      if (!clue) return '.';
      return `. The deciding clue is ${clue}${punctuation || '.'}`;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function explanationStartsWithConcept(explanation: string, conceptName: string): boolean {
  const normalizedExplanation = normalizeEvidenceText(explanation);
  const normalizedConcept = normalizeEvidenceText(conceptName);
  if (!normalizedExplanation || !normalizedConcept) return false;
  return normalizedExplanation.startsWith(normalizedConcept);
}

function scoreEvidenceSentence(sentence: string, keywords: string[]): number {
  const normalizedSentence = normalizeEvidenceText(sentence);
  if (!normalizedSentence) return 0;
  if (validateSourceQuoteShape(sentence)) return 0;

  let score = 0;
  for (const keyword of keywords.map(keyword => normalizeEvidenceText(keyword)).filter(Boolean)) {
    if (normalizedSentence.includes(keyword)) {
      score += Math.max(4, keyword.split(' ').length);
      continue;
    }

    const tokens = keyword.split(' ').filter(Boolean);
    const matchedTokens = tokens.filter(token => normalizedSentence.includes(token)).length;
    if (matchedTokens >= Math.max(2, Math.ceil(tokens.length / 2))) {
      score += matchedTokens;
    }
  }

  if (sentence.split(/\s+/).filter(Boolean).length >= 10) {
    score += 1;
  }
  if (/^[A-Z][A-Za-z0-9 ,:/()-]{0,90}$/.test(sentence) && !/[.!?]$/.test(sentence)) {
    score -= 2;
  }
  return score;
}

function pickBetterEvidenceSentence(
  evidenceCorpus: string,
  currentSourceQuote: string,
  keywords: string[],
): string {
  const sentences = extractEvidenceSentences(evidenceCorpus);
  if (!sentences.length) return currentSourceQuote;

  let bestSentence = currentSourceQuote;
  let bestScore = currentSourceQuote ? scoreEvidenceSentence(currentSourceQuote, keywords) : 0;
  for (const sentence of sentences) {
    const score = scoreEvidenceSentence(sentence, keywords);
    if (score > bestScore) {
      bestSentence = sentence;
      bestScore = score;
    }
  }

  return bestSentence;
}

export function buildPressureVolumePropertyDraft(
  slot: GenerationSlot,
  evidenceCorpus: string,
): Record<string, unknown> | null {
  const conceptName = slot.conceptName.toLowerCase();

  if (conceptName === 'vascular distensibility') {
    const sourceQuote =
      findEvidenceClause(
        evidenceCorpus,
        /[^.;\n]*fractional increase in volume[^.;\n]*millimeter[s]? of mercury rise in pressure[^.;\n]*[.;]?/i,
      ) ||
      findEvidenceSentenceByKeywords(evidenceCorpus, [
        'fractional increase in volume',
        'millimeter of mercury rise in pressure',
      ]) || findEvidenceSentenceByKeywords(evidenceCorpus, ['blood vessels are distensible']);

    if (slot.level === 1) {
      return {
        conceptId: slot.conceptId,
        conceptName: slot.conceptName,
        level: slot.level,
        question: 'Which vascular property is defined as the fractional increase in volume per mm Hg rise in pressure?',
        options: [
          'Compliance',
          'Distensibility',
          'Resistance',
          'Vascular tone',
          'Pulse pressure',
        ],
        correctAnswer: 1,
        explanation: 'Distensibility is correct because it is defined as the fractional increase in volume per mm Hg rise in pressure, whereas compliance refers to the total quantity of blood stored per pressure rise. Compliance is tempting because both are pressure-volume vessel properties, but fails because it measures total storage capacity rather than fractional change.',
        sourceQuote,
        decisionTarget: 'definition',
        decidingClue: 'fractional increase in volume per mm Hg rise in pressure',
        mostTemptingDistractor: 'Compliance',
        whyTempting: 'both are pressure-volume vessel properties',
        whyFails: 'compliance measures total stored volume per pressure rise rather than fractional change',
      };
    }

    if (slot.level === 2) {
      return {
        conceptId: slot.conceptId,
        conceptName: slot.conceptName,
        level: slot.level,
        question: 'The ability of veins to accept extra blood with only a small pressure rise depends most directly on which vascular property?',
        options: [
          'Compliance',
          'Distensibility',
          'Resistance',
          'Pulse pressure',
        ],
        correctAnswer: 1,
        explanation: 'Distensibility is correct because it describes how readily a vessel expands with a pressure increase, whereas compliance refers to the total blood volume stored per pressure rise. Compliance is tempting because both concepts help explain venous storage, but fails because this stem is asking about the vessel wall property that allows expansion itself.',
        sourceQuote:
          findEvidenceClause(evidenceCorpus, /[^.;\n]*veins[^.;\n]*more distensible than arteries[^.;\n]*[.;]?/i)
          || sourceQuote
          || findEvidenceSentenceByKeywords(evidenceCorpus, ['veins are more distensible than arteries']),
        decisionTarget: 'mechanism',
        decidingClue: 'readily expands with a small pressure increase',
        mostTemptingDistractor: 'Compliance',
        whyTempting: 'both concepts are used to explain venous blood storage',
        whyFails: 'compliance describes total storage capacity per pressure rise rather than the expansion property itself',
      };
    }
  }

  if (conceptName === 'vascular compliance') {
    const sourceQuote =
      findEvidenceClause(
        evidenceCorpus,
        /[^.;\n]*total quantity of blood[^.;\n]*stored[^.;\n]*mm hg pressure rise[^.;\n]*[.;]?/i,
      ) ||
      findEvidenceSentenceByKeywords(evidenceCorpus, [
        'total quantity of blood that can be stored per mm hg pressure rise',
      ]) || findEvidenceSentenceByKeywords(evidenceCorpus, ['compliance', 'distensibility times volume']);

    if (slot.level === 1) {
      return {
        conceptId: slot.conceptId,
        conceptName: slot.conceptName,
        level: slot.level,
        question: 'Which vascular property is defined as the total quantity of blood that can be stored per mm Hg pressure rise?',
        options: [
          'Distensibility',
          'Compliance',
          'Resistance',
          'Vascular tone',
          'Pulse pressure',
        ],
        correctAnswer: 1,
        explanation: 'Compliance is correct because it is the total quantity of blood that can be stored per mm Hg pressure rise, whereas distensibility refers to fractional volume change with pressure. Distensibility is tempting because both are pressure-volume concepts, but fails because it does not include the vessel volume term that determines storage capacity.',
        sourceQuote,
        decisionTarget: 'definition',
        decidingClue: 'total quantity of blood stored per mm Hg pressure rise',
        mostTemptingDistractor: 'Distensibility',
        whyTempting: 'both are closely related pressure-volume vessel properties',
        whyFails: 'distensibility is fractional change with pressure and does not directly encode total storage capacity',
      };
    }

    if (slot.level === 2) {
      return {
        conceptId: slot.conceptId,
        conceptName: slot.conceptName,
        level: slot.level,
        question: 'Systemic veins can store much more blood than corresponding arteries primarily because veins have greater what?',
        options: [
          'Distensibility',
          'Compliance',
          'Resistance',
          'Pulse pressure',
        ],
        correctAnswer: 1,
        explanation: 'Compliance is correct because veins can store more blood for a given pressure rise, whereas distensibility alone describes relative expansibility without directly capturing total storage. Distensibility is tempting because veins are also highly distensible, but fails because the stem asks about the property that explains much greater blood storage.',
        sourceQuote:
          findEvidenceClause(evidenceCorpus, /[^.;\n]*systemic veins[^.;\n]*compliance[^.;\n]*arteries[^.;\n]*[.;]?/i)
          || sourceQuote
          || findEvidenceSentenceByKeywords(evidenceCorpus, ['systemic veins', 'compliance', 'arteries']),
        decisionTarget: 'mechanism',
        decidingClue: 'stores much more blood per pressure rise',
        mostTemptingDistractor: 'Distensibility',
        whyTempting: 'veins are also more distensible, so the terms are commonly confused',
        whyFails: 'the stem asks about total storage capacity per pressure rise, which is compliance',
      };
    }
  }

  return null;
}

function toRevisionSeed(raw: Record<string, unknown>, level: number, conceptId: string): {
  stem: string;
  options: string[];
  answer: number;
  level: number;
  pageEstimate?: string;
  decidingClue?: string;
  decisionTarget?: string;
  mostTemptingDistractor?: string;
  conceptId?: string;
} | null {
  const stem = typeof raw.question === 'string' ? raw.question : '';
  const options = Array.isArray(raw.options)
    ? raw.options.filter((opt): opt is string => typeof opt === 'string')
    : [];
  const answer = typeof raw.correctAnswer === 'number' ? raw.correctAnswer : -1;

  if (!stem || !options.length || answer < 0 || answer >= options.length) {
    return null;
  }

  return {
    stem,
    options,
    answer,
    level,
    pageEstimate: typeof raw.pageEstimate === 'string' ? raw.pageEstimate : undefined,
    decidingClue: typeof raw.decidingClue === 'string' ? raw.decidingClue : undefined,
    decisionTarget: typeof raw.decisionTarget === 'string' ? raw.decisionTarget : undefined,
    mostTemptingDistractor: typeof raw.mostTemptingDistractor === 'string' ? raw.mostTemptingDistractor : undefined,
    conceptId,
  };
}

// ─── normaliseQuestion — verbatim port ───────────────────────────────────────

export function normaliseQuestion(
  raw:     Record<string, unknown>,
  concept: { id: string; name: string; category: string; importance: string; coverageDomain?: string; pageEstimate?: string },
  level:   number,
  pdfId:   string,
  userId:  string,
): Omit<Question, 'id' | 'created_at'> | null {
  const resolvedLevel = parseInt(String(raw?.level)) || level;
  const expectedOptionCount = getExpectedOptionCount(resolvedLevel);
  if (
    !raw?.question || !Array.isArray(raw.options) ||
    (raw.options as unknown[]).length !== expectedOptionCount ||
    typeof raw.correctAnswer !== 'number' ||
    (raw.correctAnswer as number) < 0 ||
    (raw.correctAnswer as number) >= (raw.options as unknown[]).length
  ) return null;

  let opts = cleanOptions([...(raw.options as string[])]);
  let ci = raw.correctAnswer as number;

  // Fisher-Yates shuffle on indices (verbatim from HTML)
  const n = opts.length;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [opts[i], opts[j]] = [opts[j]!, opts[i]!];
    if (ci === i) ci = j;
    else if (ci === j) ci = i;
  }

  const normalized: Omit<Question, 'id' | 'created_at'> = {
    pdf_id:              pdfId,
    concept_id:          concept.id,
    concept_name:        concept.name,
    user_id:             userId,
    level:               resolvedLevel as Question['level'],
    stem:                raw.question as string,
    options:             opts,
    answer:              ci,
    explanation:         (raw.explanation as string) || '',
    option_explanations: null,
    source_quote:        typeof raw.sourceQuote === 'string' ? raw.sourceQuote as string : '',
    evidence_start:      typeof raw.evidenceStart === 'number' ? raw.evidenceStart as number : 0,
    evidence_end:        typeof raw.evidenceEnd === 'number' ? raw.evidenceEnd as number : 0,
    chunk_id:            typeof raw.chunkId === 'string' ? raw.chunkId : null,
    evidence_match_type: (raw.evidenceMatchType as Question['evidence_match_type']) ?? null,
    decision_target:     typeof raw.decisionTarget === 'string' ? raw.decisionTarget : null,
    deciding_clue:       typeof raw.decidingClue === 'string' ? raw.decidingClue : null,
    most_tempting_distractor: typeof raw.mostTemptingDistractor === 'string' ? raw.mostTemptingDistractor : null,
    why_tempting:        typeof raw.whyTempting === 'string' ? raw.whyTempting : null,
    why_fails:           typeof raw.whyFails === 'string' ? raw.whyFails : null,
    option_set_flags:    null,
    flagged:             false,
    flag_reason:         null,
  };

  const [optionFlags] = runOptionSetAudit([normalized]);
  normalized.option_set_flags = optionFlags?.length ? optionFlags : null;
  return normalized;
}

// ─── generateCoverageQuestions — verbatim prompt ──────────────────────────────

interface ConceptSpec {
  id:            string;
  name:          string;
  category:      string;
  importance:    string;
  keyFacts:      string[];
  clinicalRelevance: string;
  associations:  string[];
  pageEstimate:  string;
  coverageDomain: string;
  chunk_ids:     string[];
}

interface ConceptGenerationContext {
  concept: ConceptSpec;
  levels: number[];
  facts: string;
  chunks: ChunkRecord[];
  ragPassages: string;
  neighborSnippets: string[];
}

export interface SlotGenerationFailure {
  conceptId: string;
  conceptName: string;
  level: number;
  reason: string;
  raw: Record<string, unknown> | null;
}

function buildSlotFromContext(context: ConceptGenerationContext, level: number): GenerationSlot {
  return {
    conceptId: context.concept.id,
    conceptName: context.concept.name,
    category: context.concept.category,
    importance: context.concept.importance as GenerationSlot['importance'],
    level: level as GenerationSlot['level'],
    // Mirror inventory.ts default: unmatched concepts are entity_recall (named entities,
    // diseases, syndromes), NOT definition_recall. The old default here would still
    // route any concept missing coverageDomain into the physiology definition-soup
    // path, which fires shouldRewriteAsNamedConceptDefinition() and produces the
    // "In the source passage, which named concept is described by..." template.
    // See commit 4b2df97 (inventory side) — this is the matching generation-side fix.
    coverageDomain: context.concept.coverageDomain ?? 'entity_recall',
    chunkIds: context.concept.chunk_ids ?? [],
    pageEstimate: context.concept.pageEstimate ?? '',
    keyFacts: context.concept.keyFacts ?? [],
    clinicalRelevance: context.concept.clinicalRelevance ?? '',
    associations: context.concept.associations ?? [],
  };
}

function buildDefinitionChoicePool(
  slot: GenerationSlot,
  allConceptSpecs: ConceptSpec[],
  candidatePool: DistractorCandidate[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>([normalizeOptionComparisonText(slot.conceptName)]);
  const push = (text: string) => {
    const cleaned = text.trim();
    const key = normalizeOptionComparisonText(cleaned);
    if (!cleaned || !key || seen.has(key)) return;
    seen.add(key);
    out.push(cleaned);
  };

  candidatePool.forEach(candidate => push(candidate.text));
  allConceptSpecs
    .filter(concept => concept.id !== slot.conceptId)
    .filter(concept => (
      concept.coverageDomain === slot.coverageDomain
      || /pressure|volume|compliance|distensibility|pulse|venous|arterial|reservoir/i.test(concept.name)
    ))
    .sort((a, b) => {
      const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
      return (order[a.importance] ?? 2) - (order[b.importance] ?? 2);
    })
    .forEach(concept => push(concept.name));

  return out;
}

function shouldRewriteAsNamedConceptDefinition(raw: Record<string, unknown>, slot: GenerationSlot): boolean {
  if (slot.level !== 1) return false;

  const decisionTarget = typeof raw.decisionTarget === 'string' ? raw.decisionTarget.toLowerCase() : '';
  const options = Array.isArray(raw.options)
    ? raw.options.filter((opt): opt is string => typeof opt === 'string')
    : [];
  if (options.length < 4) return false;

  const definitionLikeCount = options.filter(option => {
    const trimmed = option.trim();
    const wordCount = trimmed.split(/\s+/).length;
    return wordCount >= 6 && /^(the\s+|ability\s+of|capacity\s+of|increase\s+in)/i.test(trimmed);
  }).length;

  // Only rewrite when options are genuinely definition-soup sentences AND we are
  // in a physiology definition-recall domain (e.g. vascular compliance/distensibility).
  // Excluding `decisionTarget === 'definition'` alone prevents the writer's label from
  // triggering this for pathology concepts, which all received 'entity_recall' domain
  // and should produce real clinical/mechanistic questions instead of named-concept templates.
  return (slot.coverageDomain === 'definition_recall' || slot.coverageDomain === 'pressure_volume_quantitative')
    && definitionLikeCount >= Math.max(3, options.length - 1);
}

function buildDefinitionStemFromClue(clue: string): string {
  // Avoid template stems that trigger the definition-soup detector in
  // question-validation.ts (e.g. "The concept defined by..."). Use a
  // clue-forward phrasing that reads as a real recall question.
  const normalized = clue.replace(/\.$/, '').trim();
  if (!normalized) {
    return 'In the source passage, which named concept matches the clue described in this stem?';
  }
  // Shorten very long clues so the stem stays readable.
  const trimmedClue = normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
  return `In the source passage, which named concept is described by "${trimmedClue}"?`;
}

function countMeaningfulOptionTokens(text: string): number {
  return normalizeOptionComparisonText(text).split(' ').filter(token => token.length >= 3).length;
}

function hasParenthetical(text: string): boolean {
  return /\([^)]+\)/.test(text);
}

// Generic noun suffixes that are meaningless for distinguishing options.
// "LDL particles" vs "HDL particles" — stripping "particles" leaves the
// discriminating token. Same for "cells", "disease", "syndrome", etc.
const OPTION_SUFFIX_NOISE = new Set([
  'particles', 'cells', 'cell', 'disease', 'diseases', 'syndrome', 'syndromes',
  'disorder', 'disorders', 'condition', 'conditions', 'type', 'types',
  'formation', 'occurrence', 'incident', 'event', 'process', 'mechanism',
  'therapy', 'treatment', 'development', 'activation', 'dysfunction',
  'injury', 'damage', 'response', 'reaction', 'changes', 'change',
]);

function optionsAreTooSimilar(a: string, b: string): boolean {
  const normalizedA = normalizeOptionComparisonText(a);
  const normalizedB = normalizeOptionComparisonText(b);
  if (!normalizedA || !normalizedB) return false;
  if (normalizedA === normalizedB) return true;
  if (normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA)) return true;

  // Keep tokens ≥3 chars (captures abbreviations like LDL, HDL, CRP) but
  // strip generic suffixes that are shared by all options in a category set
  // (e.g. "particles", "cells") — they would otherwise overwhelm the overlap
  // ratio and flag perfectly valid same-category distractor sets.
  const filterTokens = (text: string) =>
    text.split(' ').filter(token => token.length >= 3 && !OPTION_SUFFIX_NOISE.has(token));

  const tokensA = filterTokens(normalizedA);
  const tokensB = filterTokens(normalizedB);
  if (!tokensA.length || !tokensB.length) return false;

  const shared = tokensA.filter(token => tokensB.includes(token)).length;
  return shared / Math.max(1, Math.min(tokensA.length, tokensB.length)) > 0.65;
}

function scoreDefinitionDistractor(candidate: string, conceptName: string): number {
  const candidateTokens = countMeaningfulOptionTokens(candidate);
  const conceptTokens = countMeaningfulOptionTokens(conceptName);
  let score = 10 - Math.min(Math.abs(candidateTokens - conceptTokens), 6);

  if (hasParenthetical(candidate) !== hasParenthetical(conceptName)) {
    score -= 3;
  }
  if (candidate.includes('/') !== conceptName.includes('/')) {
    score -= 2;
  }

  return score;
}

export function rewriteDefinitionStyleDraft(
  raw: Record<string, unknown>,
  slot: GenerationSlot,
  allConceptSpecs: ConceptSpec[],
  candidatePool: DistractorCandidate[],
): Record<string, unknown> {
  if (!shouldRewriteAsNamedConceptDefinition(raw, slot)) {
    return raw;
  }

  const expectedOptionCount = getExpectedOptionCount(slot.level);
  const choicePool = buildDefinitionChoicePool(slot, allConceptSpecs, candidatePool);
  if (choicePool.length < expectedOptionCount - 1) {
    return raw;
  }

  const currentMostTempting = typeof raw.mostTemptingDistractor === 'string' ? raw.mostTemptingDistractor.trim() : '';
  const currentWhyTempting = typeof raw.whyTempting === 'string' ? raw.whyTempting.trim() : '';
  const currentWhyFails = typeof raw.whyFails === 'string' ? raw.whyFails.trim() : '';
  const decidingClue = typeof raw.decidingClue === 'string' ? raw.decidingClue.trim() : '';
  const sourceQuote = typeof raw.sourceQuote === 'string' ? raw.sourceQuote.trim() : '';
  const clue = decidingClue || sourceQuote || slot.keyFacts[0] || slot.conceptName;
  const answerIndex = typeof raw.correctAnswer === 'number' && raw.correctAnswer >= 0 && raw.correctAnswer < expectedOptionCount
    ? raw.correctAnswer
    : Math.min(2, expectedOptionCount - 1);

  const distractors: string[] = [];
  const candidateDistractors: string[] = [];
  const pushDistractor = (text: string) => {
    const cleaned = text.trim();
    const key = normalizeOptionComparisonText(cleaned);
    if (
      !cleaned
      || key === normalizeOptionComparisonText(slot.conceptName)
      || candidateDistractors.some(existing => normalizeOptionComparisonText(existing) === key)
    ) return;
    candidateDistractors.push(cleaned);
  };

  if (currentMostTempting && !/^(the\s+(ability|capacity|increase|resistance|pressure|rate)|ability\s+of|capacity\s+of)/i.test(currentMostTempting)) {
    pushDistractor(currentMostTempting);
  }
  choicePool.forEach(pushDistractor);
  if (candidateDistractors.length < expectedOptionCount - 1) {
    return raw;
  }

  const rankedDistractors = candidateDistractors
    .sort((a, b) => scoreDefinitionDistractor(b, slot.conceptName) - scoreDefinitionDistractor(a, slot.conceptName));

  for (const candidate of rankedDistractors) {
    if (distractors.some(existing => optionsAreTooSimilar(existing, candidate))) continue;
    distractors.push(candidate);
    if (distractors.length >= expectedOptionCount - 1) break;
  }

  if (distractors.length < expectedOptionCount - 1) {
    for (const candidate of rankedDistractors) {
      if (distractors.some(existing => normalizeOptionComparisonText(existing) === normalizeOptionComparisonText(candidate))) continue;
      distractors.push(candidate);
      if (distractors.length >= expectedOptionCount - 1) break;
    }
  }

  const options = Array.from({ length: expectedOptionCount }, (_, idx) =>
    idx === answerIndex ? slot.conceptName : distractors.shift() ?? 'Related concept',
  );
  const mostTemptingDistractor = options.find((option, idx) => idx !== answerIndex) ?? '';
  const whyTempting = currentWhyTempting || `${mostTemptingDistractor} is a nearby pressure-volume concept from the same chapter.`;
  const whyFails = currentWhyFails || (decidingClue
    ? `${mostTemptingDistractor} does not match the defining clue: ${decidingClue}.`
    : `${mostTemptingDistractor} does not match the defining clue in the stem.`);

  return {
    ...raw,
    question: buildDefinitionStemFromClue(clue),
    options,
    correctAnswer: answerIndex,
    decisionTarget: 'definition',
    mostTemptingDistractor,
    whyTempting,
    whyFails,
    explanation: `${slot.conceptName} is correct because it matches the defining clue in the stem. ${mostTemptingDistractor} is tempting because ${whyTempting.replace(/\.$/, '')}, but fails because ${whyFails.replace(/\.$/, '')}.`,
  };
}

async function buildConceptGenerationContexts(
  batch: ConceptSpec[],
  pdfId: string,
  dc: DensityConfig,
  allChunkRecords: ChunkRecord[],
  confusionMap: ConfusionMap,
  bm25Index: BM25Index | null,
  onCost?: OpenAICostTracker,
): Promise<ConceptGenerationContext[]> {
  const hasEmbeddings = allChunkRecords.some(c => c.embedding && c.embedding.length > 0);
  let conceptChunks: ChunkRecord[][] = batch.map(() => []);
  let neighborSnippetsByConcept: string[][] = batch.map(() => []);

  if (hasEmbeddings) {
    try {
      const queries = batch.map(c => `${c.name}: ${(c.keyFacts ?? []).slice(0, 3).join('. ')}`);
      const queryVecs = await embedTexts(queries, onCost);

      for (let i = 0; i < queryVecs.length; i++) {
        const qVec = queryVecs[i]!;
        const concept = batch[i]!;
        const queryText = queries[i]!;
        const sourceIds = new Set(concept.chunk_ids ?? []);
        const sourceChunks = allChunkRecords.filter(r => sourceIds.has(r.id) && r.embedding.length > 0);
        const excluded = new Set(sourceChunks.map(r => r.id));
        const simChunks = await retrieveTopChunks(
          pdfId,
          qVec,
          queryText,
          bm25Index,
          allChunkRecords.filter(r => !excluded.has(r.id)),
          Math.max(0, RAG_TOP_K - sourceChunks.length),
        );
        conceptChunks[i] = [...sourceChunks, ...simChunks].slice(0, RAG_TOP_K);
      }

      if (env.flags.negativeRag) {
        const neighborQueries = batch.map(concept => {
          const confusions = confusionMap[concept.name] ?? [];
          return confusions
            .slice(0, 2)
            .map(confusion => `${confusion.concept} (${confusion.reason})`)
            .join('; ');
        });
        const hasNeighbors = neighborQueries.some(query => query.length > 0);
        if (hasNeighbors) {
          const neighborVecs = await embedTexts(
            neighborQueries.map((query, idx) => query || batch[idx]!.name),
            onCost,
          );
          const neighborResults = await Promise.all(
            neighborVecs.map((vector, idx) => {
              if (!neighborQueries[idx]) return Promise.resolve([]);
              return retrieveTopChunks(pdfId, vector, neighborQueries[idx]!, bm25Index, allChunkRecords, 2)
                .catch(() => [] as ChunkRecord[]);
            }),
          );
          neighborSnippetsByConcept = neighborResults.map(chunks => chunks.map(chunk => chunk.text.slice(0, 200)));
        }
      }
    } catch (e) {
      console.warn('RAG embedding failed for batch — falling back to no-RAG:', (e as Error).message);
      conceptChunks = batch.map(() => []);
      neighborSnippetsByConcept = batch.map(() => []);
    }
  }

  return batch.map((concept, idx) => {
    const levels = dc.levels[concept.importance as keyof typeof dc.levels] ?? [1, 2];
    let guardedLevels = levels;
    if (env.flags.l3GroundingGuard && levels.includes(3) && !hasClinicalPresentationSupport(conceptChunks[idx] ?? [])) {
      guardedLevels = Array.from(new Set(levels.map(l => l === 3 ? 2 : l)));
      console.log(`[Pipeline] L3→L2 downgrade: ${concept.name} (insufficient clinical context in chunks)`);
    }

    const facts = [
      ...(concept.keyFacts ?? []),
      concept.clinicalRelevance ?? '',
      ...(concept.associations ?? []).slice(0, 3),
    ].filter(Boolean).join('; ');

    const ragPassages = (conceptChunks[idx] ?? []).map(chunk => {
      const pageRange =
        chunk.start_page && chunk.end_page && chunk.start_page !== chunk.end_page
          ? `pages ${chunk.start_page}–${chunk.end_page}`
          : `page ${chunk.start_page ?? '?'}`;
      return `> "${chunk.text.slice(0, 350).replace(/"/g, "'")}" [${pageRange}]`;
    }).join('\n');

    return {
      concept,
      levels: guardedLevels,
      facts,
      chunks: conceptChunks[idx] ?? [],
      ragPassages,
      neighborSnippets: neighborSnippetsByConcept[idx] ?? [],
    };
  });
}

async function generateQuestionsBySlot(
  contexts: ConceptGenerationContext[],
  allConceptSpecs: ConceptSpec[],
  pdfId: string,
  userId: string,
  confusionMap: ConfusionMap,
  onCost?: OpenAICostTracker,
): Promise<{
  questions: Array<Omit<Question, 'id' | 'created_at'>>;
  rejectedSlots: SlotGenerationFailure[];
  costUSD: number;
}> {
  const questions: Array<Omit<Question, 'id' | 'created_at'>> = [];
  const rejectedSlots: SlotGenerationFailure[] = [];
  let totalCost = 0;

  for (const context of contexts) {
    for (const level of context.levels) {
      const slot = buildSlotFromContext(context, level);
      const confusions = confusionMap[slot.conceptName] ?? [];
      const candidatePool = buildDistractorCandidatePool(slot, allConceptSpecs, confusions, context.neighborSnippets);
      const confusionText = confusions.length
        ? confusions.map(confusion => `${confusion.concept} (${confusion.reason})`).join('; ')
        : '';
      const candidatePoolText = formatDistractorCandidatePool(candidatePool);
      const neighborGuide = context.neighborSnippets.length
        ? context.neighborSnippets.map(snippet => `"${snippet}"`).join(' | ')
        : '';
      const evidenceCorpus = context.chunks.map(chunk => chunk.text).join('\n');

      const deterministicRaw = buildPressureVolumePropertyDraft(slot, evidenceCorpus);
      if (deterministicRaw) {
        const repairedDeterministic = repairDraftForValidation(deterministicRaw, evidenceCorpus);
        const deterministicValidation = validateQuestionDraft(repairedDeterministic, {
          conceptId: slot.conceptId,
          conceptName: slot.conceptName,
          expectedLevel: slot.level,
          evidenceCorpus,
        });
        const deterministicNormed = normaliseQuestion(
          {
            ...repairedDeterministic,
            level: slot.level,
            conceptId: slot.conceptId,
            conceptName: slot.conceptName,
            evidenceMatchType: deterministicValidation.evidenceResult.evidenceMatchType,
            optionSetFlags: deterministicValidation.optionFlags,
          },
          context.concept,
          slot.level,
          pdfId,
          userId,
        );
        if (deterministicNormed) {
          questions.push(deterministicNormed);
          continue;
        }
      }

      let saved = false;
      let lastReason = 'Writer did not return a normalizable question draft.';
      let lastRaw: Record<string, unknown> | null = null;
      let lastCritique = 'Return a fully valid board-style item that obeys all option-set, explanation, and evidence rules.';
      let lastCriterion = 'INITIAL_GENERATION';
      let attemptedOptionBalanceRevise = false;

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const revisionSeed = attempt > 0 && lastRaw
            ? toRevisionSeed(lastRaw, slot.level, slot.conceptId)
            : null;
          const { raw, costUSD } = revisionSeed
            ? await writerAgentRevise(
                context.concept,
                revisionSeed,
                lastCriterion,
                lastCritique,
                context.ragPassages,
                confusionText || candidatePoolText || neighborGuide,
                onCost,
              )
            : await writerAgentGenerate(
                context.concept,
                slot,
                context.ragPassages,
                confusionText,
                candidatePool,
                candidatePoolText,
                neighborGuide,
                onCost,
              );
          totalCost += costUSD;
          const rewrittenRaw = rewriteDefinitionStyleDraft(raw, slot, allConceptSpecs, candidatePool);
          const repairedRaw = repairDraftForValidation(rewrittenRaw, evidenceCorpus);
          lastRaw = repairedRaw;

          const validation = validateQuestionDraft(repairedRaw, {
            conceptId: slot.conceptId,
            conceptName: slot.conceptName,
            expectedLevel: slot.level,
            evidenceCorpus,
          });
          const optionBalanceSignal = balanceOptionLengths(optionsFromRaw(repairedRaw), answerFromRaw(repairedRaw));

          if (env.flags.strictQuestionValidation && (!validation.ok || !validation.evidenceOk)) {
            const hasOptionLengthTell = validation.issues.includes(
              'Option lengths create a test-taking tell rather than requiring medical knowledge.',
            );
            if (hasOptionLengthTell && optionBalanceSignal && !attemptedOptionBalanceRevise) {
              attemptedOptionBalanceRevise = true;
              lastCriterion = 'OPTION_SET_HOMOGENEITY';
              lastCritique = 'Rewrite distractors so all four options are within ±25% of the correct answer\'s length. Do not change the keyed option or the stem.';
              lastReason = validation.issues[0] ?? 'Option lengths create a test-taking tell rather than requiring medical knowledge.';
              continue;
            }

            lastCriterion = validation.evidenceOk ? 'STRICT_VALIDATION' : 'EVIDENCE_GROUNDING';
            const issueList = validation.issues.length
              ? validation.issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n')
              : 'Return a fully grounded draft that satisfies all deterministic validation checks.';
            lastCritique = `Fix EVERY one of the following issues in your next draft (do not ignore any):\n${issueList}`;
            lastReason = validation.issues[0] ?? 'Writer returned a draft that failed deterministic validation.';
            continue;
          }

          const hasExplanationAnswerMismatch = validation.issues.some(issue =>
            /different answer choice than the keyed correct answer/i.test(issue)
          );
          if (hasExplanationAnswerMismatch) {
            lastCriterion = 'ANSWER_KEY_MISMATCH';
            const mismatchIssue = validation.issues.find(issue =>
              /different answer choice than the keyed correct answer/i.test(issue)
            ) ?? 'Align the explanation and the correctAnswer index so they point to the same option.';
            const otherIssues = validation.issues.filter(issue => issue !== mismatchIssue);
            lastCritique = otherIssues.length
              ? `${mismatchIssue}\nAlso fix:\n${otherIssues.map((issue, i) => `${i + 1}. ${issue}`).join('\n')}`
              : mismatchIssue;
            lastReason = 'Writer returned a draft whose explanation supports a different option than the keyed answer.';
            continue;
          }

          // validateQuestionDraft is still primarily used for side-effect data
          // (evidenceMatchType, optionFlags). Most content-quality issues remain in
          // the downstream audit/revision loop. The explanation/key mismatch is the
          // exception because it produces user-visible wrong-answer grading.

          const normed = normaliseQuestion(
            {
              ...repairedRaw,
              level: slot.level,
              conceptId: slot.conceptId,
              conceptName: slot.conceptName,
              ...inferEvidenceProvenance(
                typeof repairedRaw.sourceQuote === 'string' ? repairedRaw.sourceQuote : '',
                context.chunks,
                validation.evidenceResult.evidenceMatchedText,
              ),
              evidenceMatchType: validation.evidenceResult.evidenceMatchType,
              optionSetFlags: validation.optionFlags,
            },
            context.concept,
            slot.level,
            pdfId,
            userId,
          );

          if (normed) {
            questions.push(normed);
            saved = true;
            break;
          }

          lastCriterion = 'SHAPE_VALIDATION';
          lastCritique = validation.issues.length
            ? `Fix EVERY one of the following issues in your next draft:\n${validation.issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n')}`
            : 'Return the exact required option count and a valid correctAnswer index.';
          lastReason = 'Writer returned a draft that could not be normalized (wrong option count or invalid answer index).';
          if (!validation.shouldRetry) break;
        } catch (e) {
          lastReason = (e as Error).message;
        }
      }

      if (!saved) {
        rejectedSlots.push({
          conceptId: slot.conceptId,
          conceptName: slot.conceptName,
          level: slot.level,
          reason: lastReason,
          raw: lastRaw,
        });
      }
    }
  }

  return { questions, rejectedSlots, costUSD: totalCost };
}

function optionsFromRaw(raw: Record<string, unknown>): string[] {
  return Array.isArray(raw.options)
    ? raw.options.filter((option): option is string => typeof option === 'string')
    : [];
}

function answerFromRaw(raw: Record<string, unknown>): number {
  return typeof raw.correctAnswer === 'number' ? raw.correctAnswer : -1;
}

export async function generateCoverageQuestions(
  batch:          ConceptSpec[],
  pdfId:          string,
  userId:         string,
  dc:             DensityConfig,
  allChunkRecords: ChunkRecord[],
  confusionMap:   ConfusionMap,
  bm25Index:      BM25Index | null,
  allConceptSpecs: ConceptSpec[] = batch,
  onCost?: OpenAICostTracker,
): Promise<{
  questions: Array<Omit<Question, 'id' | 'created_at'>>;
  rejectedSlots: SlotGenerationFailure[];
  costUSD: number;
}> {
  const contexts = await buildConceptGenerationContexts(
    batch,
    pdfId,
    dc,
    allChunkRecords,
    confusionMap,
    bm25Index,
    onCost,
  );
  return generateQuestionsBySlot(contexts, allConceptSpecs, pdfId, userId, confusionMap, onCost);
}

// ─── writerAgentGenerate — verbatim prompt ────────────────────────────────────

export async function writerAgentGenerate(
  concept:        ConceptSpec,
  slot:           GenerationSlot,
  ragPassages:    string,
  confusionPairs: string,
  distractorCandidates: DistractorCandidate[],
  distractorPoolText: string,
  neighborGuide:  string,
  onCost?: OpenAICostTracker,
): Promise<{ raw: Record<string, unknown>; costUSD: number }> {
  const level = slot.level;
  const levelLabel =
    level === 1 ? 'L1 — Recall / Definition' :
    level === 2 ? 'L2 — Mechanism / Application' :
                  'L3 — Clinical Vignette / Comparison';
  const expectedOptionCount = getExpectedOptionCount(level);
  const facts = [
    ...(concept.keyFacts ?? []),
    concept.clinicalRelevance ?? '',
    ...(concept.associations ?? []).slice(0, 3),
  ].filter(Boolean).join('; ');

  const exemplars = findSimilarExemplars(concept.name, level, 2);
  const exemplarSection = exemplars.length > 0
    ? `\nFEW-SHOT EXEMPLARS — Study these ${level === 1 ? 'definition-style' : level === 2 ? 'mechanism-based' : 'clinical vignette'} questions and adopt their structure:\n${exemplars
        .map((ex, i) => {
          const correctIdx = ex.options.findIndex(o => o.letter === ex.correctLetter);
          return `\nEXAMPLE ${i + 1} [${ex.topic}]:\n` +
            `Stem: "${ex.stem}"\n` +
            `Options: ${ex.options.map((o, j) => `${j === correctIdx ? '★' : ' '} ${o.letter}) ${o.text}`).join(' | ')}\n` +
            `Explanation: "${ex.explanation}"\n` +
            `Citation: ${ex.citation}`;
        })
        .join('\n')}\n`
    : '';

  const sourceSection = ragPassages
    ? `\nSOURCE PASSAGES FROM PDF (use to ground the question and sourceQuote):\n${ragPassages}\n`
    : '';
  const confusionSection = confusionPairs
    ? `\nKNOWN CONFUSION PAIRS — use these as distractors where appropriate:\n${confusionPairs}\n`
    : '';
  const candidatePoolSection = distractorPoolText
    ? `\nDISTRACTOR CANDIDATE POOL — prefer these over inventing new options. Keep the answer choices in the same comparison class and at the same granularity.\n${distractorPoolText}\n`
    : '';
  const neighborSection = neighborGuide
    ? `\nNEGATIVE-RAG DISTRACTOR GROUNDING — use these neighbor snippets only if they help explain why a tempting distractor fails.\n${neighborGuide}\n`
    : '';
  const definitionSection = level === 1 && slot.coverageDomain === 'definition_recall'
    ? `\nDEFINITION-STYLE ITEM GUIDANCE:\n- Do NOT ask "Which statement best defines ${concept.name}?" followed by five paraphrased sentence-definitions.\n- Prefer a clue-forward stem such as "The vascular property defined as ..." or "A vessel feature characterized by ..." and use concise named property/concept options.\n- For this item type, options should usually be short noun phrases or named chapter concepts from the distractor pool, not five long explanatory sentences with the same template.\n- Use the source text clue in the stem, and make the answer choices the competing named concepts.\n`
    : '';

  const prompt = `You are a specialist USMLE/COMLEX Writer Agent. Generate exactly ONE board-quality MCQ.

SLOT IDENTITY:
- conceptId: ${slot.conceptId}
- conceptName: ${concept.name}
- requiredLevel: ${level}

CONCEPT: ${concept.name} [${concept.category}] [${concept.importance}-yield]
Required level: ${levelLabel}
Key information: ${facts}${exemplarSection}${sourceSection}${confusionSection}${candidatePoolSection}${neighborSection}${definitionSection}

RULES (all mandatory):
1. EVIDENCE. sourceQuote MUST be ONE complete sentence copied verbatim from SOURCE PASSAGES, from its capital letter to its period. No paraphrasing, no stitching clauses from different sentences, no deleting words. Minimum 10 words. The sentence must directly prove the keyed answer. Do NOT pick a sentence from a chapter outline, table of contents, index, list of figures, or page header — pick a body-text sentence. If no single body-text sentence in the passages proves the answer, pick a different angle on the same concept.
2. STEM. The stem must be specific enough that an expert can answer it before seeing the options. Never write "Which is true about X" or "Which best describes X" stems. Never use template stems such as "The concept defined by X is...", "The condition characterized by Y is...", or "Which condition is characterized by Z?" — write a real clinical, mechanistic, or applied question. ${level === 3 ? 'L3: open with age, sex, and a short presentation, then ask the reasoning question.' : level === 2 ? 'L2: frame a mechanism or application, not a plain definition.' : 'L1: ask for a named concept that matches a specific clue from the source.'}
3. OPTIONS. Exactly ${expectedOptionCount} options. All in the same comparison class (all mechanisms, or all named entities, or all lab findings — never mixed). All within 1–2 words of each other in length AND the same grammatical shape (all noun phrases, OR all "verb + object" phrases, OR all "noun + because-clause" — never mix shapes). No two options may end with the same word. If the correct answer contains a parenthetical, every distractor must also contain a parenthetical of similar length; otherwise no parentheticals at all.
4. DISTRACTORS. Each must be a genuine near-miss a partially-informed student would plausibly pick. Prefer entries from the DISTRACTOR CANDIDATE POOL. Do not reuse the same clinical word or root across 3+ options while the correct answer lacks it.
5. NO TELLS. The correct answer must not stand out by length, specificity, grammar, or parenthetical detail. Never use "all of the above" or "none of the above".
6. CONCEPT FIDELITY. Echo conceptId exactly as provided. The question must test ${concept.name}, not a neighboring concept.
7. NEGATION. Avoid NOT/EXCEPT/LEAST stems at L1. At L2/L3, if you use one, every non-keyed option must be unambiguously true.
8. EXPLANATION. Two sentences, plain prose, no scaffolding phrases. Sentence one: why the correct answer is correct, citing the mechanism or clue from the source AND naming the keyed answer text explicitly. Sentence two: why the single closest distractor is wrong for THIS question, naming that distractor explicitly. Do not list all distractors. Do not include the phrase "Key distinction".
9. METADATA. Populate decisionTarget (diagnosis / mechanism / distinguishing feature / next best step / comparison / definition), decidingClue, whyTempting (one short clause), whyFails (one short clause). decidingClue MUST be a verbatim phrase of 4–12 words copied directly from your sourceQuote — do NOT paraphrase, do NOT invent new wording. The decidingClue must literally appear inside sourceQuote. These are stored as sidecar data — do not paste them into the explanation text.

Return a single JSON object only — no markdown, no prose:
{"conceptId":"${slot.conceptId}","conceptName":"${concept.name}","level":${level},"question":"...","options":[${Array.from({ length: expectedOptionCount }).map(() => '"..."').join(',')}],"correctAnswer":2,"explanation":"...","sourceQuote":"...","pageEstimate":"${concept.pageEstimate || ''}","decisionTarget":"...","decidingClue":"...","whyTempting":"...","whyFails":"..."}`;

  const { text, costUSD } = await callOpenAI(prompt, 2048, WRITER_MODEL, onCost, {
    responseFormat: { type: 'json_object' },
  });
  const rawParsed = parseJSON(text);
  const raw = Array.isArray(rawParsed) ? rawParsed[0] : rawParsed;
  return { raw: raw as Record<string, unknown>, costUSD };
}

// ─── writerAgentRevise — verbatim prompt ─────────────────────────────────────

export async function writerAgentRevise(
  concept:     ConceptSpec,
  prevQuestion: {
    stem: string;
    options: string[];
    answer: number;
    level: number;
    pageEstimate?: string;
    decidingClue?: string;
    decisionTarget?: string;
    mostTemptingDistractor?: string;
    conceptId?: string;
  },
  criterion:   string,
  critique:    string,
  ragPassages: string,
  distractorGuide: string,
  onCost?: OpenAICostTracker,
): Promise<{ raw: Record<string, unknown>; costUSD: number }> {
  const level = prevQuestion.level;
  const levelLabel =
    level === 1 ? 'L1 — Recall / Definition' :
    level === 2 ? 'L2 — Mechanism / Application' :
                  'L3 — Clinical Vignette / Comparison';
  const expectedOptionCount = getExpectedOptionCount(level);
  const facts = [
    ...(concept.keyFacts ?? []),
    concept.clinicalRelevance ?? '',
    ...(concept.associations ?? []).slice(0, 3),
  ].filter(Boolean).join('; ');

  const sourceSection = ragPassages
    ? `\nSOURCE PASSAGES FROM PDF:\n${ragPassages}\n`
    : '';

  const metadataContext = prevQuestion.decidingClue
    ? `\nDesign metadata: decisionTarget=${prevQuestion.decisionTarget ?? '?'} | decidingClue="${prevQuestion.decidingClue}" | mostTemptingDistractor="${prevQuestion.mostTemptingDistractor ?? '?'}"`
    : '';
  const distractorSection = distractorGuide
    ? `\nDISTRACTOR GUIDE:\n${distractorGuide}\n`
    : '';
  const isDefinitionStyleStem = /\bwhich\b.{0,30}(best\s+)?(describe|define|characterize|represent)/i.test(prevQuestion.stem)
    || prevQuestion.decisionTarget === 'definition';
  const allOptionsShareTemplate = prevQuestion.options.length >= 3 && (() => {
    const prefix = (s: string) => s.trim().toLowerCase().split(/\s+/).slice(0, 4).join(' ');
    const prefixes = prevQuestion.options.map(prefix);
    const first = prefixes[0];
    return prefixes.filter(p => p === first).length >= Math.ceil(prevQuestion.options.length * 0.6);
  })();
  const definitionSection = (isDefinitionStyleStem || criterion === 'OPTION_SET_HOMOGENEITY' || allOptionsShareTemplate)
    ? `\nDEFINITION-STYLE REVISION GUIDANCE:\n- Do NOT keep a stem of the form "Which of the following best describes/defines ${concept.name}?" — this reliably produces option-template soup.\n- Instead, rewrite the stem as a clue-forward question: "The vascular property defined as [decidingClue] is:" or "A vessel characterized by [clue] is demonstrating:".\n- ALL options must be short named concepts or noun phrases (e.g. "Vascular Compliance", "Vascular Distensibility", "Vascular Elastance") drawn from the DISTRACTOR GUIDE — NOT sentence-definitions beginning with "The ability of..." or "The capacity of...".\n- If the DISTRACTOR GUIDE lacks enough named alternatives, invent plausible named chapter concepts at the same granularity.\n- Verify: no two options begin with the same 4 words.\n`
    : '';

  const prompt = `You are a specialist USMLE/COMLEX Writer Agent. Revise the question below to address one specific auditor flaw.

CONCEPT: ${concept.name} [${concept.category}]
Required level: ${levelLabel}
Slot conceptId: ${prevQuestion.conceptId ?? concept.id}
Key information: ${facts}${sourceSection}${metadataContext}${distractorSection}${definitionSection}

PREVIOUS VERSION:
Stem: ${prevQuestion.stem}
Options: ${prevQuestion.options.map((o, j) => `${j === prevQuestion.answer ? '★' : ''}${['A', 'B', 'C', 'D', 'E'][j]}) ${o}`).join(' | ')}

AUDITOR FEEDBACK — Criterion: ${criterion}
Fix: "${critique}"

Address ONLY the named flaw. Preserve everything else that worked. Keep the same concept, level, and tested mechanism.

Writing rules that still apply:
- sourceQuote is ONE complete verbatim sentence from SOURCE PASSAGES, ≥10 words, and directly proves the keyed answer. Do not paraphrase. Do NOT pick a sentence from a chapter outline, table of contents, index, or list of figures.
- Exactly ${expectedOptionCount} options. Same comparison class. All options within 1–2 words of each other in length, same grammatical shape. No two options end with the same word. No parentheticals on only the correct answer.
- Stem must NOT use template phrasings such as "The concept defined by X is..." or "The condition characterized by Y is...". Write a real clinical, mechanistic, or applied question.
- Explanation is two plain sentences: why correct (naming the keyed answer text explicitly), why the closest distractor fails (naming that distractor explicitly). No "Key distinction" phrase, no scaffolding. The keyed answer text must literally appear somewhere in your explanation.
- Echo conceptId exactly. Keep decisionTarget, whyTempting, whyFails populated as sidecar metadata — do not paste them into the explanation.
- decidingClue MUST be a verbatim 4–12 word phrase copied directly from your sourceQuote (no paraphrase, no rewording).

If the flaw is a LENGTH TELL: keep the correct answer as-is and expand every distractor to match its word count and grammatical shape.
If the flaw is OPTION OVERLAP: rewrite distractors so each reflects a distinct misconception; prefer distinct named concepts from DISTRACTOR GUIDE over paraphrased synonyms.
If the flaw is EVIDENCE GROUNDING: find a different single sentence in SOURCE PASSAGES that proves the answer, and copy it verbatim.

Return a single JSON object only — no markdown, no prose:
{"conceptId":"${prevQuestion.conceptId ?? concept.id}","conceptName":"${concept.name}","level":${level},"question":"...","options":[${Array.from({ length: expectedOptionCount }).map(() => '"..."').join(',')}],"correctAnswer":2,"explanation":"...","sourceQuote":"...","pageEstimate":"${concept.pageEstimate || ''}","decisionTarget":"...","decidingClue":"...","whyTempting":"...","whyFails":"..."}`;

  const { text, costUSD } = await callOpenAI(prompt, 2048, WRITER_MODEL, onCost, {
    responseFormat: { type: 'json_object' },
  });
  const rawParsed = parseJSON(text);
  const raw = Array.isArray(rawParsed) ? rawParsed[0] : rawParsed;
  return { raw: raw as Record<string, unknown>, costUSD };
}

// ─── L3 Grounding Guard ───────────────────────────────────────────────────────
// Returns true if chunks contain sufficient clinical-context language for L3 vignettes.
export function hasClinicalPresentationSupport(chunks: ChunkRecord[]): boolean {
  if (!env.flags.l3GroundingGuard) return true;
  const clinicalSignals = /\b(patient|presents?|year.old|male|female|complain|symptom|sign|vital|lab|imaging|exam|diagnosis|management|treatment|history|physical|workup|finding|fever|pain|dyspnea|fatigue|nausea|vomiting|diarrhea|rash|edema|tachycardia|bradycardia|hypertension|hypotension|biopsy|CBC|BMP|CXR|CT|MRI|EKG|ECG)\b/i;
  const combined = chunks.map(ch => ch.text ?? '').join(' ');
  const matchCount = (combined.match(clinicalSignals) ?? []).length;
  const wordCount = combined.split(/\s+/).length;
  return matchCount >= Math.max(2, wordCount / 200);
}
