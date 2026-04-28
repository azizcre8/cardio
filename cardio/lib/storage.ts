/**
 * Async Supabase data access layer — mirrors the `S` localStorage API from the HTML app.
 * All server-side code uses supabaseAdmin; client-side reads use supabaseBrowser.
 */

import { supabaseAdmin } from '@/lib/supabase';
import type {
  PDF,
  Deck,
  Concept,
  Chunk,
  Question,
  SRSState,
  Review,
  ChunkRecord,
  UserProfile,
  SharedBank,
  SharedBankMember,
  QuestionAttempt,
  WaitlistSubmission,
  AllQuestionRow,
  FlaggedQuestionRow,
  FactCheckResult,
} from '@/types';

// ─── Decks ───────────────────────────────────────────────────────────────────

/** Fetch all decks for a user. Tries the recursive CTE RPC first; falls back to a
 *  flat table query if the function hasn't been deployed yet; returns [] if the
 *  decks table itself is missing (migration 004 not yet applied). */
export async function getDecks(userId: string): Promise<Deck[]> {
  const { data, error } = await supabaseAdmin.rpc('get_deck_tree', { p_user_id: userId });
  if (!error) return (data ?? []) as Deck[];

  // RPC not available yet — fall back to direct table query
  const { data: rows, error: tableError } = await supabaseAdmin
    .from('decks')
    .select('*')
    .eq('user_id', userId)
    .order('position', { ascending: true });
  if (!tableError) return (rows ?? []) as Deck[];

  // Decks table doesn't exist yet (migration 004 pending) — degrade gracefully
  return [];
}

export async function insertDeck(
  deck: Pick<Deck, 'user_id' | 'parent_id' | 'name' | 'is_exam_block' | 'due_date' | 'position'>,
): Promise<Deck> {
  const { data, error } = await supabaseAdmin
    .from('decks')
    .insert({ ...deck, updated_at: new Date().toISOString() })
    .select()
    .single();
  if (error) throw new Error(`insertDeck: ${error.message}`);
  return data as Deck;
}

export async function updateDeck(id: string, patch: Partial<Omit<Deck, 'id' | 'user_id' | 'created_at'>>): Promise<void> {
  const { error } = await supabaseAdmin
    .from('decks')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(`updateDeck: ${error.message}`);
}

export async function deleteDeck(id: string): Promise<void> {
  // Children have parent_id SET NULL via FK cascade — they become root decks.
  // PDFs have deck_id SET NULL — they become uncategorized.
  const { error } = await supabaseAdmin.from('decks').delete().eq('id', id);
  if (error) throw new Error(`deleteDeck: ${error.message}`);
}

/**
 * Walk up the deck ancestry of a PDF and return the nearest exam-block due_date.
 * Returns null if the PDF has no deck or no exam-block ancestor.
 */
export async function getExamDeadlineForPdf(pdfId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.rpc('get_exam_deadline_for_pdf', { p_pdf_id: pdfId });
  if (error) return null; // gracefully degrade if RPC not yet deployed
  return (data as string | null) ?? null;
}

/** Return the next available position among siblings of parentId (or root). */
export async function nextDeckPosition(userId: string, parentId: string | null): Promise<number> {
  const query = supabaseAdmin
    .from('decks')
    .select('position')
    .eq('user_id', userId)
    .order('position', { ascending: false })
    .limit(1);

  const { data } = parentId
    ? await query.eq('parent_id', parentId)
    : await query.is('parent_id', null);

  return data && data.length > 0 ? (data[0].position as number) + 1 : 0;
}

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

  if (!error) return data as PDF;

  // Older databases may not have deck/display metadata yet. Retry with the
  // legacy pdfs shape so uploads still work before migration 004 is applied.
  if (error.message.includes('display_name') || error.message.includes('deck_id') || error.message.includes('position')) {
    const legacyInsert = {
      user_id: pdf.user_id,
      name: pdf.name,
      page_count: pdf.page_count,
      density: pdf.density,
      processed_at: pdf.processed_at,
      processing_cost_usd: pdf.processing_cost_usd,
      concept_count: pdf.concept_count,
      question_count: pdf.question_count,
    };

    const retry = await supabaseAdmin
      .from('pdfs')
      .insert(legacyInsert)
      .select()
      .single();

    if (retry.error) throw new Error(`insertPDF: ${retry.error.message}`);
    return {
      ...(retry.data as PDF),
      deck_id: null,
      display_name: null,
      position: 0,
    };
  }

  throw new Error(`insertPDF: ${error.message}`);
}

