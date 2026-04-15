import { describe, expect, it } from 'vitest';
import {
  breakEvenCostPerPdf,
  breakEvenPdfsPerMonth,
  computeContributionMargin,
  maxActiveSeatsBeforeNegativeMargin,
  maxPdfsForTargetMargin,
  requiredPriceForTargetMargin,
} from '@/lib/economics/margin-projection';

describe('margin projection math', () => {
  it('computes contribution margin from monthly price and generation cost', () => {
    const result = computeContributionMargin(39, 2, 6.4);
    expect(result.monthlyCost).toBe(12.8);
    expect(result.marginDollars).toBe(26.2);
    expect(result.marginPercent).toBeCloseTo(26.2 / 39, 6);
  });

  it('computes break-even and target-margin thresholds', () => {
    expect(breakEvenPdfsPerMonth(39, 6.4)).toBeCloseTo(6.09375, 6);
    expect(breakEvenCostPerPdf(39, 2)).toBe(19.5);
    expect(requiredPriceForTargetMargin(29.68, 0.7)).toBeCloseTo(98.933333, 6);
    expect(maxPdfsForTargetMargin(39, 6.4, 0.6)).toBe(2);
  });

  it('computes institution seat break-even count before negative margin', () => {
    expect(maxActiveSeatsBeforeNegativeMargin(499, 1, 6.4)).toBe(77);
  });
});
