import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { auditQuestions } from '@/lib/pipeline/audit';
import { embedAllChunks } from '@/lib/pipeline/embeddings';
import { generateCoverageQuestions } from '@/lib/pipeline/generation';
import { extractTextServer } from '@/lib/pipeline/ingestion';
import { canonicalizeConcepts, generateConfusionMap, mergeInventory } from '@/lib/pipeline/inventory';
import { chunkText } from '@/lib/pipeline/chunking';
import { extractInventoriesResilient, sortConceptsByImportanceAndName } from '@/lib/pipeline/process-helpers';
import { buildBM25Index } from '@/lib/pipeline/retrieval';
import { buildDistractorCandidatePool, formatDistractorCandidatePool } from '@/lib/pipeline/distractors';
import { DENSITY_CONFIG, type ChunkRecord } from '@/types';

async function main() {
  const pdfPath = process.argv[2];
  const requestedConceptCount = Number.parseInt(process.argv[3] ?? '10', 10);
  if (!pdfPath) {
    throw new Error('Usage: tsx scripts/smoke-pipeline.ts <pdf-path> [concept-count]');
  }
  const conceptCount = Number.isFinite(requestedConceptCount) && requestedConceptCount > 0
    ? requestedConceptCount
    : 10;

  const resolvedPdfPath = path.resolve(pdfPath);
  const buffer = await fs.readFile(resolvedPdfPath);

  const pdfId = randomUUID();
  const userId = 'smoke-user';
  const dc = DENSITY_CONFIG.standard;
  let totalCostUSD = 0;
  const recordCost = async ({ costUSD }: { costUSD: number }) => {
    totalCostUSD += costUSD;
  };

  const pages = await extractTextServer(buffer);
  const rawChunks = chunkText(pages, dc.words, dc.overlap, pdfId);
  const embeddedChunks = await embedAllChunks(rawChunks, undefined, recordCost);
  const chunkRows = embeddedChunks.map(chunk => ({
    id: chunk.id,
    pdf_id: pdfId,
    user_id: userId,
    text: chunk.text,
    start_page: chunk.start_page,
    end_page: chunk.end_page,
    headers: chunk.headers,
    word_count: chunk.word_count,
    embedding: chunk.embedding,
  }));
  const bm25Index = buildBM25Index(chunkRows);

  const { inventories, warnings } = await extractInventoriesResilient(embeddedChunks, dc, recordCost);
  const merged = mergeInventory(inventories, pdfId);
  const canonical = canonicalizeConcepts(merged);
  const sortedConcepts = sortConceptsByImportanceAndName(canonical).slice(0, conceptCount);
  const confusionMap = await generateConfusionMap(
    sortedConcepts.map(concept => ({ name: concept.name, category: concept.category })),
    recordCost,
  );

  const conceptSpecs = sortedConcepts.map((concept, index) => ({
    id: `smoke-concept-${index + 1}`,
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

  const generation = await generateCoverageQuestions(
    conceptSpecs,
    pdfId,
    userId,
    dc,
    embeddedChunks,
    confusionMap,
    bm25Index,
    conceptSpecs,
    recordCost,
  );

  const ragPassages: Record<string, string> = {};
  const ragChunks: Record<string, ChunkRecord[]> = {};
  const distractorGuides: Record<string, string> = {};

  for (const concept of conceptSpecs) {
    const chunks = embeddedChunks.filter(chunk => concept.chunk_ids.includes(chunk.id));
    ragChunks[concept.id] = chunks;
    ragPassages[concept.id] = chunks.map(chunk => chunk.text).join('\n\n');

    const confusions = confusionMap[concept.name] ?? [];
    const candidatePool = buildDistractorCandidatePool(
      {
        conceptId: concept.id,
        conceptName: concept.name,
        category: concept.category,
        importance: concept.importance,
        level: 2,
        coverageDomain: concept.coverageDomain,
        chunkIds: concept.chunk_ids,
        pageEstimate: concept.pageEstimate,
        keyFacts: concept.keyFacts,
        clinicalRelevance: concept.clinicalRelevance,
        associations: concept.associations,
      },
      conceptSpecs,
      confusions,
      [],
    );
    const candidateGuide = formatDistractorCandidatePool(candidatePool);
    const confusionGuide = confusions.length
      ? confusions.map(confusion => `${confusion.concept}: ${confusion.reason}`).join('\n')
      : '';
    distractorGuides[concept.id] = [candidateGuide, confusionGuide].filter(Boolean).join('\n');
  }

  const audit = await auditQuestions(
    generation.questions,
    conceptSpecs,
    pdfId,
    userId,
    ragPassages,
    ragChunks,
    distractorGuides,
    recordCost,
  );

  const totalGenerated = generation.questions.length + generation.rejectedSlots.length;
  const totalRejected = generation.rejectedSlots.length + audit.hardRejected.length;
  const acceptanceRate = totalGenerated ? audit.passed.length / totalGenerated : 0;

  const rejectionBreakdown = audit.hardRejected.reduce<Record<string, number>>((acc, rejection) => {
    const key = rejection.criterion || 'UNKNOWN';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  if (generation.rejectedSlots.length) {
    rejectionBreakdown.SLOT_GENERATION = generation.rejectedSlots.length;
  }
  const slotFailureBreakdown = generation.rejectedSlots.reduce<Record<string, number>>((acc, rejection) => {
    const key = rejection.reason || 'UNKNOWN_SLOT_FAILURE';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  console.log(JSON.stringify({
    pdfPath: resolvedPdfPath,
    requestedConceptCount: conceptCount,
    pages: pages.length,
    chunks: embeddedChunks.length,
    inventoryWarnings: warnings.length,
    extractedConcepts: canonical.length,
    testedConcepts: conceptSpecs.map(concept => concept.name),
    generatedQuestions: generation.questions.length,
    slotFailures: generation.rejectedSlots.length,
    acceptedQuestions: audit.passed.length,
    hardRejectedQuestions: audit.hardRejected.length,
    totalRejected,
    totalGenerated,
    acceptanceRate,
    rejectionBreakdown,
    slotFailureBreakdown,
    openaiCostUSD: Number(totalCostUSD.toFixed(4)),
    acceptedStems: audit.passed.map(question => ({
      concept: question.concept_name ?? question.concept_id,
      level: question.level,
      stem: question.stem,
    })),
    slotFailuresDetail: generation.rejectedSlots.map(rejection => ({
      concept: rejection.conceptName,
      level: rejection.level,
      reason: rejection.reason,
      raw: rejection.raw,
    })),
    rejected: audit.hardRejected.map(rejection => ({
      concept: rejection.conceptName,
      level: rejection.level,
      criterion: rejection.criterion,
      critique: rejection.critique,
    })),
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
