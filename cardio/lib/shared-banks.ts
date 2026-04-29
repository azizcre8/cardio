import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/supabase';
import type { Deck, PDF, SharedBank } from '@/types';

type SourceClient = Pick<SupabaseClient, 'from'>;

export type SharedBankWithSources = SharedBank & {
  source_pdf: PDF | null;
  source_deck: Deck | null;
  source_pdfs: PDF[];
};

type DeckTreeRow = Pick<Deck, 'id' | 'parent_id' | 'name' | 'position'>;

function sortDeckRows(a: DeckTreeRow, b: DeckTreeRow) {
  return (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name);
}

export function slugifySharedBank(input: string) {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'bank';
}

export async function createUniqueSharedBankSlug(baseInput: string) {
  const base = slugifySharedBank(baseInput);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const { data, error } = await supabaseAdmin
      .from('shared_banks')
      .select('id')
      .eq('slug', slug)
      .maybeSingle();

    if (error) {
      throw new Error(`createUniqueSharedBankSlug: ${error.message}`);
    }

    if (!data) return slug;
  }

  return `${base}-${Date.now().toString(36)}`;
}

export async function getDeckAndDescendantIds(
  client: SourceClient,
  ownerUserId: string,
  rootDeckId: string,
) {
  const { data, error } = await client
    .from('decks')
    .select('id, parent_id, name, position')
    .eq('user_id', ownerUserId);

  if (error) throw new Error(`getDeckAndDescendantIds: ${error.message}`);

  const rows = ((data ?? []) as DeckTreeRow[]).sort(sortDeckRows);
  const byParentId = new Map<string | null, DeckTreeRow[]>();
  for (const row of rows) {
    const siblings = byParentId.get(row.parent_id) ?? [];
    siblings.push(row);
    byParentId.set(row.parent_id, siblings);
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  function visit(deckId: string) {
    if (seen.has(deckId)) return;
    seen.add(deckId);
    ids.push(deckId);
    for (const child of byParentId.get(deckId) ?? []) visit(child.id);
  }

  visit(rootDeckId);
  return ids;
}

async function getDeckAncestorIds(
  client: SourceClient,
  ownerUserId: string,
  deckId: string,
) {
  const { data, error } = await client
    .from('decks')
    .select('id, parent_id, name, position')
    .eq('user_id', ownerUserId);

  if (error) throw new Error(`getDeckAncestorIds: ${error.message}`);

  const byId = new Map(((data ?? []) as DeckTreeRow[]).map(deck => [deck.id, deck]));
  const ids: string[] = [];
  let currentId: string | null = deckId;
  const seen = new Set<string>();

  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    ids.push(currentId);
    currentId = byId.get(currentId)?.parent_id ?? null;
  }

  return ids;
}

export async function getSharedBankSources(
  client: SourceClient,
  bank: SharedBank,
): Promise<SharedBankWithSources> {
  if (bank.source_pdf_id) {
    const { data: sourcePdf, error } = await client
      .from('pdfs')
      .select('*')
      .eq('id', bank.source_pdf_id)
      .maybeSingle();

    if (error) throw new Error(`getSharedBankSources pdf: ${error.message}`);

    const pdf = (sourcePdf as PDF | null) ?? null;
    return {
      ...bank,
      source_pdf: pdf,
      source_deck: null,
      source_pdfs: pdf ? [pdf] : [],
    };
  }

  if (!bank.source_deck_id) {
    return { ...bank, source_pdf: null, source_deck: null, source_pdfs: [] };
  }

  const [{ data: sourceDeck, error: deckError }, deckIds] = await Promise.all([
    client.from('decks').select('*').eq('id', bank.source_deck_id).maybeSingle(),
    getDeckAndDescendantIds(client, bank.owner_user_id, bank.source_deck_id),
  ]);

  if (deckError) throw new Error(`getSharedBankSources deck: ${deckError.message}`);

  const { data: pdfRows, error: pdfError } = deckIds.length > 0
    ? await client
      .from('pdfs')
      .select('*')
      .eq('user_id', bank.owner_user_id)
      .in('deck_id', deckIds)
    : { data: [], error: null };

  if (pdfError) throw new Error(`getSharedBankSources deck pdfs: ${pdfError.message}`);

  const deckRank = new Map(deckIds.map((id, idx) => [id, idx]));
  const sourcePdfs = ((pdfRows ?? []) as PDF[]).sort((a, b) => {
    const deckDelta = (deckRank.get(a.deck_id ?? '') ?? Number.MAX_SAFE_INTEGER)
      - (deckRank.get(b.deck_id ?? '') ?? Number.MAX_SAFE_INTEGER);
    return deckDelta || (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name);
  });

  return {
    ...bank,
    source_pdf: null,
    source_deck: (sourceDeck as Deck | null) ?? null,
    source_pdfs: sourcePdfs,
  };
}

export async function attachSharedBankSources(
  client: SourceClient,
  banks: SharedBank[],
) {
  return Promise.all(banks.map(bank => getSharedBankSources(client, bank)));
}

export async function getAccessiblePdfForUser(
  pdfId: string,
  userId: string,
): Promise<{ pdf: PDF; access_scope: 'owned' | 'shared'; shared_bank: SharedBank | null } | null> {
  const { data: pdfRow, error: pdfError } = await supabaseAdmin
    .from('pdfs')
    .select('*')
    .eq('id', pdfId)
    .maybeSingle();

  if (pdfError) throw new Error(`getAccessiblePdfForUser pdf: ${pdfError.message}`);
  if (!pdfRow) return null;

  const pdf = pdfRow as PDF;
  if (pdf.user_id === userId) {
    return { pdf, access_scope: 'owned', shared_bank: null };
  }

  const { data: membershipRows, error: membershipError } = await supabaseAdmin
    .from('shared_bank_members')
    .select('shared_bank_id')
    .eq('user_id', userId);

  if (membershipError) throw new Error(`getAccessiblePdfForUser memberships: ${membershipError.message}`);

  const memberBankIds = new Set(
    ((membershipRows ?? []) as Array<{ shared_bank_id: string }>).map(row => row.shared_bank_id),
  );

  const directBanksPromise = supabaseAdmin
    .from('shared_banks')
    .select('*')
    .eq('owner_user_id', pdf.user_id)
    .eq('source_pdf_id', pdf.id)
    .eq('is_active', true);

  const ancestorDeckIds = pdf.deck_id
    ? await getDeckAncestorIds(supabaseAdmin, pdf.user_id, pdf.deck_id)
    : [];

  const [{ data: directBanks, error: directError }, { data: deckBanks, error: deckError }] = await Promise.all([
    directBanksPromise,
    ancestorDeckIds.length > 0
      ? supabaseAdmin
        .from('shared_banks')
        .select('*')
        .eq('owner_user_id', pdf.user_id)
        .eq('is_active', true)
        .in('source_deck_id', ancestorDeckIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (directError) throw new Error(`getAccessiblePdfForUser direct bank: ${directError.message}`);
  if (deckError) throw new Error(`getAccessiblePdfForUser deck bank: ${deckError.message}`);

  const sharedBank = ([...(directBanks ?? []), ...(deckBanks ?? [])] as SharedBank[]).find(bank =>
    bank.visibility === 'public' || memberBankIds.has(bank.id),
  ) ?? null;

  if (!sharedBank) return null;

  return { pdf, access_scope: 'shared', shared_bank: sharedBank };
}
