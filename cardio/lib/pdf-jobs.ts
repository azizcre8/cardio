import { supabaseAdmin } from '@/lib/supabase';
import { roundUsdAmount } from '@/lib/openai-cost';
import type { PDFJob, PDFJobStatus, Density } from '@/types';

function isMissingPdfJobsSchema(message: string): boolean {
  return message.includes('pdf_jobs') || message.includes('plan_name') || message.includes('openai_cost_usd');
}

type CreatePdfJobInput = {
  user_id: string;
  pdf_id: string;
  pdf_name: string;
  density: Density;
  plan_name: string;
  page_count?: number | null;
  question_count?: number | null;
  concept_count?: number | null;
  openai_cost_usd?: number;
  started_at?: string;
};

type UpdatePdfJobPatch = Partial<Omit<PDFJob, 'id' | 'user_id' | 'pdf_id' | 'created_at' | 'updated_at'>>;

export async function createPdfJob(input: CreatePdfJobInput): Promise<PDFJob | null> {
  const row = {
    user_id: input.user_id,
    pdf_id: input.pdf_id,
    pdf_name: input.pdf_name,
    page_count: input.page_count ?? 0,
    question_count: input.question_count ?? 0,
    concept_count: input.concept_count ?? 0,
    density: input.density,
    plan_name: input.plan_name,
    status: 'processing' as PDFJobStatus,
    started_at: input.started_at ?? new Date().toISOString(),
    finished_at: null,
    openai_cost_usd: roundUsdAmount(input.openai_cost_usd ?? 0),
    error_message: null,
  };

  const { data, error } = await supabaseAdmin
    .from('pdf_jobs')
    .insert(row)
    .select('*')
    .single();

  if (error) {
    if (isMissingPdfJobsSchema(error.message)) return null;
    throw new Error(`createPdfJob: ${error.message}`);
  }
  return data as PDFJob;
}

export async function updatePdfJob(id: string, patch: UpdatePdfJobPatch): Promise<void> {
  const normalizedPatch: Record<string, unknown> = {
    ...patch,
    updated_at: new Date().toISOString(),
  };

  if (typeof patch.openai_cost_usd === 'number') {
    normalizedPatch.openai_cost_usd = roundUsdAmount(patch.openai_cost_usd);
  }

  const { error } = await supabaseAdmin.from('pdf_jobs').update(normalizedPatch).eq('id', id);
  if (error) {
    if (isMissingPdfJobsSchema(error.message)) return;
    throw new Error(`updatePdfJob: ${error.message}`);
  }
}

export async function finishPdfJobSuccess(
  id: string,
  result: {
    page_count: number;
    question_count: number;
    concept_count: number;
    openai_cost_usd: number;
  },
): Promise<void> {
  await updatePdfJob(id, {
    page_count: result.page_count,
    question_count: result.question_count,
    concept_count: result.concept_count,
    openai_cost_usd: result.openai_cost_usd,
    status: 'completed',
    finished_at: new Date().toISOString(),
    error_message: null,
  });
}

export async function finishPdfJobError(
  id: string,
  result: {
    openai_cost_usd: number;
    error_message: string;
    page_count?: number;
    question_count?: number;
    concept_count?: number;
  },
): Promise<void> {
  await updatePdfJob(id, {
    page_count: result.page_count,
    question_count: result.question_count,
    concept_count: result.concept_count,
    openai_cost_usd: result.openai_cost_usd,
    status: 'failed',
    finished_at: new Date().toISOString(),
    error_message: result.error_message,
  });
}

/**
 * Internal aggregate helper for ops/admin use.
 * This keeps reporting out of the product UI while giving the backend a stable
 * place to answer questions like average cost per PDF, total cost by user, and
 * total cost by plan.
 */
export async function getPdfJobCostSummary(): Promise<{
  averageCostPerPdf: number;
  totalCostByUser: Array<{ user_id: string; total_cost_usd: number; job_count: number }>;
  totalCostByPlan: Array<{ plan_name: string; total_cost_usd: number; job_count: number }>;
}> {
  const { data, error } = await supabaseAdmin
    .from('pdf_jobs')
    .select('user_id, plan_name, openai_cost_usd')
    .not('finished_at', 'is', null);

  if (error) throw new Error(`getPdfJobCostSummary: ${error.message}`);

  const rows = (data ?? []) as Array<{ user_id: string; plan_name: string; openai_cost_usd: number | string | null }>;
  const byUser = new Map<string, { total_cost_usd: number; job_count: number }>();
  const byPlan = new Map<string, { total_cost_usd: number; job_count: number }>();
  let totalCost = 0;

  for (const row of rows) {
    const cost = Number(row.openai_cost_usd ?? 0);
    totalCost += cost;

    const userEntry = byUser.get(row.user_id) ?? { total_cost_usd: 0, job_count: 0 };
    userEntry.total_cost_usd += cost;
    userEntry.job_count += 1;
    byUser.set(row.user_id, userEntry);

    const planName = row.plan_name || 'unknown';
    const planEntry = byPlan.get(planName) ?? { total_cost_usd: 0, job_count: 0 };
    planEntry.total_cost_usd += cost;
    planEntry.job_count += 1;
    byPlan.set(planName, planEntry);
  }

  return {
    averageCostPerPdf: rows.length ? roundUsdAmount(totalCost / rows.length) : 0,
    totalCostByUser: Array.from(byUser.entries()).map(([user_id, value]) => ({
      user_id,
      total_cost_usd: roundUsdAmount(value.total_cost_usd),
      job_count: value.job_count,
    })),
    totalCostByPlan: Array.from(byPlan.entries()).map(([plan_name, value]) => ({
      plan_name,
      total_cost_usd: roundUsdAmount(value.total_cost_usd),
      job_count: value.job_count,
    })),
  };
}
