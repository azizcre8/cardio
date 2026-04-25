/**
 * GET /api/admin/question-stats?pdfId=<uuid>
 * Returns per-question psychometric analytics for a PDF.
 *
 * Metrics computed server-side:
 *   - difficulty_index   = correct_count / total_attempts (0–1)
 *   - discrimination_index = p_top27 - p_bottom27
 *   - option_counts      = tally of selected_option per slot
 *   - avg_time_ms        = mean time_spent_ms
 *   - flag_count / flag_reasons
 *   - helpful_pct        = % of helpful=true ratings (null if none)
 */

import { NextRequest } from 'next/server';
import { getQuestionAttemptsForPdf } from '@/lib/storage';
import { supabaseAdmin } from '@/lib/supabase';
import { requireUser } from '@/lib/auth';
import { jsonBadRequest, jsonOk } from '@/lib/api';
import type { QuestionStatRow, AttemptFlagReason } from '@/types';

type AttemptRow = {
  question_id: string;
  user_id: string;
  selected_option: number;
  is_correct: boolean;
  time_spent_ms: number;
  explanation_helpful: boolean | null;
  flag_reason: string | null;
};

export async function GET(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(req.url);
  const pdfId = searchParams.get('pdfId');
  if (!pdfId) return jsonBadRequest('pdfId query param is required');

  // Fetch all attempts for this PDF
  const attempts = (await getQuestionAttemptsForPdf(pdfId)) as AttemptRow[];

  // Fetch question metadata (stem, level, answer, options, concept_name)
  // Join concepts to get concept_name
  const { data: questionsRaw, error: qErr } = await supabaseAdmin
    .from('questions')
    .select('id, stem, level, answer, options, concept_id, concept_name')
    .eq('pdf_id', pdfId);

  if (qErr) return jsonBadRequest(`Failed to fetch questions: ${qErr.message}`);

  const questions = (questionsRaw ?? []) as Array<{
    id: string;
    stem: string;
    level: number;
    answer: number;
    options: string[];
    concept_id: string;
    concept_name: string | null;
  }>;

  if (!questions.length) return jsonOk([]);

  // Build userId → score map (% correct across all attempts in this PDF)
  // We use "attempts per user" to compute their overall score
  const userAttemptMap = new Map<string, { correct: number; total: number }>();
  for (const a of attempts) {
    const entry = userAttemptMap.get(a.user_id) ?? { correct: 0, total: 0 };
    entry.total += 1;
    if (a.is_correct) entry.correct += 1;
    userAttemptMap.set(a.user_id, entry);
  }

  // Sort users by % correct, descending
  const sortedUsers = Array.from(userAttemptMap.entries())
    .map(([userId, s]) => ({ userId, pct: s.total > 0 ? s.correct / s.total : 0 }))
    .sort((a, b) => b.pct - a.pct);

  const n = sortedUsers.length;
  const cutoff = Math.max(1, Math.ceil(n * 0.27));
  const topUserIds = new Set(sortedUsers.slice(0, cutoff).map(u => u.userId));
  const bottomUserIds = new Set(sortedUsers.slice(n - cutoff).map(u => u.userId));

  // Group attempts by question_id
  const attemptsByQuestion = new Map<string, typeof attempts>();
  for (const a of attempts) {
    const arr = attemptsByQuestion.get(a.question_id) ?? [];
    arr.push(a);
    attemptsByQuestion.set(a.question_id, arr);
  }

  // Build QuestionStatRow for each question
  const rows: QuestionStatRow[] = questions.map(q => {
    const qAttempts = attemptsByQuestion.get(q.id) ?? [];
    const total = qAttempts.length;

    if (total === 0) {
      return {
        question_id:          q.id,
        stem:                 q.stem,
        level:                q.level as 1 | 2 | 3,
        concept_name:         q.concept_name ?? '',
        total_attempts:       0,
        difficulty_index:     0,
        discrimination_index: 0,
        option_counts:        Array(q.options?.length ?? 4).fill(0) as number[],
        avg_time_ms:          0,
        flag_count:           0,
        flag_reasons:         {},
        helpful_pct:          null,
      };
    }

    const numOptions = q.options?.length ?? 4;

    // Difficulty index
    const correctCount = qAttempts.filter(a => a.is_correct).length;
    const difficulty_index = correctCount / total;

    // Discrimination index
    const topAttempts    = qAttempts.filter(a => topUserIds.has(a.user_id));
    const bottomAttempts = qAttempts.filter(a => bottomUserIds.has(a.user_id));
    const p_top    = topAttempts.length    > 0 ? topAttempts.filter(a => a.is_correct).length    / topAttempts.length    : 0;
    const p_bottom = bottomAttempts.length > 0 ? bottomAttempts.filter(a => a.is_correct).length / bottomAttempts.length : 0;
    const discrimination_index = p_top - p_bottom;

    // Option counts (skip -1 = skipped)
    const option_counts = Array(numOptions).fill(0) as number[];
    for (const a of qAttempts) {
      if (a.selected_option >= 0 && a.selected_option < numOptions) {
        option_counts[a.selected_option] = (option_counts[a.selected_option] ?? 0) + 1;
      }
    }

    // Average time
    const totalTime = qAttempts.reduce((sum, a) => sum + a.time_spent_ms, 0);
    const avg_time_ms = Math.round(totalTime / total);

    // Flags
    const flagged = qAttempts.filter(a => a.flag_reason != null);
    const flag_count = flagged.length;
    const flag_reasons: Partial<Record<AttemptFlagReason, number>> = {};
    for (const a of flagged) {
      const r = a.flag_reason as AttemptFlagReason;
      flag_reasons[r] = (flag_reasons[r] ?? 0) + 1;
    }

    // Helpful %
    const rated = qAttempts.filter(a => a.explanation_helpful != null);
    const helpfulCount = rated.filter(a => a.explanation_helpful === true).length;
    const helpful_pct = rated.length > 0 ? Math.round((helpfulCount / rated.length) * 100) : null;

    return {
      question_id:          q.id,
      stem:                 q.stem,
      level:                q.level as 1 | 2 | 3,
      concept_name:         q.concept_name ?? '',
      total_attempts:       total,
      difficulty_index,
      discrimination_index,
      option_counts,
      avg_time_ms,
      flag_count,
      flag_reasons,
      helpful_pct,
    };
  });

  // Default sort: flag_count descending, then difficulty (easiest first = potential ceiling effect)
  rows.sort((a, b) => b.flag_count - a.flag_count || a.difficulty_index - b.difficulty_index);

  return jsonOk(rows);
}
