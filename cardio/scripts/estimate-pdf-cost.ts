import { OPENAI_MODEL_PRICING_USD_PER_MILLION, roundUsdAmount } from '../lib/openai-cost';
import { DENSITY_CONFIG, type Density } from '../types';

type ImportanceMix = { high: number; medium: number; low: number };

type EstimateAssumptions = {
  wordsPerPage: number;
  charsPerWord: number;
  tokensPerWord: number;
  conceptsPer100Pages: number;
  importanceMix: ImportanceMix;
  maxQuestionsPerPdf: number;
  current: {
    inventoryPromptOverheadTokens: number;
    inventoryOutputTokensPerBatch: number;
    confusionPromptBaseTokens: number;
    confusionOutputTokens: number;
    generationPromptBaseTokens: number;
    generationPromptPerConceptTokens: number;
    generationOutputTokensPerQuestion: number;
    auditPromptBaseTokens: number;
    auditPromptPerQuestionTokens: number;
    auditOutputTokensPerQuestion: number;
    reviseRate: number;
    revisePromptTokens: number;
    reviseOutputTokens: number;
  };
  rewritten: {
    slotPromptBaseTokens: number;
    slotPromptRagTokens: number;
    slotPromptPerCandidateTokens: number;
    averageCandidatesPerSlot: number;
    slotOutputTokens: number;
    retryRate: number;
    auditPromptBaseTokens: number;
    auditPromptPerQuestionTokens: number;
    auditOutputTokensPerQuestion: number;
    reviseRate: number;
    revisePromptTokens: number;
    reviseOutputTokens: number;
  };
};

type CostBreakdown = {
  embeddings: number;
  inventory: number;
  confusionMap: number;
  writer: number;
  auditor: number;
  revisions: number;
  total: number;
  chunkCount: number;
  conceptCount: number;
  includedConceptCount: number;
  questionCount: number;
};

const DEFAULT_PAGES = [50, 150, 300];

// Dense medical textbook defaults: high word density, terminology-heavy prose, and richer concept packing.
const DENSE_MEDICAL_TEXTBOOK_ASSUMPTIONS: EstimateAssumptions = {
  wordsPerPage: 550,
  charsPerWord: 6.4,
  tokensPerWord: 1.38,
  conceptsPer100Pages: 140,
  importanceMix: { high: 0.3, medium: 0.45, low: 0.25 },
  maxQuestionsPerPdf: 500,
  current: {
    inventoryPromptOverheadTokens: 650,
    inventoryOutputTokensPerBatch: 1350,
    confusionPromptBaseTokens: 500,
    confusionOutputTokens: 800,
    generationPromptBaseTokens: 5200,
    generationPromptPerConceptTokens: 850,
    generationOutputTokensPerQuestion: 240,
    auditPromptBaseTokens: 1500,
    auditPromptPerQuestionTokens: 300,
    auditOutputTokensPerQuestion: 65,
    reviseRate: 0.35,
    revisePromptTokens: 1750,
    reviseOutputTokens: 250,
  },
  rewritten: {
    slotPromptBaseTokens: 2300,
    slotPromptRagTokens: 780,
    slotPromptPerCandidateTokens: 55,
    averageCandidatesPerSlot: 5,
    slotOutputTokens: 250,
    retryRate: 0.08,
    auditPromptBaseTokens: 1500,
    auditPromptPerQuestionTokens: 280,
    auditOutputTokensPerQuestion: 60,
    reviseRate: 0.18,
    revisePromptTokens: 1850,
    reviseOutputTokens: 245,
  },
};

function parseArgs(): { density: Density | 'all'; pages: number[]; questionBudget: number } {
  const args = Object.fromEntries(
    process.argv.slice(2).map(arg => {
      const [key, value] = arg.replace(/^--/, '').split('=');
      return [key, value];
    }),
  );

  const density = (args.density as Density | 'all' | undefined) ?? 'all';
  const pages = args.pages
    ? String(args.pages).split(',').map(value => parseInt(value, 10)).filter(Number.isFinite)
    : DEFAULT_PAGES;
  const questionBudget = args.questionBudget ? parseInt(String(args.questionBudget), 10) : DENSE_MEDICAL_TEXTBOOK_ASSUMPTIONS.maxQuestionsPerPdf;

  return { density, pages, questionBudget };
}

