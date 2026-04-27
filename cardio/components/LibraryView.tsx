'use client';

import { useRef, useState, useMemo, useEffect } from 'react';
import type { PDF, Deck, Density, ProcessEvent, SharedBank } from '@/types';
import ProcessingLog from './ProcessingLog';
import LibrarySidebar, { buildDeckTree, descendantIds, findExamDeadline } from './LibrarySidebar';
import { Eyebrow, Icon, Btn } from './ui';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { uploadPdfToStorage } from '@/lib/upload-pdf';

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
  const [joinSlug,       setJoinSlug]       = useState('');
  const [joinStatus,     setJoinStatus]     = useState<string | null>(null);
  const [shareToast,     setShareToast]     = useState<string | null>(null);
  const [folderShareStatus, setFolderShareStatus] = useState<string | null>(null);
  const [sharedBanks,    setSharedBanks]    = useState<SharedBank[]>([]);
  const [logs,           setLogs]           = useState<ProcessEvent[]>([]);
  const [search,         setSearch]         = useState('');
  const [selectedDeckId, setSelectedDeckId] = useState<string | null>(null);
  const [showJoinPanel,  setShowJoinPanel]  = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const daysLeft = examDate
    ? Math.ceil((new Date(examDate).getTime() - Date.now()) / 86_400_000)
    : null;

  const { nodeMap } = useMemo(() => buildDeckTree(decks, pdfs), [decks, pdfs]);

  const sharedDeckIds = useMemo(() => new Set(
    sharedBanks
      .filter(bank => bank.is_active && !!bank.source_deck_id)
      .map(bank => bank.source_deck_id as string),
  ), [sharedBanks]);

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

  async function refreshSharedBanksFromServer() {
    const res = await fetch('/api/shared-banks');
    if (!res.ok) return;
    const data = await res.json().catch(() => null) as { owned?: SharedBank[] } | null;
    setSharedBanks(data?.owned ?? []);
  }

  useEffect(() => {
    void refreshSharedBanksFromServer();
  }, []);

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
    let resp: Response;
    try {
      const { data: { user } } = await supabaseBrowser.auth.getUser();
      if (!user?.id) {
        setLogs([{ phase: 0, message: 'Error: You must be signed in to upload PDFs.', pct: 0 }]);
        return;
      }

      const storagePath = await uploadPdfToStorage(file, user.id);
      resp = await fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storagePath, density }),
      });
    } catch (error) {
      setLogs([{ phase: 0, message: `Upload failed: ${(error as Error).message}`, pct: 0 }]);
      return;
    }
    if (!resp.ok) {
      const txt = await resp.text();
      let msg = `Upload failed: ${txt}`;
      try {
        const json = JSON.parse(txt) as { error?: string; tier?: string; limit?: number };
        if (json.error === 'Plan limit exceeded') {
          msg = `Plan limit reached: your ${json.tier ?? 'free'} plan allows ${json.limit} PDF${json.limit === 1 ? '' : 's'} per month. Upgrade your plan to continue.`;
        }
      } catch { /* not JSON, use raw text */ }
      setLogs([{ phase: 0, message: msg, pct: 0 }]);
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

  async function sharePdf(pdfId: string) {
    const res = await fetch('/api/shared-banks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdfId }),
    });
    const data = await res.json().catch(() => null) as { shareUrl?: string } | null;
    if (!res.ok || !data?.shareUrl) { setShareToast('Failed to generate share link.'); return; }
    await navigator.clipboard.writeText(data.shareUrl).catch(() => null);
    setShareToast('Link copied! ' + data.shareUrl);
    await refreshPdfsFromServer();
    setTimeout(() => setShareToast(null), 6000);
  }

  function shareUrlForSlug(slug: string) {
    return `${window.location.origin}/s/${slug}`;
  }

  async function handleShareDeck(deckId: string) {
    const existingBank = sharedBanks.find(bank => bank.is_active && bank.source_deck_id === deckId);
    if (existingBank) {
      const shareUrl = shareUrlForSlug(existingBank.slug);
      await navigator.clipboard.writeText(shareUrl).catch(() => null);
      setFolderShareStatus('Link copied!');
      setShareToast('Link copied! ' + shareUrl);
      setTimeout(() => setFolderShareStatus(null), 3000);
      setTimeout(() => setShareToast(null), 6000);
      return;
    }

    const res = await fetch('/api/shared-banks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deckId, visibility: 'public' }),
    });
    const data = await res.json().catch(() => null) as { shareUrl?: string; error?: string } | null;
    if (!res.ok || !data?.shareUrl) {
      const message = data?.error ?? 'Failed to generate folder share link.';
      setFolderShareStatus(message);
      setShareToast(message);
      setTimeout(() => setFolderShareStatus(null), 4000);
      setTimeout(() => setShareToast(null), 4000);
      return;
    }
    await navigator.clipboard.writeText(data.shareUrl).catch(() => null);
    await refreshSharedBanksFromServer();
    setFolderShareStatus('Link copied!');
    setShareToast('Link copied! ' + data.shareUrl);
    setTimeout(() => setFolderShareStatus(null), 3000);
    setTimeout(() => setShareToast(null), 6000);
  }

  async function revokePdf(slug: string) {
    if (!confirm('Revoke this shared link? Students will no longer be able to join.')) return;
    await fetch(`/api/shared-banks/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    await refreshPdfsFromServer();
    setShareToast('Sharing link revoked.');
    setTimeout(() => setShareToast(null), 3000);
  }

  async function revokeDeck(slug: string) {
    if (!confirm('Revoke this shared folder link? Students will no longer be able to join.')) return;
    await fetch(`/api/shared-banks/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    await refreshSharedBanksFromServer();
    setFolderShareStatus('Sharing link revoked.');
    setShareToast('Sharing link revoked.');
    setTimeout(() => setFolderShareStatus(null), 3000);
    setTimeout(() => setShareToast(null), 3000);
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
  const selectedDeckBank = selectedDeck
    ? sharedBanks.find(bank => bank.is_active && bank.source_deck_id === selectedDeck.id) ?? null
    : null;

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '260px 1fr',
      height: 'calc(100vh - 56px)',
      overflow: 'hidden',
      position: 'relative',
    }}>
      {shareToast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--text-primary)', color: 'var(--bg)',
          padding: '10px 18px', borderRadius: 8, fontSize: 13,
          fontFamily: 'var(--font-sans)', zIndex: 200,
          boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
          maxWidth: 480, textAlign: 'center', wordBreak: 'break-all',
        }}>
          {shareToast}
        </div>
      )}
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
          onShareDeck={handleShareDeck}
          sharedDeckIds={sharedDeckIds}
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
            decks={decks}
            getPdfDisplayName={getPdfDisplayName}
            nodeMap={nodeMap}
            onStudy={onOpenConceptMap}
            onDelete={deletePdf}
            onRename={renamePdf}
            onMovePdf={handleMovePdf}
            onShare={sharePdf}
            onRevoke={revokePdf}
            onShareDeck={handleShareDeck}
            onRevokeDeck={revokeDeck}
            sharedBank={selectedDeckBank}
            shareStatus={folderShareStatus}
            onUpload={() => fileInputRef.current?.click()}
            processing={processing}
            logs={logs}
          />
        ) : (
          <TodayPanel
            pdfs={pdfs}
            filtered={filtered}
            decks={decks}
            search={search}
            onSearchChange={setSearch}
            density={density}
            onDensityChange={setDensity}
            processing={processing}
            onUpload={() => fileInputRef.current?.click()}
            onStudy={onOpenConceptMap}
            onDelete={deletePdf}
            onRename={renamePdf}
            onMovePdf={handleMovePdf}
            onShare={sharePdf}
            onRevoke={revokePdf}
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

      {/* Hidden file input */}
      <input ref={fileInputRef} type="file" accept=".pdf" style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) { void handleUpload(f); } e.target.value = ''; }} />
    </div>
  );
}