export async function updatePDF(id: string, patch: Partial<PDF>): Promise<void> {
  const { error } = await supabaseAdmin.from('pdfs').update(patch).eq('id', id);
  if (!error) return;

  if (error.message.includes('display_name') || error.message.includes('deck_id') || error.message.includes('position')) {
    const legacyPatch: Record<string, unknown> = { ...patch };
    delete legacyPatch.deck_id;
    delete legacyPatch.display_name;
    delete legacyPatch.position;

    const retry = await supabaseAdmin.from('pdfs').update(legacyPatch).eq('id', id);
    if (retry.error) throw new Error(`updatePDF: ${retry.error.message}`);
    return;
  }

  throw new Error(`updatePDF: ${error.message}`);
}

export async function deletePDF(id: string): Promise<void> {
  const { error } = await supabaseAdmin.from('pdfs').delete().eq('id', id);
  if (error) throw new Error(`deletePDF: ${error.message}`);
}

export async function getPDF(pdfId: string, userId: string): Promise<PDF | null> {
  const { data, error } = await supabaseAdmin
    .from('pdfs')
    .select('*')
    .eq('id', pdfId)
    .eq('user_id', userId)
    .single();
  if (error) return null;
  return data as PDF;
}

// ─── Shared Banks ────────────────────────────────────────────────────────────

export async function getOwnedSharedBanks(ownerUserId: string): Promise<SharedBank[]> {
  const { data, error } = await supabaseAdmin
    .from('shared_banks')
    .select('*')
    .eq('owner_user_id', ownerUserId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`getOwnedSharedBanks: ${error.message}`);
  return (data ?? []) as SharedBank[];
}

