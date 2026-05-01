import { notFound } from 'next/navigation';
import { unstable_noStore as noStore } from 'next/cache';
import type { Metadata } from 'next';
import { supabaseServerComponent } from '@/lib/supabase';
import { getSharedBankPreviewData } from '@/lib/shared-bank-preview';
import JoinSection from './JoinSection';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const preview = await getSharedBankPreviewData(params.slug);

  if (!preview) {
    return {
      title: 'Cardio — Shared Question Bank',
      description: 'Open this shared Cardio question bank to study with your cohort.',
    };
  }

  return {
    title: preview.title,
    description: preview.description,
    alternates: {
      canonical: preview.shareUrl,
    },
    openGraph: {
      title: preview.title,
      description: preview.description,
      url: preview.shareUrl,
      siteName: 'Cardio',
      type: 'website',
      images: [
        {
          url: preview.imageUrl,
          width: 1200,
          height: 630,
          alt: `${preview.bank.title} shared question bank on Cardio`,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: preview.title,
      description: preview.description,
      images: [preview.imageUrl],
    },
  };
}

export default async function SharedBankLandingPage({ params }: { params: { slug: string } }) {
  noStore();

  const preview = await getSharedBankPreviewData(params.slug);
  if (!preview) notFound();
  const { bank, memberCount, pageCount, questionCount } = preview;
  const sourcePdfs = bank.source_pdfs;
  const isDeckBank = !!bank.source_deck_id;

  const supabase = supabaseServerComponent();
  const { data: { user } } = await supabase.auth.getUser();
  const isOwner = user?.id === bank.owner_user_id;

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'flex-start',
      padding: '80px 20px 60px',
    }}>
      {/* Logo */}
      <a href="/" style={{ textDecoration: 'none', marginBottom: 48 }}>
        <span style={{
          fontFamily: 'var(--font-sans)',
          fontSize: 13, fontWeight: 700,
          letterSpacing: '0.18em', color: 'var(--accent)',
        }}>
          CARDIO
        </span>
      </a>

      <div style={{
        width: '100%', maxWidth: 480,
        background: 'var(--bg-raised)',
        border: '1px solid var(--border)',
        borderRadius: 16,
        padding: '40px 40px 36px',
        boxShadow: '0 4px 32px rgba(0,0,0,0.06)',
      }}>
        {/* Label */}
        <div style={{
          fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
          color: 'var(--accent)', fontFamily: 'var(--font-sans)',
          marginBottom: 10, textTransform: 'uppercase',
        }}>
          Shared Question Bank
        </div>

        {/* Title */}
        <h1 style={{
          fontFamily: 'var(--font-serif)',
          fontSize: 32, fontWeight: 400,
          letterSpacing: '-0.02em', lineHeight: 1.2,
          color: 'var(--text-primary)',
          margin: '0 0 20px',
        }}>
          {bank.title}
        </h1>

        {/* Stats */}
        <div style={{
          display: 'flex', gap: 20,
          fontSize: 13, color: 'var(--text-secondary)',
          fontFamily: 'var(--font-mono)', letterSpacing: '0.02em',
          marginBottom: 28,
        }}>
          {questionCount > 0 && <span>{questionCount} questions</span>}
          {pageCount > 0 && <><span>·</span><span>{pageCount} pages</span></>}
          {isDeckBank && <><span>·</span><span>{sourcePdfs.length} PDFs</span></>}
          {(memberCount ?? 0) > 0 && <><span>·</span><span>{memberCount} studying</span></>}
        </div>

        {bank.description && (
          <p style={{
            fontSize: 14, color: 'var(--text-secondary)',
            fontFamily: 'var(--font-sans)', lineHeight: 1.6,
            marginBottom: 28,
          }}>
            {bank.description}
          </p>
        )}

        {isDeckBank && sourcePdfs.length > 0 && (
          <div style={{
            borderTop: '1px solid var(--border)',
            borderBottom: '1px solid var(--border)',
            marginBottom: 28,
          }}>
            {sourcePdfs.map(pdf => (
              <div key={pdf.name} style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 16,
                padding: '10px 0',
                borderTop: '1px solid var(--border)',
                fontFamily: 'var(--font-sans)',
              }}>
                <span style={{
                  fontSize: 13,
                  color: 'var(--text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {pdf.display_name ?? pdf.name.replace(/\.pdf$/i, '')}
                </span>
                <span style={{
                  fontSize: 11,
                  color: 'var(--text-dim)',
                  fontFamily: 'var(--font-mono)',
                  flexShrink: 0,
                }}>
                  {pdf.question_count ?? 0} Q
                </span>
              </div>
            ))}
          </div>
        )}

        <JoinSection slug={params.slug} isDeckBank={isDeckBank} questionCount={questionCount} />
      </div>

      {/* Owner panel */}
      {isOwner && (
        <div style={{
          width: '100%', maxWidth: 480,
          marginTop: 16,
          background: 'var(--bg-raised)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: '20px 24px',
        }}>
          <div style={{
            fontSize: 11, fontWeight: 700, letterSpacing: '0.1em',
            color: 'var(--text-dim)', fontFamily: 'var(--font-sans)',
            marginBottom: 8, textTransform: 'uppercase',
          }}>
            Owner dashboard
          </div>
          <div style={{ fontSize: 14, color: 'var(--text-secondary)', fontFamily: 'var(--font-sans)' }}>
            {memberCount ?? 0} student{(memberCount ?? 0) !== 1 ? 's' : ''} joined this bank.
          </div>
        </div>
      )}
    </div>
  );
}
