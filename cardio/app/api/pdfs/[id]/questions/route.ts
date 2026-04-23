/**
 * GET /api/pdfs/[id]/questions — fetch all questions for a PDF (shuffled)
 */

import { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api';

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const { supabase, userId } = auth;

  const [{ data, error }, { data: srsData }] = await Promise.all([
    supabase
      .from('questions')
      .select(`
        id,
        stem,
        options,
        answer,
        explanation,
        source_quote,
        level,
        concept_id,
        chunk_id,
        evidence_start,
        evidence_end,
        evidence_match_type,
        decision_target,
        deciding_clue,
        most_tempting_distractor,
        option_set_flags,
        concepts(name)
      `)
      .eq('pdf_id', params.id)
      .eq('flagged', false),
    supabase
      .from('srs_state')
      .select('question_id,interval,ease_factor,repetitions,next_review,last_reviewed,times_reviewed,times_correct,times_incorrect,quality_history')
      .eq('pdf_id', params.id)
      .eq('user_id', userId),
  ]);

  if (error) return jsonError(error.message);

  const srsMap = new Map((srsData ?? []).map((s: Record<string, unknown>) => [s.question_id as string, s]));

  // Flatten concept name, merge SRS state, and shuffle (Fisher-Yates)
  const questions = (data ?? []).map((q: Record<string, unknown>) => {
    const { concepts, ...rest } = q;
    const srs = srsMap.get(q.id as string);
    return {
      ...rest,
      concept_name: (concepts as { name?: string } | null)?.name ?? undefined,
      ...(srs ? {
        interval:        srs.interval,
        ease_factor:     srs.ease_factor,
        repetitions:     srs.repetitions,
        next_review:     srs.next_review,
        last_reviewed:   srs.last_reviewed,
        times_reviewed:  srs.times_reviewed,
        times_correct:   srs.times_correct,
        times_incorrect: srs.times_incorrect,
        quality_history: srs.quality_history,
      } : {}),
    };
  });
  for (let i = questions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [questions[i], questions[j]] = [questions[j], questions[i]];
  }

  return jsonOk({ questions });
}
