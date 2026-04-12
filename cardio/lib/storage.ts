/**
 * Async Supabase data access layer — mirrors the `S` localStorage API from the HTML app.
 * All server-side code uses supabaseAdmin; client-side reads use supabaseBrowser.
 */

import { supabaseAdmin } from '@/lib/supabase';
import type { PDF, Concept, Chunk, Question, SRSState, Review, ChunkRecord, UserProfile } from '@/types';

// ─── PDFs ────────────────────────────────────────────────────────────────────

export async function getPDFs(userId: string): Promise<PDF[]> {
  const { data, error } = await supabaseAdmin
    .from('pdfs')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`getPDFs: ${error.message}`);
  return (data ?? []) as PDF[];
}

export async function insertPDF(pdf: Omit<PDF, 'id' | 'created_at'>): Promise<PDF> {
  const { data, error } = await supabaseAdmin
    .from('pdfs')
    .insert(pdf)
    .select()
    .single();
  if (error) throw new Error(`insertPDF: ${error.message}`);
  return data as PDF;
}

export async function updatePDF(id: string, patch: Partial<PDF>): Promise<void> {
  const { error } = await supabaseAdmin.from('pdfs').update(patch).eq('id', id);
  if (error) throw new Error(`updatePDF: ${error.message}`);
}

export async function deletePDF(id: string): Promise<void> {
  const { error } = await supabaseAdmin.from('pdfs').delete().eq('id', id);
  if (error) throw new Error(`deletePDF: ${error.message}`);
}

// ─── Chunks ───────────────────────────────────────────────────────────────────

export async function insertChunks(chunks: Omit<Chunk, 'created_at'>[]): Promise<void> {
  // Bulk insert in batches of 200 to avoid request-size limits
  const BATCH = 200;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const { error } = await supabaseAdmin.from('chunks').insert(chunks.slice(i, i + BATCH));
    if (error) throw new Error(`insertChunks batch ${i}: ${error.message}`);
  }
}

export async function getChunks(pdfId: string): Promise<ChunkRecord[]> {
  const { data, error } = await supabaseAdmin
    .from('chunks')
    .select('id, pdf_id, text, start_page, end_page, headers, word_count, embedding')
    .eq('pdf_id', pdfId);
  if (error) throw new Error(`getChunks: ${error.message}`);
  return (data ?? []).map((r: Record<string, unknown>) => ({
    id:         r.id as string,
    pdf_id:     r.pdf_id as string,
    text:       r.text as string,
    start_page: r.start_page as number,
    end_page:   r.end_page as number,
    headers:    r.headers as string[],
    word_count: r.word_count as number,
    embedding:  (r.embedding as number[]) ?? [],
  }));
}

// ─── Concepts ─────────────────────────────────────────────────────────────────

export async function insertConcepts(
  concepts: Omit<Concept, 'id' | 'created_at'>[],
): Promise<Concept[]> {
  const { data, error } = await supabaseAdmin
    .from('concepts')
    .insert(concepts)
    .select();
  if (error) throw new Error(`insertConcepts: ${error.message}`);
  return (data ?? []) as Concept[];
}

export async function getConcepts(pdfId: string): Promise<Concept[]> {
  const { data, error } = await supabaseAdmin
    .from('concepts')
    .select('*')
    .eq('pdf_id', pdfId);
  if (error) throw new Error(`getConcepts: ${error.message}`);
  return (data ?? []) as Concept[];
}

// ─── Questions ───────────────────────────────────────────────────────────────

export async function insertQuestions(
  questions: Omit<Question, 'id' | 'created_at'>[],
): Promise<Question[]> {
  const BATCH = 100;
  const all: Question[] = [];
  for (let i = 0; i < questions.length; i += BATCH) {
    const { data, error } = await supabaseAdmin
      .from('questions')
      .insert(questions.slice(i, i + BATCH))
      .select();
    if (error) throw new Error(`insertQuestions batch ${i}: ${error.message}`);
    all.push(...((data ?? []) as Question[]));
  }
  return all;
}

export async function getQuestions(pdfId: string): Promise<Question[]> {
  const { data, error } = await supabaseAdmin
    .from('questions')
    .select('*')
    .eq('pdf_id', pdfId);
  if (error) throw new Error(`getQuestions: ${error.message}`);
  return (data ?? []) as Question[];
}

