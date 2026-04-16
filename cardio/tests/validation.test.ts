import { describe, expect, it } from 'vitest';
import { hasEvidenceAnchorSupport, verifyEvidenceSpan } from '@/lib/pipeline/validation';

describe('verifyEvidenceSpan', () => {
  it('accepts multi-clause quote strings when the component clauses appear in source text', () => {
    const result = verifyEvidenceSpan(
      'Critical for maintaining blood pressure during stress or blood loss; elicits nerve signals to constrict veins.',
      0,
      0,
      'The sympathetic nervous system is critical for maintaining blood pressure during stress or blood loss. It elicits nerve signals to constrict veins and shift blood toward the heart.',
    );

    expect(result.ok).toBe(true);
    expect(result.evidenceMatchType).not.toBe('none');
  });

  it('detects lexical support between keyed answer language and evidence text', () => {
    expect(
      hasEvidenceAnchorSupport(
        'venous constriction increases venous return',
        'Venous constriction increases venous return and helps preserve blood pressure.',
      ),
    ).toBe(true);

    expect(
      hasEvidenceAnchorSupport(
        'automated oscillometric method reduces white coat effect',
        'The liver stores blood and helps filter old erythrocytes from circulation.',
      ),
    ).toBe(false);
  });
});
