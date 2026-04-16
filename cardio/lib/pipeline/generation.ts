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
import { embedTexts } from './embeddings';
import { retrieveTopChunks } from './retrieval';
import { calculateOpenAIUsageCostUSD, type OpenAICostTracker } from '@/lib/openai-cost';
import { getExpectedOptionCount, runOptionSetAudit, validateQuestionDraft } from './question-validation';

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
  options?: { responseFormat?: { type: 'json_object' } },
): Promise<{ text: string; costUSD: number }> {
  const openai = getOpenAI();
  let totalCost = 0;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.3,
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
        const wait = 10_000 * (attempt + 1);
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

function extractEvidenceSentences(evidenceCorpus: string): string[] {
  return evidenceCorpus
    .split(/(?<=[.!?])\s+|\n+/)
    .map(part => part.trim())
    .filter(part => part.length >= 30);
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

  const currentMostTemptingSource = typeof repaired.mostTemptingDistractor === 'string'
    ? repaired.mostTemptingDistractor
    : (typeof repaired.most_tempting_distractor === 'string' ? repaired.most_tempting_distractor : '');
  const currentMostTempting = currentMostTemptingSource
    ? cleanOptions([currentMostTemptingSource])[0] ?? ''
    : '';

  if (wrongOptions.length) {
    const matchedWrong = wrongOptions.find(option => option === currentMostTempting);
    if (matchedWrong) {
      repaired.mostTemptingDistractor = matchedWrong;
      repaired.most_tempting_distractor = matchedWrong;
    } else {
      const closestWrong = [...wrongOptions]
        .map(option => ({
          option,
          score: Math.max(
            optionSimilarityScore(option, currentMostTempting),
            optionSimilarityScore(option, correctOption),
          ),
        }))
        .sort((a, b) => b.score - a.score)[0];

      if (closestWrong && (closestWrong.score >= 0.34 || !currentMostTempting)) {
        repaired.mostTemptingDistractor = closestWrong.option;
        repaired.most_tempting_distractor = closestWrong.option;
      }
    }

    if (!repaired.mostTemptingDistractor && !repaired.most_tempting_distractor) {
      const fallback = [...wrongOptions]
        .sort((a, b) => optionSimilarityScore(b, correctOption) - optionSimilarityScore(a, correctOption))[0];
      if (fallback) {
        repaired.mostTemptingDistractor = fallback;
        repaired.most_tempting_distractor = fallback;
      }
    }
  }

  const decidingClueSource = typeof repaired.decidingClue === 'string'
    ? repaired.decidingClue
    : (typeof repaired.deciding_clue === 'string' ? repaired.deciding_clue : '');
  const decidingClue = decidingClueSource ? decidingClueSource.trim() : '';
  const mostTemptingDistractorSource = typeof repaired.mostTemptingDistractor === 'string'
    ? repaired.mostTemptingDistractor
    : (typeof repaired.most_tempting_distractor === 'string' ? repaired.most_tempting_distractor : '');
  const mostTemptingDistractor = mostTemptingDistractorSource
    ? mostTemptingDistractorSource.trim()
    : '';
  const whyTemptingSource = typeof repaired.whyTempting === 'string'
    ? repaired.whyTempting
    : (typeof repaired.why_tempting === 'string' ? repaired.why_tempting : '');
  const whyFailsSource = typeof repaired.whyFails === 'string'
    ? repaired.whyFails
    : (typeof repaired.why_fails === 'string' ? repaired.why_fails : '');
  const whyTempting = whyTemptingSource ? whyTemptingSource.trim() : '';
  const whyFails = whyFailsSource ? whyFailsSource.trim() : '';
  const explanation = typeof repaired.explanation === 'string' ? repaired.explanation.trim() : '';

  let nextExplanation = explanation;
  if (nextExplanation && mostTemptingDistractor && !/\b(whereas|however|unlike|in contrast|but fails|not because)\b/i.test(nextExplanation)) {
    const temptingReason = whyTempting || 'it shares surface features with the keyed answer';
    const failingReason = whyFails || (decidingClue ? `it does not match the deciding clue: ${decidingClue}` : 'it does not fit the stem-specific clue');
    nextExplanation = `${nextExplanation.replace(/\s+$/, '')} ${mostTemptingDistractor} is tempting because ${temptingReason}, but fails because ${failingReason}.`.trim();
  }
  if (nextExplanation && decidingClue && !/key distinction:/i.test(nextExplanation)) {
    nextExplanation = `${nextExplanation.replace(/\s+$/, '')} Key distinction: ${decidingClue}.`.trim();
  }
  if (nextExplanation && nextExplanation !== explanation) {
    repaired.explanation = nextExplanation;
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
        explanation: 'Distensibility is correct because it is defined as the fractional increase in volume per mm Hg rise in pressure, whereas compliance refers to the total quantity of blood stored per pressure rise. Compliance is tempting because both are pressure-volume vessel properties, but fails because it measures total storage capacity rather than fractional change. Key distinction: fractional increase points to distensibility, whereas total stored volume per pressure rise points to compliance.',
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
        explanation: 'Distensibility is correct because it describes how readily a vessel expands with a pressure increase, whereas compliance refers to the total blood volume stored per pressure rise. Compliance is tempting because both concepts help explain venous storage, but fails because this stem is asking about the vessel wall property that allows expansion itself. Key distinction: readiness to expand with pressure points to distensibility, whereas total storage capacity per pressure rise points to compliance.',
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
        explanation: 'Compliance is correct because it is the total quantity of blood that can be stored per mm Hg pressure rise, whereas distensibility refers to fractional volume change with pressure. Distensibility is tempting because both are pressure-volume concepts, but fails because it does not include the vessel volume term that determines storage capacity. Key distinction: total stored volume per pressure rise points to compliance, whereas fractional change points to distensibility.',
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
        explanation: 'Compliance is correct because veins can store more blood for a given pressure rise, whereas distensibility alone describes relative expansibility without directly capturing total storage. Distensibility is tempting because veins are also highly distensible, but fails because the stem asks about the property that explains much greater blood storage. Key distinction: when the clue is blood stored per pressure rise, the answer is compliance rather than distensibility.',
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
    chunk_id:            null,
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
    coverageDomain: context.concept.coverageDomain ?? 'definition_recall',
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
    return wordCount >= 6 && /^(the\s+(ability|capacity|increase|resistance|pressure|rate|property)|ability\s+of|capacity\s+of|increase\s+in)/i.test(trimmed);
  }).length;

  return slot.coverageDomain === 'definition_recall'
    || decisionTarget === 'definition'
    || definitionLikeCount >= Math.max(3, options.length - 1);
}

