import { env } from '@/lib/env';
import { normalizeSharedBankSlug } from '@/lib/join-intent';
import { getSharedBankSources, type SharedBankWithSources } from '@/lib/shared-banks';
import { supabaseAdmin } from '@/lib/supabase';
import type { SharedBank } from '@/types';

export type SharedBankPreviewData = {
  bank: SharedBankWithSources;
  questionCount: number;
  pageCount: number;
  sourceCount: number;
  memberCount: number;
  title: string;
  description: string;
  shareText: string;
  shareUrl: string;
  imageUrl: string;
};

function absoluteSiteUrl() {
  return env.siteUrl.replace(/\/+$/, '');
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

export function buildSharedBankStatsText(questionCount: number, sourceCount: number) {
  const parts = [];
  if (questionCount > 0) parts.push(pluralize(questionCount, 'question'));
  if (sourceCount > 0) parts.push(`from ${pluralize(sourceCount, 'source')}`);
  return parts.length > 0 ? parts.join(' ') : 'Shared question bank';
}

export function buildSharedBankPreviewDescription(
  questionCount: number,
  sourceCount: number,
) {
  return `${buildSharedBankStatsText(questionCount, sourceCount)}. Study this Cardio question bank.`;
}

export function buildSharedBankShareText(title: string, questionCount: number, sourceCount: number) {
  return `${title}: ${buildSharedBankStatsText(questionCount, sourceCount)} on Cardio.`;
}

export function buildSharedBankShareUrl(slug: string) {
  return `${absoluteSiteUrl()}/s/${encodeURIComponent(slug)}`;
}

export function buildSharedBankImageUrl(slug: string) {
  return `${absoluteSiteUrl()}/s/${encodeURIComponent(slug)}/opengraph-image`;
}

export async function getSharedBankPreviewData(slug: string): Promise<SharedBankPreviewData | null> {
  const normalizedSlug = normalizeSharedBankSlug(slug);
  if (!normalizedSlug) return null;

  const { data: bankRow, error: bankError } = await supabaseAdmin
    .from('shared_banks')
    .select('*')
    .eq('slug', normalizedSlug)
    .eq('is_active', true)
    .maybeSingle();

  if (bankError) throw new Error(`getSharedBankPreviewData bank: ${bankError.message}`);
  if (!bankRow) return null;

  const bank = bankRow as SharedBank;
  const [bankWithSources, { count: memberCount, error: memberError }] = await Promise.all([
    getSharedBankSources(supabaseAdmin, bank),
    supabaseAdmin
      .from('shared_bank_members')
      .select('*', { count: 'exact', head: true })
      .eq('shared_bank_id', bank.id),
  ]);

  if (memberError) throw new Error(`getSharedBankPreviewData members: ${memberError.message}`);

  const sourcePdfs = bankWithSources.source_pdfs;
  const questionCount = sourcePdfs.reduce((sum, pdf) => sum + (pdf.question_count ?? 0), 0);
  const pageCount = sourcePdfs.reduce((sum, pdf) => sum + (pdf.page_count ?? 0), 0);
  const sourceCount = sourcePdfs.length;
  const title = `${bank.title} · Cardio`;
  const description = buildSharedBankPreviewDescription(questionCount, sourceCount);

  return {
    bank: bankWithSources,
    questionCount,
    pageCount,
    sourceCount,
    memberCount: memberCount ?? 0,
    title,
    description,
    shareText: buildSharedBankShareText(bank.title, questionCount, sourceCount),
    shareUrl: buildSharedBankShareUrl(bank.slug),
    imageUrl: buildSharedBankImageUrl(bank.slug),
  };
}
