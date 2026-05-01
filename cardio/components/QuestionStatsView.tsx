'use client';

import { useEffect, useState } from 'react';
import type { PDF, QuestionStatRow } from '@/types';

type SortKey = 'flags' | 'difficulty' | 'discrimination' | 'attempts' | 'time';

interface Props {
  pdfs: PDF[];
  userEmail: string | null;
}

function difficultyColor(d: number): string {
  if (d < 0.2 || d > 0.8) return 'var(--red)';
  if (d < 0.35 || d > 0.65) return 'var(--amber)';
  return 'var(--green)';
}

function discriminationColor(d: number): string {
  if (d < 0.1) return 'var(--red)';
  if (d < 0.2) return 'var(--amber)';
  return 'var(--green)';
}

function pct(n: number) {
  return `${Math.round(n * 100)}%`;
}

function formatMs(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function QuestionStatsView({ pdfs, userEmail }: Props) {
  const processedPdfs = pdfs.filter(p => p.processed_at != null);

  const [selectedPdfId, setSelectedPdfId] = useState<string | null>(
    processedPdfs[0]?.id ?? null
  );
  const [rows, setRows]       = useState<QuestionStatRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [sortBy, setSortBy]   = useState<SortKey>('flags');
  const [search, setSearch]   = useState('');

  useEffect(() => {
    if (userEmail !== 'sajedsamiraziz@gmail.com') { setRows([]); return; }
    if (!selectedPdfId) { setRows([]); return; }
    setLoading(true);
    setError(null);
    fetch(`/api/admin/question-stats?pdfId=${encodeURIComponent(selectedPdfId)}`)
      .then(r => r.json())
      .then((data: unknown) => {
        if (Array.isArray(data)) {
          setRows(data as QuestionStatRow[]);
        } else {
          setError('Unexpected response from server.');
        }
      })
      .catch(() => setError('Failed to load question stats.'))
      .finally(() => setLoading(false));
  }, [selectedPdfId, userEmail]);

  const sorted = [...rows].sort((a, b) => {
    switch (sortBy) {
      case 'flags':          return b.flag_count - a.flag_count;
      case 'difficulty':     return a.difficulty_index - b.difficulty_index;
      case 'discrimination': return a.discrimination_index - b.discrimination_index;
      case 'attempts':       return b.total_attempts - a.total_attempts;
      case 'time':           return b.avg_time_ms - a.avg_time_ms;
      default:               return 0;
    }
  });

  const visible = sorted.filter(r => !search.trim() || r.stem.toLowerCase().includes(search.toLowerCase()));

  if (userEmail !== 'sajedsamiraziz@gmail.com') {
    return (
      <div style={{ textAlign: 'center', padding: '80px 0', color: 'var(--text-dim)', fontSize: '0.85rem' }}>
        Q·Stats is only available to administrators.
      </div>
    );
  }

  const SORT_TABS: { key: SortKey; label: string }[] = [
    { key: 'flags',          label: 'Flags' },
    { key: 'difficulty',     label: 'Difficulty' },
    { key: 'discrimination', label: 'Discrimination' },
    { key: 'attempts',       label: 'Attempts' },
    { key: 'time',           label: 'Avg Time' },
  ];

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 4px' }}>

      {/* Header row */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 20,
      }}>
        <div>
          <h2 style={{
            fontSize: '1.1rem', fontWeight: 700, letterSpacing: '-0.01em',
            color: 'var(--text-primary)', margin: 0,
          }}>
            Q·Stats
          </h2>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginTop: 2 }}>
            Difficulty · discrimination · distractor analysis
          </p>
        </div>

        {processedPdfs.length > 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ position: 'relative' }}>
              <svg style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)', pointerEvents: 'none' }}
                width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
                <circle cx="8.5" cy="8.5" r="5.5" /><line x1="13" y1="13" x2="17.5" y2="17.5" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search questions…"
                style={{
                  width: 240, height: 32, paddingLeft: 28, paddingRight: 10,
                  borderRadius: 'var(--r2)', fontSize: '0.8rem',
                  background: 'var(--bg-sunken)', border: '1px solid var(--border)',
                  color: 'var(--text-primary)', outline: 'none',
                }}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
              />
            </div>
            <select
              value={selectedPdfId ?? ''}
              onChange={e => setSelectedPdfId(e.target.value || null)}
              style={{
                height: 32,
                fontSize: '0.8rem', fontFamily: 'var(--font-sans)',
                padding: '6px 10px', borderRadius: 'var(--r2)',
                border: '1px solid var(--border)', background: 'var(--bg-raised)',
                color: 'var(--text-primary)', cursor: 'pointer', maxWidth: 320,
              }}
            >
              {processedPdfs.map(p => (
                <option key={p.id} value={p.id}>
                  {p.display_name ?? p.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>No processed PDFs</span>
        )}
      </div>

      {/* Sort tabs */}
      <div style={{
        display: 'flex', gap: 4, marginBottom: 16,
        borderBottom: '1px solid var(--border)', paddingBottom: 0,
      }}>
        {SORT_TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setSortBy(tab.key)}
            style={{
              fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.08em',
              textTransform: 'uppercase', padding: '6px 12px',
              background: 'none', border: 'none', cursor: 'pointer',
              color: sortBy === tab.key ? 'var(--accent)' : 'var(--text-dim)',
              borderBottom: `2px solid ${sortBy === tab.key ? 'var(--accent)' : 'transparent'}`,
              marginBottom: -1, transition: 'color 0.15s',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {search.trim() !== '' && (
        <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: -8, marginBottom: 14 }}>
          {visible.length} of {sorted.length} questions
        </div>
      )}

      {/* Body */}
      {!selectedPdfId && (
        <p style={{ fontSize: '0.85rem', color: 'var(--text-dim)', textAlign: 'center', padding: '60px 0' }}>
          Select a PDF to view analytics.
        </p>
      )}

      {selectedPdfId && loading && (
        <p style={{ fontSize: '0.85rem', color: 'var(--text-dim)', textAlign: 'center', padding: '60px 0' }}>
          Loading…
        </p>
      )}

      {selectedPdfId && error && (
        <p style={{ fontSize: '0.85rem', color: 'var(--red)', textAlign: 'center', padding: '60px 0' }}>
          {error}
        </p>
      )}

      {selectedPdfId && !loading && !error && sorted.length === 0 && (
        <p style={{ fontSize: '0.85rem', color: 'var(--text-dim)', textAlign: 'center', padding: '60px 0' }}>
          No attempts recorded yet for this PDF.
        </p>
      )}

      {selectedPdfId && !loading && !error && sorted.length > 0 && visible.length === 0 && (
        <p style={{ fontSize: '0.85rem', color: 'var(--text-dim)', textAlign: 'center', padding: '60px 0' }}>
          No questions match "{search}".
        </p>
      )}

      {!loading && !error && visible.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{
            width: '100%', borderCollapse: 'collapse',
            fontSize: '0.8rem', fontFamily: 'var(--font-sans)',
          }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Stem', 'Lvl', 'Attempts', 'Difficulty', 'Discrimination', 'Avg Time', 'Flags', 'Helpful'].map(h => (
                  <th
                    key={h}
                    style={{
                      textAlign: h === 'Stem' ? 'left' : 'center',
                      padding: '8px 10px',
                      fontSize: '0.67rem', fontWeight: 700,
                      letterSpacing: '0.1em', textTransform: 'uppercase',
                      color: 'var(--text-dim)', whiteSpace: 'nowrap',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((row, i) => {
                const hasFlags = row.flag_count > 0;
                return (
                  <tr
                    key={row.question_id}
                    style={{
                      borderBottom: '1px solid var(--border)',
                      background: hasFlags
                        ? 'rgba(245,158,11,0.05)'
                        : i % 2 === 0 ? 'transparent' : 'var(--bg-sunken)',
                    }}
                  >
                    {/* Stem */}
                    <td style={{
                      padding: '10px 10px', maxWidth: 340,
                      color: 'var(--text-primary)', lineHeight: 1.4,
                    }}>
                      <div style={{
                        display: '-webkit-box', WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical', overflow: 'hidden',
                        fontSize: '0.8rem',
                      }}>
                        {row.stem}
                      </div>
                      {row.concept_name && (
                        <div style={{
                          fontFamily: 'var(--font-mono)', fontSize: '0.62rem',
                          color: 'var(--text-dim)', marginTop: 3, letterSpacing: '0.04em',
                        }}>
                          {row.concept_name}
                        </div>
                      )}
                    </td>

                    {/* Level */}
                    <td style={{ textAlign: 'center', padding: '10px 8px', whiteSpace: 'nowrap' }}>
                      <span style={{
                        fontFamily: 'var(--font-mono)', fontSize: '0.68rem', fontWeight: 700,
                        padding: '2px 6px', borderRadius: 99,
                        color: 'var(--accent)', background: 'var(--accent-dim)',
                      }}>
                        L{row.level}
                      </span>
                    </td>

                    {/* Attempts */}
                    <td style={{ textAlign: 'center', padding: '10px 8px', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
                      {row.total_attempts}
                    </td>

                    {/* Difficulty */}
                    <td style={{ textAlign: 'center', padding: '10px 8px' }}>
                      <span style={{
                        fontFamily: 'var(--font-mono)', fontWeight: 700,
                        fontSize: '0.8rem',
                        color: row.total_attempts > 0 ? difficultyColor(row.difficulty_index) : 'var(--text-dim)',
                      }}>
                        {row.total_attempts > 0 ? pct(row.difficulty_index) : '—'}
                      </span>
                    </td>

                    {/* Discrimination */}
                    <td style={{ textAlign: 'center', padding: '10px 8px' }}>
                      <span style={{
                        fontFamily: 'var(--font-mono)', fontWeight: 700,
                        fontSize: '0.8rem',
                        color: row.total_attempts > 0 ? discriminationColor(row.discrimination_index) : 'var(--text-dim)',
                      }}>
                        {row.total_attempts > 0 ? row.discrimination_index.toFixed(2) : '—'}
                      </span>
                    </td>

                    {/* Avg time */}
                    <td style={{ textAlign: 'center', padding: '10px 8px', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', fontSize: '0.76rem' }}>
                      {row.total_attempts > 0 ? formatMs(row.avg_time_ms) : '—'}
                    </td>

                    {/* Flags */}
                    <td style={{ textAlign: 'center', padding: '10px 8px' }}>
                      {row.flag_count > 0 ? (
                        <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                          <span style={{
                            fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '0.8rem',
                            color: 'var(--amber)',
                          }}>
                            {row.flag_count}
                          </span>
                          <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', lineHeight: 1.3 }}>
                            {Object.entries(row.flag_reasons).map(([reason, count]) => (
                              <div key={reason}>{String(count)}× {reason.replace(/_/g, ' ')}</div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <span style={{ color: 'var(--text-disabled)', fontFamily: 'var(--font-mono)' }}>—</span>
                      )}
                    </td>

                    {/* Helpful % */}
                    <td style={{ textAlign: 'center', padding: '10px 8px' }}>
                      {row.helpful_pct != null ? (
                        <span style={{
                          fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: '0.8rem',
                          color: row.helpful_pct >= 70 ? 'var(--green)' : row.helpful_pct >= 40 ? 'var(--amber)' : 'var(--red)',
                        }}>
                          {row.helpful_pct}%
                        </span>
                      ) : (
                        <span style={{ color: 'var(--text-disabled)', fontFamily: 'var(--font-mono)' }}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Legend */}
      {!loading && !error && visible.length > 0 && (
        <div style={{
          marginTop: 20, padding: '12px 16px', borderRadius: 'var(--r2)',
          border: '1px solid var(--border)', background: 'var(--bg-raised)',
          display: 'flex', gap: 24, flexWrap: 'wrap',
          fontSize: '0.7rem', color: 'var(--text-dim)',
        }}>
          <span style={{ fontWeight: 700, color: 'var(--text-secondary)' }}>Color codes:</span>
          <span>
            <strong style={{ color: 'var(--red)' }}>Difficulty</strong> red = &lt;20% or &gt;80%
            &nbsp;·&nbsp;<span style={{ color: 'var(--amber)' }}>amber</span> = 20–35% or 65–80%
            &nbsp;·&nbsp;<span style={{ color: 'var(--green)' }}>green</span> = 35–65%
          </span>
          <span>
            <strong style={{ color: 'var(--red)' }}>Discrimination</strong> red = &lt;0.10
            &nbsp;·&nbsp;<span style={{ color: 'var(--amber)' }}>amber</span> = 0.10–0.20
            &nbsp;·&nbsp;<span style={{ color: 'var(--green)' }}>green</span> = ≥0.20
          </span>
        </div>
      )}
    </div>
  );
}