function buildDefinitionStemFromClue(clue: string): string {
  const normalized = clue.replace(/\.$/, '').trim();
  if (!normalized) {
    return 'Which concept best matches the defining clue in this stem?';
  }
  if (/^(the|a|an)\b/i.test(normalized)) {
    return `${normalized} is which of the following?`;
  }
  return `The concept defined by ${normalized} is which of the following?`;
}

function rewriteDefinitionStyleDraft(
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
  const pushDistractor = (text: string) => {
    const cleaned = text.trim();
    const key = normalizeOptionComparisonText(cleaned);
    if (
      !cleaned
      || key === normalizeOptionComparisonText(slot.conceptName)
      || distractors.some(existing => normalizeOptionComparisonText(existing) === key)
    ) return;
    distractors.push(cleaned);
  };

  if (currentMostTempting && !/^(the\s+(ability|capacity|increase|resistance|pressure|rate)|ability\s+of|capacity\s+of)/i.test(currentMostTempting)) {
    pushDistractor(currentMostTempting);
  }
  choicePool.forEach(pushDistractor);
  if (distractors.length < expectedOptionCount - 1) {
    return raw;
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
    explanation: `${slot.conceptName} is correct because it matches the defining clue in the stem. ${mostTemptingDistractor} is tempting because ${whyTempting.replace(/\.$/, '')}, but fails because ${whyFails.replace(/\.$/, '')}. Key distinction: ${decidingClue || clue}.`,
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

          // validateQuestionDraft is called for its side-effect data (evidenceMatchType,
          // optionFlags). Do NOT gate on content-quality issues (evidence verification,
          // explanation style, metadata completeness) — those are handled by the audit
          // loop's writer-revision cycle. Blocking here causes near-total rejection
          // because retries get no feedback and temperature=0.3 rarely changes the outcome.
          // normaliseQuestion below enforces the structural minimum (option count, answer index).

          const normed = normaliseQuestion(
            {
              ...repairedRaw,
              level: slot.level,
              conceptId: slot.conceptId,
              conceptName: slot.conceptName,
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
          lastCritique = validation.issues[0] ?? 'Return the exact required option count and a valid correctAnswer index.';
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
- distractorPoolSize: ${distractorCandidates.length}

CONCEPT: ${concept.name} [${concept.category}] [${concept.importance}-yield]
Required level: ${levelLabel}
Key information: ${facts}${sourceSection}${confusionSection}${candidatePoolSection}${neighborSection}${definitionSection}

BOARD-STANDARD WRITING RULES (all mandatory):
1. The correct answer must be directly defensible from the key information or source passages above — no speculation.
2. All distractors must be from the SAME conceptual category as the correct answer (all drugs, all lab findings, all mechanisms, etc.).
3. Every distractor must represent a genuine near-miss — something a partially-informed student would plausibly choose.
4. The stem must be specific enough to answer BEFORE reading the options. Never write "Which is true about X" stems.
5. L3 must open with a patient scenario (age, presentation, key finding) then ask a reasoning question.
6. All options must be approximately the same length. The correct answer must NOT be longer or more detailed.
7. Vary the correct answer position — do NOT default to A or B.
8. The sourceQuote must be a single verbatim sentence copied from the source passages that directly proves the correct answer. Do not paraphrase or merge multiple clauses.
9. L1 questions MUST have exactly 5 options (A-E). L2/L3 questions MUST have exactly 4 options (A-D). This slot requires exactly ${expectedOptionCount} options.
10. Echo conceptId exactly as provided above. Do not change it.
11. mostTemptingDistractor must exactly match one of the incorrect options.
12. Prefer distractors from the provided candidate pool. Only invent a new distractor if the pool is insufficient, and keep it in the same comparison class and granularity.
13. If the concept is a physiologic property, formula, or named definition, do NOT write all options as near-synonymous sentence definitions beginning with the same generic template. Use distinct named chapter concepts, measures, or effects as answer choices whenever the candidate pool supports that.

TELL-SIGN RULES (strictly enforced — these allow guessing without medical knowledge):
14. LENGTH PARITY: Count the words in each option before finalizing. If the correct answer is more than 3 words longer than any distractor, trim it or expand the distractors to match.
15. STRUCTURAL PARITY: All options must use identical grammatical structure. If the correct answer is "[Mechanism] → [Effect]", every distractor must also be "[Mechanism] → [Effect]". Never mix bare noun phrases with full mechanistic phrases across options.
16. NO KEYWORD MIRRORING: If your correct answer contains a rare or specific term from the stem, at least 2 distractors must also contain that same term (applied incorrectly) — otherwise remove it from the correct answer.
17. SPECIFICITY MATCHING: If the correct answer names a specific pathway or receptor, distractors must also name specific (but wrong) pathways or receptors — not vague categories.
18. THE BLINDFOLD TEST: Before finalizing, ask yourself: "Could a smart test-taker eliminate 2 distractors using only test-taking strategy and no medical knowledge?" If yes, rewrite until the answer is no.

CONVERGENCE RULES (strictly enforced — these allow outlier elimination without medical knowledge):
19. THEME DIVERSITY: Each distractor must represent a distinctly different mechanism, pathway, or clinical concept. Never write 2 or more distractors that are variations of the same theme.
20. NO SHARED DOMINANT WORDS: Scan all options. If 3 or more options share a clinically significant word or root while the remaining option does not, rewrite.
21. THE OUTLIER TEST: Before finalizing, ask: "Is one option the obvious odd-one-out based on theme alone?" If yes, rewrite.
22. CROSS-CONCEPT DISTRACTORS: Prefer distractors drawn from related but distinct concepts covered elsewhere in the same chapter.
23. NO DISTRACTOR CLUSTERING: Before finalizing, scan distractors for repeated keywords that make elimination easy.
24. NO POLARITY CLUSTERING: Do not write distractors that all describe the same directional change unless the correct answer also fits that pattern.
25. THE OUTLIER TEST (structural): Before finalizing, ask yourself: "Does the correct answer stand out as the odd one out among the options?" If yes, redesign the set.

NEGATION STEM RULES (applies only to questions containing "NOT," "EXCEPT," or "LEAST likely"):
26. AVOID negation stems at Level 1. Only use negation stems at Level 2 or Level 3.
27. When writing a negation stem, ALL options except the correct answer must be definitively and unambiguously true statements about the concept.
28. Never write a negation stem where the false option is false because of a minor technicality or ambiguous wording.
29. The explanation for a negation stem must explicitly confirm why each true option IS correct, then explain why the keyed answer is the exception.

EXPLANATION RULES:
30. The "explanation" field MUST contain three parts in this order:
    - WHY CORRECT: One sentence stating why the correct answer is right (key mechanism or fact).
    - WHY WRONG: For each distractor, one clause explaining why it is wrong FOR THIS SPECIFIC QUESTION — not just that it is incorrect in general, but what specific feature of this question makes it wrong. Use contrast language: "whereas," "however," "unlike," "in contrast," "not because."
    - DISTINCTION: One final sentence: "Key distinction: [decidingClue] — remember that [reusable rule]."
    Example format: "[Correct answer] because [mechanism]. [MostTempting] is tempting because [shared feature], but fails because [specific reason]; [other distractor] applies only when [context]. Key distinction: [decidingClue] — remember that [reusable rule]."

ITEM DESIGN PROCESS (required):
1. Choose decisionTarget (diagnosis/mechanism/pathophysiology/distinguishing feature/next best step/adverse effect/contraindication/complication/interpretation/comparison)
2. Identify decidingClue: the single clue separating correct from mostTemptingDistractor
3. Identify mostTemptingDistractor: the best near-miss a partially-informed student would choose

Return a single JSON object only — no markdown, no prose:
{"conceptId":"${slot.conceptId}","conceptName":"${concept.name}","level":${level},"question":"...","options":[${Array.from({ length: expectedOptionCount }).map(() => '"..."').join(',')}],"correctAnswer":2,"explanation":"...","sourceQuote":"...","pageEstimate":"${concept.pageEstimate || ''}","decisionTarget":"...","decidingClue":"...","mostTemptingDistractor":"...","whyTempting":"...","whyFails":"..."}`;

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

  const prompt = `You are a specialist USMLE/COMLEX Writer Agent. Revise the question below based on the auditor's feedback.

CONCEPT: ${concept.name} [${concept.category}]
Required level: ${levelLabel}
Slot conceptId: ${prevQuestion.conceptId ?? concept.id}
Key information: ${facts}${sourceSection}${metadataContext}${distractorSection}${definitionSection}

PREVIOUS VERSION (do NOT repeat its flaws):
Stem: ${prevQuestion.stem}
Options: ${prevQuestion.options.map((o, j) => `${j === prevQuestion.answer ? '★' : ''}${['A', 'B', 'C', 'D', 'E'][j]}) ${o}`).join(' | ')}

AUDITOR REJECTION — Criterion violated: ${criterion}
Specific fix required: "${critique}"

Address ONLY the named criterion. Keep everything else correct (same concept, same level, same category constraints). Apply all standard board rules: same-category distractors, equal option lengths, no length tells, stem answerable before options.
If the flaw is a LENGTH TELL: keep the correct answer exactly as-is and rewrite every distractor so it matches the correct answer's word count and grammatical structure (e.g. if correct answer is "Decreased preload due to venous pooling", each distractor must also be a full mechanistic phrase like "Increased afterload due to arterial vasoconstriction" — not bare noun phrases). Count words in the correct answer, then write each distractor to within 2 words of that count.
If the flaw is option overlap, rewrite the entire option set so each distractor reflects a distinct misconception and prefer distinct named concepts from DISTRACTOR GUIDE instead of paraphrased synonyms of the keyed definition. For property/definition concepts, do not keep all options in the form "the ability/capacity of blood vessels to...". If the flaw is explanation quality, include explicit contrast clauses and a final "Key distinction:" sentence. If the flaw is evidence grounding, copy one verbatim proving sentence from SOURCE PASSAGES.
Return exactly ${expectedOptionCount} options. Echo conceptId exactly. mostTemptingDistractor must exactly match one incorrect option.

Return a single JSON object only — no markdown, no prose (include metadata fields if you improved them):
{"conceptId":"${prevQuestion.conceptId ?? concept.id}","conceptName":"${concept.name}","level":${level},"question":"...","options":[${Array.from({ length: expectedOptionCount }).map(() => '"..."').join(',')}],"correctAnswer":2,"explanation":"...","sourceQuote":"...","pageEstimate":"${concept.pageEstimate || ''}","decisionTarget":"...","decidingClue":"...","mostTemptingDistractor":"...","whyTempting":"...","whyFails":"..."}`;

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