// ── Today / home panel ────────────────────────────────────────────────────────

function TodayPanel({
  pdfs, filtered, decks, search, onSearchChange, density, onDensityChange,
  processing, onUpload, onStudy, onDelete, onRename, onMovePdf, onShare, onRevoke,
  getPdfDisplayName, nodeMap, daysLeft, logs, joinStatus, joinSlug,
  showJoinPanel, onShowJoinPanel, onJoinSlugChange, onJoinBank,
}: {
  pdfs: PDF[]; filtered: PDF[]; decks: Deck[]; search: string;
  onSearchChange: (v: string) => void;
  density: Density; onDensityChange: (v: Density) => void;
  processing: string | null;
  onUpload: () => void;
  onStudy: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (pdf: PDF) => void;
  onMovePdf: (pdfId: string, deckId: string | null) => Promise<void>;
  onShare: (pdfId: string) => Promise<void>;
  onRevoke: (slug: string) => Promise<void>;
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
              decks={decks}
              onStudy={onStudy}
              onDelete={() => onDelete(pdf.id)}
              onRename={() => onRename(pdf)}
              onMove={deckId => void onMovePdf(pdf.id, deckId)}
              onShare={() => void onShare(pdf.id)}
              onRevoke={() => pdf.shared_bank_slug ? void onRevoke(pdf.shared_bank_slug) : undefined}
            />
          ))
        )}
      </div>
    </div>
  );
}


