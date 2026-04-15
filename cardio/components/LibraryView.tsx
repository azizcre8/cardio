'use client';

import { useRef, useState, useMemo } from 'react';
import type { PDF, Deck, Density, ProcessEvent } from '@/types';
import ProcessingLog from './ProcessingLog';
import LibrarySidebar, { buildDeckTree, descendantIds, findExamDeadline } from './LibrarySidebar';

interface Props {
  pdfs:                  PDF[];
  decks:                 Deck[];
  examDate:              string | null;
  onOpenConceptMap:      (pdfId: string) => void;
  onPdfsChange:          (pdfs: PDF[]) => void;
  onDecksChange:         (decks: Deck[]) => void;
  onProcessingComplete?: (pdfId: string) => void;
}

export default function LibraryView({
  pdfs, decks, examDate,
  onOpenConceptMap, onPdfsChange, onDecksChange, onProcessingComplete,
}: Props) {
  const [density,        setDensity]        = useState<Density>('standard');
  const [processing,     setProcessing]     = useState<string | null>(null);
  const [publishingId,   setPublishingId]   = useState<string | null>(null);
  const [joinSlug,       setJoinSlug]       = useState('');
  const [joinStatus,     setJoinStatus]     = useState<string | null>(null);
  const [logs,           setLogs]           = useState<ProcessEvent[]>([]);
  const [search,         setSearch]         = useState('');
  const [selectedDeckId, setSelectedDeckId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const daysLeft = examDate
    ? Math.ceil((new Date(examDate).getTime() - Date.now()) / 86_400_000)
    : null;

  // ── Tree state ──────────────────────────────────────────────────────────────

  const { nodeMap } = useMemo(() => buildDeckTree(decks, pdfs), [decks, pdfs]);

  // ── Filtered PDFs ───────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    let base = pdfs;

    // Filter by selected deck (include all descendants)
    if (selectedDeckId === '__uncategorized__') {
      base = base.filter(p => !p.deck_id);
    } else if (selectedDeckId) {
      const ids = descendantIds(selectedDeckId, nodeMap);
      base = base.filter(p => p.deck_id && ids.has(p.deck_id));
    }

    // Search filter
    if (search.trim()) {
      const q = search.toLowerCase();
      base = base.filter(p => getPdfDisplayName(p).toLowerCase().includes(q));
    }

    return base;
  }, [pdfs, selectedDeckId, nodeMap, search]);

  // ── Display name ────────────────────────────────────────────────────────────

  function getPdfDisplayName(pdf: PDF) {
    return pdf.shared_bank_title ?? pdf.display_name ?? pdf.name.replace(/\.pdf$/i, '');
  }

  async function refreshPdfsFromServer() {
    const res = await fetch('/api/pdfs');
    if (!res.ok) return;
    onPdfsChange(await res.json() as PDF[]);
  }

  function parseSharedSlug(input: string) {
    const trimmed = input.trim();
    if (!trimmed) return '';

    try {
      const url = new URL(trimmed);
      return url.searchParams.get('shared') ?? trimmed;
    } catch {
      return trimmed.replace(/^\/+/, '').replace(/^app\?shared=/, '').trim();
    }
  }

  async function publishPdf(pdf: PDF) {
    if (pdf.access_scope === 'shared') return;

    const defaultTitle = getPdfDisplayName(pdf);
    const title = window.prompt('Shared bank title:', defaultTitle)?.trim();
    if (!title) return;

    setPublishingId(pdf.id);
    setJoinStatus(null);

    try {
      const res = await fetch('/api/shared-banks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pdfId: pdf.id,
          title,
          visibility: 'public',
        }),
      });

      const data = await res.json().catch(() => null) as {
        bank?: { slug?: string | null };
        shareUrl?: string | null;
        error?: string;
      } | null;

      if (!res.ok) {
        throw new Error(data?.error ?? 'Failed to publish shared bank.');
      }

      if (data?.shareUrl && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(data.shareUrl);
      }

      await refreshPdfsFromServer();
      setJoinStatus(data?.shareUrl
        ? `Published. Share link copied: ${data.shareUrl}`
        : `Published shared bank ${data?.bank?.slug ?? ''}`.trim());
    } catch (error) {
      setJoinStatus(error instanceof Error ? error.message : 'Failed to publish shared bank.');
    } finally {
      setPublishingId(null);
    }
  }

  async function joinSharedBank() {
    const slug = parseSharedSlug(joinSlug);
    if (!slug) {
      setJoinStatus('Paste a shared-bank link or slug.');
      return;
    }

    setJoinStatus('Joining shared bank…');

    try {
      const res = await fetch(`/api/shared-banks/${encodeURIComponent(slug)}/join`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => null) as {
        bank?: { source_pdf_id?: string | null; title?: string | null };
        error?: string;
      } | null;

      if (!res.ok) throw new Error(data?.error ?? 'Failed to join shared bank.');

      await refreshPdfsFromServer();
      const sourcePdfId = data?.bank?.source_pdf_id;
      setJoinStatus(`Joined ${data?.bank?.title ?? slug}.`);
      setJoinSlug('');
      if (sourcePdfId) onOpenConceptMap(sourcePdfId);
    } catch (error) {
      setJoinStatus(error instanceof Error ? error.message : 'Failed to join shared bank.');
    }
  }

  // ── Upload ──────────────────────────────────────────────────────────────────

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
            // If a deck is selected, move the new PDF into it
            if (selectedDeckId && selectedDeckId !== '__uncategorized__') {
              await fetch(`/api/pdfs/${completedPdfId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deck_id: selectedDeckId }),
              });
            }
            const res = await fetch('/api/pdfs');
            if (res.ok) onPdfsChange(await res.json() as PDF[]);
            setProcessing(null);
          }
        } catch { /* ignore */ }
      }
    }
    setProcessing(null);
    if (completedPdfId && onProcessingComplete) {
      setTimeout(() => onProcessingComplete(completedPdfId!), 400);
    }
  }

  async function deletePdf(pdfId: string) {
    const pdf = pdfs.find(item => item.id === pdfId);
    if (!pdf || pdf.access_scope === 'shared') return;
    if (!confirm('Delete this PDF and all its questions?')) return;
    await fetch(`/api/pdfs/${pdfId}`, { method: 'DELETE' });
    onPdfsChange(pdfs.filter(p => p.id !== pdfId));
  }

  async function renamePdf(pdf: PDF) {
    if (pdf.access_scope === 'shared') return;
    const next = window.prompt('Rename:', getPdfDisplayName(pdf));
    if (!next?.trim() || next.trim() === getPdfDisplayName(pdf)) return;
    await fetch(`/api/pdfs/${pdf.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: next.trim() }),
    });
    onPdfsChange(pdfs.map(p => p.id === pdf.id ? { ...p, display_name: next.trim() } : p));
  }

  // ── Deck CRUD ───────────────────────────────────────────────────────────────

  async function handleCreateDeck(
    parentId: string | null, name: string, isExamBlock: boolean, dueDate: string | null,
  ) {
    const res = await fetch('/api/decks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parent_id: parentId, is_exam_block: isExamBlock, due_date: dueDate }),
    });
    if (res.ok) {
      const refreshed = await fetch('/api/decks');
      if (refreshed.ok) onDecksChange(await refreshed.json() as Deck[]);
    }
  }

  async function handleRenameDeck(id: string, name: string) {
    await fetch(`/api/decks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    onDecksChange(decks.map(d => d.id === id ? { ...d, name } : d));
  }

  async function handleDeleteDeck(id: string) {
    await fetch(`/api/decks/${id}`, { method: 'DELETE' });
    onDecksChange(decks.filter(d => d.id !== id));
    // PDFs in deleted deck become uncategorized
    onPdfsChange(pdfs.map(p => p.deck_id === id ? { ...p, deck_id: null } : p));
    if (selectedDeckId === id) setSelectedDeckId(null);
  }

  async function handleMoveDeck(id: string, newParentId: string | null) {
    await fetch(`/api/decks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent_id: newParentId }),
    });
    onDecksChange(decks.map(d => d.id === id ? { ...d, parent_id: newParentId } : d));
  }

  async function handleMovePdf(pdfId: string, deckId: string | null) {
    const pdf = pdfs.find(item => item.id === pdfId);
    if (!pdf || pdf.access_scope === 'shared') return;

    await fetch(`/api/pdfs/${pdfId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deck_id: deckId }),
    });
    onPdfsChange(pdfs.map(p => p.id === pdfId ? { ...p, deck_id: deckId } : p));
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  const ready  = pdfs.filter(p => p.processed_at);
  const totalQ = ready.reduce((s, p) => s + (p.question_count ?? 0), 0);

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 56px)', overflow: 'hidden' }}>

      {/* ── Left sidebar ── */}
      <LibrarySidebar
        decks={decks}
        pdfs={pdfs}
        selectedDeckId={selectedDeckId}
        onSelectDeck={setSelectedDeckId}
        onCreateDeck={handleCreateDeck}
        onRenameDeck={handleRenameDeck}
        onDeleteDeck={handleDeleteDeck}
        onMoveDeck={handleMoveDeck}
        onMovePdf={handleMovePdf}
      />

      {/* ── Main content ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>

        {/* Exam countdown */}
        {daysLeft !== null && (
          <div style={{
            marginBottom: '14px', padding: '7px 12px',
            borderRadius: 'var(--radius-md)',
            fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.04em',
            background: daysLeft <= 3 ? 'rgba(220,38,38,0.08)' : 'var(--accent-dim)',
            color:      daysLeft <= 3 ? 'var(--red)' : 'var(--accent)',
            border:     `1px solid ${daysLeft <= 3 ? 'rgba(220,38,38,0.2)' : 'rgba(13,154,170,0.2)'}`,
          }}>
            {daysLeft > 0 ? `${daysLeft} days until exam` : 'Exam day!'}
          </div>
        )}

        {/* Stats bar */}
        {ready.length > 0 && (
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)',
            gap: '10px', marginBottom: '20px',
          }}>
            {[
              { n: ready.length,            label: 'Active Decks',    color: 'var(--accent)' },
              { n: totalQ.toLocaleString(), label: 'Total Questions', color: 'var(--text-secondary)' },
            ].map(({ n, label, color }) => (
              <div key={label} style={{
                background: 'var(--bg-raised)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius-lg)', padding: '12px 14px',
              }}>
                <div style={{
                  fontFamily: "'Source Serif 4', Georgia, serif",
                  fontSize: '1.6rem', fontWeight: 300, color,
                  letterSpacing: '-0.04em', lineHeight: 1, marginBottom: '4px',
                }}>{n}</div>
                <div style={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>{label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
          {/* Search */}
          <div style={{ flex: 1, position: 'relative' }}>
            <svg style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)', pointerEvents: 'none' }}
              width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="8.5" cy="8.5" r="5.5" /><line x1="13" y1="13" x2="17.5" y2="17.5" />
            </svg>
            <input
              type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search decks…"
              style={{
                width: '100%', height: '34px', paddingLeft: '32px', paddingRight: '12px',
                borderRadius: 'var(--radius-md)', fontSize: '0.82rem',
                background: 'var(--bg-raised)', border: '1px solid var(--border)',
                color: 'var(--text-primary)', outline: 'none',
              }}
              onFocus={e  => (e.currentTarget.style.borderColor = 'var(--accent)')}
              onBlur={e   => (e.currentTarget.style.borderColor = 'var(--border)')}
            />
          </div>

          {/* Density */}
          <select
            value={density} onChange={e => setDensity(e.target.value as Density)}
            style={{
              height: '34px', padding: '0 10px',
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
              height: '34px', padding: '0 16px',
              borderRadius: 'var(--radius-md)', fontSize: '0.78rem', fontWeight: 600,
              background: 'var(--accent)', color: 'white', border: 'none',
              cursor: processing ? 'not-allowed' : 'pointer',
              opacity: processing ? 0.6 : 1, whiteSpace: 'nowrap',
            }}
          >
            {processing ? 'Processing…' : '+ Upload PDF'}
          </button>
          <input ref={fileInputRef} type="file" accept=".pdf" style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); e.target.value = ''; }} />

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: '320px', flex: '1 1 320px' }}>
            <input
              type="text"
              value={joinSlug}
              onChange={e => setJoinSlug(e.target.value)}
              placeholder="Paste shared bank link or slug"
              style={{
                flex: 1,
                height: '34px',
                padding: '0 12px',
                borderRadius: 'var(--radius-md)',
                fontSize: '0.78rem',
                background: 'var(--bg-raised)',
                border: '1px solid var(--border)',
                color: 'var(--text-primary)',
                outline: 'none',
              }}
            />
            <button
              onClick={() => { void joinSharedBank(); }}
              style={{
                height: '34px', padding: '0 14px',
                borderRadius: 'var(--radius-md)', fontSize: '0.78rem', fontWeight: 600,
                background: 'var(--bg-sunken)', color: 'var(--text-secondary)', border: '1px solid var(--border)',
                cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              Join Bank
            </button>
          </div>
        </div>

        {joinStatus && (
          <div style={{
            marginBottom: '16px',
            padding: '10px 12px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--bg-raised)',
            border: '1px solid var(--border)',
            fontSize: '0.76rem',
            color: 'var(--text-secondary)',
          }}>
            {joinStatus}
          </div>
        )}

        {/* Processing log */}
        {logs.length > 0 && (
          <div style={{ marginBottom: '20px', animation: 'fade-up 0.3s ease' }}>
            <ProcessingLog events={logs} />
          </div>
        )}

        {/* Deck grid */}
        {pdfs.length === 0 ? (
          <EmptyState onUpload={() => fileInputRef.current?.click()} />
        ) : search.trim() && filtered.length === 0 ? (
          <p style={{ textAlign: 'center', padding: '40px', fontSize: '0.85rem', color: 'var(--text-dim)' }}>
            No decks match &ldquo;{search}&rdquo;
          </p>
        ) : filtered.length === 0 ? (
          <p style={{ textAlign: 'center', padding: '40px', fontSize: '0.85rem', color: 'var(--text-dim)' }}>
            No PDFs in this folder yet. Upload one or drag an existing PDF here.
          </p>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(264px, 1fr))',
            gap: '12px',
          }}>
            {filtered.map(pdf => (
              <DeckCard
                key={pdf.id}
                pdf={pdf}
                displayName={getPdfDisplayName(pdf)}
                examDeadline={findExamDeadline(pdf.deck_id, nodeMap)}
                deckName={pdf.deck_id ? nodeMap.get(pdf.deck_id)?.name ?? '' : ''}
                onStudy={onOpenConceptMap}
                onDelete={deletePdf}
                onRename={renamePdf}
                onPublish={publishPdf}
                isPublishing={publishingId === pdf.id}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Deck card ────────────────────────────────────────────────────────────────

function DeckCard({
  pdf, displayName, examDeadline, deckName,
  onStudy, onDelete, onRename, onPublish, isPublishing,
}: {
  pdf:          PDF;
  displayName:  string;
  examDeadline: string | null;
  deckName:     string;
  onStudy:      (id: string) => void;
  onDelete:     (id: string) => void;
  onRename:     (pdf: PDF) => void;
  onPublish:    (pdf: PDF) => void;
  isPublishing: boolean;
}) {
  const [hov, setHov] = useState(false);
  const isOwned = pdf.access_scope !== 'shared';
  const isShared = !isOwned;

  const total    = pdf.question_count ?? 0;
  const category = isShared
    ? 'SHARED BANK'
    : (pdf.name.split(/[\s_-]/)[0] ?? 'General').toUpperCase();

  let examBadge: React.ReactNode = null;
  if (examDeadline) {
    const days  = Math.ceil((new Date(examDeadline).getTime() - Date.now()) / 86_400_000);
    const color = days <= 0 ? '#ef4444' : days <= 7 ? '#f97316' : days <= 21 ? '#f59e0b' : '#6b7280';
    const label = days <= 0 ? 'Overdue' : days === 1 ? 'Due tomorrow' : `${days}d`;
    examBadge = (
      <span style={{
        fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.06em',
        padding: '1px 6px', borderRadius: '99px',
        background: `${color}18`, color, border: `1px solid ${color}44`,
      }}>
        📅 {label}
      </span>
    );
  }

  return (
    <div
      style={{
        background:   'var(--bg-raised)',
        borderTop:    pdf.processed_at ? '3px solid var(--accent)' : '3px solid var(--border)',
        borderRight:  `1px solid ${hov ? 'var(--border-med)' : 'var(--border)'}`,
        borderBottom: `1px solid ${hov ? 'var(--border-med)' : 'var(--border)'}`,
        borderLeft:   `1px solid ${hov ? 'var(--border-med)' : 'var(--border)'}`,
        borderRadius: 'var(--radius-lg)',
        padding: '16px',
        transition: 'box-shadow 0.15s, border-color 0.15s',
        boxShadow: hov ? 'var(--shadow-md)' : 'none',
        cursor: 'default',
      }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
    >
      {/* Top row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', marginBottom: '10px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Category + deck */}
          <p style={{ fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.1em', color: 'var(--text-dim)', marginBottom: '3px', textTransform: 'uppercase' }}>
            {category}{deckName ? ` · ${deckName}` : ''}
          </p>
          {/* Name */}
          <p style={{
            fontSize: '0.88rem', fontWeight: 700,
            color: 'var(--text-primary)', letterSpacing: '-0.01em',
            lineHeight: 1.2, marginBottom: '4px',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }} title={displayName}>
            {displayName}
          </p>
          {/* Sub stats */}
          <div style={{ display: 'flex', gap: '12px', fontSize: '0.71rem' }}>
            <span style={{ color: 'var(--text-dim)' }}>{total} questions</span>
            {pdf.concept_count != null && (
              <span style={{ color: 'var(--text-dim)' }}>{pdf.concept_count} concepts</span>
            )}
          </div>
        </div>

        {isOwned && (
          <div style={{ opacity: hov ? 1 : 0, transition: 'opacity 0.15s', flexShrink: 0 }}>
            <MetaBtn title="Rename" onClick={() => onRename(pdf)}>✎</MetaBtn>
          </div>
        )}
      </div>

      {(isShared || pdf.shared_bank_slug) && (
        <div style={{ display: 'flex', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
          {isShared && (
            <span style={{
              fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.06em',
              padding: '1px 6px', borderRadius: '99px',
              background: 'var(--accent-dim)', color: 'var(--accent)', border: '1px solid rgba(13,154,170,0.22)',
            }}>
              Shared
            </span>
          )}
          {pdf.shared_bank_slug && (
            <span style={{
              fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.06em',
              padding: '1px 6px', borderRadius: '99px',
              background: 'var(--bg-sunken)', color: 'var(--text-dim)', border: '1px solid var(--border)',
            }}>
              /{pdf.shared_bank_slug}
            </span>
          )}
        </div>
      )}

      {/* Exam deadline badge */}
      {examBadge && <div style={{ marginBottom: '10px' }}>{examBadge}</div>}

      {/* Actions */}
      <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
        {pdf.processed_at ? (
          <button
            onClick={() => onStudy(pdf.id)}
            style={{
              flex: 1, padding: '7px', borderRadius: 'var(--radius-md)',
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
          <span style={{ flex: 1, padding: '7px', textAlign: 'center', fontSize: '0.75rem', color: 'var(--text-dim)' }}>
            Processing…
          </span>
        )}
        {isOwned ? (
          pdf.shared_bank_slug ? (
            <button
              onClick={() => onPublish(pdf)}
              style={{
                padding: '7px 12px', borderRadius: 'var(--radius-md)',
                background: 'var(--bg-sunken)', border: '1px solid var(--border)',
                color: 'var(--text-dim)', fontSize: '0.75rem', fontWeight: 500, cursor: 'pointer',
              }}
            >
              {isPublishing ? 'Sharing…' : 'Share'}
            </button>
          ) : (
            <button
              onClick={() => onPublish(pdf)}
              style={{
                padding: '7px 12px', borderRadius: 'var(--radius-md)',
                background: 'var(--bg-sunken)', border: '1px solid var(--border)',
                color: 'var(--text-dim)', fontSize: '0.75rem', fontWeight: 500, cursor: 'pointer',
              }}
            >
              {isPublishing ? 'Publishing…' : 'Publish'}
            </button>
          )
        ) : null}
        {isOwned && (
          <button
            onClick={() => onDelete(pdf.id)}
            style={{
              padding: '7px 12px', borderRadius: 'var(--radius-md)',
              background: 'var(--bg-sunken)', border: '1px solid var(--border)',
              color: 'var(--text-dim)', fontSize: '0.75rem', fontWeight: 500, cursor: 'pointer',
            }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--red)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ onUpload }: { onUpload: () => void }) {
  return (
    <div style={{ textAlign: 'center', padding: '64px 20px' }}>
      <div style={{ fontSize: '3rem', marginBottom: '16px', animation: 'float 3s ease-in-out infinite' }}>📖</div>
      <p style={{ fontWeight: 600, marginBottom: '6px', color: 'var(--text-primary)' }}>No chapters yet</p>
      <p style={{ fontSize: '0.85rem', marginBottom: '20px', color: 'var(--text-dim)' }}>
        Upload a PDF to generate a full question bank in 10–15 minutes.
      </p>
      <button
        onClick={onUpload}
        style={{
          padding: '10px 28px', borderRadius: 'var(--radius-md)',
          background: 'var(--accent)', color: 'white',
          fontSize: '0.875rem', fontWeight: 600, border: 'none', cursor: 'pointer',
        }}
      >
        Upload your first PDF
      </button>
    </div>
  );
}

// ─── MetaBtn ──────────────────────────────────────────────────────────────────

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