export async function getJoinedSharedBanks(userId: string): Promise<SharedBank[]> {
  const { data, error } = await supabaseAdmin
    .from('shared_bank_members')
    .select('shared_banks(*)')
    .eq('user_id', userId)
    .order('joined_at', { ascending: false });
  if (error) throw new Error(`getJoinedSharedBanks: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[])
    .map((row: Record<string, unknown>) => row.shared_banks as SharedBank | null)
    .filter((bank): bank is SharedBank => bank !== null);
}

export async function getSharedBankById(id: string): Promise<SharedBank | null> {
  const { data, error } = await supabaseAdmin
    .from('shared_banks')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`getSharedBankById: ${error.message}`);
  return (data as SharedBank | null) ?? null;
}

export async function getSharedBankBySlug(slug: string): Promise<SharedBank | null> {
  const { data, error } = await supabaseAdmin
    .from('shared_banks')
    .select('*')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw new Error(`getSharedBankBySlug: ${error.message}`);
  return (data as SharedBank | null) ?? null;
}

export async function insertSharedBank(
  bank: Pick<SharedBank, 'owner_user_id' | 'source_pdf_id' | 'title' | 'description' | 'slug' | 'visibility'>
    & Partial<Pick<SharedBank, 'is_active' | 'published_at'>>,
): Promise<SharedBank> {
  const { data, error } = await supabaseAdmin
    .from('shared_banks')
    .insert({
      ...bank,
      is_active: bank.is_active ?? true,
      published_at: bank.published_at ?? new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw new Error(`insertSharedBank: ${error.message}`);
  return data as SharedBank;
}

export async function updateSharedBank(
  id: string,
  patch: Partial<Omit<SharedBank, 'id' | 'owner_user_id' | 'source_pdf_id' | 'created_at' | 'updated_at'>>,
): Promise<void> {
  const { error } = await supabaseAdmin.from('shared_banks').update(patch).eq('id', id);
  if (error) throw new Error(`updateSharedBank: ${error.message}`);
}

export async function getSharedBankMembers(sharedBankId: string): Promise<SharedBankMember[]> {
  const { data, error } = await supabaseAdmin
    .from('shared_bank_members')
    .select('*')
    .eq('shared_bank_id', sharedBankId)
    .order('joined_at', { ascending: true });
  if (error) throw new Error(`getSharedBankMembers: ${error.message}`);
  return (data ?? []) as SharedBankMember[];
}

export async function addSharedBankMember(
  sharedBankId: string,
  userId: string,
  role: SharedBankMember['role'] = 'member',
): Promise<SharedBankMember> {
  const { data, error } = await supabaseAdmin
    .from('shared_bank_members')
    .upsert(
      {
        shared_bank_id: sharedBankId,
        user_id: userId,
        role,
      },
      { onConflict: 'shared_bank_id,user_id' },
    )
    .select()
    .single();
  if (error) throw new Error(`addSharedBankMember: ${error.message}`);
  return data as SharedBankMember;
}

export async function removeSharedBankMember(sharedBankId: string, userId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('shared_bank_members')
    .delete()
    .eq('shared_bank_id', sharedBankId)
    .eq('user_id', userId);
  if (error) throw new Error(`removeSharedBankMember: ${error.message}`);
}

// ─── Chunks ───────────────────────────────────────────────────────────────────

export async function insertChunks(chunks: Omit<Chunk, 'created_at'>[]): Promise<void> {
  // Bulk insert in batches of 200 to avoid request-size limits
  const BATCH = 200;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const normalizedBatch = chunks.slice(i, i + BATCH).map(chunk => ({
      ...chunk,
      embedding: Array.isArray(chunk.embedding) && chunk.embedding.length > 0
        ? chunk.embedding
        : null,
    }));
    const { error } = await supabaseAdmin.from('chunks').insert(normalizedBatch);
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
    let batch = questions.slice(i, i + BATCH).map(question => ({ ...question })) as Array<Record<string, unknown>>;
    let lastError: string | null = null;

    // Older databases may be missing newer optional columns. Strip unsupported
    // fields progressively so generation can finish before every migration is applied.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const { data, error } = await supabaseAdmin
        .from('questions')
        .insert(batch)
        .select();

      if (!error) {
        all.push(...((data ?? []) as Question[]));
        lastError = null;
        break;
      }

      lastError = error.message;
      const missingColumn = error.message.match(/Could not find the '([^']+)' column of 'questions'/)?.[1];
      if (!missingColumn) break;

      console.error(`insertQuestions: dropping unsupported column '${missingColumn}' from insert payload`);
      batch = batch.map(question => {
        const next = { ...question };
        delete next[missingColumn];
        return next;
      });
    }

    if (lastError) throw new Error(`insertQuestions batch ${i}: ${lastError}`);
  }
  return all;
}

export async function getQuestions(pdfId: string): Promise<Question[]> {
  const { data, error } = await supabaseAdmin
    .from('questions')
    .select('*')
    .eq('pdf_id', pdfId)
    .eq('flagged', false);
  if (error) throw new Error(`getQuestions: ${error.message}`);
  return (data ?? []) as Question[];
}

export async function getQuestionForUser(questionId: string, userId: string): Promise<Question | null> {
  const { data, error } = await supabaseAdmin
    .from('questions')
    .select('*')
    .eq('id', questionId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`getQuestionForUser: ${error.message}`);
  return (data as Question | null) ?? null;
}

export async function getAllQuestionsForUser(userId: string): Promise<AllQuestionRow[]> {
  const { data, error } = await supabaseAdmin
    .from('questions')
    .select('id, pdf_id, stem, options, answer, explanation, level, flagged, flag_reason, pdfs!inner(name, display_name)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`getAllQuestionsForUser: ${error.message}`);

  return ((data ?? []) as Array<Record<string, unknown>>).map(row => {
    const options = (row.options as string[]) ?? [];
    const answer = Number(row.answer ?? 0);
    const pdf = row.pdfs as { name?: string | null; display_name?: string | null } | null;
    return {
      id: row.id as string,
      pdf_id: row.pdf_id as string,
      stem: row.stem as string,
      options,
      answer,
      answer_text: options[answer] ?? '',
      explanation: (row.explanation as string) ?? '',
      level: row.level as AllQuestionRow['level'],
      flagged: Boolean(row.flagged),
      flag_reason: (row.flag_reason as string | null) ?? null,
      pdf_name: pdf?.display_name ?? pdf?.name?.replace(/\.pdf$/i, '') ?? 'Untitled source',
    };
  });
}

export async function getFlaggedQuestionsForUser(userId: string): Promise<FlaggedQuestionRow[]> {
  const [{ data: flaggedRows, error: flaggedError }, { data: srsRows, error: srsError }] = await Promise.all([
    supabaseAdmin
      .from('questions')
      .select('id, pdf_id, stem, options, answer, level, flag_reason, pdfs!inner(name, display_name)')
      .eq('user_id', userId)
      .eq('flagged', true),
    supabaseAdmin
      .from('srs_state')
      .select('question_id, pdf_id, questions!inner(id, stem, options, answer, level, flag_reason, pdfs!inner(name, display_name))')
      .eq('user_id', userId)
      .contains('quality_history', [1]),
  ]);
  if (flaggedError) throw new Error(`getFlaggedQuestionsForUser flagged: ${flaggedError.message}`);
  if (srsError) throw new Error(`getFlaggedQuestionsForUser srs: ${srsError.message}`);

  const rows: FlaggedQuestionRow[] = [];
  const seen = new Set<string>();

  function pushQuestion(row: Record<string, unknown>, source: FlaggedQuestionRow['source'], reason: string | null) {
    const id = row.id as string;
    if (!id || seen.has(`${source}:${id}`)) return;
    seen.add(`${source}:${id}`);
    const options = (row.options as string[]) ?? [];
    const answer = Number(row.answer ?? 0);
    const pdf = row.pdfs as { name?: string | null; display_name?: string | null } | null;
    rows.push({
      question_id: id,
      pdf_id: row.pdf_id as string,
      stem: row.stem as string,
      answer_text: options[answer] ?? '',
      level: row.level as FlaggedQuestionRow['level'],
      pdf_name: pdf?.display_name ?? pdf?.name?.replace(/\.pdf$/i, '') ?? 'Untitled source',
      flag_reason: reason,
      source,
    });
  }

  for (const row of (flaggedRows ?? []) as Array<Record<string, unknown>>) {
    pushQuestion(row, 'question_flag', (row.flag_reason as string | null) ?? 'Flagged during generation');
  }
  for (const row of (srsRows ?? []) as Array<Record<string, unknown>>) {
    const question = row.questions as Record<string, unknown> | null;
    if (question) pushQuestion({ ...question, pdf_id: row.pdf_id }, 'srs_quality', 'Marked Again in study');
  }

  return rows;
}

export async function unflagQuestionForUser(questionId: string, userId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('questions')
    .update({ flagged: false, flag_reason: null })
    .eq('id', questionId)
    .eq('user_id', userId);
  if (error) throw new Error(`unflagQuestionForUser: ${error.message}`);
}

export async function checkPdfHasConcepts(pdfId: string): Promise<boolean> {
  const { count, error } = await supabaseAdmin
    .from('concepts')
    .select('id', { count: 'exact', head: true })
    .eq('pdf_id', pdfId);
  if (error) throw new Error(`checkPdfHasConcepts: ${error.message}`);
  return (count ?? 0) > 0;
}

export async function createWaitlistSubmission(entry: {
  user_id: string;
  email: string;
  use_case: string;
}): Promise<WaitlistSubmission> {
  const { data, error } = await supabaseAdmin
    .from('waitlist')
    .insert(entry)
    .select()
    .single();
  if (error) throw new Error(`createWaitlistSubmission: ${error.message}`);
  return data as WaitlistSubmission;
}

export async function factCheckQuestionForUser(questionId: string, userId: string): Promise<FactCheckResult | null> {
  const question = await getQuestionForUser(questionId, userId);
  if (!question) return null;
  const evidence = [
    question.source_quote,
    question.chunk_id,
    question.evidence_match_type && question.evidence_match_type !== 'none' ? question.evidence_match_type : '',
  ].filter(Boolean).join(' ').trim();

  return {
    medicallyAccurate: !question.flagged && !((question.option_set_flags ?? []).length > 0),
    sourcedFromText: evidence.length > 0 && question.source_quote !== 'UNGROUNDED',
  };
}

export async function deleteQuestions(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const BATCH = 100;
  for (let i = 0; i < ids.length; i += BATCH) {
    const { error } = await supabaseAdmin
      .from('questions')
      .delete()
      .in('id', ids.slice(i, i + BATCH));
    if (error) throw new Error(`deleteQuestions: ${error.message}`);
  }
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

export async function ensureUserProfile(userId: string, email: string): Promise<void> {
  const normalizedEmail = email.trim() || `${userId}@local.invalid`;
  const { error } = await supabaseAdmin
    .from('users')
    .upsert(
      {
        id: userId,
        email: normalizedEmail,
      },
      { onConflict: 'id' },
    );
  if (error) throw new Error(`ensureUserProfile: ${error.message}`);
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
  const nowYearMonth = now.getFullYear() * 12 + now.getMonth();
  const resetYearMonth = resetAt.getFullYear() * 12 + resetAt.getMonth();

  if (nowYearMonth > resetYearMonth) {
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

// ─── Question Attempts ────────────────────────────────────────────────────────

export async function insertQuestionAttempt(
  attempt: Omit<QuestionAttempt, 'id' | 'created_at'>,
): Promise<void> {
  const { error } = await supabaseAdmin.from('question_attempts').insert(attempt);
  if (error) throw new Error(`insertQuestionAttempt: ${error.message}`);
}

export async function getQuestionAttemptsForPdf(pdfId: string) {
  const { data, error } = await supabaseAdmin
    .from('question_attempts')
    .select('question_id, user_id, selected_option, is_correct, time_spent_ms, explanation_helpful, flag_reason')
    .eq('pdf_id', pdfId);
  if (error) throw new Error(`getQuestionAttemptsForPdf: ${error.message}`);
  return data ?? [];
}
