'use client';

import { useRef, useState, useEffect } from 'react';
import type { PDF, Density, ProcessEvent } from '@/types';
import ProcessingLog from './ProcessingLog';

interface Props {
  pdfs:           PDF[];
  examDate:       string | null;
  userId:         string;
  onStartStudy:   (pdfId: string) => void;
  onPdfsChange:   (pdfs: PDF[]) => void;
}

/* ── localStorage deck meta (rename + folder) ── */
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

export default function LibraryView({ pdfs, examDate, userId, onStartStudy, onPdfsChange }: Props) {
  const [density,    setDensity]    = useState<Density>('standard');
  const [processing, setProcessing] = useState<string | null>(null);
  const [logs,       setLogs]       = useState<ProcessEvent[]>([]);
  const [search,     setSearch]     = useState('');
  const [, forceRender]             = useState(0); // trigger re-render after meta update
  const fileInputRef = useRef<HTMLInputElement>(null);

  const daysLeft = examDate
    ? Math.ceil((new Date(examDate).getTime() - Date.now()) / 86_400_000)
    : null;

  function getDeckName(pdf: PDF): string {
    return getDeckMeta(pdf.id).displayName ?? pdf.name.replace(/\.pdf$/i, '');
  }
  function getDeckFolder(pdf: PDF): string {
    return getDeckMeta(pdf.id).folder ?? '';
  }

  function renameDeck(pdf: PDF) {
    const cur = getDeckName(pdf);
    const next = window.prompt('Rename deck:', cur);
    if (next && next.trim() && next.trim() !== cur) {
      setDeckMeta(pdf.id, { displayName: next.trim() });
      forceRender(n => n + 1);
    }
  }
  function moveDeckToFolder(pdf: PDF) {
    const cur = getDeckFolder(pdf);
    const next = window.prompt('Assign folder (blank to remove):', cur);
    if (next !== null) {
      setDeckMeta(pdf.id, { folder: next.trim() });
      forceRender(n => n + 1);
    }
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
            const res = await fetch('/api/pdfs');
            if (res.ok) onPdfsChange(await res.json() as PDF[]);
            setProcessing(null);
          }
        } catch { /* ignore */ }
      }
    }
    setProcessing(null);
  }

  async function deletePdf(pdfId: string) {
    if (!confirm('Delete this PDF and all its questions?')) return;
    await fetch(`/api/pdfs/${pdfId}`, { method: 'DELETE' });
    onPdfsChange(pdfs.filter(p => p.id !== pdfId));
  }

  const ready = pdfs.filter(p => p.processed_at);
  const totalQ = ready.reduce((s, p) => s + (p.question_count ?? 0), 0);

  // Search filter
  const filtered = search.trim()
    ? pdfs.filter(p => getDeckName(p).toLowerCase().includes(search.toLowerCase()))
    : pdfs;

  // Group by folder
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
    <div className="max-w-2xl mx-auto">

      {/* ── Exam countdown ── */}
      {daysLeft !== null && (
        <div
          className="mb-4 px-3 py-2 rounded-lg text-xs font-semibold tracking-wide"
          style={{
            background: daysLeft <= 3 ? 'rgba(220,38,38,0.08)' : 'rgba(13,154,170,0.07)',
            color:      daysLeft <= 3 ? 'var(--red)' : 'var(--accent)',
            border:     `1px solid ${daysLeft <= 3 ? 'rgba(220,38,38,0.2)' : 'rgba(13,154,170,0.2)'}`,
          }}
        >
          {daysLeft > 0 ? `${daysLeft} days until exam` : 'Exam day!'}
        </div>
      )}

      {/* ── Hero stats ── */}
      {ready.length > 0 && (
        <div className="grid grid-cols-2 gap-3 mb-5">
          <div
            className="rounded-2xl p-5"
            style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)', borderLeft: '3px solid var(--accent)' }}
          >
            <div
              className="font-serif leading-none mb-2"
              style={{ fontSize: '2.6rem', fontWeight: 300, color: 'var(--accent)', letterSpacing: '-0.05em' }}
            >
              {ready.length}
            </div>
            <div className="text-xs font-bold tracking-widest uppercase" style={{ color: 'var(--text-dim)' }}>
              Decks Ready
            </div>
          </div>
          <div
            className="rounded-2xl p-5"
            style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}
          >
            <div
              className="font-serif leading-none mb-2"
              style={{ fontSize: '2.6rem', fontWeight: 300, color: 'var(--text-secondary)', letterSpacing: '-0.05em' }}
            >
              {totalQ.toLocaleString()}
            </div>
            <div className="text-xs font-bold tracking-widest uppercase" style={{ color: 'var(--text-dim)' }}>
              Total Questions
            </div>
          </div>
        </div>
      )}

      {/* ── Search + upload toolbar ── */}
      <div className="flex items-center gap-2 mb-4">
        <div className="flex-1 relative">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none"
            style={{ color: 'var(--text-dim)' }}
            viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8"
          >
            <circle cx="8.5" cy="8.5" r="5.5"/><line x1="13" y1="13" x2="17.5" y2="17.5"/>
          </svg>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search decks…"
            className="w-full h-9 pl-9 pr-3 rounded-lg text-sm outline-none transition-all"
            style={{
              background: 'var(--bg-raised)',
              border:     '1px solid var(--border)',
              color:      'var(--text-primary)',
            }}
            onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
            onBlur={e  => (e.currentTarget.style.borderColor = 'var(--border)')}
          />
        </div>

        <select
          value={density}
          onChange={e => setDensity(e.target.value as Density)}
          className="h-9 px-2 rounded-lg text-xs outline-none"
          style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
        >
          <option value="standard">Standard</option>
          <option value="comprehensive">Comprehensive</option>
          <option value="boards">Boards</option>
        </select>

        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={!!processing}
          className="h-9 px-4 rounded-lg text-xs font-semibold tracking-wide whitespace-nowrap transition-colors disabled:opacity-50"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          {processing ? 'Processing…' : 'Upload PDF +'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf"
          className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); }}
        />
      </div>

      {/* Processing log */}
      {logs.length > 0 && (
        <div className="mb-4 rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)' }}>
          <ProcessingLog events={logs} />
        </div>
      )}

      {/* ── Deck list ── */}
      {pdfs.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-4xl mb-4">📖</div>
          <p className="font-medium mb-1" style={{ color: 'var(--text-primary)' }}>No chapters yet</p>
          <p className="text-sm mb-5" style={{ color: 'var(--text-dim)' }}>Upload a PDF to generate a full question bank in 10–15 minutes.</p>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-6 py-2.5 rounded-lg text-sm font-semibold text-white"
            style={{ background: 'var(--accent)' }}
          >
            Upload your first PDF
          </button>
        </div>
      ) : search.trim() && filtered.length === 0 ? (
        <p className="text-center py-10 text-sm" style={{ color: 'var(--text-dim)' }}>
          No decks match &ldquo;{search}&rdquo;
        </p>
      ) : (
        folderOrder.map(folder => (
          <div key={folder}>
            {folder && (
              <div
                className="flex items-center gap-2 pt-4 pb-2 mb-2 text-xs font-bold tracking-widest uppercase"
                style={{ color: 'var(--accent)', borderBottom: '1px solid var(--border)' }}
              >
                <span style={{ opacity: 0.7 }}>▸</span>
                {folder}
                <span
                  className="ml-auto font-normal text-[0.62rem] px-2 py-0.5 rounded-full"
                  style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border)', color: 'var(--text-dim)' }}
                >
                  {folderMap.get(folder)!.length}
                </span>
              </div>
            )}

            {folderMap.get(folder)!.map(pdf => (
              <DeckCard
                key={pdf.id}
                pdf={pdf}
                displayName={getDeckName(pdf)}
                folder={getDeckFolder(pdf)}
                onStudy={onStartStudy}
                onDelete={deletePdf}
                onRename={renameDeck}
                onFolder={moveDeckToFolder}
              />
            ))}
          </div>
        ))
      )}
    </div>
  );
}

