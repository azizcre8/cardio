import { PLAN_LIMITS, type PlanTier, type PlanLimits } from '@/types';

export { PLAN_LIMITS };

export function normalizePlanTier(plan: string | null | undefined): PlanTier {
  if (plan === 'student' || plan === 'boards' || plan === 'institution') {
    return plan;
  }
  return 'free';
}

export function getPlanLimits(plan: string | null | undefined): PlanLimits {
  return PLAN_LIMITS[normalizePlanTier(plan)];
}
