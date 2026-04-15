import { describe, expect, it } from 'vitest';
import { buildDistractorCandidatePool } from '@/lib/pipeline/distractors';
import type { GenerationSlot } from '@/types';

describe('buildDistractorCandidatePool', () => {
  it('prefers chapter-local same-category and confusion targets before hardcoded fallbacks', () => {
    const slot: GenerationSlot = {
      conceptId: 'c1',
      conceptName: 'Achalasia',
      category: 'Pathological Condition',
      importance: 'high',
      level: 2,
      coverageDomain: 'clinical_application',
      chunkIds: ['chunk-1'],
      pageEstimate: '5',
      keyFacts: ['aperistalsis', 'failure of LES relaxation'],
      clinicalRelevance: 'Causes dysphagia to solids and liquids from onset.',
      associations: ['Diffuse esophageal spasm'],
    };

    const pool = buildDistractorCandidatePool(
      slot,
      [
        { id: 'c1', name: 'Achalasia', category: 'Pathological Condition' },
        { id: 'c2', name: 'Diffuse esophageal spasm', category: 'Pathological Condition' },
        { id: 'c3', name: 'Scleroderma esophagus', category: 'Pathological Condition' },
        { id: 'c4', name: 'Nitric oxide', category: 'Pathophysiological Mechanism' },
      ],
      [
        { concept: 'Diffuse esophageal spasm', reason: 'both are esophageal motility disorders' },
      ],
      [],
    );

    expect(pool[0]?.text).toBe('Diffuse esophageal spasm');
    expect(pool.some(candidate => candidate.reasonType === 'same_category_peer')).toBe(true);
    expect(pool.some(candidate => candidate.reasonType === 'confusion_pair')).toBe(true);
    expect(pool.every(candidate => candidate.text !== 'Achalasia')).toBe(true);
  });
});
