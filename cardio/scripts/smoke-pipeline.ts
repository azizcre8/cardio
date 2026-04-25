import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env.local before any module that reads env vars
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}

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
