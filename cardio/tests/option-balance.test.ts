import { describe, expect, it } from 'vitest';
import { balanceOptionLengths } from '@/lib/pipeline/distractors';

describe('balanceOptionLengths', () => {
  it('signals when the correct option is a strong length outlier', () => {
    const result = balanceOptionLengths(
      ['A', 'B', 'C', 'This is a much longer correct answer'],
      3,
    );

    expect(result).not.toBeNull();
  });

  it('does not signal when option lengths are comparable', () => {
    const result = balanceOptionLengths(
      ['Increased ADH release', 'Reduced ADH release', 'Normal ADH release', 'Delayed ADH release'],
      0,
    );

    expect(result).toBeNull();
  });
});
