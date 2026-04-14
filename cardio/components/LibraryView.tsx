'use client';

import { useRef, useState, useEffect } from 'react';
import type { PDF, Density, ProcessEvent } from '@/types';
import ProcessingLog from './ProcessingLog';

interface Props {
  pdfs:                  PDF[];
  examDate:              string | null;
  userId:                string;
  onOpenConceptMap:      (pdfId: string) => void;
  onPdfsChange:          (pdfs: PDF[]) => void;
  onProcessingComplete?: (pdfId: string) => void;
}

/* ── localStorage deck meta ── */
interface DeckMeta { displayName?: string; folder?: string; }
function getDeckMeta(pdfId: string): DeckMeta {
  if (typeof window === 'undefined') return {};
  try { return JSON.parse(localStorage.getItem('cardio_deck_meta') ?? '{}')[pdfId] ?? {}; } catch { return {}; }
}
function setDeckMeta(pdfId: string, updates: DeckMeta) {
  if (typeof window === 'undefined') return;
  try {
    const all = JSON.parse(localStorage.getItem('cardio_deck_meta') ?? '{}');
    all[pdfId] = { ...getDeckMeta(pdfId), ...updates };
    localStorage.setItem('cardio_deck_meta', JSON.stringify(all));
  } catch { /* ignore */ }
}

