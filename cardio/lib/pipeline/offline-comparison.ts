import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  type BM25Index,
  type ChunkRecord,
  type Density,
  type DensityConfig,
  DENSITY_CONFIG,
  type GenerationSlot,
  type ImportanceLevel,
  type Question,
} from '@/types';
import type { OpenAICostTracker } from '@/lib/openai-cost';
import { detectExplanationAnswerMismatch } from './answer-key-check';
import { auditQuestions } from './audit';
import { dedupQuestions, type DedupDrop } from './dedup';
import { embedAllChunks } from './embeddings';
import {
  WRITER_MODEL,
  callOpenAI,
  inferEvidenceProvenance,
  normaliseQuestion,
  parseJSON,
  repairDraftForValidation,
} from './generation';
import { extractTextServer } from './ingestion';
import { canonicalizeConcepts, generateConfusionMap, mergeInventory } from './inventory';
import { extractInventoriesResilient, sortConceptsByImportanceAndName } from './process-helpers';
import { buildBM25Index, bm25Search } from './retrieval';
import { buildGenerationSlots } from './slots';
import { stemIsInterrogative, validateSourceQuoteShape } from './question-validation';
import { verifyEvidenceSpan } from './validation';
import { chunkText } from './chunking';

type RunnerQuestion = Omit<Question, 'id' | 'created_at'>;

export type ComparisonRunnerKind = 'current' | 'simplified';
export type ComparisonRunnerSelection = ComparisonRunnerKind | 'both';

export interface ComparisonQuestionRecord {
  conceptId: string;
  conceptName: string;
  level: number;
  stem: string;
  options: string[];
  answer: number;
  explanation: string;
  sourceQuote: string;
}

export interface ComparisonFailureRecord {
  conceptId: string;
  conceptName: string;
  level: number;
  reason: string;
  detail?: string;
  raw?: Record<string, unknown> | null;
}

export interface PipelineComparisonResult {
  runner: ComparisonRunnerKind;
  pdfPath: string;
  density: Density;
  requestedConceptCount: number;
  pages: number;
  chunks: number;
  inventoryWarnings: number;
  extractedConcepts: number;
  testedConcepts: string[];
  generatedQuestions: number;
  acceptedQuestions: number;
  rejectedQuestions: number;
  dedupedQuestions: number;
  acceptanceRate: number;
  openaiCostUSD: number;
  rejectionBreakdown: Record<string, number>;
  accepted: ComparisonQuestionRecord[];
  representativeFailures: ComparisonFailureRecord[];
  notes: string[];
}

export interface ComparisonBundle {
  pdfPath: string;
  density: Density;
  requestedConceptCount: number;
  generatedAt: string;
  results: PipelineComparisonResult[];
}

interface ConceptSpec {
  id: string;
  name: string;
  category: string;
  importance: ImportanceLevel;
  keyFacts: string[];
  clinicalRelevance: string;
  associations: string[];
  pageEstimate: string;
  coverageDomain: string;
  chunk_ids: string[];
}

interface SharedComparisonContext {
  pdfPath: string;
  density: Density;
  requestedConceptCount: number;
  pdfId: string;
  userId: string;
  dc: DensityConfig;
  pages: Awaited<ReturnType<typeof extractTextServer>>;
  chunkRecords: ChunkRecord[];
  bm25Index: BM25Index;
  concepts: ConceptSpec[];
  conceptImportance: Record<string, ImportanceLevel>;
  confusionMap: Awaited<ReturnType<typeof generateConfusionMap>>;
  inventoryWarnings: number;
}

interface RunnerResultDraft {
  generated: RunnerQuestion[];
  deduped: DedupDrop[];
  failures: ComparisonFailureRecord[];
  costUSD: number;
  notes: string[];
}

interface SimplifiedValidationResult {
  ok: boolean;
  question: RunnerQuestion | null;
  issues: string[];
}

export interface CompareGenerationOptions {
  pdfPath: string;
  conceptCount: number;
  density?: Density;
  runner?: ComparisonRunnerSelection;
}

export function createCostTracker() {
  let totalCostUSD = 0;
  const recordCost: OpenAICostTracker = async ({ costUSD }) => {
    totalCostUSD += costUSD;
  };

  return {
    recordCost,
    getTotalCostUSD() {
      return Number(totalCostUSD.toFixed(4));
    },
  };
}

function totalSlotsForConcepts(concepts: ConceptSpec[], dc: DensityConfig): number {
  return concepts.reduce((sum, concept) => sum + (dc.levels[concept.importance]?.length ?? 0), 0);
}