// ── Subject / deck detail panel ───────────────────────────────────────────────

function SubjectPanel({
  deck, pdfs, decks, getPdfDisplayName, nodeMap,
  onStudy, onDelete, onRename, onMovePdf, onShare, onRevoke,
  onShareDeck, onRevokeDeck, sharedBank, shareStatus,
  onUpload, processing, logs,
}: {
  deck: import('@/types').DeckNode;
  pdfs: PDF[];
  decks: Deck[];
  getPdfDisplayName: (pdf: PDF) => string;
  nodeMap: Map<string, import('@/types').DeckNode>;
  onStudy: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (pdf: PDF) => void;
  onMovePdf: (pdfId: string, deckId: string | null) => Promise<void>;
  onShare: (pdfId: string) => Promise<void>;
  onRevoke: (slug: string) => Promise<void>;
  onShareDeck: (deckId: string) => Promise<void>;
  onRevokeDeck: (slug: string) => Promise<void>;
  sharedBank: SharedBank | null;
  shareStatus: string | null;
  onUpload: () => void;
  processing: string | null;
  logs: import('@/types').ProcessEvent[];
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
        {sharedBank ? (
          <>
            <Btn kind="secondary" icon="eye" onClick={() => { void onShareDeck(deck.id); }}>
              Copy link
            </Btn>
            <Btn kind="danger" onClick={() => { void onRevokeDeck(sharedBank.slug); }}>
              Revoke
            </Btn>
          </>
        ) : (
          <Btn kind="secondary" icon="eye" onClick={() => { void onShareDeck(deck.id); }}>
            Share folder
          </Btn>
        )}
        {shareStatus && (
          <span style={{
            alignSelf: 'center',
            fontSize: 12,
            color: shareStatus === 'Link copied!' ? 'var(--accent)' : 'var(--text-secondary)',
            fontFamily: 'var(--font-sans)',
          }}>
            {shareStatus}
          </span>
        )}
      </div>

      {logs.length > 0 && (
        <div style={{ marginTop: 16, animation: 'fade-up 0.3s ease' }}>
          <ProcessingLog events={logs} />
        </div>
      )}

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
            decks={decks}
            onStudy={onStudy}
            onDelete={() => onDelete(pdf.id)}
            onRename={() => onRename(pdf)}
            onMove={deckId => void onMovePdf(pdf.id, deckId)}
            onShare={() => void onShare(pdf.id)}
            onRevoke={() => pdf.shared_bank_slug ? void onRevoke(pdf.shared_bank_slug) : undefined}
          />
        ))
      )}
    </div>
  );
}

// ── Source row ────────────────────────────────────────────────────────────────