function levelsPerConcept(density: Density, mix: ImportanceMix): number {
  const levels = DENSITY_CONFIG[density].levels;
  return (
    mix.high * (levels.high?.length ?? 0) +
    mix.medium * (levels.medium?.length ?? 0) +
    mix.low * (levels.low?.length ?? 0)
  );
}

function estimateChunks(pageCount: number, density: Density, assumptions: EstimateAssumptions): number {
  const totalWords = pageCount * assumptions.wordsPerPage;
  const cfg = DENSITY_CONFIG[density];
  const step = Math.max(1, Math.round(cfg.words * (1 - cfg.overlap)));
  if (totalWords <= cfg.words) return 1;
  return 1 + Math.ceil((totalWords - cfg.words) / step);
}

function estimateRawConceptCount(pageCount: number, assumptions: EstimateAssumptions): number {
  return Math.max(12, Math.round((pageCount / 100) * assumptions.conceptsPer100Pages));
}

function estimateCurrentIncludedConcepts(rawConcepts: number, density: Density, questionBudget: number): number {
  const cfg = DENSITY_CONFIG[density];
  const avgQPerConcept = (cfg.min + cfg.max) / 2;
  const byBudget = Math.ceil((questionBudget * 2) / avgQPerConcept);
  const maxConcepts = Math.min(Math.max(byBudget, 20), 80);
  return Math.min(rawConcepts, maxConcepts);
}

function estimateRewrittenIncludedConcepts(rawConcepts: number, density: Density, assumptions: EstimateAssumptions, questionBudget: number): number {
  const avgLevels = Math.max(1, levelsPerConcept(density, assumptions.importanceMix));
  return Math.min(rawConcepts, Math.max(1, Math.floor(questionBudget / avgLevels)));
}

function wordsToTokens(words: number, assumptions: EstimateAssumptions): number {
  return Math.round(words * assumptions.tokensPerWord);
}

function costForModel(model: keyof typeof OPENAI_MODEL_PRICING_USD_PER_MILLION, inputTokens: number, outputTokens: number): number {
  const pricing = OPENAI_MODEL_PRICING_USD_PER_MILLION[model];
  return roundUsdAmount(
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output,
  );
}

function estimateCurrentPipeline(pageCount: number, density: Density, assumptions: EstimateAssumptions, questionBudget: number): CostBreakdown {
  const chunkCount = estimateChunks(pageCount, density, assumptions);
  const rawConceptCount = estimateRawConceptCount(pageCount, assumptions);
  const includedConceptCount = estimateCurrentIncludedConcepts(rawConceptCount, density, questionBudget);
  const avgLevels = levelsPerConcept(density, assumptions.importanceMix);
  const questionCount = Math.round(includedConceptCount * avgLevels);
  const inventoryBatchCount = Math.ceil(chunkCount / 3);
  const conceptBatchCount = Math.ceil(includedConceptCount / 3);

  const embeddedWordsPerChunk = Math.floor(2000 / assumptions.charsPerWord);
  const chunkEmbeddingTokens = chunkCount * wordsToTokens(embeddedWordsPerChunk, assumptions);
  const conceptQueryEmbeddingTokens = includedConceptCount * wordsToTokens(42, assumptions);
  const negativeRagEmbeddingTokens = includedConceptCount * wordsToTokens(18, assumptions);
  const embeddings = costForModel(
    'text-embedding-3-small',
    chunkEmbeddingTokens + conceptQueryEmbeddingTokens + negativeRagEmbeddingTokens,
    0,
  );

  const inventoryInputTokens = inventoryBatchCount * (
    assumptions.current.inventoryPromptOverheadTokens +
    wordsToTokens(DENSITY_CONFIG[density].words * 3, assumptions)
  );
  const inventoryOutputTokens = inventoryBatchCount * assumptions.current.inventoryOutputTokensPerBatch;
  const inventory = costForModel('gpt-4o-mini', inventoryInputTokens, inventoryOutputTokens);

  const confusionInputTokens = assumptions.current.confusionPromptBaseTokens + includedConceptCount * 8;
  const confusionMap = costForModel('gpt-4o-mini', confusionInputTokens, assumptions.current.confusionOutputTokens);

  const writerInputTokens =
    conceptBatchCount * assumptions.current.generationPromptBaseTokens +
    includedConceptCount * assumptions.current.generationPromptPerConceptTokens;
  const writerOutputTokens = questionCount * assumptions.current.generationOutputTokensPerQuestion;
  const writer = costForModel('gpt-4o', writerInputTokens, writerOutputTokens);

  const auditorInputTokens =
    conceptBatchCount * assumptions.current.auditPromptBaseTokens +
    questionCount * assumptions.current.auditPromptPerQuestionTokens;
  const auditorOutputTokens = questionCount * assumptions.current.auditOutputTokensPerQuestion;
  const auditor = costForModel('gpt-4o', auditorInputTokens, auditorOutputTokens);

  const revisionCount = Math.round(questionCount * assumptions.current.reviseRate);
  const revisions = costForModel(
    'gpt-4o',
    revisionCount * assumptions.current.revisePromptTokens,
    revisionCount * assumptions.current.reviseOutputTokens,
  );

  const total = roundUsdAmount(embeddings + inventory + confusionMap + writer + auditor + revisions);
  return {
    embeddings,
    inventory,
    confusionMap,
    writer,
    auditor,
    revisions,
    total,
    chunkCount,
    conceptCount: rawConceptCount,
    includedConceptCount,
    questionCount,
  };
}