/** Merge SRS state rows onto question objects (used by /api/study/queue). */
export async function getQuestionsWithSRS(
  pdfId:  string,
  userId: string,
): Promise<Question[]> {
  const [questions, srsRows] = await Promise.all([
    getQuestions(pdfId),
    getSRSStates(pdfId, userId),
  ]);

  const srsMap = new Map(srsRows.map(s => [s.question_id, s]));

  return questions.map(q => {
    const s = srsMap.get(q.id);
    if (!s) return q;
    return {
      ...q,
      interval:        s.interval,
      ease_factor:     s.ease_factor,
      repetitions:     s.repetitions,
      next_review:     s.next_review,
      last_reviewed:   s.last_reviewed,
      times_reviewed:  s.times_reviewed,
      times_correct:   s.times_correct,
      times_incorrect: s.times_incorrect,
      quality_history: s.quality_history,
    };
  });
}

// ─── SRS State ───────────────────────────────────────────────────────────────

export async function getSRSStates(pdfId: string, userId: string): Promise<SRSState[]> {
  const { data, error } = await supabaseAdmin
    .from('srs_state')
    .select('*')
    .eq('pdf_id', pdfId)
    .eq('user_id', userId);
  if (error) throw new Error(`getSRSStates: ${error.message}`);
  return (data ?? []) as SRSState[];
}

export async function upsertSRSState(state: Omit<SRSState, 'id' | 'updated_at'>): Promise<void> {
  const { error } = await supabaseAdmin
    .from('srs_state')
    .upsert({ ...state, updated_at: new Date().toISOString() }, {
      onConflict: 'user_id,question_id',
    });
  if (error) throw new Error(`upsertSRSState: ${error.message}`);
}

// ─── Reviews ──────────────────────────────────────────────────────────────────

export async function insertReview(review: Omit<Review, 'id' | 'reviewed_at'>): Promise<void> {
  const { error } = await supabaseAdmin.from('reviews').insert(review);
  if (error) throw new Error(`insertReview: ${error.message}`);
}

// ─── User Profile ─────────────────────────────────────────────────────────────

export async function getUserProfile(userId: string): Promise<UserProfile | null> {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('id', userId)
    .single();
  if (error) return null;
  return data as UserProfile;
}

export async function updateUserProfile(userId: string, patch: Partial<UserProfile>): Promise<void> {
  const { error } = await supabaseAdmin.from('users').update(patch).eq('id', userId);
  if (error) throw new Error(`updateUserProfile: ${error.message}`);
}

/**
 * Check and reset monthly PDF counter if we're in a new month.
 * Returns the current count AFTER potential reset.
 */
export async function getAndMaybeResetMonthlyCount(userId: string): Promise<number> {
  const profile = await getUserProfile(userId);
  if (!profile) throw new Error('User profile not found');

  const now = new Date();
  const resetAt = new Date(profile.month_reset_at);

  if (now.getFullYear() > resetAt.getFullYear() || now.getMonth() > resetAt.getMonth()) {
    // New month — reset counter
    await updateUserProfile(userId, {
      pdfs_this_month: 0,
      month_reset_at: now.toISOString(),
    });
    return 0;
  }

  return profile.pdfs_this_month;
}

export async function incrementMonthlyCount(userId: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc('increment_pdfs_this_month', { uid: userId });
  if (error) {
    // Fallback: manual increment if RPC not defined
    const profile = await getUserProfile(userId);
    if (profile) {
      await updateUserProfile(userId, {
        pdfs_this_month: (profile.pdfs_this_month ?? 0) + 1,
      });
    }
  }
}

// ─── Flagged questions ────────────────────────────────────────────────────────

export async function insertFlaggedQuestion(entry: {
  pdf_id:      string;
  user_id:     string;
  question_id: string | null;
  reason:      string;
  raw_json:    Record<string, unknown> | null;
}): Promise<void> {
  const { error } = await supabaseAdmin.from('flagged_questions').insert(entry);
  if (error) throw new Error(`insertFlaggedQuestion: ${error.message}`);
}
