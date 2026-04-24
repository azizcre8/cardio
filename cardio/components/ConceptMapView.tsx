'use client';

import { useEffect, useState } from 'react';
import type { Concept, PDF } from '@/types';

interface Props {
  pdf:          PDF;
  onStudyNow:   () => void;
  onReviewDue?: () => void;
  onBack:       () => void;
}

const IMP = {
  high:   { border: 'var(--accent)', bg: 'var(--accent-dim)',       text: 'var(--accent)', label: 'High yield' },
  medium: { border: 'var(--amber)',  bg: 'rgba(217,119,6,0.08)',    text: 'var(--amber)',  label: 'Medium'     },
  low:    { border: 'var(--border)', bg: 'var(--bg-sunken)',         text: 'var(--text-dim)', label: 'Low'     },
} as const;

export default function ConceptMapView({ pdf, onStudyNow, onReviewDue, onBack }: Props) {
  const [concepts,  setConcepts]  = useState<Concept[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [selected,  setSelected]  = useState<string | null>(null);
  const [hovAction, setHovAction] = useState('');
  const [dueCount,  setDueCount]  = useState<number | null>(null);

  useEffect(() => {
    fetch(`/api/pdfs/${pdf.id}/concepts`)
      .then(r => r.json())
      .then(d => { setConcepts(d.concepts ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [pdf.id]);

  useEffect(() => {
    if (!onReviewDue) return;
    fetch(`/api/study/queue?pdfId=${pdf.id}`)
      .then(r => r.json())
      .then(d => {
        // Count only SRS-due items (previously reviewed, now due)
        const due = (d.queue ?? []).filter((q: { _bucket: string }) => q._bucket === 'srs').length;
        setDueCount(due);
      })
      .catch(() => {});
  }, [pdf.id, onReviewDue]);

  /* group by category */
  const byCategory = new Map<string, Concept[]>();
  concepts.forEach(c => {
    const cat = c.category || 'General';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(c);
  });
  const categories = Array.from(byCategory.keys()).sort();

  const highCount = concepts.filter(c => c.importance === 'high').length;
  const deckName  = pdf.shared_bank_title ?? pdf.display_name ?? pdf.name.replace(/\.pdf$/i, '');

  return (
    <div style={{ maxWidth: '900px', margin: '0 auto', paddingBottom: '40px' }}>

      {/* ── Breadcrumb + title ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '24px' }}>
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
          Library
        </button>
        <svg width="4" height="4" viewBox="0 0 4 4"><circle cx="2" cy="2" r="2" fill="var(--text-dim)" opacity="0.4" /></svg>
        <h1 style={{
          flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)',
          letterSpacing: '-0.015em', margin: 0,
        }}>
          {deckName}
        </h1>
      </div>

      {/* ── Stats row ── */}
      {!loading && concepts.length > 0 && (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px',
          marginBottom: '20px',
          animation: 'fade-up 0.3s ease both',
        }}>
          {[
            { n: concepts.length,        label: 'Concepts',     color: 'var(--text-secondary)' },
            { n: highCount,              label: 'High yield',   color: 'var(--accent)'         },
            { n: pdf.question_count ?? 0, label: 'Questions',   color: 'var(--text-secondary)' },
          ].map(({ n, label, color }) => (
            <div
              key={label}
              style={{
                background: 'var(--bg-raised)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius-lg)', padding: '18px 20px',
              }}
            >
              <div style={{
                fontFamily: "'Source Serif 4', Georgia, serif",
                fontSize: '2.2rem', fontWeight: 300, color,
                letterSpacing: '-0.05em', lineHeight: 1, marginBottom: '6px',
              }}>
                {n}
              </div>
              <div style={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>
                {label}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Action bar ── */}
      {!loading && concepts.length > 0 && (
        <div style={{
          background: 'var(--bg-raised)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)', padding: '14px 20px',
          display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
          marginBottom: '28px',
          animation: 'fade-up 0.35s ease 0.05s both',
        }}>
          {onReviewDue && (
            <ActionBtn
              label={dueCount === null ? '🔁 Review Due' : dueCount > 0 ? `🔁 Review Due (${dueCount})` : '🔁 Review Due (0)'}
              primary={dueCount !== null && dueCount > 0}
              hovered={hovAction === 'review'}
              onHover={h => setHovAction(h ? 'review' : '')}
              onClick={onReviewDue}
            />
          )}
          <ActionBtn
            label="▶ Practice All"
            primary={!onReviewDue || dueCount === 0}
            hovered={hovAction === 'study'}
            onHover={h => setHovAction(h ? 'study' : '')}
            onClick={onStudyNow}
          />
          <ActionBtn
            label="📚 Back to Library"
            hovered={hovAction === 'back'}
            onHover={h => setHovAction(h ? 'back' : '')}
            onClick={onBack}
          />
        </div>
      )}

      {/* ── Loading ── */}
      {loading && (
        <div style={{ textAlign: 'center', padding: '80px 20px' }}>
          <div style={{ fontSize: '2rem', marginBottom: '14px', animation: 'float 2s ease-in-out infinite' }}>
            🧬
          </div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-dim)' }}>
            Loading concept map…
          </p>
        </div>
      )}

      {/* ── Concept grid by category ── */}
      {!loading && categories.map((cat, ci) => (
        <div
          key={cat}
          style={{ marginBottom: '32px', animation: `fade-up 0.3s ease ${0.05 + ci * 0.05}s both` }}
        >
          {/* Category header */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: '10px',
            marginBottom: '12px', paddingBottom: '10px',
            borderBottom: '1px solid var(--border)',
          }}>
            <span style={{
              fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.14em',
              textTransform: 'uppercase', color: 'var(--accent)',
            }}>
              {cat}
            </span>
            <span style={{
              fontSize: '0.58rem', fontWeight: 700,
              background: 'var(--accent-dim)', border: '1px solid rgba(13,154,170,0.2)',
              color: 'var(--accent)', borderRadius: '99px', padding: '1px 7px',
            }}>
              {byCategory.get(cat)!.length}
            </span>
          </div>

          {/* Concept cards */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
            gap: '10px',
          }}>
            {byCategory.get(cat)!.map((concept, i) => {
              const imp        = IMP[concept.importance] ?? IMP.low;
              const isSelected = selected === concept.id;

              return (
                <ConceptCard
                  key={concept.id}
                  concept={concept}
                  imp={imp}
                  isSelected={isSelected}
                  delay={0.05 + ci * 0.05 + i * 0.02}
                  onClick={() => setSelected(isSelected ? null : concept.id)}
                />
              );
            })}
          </div>
        </div>
      ))}

      {/* ── Empty state ── */}
      {!loading && concepts.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 20px' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '12px' }}>🗺️</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-dim)', marginBottom: '20px' }}>
            Concepts are still being indexed.
          </p>
          <button
            onClick={onStudyNow}
            style={{
              padding: '10px 28px', borderRadius: 'var(--radius-md)',
              background: 'var(--accent)', color: 'white',
              fontSize: '0.85rem', fontWeight: 600, border: 'none', cursor: 'pointer',
            }}
          >
            Study Now →
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Sub-components ── */

function ConceptCard({
  concept, imp, isSelected, delay, onClick,
}: {
  concept:    Concept;
  imp:        typeof IMP[keyof typeof IMP];
  isSelected: boolean;
  delay:      number;
  onClick:    () => void;
}) {
  const [hov, setHov] = useState(false);
  const active = isSelected || hov;

  return (
    <div
      onClick={onClick}
      style={{
        background:  active ? imp.bg : 'var(--bg-raised)',
        border:      `1px solid ${active ? imp.border : 'var(--border)'}`,
        borderLeft:  `3px solid ${imp.border}`,
        borderRadius: 'var(--radius-md)',
        padding:     '14px',
        cursor:      'pointer',
        transition:  'all 0.15s ease',
        animation:   `fade-up 0.25s ease ${delay}s both`,
      }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
    >
      {/* Name + importance badge */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px', marginBottom: '8px' }}>
        <p style={{
          fontSize: '0.85rem', fontWeight: 600,
          color: 'var(--text-primary)', lineHeight: 1.35,
          letterSpacing: '-0.01em', margin: 0,
        }}>
          {concept.name}
        </p>
        <span style={{
          fontSize: '0.56rem', fontWeight: 800,
          letterSpacing: '0.08em', textTransform: 'uppercase',
          color: imp.text, flexShrink: 0,
          padding: '2px 7px', borderRadius: '99px',
          background: imp.bg, border: `1px solid ${imp.border}`,
        }}>
          {imp.label}
        </span>
      </div>

      {/* Summary */}
      {concept.summary && (
        <p style={{
          fontSize: '0.74rem', color: 'var(--text-secondary)',
          lineHeight: 1.55, margin: 0,
          display:           '-webkit-box',
          WebkitLineClamp:   isSelected ? undefined : 2,
          WebkitBoxOrient:   'vertical',
          overflow:          isSelected ? 'visible' : 'hidden',
        }}>
          {concept.summary}
        </p>
      )}

      {/* Confusion targets (expanded) */}
      {isSelected && concept.confusion_targets?.length > 0 && (
        <div style={{
          marginTop: '10px', paddingTop: '10px',
          borderTop: '1px solid var(--border)',
        }}>
          <span style={{ fontSize: '0.64rem', color: 'var(--text-dim)', fontWeight: 600 }}>
            Often confused with:{' '}
          </span>
          {concept.confusion_targets.map(t => (
            <span key={t} style={{ fontSize: '0.7rem', color: 'var(--amber)', marginRight: '6px' }}>
              {t}
            </span>
          ))}
        </div>
      )}

      {/* Coverage domains (expanded) */}
      {isSelected && concept.coverage_domains?.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '8px' }}>
          {concept.coverage_domains.map(d => (
            <span key={d} style={{
              fontSize: '0.6rem', fontWeight: 600,
              background: 'var(--bg-sunken)', border: '1px solid var(--border)',
              color: 'var(--text-dim)', borderRadius: '99px', padding: '2px 7px',
              textTransform: 'capitalize',
            }}>
              {d}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ActionBtn({
  label, onClick, primary, hovered, onHover,
}: {
  label:   string;
  onClick: () => void;
  primary?: boolean;
  hovered: boolean;
  onHover: (h: boolean) => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding:      '8px 18px',
        borderRadius: 'var(--radius-md)',
        fontSize:     '0.78rem', fontWeight: 600,
        border:       `1px solid ${primary ? 'transparent' : 'var(--border)'}`,
        background:   primary
          ? (hovered ? '#0A8898' : 'var(--accent)')
          : (hovered ? 'var(--accent-dim)' : 'var(--bg-sunken)'),
        color:        primary ? 'white' : (hovered ? 'var(--accent)' : 'var(--text-secondary)'),
        cursor:       'pointer',
        transition:   'all 0.15s ease',
      }}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
      {label}
    </button>
  );
}
