import { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { jsonBadRequest, jsonError, jsonOk, parseJsonBody } from '@/lib/api';
import {
  attachSharedBankSources,
  createUniqueSharedBankSlug,
  getDeckAndDescendantIds,
  getSharedBankSources,
  type SharedBankWithSources,
} from '@/lib/shared-banks';
import { supabaseAdmin } from '@/lib/supabase';
import type { Deck, PDF, SharedBank, SharedBankVisibility } from '@/types';

type PublishSharedBankBody = {
  deckId?: string;
  pdfId?: string;
  title?: string;
  description?: string | null;
  visibility?: SharedBankVisibility;
};

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const [{ data: ownedRows, error: ownedError }, { data: membershipRows, error: membershipError }] = await Promise.all([
    auth.supabase
      .from('shared_banks')
      .select('*')
      .eq('owner_user_id', auth.userId)
      .order('created_at', { ascending: false }),
    auth.supabase
      .from('shared_bank_members')
      .select('role, joined_at, shared_banks(*)')
      .eq('user_id', auth.userId)
      .order('joined_at', { ascending: false }),
  ]);

  if (ownedError) return jsonError(ownedError.message);
  if (membershipError) return jsonError(membershipError.message);

  const owned = (ownedRows ?? []) as SharedBank[];
  const joined = ((membershipRows ?? []) as Record<string, unknown>[])
    .map((row: Record<string, unknown>): SharedBank | null => {
      const bank = row.shared_banks as SharedBank | null;
      if (!bank || bank.owner_user_id === auth.userId) return null;
      return {
        ...bank,
        membership_role: (row.role as SharedBank['membership_role']) ?? 'member',
        membership_joined_at: (row.joined_at as string | null) ?? null,
      };
    })
    .filter((bank): bank is SharedBank => bank !== null);

  return jsonOk({
    owned: await attachSharedBankSources(supabaseAdmin, owned),
    joined: await attachSharedBankSources(supabaseAdmin, joined),
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const parsed = await parseJsonBody<PublishSharedBankBody>(req);
  if (!parsed.ok) return parsed.response;

  const body = parsed.data;
  const deckId = body.deckId?.trim();
  const pdfId = body.pdfId?.trim();
  if ((!pdfId && !deckId) || (pdfId && deckId)) return jsonBadRequest('Provide exactly one of pdfId or deckId');

  const visibility = body.visibility ?? 'public';
  if (!['private', 'invite_only', 'public'].includes(visibility)) {
    return jsonBadRequest('visibility must be private, invite_only, or public');
  }

  if (deckId) {
    const { data: deckRow, error: deckError } = await auth.supabase
      .from('decks')
      .select('*')
      .eq('id', deckId)
      .eq('user_id', auth.userId)
      .single();

    if (deckError || !deckRow) return jsonBadRequest('Deck not found');

    const deckIds = await getDeckAndDescendantIds(supabaseAdmin, auth.userId, deckId);
    const { data: deckPdfRows, error: deckPdfsError } = deckIds.length > 0
      ? await supabaseAdmin
        .from('pdfs')
        .select('*')
        .in('deck_id', deckIds)
        .eq('user_id', auth.userId)
      : { data: [], error: null };

    if (deckPdfsError) return jsonError(deckPdfsError.message);

    const deckRank = new Map(deckIds.map((id, idx) => [id, idx]));
    const sourcePdfs = ((deckPdfRows ?? []) as PDF[]).sort((a, b) => {
      const deckDelta = (deckRank.get(a.deck_id ?? '') ?? Number.MAX_SAFE_INTEGER)
        - (deckRank.get(b.deck_id ?? '') ?? Number.MAX_SAFE_INTEGER);
      return deckDelta || (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name);
    });
    if (!sourcePdfs.some(pdf => !!pdf.processed_at)) {
      return jsonBadRequest('Folder must contain at least one processed PDF before it can be published');
    }

    const defaultTitle = (deckRow as Deck).name;
    const title = (body.title?.trim() || defaultTitle).slice(0, 120);
    const description = body.description?.trim() || null;

    const { data: existingRow, error: existingError } = await auth.supabase
      .from('shared_banks')
      .select('*')
      .eq('owner_user_id', auth.userId)
      .eq('source_deck_id', deckId)
      .maybeSingle();

    if (existingError) return jsonError(existingError.message);

    let bank: SharedBank;

    if (existingRow) {
      const { data: updatedRow, error: updateError } = await auth.supabase
        .from('shared_banks')
        .update({
          title,
          description,
          visibility,
          is_active: true,
          published_at: existingRow.published_at ?? new Date().toISOString(),
        })
        .eq('id', existingRow.id)
        .select('*')
        .single();

      if (updateError || !updatedRow) return jsonError(updateError?.message ?? 'Failed to update shared bank');
      bank = updatedRow as SharedBank;
    } else {
      const slug = await createUniqueSharedBankSlug(title);
      const { data: insertedRow, error: insertError } = await auth.supabase
        .from('shared_banks')
        .insert({
          owner_user_id: auth.userId,
          source_pdf_id: null,
          source_deck_id: deckId,
          title,
          description,
          slug,
          visibility,
          is_active: true,
          published_at: new Date().toISOString(),
        })
        .select('*')
        .single();

      if (insertError || !insertedRow) return jsonError(insertError?.message ?? 'Failed to publish shared bank');
      bank = insertedRow as SharedBank;
    }

    const origin = req.nextUrl.origin;

    return jsonOk({
      bank: {
        ...bank,
        source_pdf: null,
        source_deck: deckRow as Deck,
        source_pdfs: sourcePdfs,
      } satisfies SharedBankWithSources,
      shareUrl: `${origin}/s/${bank.slug}`,
    });
  }

  const { data: pdfRow, error: pdfError } = await auth.supabase
    .from('pdfs')
    .select('*')
    .eq('id', pdfId)
    .eq('user_id', auth.userId)
    .single();

  if (pdfError || !pdfRow) return jsonBadRequest('PDF not found');
  if (!pdfRow.processed_at) return jsonBadRequest('PDF must finish processing before it can be published');

  const defaultTitle = pdfRow.display_name ?? pdfRow.name.replace(/\.pdf$/i, '');
  const title = (body.title?.trim() || defaultTitle).slice(0, 120);
  const description = body.description?.trim() || null;

  const { data: existingRow, error: existingError } = await auth.supabase
    .from('shared_banks')
    .select('*')
    .eq('owner_user_id', auth.userId)
    .eq('source_pdf_id', pdfId)
    .maybeSingle();

  if (existingError) return jsonError(existingError.message);

  let bank: SharedBank;

  if (existingRow) {
    const { data: updatedRow, error: updateError } = await auth.supabase
      .from('shared_banks')
      .update({
        title,
        description,
        visibility,
        is_active: true,
        published_at: existingRow.published_at ?? new Date().toISOString(),
      })
      .eq('id', existingRow.id)
      .select('*')
      .single();

    if (updateError || !updatedRow) return jsonError(updateError?.message ?? 'Failed to update shared bank');
    bank = updatedRow as SharedBank;
  } else {
    const slug = await createUniqueSharedBankSlug(title);
    const { data: insertedRow, error: insertError } = await auth.supabase
      .from('shared_banks')
      .insert({
        owner_user_id: auth.userId,
        source_pdf_id: pdfId,
        source_deck_id: null,
        title,
        description,
        slug,
        visibility,
        is_active: true,
        published_at: new Date().toISOString(),
      })
      .select('*')
      .single();

    if (insertError || !insertedRow) return jsonError(insertError?.message ?? 'Failed to publish shared bank');
    bank = insertedRow as SharedBank;
  }

  const origin = req.nextUrl.origin;

  return jsonOk({
    bank: await getSharedBankSources(supabaseAdmin, bank),
    shareUrl: `${origin}/s/${bank.slug}`,
  });
}
