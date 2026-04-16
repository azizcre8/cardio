import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChunkRecord, DensityConfig } from '@/types';

vi.mock('@/lib/pipeline/inventory', () => ({
  extractInventory: vi.fn(),
}));

import { extractInventory } from '@/lib/pipeline/inventory';
import {
  buildGenerationBatchFailureFlags,
  extractInventoriesResilient,
  sortConceptsByImportanceAndName,
} from '@/lib/pipeline/process-helpers';

const mockedExtractInventory = vi.mocked(extractInventory);

const densityConfig: DensityConfig = {
  words: 600,
  overlap: 150,
  min: 4,
  max: 8,
  levels: {
    high: [1, 2, 3],
    medium: [1, 2],
    low: [1],
  },
};

function makeChunk(id: string): ChunkRecord {
  return {
    id,
    pdf_id: 'pdf-1',
    text: `Chunk text for ${id} with enough content to clear validation and inventory thresholds.`,
    start_page: 1,
    end_page: 1,
    headers: [],
    word_count: 20,
    embedding: [],
  };
}

describe('process helpers', () => {
  beforeEach(() => {
    mockedExtractInventory.mockReset();
  });

  it('continues inventory extraction after a failed batch', async () => {
    const chunks = ['c1', 'c2', 'c3', 'c4'].map(makeChunk);

    mockedExtractInventory
      .mockRejectedValueOnce(new Error('Could not parse JSON from response'))
      .mockResolvedValueOnce({
        headings: ['Recovered'],
        sourceChunkIds: ['c4'],
        concepts: [{
          name: 'Recovered Concept',
          category: 'Key Term',
          importance: 'medium',
          keyFacts: [],
          clinicalRelevance: '',
          associations: [],
          aliases: [],
          chunk_ids: ['c4'],
        }],
      });

    const result = await extractInventoriesResilient(chunks, densityConfig);

    expect(result.inventories).toHaveLength(1);
    expect(result.inventories[0]?.sourceChunkIds).toEqual(['c4']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.chunkIds).toEqual(['c1', 'c2', 'c3']);
  });

  it('creates one flagged failure payload per concept in a failed generation batch', () => {
    const failures = buildGenerationBatchFailureFlags(
      [
        { id: 'concept-1', name: 'Alpha' },
        { id: 'concept-2', name: 'Beta' },
      ],
      new Error('429 retry budget exhausted'),
    );

    expect(failures).toHaveLength(2);
    expect(failures[0]?.reason).toBe('GENERATION_BATCH_FAILED: 429 retry budget exhausted');
    expect(failures[1]?.raw_json).toMatchObject({
      conceptId: 'concept-2',
      conceptName: 'Beta',
      error: '429 retry budget exhausted',
    });
  });

  it('stabilizes concept ordering within the same importance tier', () => {
    const sorted = sortConceptsByImportanceAndName([
      { id: '2', name: 'Beta', importance: 'high' },
      { id: '1', name: 'Alpha', importance: 'high' },
      { id: '3', name: 'Gamma', importance: 'medium' },
    ]);

    expect(sorted.map(concept => concept.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });
});