function pickEvidenceChunks(slot: GenerationSlot, allChunks: ChunkRecord[], bm25Index: BM25Index): ChunkRecord[] {
  const sourceChunks = allChunks.filter(chunk => slot.chunkIds.includes(chunk.id));
  if (sourceChunks.length <= 4) return sourceChunks;

  const queryText = [slot.conceptName, ...slot.keyFacts.slice(0, 2)].filter(Boolean).join(' ');
  const ranked = bm25Search(queryText, bm25Index, sourceChunks, 4);
  return ranked.length ? ranked : sourceChunks.slice(0, 4);
}

function toQuestionRecord(question: RunnerQuestion): ComparisonQuestionRecord {
  return {
    conceptId: question.concept_id,
    conceptName: question.concept_name ?? question.concept_id,
    level: question.level,
    stem: question.stem,
    options: question.options,
    answer: question.answer,
    explanation: question.explanation,
    sourceQuote: question.source_quote,
  };
}

function summarizeFailures(failures: ComparisonFailureRecord[]): Record<string, number> {
  return failures.reduce<Record<string, number>>((acc, failure) => {
    acc[failure.reason] = (acc[failure.reason] ?? 0) + 1;
    return acc;
  }, {});
}

export async function prepareSharedComparisonContext(
  options: CompareGenerationOptions,
  onCost?: OpenAICostTracker,
): Promise<SharedComparisonContext> {
  const density = options.density ?? 'standard';
  const requestedConceptCount = Number.isFinite(options.conceptCount) && options.conceptCount > 0
    ? options.conceptCount
    : 10;
  const resolvedPdfPath = path.resolve(options.pdfPath);
  const buffer = await fs.readFile(resolvedPdfPath);

  const pdfId = randomUUID();
  const userId = 'offline-compare-user';
  const dc = DENSITY_CONFIG[density];

  const pages = await extractTextServer(buffer);
  const rawChunks = chunkText(pages, dc.words, dc.overlap, pdfId);
  const chunkRecords = await embedAllChunks(rawChunks, undefined, onCost);
  const bm25Index = buildBM25Index(chunkRecords);

  const { inventories, warnings } = await extractInventoriesResilient(chunkRecords, dc, onCost);
  const merged = mergeInventory(inventories, pdfId);
  const canonical = canonicalizeConcepts(merged);
  const concepts = sortConceptsByImportanceAndName(canonical)
    .slice(0, requestedConceptCount)
    .map((concept, index) => ({
      id: `compare-concept-${index + 1}`,
      name: concept.name,
      category: concept.category,
      importance: concept.importance,
      keyFacts: concept.keyFacts,
      clinicalRelevance: concept.clinicalRelevance,
      associations: concept.associations,
      pageEstimate: concept.pageEstimate,
      coverageDomain: concept.coverageDomain,
      chunk_ids: concept.sourceChunkIds,
    }));

  const conceptImportance = Object.fromEntries(
    concepts.map(concept => [concept.id, concept.importance]),
  ) as Record<string, ImportanceLevel>;

  const confusionMap = await generateConfusionMap(
    concepts.map(concept => ({ name: concept.name, category: concept.category })),
    onCost,
  );

  return {
    pdfPath: resolvedPdfPath,
    density,
    requestedConceptCount,
    pdfId,
    userId,
    dc,
    pages,
    chunkRecords,
    bm25Index,
    concepts,
    conceptImportance,
    confusionMap,
    inventoryWarnings: warnings.length,
  };
}

export async function dedupeComparisonQuestions(
  questions: RunnerQuestion[],
  conceptImportance: Record<string, ImportanceLevel>,
  onCost?: OpenAICostTracker,
) {
  return dedupQuestions(questions, conceptImportance, onCost);
}

