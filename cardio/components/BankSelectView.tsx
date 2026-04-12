'use client';

import { useState } from 'react';
import type { PDF } from '@/types';

interface Props {
  pdfs:       PDF[];
  onSelect:   (pdfId: string) => void;
  onBack:     () => void;
}

export default function BankSelectView({ pdfs, onSelect, onBack }: Props) {
  const [hov, setHov] = useState<string | null>(null);
  const banks = pdfs.filter(p => p.processed_at);

  return (
    <div style={{ maxWidth: '700px', margin: '0 auto', paddingBottom: '40px' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '28px' }}>
        <button
          onClick={onBack}
          style={{
            display: 'flex', alignItems: 'center', gap: '5px',
            fontSize: '0.75rem', fontWeight: 600, letterSpacing: '0.02em',
            color: 'var(--text-dim)', background: 'none', border: 'none',
            cursor: 'pointer', padding: '4px 0', transition: 'color 0.15s',
          }}
          onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
          onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2">
            <polyline points="10,3 5,8 10,13" />
          </svg>
          Back
        </button>
        <svg width="4" height="4" viewBox="0 0 4 4"><circle cx="2" cy="2" r="2" fill="var(--text-dim)" opacity="0.4" /></svg>
        <h1 style={{
          fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)',
          letterSpacing: '-0.015em', margin: 0,
        }}>
          Choose Question Bank
        </h1>
      </div>

      <p style={{ fontSize: '0.82rem', color: 'var(--text-dim)', marginBottom: '20px' }}>
        Select a question bank to start a quiz session.
      </p>

      {banks.length === 0 && (
        <div style={{
          textAlign: 'center', padding: '60px 20px',
          background: 'var(--bg-raised)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
        }}>
          <div style={{ fontSize: '2rem', marginBottom: '12px' }}>📚</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-dim)' }}>
            No processed question banks yet. Upload a PDF to get started.
          </p>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '12px' }}>
        {banks.map((pdf, i) => {
          const name = pdf.name.replace(/\.pdf$/i, '');
          const isHov = hov === pdf.id;
          return (
            <button
              key={pdf.id}
              onClick={() => onSelect(pdf.id)}
              style={{
                background:   isHov ? 'var(--accent-dim)' : 'var(--bg-raised)',
                border:       `1px solid ${isHov ? 'rgba(13,154,170,0.35)' : 'var(--border)'}`,
                borderTop:    `3px solid var(--accent)`,
                borderRadius: 'var(--radius-lg)',
                padding:      '18px 20px',
                textAlign:    'left',
                cursor:       'pointer',
                transition:   'all 0.15s ease',
                boxShadow:    isHov ? 'var(--shadow-md)' : 'none',
                animation:    `fade-up 0.25s ease ${i * 0.05}s both`,
              }}
              onMouseEnter={() => setHov(pdf.id)}
              onMouseLeave={() => setHov(null)}
            >
              <p style={{
                fontSize: '0.88rem', fontWeight: 700,
                color: isHov ? 'var(--accent)' : 'var(--text-primary)',
                letterSpacing: '-0.01em', lineHeight: 1.3,
                marginBottom: '8px',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                transition: 'color 0.15s',
              }}>
                {name}
              </p>
              <div style={{ display: 'flex', gap: '14px', fontSize: '0.72rem' }}>
                <span style={{ color: 'var(--text-dim)' }}>
                  {pdf.question_count ?? 0} questions
                </span>
                {pdf.concept_count != null && (
                  <span style={{ color: 'var(--text-dim)' }}>
                    {pdf.concept_count} concepts
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