function estimateRewrittenPipeline(pageCount: number, density: Density, assumptions: EstimateAssumptions, questionBudget: number): CostBreakdown {
  const chunkCount = estimateChunks(pageCount, density, assumptions);
  const rawConceptCount = estimateRawConceptCount(pageCount, assumptions);
  const includedConceptCount = estimateRewrittenIncludedConcepts(rawConceptCount, density, assumptions, questionBudget);
  const avgLevels = levelsPerConcept(density, assumptions.importanceMix);
  const questionCount = Math.round(includedConceptCount * avgLevels);
  const inventoryBatchCount = Math.ceil(chunkCount / 3);
  const auditBatchCount = Math.max(1, Math.ceil(questionCount / 8));

  const embeddedWordsPerChunk = Math.floor(2000 / assumptions.charsPerWord);
  const chunkEmbeddingTokens = chunkCount * wordsToTokens(embeddedWordsPerChunk, assumptions);
  const conceptQueryEmbeddingTokens = includedConceptCount * wordsToTokens(42, assumptions);
  const negativeRagEmbeddingTokens = includedConceptCount * wordsToTokens(18, assumptions);
  const embeddings = costForModel(
    'text-embedding-3-small',
    chunkEmbeddingTokens + conceptQueryEmbeddingTokens + negativeRagEmbeddingTokens,
    0,
  );

  const inventoryInputTokens = inventoryBatchCount * (
    assumptions.current.inventoryPromptOverheadTokens +
    wordsToTokens(DENSITY_CONFIG[density].words * 3, assumptions)
  );
  const inventoryOutputTokens = inventoryBatchCount * assumptions.current.inventoryOutputTokensPerBatch;
  const inventory = costForModel('gpt-4o-mini', inventoryInputTokens, inventoryOutputTokens);

  const confusionInputTokens = assumptions.current.confusionPromptBaseTokens + includedConceptCount * 10;
  const confusionMap = costForModel('gpt-4o-mini', confusionInputTokens, assumptions.current.confusionOutputTokens);

  const slotAttempts = Math.round(questionCount * (1 + assumptions.rewritten.retryRate));
  const writerInputTokens = slotAttempts * (
    assumptions.rewritten.slotPromptBaseTokens +
    assumptions.rewritten.slotPromptRagTokens +
    assumptions.rewritten.averageCandidatesPerSlot * assumptions.rewritten.slotPromptPerCandidateTokens
  );
  const writerOutputTokens = slotAttempts * assumptions.rewritten.slotOutputTokens;
  const writer = costForModel('gpt-4o', writerInputTokens, writerOutputTokens);

  const auditorInputTokens =
    auditBatchCount * assumptions.rewritten.auditPromptBaseTokens +
    questionCount * assumptions.rewritten.auditPromptPerQuestionTokens;
  const auditorOutputTokens = questionCount * assumptions.rewritten.auditOutputTokensPerQuestion;
  const auditor = costForModel('gpt-4o', auditorInputTokens, auditorOutputTokens);

  const revisionCount = Math.round(questionCount * assumptions.rewritten.reviseRate);
  const revisions = costForModel(
    'gpt-4o',
    revisionCount * assumptions.rewritten.revisePromptTokens,
    revisionCount * assumptions.rewritten.reviseOutputTokens,
  );

  const total = roundUsdAmount(embeddings + inventory + confusionMap + writer + auditor + revisions);
  return {
    embeddings,
    inventory,
    confusionMap,
    writer,
    auditor,
    revisions,
    total,
    chunkCount,
    conceptCount: rawConceptCount,
    includedConceptCount,
    questionCount,
  };
}