export function validateSimplifiedDraft(
  raw: Record<string, unknown>,
  slot: GenerationSlot,
  concept: ConceptSpec,
  evidenceCorpus: string,
  pdfId: string,
  userId: string,
): SimplifiedValidationResult {
  const repaired = repairDraftForValidation(raw, evidenceCorpus);
  const issues: string[] = [];

  const questionText = typeof repaired.question === 'string' ? repaired.question.trim() : '';
  const options = Array.isArray(repaired.options)
    ? repaired.options.filter((option): option is string => typeof option === 'string')
    : [];
  const answer = typeof repaired.correctAnswer === 'number' ? repaired.correctAnswer : -1;
  const explanation = typeof repaired.explanation === 'string' ? repaired.explanation : '';
  const sourceQuote = typeof repaired.sourceQuote === 'string' ? repaired.sourceQuote.trim() : '';

  if (!questionText || !options.length || answer < 0 || answer >= options.length) {
    issues.push('Draft does not have a valid question/options/answer shape.');
  }

  if (questionText && !stemIsInterrogative(questionText)) {
    issues.push('Stem is not phrased as a question.');
  }

  const sourceQuoteShapeIssue = sourceQuote ? validateSourceQuoteShape(sourceQuote) : 'Source quote is missing.';
  if (sourceQuoteShapeIssue) {
    issues.push(sourceQuoteShapeIssue);
  }

  const evidenceResult = verifyEvidenceSpan(sourceQuote, 0, 0, evidenceCorpus);
  if (!evidenceResult.ok) {
    issues.push('Source quote could not be verified against the supporting evidence.');
  }

  if (options.length && answer >= 0 && answer < options.length && explanation) {
    const mismatch = detectExplanationAnswerMismatch(options, answer, explanation);
    if (mismatch) issues.push(mismatch);
  }

  const normalized = normaliseQuestion(
    {
      ...repaired,
      level: slot.level,
      conceptId: slot.conceptId,
      conceptName: slot.conceptName,
      ...inferEvidenceProvenance(sourceQuote, evidenceCorpus ? [{
        id: slot.chunkIds[0] ?? `${slot.conceptId}-chunk`,
        pdf_id: pdfId,
        text: evidenceCorpus,
        start_page: 1,
        end_page: 1,
        headers: [],
        word_count: evidenceCorpus.split(/\s+/).filter(Boolean).length,
        embedding: [],
      }] : [], evidenceResult.evidenceMatchedText),
      evidenceMatchType: evidenceResult.evidenceMatchType,
    },
    concept,
    slot.level,
    pdfId,
    userId,
  );

  if (!normalized) {
    issues.push('Draft could not be normalized into a saved question shape.');
  }

  return {
    ok: issues.length === 0 && normalized !== null,
    question: normalized,
    issues,
  };
}

