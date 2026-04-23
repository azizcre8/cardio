'use client';

import { useRef, useState, useMemo } from 'react';
import type { PDF, Deck, Density, ProcessEvent } from '@/types';
import ProcessingLog from './ProcessingLog';
import LibrarySidebar, { buildDeckTree, descendantIds, findExamDeadline } from './LibrarySidebar';
import { MasteryBar, Eyebrow, Icon, Btn } from './ui';

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
  const [showJoinPanel,  setShowJoinPanel]  = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const daysLeft = examDate
    ? Math.ceil((new Date(examDate).getTime() - Date.now()) / 86_400_000)
    : null;

  const { nodeMap } = useMemo(() => buildDeckTree(decks, pdfs), [decks, pdfs]);

  const filtered = useMemo(() => {
    let base = pdfs;
    if (selectedDeckId === '__uncategorized__') {
      base = base.filter(p => !p.deck_id);
    } else if (selectedDeckId) {
      const ids = descendantIds(selectedDeckId, nodeMap);
      base = base.filter(p => p.deck_id && ids.has(p.deck_id));
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      base = base.filter(p => getPdfDisplayName(p).toLowerCase().includes(q));
    }
    return base;
  }, [pdfs, selectedDeckId, nodeMap, search]);

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
        body: JSON.stringify({ pdfId: pdf.id, title, visibility: 'public' }),
      });
      const data = await res.json().catch(() => null) as {
        bank?: { slug?: string | null };
        shareUrl?: string | null;
        error?: string;
      } | null;
      if (!res.ok) throw new Error(data?.error ?? 'Failed to publish shared bank.');
      if (data?.shareUrl && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(data.shareUrl);
      }
      await refreshPdfsFromServer();
      setJoinStatus(data?.shareUrl
        ? `Published. Link copied: ${data.shareUrl}`
        : `Published ${data?.bank?.slug ?? ''}`.trim());
    } catch (error) {
      setJoinStatus(error instanceof Error ? error.message : 'Failed to publish.');
    } finally {
      setPublishingId(null);
    }
  }

  async function joinSharedBank() {
    const slug = parseSharedSlug(joinSlug);
    if (!slug) { setJoinStatus('Paste a shared-bank link or slug.'); return; }
    setJoinStatus('Joining shared bank…');
    try {
      const res = await fetch(`/api/shared-banks/${encodeURIComponent(slug)}/join`, { method: 'POST' });
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
    let sawTerminalEvent = false;
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
            sawTerminalEvent = true;
            completedPdfId = ev.data.pdfId as string;
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
          } else if (ev.phase === 0) {
            sawTerminalEvent = true;
            setProcessing(null);
          }
        } catch { /* ignore */ }
      }
    }
    if (!sawTerminalEvent) {
      setLogs(prev => [...prev, { phase: 0, message: 'Stream ended before completion.', pct: 0 }]);
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

  const ready     = pdfs.filter(p => p.processed_at);
  const totalQ    = ready.reduce((s, p) => s + (p.question_count ?? 0), 0);
  const selectedDeck = selectedDeckId ? nodeMap.get(selectedDeckId) : null;

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '260px 1fr 280px',
      height: 'calc(100vh - 56px)',
      overflow: 'hidden',
    }}>
      {/* ── Left sidebar ── */}
      <div style={{ borderRight: '1px solid var(--border)', overflow: 'auto' }}>
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
      </div>

      {/* ── Center panel ── */}
      <div style={{ overflow: 'auto' }}>
        {pdfs.length === 0 ? (
          <EmptyState onUpload={() => fileInputRef.current?.click()} />
        ) : selectedDeck ? (
          <SubjectPanel
            deck={selectedDeck}
            pdfs={filtered}
            getPdfDisplayName={getPdfDisplayName}
            nodeMap={nodeMap}
            onStudy={onOpenConceptMap}
            onDelete={deletePdf}
            onRename={renamePdf}
            onPublish={publishPdf}
            onUpload={() => fileInputRef.current?.click()}
            publishingId={publishingId}
            processing={processing}
          />
        ) : (
          <TodayPanel
            pdfs={pdfs}
            filtered={filtered}
            search={search}
            onSearchChange={setSearch}
            density={density}
            onDensityChange={setDensity}
            processing={processing}
            onUpload={() => fileInputRef.current?.click()}
            onStudy={onOpenConceptMap}
            onDelete={deletePdf}
            onRename={renamePdf}
            onPublish={publishPdf}
            publishingId={publishingId}
            getPdfDisplayName={getPdfDisplayName}
            nodeMap={nodeMap}
            daysLeft={daysLeft}
            logs={logs}
            joinStatus={joinStatus}
            joinSlug={joinSlug}
            showJoinPanel={showJoinPanel}
            onShowJoinPanel={() => setShowJoinPanel(s => !s)}
            onJoinSlugChange={setJoinSlug}
            onJoinBank={() => { void joinSharedBank(); }}
          />
        )}
      </div>

      {/* ── Right rail ── */}
      <RightRail
        pdfs={pdfs}
        ready={ready}
        totalQ={totalQ}
        daysLeft={daysLeft}
        examDate={examDate}
      />

      {/* Hidden file input */}
      <input ref={fileInputRef} type="file" accept=".pdf" style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) { void handleUpload(f); } e.target.value = ''; }} />
    </div>
  );
}

