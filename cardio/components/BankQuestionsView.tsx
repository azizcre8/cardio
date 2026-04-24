'use client';

import { useEffect, useState } from 'react';
import type { PDF } from '@/types';

interface Question {
  id: string;
  stem: string;
  options: string[];
  answer: number;
  explanation?: string;
  concept_name?: string;
  level?: number;
  interval?: number;
  times_reviewed?: number;
  next_review?: string;
}

interface Props {
  pdfId: string;
  pdfs: PDF[];
  onBack: () => void;
  onStudy: () => void;
}

export default function BankQuestionsView({ pdfId, pdfs, onBack, onStudy }: Props) {
  const pdf = pdfs.find(p => p.id === pdfId);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    setLoading(true);
    fetch(`/api/pdfs/${pdfId}/questions`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.questions) setQuestions(d.questions as Question[]); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [pdfId]);

  const filtered = search.trim()
    ? questions.filter(q =>
        q.stem.toLowerCase().includes(search.toLowerCase()) ||
        (q.concept_name ?? '').toLowerCase().includes(search.toLowerCase()),
      )
    : questions;

  const name = pdf?.display_name ?? pdf?.name ?? 'Question Bank';

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '32px 40px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 28 }}>
          <div>
            <button
              onClick={onBack}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: 12, color: 'var(--text-dim)', padding: '0 0 8px',
                display: 'flex', alignItems: 'center', gap: 4,
                fontFamily: 'var(--font-mono)',
              }}
            >
              ← Banks
            </button>
            <h2 style={{
              fontFamily: 'var(--font-serif)',
              fontSize: '1.25rem', fontWeight: 400,
              color: 'var(--text-primary)', margin: '0 0 6px',
            }}>
              {name}
            </h2>
            {!loading && (
              <p style={{ fontSize: 13, color: 'var(--text-dim)', margin: 0 }}>
                <span style={{ color: 'var(--accent)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                  {questions.length}
                </span>
                {' '}question{questions.length !== 1 ? 's' : ''}
              </p>
            )}
          </div>
          {(pdf?.question_count ?? 0) > 0 && (
            <button
              onClick={onStudy}
              style={{
                padding: '8px 18px',
                background: 'var(--accent)',
                border: 'none', borderRadius: 8,
                fontSize: 13, fontWeight: 600,
                color: 'var(--accent-ink)', cursor: 'pointer',
              }}
            >
              Study
            </button>
          )}
        </div>

        {/* Search */}
        {questions.length > 5 && (
          <input
            type="search"
            placeholder="Search questions…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              width: '100%', boxSizing: 'border-box',
              padding: '8px 12px', marginBottom: 20,
              background: 'var(--bg-raised)',
              border: '1px solid var(--border-med)',
              borderRadius: 'var(--r2)',
              fontSize: 13, color: 'var(--text-primary)',
              fontFamily: 'var(--font-sans)',
              outline: 'none',
            }}
          />
        )}

        {/* Body */}
        {loading ? (
          <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--text-dim)', fontSize: 13 }}>
            Loading…
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--text-dim)', fontSize: 13 }}>
            {search ? 'No matching questions.' : 'No questions yet.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {filtered.map((q, i) => (
              <QuestionCard key={q.id} q={q} index={filtered.indexOf(q)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function QuestionCard({ q, index }: { q: Question; index: number }) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);

  const now = new Date().toISOString();
  const isDue = q.next_review ? q.next_review <= now : false;
  const isNew = !q.times_reviewed;

  return (
    <div
      onClick={() => setOpen(o => !o)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? 'var(--bg-raised)' : 'var(--bg-raised)',
        border: `1px solid ${hovered ? 'var(--border-med)' : 'var(--border)'}`,
        borderRadius: 'var(--r3)',
        cursor: 'pointer',
        transition: 'border-color 0.15s',
        overflow: 'hidden',
      }}
    >
      {/* Card header */}
      <div style={{ padding: '14px 16px', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        {/* Index */}
        <span style={{
          fontSize: 10, fontWeight: 600, fontFamily: 'var(--font-mono)',
          color: 'var(--text-disabled)', minWidth: 28, marginTop: 2,
          flexShrink: 0,
        }}>
          Q{index + 1}
        </span>

        {/* Stem + meta */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{
            margin: '0 0 8px',
            fontSize: 13, color: 'var(--text-primary)',
            lineHeight: 1.5,
          }}>
            {q.stem}
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {q.level && <LevelBadge level={q.level} />}
            {q.concept_name && (
              <span style={{
                fontSize: 10, color: 'var(--text-dim)',
                fontFamily: 'var(--font-mono)',
              }}>
                {q.concept_name}
              </span>
            )}
            {isNew ? (
              <span style={{ fontSize: 10, color: 'var(--accent)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>new</span>
            ) : isDue ? (
              <span style={{ fontSize: 10, color: 'var(--amber)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>due</span>
            ) : q.interval != null ? (
              <span style={{ fontSize: 10, color: 'var(--green)', fontFamily: 'var(--font-mono)' }}>
                {fmtInterval(q.interval)}
              </span>
            ) : null}
          </div>
        </div>

        {/* Expand toggle */}
        <span style={{
          fontSize: 10, color: 'var(--text-dim)',
          transform: open ? 'rotate(180deg)' : 'rotate(0)',
          transition: 'transform 0.2s',
          display: 'inline-block', flexShrink: 0, marginTop: 4,
        }}>
          ▼
        </span>
      </div>

      {/* Options (expanded) */}
      {open && (
        <div style={{
          borderTop: '1px solid var(--border)',
          padding: '12px 16px 12px 56px',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          {q.options.map((opt, i) => (
            <div
              key={i}
              style={{
                display: 'flex', gap: 10, alignItems: 'flex-start',
                padding: '6px 10px',
                borderRadius: 'var(--r2)',
                background: i === q.answer ? 'color-mix(in srgb, var(--green) 12%, transparent)' : 'transparent',
                border: `1px solid ${i === q.answer ? 'var(--green)' : 'transparent'}`,
              }}
            >
              <span style={{
                fontSize: 11, fontWeight: 700,
                color: i === q.answer ? 'var(--green)' : 'var(--text-disabled)',
                fontFamily: 'var(--font-mono)', flexShrink: 0, marginTop: 1,
              }}>
                {String.fromCharCode(65 + i)}.
              </span>
              <span style={{ fontSize: 13, color: i === q.answer ? 'var(--text-primary)' : 'var(--text-secondary)', lineHeight: 1.45 }}>
                {opt}
              </span>
            </div>
          ))}
          {q.explanation && (
            <p style={{
              margin: '8px 0 0',
              fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5,
              borderTop: '1px solid var(--border)', paddingTop: 10,
            }}>
              {q.explanation}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function LevelBadge({ level }: { level: number }) {
  const colors: Record<number, string> = { 1: 'var(--green)', 2: 'var(--amber)', 3: 'var(--red)' };
  const labels: Record<number, string> = { 1: 'L1', 2: 'L2', 3: 'L3' };
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
      fontFamily: 'var(--font-mono)',
      color: colors[level] ?? 'var(--text-dim)',
      background: `color-mix(in srgb, ${colors[level] ?? 'var(--text-dim)'} 12%, transparent)`,
      padding: '2px 5px', borderRadius: 3,
    }}>
      {labels[level] ?? `L${level}`}
    </span>
  );
}

function fmtInterval(days: number): string {
  if (days < 1) return `${Math.round(days * 24)}h`;
  if (days < 7) return `${Math.round(days)}d`;
  if (days < 30) return `${Math.round(days / 7)}w`;
  return `${Math.round(days / 30)}mo`;
}