async function generateSimplifiedQuestionDraft(
  slot: GenerationSlot,
  concept: ConceptSpec,
  evidenceCorpus: string,
  critique: string | null,
  onCost?: OpenAICostTracker,
): Promise<Record<string, unknown>> {
  const prompt = `You are generating one board-style study question from a medical PDF.

TARGET CONCEPT
- conceptId: ${slot.conceptId}
- conceptName: ${slot.conceptName}
- level: ${slot.level}
- category: ${slot.category}
- importance: ${slot.importance}

CONCEPT SUPPORT
- key facts: ${concept.keyFacts.join('; ') || '(none)'}
- clinical relevance: ${concept.clinicalRelevance || '(none)'}
- associations: ${concept.associations.join('; ') || '(none)'}

SOURCE PASSAGES
${evidenceCorpus}

REQUIREMENTS
- Return exactly one JSON object.
- Write one useful, study-worthy multiple choice question.
- Keep the question focused on ${slot.conceptName}.
- Use ${slot.level === 1 ? '5 options' : '4 options'}.
- sourceQuote must be one complete sentence copied verbatim from the source passages.
- Explanation must clearly state why the correct answer is right and why one tempting distractor is wrong.
- decidingClue should be a short verbatim phrase from sourceQuote.
- Avoid duplicate or trivial questions.

${critique ? `REVISION FEEDBACK\n${critique}\n` : ''}

Return JSON only:
{"conceptId":"${slot.conceptId}","conceptName":"${slot.conceptName}","level":${slot.level},"question":"...","options":["..."],"correctAnswer":0,"explanation":"...","sourceQuote":"...","pageEstimate":"${concept.pageEstimate}","decisionTarget":"...","decidingClue":"...","mostTemptingDistractor":"...","whyTempting":"...","whyFails":"..."}`;

  const { text } = await callOpenAI(prompt, 1800, WRITER_MODEL, onCost, {
    responseFormat: { type: 'json_object' },
    temperature: 0.2,
  });

  const parsed = parseJSON(text);
  return (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown>;
}

export async function runCurrentPipelineRunner(
  context: SharedComparisonContext,
  onCost?: OpenAICostTracker,
): Promise<RunnerResultDraft> {
  const { generateCoverageQuestions } = await import('./generation');

  const generated = await generateCoverageQuestions(
    context.concepts,
    context.pdfId,
    context.userId,
    context.dc,
    context.chunkRecords,
    context.confusionMap,
    context.bm25Index,
    context.concepts,
    onCost,
  );

  const ragPassages: Record<string, string> = {};
  const ragChunks: Record<string, ChunkRecord[]> = {};

  for (const concept of context.concepts) {
    const chunks = context.chunkRecords.filter(chunk => concept.chunk_ids.includes(chunk.id));
    ragChunks[concept.id] = chunks;
    ragPassages[concept.id] = chunks.map(chunk => chunk.text).join('\n\n');
  }

  const audit = await auditQuestions(
    generated.questions,
    context.concepts,
    context.pdfId,
    context.userId,
    ragPassages,
    ragChunks,
    {},
    onCost,
  );

  const deduped = await dedupeComparisonQuestions(audit.passed, context.conceptImportance, onCost);

  const failures: ComparisonFailureRecord[] = [
    ...generated.rejectedSlots.map(failure => ({
      conceptId: failure.conceptId,
      conceptName: failure.conceptName,
      level: failure.level,
      reason: failure.reason,
      raw: failure.raw,
    })),
    ...audit.hardRejected.map(failure => ({
      conceptId: failure.conceptId,
      conceptName: failure.conceptName,
      level: failure.level,
      reason: failure.criterion,
      detail: failure.critique,
      raw: failure.lastQuestion,
    })),
  ];

  return {
    generated: deduped.kept,
    deduped: deduped.dropped,
    failures,
    costUSD: 0,
    notes: [
      'Baseline runner uses the existing generation, audit, and dedup pipeline unchanged.',
    ],
  };
}

export async function runSimplifiedPipelineRunner(
  context: SharedComparisonContext,
  onCost?: OpenAICostTracker,
): Promise<RunnerResultDraft> {
  const failures: ComparisonFailureRecord[] = [];
  const accepted: RunnerQuestion[] = [];
  const notes = [
    'Simplified runner keeps extraction, chunking, embeddings, inventory, and concept selection.',
    'Generation is AI-led with one retry and light validation only.',
  ];

  const { slots } = buildGenerationSlots(
    context.concepts,
    context.dc,
    totalSlotsForConcepts(context.concepts, context.dc),
  );
  const conceptById = new Map(context.concepts.map(concept => [concept.id, concept]));

  for (const slot of slots) {
    const concept = conceptById.get(slot.conceptId);
    if (!concept) continue;

    const evidenceChunks = pickEvidenceChunks(slot, context.chunkRecords, context.bm25Index);
    const evidenceCorpus = evidenceChunks.map(chunk => chunk.text).join('\n\n');

    let lastIssues: string[] = [];
    let saved = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const critique = attempt === 0 || !lastIssues.length
        ? null
        : `Revise the draft to fix these issues:\n- ${lastIssues.join('\n- ')}`;

      try {
        const raw = await generateSimplifiedQuestionDraft(slot, concept, evidenceCorpus, critique, onCost);
        const validation = validateSimplifiedDraft(raw, slot, concept, evidenceCorpus, context.pdfId, context.userId);
        if (validation.ok && validation.question) {
          accepted.push(validation.question);
          saved = true;
          break;
        }
        lastIssues = validation.issues;

        if (attempt === 1) {
          failures.push({
            conceptId: slot.conceptId,
            conceptName: slot.conceptName,
            level: slot.level,
            reason: validation.issues[0] ?? 'SIMPLIFIED_VALIDATION_FAILED',
            detail: validation.issues.join(' | '),
            raw,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastIssues = [message];
        if (attempt === 1) {
          failures.push({
            conceptId: slot.conceptId,
            conceptName: slot.conceptName,
            level: slot.level,
            reason: 'SIMPLIFIED_GENERATION_FAILED',
            detail: message,
          });
        }
      }
    }

    if (!saved && !lastIssues.length) {
      failures.push({
        conceptId: slot.conceptId,
        conceptName: slot.conceptName,
        level: slot.level,
        reason: 'SIMPLIFIED_GENERATION_FAILED',
      });
    }
  }

  const deduped = await dedupeComparisonQuestions(accepted, context.conceptImportance, onCost);
  return {
    generated: deduped.kept,
    deduped: deduped.dropped,
    failures,
    costUSD: 0,
    notes,
  };
}

export async function runComparisonRunner(
  runner: ComparisonRunnerKind,
  context: SharedComparisonContext,
  onCost?: OpenAICostTracker,
): Promise<PipelineComparisonResult> {
  const result = runner === 'current'
    ? await runCurrentPipelineRunner(context, onCost)
    : await runSimplifiedPipelineRunner(context, onCost);

  const generatedQuestions = result.generated.length + result.failures.length + result.deduped.length;
  const acceptedQuestions = result.generated.length;
  const rejectedQuestions = result.failures.length;
  const dedupedQuestions = result.deduped.length;

  return {
    runner,
    pdfPath: context.pdfPath,
    density: context.density,
    requestedConceptCount: context.requestedConceptCount,
    pages: context.pages.length,
    chunks: context.chunkRecords.length,
    inventoryWarnings: context.inventoryWarnings,
    extractedConcepts: context.concepts.length,
    testedConcepts: context.concepts.map(concept => concept.name),
    generatedQuestions,
    acceptedQuestions,
    rejectedQuestions,
    dedupedQuestions,
    acceptanceRate: generatedQuestions > 0
      ? Number((acceptedQuestions / generatedQuestions).toFixed(4))
      : 0,
    openaiCostUSD: 0,
    rejectionBreakdown: summarizeFailures(result.failures),
    accepted: result.generated.map(toQuestionRecord),
    representativeFailures: result.failures.slice(0, 12),
    notes: result.notes,
  };
}

export async function runOfflineComparison(
  options: CompareGenerationOptions,
): Promise<ComparisonBundle> {
  const tracker = createCostTracker();
  const context = await prepareSharedComparisonContext(options, tracker.recordCost);
  const requestedRunner = options.runner ?? 'both';
  const runners: ComparisonRunnerKind[] = requestedRunner === 'both'
    ? ['current', 'simplified']
    : [requestedRunner];

  const results: PipelineComparisonResult[] = [];
  for (const runner of runners) {
    const result = await runComparisonRunner(runner, context, tracker.recordCost);
    result.openaiCostUSD = tracker.getTotalCostUSD();
    results.push(result);
  }

  return {
    pdfPath: context.pdfPath,
    density: context.density,
    requestedConceptCount: context.requestedConceptCount,
    generatedAt: new Date().toISOString(),
    results,
  };
}

export function renderComparisonMarkdown(bundle: ComparisonBundle): string {
  const lines: string[] = [];
  lines.push(`# Generation Comparison`);
  lines.push('');
  lines.push(`- PDF: \`${bundle.pdfPath}\``);
  lines.push(`- Density: \`${bundle.density}\``);
  lines.push(`- Requested concepts: ${bundle.requestedConceptCount}`);
  lines.push(`- Generated at: ${bundle.generatedAt}`);
  lines.push('');

  for (const result of bundle.results) {
    lines.push(`## Runner: ${result.runner}`);
    lines.push('');
    lines.push(`- Pages: ${result.pages}`);
    lines.push(`- Chunks: ${result.chunks}`);
    lines.push(`- Tested concepts: ${result.testedConcepts.length}`);
    lines.push(`- Generated: ${result.generatedQuestions}`);
    lines.push(`- Accepted: ${result.acceptedQuestions}`);
    lines.push(`- Rejected: ${result.rejectedQuestions}`);
    lines.push(`- Deduped: ${result.dedupedQuestions}`);
    lines.push(`- Acceptance rate: ${(result.acceptanceRate * 100).toFixed(1)}%`);
    lines.push(`- OpenAI cost (cumulative run): $${result.openaiCostUSD.toFixed(4)}`);
    lines.push('');

    if (result.notes.length) {
      lines.push(`### Notes`);
      lines.push('');
      result.notes.forEach(note => lines.push(`- ${note}`));
      lines.push('');
    }

    lines.push(`### Accepted Question Samples`);
    lines.push('');
    result.accepted.slice(0, 8).forEach((question, index) => {
      lines.push(`#### ${index + 1}. ${question.conceptName} (L${question.level})`);
      lines.push('');
      lines.push(`${question.stem}`);
      lines.push('');
      question.options.forEach((option, optionIndex) => {
        const marker = optionIndex === question.answer ? '*' : '-';
        lines.push(`${marker} ${String.fromCharCode(65 + optionIndex)}. ${option}`);
      });
      lines.push('');
      lines.push(`Explanation: ${question.explanation}`);
      lines.push('');
    });

    if (result.representativeFailures.length) {
      lines.push(`### Representative Failures`);
      lines.push('');
      result.representativeFailures.forEach(failure => {
        lines.push(`- ${failure.conceptName} (L${failure.level}): ${failure.reason}${failure.detail ? ` — ${failure.detail}` : ''}`);
      });
      lines.push('');
    }
  }

  lines.push(`## Manual Review Rubric`);
  lines.push('');
  lines.push(`- Is the question genuinely useful to study from?`);
  lines.push(`- Is the keyed answer clearly correct?`);
  lines.push(`- Are the distractors plausible near-misses?`);
  lines.push(`- Is the question repetitive or overly template-like?`);
  lines.push(`- Would you trust this question in a real deck?`);
  lines.push('');
  return lines.join('\n');
}
