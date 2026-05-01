import { supabaseAdmin } from '@/lib/supabase';
import { getAccessiblePdfForUser, getDeckAndDescendantIds, getSharedBankSources } from '@/lib/shared-banks';
import type { Concept, PDF, Question, SRSState, SharedBank, StudyScopeType } from '@/types';

export type StudyScope =
  | { type: 'library' }
  | { type: 'deck'; id: string }
  | { type: 'pdf'; id: string };

export type QuestionBasic = Pick<Question, 'id' | 'pdf_id' | 'user_id'>;

function mapOwnedPdf(pdf: PDF): PDF {
  return {
    ...pdf,
    access_scope: 'owned',
    deck_id: pdf.deck_id,
    shared_bank_id: pdf.shared_bank_id ?? null,
    shared_bank_title: pdf.shared_bank_title ?? null,
    shared_bank_slug: pdf.shared_bank_slug ?? null,
    shared_bank_visibility: pdf.shared_bank_visibility ?? null,
    shared_bank_source_type: pdf.shared_bank_source_type ?? null,
  };
}

function mapSharedPdf(pdf: PDF, bank: SharedBank | null): PDF {
  return {
    ...pdf,
    access_scope: 'shared',
    deck_id: null,
    shared_bank_id: bank?.id ?? null,
    shared_bank_title: bank?.title ?? null,
    shared_bank_slug: bank?.slug ?? null,
    shared_bank_visibility: bank?.visibility ?? null,
    shared_bank_source_type: bank ? (bank.source_deck_id ? 'deck' : 'pdf') : null,
  };
}

export function getPdfDisplayName(pdf: PDF) {
  if (pdf.shared_bank_source_type !== 'deck' && pdf.shared_bank_title) {
    return pdf.shared_bank_title;
  }
  return pdf.display_name ?? pdf.name.replace(/\.pdf$/i, '');
}

export async function getVisiblePdfsForUser(userId: string): Promise<PDF[]> {
  const { data: ownedRows, error: ownedError } = await supabaseAdmin
    .from('pdfs')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (ownedError) throw new Error(`getVisiblePdfsForUser owned: ${ownedError.message}`);

  const ownedPdfs = ((ownedRows ?? []) as PDF[]).map(mapOwnedPdf);
  const ownedPdfIds = new Set(ownedPdfs.map(pdf => pdf.id));

  const { data: memberRows, error: memberError } = await supabaseAdmin
    .from('shared_bank_members')
    .select('shared_banks(id, source_pdf_id, source_deck_id, title, slug, visibility, is_active, owner_user_id)')
    .eq('user_id', userId)
    .eq('role', 'member');

  if (memberError) throw new Error(`getVisiblePdfsForUser shared memberships: ${memberError.message}`);

  const joinedBanks = ((memberRows ?? []) as Array<{ shared_banks: SharedBank | null }>)
    .map(row => row.shared_banks)
    .filter((bank): bank is SharedBank => bank !== null && bank.is_active);

  const joinedPdfBanks = joinedBanks.filter((bank): bank is SharedBank & { source_pdf_id: string } => !!bank.source_pdf_id);
  const joinedDeckBanks = joinedBanks.filter((bank): bank is SharedBank & { source_deck_id: string } => !!bank.source_deck_id);
  const joinedPdfIds = joinedPdfBanks
    .map(bank => bank.source_pdf_id)
    .filter((id): id is string => !!id && !ownedPdfIds.has(id));

  if (joinedPdfIds.length === 0 && joinedDeckBanks.length === 0) {
    return ownedPdfs;
  }

  const [{ data: joinedPdfRows, error: joinedPdfError }, joinedDeckSourceRows] = await Promise.all([
    joinedPdfIds.length > 0
      ? supabaseAdmin.from('pdfs').select('*').in('id', joinedPdfIds)
      : Promise.resolve({ data: [], error: null }),
    Promise.all(joinedDeckBanks.map(async bank => {
      const bankWithSources = await getSharedBankSources(supabaseAdmin, bank);
      return bankWithSources.source_pdfs.map(pdf => ({ pdf, bank }));
    })),
  ]);

  if (joinedPdfError) throw new Error(`getVisiblePdfsForUser shared pdfs: ${joinedPdfError.message}`);

  const bankBySourcePdfId = new Map(joinedPdfBanks.map(bank => [bank.source_pdf_id, bank]));
  const joinedPdfs = ((joinedPdfRows ?? []) as PDF[])
    .filter(pdf => !ownedPdfIds.has(pdf.id))
    .map(pdf => mapSharedPdf(pdf, bankBySourcePdfId.get(pdf.id) ?? null));

  const seenSharedPdfIds = new Set(joinedPdfs.map(pdf => pdf.id));
  const joinedDeckPdfs = joinedDeckSourceRows
    .flat()
    .filter(({ pdf }) => {
      if (ownedPdfIds.has(pdf.id) || seenSharedPdfIds.has(pdf.id)) return false;
      seenSharedPdfIds.add(pdf.id);
      return true;
    })
    .map(({ pdf, bank }) => mapSharedPdf(pdf, bank));

  return [...ownedPdfs, ...joinedPdfs, ...joinedDeckPdfs];
}

