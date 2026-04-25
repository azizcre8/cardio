/**
 * GET /api/pdfs — list all PDFs visible to the authenticated user
 * Includes owned PDFs and PDFs from shared banks the user has joined.
 */

import { requireUser } from '@/lib/auth';
import { jsonOk } from '@/lib/api';
import { supabaseAdmin } from '@/lib/supabase';
import type { PDF, SharedBank } from '@/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const { data: pdfRows, error: pdfError } = await auth.supabase
    .from('pdfs')
    .select('*')
    .eq('user_id', auth.userId)
    .order('created_at', { ascending: false });

  if (pdfError) {
    throw new Error(`GET /api/pdfs: ${pdfError.message}`);
  }

  const pdfs = (pdfRows ?? []) as PDF[];
  const pdfIds = pdfs.map(pdf => pdf.id);

  let sharedBanks: SharedBank[] = [];
  if (pdfIds.length > 0) {
    const { data: sharedRows, error: sharedError } = await supabaseAdmin
      .from('shared_banks')
      .select('*')
      .in('source_pdf_id', pdfIds)
      .eq('is_active', true);

    if (sharedError) {
      throw new Error(`GET /api/pdfs shared_banks: ${sharedError.message}`);
    }

    sharedBanks = (sharedRows ?? []) as SharedBank[];
  }

  const bankByPdfId = new Map(sharedBanks.map(bank => [bank.source_pdf_id, bank]));

  const ownedPdfsMapped = pdfs.map(pdf => {
    const bank = bankByPdfId.get(pdf.id);
    return {
      ...pdf,
      access_scope: 'owned' as const,
      deck_id: pdf.deck_id,
      shared_bank_id: bank?.id ?? null,
      shared_bank_title: bank?.title ?? null,
      shared_bank_slug: bank?.slug ?? null,
      shared_bank_visibility: bank?.visibility ?? null,
    } satisfies PDF;
  });

  // Fetch PDFs from shared banks the user has joined as a member
  const { data: memberRows } = await supabaseAdmin
    .from('shared_bank_members')
    .select('shared_banks(id, source_pdf_id, title, slug, visibility, is_active, owner_user_id)')
    .eq('user_id', auth.userId)
    .eq('role', 'member');

  const joinedBanks = ((memberRows ?? []) as Array<{ shared_banks: SharedBank | null }>)
    .map(r => r.shared_banks)
    .filter((b): b is SharedBank => b !== null && b.is_active);

  const joinedPdfIds = joinedBanks
    .map(b => b.source_pdf_id)
    .filter(id => !pdfIds.includes(id));

  if (joinedPdfIds.length === 0) {
    return jsonOk(ownedPdfsMapped);
  }

  const { data: joinedPdfRows } = await supabaseAdmin
    .from('pdfs')
    .select('*')
    .in('id', joinedPdfIds);

  const bankBySourcePdfId = new Map(joinedBanks.map(b => [b.source_pdf_id, b]));

  const joinedPdfsMapped = ((joinedPdfRows ?? []) as PDF[]).map(pdf => {
    const bank = bankBySourcePdfId.get(pdf.id);
    return {
      ...pdf,
      access_scope: 'shared' as const,
      deck_id: null,
      shared_bank_id: bank?.id ?? null,
      shared_bank_title: bank?.title ?? null,
      shared_bank_slug: bank?.slug ?? null,
      shared_bank_visibility: bank?.visibility ?? null,
    } satisfies PDF;
  });

  return jsonOk([...ownedPdfsMapped, ...joinedPdfsMapped]);
}
