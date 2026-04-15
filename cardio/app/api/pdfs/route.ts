/**
 * GET /api/pdfs — list all PDFs visible to the authenticated user
 */

import { requireUser } from '@/lib/auth';
import { jsonOk } from '@/lib/api';
import type { PDF, SharedBank } from '@/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const { data: pdfRows, error: pdfError } = await auth.supabase
    .from('pdfs')
    .select('*')
    .order('created_at', { ascending: false });

  if (pdfError) {
    throw new Error(`GET /api/pdfs: ${pdfError.message}`);
  }

  const pdfs = (pdfRows ?? []) as PDF[];
  const pdfIds = pdfs.map(pdf => pdf.id);

  let sharedBanks: SharedBank[] = [];
  if (pdfIds.length > 0) {
    const { data: sharedRows, error: sharedError } = await auth.supabase
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

  return jsonOk(
    pdfs.map(pdf => {
      const bank = bankByPdfId.get(pdf.id);
      const isOwned = pdf.user_id === auth.userId;

      return {
        ...pdf,
        access_scope: isOwned ? 'owned' : 'shared',
        deck_id: isOwned ? pdf.deck_id : null,
        shared_bank_id: bank?.id ?? null,
        shared_bank_title: bank?.title ?? null,
        shared_bank_slug: bank?.slug ?? null,
        shared_bank_visibility: bank?.visibility ?? null,
      } satisfies PDF;
    }),
  );
}
