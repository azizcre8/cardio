import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/pipeline/embeddings', () => ({
  embedTexts: async (texts: string[]) => texts.map(text =>
    /venous|vein/i.test(text) ? [1, 0] : [0, 1],
  ),
}));

import {
  dedupeComparisonQuestions,
  renderComparisonMarkdown,
  validateSimplifiedDraft,
  type ComparisonBundle,
} from '@/lib/pipeline/offline-comparison';
import type { Question } from '@/types';

const slot = {
  conceptId: 'concept-1',
  conceptName: 'Vascular Distensibility',
  category: 'Physiology',
  importance: 'high' as const,
  level: 1 as const,
  coverageDomain: 'definition_recall',
  chunkIds: ['chunk-1'],
  pageEstimate: '183',
  keyFacts: ['fractional increase in volume'],
  clinicalRelevance: '',
  associations: ['Vascular Compliance'],
};

const concept = {
  id: 'concept-1',
  name: 'Vascular Distensibility',
  category: 'Physiology',
  importance: 'high' as const,
  keyFacts: ['fractional increase in volume'],
  clinicalRelevance: '',
  associations: ['Vascular Compliance'],
  pageEstimate: '183',
  coverageDomain: 'definition_recall',
  chunk_ids: ['chunk-1'],
};

const evidence = 'Vascular distensibility is expressed ordinarily as the fractional increase in volume for each millimeter of mercury rise in pressure.';

function buildQuestion(partial: Partial<Omit<Question, 'id' | 'created_at'>>): Omit<Question, 'id' | 'created_at'> {
  return {
    pdf_id: 'pdf-1',
    concept_id: 'concept-1',
    concept_name: 'Concept',
    user_id: 'user-1',
    level: 2,
    stem: 'Which mechanism best preserves venous return during acute blood loss?',
    options: [
      'Arterial vasodilation',
      'Venous constriction',
      'Lower heart rate',
      'Reduced preload',
    ],
    answer: 1,
    explanation: 'Venous constriction is correct because it preserves venous return, whereas arterial vasodilation lowers effective filling pressure.',
    option_explanations: null,
    source_quote: 'The sympathetic nervous system elicits nerve signals to constrict veins during blood loss.',
    evidence_start: 0,
    evidence_end: 0,
    chunk_id: 'chunk-1',
    evidence_match_type: 'exact',
    decision_target: 'mechanism',
    deciding_clue: 'constrict veins during blood loss',
    most_tempting_distractor: 'Arterial vasodilation',
    why_tempting: 'both change hemodynamics',
    why_fails: 'vasodilation lowers pressure instead of preserving return',
    option_set_flags: null,
    flagged: false,
    flag_reason: null,
    ...partial,
  };
}

