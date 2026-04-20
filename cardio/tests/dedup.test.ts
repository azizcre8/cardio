import { describe, expect, it, vi } from 'vitest';
import { dedupQuestions } from '@/lib/pipeline/dedup';
import type { Question } from '@/types';

vi.mock('@/lib/pipeline/embeddings', () => ({
  embedTexts: vi.fn(async (texts: string[]) => texts.map((_, idx) => idx === 0 ? [1, 0] : [0.98, 0.02])),
}));

function buildQuestion(overrides: Partial<Omit<Question, 'id' | 'created_at'>>): Omit<Question, 'id' | 'created_at'> {
  return {
    pdf_id: 'pdf-1',
    concept_id: 'concept-1',
    user_id: 'user-1',
    level: 2,
    stem: 'A 65 year old man presents with swelling in his legs and shortness of breath which mechanism best explains his edema?',
    options: ['Increased capillary hydrostatic pressure', 'Decreased lymph flow', 'Reduced plasma proteins', 'Increased sodium excretion'],
    answer: 0,
    explanation: 'Increased capillary hydrostatic pressure is correct because it drives fluid out of the capillaries.',
    option_explanations: null,
    source_quote: 'Capillary hydrostatic pressure promotes filtration of fluid into the interstitial space.',
    concept_name: 'Edema',
    evidence_start: 0,
    evidence_end: 0,
    chunk_id: 'chunk-2',
    evidence_match_type: 'exact',
    decision_target: 'mechanism',
    deciding_clue: 'leg swelling with fluid movement',
    most_tempting_distractor: 'Decreased lymph flow',
    why_tempting: 'both can produce edema',
    why_fails: 'lymphatic obstruction is not the primary mechanism here',
    option_set_flags: null,
    flagged: false,
    flag_reason: null,
    ...overrides,
  };
}

describe('dedupQuestions', () => {
  it('keeps the higher-importance concept when stems are near-identical', async () => {
    const higherImportance = buildQuestion({
      concept_id: 'concept-high',
      concept_name: 'Edema',
      chunk_id: 'chunk-1',
    });
    const lowerImportance = buildQuestion({
      concept_id: 'concept-low',
      concept_name: 'Extracellular Fluid',
      chunk_id: 'chunk-9',
      stem: 'A 65 year old man presents with swelling in his legs and shortness of breath which mechanism best explains this extracellular fluid expansion?',
    });

    const result = await dedupQuestions(
      [lowerImportance, higherImportance],
      { 'concept-high': 'high', 'concept-low': 'medium' },
    );

    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]?.concept_id).toBe('concept-high');
    expect(result.dropped).toHaveLength(1);
  });
});