function printComparison(density: Density, pageCount: number, current: CostBreakdown, rewritten: CostBreakdown): void {
  const delta = roundUsdAmount(rewritten.total - current.total);
  const deltaPct = current.total > 0 ? ((rewritten.total - current.total) / current.total) * 100 : 0;
  console.log(`\n## ${density.toUpperCase()} — ${pageCount} dense pages`);
  console.log(`raw concepts=${current.conceptCount} | current included=${current.includedConceptCount} | rewritten included=${rewritten.includedConceptCount}`);
  console.log(`chunks=${current.chunkCount} | current questions≈${current.questionCount} | rewritten questions≈${rewritten.questionCount}`);
  console.log('');
  console.log('| Phase | Current USD | Rewritten USD |');
  console.log('| --- | ---: | ---: |');
  console.log(`| Embeddings | ${current.embeddings.toFixed(4)} | ${rewritten.embeddings.toFixed(4)} |`);
  console.log(`| Inventory | ${current.inventory.toFixed(4)} | ${rewritten.inventory.toFixed(4)} |`);
  console.log(`| Confusion map | ${current.confusionMap.toFixed(4)} | ${rewritten.confusionMap.toFixed(4)} |`);
  console.log(`| Writer | ${current.writer.toFixed(4)} | ${rewritten.writer.toFixed(4)} |`);
  console.log(`| Auditor | ${current.auditor.toFixed(4)} | ${rewritten.auditor.toFixed(4)} |`);
  console.log(`| Revisions | ${current.revisions.toFixed(4)} | ${rewritten.revisions.toFixed(4)} |`);
  console.log(`| Total | ${current.total.toFixed(4)} | ${rewritten.total.toFixed(4)} |`);
  console.log('');
  console.log(`delta=${delta >= 0 ? '+' : ''}${delta.toFixed(4)} USD (${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}%)`);
}

function main(): void {
  const { density, pages, questionBudget } = parseArgs();
  const densities: Density[] = density === 'all' ? ['standard', 'comprehensive', 'boards'] : [density];

  console.log('# Dense Medical Textbook Cost Estimate');
  console.log(`assumptions: words/page=${DENSE_MEDICAL_TEXTBOOK_ASSUMPTIONS.wordsPerPage}, concepts/100 pages=${DENSE_MEDICAL_TEXTBOOK_ASSUMPTIONS.conceptsPer100Pages}, question budget=${questionBudget}`);
  console.log(`importance mix: high=${DENSE_MEDICAL_TEXTBOOK_ASSUMPTIONS.importanceMix.high}, medium=${DENSE_MEDICAL_TEXTBOOK_ASSUMPTIONS.importanceMix.medium}, low=${DENSE_MEDICAL_TEXTBOOK_ASSUMPTIONS.importanceMix.low}`);

  for (const selectedDensity of densities) {
    for (const pageCount of pages) {
      const current = estimateCurrentPipeline(pageCount, selectedDensity, DENSE_MEDICAL_TEXTBOOK_ASSUMPTIONS, questionBudget);
      const rewritten = estimateRewrittenPipeline(pageCount, selectedDensity, DENSE_MEDICAL_TEXTBOOK_ASSUMPTIONS, questionBudget);
      printComparison(selectedDensity, pageCount, current, rewritten);
    }
  }
}

main();
