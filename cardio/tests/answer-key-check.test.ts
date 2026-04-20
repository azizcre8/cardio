import { describe, expect, it } from 'vitest';
import { detectConceptMismatch, detectExplanationAnswerMismatch } from '@/lib/pipeline/answer-key-check';

describe('answer-key checks', () => {
  it('passes when the explanation leads with the keyed option', () => {
    const result = detectExplanationAnswerMismatch(
      ['Aldosterone', 'ADH', 'ANP', 'Renin'],
      1,
      'ADH is correct because it increases water reabsorption in the collecting ducts.',
    );

    expect(result).toBeNull();
  });

  it('flags when the explanation leads with a distractor and a positive cue', () => {
    const result = detectExplanationAnswerMismatch(
      ['Aldosterone', 'ADH', 'ANP', 'Renin'],
      1,
      'Aldosterone is correct because it increases sodium retention in the distal nephron.',
    );

    expect(result).toContain('Aldosterone');
  });

  it('flags concept mismatch when neither stem nor keyed option mentions the concept or an alias', () => {
    const result = detectConceptMismatch(
      'Which property best preserves internal stability across changing external conditions?',
      'Homeostasis',
      'Hypernatremia',
      ['elevated serum sodium'],
    );

    expect(result).toContain('Hypernatremia');
  });

  it('passes when the stem contains a concept alias', () => {
    const result = detectConceptMismatch(
      'Which hormone deficiency most directly explains severe dehydration in a patient with absent ADH?',
      'Antidiuretic hormone deficiency',
      'Antidiuretic Hormone (ADH)',
      ['vasopressin'],
    );

    expect(result).toBeNull();
  });
});
