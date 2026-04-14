/**
 * GET /api/pdfs/[id]/questions — fetch all questions for a PDF (shuffled)
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const supabase = supabaseServer();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase
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
    .eq('user_id', session.user.id)
    .eq('flagged', false);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

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

  return NextResponse.json({ questions });
}
