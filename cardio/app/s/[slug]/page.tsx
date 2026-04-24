import { notFound } from 'next/navigation';
import { supabaseAdmin, supabaseServerComponent } from '@/lib/supabase';
import JoinSection from './JoinSection';
import type { PDF, SharedBank } from '@/types';

export const dynamic = 'force-dynamic';

export default async function SharedBankLandingPage({ params }: { params: { slug: string } }) {
  const { data: bankRow } = await supabaseAdmin
    .from('shared_banks')
    .select('*')
    .eq('slug', params.slug)
    .eq('is_active', true)
    .maybeSingle();

  if (!bankRow) notFound();
  const bank = bankRow as SharedBank;

  const [{ data: pdfRow }, { count: memberCount }] = await Promise.all([
    supabaseAdmin.from('pdfs').select('name, display_name, question_count, page_count').eq('id', bank.source_pdf_id).maybeSingle(),
    supabaseAdmin.from('shared_bank_members').select('*', { count: 'exact', head: true }).eq('shared_bank_id', bank.id),
  ]);

  const pdf = pdfRow as Pick<PDF, 'name' | 'display_name' | 'question_count' | 'page_count'> | null;

  const supabase = supabaseServerComponent();
  const { data: { user } } = await supabase.auth.getUser();
  const isOwner = user?.id === bank.owner_user_id;

  const questionCount = pdf?.question_count ?? 0;
  const pageCount = pdf?.page_count ?? 0;

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

        <JoinSection slug={params.slug} />
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