function SourceRow({
  idx, pdf, displayName, examDeadline, decks,
  onStudy, onDelete, onRename, onMove, onShare, onRevoke,
}: {
  idx: number;
  pdf: PDF;
  displayName: string;
  examDeadline: string | null;
  decks: Deck[];
  onStudy: (id: string) => void;
  onDelete: () => void;
  onRename: () => void;
  onMove: (deckId: string | null) => void;
  onShare: () => void;
  onRevoke: () => void;
}) {
  const [menu, setMenu] = useState<'closed' | 'main' | 'move'>('closed');
  const menuRef = useRef<HTMLDivElement>(null);
  const isOwned = pdf.access_scope !== 'shared';
  const total = pdf.question_count ?? 0;

  useEffect(() => {
    if (menu === 'closed') return;
    function close(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenu('closed');
    }
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);

  let examBadgeDays: number | null = null;
  if (examDeadline) {
    examBadgeDays = Math.ceil((new Date(examDeadline).getTime() - Date.now()) / 86_400_000);
  }

  const menuItemStyle: React.CSSProperties = {
    display: 'block', width: '100%', textAlign: 'left',
    padding: '7px 14px', background: 'none', border: 'none',
    fontSize: 13, cursor: 'pointer', color: 'var(--text-primary)',
    fontFamily: 'var(--font-sans)', whiteSpace: 'nowrap',
  };

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '28px 1fr auto',
      gap: 20, alignItems: 'center',
      padding: '18px 0',
      borderBottom: '1px solid var(--border)',
    }}>
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
          color: 'var(--text-dim)', letterSpacing: '0.02em', flexWrap: 'wrap',
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

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {pdf.processed_at ? (
          <button
            onClick={() => onStudy(pdf.id)}
            style={{
              fontSize: 11, fontWeight: 700, letterSpacing: '0.04em',
              padding: '5px 10px', color: 'var(--accent)',
              background: 'var(--accent-dim)', border: 'none',
              borderRadius: 4, cursor: 'pointer', fontFamily: 'var(--font-mono)',
            }}
          >
            OPEN →
          </button>
        ) : (
          <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
            PROCESSING…
          </span>
        )}

        {isOwned && (
          <div ref={menuRef} style={{ position: 'relative' }}>
            <button
              onClick={() => setMenu(m => m === 'closed' ? 'main' : 'closed')}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-dim)', padding: '4px 6px',
                fontSize: 16, lineHeight: 1, borderRadius: 4,
                transition: 'background 0.1s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-raised)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}
              title="More options"
            >···</button>

            {menu !== 'closed' && (
              <div style={{
                position: 'absolute', right: 0, top: '100%', marginTop: 4,
                background: 'var(--bg-raised)', border: '1px solid var(--border)',
                borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
                zIndex: 50, minWidth: 140, overflow: 'hidden',
              }}>
                {menu === 'main' && (
                  <>
                    <button style={menuItemStyle} onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-sunken)')} onMouseLeave={e => (e.currentTarget.style.background = 'none')} onClick={() => { onRename(); setMenu('closed'); }}>Rename</button>
                    <button style={menuItemStyle} onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-sunken)')} onMouseLeave={e => (e.currentTarget.style.background = 'none')} onClick={() => setMenu('move')}>Move to deck →</button>
                    {pdf.processed_at && (
                      <>
                        <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
                        <button style={menuItemStyle} onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-sunken)')} onMouseLeave={e => (e.currentTarget.style.background = 'none')} onClick={() => { onShare(); setMenu('closed'); }}>
                          {pdf.shared_bank_slug ? 'Copy class link' : 'Share with class'}
                        </button>
                        {pdf.shared_bank_slug && (
                          <button style={{ ...menuItemStyle, color: 'var(--text-dim)', fontSize: 12 }} onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-sunken)')} onMouseLeave={e => (e.currentTarget.style.background = 'none')} onClick={() => { onRevoke(); setMenu('closed'); }}>Revoke link</button>
                        )}
                      </>
                    )}
                    <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
                    <button style={{ ...menuItemStyle, color: 'var(--red, #ef4444)' }} onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-sunken)')} onMouseLeave={e => (e.currentTarget.style.background = 'none')} onClick={() => { onDelete(); setMenu('closed'); }}>Delete</button>
                  </>
                )}
                {menu === 'move' && (
                  <>
                    <button style={{ ...menuItemStyle, color: 'var(--text-dim)', fontSize: 12 }} onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-sunken)')} onMouseLeave={e => (e.currentTarget.style.background = 'none')} onClick={() => setMenu('main')}>← Back</button>
                    <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
                    <button style={{ ...menuItemStyle, color: 'var(--text-secondary)', fontStyle: 'italic' }} onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-sunken)')} onMouseLeave={e => (e.currentTarget.style.background = 'none')} onClick={() => { onMove(null); setMenu('closed'); }}>No folder</button>
                    {decks.map(d => (
                      <button key={d.id} style={menuItemStyle} onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-sunken)')} onMouseLeave={e => (e.currentTarget.style.background = 'none')} onClick={() => { onMove(d.id); setMenu('closed'); }}>{d.name}</button>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
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