// ── Today / home panel ────────────────────────────────────────────────────────

function TodayPanel({
  pdfs, filtered, search, onSearchChange, density, onDensityChange,
  processing, onUpload, onStudy, onDelete, onRename, onPublish, publishingId,
  getPdfDisplayName, nodeMap, daysLeft, logs, joinStatus, joinSlug,
  showJoinPanel, onShowJoinPanel, onJoinSlugChange, onJoinBank,
}: {
  pdfs: PDF[]; filtered: PDF[]; search: string;
  onSearchChange: (v: string) => void;
  density: Density; onDensityChange: (v: Density) => void;
  processing: string | null;
  onUpload: () => void;
  onStudy: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (pdf: PDF) => void;
  onPublish: (pdf: PDF) => void;
  publishingId: string | null;
  getPdfDisplayName: (pdf: PDF) => string;
  nodeMap: Map<string, import('@/types').DeckNode>;
  daysLeft: number | null;
  logs: ProcessEvent[];
  joinStatus: string | null;
  joinSlug: string;
  showJoinPanel: boolean;
  onShowJoinPanel: () => void;
  onJoinSlugChange: (v: string) => void;
  onJoinBank: () => void;
}) {
  const ready = pdfs.filter(p => p.processed_at);
  const totalQ = ready.reduce((s, p) => s + (p.question_count ?? 0), 0);

  return (
    <div style={{ padding: '32px 40px 60px', maxWidth: 900 }}>
      <Eyebrow>Library</Eyebrow>
      <h1 style={{
        fontFamily: 'var(--font-serif)', fontSize: 40, fontWeight: 400,
        letterSpacing: '-0.025em', lineHeight: 1.1, margin: '4px 0 0',
        color: 'var(--text-primary)',
      }}>
        Your study sources
      </h1>

      {/* Stats row */}
      {ready.length > 0 && (
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr',
          gap: 1, marginTop: 22, background: 'var(--border)',
          border: '1px solid var(--border)', borderRadius: 'var(--r3)', overflow: 'hidden',
        }}>
          <StatCell label="Active sources" value={String(ready.length)} />
          <StatCell label="Total questions" value={totalQ.toLocaleString()} />
        </div>
      )}

      {/* Exam countdown */}
      {daysLeft !== null && (
        <div style={{
          marginTop: 16, padding: '10px 14px',
          borderRadius: 'var(--r2)', fontSize: 12, fontWeight: 600,
          background: daysLeft <= 3 ? 'var(--red-dim)' : 'var(--accent-dim)',
          color: daysLeft <= 3 ? 'var(--red)' : 'var(--accent)',
          border: `1px solid ${daysLeft <= 3 ? 'var(--red)' : 'var(--accent)'}22`,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <Icon name="flag" size={13} />
          {daysLeft > 0 ? `${daysLeft} days until exam` : 'Exam day!'}
        </div>
      )}

      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 24, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, position: 'relative', minWidth: 160 }}>
          <div style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)', pointerEvents: 'none' }}>
            <Icon name="search" size={13} />
          </div>
          <input
            value={search}
            onChange={e => onSearchChange(e.target.value)}
            placeholder="Search sources…"
            style={{
              width: '100%', height: 34, paddingLeft: 30, paddingRight: 12,
              borderRadius: 'var(--r2)', fontSize: 12,
              background: 'var(--bg-raised)', border: '1px solid var(--border)',
              color: 'var(--text-primary)', outline: 'none',
              fontFamily: 'var(--font-sans)',
            }}
            onFocus={e  => (e.currentTarget.style.borderColor = 'var(--accent)')}
            onBlur={e   => (e.currentTarget.style.borderColor = 'var(--border)')}
          />
        </div>

        <select
          value={density}
          onChange={e => onDensityChange(e.target.value as Density)}
          style={{
            height: 34, padding: '0 10px',
            borderRadius: 'var(--r2)', fontSize: 12,
            background: 'var(--bg-raised)', border: '1px solid var(--border)',
            color: 'var(--text-secondary)', outline: 'none', cursor: 'pointer',
            fontFamily: 'var(--font-sans)',
          }}
        >
          <option value="standard">Standard</option>
          <option value="comprehensive">Comprehensive</option>
          <option value="boards">Boards</option>
        </select>

        <Btn kind="primary" icon="plus" onClick={onUpload} disabled={!!processing}>
          {processing ? 'Processing…' : 'Upload PDF'}
        </Btn>

        <button
          onClick={onShowJoinPanel}
          style={{
            height: 34, padding: '0 12px',
            borderRadius: 'var(--r2)', fontSize: 12, fontWeight: 500,
            background: 'var(--bg-raised)', border: '1px solid var(--border)',
            color: 'var(--text-secondary)', cursor: 'pointer',
            fontFamily: 'var(--font-sans)',
          }}
        >
          Join bank
        </button>
      </div>

      {/* Join panel */}
      {showJoinPanel && (
        <div style={{
          marginTop: 10, padding: 14,
          background: 'var(--bg-raised)', border: '1px solid var(--border)',
          borderRadius: 'var(--r3)', display: 'flex', gap: 8, flexWrap: 'wrap',
          animation: 'fade-up 0.2s ease',
        }}>
          <input
            value={joinSlug}
            onChange={e => onJoinSlugChange(e.target.value)}
            placeholder="Paste shared bank link or slug"
            style={{
              flex: 1, height: 34, padding: '0 12px',
              borderRadius: 'var(--r2)', fontSize: 12,
              background: 'var(--bg-sunken)', border: '1px solid var(--border)',
              color: 'var(--text-primary)', outline: 'none',
              fontFamily: 'var(--font-sans)',
            }}
            onKeyDown={e => { if (e.key === 'Enter') onJoinBank(); }}
          />
          <Btn kind="secondary" onClick={onJoinBank}>Join</Btn>
        </div>
      )}

      {joinStatus && (
        <div style={{
          marginTop: 10, padding: '10px 12px',
          borderRadius: 'var(--r2)',
          background: 'var(--bg-raised)', border: '1px solid var(--border)',
          fontSize: 12, color: 'var(--text-secondary)',
        }}>
          {joinStatus}
        </div>
      )}

      {/* Processing log */}
      {logs.length > 0 && (
        <div style={{ marginTop: 16, animation: 'fade-up 0.3s ease' }}>
          <ProcessingLog events={logs} />
        </div>
      )}

      {/* Source list */}
      <div style={{ marginTop: 28, borderTop: '1px solid var(--border)' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 0 10px', borderBottom: '1px solid var(--border)',
        }}>
          <Eyebrow>Sources</Eyebrow>
          <span style={{ fontSize: 10, color: 'var(--text-dim)', marginLeft: 'auto', fontFamily: 'var(--font-mono)' }}>
            {filtered.length}
          </span>
        </div>

        {filtered.length === 0 ? (
          <p style={{ textAlign: 'center', padding: '32px 0', fontSize: 13, color: 'var(--text-dim)', fontStyle: 'italic', fontFamily: 'var(--font-serif)' }}>
            {search.trim() ? `No sources match "${search}"` : 'No PDFs in this folder yet.'}
          </p>
        ) : (
          filtered.map((pdf, i) => (
            <SourceRow
              key={pdf.id}
              idx={i}
              pdf={pdf}
              displayName={getPdfDisplayName(pdf)}
              examDeadline={findExamDeadline(pdf.deck_id, nodeMap)}
              onStudy={onStudy}
              onDelete={() => void deletePdf_wrapper(pdf.id, onDelete)}
              onRename={() => onRename(pdf)}
              onPublish={() => void onPublish(pdf)}
              isPublishing={publishingId === pdf.id}
            />
          ))
        )}
      </div>
    </div>
  );
}

