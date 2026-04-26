import type { DensityConfig, GenerationSlot, ImportanceLevel } from '@/types';

interface SlotConceptInput {
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

export function buildGenerationSlots(
  concepts: SlotConceptInput[],
  dc: DensityConfig,
  maxQuestions: number,
): { slots: GenerationSlot[]; truncated: boolean } {
  const slots: GenerationSlot[] = [];
  let truncated = false;

  for (const concept of concepts) {
    const levels = dc.levels[concept.importance] ?? [1, 2];

    if (slots.length + levels.length <= maxQuestions) {
      levels.forEach(level => {
        slots.push({
          conceptId: concept.id,
          conceptName: concept.name,
          category: concept.category,
          importance: concept.importance,
          level,
          coverageDomain: concept.coverageDomain,
          chunkIds: concept.chunk_ids,
          pageEstimate: concept.pageEstimate ?? '',
          keyFacts: concept.keyFacts ?? [],
          clinicalRelevance: concept.clinicalRelevance ?? '',
          associations: concept.associations ?? [],
        });
      });
      continue;
    }

    if (!slots.length && maxQuestions > 0) {
      levels.slice(0, maxQuestions).forEach(level => {
        slots.push({
          conceptId: concept.id,
          conceptName: concept.name,
          category: concept.category,
          importance: concept.importance,
          level,
          coverageDomain: concept.coverageDomain,
          chunkIds: concept.chunk_ids,
          pageEstimate: concept.pageEstimate ?? '',
          keyFacts: concept.keyFacts ?? [],
          clinicalRelevance: concept.clinicalRelevance ?? '',
          associations: concept.associations ?? [],
        });
      });
    }

    truncated = true;
    break;
  }

  return { slots, truncated };
}