export async function getScopedPdfsForUser(userId: string, scope: StudyScope): Promise<PDF[] | null> {
  if (scope.type === 'library') return getVisiblePdfsForUser(userId);

  if (scope.type === 'pdf') {
    const access = await getAccessiblePdfForUser(scope.id, userId);
    if (!access) return null;
    return [access.access_scope === 'owned' ? mapOwnedPdf(access.pdf) : mapSharedPdf(access.pdf, access.shared_bank)];
  }

  const { data: deck, error: deckError } = await supabaseAdmin
    .from('decks')
    .select('id')
    .eq('id', scope.id)
    .eq('user_id', userId)
    .maybeSingle();

  if (deckError) throw new Error(`getScopedPdfsForUser deck: ${deckError.message}`);
  if (!deck) return null;

  const deckIds = await getDeckAndDescendantIds(supabaseAdmin, userId, scope.id);
  if (deckIds.length === 0) return [];

  const { data: pdfRows, error: pdfError } = await supabaseAdmin
    .from('pdfs')
    .select('*')
    .eq('user_id', userId)
    .in('deck_id', deckIds);

  if (pdfError) throw new Error(`getScopedPdfsForUser deck pdfs: ${pdfError.message}`);
  return ((pdfRows ?? []) as PDF[]).map(mapOwnedPdf);
}

export async function getQuestionsForScopedPdfs(pdfs: PDF[]): Promise<Question[]> {
  const pdfIds = pdfs.map(pdf => pdf.id);
  if (pdfIds.length === 0) return [];

  const ownerByPdfId = new Map(pdfs.map(pdf => [pdf.id, pdf.user_id]));
  const { data, error } = await supabaseAdmin
    .from('questions')
    .select('*')
    .in('pdf_id', pdfIds)
    .eq('flagged', false);

  if (error) throw new Error(`getQuestionsForScopedPdfs: ${error.message}`);

  return ((data ?? []) as Question[]).filter(question =>
    ownerByPdfId.get(question.pdf_id) === question.user_id,
  );
}

export async function getQuestionBasicsForScopedPdfs(pdfs: PDF[]): Promise<QuestionBasic[]> {
  const pdfIds = pdfs.map(pdf => pdf.id);
  if (pdfIds.length === 0) return [];

  const ownerByPdfId = new Map(pdfs.map(pdf => [pdf.id, pdf.user_id]));
  const { data, error } = await supabaseAdmin
    .from('questions')
    .select('id, pdf_id, user_id')
    .in('pdf_id', pdfIds)
    .eq('flagged', false);

  if (error) throw new Error(`getQuestionBasicsForScopedPdfs: ${error.message}`);

  return ((data ?? []) as QuestionBasic[]).filter(question =>
    ownerByPdfId.get(question.pdf_id) === question.user_id,
  );
}

export async function getConceptsForScopedPdfs(pdfs: PDF[]): Promise<Concept[]> {
  const pdfIds = pdfs.map(pdf => pdf.id);
  if (pdfIds.length === 0) return [];

  const ownerByPdfId = new Map(pdfs.map(pdf => [pdf.id, pdf.user_id]));
  const { data, error } = await supabaseAdmin
    .from('concepts')
    .select('*')
    .in('pdf_id', pdfIds);

  if (error) throw new Error(`getConceptsForScopedPdfs: ${error.message}`);

  return ((data ?? []) as Concept[]).filter(concept =>
    ownerByPdfId.get(concept.pdf_id) === concept.user_id,
  );
}

export async function getSrsForScopedPdfs(userId: string, pdfs: PDF[]): Promise<SRSState[]> {
  const pdfIds = pdfs.map(pdf => pdf.id);
  if (pdfIds.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from('srs_state')
    .select('*')
    .eq('user_id', userId)
    .in('pdf_id', pdfIds);

  if (error) throw new Error(`getSrsForScopedPdfs: ${error.message}`);
  return (data ?? []) as SRSState[];
}

export function mergeQuestionsWithSrs(questions: Question[], srsRows: SRSState[]): Question[] {
  const srsMap = new Map(srsRows.map(row => [row.question_id, row]));

  return questions.map(question => {
    const srs = srsMap.get(question.id);
    if (!srs) return question;

    return {
      ...question,
      interval: srs.interval,
      ease_factor: srs.ease_factor,
      repetitions: srs.repetitions,
      next_review: srs.next_review,
      last_reviewed: srs.last_reviewed,
      times_reviewed: srs.times_reviewed,
      times_correct: srs.times_correct,
      times_incorrect: srs.times_incorrect,
      quality_history: srs.quality_history,
    };
  });
}

export function parseStudyScope(scopeParam: string | null, id: string | null): StudyScope | null {
  const scope = (scopeParam ?? 'library') as StudyScopeType;
  if (scope === 'library') return { type: 'library' };
  if ((scope === 'deck' || scope === 'pdf') && id) return { type: scope, id };
  return null;
}