function deletePdf_wrapper(id: string, onDelete: (id: string) => void) {
  onDelete(id);
}

// ── Subject / deck detail panel ───────────────────────────────────────────────

function SubjectPanel({
  deck, pdfs, getPdfDisplayName, nodeMap,
  onStudy, onDelete, onRename, onPublish, onUpload, publishingId, processing,
}: {
  deck: import('@/types').DeckNode;
  pdfs: PDF[];
  getPdfDisplayName: (pdf: PDF) => string;
  nodeMap: Map<string, import('@/types').DeckNode>;
  onStudy: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (pdf: PDF) => void;
  onPublish: (pdf: PDF) => void;
  onUpload: () => void;
  publishingId: string | null;
  processing: string | null;
}) {
  const [filter, setFilter] = useState<'all' | 'processed' | 'shared'>('all');
  const totalQ = pdfs.reduce((s, p) => s + (p.question_count ?? 0), 0);

  const shown = pdfs.filter(p =>
    filter === 'all'       ? true
    : filter === 'processed' ? !!p.processed_at
    : filter === 'shared'    ? p.access_scope === 'shared'
    : true
  );

  const daysLeft = deck.is_exam_block && deck.due_date
    ? Math.ceil((new Date(deck.due_date).getTime() - Date.now()) / 86_400_000)
    : null;

  return (
    <div style={{ padding: '32px 44px 60px', maxWidth: 900 }}>
      <Eyebrow>Subject</Eyebrow>
      <h1 style={{
        fontFamily: 'var(--font-serif)', fontSize: 40, fontWeight: 400,
        letterSpacing: '-0.025em', lineHeight: 1.1, margin: '4px 0 0',
        color: 'var(--text-primary)',
      }}>
        {deck.name}
      </h1>

      <div style={{ display: 'flex', gap: 18, marginTop: 12, fontSize: 13, color: 'var(--text-secondary)' }}>
        <span>{pdfs.length} sources</span>
        <span>·</span>
        <span>{totalQ.toLocaleString()} questions</span>
        {daysLeft !== null && (
          <>
            <span>·</span>
            <span style={{ color: daysLeft <= 7 ? 'var(--red)' : 'var(--amber)', fontWeight: 600 }}>
              {daysLeft > 0 ? `${daysLeft}d to exam` : 'Exam day'}
            </span>
          </>
        )}
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
        <Btn kind="primary" icon="plus" onClick={onUpload} disabled={!!processing}>
          {processing ? 'Processing…' : 'Add PDF'}
        </Btn>
      </div>

      {/* Filter tabs */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        marginTop: 28, borderBottom: '1px solid var(--border)', paddingBottom: 10,
      }}>
        <Eyebrow>Sources</Eyebrow>
        <div style={{ flex: 1 }} />
        {([['all', 'All'], ['processed', 'Ready'], ['shared', 'Shared']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)} style={{
            fontSize: 11, fontWeight: 500, padding: '3px 10px', borderRadius: 99,
            border: `1px solid ${filter === k ? 'var(--text-primary)' : 'var(--border)'}`,
            background: filter === k ? 'var(--text-primary)' : 'transparent',
            color: filter === k ? 'var(--bg)' : 'var(--text-secondary)',
            cursor: 'pointer', fontFamily: 'var(--font-sans)',
          }}>{l}</button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-dim)', fontSize: 13, fontStyle: 'italic', fontFamily: 'var(--font-serif)' }}>
          No sources match this filter.
        </div>
      ) : (
        shown.map((pdf, i) => (
          <SourceRow
            key={pdf.id}
            idx={i}
            pdf={pdf}
            displayName={getPdfDisplayName(pdf)}
            examDeadline={findExamDeadline(pdf.deck_id, nodeMap)}
            onStudy={onStudy}
            onDelete={() => onDelete(pdf.id)}
            onRename={() => onRename(pdf)}
            onPublish={() => void onPublish(pdf)}
            isPublishing={publishingId === pdf.id}
          />
        ))
      )}
    </div>
  );
}

