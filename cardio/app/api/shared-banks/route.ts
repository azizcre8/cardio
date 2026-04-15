import { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { jsonBadRequest, jsonError, jsonOk, parseJsonBody } from '@/lib/api';
import { createUniqueSharedBankSlug } from '@/lib/shared-banks';
import { supabaseServer } from '@/lib/supabase';
import type { PDF, SharedBank, SharedBankVisibility } from '@/types';

type PublishSharedBankBody = {
  pdfId?: string;
  title?: string;
  description?: string | null;
  visibility?: SharedBankVisibility;
};

type SharedBankWithPdf = SharedBank & {
  source_pdf: PDF | null;
};

async function attachSourcePdfs(
  supabase: ReturnType<typeof supabaseServer>,
  banks: SharedBank[],
): Promise<SharedBankWithPdf[]> {
  const pdfIds = Array.from(new Set(banks.map(bank => bank.source_pdf_id)));
  if (pdfIds.length === 0) {
    return banks.map(bank => ({ ...bank, source_pdf: null }));
  }

  const { data: pdfRows, error: pdfError } = await supabase
    .from('pdfs')
    .select('*')
    .in('id', pdfIds);

  if (pdfError) throw new Error(`attachSourcePdfs: ${pdfError.message}`);

  const pdfById = new Map(((pdfRows ?? []) as PDF[]).map(pdf => [pdf.id, pdf]));

  return banks.map(bank => ({
    ...bank,
    source_pdf: pdfById.get(bank.source_pdf_id) ?? null,
  }));
}

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
  const joined = (membershipRows ?? [])
    .map((row: Record<string, unknown>) => {
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
    owned: await attachSourcePdfs(auth.supabase, owned),
    joined: await attachSourcePdfs(auth.supabase, joined),
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const parsed = await parseJsonBody<PublishSharedBankBody>(req);
  if (!parsed.ok) return parsed.response;

  const body = parsed.data;
  const pdfId = body.pdfId?.trim();
  if (!pdfId) return jsonBadRequest('pdfId is required');

  const visibility = body.visibility ?? 'public';
  if (!['private', 'invite_only', 'public'].includes(visibility)) {
    return jsonBadRequest('visibility must be private, invite_only, or public');
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
      source_pdf: pdfRow as PDF,
    } satisfies SharedBankWithPdf,
    shareUrl: `${origin}/app?shared=${bank.slug}`,
  });
}
