/**
 * GET /api/pdfs/[id]/questions — fetch all questions for a PDF (shuffled)
 */

import { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { jsonError, jsonNotFound, jsonOk } from '@/lib/api';
import { getAccessiblePdfForUser } from '@/lib/shared-banks';
import { supabaseAdmin } from '@/lib/supabase';

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const access = await getAccessiblePdfForUser(params.id, auth.userId);
  if (!access) return jsonNotFound('PDF not found');

  const { data, error } = await supabaseAdmin
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
    .eq('user_id', access.pdf.user_id)
    .eq('flagged', false);

  if (error) return jsonError(error.message);

  // Flatten concept name and shuffle (Fisher-Yates)
  const questions = (data ?? []).map((q: Record<string, unknown>) => {
    const { concepts, ...rest } = q;
    return {
      ...rest,
      concept_name: (concepts as { name?: string } | null)?.name ?? undefined,
    };
  });
  for (let i = questions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [questions[i], questions[j]] = [questions[j], questions[i]];
  }

  return jsonOk({ questions });
}
