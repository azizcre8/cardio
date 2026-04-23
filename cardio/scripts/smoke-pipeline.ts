import {
  createCostTracker,
  prepareSharedComparisonContext,
  runComparisonRunner,
} from '@/lib/pipeline/offline-comparison';

async function main() {
  const pdfPath = process.argv[2];
  const requestedConceptCount = Number.parseInt(process.argv[3] ?? '10', 10);
  if (!pdfPath) {
    throw new Error('Usage: tsx scripts/smoke-pipeline.ts <pdf-path> [concept-count]');
  }
  const conceptCount = Number.isFinite(requestedConceptCount) && requestedConceptCount > 0
    ? requestedConceptCount
    : 10;
  const tracker = createCostTracker();
  const context = await prepareSharedComparisonContext(
    { pdfPath, conceptCount, density: 'standard' },
    tracker.recordCost,
  );
  const result = await runComparisonRunner('current', context, tracker.recordCost);

  console.log(JSON.stringify({
    pdfPath: result.pdfPath,
    requestedConceptCount: result.requestedConceptCount,
    pages: result.pages,
    chunks: result.chunks,
    inventoryWarnings: result.inventoryWarnings,
    extractedConcepts: result.extractedConcepts,
    testedConcepts: result.testedConcepts,
    generatedQuestions: result.generatedQuestions,
    acceptedQuestions: result.acceptedQuestions,
    rejectedQuestions: result.rejectedQuestions,
    dedupedQuestions: result.dedupedQuestions,
    totalGenerated: result.generatedQuestions,
    totalRejected: result.rejectedQuestions,
    acceptanceRate: result.acceptanceRate,
    rejectionBreakdown: result.rejectionBreakdown,
    openaiCostUSD: tracker.getTotalCostUSD(),
    acceptedStems: result.accepted.map(question => ({
      concept: question.conceptName,
      level: question.level,
      stem: question.stem,
    })),
    rejected: result.representativeFailures,
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