// ── Source row (v2 design) ────────────────────────────────────────────────────

function SourceRow({
  idx, pdf, displayName, examDeadline,
  onStudy, onDelete, onRename, onPublish, isPublishing,
}: {
  idx: number;
  pdf: PDF;
  displayName: string;
  examDeadline: string | null;
  onStudy: (id: string) => void;
  onDelete: () => void;
  onRename: () => void;
  onPublish: () => void;
  isPublishing: boolean;
}) {
  const [hov, setHov] = useState(false);
  const isOwned = pdf.access_scope !== 'shared';
  const total = pdf.question_count ?? 0;

  let examBadgeDays: number | null = null;
  if (examDeadline) {
    examBadgeDays = Math.ceil((new Date(examDeadline).getTime() - Date.now()) / 86_400_000);
  }

  return (
    <div
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: 'grid',
        gridTemplateColumns: '28px 1fr auto',
        gap: 20, alignItems: 'center',
        padding: '18px 0',
        borderBottom: '1px solid var(--border)',
        transition: 'background 0.1s',
      }}
    >
      <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>
        {String(idx + 1).padStart(2, '0')}
      </span>

      <div>
        <div style={{
          fontFamily: 'var(--font-serif)', fontSize: 18, fontWeight: 400,
          letterSpacing: '-0.01em', color: 'var(--text-primary)', lineHeight: 1.3,
        }}>
          {displayName}
        </div>
        <div style={{
          display: 'flex', gap: 10, marginTop: 4,
          fontSize: 11, fontFamily: 'var(--font-mono)',
          color: 'var(--text-dim)', letterSpacing: '0.02em',
          flexWrap: 'wrap',
        }}>
          {total > 0 && <span>{total} Q</span>}
          {pdf.page_count > 0 && <><span>·</span><span>{pdf.page_count} PP</span></>}
          <span>·</span>
          <span>{pdf.density.toUpperCase()}</span>
          {pdf.access_scope === 'shared' && <><span>·</span><span style={{ color: 'var(--accent)' }}>SHARED</span></>}
          {examBadgeDays !== null && (
            <><span>·</span><span style={{ color: examBadgeDays <= 7 ? 'var(--red)' : 'var(--amber)', fontWeight: 700 }}>
              {examBadgeDays > 0 ? `${examBadgeDays}D TO EXAM` : 'EXAM DAY'}
            </span></>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: hov ? 1 : 0.6, transition: 'opacity 0.15s' }}>
        {pdf.processed_at ? (
          <button
            onClick={() => onStudy(pdf.id)}
            style={{
              fontSize: 11, fontWeight: 700, letterSpacing: '0.04em',
              padding: '5px 10px', color: 'var(--accent)',
              background: 'var(--accent-dim)', border: 'none',
              borderRadius: 4, cursor: 'pointer',
              fontFamily: 'var(--font-mono)',
            }}
          >
            OPEN →
          </button>
        ) : (
          <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
            PROCESSING…
          </span>
        )}

        {isOwned && hov && (
          <>
            <button
              onClick={onRename}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: 'var(--text-dim)', padding: 4, fontSize: 13,
              }}
              title="Rename"
            >✎</button>
            <button
              onClick={onPublish}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: 'var(--text-dim)', padding: 4, fontSize: 11,
                fontFamily: 'var(--font-mono)',
              }}
              title={pdf.shared_bank_slug ? 'Share link' : 'Publish'}
            >
              {isPublishing ? '…' : '↑'}
            </button>
            <button
              onClick={onDelete}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--red)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: 'var(--text-dim)', padding: 4, fontSize: 13,
                transition: 'color 0.15s',
              }}
              title="Delete"
            >✕</button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Right rail ────────────────────────────────────────────────────────────────

