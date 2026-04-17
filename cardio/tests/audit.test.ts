import { describe, expect, it } from 'vitest';
import { auditQuestions, deterministicVerdict } from '@/lib/pipeline/audit';

describe('deterministicVerdict', () => {
  it('keeps multi-issue option-set failures revisable instead of hard rejecting immediately', () => {
    const verdict = deterministicVerdict(0, [
      'Option lengths create a test-taking tell rather than requiring medical knowledge.',
      'Two answer choices are overly overlapping, which weakens distractor diversity.',
    ]);

    expect(verdict.status).toBe('REVISE');
    expect(verdict.criterion).toBe('OPTION_SET_HOMOGENEITY');
  });

  it('routes explanation and metadata misses into a single pedagogy revision', () => {
    const verdict = deterministicVerdict(0, [
      'Question is missing the required whyTempting rationale.',
      'Explanation is too short to teach why the correct answer is right and the top distractor is wrong.',
    ]);

    expect(verdict.status).toBe('REVISE');
    expect(verdict.criterion).toBe('CLINICAL_PEDAGOGY');
  });

  it('prioritizes evidence grounding over stylistic tells when both are present', () => {
    const verdict = deterministicVerdict(0, [
      'Correct answer is longer than average and creates a test-taking tell.',
      'Deciding clue is not clearly supported by the quoted PDF evidence.',
    ]);

    expect(verdict.status).toBe('REVISE');
    expect(verdict.criterion).toBe('EVIDENCE_GROUNDING');
  });

  it('passes low-risk level 1 definition items without sending them to the model auditor', async () => {
    const question = {
      pdf_id: 'pdf-1',
      concept_id: 'concept-1',
      concept_name: 'Vascular Distensibility',
      user_id: 'user-1',
      level: 1 as const,
      stem: 'Which vascular property is defined as the fractional increase in volume per mm Hg rise in pressure?',
      options: ['Elasticity', 'Distensibility', 'Stiffness', 'Rigidity', 'Compliance'],
      answer: 1,
      explanation: 'Distensibility is correct because it matches the fractional-increase clue, whereas compliance refers to stored volume per pressure rise. Key distinction: fractional increase in volume per mm Hg rise in pressure.',
      option_explanations: null,
      source_quote: 'Vascular distensibility is expressed ordinarily as the fractional increase in volume for each millimeter of mercury rise in pressure.',
      evidence_start: 0,
      evidence_end: 0,
      chunk_id: null,
      evidence_match_type: null,
      decision_target: 'definition',
      deciding_clue: 'fractional increase in volume per mm Hg rise in pressure',
      most_tempting_distractor: 'Compliance',
      why_tempting: 'both are pressure-volume properties',
      why_fails: 'compliance is stored volume per pressure rise, not fractional increase',
      option_set_flags: null,
      flagged: false,
      flag_reason: null,
    };

    const result = await auditQuestions(
      [question],
      [{
        id: 'concept-1',
        name: 'Vascular Distensibility',
        category: 'Physiological Concept',
        importance: 'high',
        keyFacts: ['fractional increase in volume per mm Hg rise in pressure'],
        clinicalRelevance: '',
        associations: ['Vascular Compliance'],
        pageEstimate: '183',
        coverageDomain: 'definition_recall',
        chunk_ids: [],
      }],
      'pdf-1',
      'user-1',
      { 'concept-1': 'Vascular distensibility is expressed ordinarily as the fractional increase in volume for each millimeter of mercury rise in pressure.' },
      { 'concept-1': [] },
      { 'concept-1': 'Vascular Compliance: often confused pressure-volume property' },
    );

    expect(result.passed).toHaveLength(1);
    expect(result.hardRejected).toHaveLength(0);
  });

  it('passes curated pressure-volume property items when deterministic validation is clean', async () => {
    const question = {
      pdf_id: 'pdf-1',
      concept_id: 'concept-1',
      concept_name: 'Vascular Compliance',
      user_id: 'user-1',
      level: 2 as const,
      stem: 'Systemic veins can store much more blood than corresponding arteries primarily because veins have greater what vascular property?',
      options: ['Resistance', 'Compliance', 'Distensibility', 'Pulse pressure'],
      answer: 1,
      explanation: 'Compliance is correct because veins store more blood per pressure rise, whereas distensibility describes relative expansibility rather than storage capacity. Distensibility is tempting because both are pressure-volume concepts, but fails because the stem asks about blood storage per pressure rise. Key distinction: blood stored per pressure rise points to compliance.',
      option_explanations: null,
      source_quote: 'Compliance is the total quantity of blood that can be stored per mm Hg pressure rise.',
      evidence_start: 0,
      evidence_end: 0,
      chunk_id: null,
      evidence_match_type: null,
      decision_target: 'mechanism',
      deciding_clue: 'stores much more blood per pressure rise',
      most_tempting_distractor: 'Distensibility',
      why_tempting: 'both are pressure-volume vessel properties',
      why_fails: 'distensibility does not directly encode total storage per pressure rise',
      option_set_flags: null,
      flagged: false,
      flag_reason: null,
    };

    const result = await auditQuestions(
      [question],
      [{
        id: 'concept-1',
        name: 'Vascular Compliance',
        category: 'Physiological Concept',
        importance: 'high',
        keyFacts: ['total quantity of blood stored per mm Hg pressure rise'],
        clinicalRelevance: '',
        associations: ['Vascular Distensibility'],
        pageEstimate: '183',
        coverageDomain: 'pressure_volume_quantitative',
        chunk_ids: [],
      }],
      'pdf-1',
      'user-1',
      { 'concept-1': 'Compliance is the total quantity of blood that can be stored per mm Hg pressure rise.' },
      { 'concept-1': [] },
      { 'concept-1': 'Vascular Distensibility: commonly confused contrast concept' },
    );

    expect(result.passed).toHaveLength(1);
    expect(result.hardRejected).toHaveLength(0);
  });
});