/* ── Individual deck card ── */
function DeckCard({
  pdf, displayName, folder, onStudy, onDelete, onRename, onFolder
}: {
  pdf: PDF;
  displayName: string;
  folder: string;
  onStudy: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (pdf: PDF) => void;
  onFolder: (pdf: PDF) => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className="rounded-2xl mb-3 transition-shadow"
      style={{
        background:  'var(--bg-raised)',
        border:      '1px solid var(--border)',
        boxShadow:   hovered ? '0 4px 16px rgba(0,0,0,0.07)' : 'none',
        borderLeft:  pdf.processed_at ? '3px solid var(--accent)' : '1px solid var(--border)',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="p-5">
        {/* Top row */}
        <div className="flex items-start gap-3 mb-3">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center text-[0.55rem] font-bold tracking-wider flex-shrink-0"
            style={{ background: 'var(--accent-dim)', border: '1px solid rgba(13,154,170,0.2)', color: 'var(--accent)' }}
          >
            PDF
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p
                className="text-sm font-semibold truncate"
                style={{ color: 'var(--text-primary)', letterSpacing: '-0.01em' }}
                title={pdf.name}
              >
                {displayName}
              </p>
              {folder && (
                <span
                  className="text-[0.58rem] font-semibold tracking-wider uppercase px-2 py-0.5 rounded-full flex-shrink-0"
                  style={{ background: 'var(--accent-dim)', border: '1px solid rgba(13,154,170,0.2)', color: 'var(--accent)' }}
                >
                  {folder}
                </span>
              )}
            </div>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-dim)' }}>
              {pdf.concept_count ?? 0} concepts · {pdf.question_count ?? 0} questions · {pdf.density}
            </p>
          </div>
          {/* Meta buttons — visible on hover */}
          <div
            className="flex gap-1 flex-shrink-0 transition-opacity"
            style={{ opacity: hovered ? 1 : 0 }}
          >
            <MetaBtn title="Rename" onClick={() => onRename(pdf)}>✎</MetaBtn>
            <MetaBtn title="Move to folder" onClick={() => onFolder(pdf)}>⊞</MetaBtn>
          </div>
        </div>

        {/* Mastery bar */}
        <div className="h-1 rounded-full mb-4 overflow-hidden" style={{ background: 'var(--bg-sunken)' }}>
          <div
            className="h-full rounded-full transition-all"
            style={{ width: '0%', background: 'var(--accent)' }}
          />
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          {pdf.processed_at ? (
            <button
              onClick={() => onStudy(pdf.id)}
              className="flex-1 py-2 rounded-lg text-xs font-semibold tracking-wide text-white transition-opacity hover:opacity-90"
              style={{ background: 'var(--accent)' }}
            >
              Study →
            </button>
          ) : (
            <span className="flex-1 py-2 text-center text-xs" style={{ color: 'var(--text-dim)' }}>
              Processing…
            </span>
          )}
          <button
            onClick={() => onDelete(pdf.id)}
            className="px-3 py-2 rounded-lg text-xs font-medium transition-colors"
            style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border)', color: 'var(--text-dim)' }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--red)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
          >
            Delete
          </button>
        </div>
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
      className="w-7 h-7 flex items-center justify-center rounded-lg text-sm transition-colors"
      style={{
        background:  hov ? 'var(--accent-dim)' : 'var(--bg-sunken)',
        border:      `1px solid ${hov ? 'rgba(13,154,170,0.3)' : 'var(--border)'}`,
        color:       hov ? 'var(--accent)' : 'var(--text-dim)',
      }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
    >
      {children}
    </button>
  );
}
