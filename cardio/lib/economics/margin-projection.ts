export type Tier = 'student' | 'boards' | 'institution';
export type UsageBand = 'light' | 'expected' | 'heavy';
export type CostSensitivity = 'current' | 'optimized_25' | 'optimized_50';
export type WorkloadKey =
  | 'standard_50'
  | 'standard_150'
  | 'standard_300'
  | 'comprehensive_150'
  | 'boards_150';

export interface WorkloadCost {
  key: WorkloadKey;
  label: string;
  costPerPdf: number;
}

export interface TierUsageScenario {
  tier: Tier;
  usageBand: UsageBand;
  label: string;
  workload: WorkloadKey;
  pdfsPerMonth: number;
}

export interface InstitutionOrgScenario {
  activeSeats: number;
}

export interface ContributionMargin {
  monthlyPrice: number;
  monthlyCost: number;
  marginDollars: number;
  marginPercent: number;
}

export const REWRITTEN_BASELINE_COSTS: Record<WorkloadKey, WorkloadCost> = {
  standard_50: {
    key: 'standard_50',
    label: 'STANDARD 50 dense pages',
    costPerPdf: 2.15,
  },
  standard_150: {
    key: 'standard_150',
    label: 'STANDARD 150 dense pages',
    costPerPdf: 6.4,
  },
  standard_300: {
    key: 'standard_300',
    label: 'STANDARD 300 dense pages',
    costPerPdf: 7.45,
  },
  comprehensive_150: {
    key: 'comprehensive_150',
    label: 'COMPREHENSIVE 150 dense pages',
    costPerPdf: 7.42,
  },
  boards_150: {
    key: 'boards_150',
    label: 'BOARDS 150 dense pages',
    costPerPdf: 7.42,
  },
};

export const HYPOTHETICAL_PRICE_BANDS: Record<Tier, number[]> = {
  student: [29, 39, 49],
  boards: [79, 99, 129],
  institution: [299, 499, 999],
};

export const COST_SENSITIVITY_MULTIPLIERS: Record<CostSensitivity, number> = {
  current: 1,
  optimized_25: 0.75,
  optimized_50: 0.5,
};

export const TIER_USAGE_SCENARIOS: TierUsageScenario[] = [
  {
    tier: 'student',
    usageBand: 'light',
    label: 'Student Light',
    workload: 'standard_50',
    pdfsPerMonth: 1,
  },
  {
    tier: 'student',
    usageBand: 'expected',
    label: 'Student Expected',
    workload: 'standard_150',
    pdfsPerMonth: 2,
  },
  {
    tier: 'student',
    usageBand: 'heavy',
    label: 'Student Heavy',
    workload: 'standard_150',
    pdfsPerMonth: 4,
  },
  {
    tier: 'boards',
    usageBand: 'light',
    label: 'Boards Light',
    workload: 'standard_150',
    pdfsPerMonth: 2,
  },
  {
    tier: 'boards',
    usageBand: 'expected',
    label: 'Boards Expected',
    workload: 'boards_150',
    pdfsPerMonth: 4,
  },
  {
    tier: 'boards',
    usageBand: 'heavy',
    label: 'Boards Heavy',
    workload: 'boards_150',
    pdfsPerMonth: 6,
  },
  {
    tier: 'institution',
    usageBand: 'light',
    label: 'Institution Per Seat Light',
    workload: 'standard_150',
    pdfsPerMonth: 0.5,
  },
  {
    tier: 'institution',
    usageBand: 'expected',
    label: 'Institution Per Seat Expected',
    workload: 'standard_150',
    pdfsPerMonth: 1,
  },
  {
    tier: 'institution',
    usageBand: 'heavy',
    label: 'Institution Per Seat Heavy',
    workload: 'standard_150',
    pdfsPerMonth: 2,
  },
];

export const INSTITUTION_ACTIVE_SEAT_SCENARIOS: InstitutionOrgScenario[] = [
  { activeSeats: 10 },
  { activeSeats: 25 },
  { activeSeats: 50 },
];

export function adjustedCostPerPdf(workload: WorkloadKey, sensitivity: CostSensitivity): number {
  return roundCurrency(REWRITTEN_BASELINE_COSTS[workload].costPerPdf * COST_SENSITIVITY_MULTIPLIERS[sensitivity]);
}

export function computeContributionMargin(
  monthlyPrice: number,
  pdfsPerMonth: number,
  costPerPdf: number,
): ContributionMargin {
  const monthlyCost = roundCurrency(pdfsPerMonth * costPerPdf);
  const marginDollars = roundCurrency(monthlyPrice - monthlyCost);
  const marginPercent = monthlyPrice > 0 ? marginDollars / monthlyPrice : 0;
  return {
    monthlyPrice,
    monthlyCost,
    marginDollars,
    marginPercent,
  };
}

export function breakEvenPdfsPerMonth(monthlyPrice: number, costPerPdf: number): number {
  if (costPerPdf <= 0) return Number.POSITIVE_INFINITY;
  return monthlyPrice / costPerPdf;
}

export function breakEvenCostPerPdf(monthlyPrice: number, expectedPdfsPerMonth: number): number {
  if (expectedPdfsPerMonth <= 0) return Number.POSITIVE_INFINITY;
  return monthlyPrice / expectedPdfsPerMonth;
}

export function requiredPriceForTargetMargin(totalMonthlyCost: number, targetMarginPercent: number): number {
  const retainedRevenueShare = 1 - targetMarginPercent;
  if (retainedRevenueShare <= 0) return Number.POSITIVE_INFINITY;
  return totalMonthlyCost / retainedRevenueShare;
}

export function maxPdfsForTargetMargin(monthlyPrice: number, costPerPdf: number, targetMarginPercent: number): number {
  const maxCost = monthlyPrice * (1 - targetMarginPercent);
  if (costPerPdf <= 0) return Number.POSITIVE_INFINITY;
  return Math.floor(maxCost / costPerPdf);
}

export function maxActiveSeatsBeforeNegativeMargin(
  monthlyOrgPrice: number,
  perSeatPdfsPerMonth: number,
  costPerPdf: number,
): number {
  const costPerSeat = perSeatPdfsPerMonth * costPerPdf;
  if (costPerSeat <= 0) return Number.POSITIVE_INFINITY;
  return Math.floor(monthlyOrgPrice / costPerSeat);
}

export function marginZone(marginPercent: number): 'negative' | 'below_40' | 'below_60' | 'healthy' {
  if (marginPercent < 0) return 'negative';
  if (marginPercent < 0.4) return 'below_40';
  if (marginPercent < 0.6) return 'below_60';
  return 'healthy';
}

export function formatCurrency(value: number): string {
  if (!Number.isFinite(value)) return 'Infinity';
  return `$${roundCurrency(value).toFixed(2)}`;
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return 'Infinity';
  return `${(value * 100).toFixed(1)}%`;
}

export function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}
