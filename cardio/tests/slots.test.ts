import { describe, expect, it } from 'vitest';
import { buildGenerationSlots } from '@/lib/pipeline/slots';
import { DENSITY_CONFIG } from '@/types';

describe('buildGenerationSlots', () => {
  it('builds required levels from density config in concept order', () => {
    const { slots, truncated } = buildGenerationSlots([
      {
        id: 'c1',
        name: 'Concept One',
        category: 'Pathophysiological Mechanism',
        importance: 'high',
        keyFacts: [],
        clinicalRelevance: '',
        associations: [],
        pageEstimate: '10',
        coverageDomain: 'mechanism_causal',
        chunk_ids: ['chunk-1'],
      },
      {
        id: 'c2',
        name: 'Concept Two',
        category: 'Clinical Presentation',
        importance: 'medium',
        keyFacts: [],
        clinicalRelevance: '',
        associations: [],
        pageEstimate: '11',
        coverageDomain: 'clinical_application',
        chunk_ids: ['chunk-2'],
      },
    ], DENSITY_CONFIG.standard, 10);

    expect(truncated).toBe(false);
    expect(slots.map(slot => [slot.conceptId, slot.level])).toEqual([
      ['c1', 1],
      ['c1', 2],
      ['c1', 3],
      ['c2', 1],
      ['c2', 2],
    ]);
  });
});