function RightRail({
  pdfs, ready, totalQ, daysLeft, examDate,
}: {
  pdfs: PDF[];
  ready: PDF[];
  totalQ: number;
  daysLeft: number | null;
  examDate: string | null;
}) {
  const newest = [...ready]
    .sort((a, b) => new Date(b.processed_at!).getTime() - new Date(a.processed_at!).getTime())
    .slice(0, 4);

  return (
    <aside style={{
      borderLeft: '1px solid var(--border)', overflow: 'auto',
      padding: '24px 20px', background: 'var(--bg)',
    }}>
      {/* Summary card */}
      <div style={{
        padding: 16, background: 'var(--bg-raised)',
        border: '1px solid var(--border)', borderRadius: 'var(--r3)',
        marginBottom: 24,
      }}>
        <Eyebrow>Library summary</Eyebrow>
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <RailStat label="Sources" value={String(pdfs.length)} />
          <RailStat label="Ready" value={String(ready.length)} />
          <RailStat label="Questions" value={totalQ.toLocaleString()} accent />
        </div>

        {daysLeft !== null && (
          <div style={{
            marginTop: 14, padding: '10px 12px',
            background: daysLeft <= 7 ? 'var(--red-dim)' : 'var(--amber-dim)',
            borderRadius: 'var(--r2)', fontSize: 12,
            color: daysLeft <= 7 ? 'var(--red)' : 'var(--amber)',
            fontWeight: 600,
          }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 2 }}>Exam countdown</div>
            <div style={{ fontFamily: 'var(--font-serif)', fontSize: 28, fontWeight: 400, lineHeight: 1 }}>
              {daysLeft > 0 ? daysLeft : 0}
            </div>
            <div style={{ fontSize: 11, marginTop: 2, opacity: 0.8 }}>
              days {daysLeft <= 0 ? '— today!' : `until ${new Date(examDate!).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
            </div>
          </div>
        )}
      </div>

      {/* Recent sources */}
      {newest.length > 0 && (
        <div>
          <Eyebrow>Recent sources</Eyebrow>
          <div style={{ marginTop: 10 }}>
            {newest.map(pdf => {
              const name = pdf.shared_bank_title ?? pdf.display_name ?? pdf.name.replace(/\.pdf$/i, '');
              return (
                <div key={pdf.id} style={{ padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
                  <div style={{
                    fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)',
                    lineHeight: 1.35, marginBottom: 3,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }} title={name}>
                    {name}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10.5, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                    <span>{pdf.question_count ?? 0} Q</span>
                    {pdf.question_count != null && <MasteryBar v={Math.min(100, ((pdf.question_count ?? 0) / 500) * 100)} width={40} />}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {pdfs.length === 0 && (
        <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-dim)', fontSize: 12, lineHeight: 1.6 }}>
          <div style={{ fontSize: '2rem', marginBottom: 8 }}>📖</div>
          Upload your first PDF to get started.
        </div>
      )}
    </aside>
  );
}

function RailStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
      <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600,
        color: accent ? 'var(--accent)' : 'var(--text-primary)',
      }}>{value}</span>
    </div>
  );
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: 'var(--bg-raised)', padding: '14px 18px' }}>
      <Eyebrow>{label}</Eyebrow>
      <div style={{
        fontFamily: 'var(--font-serif)', fontSize: 28, fontWeight: 400,
        letterSpacing: '-0.03em', marginTop: 4, color: 'var(--text-primary)',
      }}>{value}</div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ onUpload }: { onUpload: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', padding: '40px 20px' }}>
      <div style={{ textAlign: 'center', maxWidth: 400 }}>
        <div style={{ fontSize: '3rem', marginBottom: 16, animation: 'float 3s ease-in-out infinite' }}>📖</div>
        <p style={{ fontFamily: 'var(--font-serif)', fontSize: 24, fontWeight: 400, color: 'var(--text-primary)', marginBottom: 8 }}>
          No sources yet
        </p>
        <p style={{ fontSize: 14, marginBottom: 24, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          Upload a PDF to generate a full question bank in 10–15 minutes.
        </p>
        <Btn kind="primary" icon="plus" onClick={onUpload}>Upload your first PDF</Btn>
      </div>
    </div>
  );
}