describe('offline comparison helpers', () => {
  it('accepts a valid simplified draft and normalizes it into a saved question shape', () => {
    const result = validateSimplifiedDraft(
      {
        conceptId: 'concept-1',
        conceptName: 'Vascular Distensibility',
        level: 1,
        question: 'Which property is defined as the fractional increase in volume per millimeter of mercury rise in pressure?',
        options: ['Compliance', 'Distensibility', 'Resistance', 'Pulse pressure', 'Vascular tone'],
        correctAnswer: 1,
        explanation: 'Distensibility is correct because it is the fractional increase in volume per millimeter of mercury rise in pressure, whereas compliance refers to the absolute volume change for a pressure change.',
        sourceQuote: evidence,
        decisionTarget: 'definition',
        decidingClue: 'fractional increase in volume',
        mostTemptingDistractor: 'Compliance',
        whyTempting: 'both are pressure-volume properties',
        whyFails: 'compliance is absolute rather than fractional',
      },
      slot,
      concept,
      evidence,
      'pdf-1',
      'user-1',
    );

    expect(result.ok).toBe(true);
    expect(result.question).not.toBeNull();
    expect(result.issues).toEqual([]);
  });

  it('rejects simplified drafts when the explanation points to a different answer choice', () => {
    const result = validateSimplifiedDraft(
      {
        conceptId: 'concept-1',
        conceptName: 'Vascular Distensibility',
        level: 1,
        question: 'Which property is defined as the fractional increase in volume per millimeter of mercury rise in pressure?',
        options: ['Compliance', 'Distensibility', 'Resistance', 'Pulse pressure', 'Vascular tone'],
        correctAnswer: 1,
        explanation: 'Compliance is correct because it describes the change in volume with pressure. Distensibility is related but not the best answer here.',
        sourceQuote: evidence,
        decisionTarget: 'definition',
        decidingClue: 'fractional increase in volume',
        mostTemptingDistractor: 'Compliance',
        whyTempting: 'both are pressure-volume properties',
        whyFails: 'compliance is absolute rather than fractional',
      },
      slot,
      concept,
      evidence,
      'pdf-1',
      'user-1',
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toContain(
      'Explanation appears to justify a different answer choice than the keyed correct answer (Compliance).',
    );
  });

  it('rejects simplified drafts whose stems are declarative instead of interrogative', () => {
    const result = validateSimplifiedDraft(
      {
        conceptId: 'concept-1',
        conceptName: 'Vascular Distensibility',
        level: 1,
        question: 'The property defined as the fractional increase in volume per millimeter of mercury rise in pressure is vascular distensibility.',
        options: ['Compliance', 'Distensibility', 'Resistance', 'Pulse pressure', 'Vascular tone'],
        correctAnswer: 1,
        explanation: 'Distensibility is correct because it is the fractional increase in volume per millimeter of mercury rise in pressure, whereas compliance refers to the absolute volume change for a pressure change.',
        sourceQuote: evidence,
        decisionTarget: 'definition',
        decidingClue: 'fractional increase in volume',
        mostTemptingDistractor: 'Compliance',
        whyTempting: 'both are pressure-volume properties',
        whyFails: 'compliance is absolute rather than fractional',
      },
      slot,
      concept,
      evidence,
      'pdf-1',
      'user-1',
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toContain('Stem is not phrased as a question.');
  });

  it('deduplicates near-identical accepted questions through the comparison wrapper', async () => {
    const result = await dedupeComparisonQuestions(
      [
        buildQuestion({
          concept_id: 'concept-high',
          stem: 'Which mechanism best preserves venous return during acute blood loss?',
        }),
        buildQuestion({
          concept_id: 'concept-low',
          stem: 'Which mechanism best preserves venous return during acute blood loss?',
        }),
      ],
      {
        'concept-high': 'high',
        'concept-low': 'low',
      },
    );

    expect(result.kept).toHaveLength(1);
    expect(result.dropped).toHaveLength(1);
    expect(result.kept[0]?.concept_id).toBe('concept-high');
  });

  it('renders a reviewable markdown report from a normalized bundle shape', () => {
    const bundle: ComparisonBundle = {
      pdfPath: '/tmp/sample.pdf',
      density: 'standard',
      requestedConceptCount: 12,
      generatedAt: '2026-04-20T00:00:00.000Z',
      results: [{
        runner: 'simplified',
        pdfPath: '/tmp/sample.pdf',
        density: 'standard',
        requestedConceptCount: 12,
        pages: 16,
        chunks: 10,
        inventoryWarnings: 0,
        extractedConcepts: 12,
        testedConcepts: ['Vascular Distensibility'],
        generatedQuestions: 3,
        acceptedQuestions: 2,
        rejectedQuestions: 1,
        dedupedQuestions: 0,
        acceptanceRate: 0.6667,
        openaiCostUSD: 0.1234,
        rejectionBreakdown: { SIMPLIFIED_VALIDATION_FAILED: 1 },
        accepted: [{
          conceptId: 'concept-1',
          conceptName: 'Vascular Distensibility',
          level: 1,
          stem: 'Which property is defined as the fractional increase in volume per millimeter of mercury rise in pressure?',
          options: ['Compliance', 'Distensibility', 'Resistance', 'Pulse pressure', 'Vascular tone'],
          answer: 1,
          explanation: 'Distensibility is correct because it is the fractional increase in volume per millimeter of mercury rise in pressure, whereas compliance refers to the absolute volume change for a pressure change.',
          sourceQuote: evidence,
        }],
        representativeFailures: [{
          conceptId: 'concept-1',
          conceptName: 'Vascular Distensibility',
          level: 1,
          reason: 'SIMPLIFIED_VALIDATION_FAILED',
        }],
        notes: ['AI-led runner with light validation.'],
      }],
    };

    const markdown = renderComparisonMarkdown(bundle);

    expect(markdown).toContain('# Generation Comparison');
    expect(markdown).toContain('## Runner: simplified');
    expect(markdown).toContain('### Accepted Question Samples');
    expect(markdown).toContain('### Representative Failures');
  });
});