export default function LibraryView({ pdfs, examDate, userId, onOpenConceptMap, onPdfsChange, onProcessingComplete }: Props) {
  const [density,    setDensity]    = useState<Density>('standard');
  const [processing, setProcessing] = useState<string | null>(null);
  const [logs,       setLogs]       = useState<ProcessEvent[]>([]);
  const [search,     setSearch]     = useState('');
  const [, forceRender]             = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const daysLeft = examDate
    ? Math.ceil((new Date(examDate).getTime() - Date.now()) / 86_400_000)
    : null;

  function getDeckName(pdf: PDF)   { return getDeckMeta(pdf.id).displayName ?? pdf.name.replace(/\.pdf$/i, ''); }
  function getDeckFolder(pdf: PDF) { return getDeckMeta(pdf.id).folder ?? ''; }

  function renameDeck(pdf: PDF) {
    const next = window.prompt('Rename deck:', getDeckName(pdf));
    if (next?.trim() && next.trim() !== getDeckName(pdf)) {
      setDeckMeta(pdf.id, { displayName: next.trim() });
      forceRender(n => n + 1);
    }
  }
  function moveDeckToFolder(pdf: PDF) {
    const next = window.prompt('Assign folder (blank to remove):', getDeckFolder(pdf));
    if (next !== null) { setDeckMeta(pdf.id, { folder: next.trim() }); forceRender(n => n + 1); }
  }

  async function handleUpload(file: File) {
    setLogs([]);
    const form = new FormData();
    form.append('pdf', file);
    form.append('density', density);

    const resp = await fetch('/api/process', { method: 'POST', body: form });
    if (!resp.ok) {
      const txt = await resp.text();
      setLogs([{ phase: 0, message: `Upload failed: ${txt}`, pct: 0 }]);
      return;
    }

    setProcessing('__uploading__');
    const reader = resp.body!.getReader();
    const dec    = new TextDecoder();
    let buf      = '';
    let completedPdfId: string | null = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.replace(/^data: /, '').trim();
        if (!trimmed) continue;
        try {
          const ev: ProcessEvent = JSON.parse(trimmed);
          setLogs(prev => [...prev, ev]);
          if (ev.phase === 7 && ev.data?.pdfId) {
            completedPdfId = ev.data.pdfId as string;
            const res = await fetch('/api/pdfs');
            if (res.ok) onPdfsChange(await res.json() as PDF[]);
            setProcessing(null);
          }
        } catch { /* ignore */ }
      }
    }
    setProcessing(null);
    /* Navigate to concept map after short delay so PDF list updates first */
    if (completedPdfId && onProcessingComplete) {
      setTimeout(() => onProcessingComplete(completedPdfId!), 400);
    }
  }

  async function deletePdf(pdfId: string) {
    if (!confirm('Delete this PDF and all its questions?')) return;
    await fetch(`/api/pdfs/${pdfId}`, { method: 'DELETE' });
    onPdfsChange(pdfs.filter(p => p.id !== pdfId));
  }

  const ready  = pdfs.filter(p => p.processed_at);
  const totalQ = ready.reduce((s, p) => s + (p.question_count ?? 0), 0);

  const filtered = search.trim()
    ? pdfs.filter(p => getDeckName(p).toLowerCase().includes(search.toLowerCase()))
    : pdfs;

  const folderMap = new Map<string, PDF[]>();
  filtered.forEach(pdf => {
    const f = getDeckFolder(pdf) || '';
    if (!folderMap.has(f)) folderMap.set(f, []);
    folderMap.get(f)!.push(pdf);
  });
  const folderOrder = Array.from(folderMap.keys()).sort((a, b) =>
    a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)
  );

  return (
    <div style={{ maxWidth: '900px', margin: '0 auto' }}>

      {/* ── Exam countdown ── */}
      {daysLeft !== null && (
        <div style={{
          marginBottom: '16px', padding: '8px 14px',
          borderRadius: 'var(--radius-md)',
          fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.04em',
          background: daysLeft <= 3 ? 'rgba(220,38,38,0.08)' : 'var(--accent-dim)',
          color:      daysLeft <= 3 ? 'var(--red)' : 'var(--accent)',
          border:     `1px solid ${daysLeft <= 3 ? 'rgba(220,38,38,0.2)' : 'rgba(13,154,170,0.2)'}`,
        }}>
          {daysLeft > 0 ? `${daysLeft} days until exam` : 'Exam day!'}
        </div>
      )}

      {/* ── Dashboard stats bar ── */}
      {ready.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: '10px', marginBottom: '24px',
        }}>
          {[
            { n: ready.length,             label: 'Active Decks', color: 'var(--accent)'          },
            { n: totalQ.toLocaleString(),  label: 'Total Questions', color: 'var(--text-secondary)' },
          ].map(({ n, label, color }) => (
            <div key={label} style={{
              background: 'var(--bg-raised)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-lg)', padding: '14px 16px',
            }}>
              <div style={{
                fontFamily: "'Source Serif 4', Georgia, serif",
                fontSize: '1.8rem', fontWeight: 300, color,
                letterSpacing: '-0.04em', lineHeight: 1, marginBottom: '5px',
              }}>
                {n}
              </div>
              <div style={{ fontSize: '0.63rem', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>
                {label}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Search + upload toolbar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
        {/* Search */}
        <div style={{ flex: 1, position: 'relative' }}>
          <svg
            style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)', pointerEvents: 'none' }}
            width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8"
          >
            <circle cx="8.5" cy="8.5" r="5.5" /><line x1="13" y1="13" x2="17.5" y2="17.5" />
          </svg>
          <input
            type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search decks…"
            style={{
              width: '100%', height: '36px', paddingLeft: '32px', paddingRight: '12px',
              borderRadius: 'var(--radius-md)', fontSize: '0.82rem',
              background: 'var(--bg-raised)', border: '1px solid var(--border)',
              color: 'var(--text-primary)', outline: 'none',
            }}
            onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
            onBlur={e  => (e.currentTarget.style.borderColor = 'var(--border)')}
          />
        </div>

        {/* Density */}
        <select
          value={density} onChange={e => setDensity(e.target.value as Density)}
          style={{
            height: '36px', padding: '0 10px',
            borderRadius: 'var(--radius-md)', fontSize: '0.78rem',
            background: 'var(--bg-raised)', border: '1px solid var(--border)',
            color: 'var(--text-secondary)', outline: 'none', cursor: 'pointer',
          }}
        >
          <option value="standard">Standard</option>
          <option value="comprehensive">Comprehensive</option>
          <option value="boards">Boards</option>
        </select>

        {/* Upload */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={!!processing}
          style={{
            height: '36px', padding: '0 18px',
            borderRadius: 'var(--radius-md)', fontSize: '0.78rem', fontWeight: 600,
            background: 'var(--accent)', color: 'white', border: 'none',
            cursor: processing ? 'not-allowed' : 'pointer',
            opacity: processing ? 0.6 : 1, whiteSpace: 'nowrap',
          }}
        >
          {processing ? 'Processing…' : '+ Upload PDF'}
        </button>
        <input
          ref={fileInputRef} type="file" accept=".pdf"
          style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); e.target.value = ''; }}
        />
      </div>

      {/* Processing animation */}
      {logs.length > 0 && (
        <div style={{ marginBottom: '20px', animation: 'fade-up 0.3s ease' }}>
          <ProcessingLog events={logs} />
        </div>
      )}

      {/* ── Deck list ── */}
      {pdfs.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '64px 20px' }}>
          <div style={{ fontSize: '3rem', marginBottom: '16px', animation: 'float 3s ease-in-out infinite' }}>📖</div>
          <p style={{ fontWeight: 600, marginBottom: '6px', color: 'var(--text-primary)' }}>No chapters yet</p>
          <p style={{ fontSize: '0.85rem', marginBottom: '20px', color: 'var(--text-dim)' }}>
            Upload a PDF to generate a full question bank in 10–15 minutes.
          </p>
          <button
            onClick={() => fileInputRef.current?.click()}
            style={{
              padding: '10px 28px', borderRadius: 'var(--radius-md)',
              background: 'var(--accent)', color: 'white',
              fontSize: '0.875rem', fontWeight: 600, border: 'none', cursor: 'pointer',
            }}
          >
            Upload your first PDF
          </button>
        </div>
      ) : search.trim() && filtered.length === 0 ? (
        <p style={{ textAlign: 'center', padding: '40px', fontSize: '0.85rem', color: 'var(--text-dim)' }}>
          No decks match &ldquo;{search}&rdquo;
        </p>
      ) : (
        folderOrder.map(folder => (
          <div key={folder}>
            {folder && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                padding: '16px 0 8px', marginBottom: '8px',
                borderBottom: '1px solid var(--border)',
                fontSize: '0.62rem', fontWeight: 800,
                letterSpacing: '0.14em', textTransform: 'uppercase',
                color: 'var(--accent)',
              }}>
                <span style={{ opacity: 0.6 }}>▸</span>
                {folder}
                <span style={{
                  marginLeft: 'auto', fontWeight: 600,
                  fontSize: '0.6rem', padding: '1px 7px', borderRadius: '99px',
                  background: 'var(--bg-sunken)', border: '1px solid var(--border)', color: 'var(--text-dim)',
                }}>
                  {folderMap.get(folder)!.length}
                </span>
              </div>
            )}

            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: '12px',
            }}>
              {folderMap.get(folder)!.map(pdf => (
                <DeckCard
                  key={pdf.id}
                  pdf={pdf}
                  displayName={getDeckName(pdf)}
                  folder={getDeckFolder(pdf)}
                  onStudy={onOpenConceptMap}
                  onDelete={deletePdf}
                  onRename={renameDeck}
                  onFolder={moveDeckToFolder}
                />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

/* ── Deck card ── */
function DeckCard({
  pdf, displayName, folder, onStudy, onDelete, onRename, onFolder,
}: {
  pdf:         PDF;
  displayName: string;
  folder:      string;
  onStudy:     (id: string) => void;
  onDelete:    (id: string) => void;
  onRename:    (pdf: PDF) => void;
  onFolder:    (pdf: PDF) => void;
}) {
  const [hov, setHov] = useState(false);
  const total    = pdf.question_count ?? 0;
  const category = (pdf.name.split(/[\s_-]/)[0] ?? 'General').toUpperCase();

  return (
    <div
      style={{
        background:  'var(--bg-raised)',
        borderTop:    pdf.processed_at ? `3px solid var(--accent)` : '3px solid var(--border)',
        borderRight:  `1px solid ${hov ? 'var(--border-med)' : 'var(--border)'}`,
        borderBottom: `1px solid ${hov ? 'var(--border-med)' : 'var(--border)'}`,
        borderLeft:   `1px solid ${hov ? 'var(--border-med)' : 'var(--border)'}`,
        borderRadius: 'var(--radius-lg)',
        padding:     '18px',
        transition:  'box-shadow 0.15s, border-color 0.15s',
        boxShadow:   hov ? 'var(--shadow-md)' : 'none',
        cursor:      'default',
      }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
    >
      {/* Top row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', marginBottom: '12px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Category */}
          <p style={{ fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.1em', color: 'var(--text-dim)', marginBottom: '3px', textTransform: 'uppercase' }}>
            {category}
            {folder && ` · ${folder}`}
          </p>
          {/* Name */}
          <p style={{
            fontSize: '0.9rem', fontWeight: 700,
            color: 'var(--text-primary)', letterSpacing: '-0.01em',
            lineHeight: 1.2, marginBottom: '4px',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }} title={displayName}>
            {displayName}
          </p>
          {/* Sub stats */}
          <div style={{ display: 'flex', gap: '12px', fontSize: '0.72rem' }}>
            <span style={{ color: 'var(--text-dim)' }}>
              {total} questions
            </span>
            {pdf.concept_count != null && (
              <span style={{ color: 'var(--text-dim)' }}>
                {pdf.concept_count} concepts
              </span>
            )}
          </div>
        </div>

        {/* Meta buttons (hover) */}
        <div style={{ display: 'flex', gap: '4px', flexShrink: 0, opacity: hov ? 1 : 0, transition: 'opacity 0.15s' }}>
          <MetaBtn title="Rename" onClick={() => onRename(pdf)}>✎</MetaBtn>
          <MetaBtn title="Move to folder" onClick={() => onFolder(pdf)}>⊞</MetaBtn>
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        {pdf.processed_at ? (
          <button
            onClick={() => onStudy(pdf.id)}
            style={{
              flex: 1, padding: '8px', borderRadius: 'var(--radius-md)',
              background: 'var(--accent)', color: 'white',
              fontSize: '0.78rem', fontWeight: 600, border: 'none', cursor: 'pointer',
              transition: 'opacity 0.15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '0.88')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
          >
            View Concepts →
          </button>
        ) : (
          <span style={{ flex: 1, padding: '8px', textAlign: 'center', fontSize: '0.75rem', color: 'var(--text-dim)' }}>
            Processing…
          </span>
        )}
        <button
          onClick={() => onDelete(pdf.id)}
          style={{
            padding: '8px 12px', borderRadius: 'var(--radius-md)',
            background: 'var(--bg-sunken)', border: '1px solid var(--border)',
            color: 'var(--text-dim)', fontSize: '0.75rem', fontWeight: 500,
            cursor: 'pointer', transition: 'color 0.15s',
          }}
          onMouseEnter={e => (e.currentTarget.style.color = 'var(--red)')}
          onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
        >
          Delete
        </button>
      </div>
    </div>
  );
}


function MetaBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      title={title}
      onClick={e => { e.stopPropagation(); onClick(); }}
      style={{
        width: '26px', height: '26px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: 'var(--radius-sm)',
        background: hov ? 'var(--accent-dim)' : 'var(--bg-sunken)',
        border: `1px solid ${hov ? 'rgba(13,154,170,0.3)' : 'var(--border)'}`,
        color: hov ? 'var(--accent)' : 'var(--text-dim)',
        fontSize: '0.85rem', cursor: 'pointer', transition: 'all 0.15s',
      }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
    >
      {children}
    </button>
  );
}
