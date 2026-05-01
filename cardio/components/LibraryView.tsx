'use client';

import { useRef, useState, useMemo, useEffect } from 'react';
import type { PDF, Deck, Density, JoinedSharedBankNotice, SharedBank, FlaggedQuestionRow } from '@/types';
import LibrarySidebar, { buildDeckTree, descendantIds, findExamDeadline } from './LibrarySidebar';
import { Eyebrow, Icon, Btn } from './ui';

interface Props {
  pdfs:                  PDF[];
  decks:                 Deck[];
  examDate:              string | null;
  onOpenConceptMap:      (pdfId: string) => void;
  onPdfsChange:          (pdfs: PDF[]) => void;
  onDecksChange:         (decks: Deck[]) => void;
  joinedBankNotice?:     JoinedSharedBankNotice | null;
  onDismissJoinedBank?:  () => void;
  onStartMixedQuiz:      (slug: string) => void;
  onStartDeckQuiz:       (deckId: string) => void;
}

export default function LibraryView({
  pdfs, decks, examDate,
  onOpenConceptMap, onPdfsChange, onDecksChange,
  joinedBankNotice, onDismissJoinedBank, onStartMixedQuiz, onStartDeckQuiz,
}: Props) {
  const [density,        setDensity]        = useState<Density>('standard');
  const [joinSlug,       setJoinSlug]       = useState('');
  const [joinStatus,     setJoinStatus]     = useState<string | null>(null);
  const [shareToast,     setShareToast]     = useState<string | null>(null);
  const [folderShareStatus, setFolderShareStatus] = useState<string | null>(null);
  const [sharedBanks,    setSharedBanks]    = useState<SharedBank[]>([]);
  const [search,         setSearch]         = useState('');
  const [selectedDeckId, setSelectedDeckId] = useState<string | null>(null);
  const [showJoinPanel,  setShowJoinPanel]  = useState(false);

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

  const joinedBankPdfs = useMemo(() => {
    if (!joinedBankNotice) return [];
    return pdfs.filter(pdf => pdf.shared_bank_slug === joinedBankNotice.slug);
  }, [joinedBankNotice, pdfs]);

  function getPdfDisplayName(pdf: PDF) {
    if (pdf.shared_bank_source_type !== 'deck' && pdf.shared_bank_title) {
      return pdf.shared_bank_title;
    }
    return pdf.display_name ?? pdf.name.replace(/\.pdf$/i, '');
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
      const url = new URL(trimmed, window.location.origin);
      const querySlug = url.searchParams.get('shared') ?? url.searchParams.get('join');
      if (querySlug) return querySlug;
      const pathSlug = url.pathname.match(/^\/s\/([^/]+)/)?.[1];
      return pathSlug ? decodeURIComponent(pathSlug) : trimmed;
    } catch {
      return trimmed
        .replace(/^\/+s\//, '')
        .replace(/^\/+/, '')
        .replace(/^app\?(shared|join)=/, '')
        .trim();
    }
  }


  async function joinSharedBank() {
    const slug = parseSharedSlug(joinSlug);
    if (!slug) { setJoinStatus('Paste a shared-bank link or slug.'); return; }
    setJoinStatus('Joining shared bank…');
    try {
      const res = await fetch(`/api/shared-banks/${encodeURIComponent(slug)}/join`, { method: 'POST' });
      const data = await res.json().catch(() => null) as {
        bank?: {
          slug?: string | null;
          source_pdf_id?: string | null;
          source_pdfs?: PDF[];
          title?: string | null;
        };
        error?: string;
      } | null;
      if (!res.ok) throw new Error(data?.error ?? 'Failed to join shared bank.');
      await refreshPdfsFromServer();
      setJoinStatus(`Joined ${data?.bank?.title ?? slug}.`);
      setJoinSlug('');
      setShowJoinPanel(false);
    } catch (error) {
      setJoinStatus(error instanceof Error ? error.message : 'Failed to join shared bank.');
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

  function getSharedBankQuestionCount(bank?: SharedBank | null) {
    return bank?.source_pdfs?.reduce((sum, pdf) => sum + (pdf.question_count ?? 0), 0) ?? 0;
  }

  function getSharedBankSourceCount(bank?: SharedBank | null) {
    return bank?.source_pdfs?.length ?? 0;
  }

  function buildShareText(title: string, questionCount: number, sourceCount: number) {
    const stats = [
      questionCount > 0 ? `${questionCount.toLocaleString()} question${questionCount === 1 ? '' : 's'}` : null,
      sourceCount > 0 ? `from ${sourceCount.toLocaleString()} source${sourceCount === 1 ? '' : 's'}` : null,
    ].filter(Boolean).join(' ');

    return stats
      ? `${title}: ${stats} on Cardio.`
      : `${title}: shared question bank on Cardio.`;
  }

  async function shareSharedBankLink({
    url,
    title,
    questionCount = 0,
    sourceCount = 0,
  }: {
    url: string;
    title: string;
    questionCount?: number;
    sourceCount?: number;
  }) {
    const shareTitle = `${title} · Cardio`;
    const text = buildShareText(title, questionCount, sourceCount);

    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: shareTitle, text, url });
        return 'Shared.';
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return null;
      }
    }

    await navigator.clipboard.writeText(url).catch(() => null);
    return 'Link copied! ' + url;
  }

  async function sharePdf(pdfId: string) {
    const res = await fetch('/api/shared-banks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdfId }),
    });
    const data = await res.json().catch(() => null) as { shareUrl?: string; bank?: SharedBank } | null;
    if (!res.ok || !data?.shareUrl) { setShareToast('Failed to generate share link.'); return; }
    const fallbackPdf = pdfs.find(pdf => pdf.id === pdfId);
    const shareStatus = await shareSharedBankLink({
      url: data.shareUrl,
      title: data.bank?.title ?? (fallbackPdf ? getPdfDisplayName(fallbackPdf) : 'Shared question bank'),
      questionCount: getSharedBankQuestionCount(data.bank) || fallbackPdf?.question_count || 0,
      sourceCount: getSharedBankSourceCount(data.bank) || 1,
    });
    if (shareStatus) setShareToast(shareStatus);
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
      const shareStatus = await shareSharedBankLink({
        url: shareUrl,
        title: existingBank.title,
        questionCount: getSharedBankQuestionCount(existingBank),
        sourceCount: getSharedBankSourceCount(existingBank),
      });
      if (shareStatus) {
        setFolderShareStatus(shareStatus === 'Shared.' ? 'Shared.' : 'Link copied!');
        setShareToast(shareStatus);
      }
      setTimeout(() => setFolderShareStatus(null), 3000);
      setTimeout(() => setShareToast(null), 6000);
      return;
    }

    const res = await fetch('/api/shared-banks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deckId, visibility: 'public' }),
    });
    const data = await res.json().catch(() => null) as { shareUrl?: string; bank?: SharedBank; error?: string } | null;
    if (!res.ok || !data?.shareUrl) {
      const message = data?.error ?? 'Failed to generate folder share link.';
      setFolderShareStatus(message);
      setShareToast(message);
      setTimeout(() => setFolderShareStatus(null), 4000);
      setTimeout(() => setShareToast(null), 4000);
      return;
    }
    const shareStatus = await shareSharedBankLink({
      url: data.shareUrl,
      title: data.bank?.title ?? selectedDeck?.name ?? 'Shared question bank',
      questionCount: getSharedBankQuestionCount(data.bank) || pdfs
        .filter(pdf => pdf.deck_id === deckId)
        .reduce((sum, pdf) => sum + (pdf.question_count ?? 0), 0),
      sourceCount: getSharedBankSourceCount(data.bank) || pdfs.filter(pdf => pdf.deck_id === deckId).length,
    });
    await refreshSharedBanksFromServer();
    if (shareStatus) {
      setFolderShareStatus(shareStatus === 'Shared.' ? 'Shared.' : 'Link copied!');
      setShareToast(shareStatus);
    }
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
        {joinedBankNotice ? (
          <JoinedBankPanel
            notice={joinedBankNotice}
            pdfs={joinedBankPdfs}
            decks={decks}
            getPdfDisplayName={getPdfDisplayName}
            onStudy={onOpenConceptMap}
            onStartMixedQuiz={onStartMixedQuiz}
            onBack={onDismissJoinedBank ?? (() => undefined)}
          />
        ) : pdfs.length === 0 ? (
          <EmptyState />
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
            onStartDeckQuiz={onStartDeckQuiz}
            sharedBank={selectedDeckBank}
            shareStatus={folderShareStatus}
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
            onStudy={onOpenConceptMap}
            onDelete={deletePdf}
            onRename={renamePdf}
            onMovePdf={handleMovePdf}
            onShare={sharePdf}
            onRevoke={revokePdf}
            getPdfDisplayName={getPdfDisplayName}
            nodeMap={nodeMap}
            daysLeft={daysLeft}
            joinStatus={joinStatus}
            joinSlug={joinSlug}
            showJoinPanel={showJoinPanel}
            onShowJoinPanel={() => setShowJoinPanel(s => !s)}
            onJoinSlugChange={setJoinSlug}
            onJoinBank={() => { void joinSharedBank(); }}
            onStartMixedQuiz={onStartMixedQuiz}
          />
        )}
      </div>

    </div>
  );
}

function cleanBankTitle(title: string) {
  return title.replace(/\bPreassinged\b/g, 'Preassigned');
}

function JoinedBankPanel({
  notice, pdfs, decks, getPdfDisplayName, onStudy, onStartMixedQuiz, onBack,
}: {
  notice: JoinedSharedBankNotice;
  pdfs: PDF[];
  decks: Deck[];
  getPdfDisplayName: (pdf: PDF) => string;
  onStudy: (id: string) => void;
  onStartMixedQuiz: (slug: string) => void;
  onBack: () => void;
}) {
  const title = cleanBankTitle(notice.title);
  const firstPdfId = notice.firstPdfId ?? pdfs.find(pdf => !!pdf.processed_at)?.id ?? null;
  const sourceCount = pdfs.length || notice.sourceCount;
  const questionCount = pdfs.length
    ? pdfs.reduce((sum, pdf) => sum + (pdf.question_count ?? 0), 0)
    : notice.questionCount;

  return (
    <div style={{ padding: '32px 44px 60px', maxWidth: 900 }}>
      <div style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        borderRadius: 'var(--r2)',
        background: 'var(--accent-dim)',
        color: 'var(--accent)',
        border: '1px solid rgba(13,154,170,0.18)',
        fontSize: 12,
        fontWeight: 700,
        marginBottom: 18,
      }}>
        <Icon name="check" size={14} />
        Added {title}
      </div>

      <Eyebrow>Shared Question Bank</Eyebrow>
      <h1 style={{
        fontFamily: 'var(--font-serif)', fontSize: 40, fontWeight: 400,
        letterSpacing: '-0.025em', lineHeight: 1.1, margin: '4px 0 0',
        color: 'var(--text-primary)',
      }}>
        {title}
      </h1>

      <div style={{ display: 'flex', gap: 18, marginTop: 12, fontSize: 13, color: 'var(--text-secondary)' }}>
        <span>{sourceCount} sources</span>
        <span>·</span>
        <span>{questionCount.toLocaleString()} questions</span>
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
        <Btn
          kind="primary"
          disabled={questionCount <= 0}
          onClick={() => onStartMixedQuiz(notice.slug)}
        >
          {sourceCount > 1 ? 'Start mixed quiz' : 'Start quiz'}
        </Btn>
        {firstPdfId && (
          <Btn kind="secondary" onClick={() => onStudy(firstPdfId)}>Open first source</Btn>
        )}
        <Btn kind="secondary" onClick={onBack}>Back to library</Btn>
      </div>

      <div style={{ marginTop: 30, borderTop: '1px solid var(--border)' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 0 10px', borderBottom: '1px solid var(--border)',
        }}>
          <Eyebrow>Sources</Eyebrow>
          <span style={{ fontSize: 10, color: 'var(--text-dim)', marginLeft: 'auto', fontFamily: 'var(--font-mono)' }}>
            {pdfs.length}
          </span>
        </div>

        {pdfs.length === 0 ? (
          <p style={{ textAlign: 'center', padding: '32px 0', fontSize: 13, color: 'var(--text-dim)', fontStyle: 'italic', fontFamily: 'var(--font-serif)' }}>
            Syncing shared sources…
          </p>
        ) : (
          pdfs.map((pdf, i) => (
            <SourceRow
              key={pdf.id}
              idx={i}
              pdf={pdf}
              displayName={getPdfDisplayName(pdf)}
              examDeadline={null}
              decks={decks}
              onStudy={onStudy}
              onDelete={() => undefined}
              onRename={() => undefined}
              onMove={() => undefined}
              onShare={() => undefined}
              onRevoke={() => undefined}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ── Today / home panel ────────────────────────────────────────────────────────

function TodayPanel({
  pdfs, filtered, decks, search, onSearchChange, density, onDensityChange,
  onStudy, onDelete, onRename, onMovePdf, onShare, onRevoke,
  getPdfDisplayName, nodeMap, daysLeft, joinStatus, joinSlug,
  showJoinPanel, onShowJoinPanel, onJoinSlugChange, onJoinBank, onStartMixedQuiz,
}: {
  pdfs: PDF[]; filtered: PDF[]; decks: Deck[]; search: string;
  onSearchChange: (v: string) => void;
  density: Density; onDensityChange: (v: Density) => void;
  onStudy: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (pdf: PDF) => void;
  onMovePdf: (pdfId: string, deckId: string | null) => Promise<void>;
  onShare: (pdfId: string) => Promise<void>;
  onRevoke: (slug: string) => Promise<void>;
  getPdfDisplayName: (pdf: PDF) => string;
  nodeMap: Map<string, import('@/types').DeckNode>;
  daysLeft: number | null;
  joinStatus: string | null;
  joinSlug: string;
  showJoinPanel: boolean;
  onShowJoinPanel: () => void;
  onJoinSlugChange: (v: string) => void;
  onJoinBank: () => void;
  onStartMixedQuiz: (slug: string) => void;
}) {
  const ready = pdfs.filter(p => p.processed_at);
  const totalQ = ready.reduce((s, p) => s + (p.question_count ?? 0), 0);
  const [tab, setTab] = useState<'sources' | 'flagged'>('sources');
  const sharedDeckGroups = useMemo(() => {
    const groups = new Map<string, { slug: string; title: string; sourceCount: number; questionCount: number }>();

    for (const pdf of pdfs) {
      if (pdf.access_scope !== 'shared' || pdf.shared_bank_source_type !== 'deck' || !pdf.shared_bank_slug) continue;
      const current = groups.get(pdf.shared_bank_slug) ?? {
        slug: pdf.shared_bank_slug,
        title: pdf.shared_bank_title ?? 'Shared question bank',
        sourceCount: 0,
        questionCount: 0,
      };
      current.sourceCount += 1;
      current.questionCount += pdf.question_count ?? 0;
      groups.set(pdf.shared_bank_slug, current);
    }

    return Array.from(groups.values()).sort((a, b) => a.title.localeCompare(b.title));
  }, [pdfs]);

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

      {sharedDeckGroups.length > 0 && (
        <div style={{ marginTop: 28, borderTop: '1px solid var(--border)' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '12px 0 10px', borderBottom: '1px solid var(--border)',
          }}>
            <Eyebrow>Shared decks</Eyebrow>
            <span style={{ fontSize: 10, color: 'var(--text-dim)', marginLeft: 'auto', fontFamily: 'var(--font-mono)' }}>
              {sharedDeckGroups.length}
            </span>
          </div>
          {sharedDeckGroups.map(group => (
            <div
              key={group.slug}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto',
                gap: 20,
                alignItems: 'center',
                padding: '16px 0',
                borderBottom: '1px solid var(--border)',
              }}
            >
              <div>
                <div style={{
                  fontFamily: 'var(--font-serif)', fontSize: 18, fontWeight: 400,
                  letterSpacing: '-0.01em', color: 'var(--text-primary)', lineHeight: 1.3,
                }}>
                  {cleanBankTitle(group.title)}
                </div>
                <div style={{
                  display: 'flex', gap: 10, marginTop: 4,
                  fontSize: 11, fontFamily: 'var(--font-mono)',
                  color: 'var(--text-dim)', letterSpacing: '0.02em', flexWrap: 'wrap',
                }}>
                  <span>{group.sourceCount} SOURCES</span>
                  <span>·</span>
                  <span>{group.questionCount.toLocaleString()} Q</span>
                </div>
              </div>
              <button
                onClick={() => onStartMixedQuiz(group.slug)}
                disabled={group.questionCount <= 0}
                style={{
                  fontSize: 11, fontWeight: 700, letterSpacing: '0.04em',
                  padding: '7px 12px', color: 'var(--accent)',
                  background: 'var(--accent-dim)', border: 'none',
                  borderRadius: 4, cursor: group.questionCount > 0 ? 'pointer' : 'default',
                  opacity: group.questionCount > 0 ? 1 : 0.5,
                  fontFamily: 'var(--font-mono)',
                  whiteSpace: 'nowrap',
                }}
              >
                START MIXED QUIZ
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Source list */}
      <div style={{ marginTop: 28, borderTop: '1px solid var(--border)' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 0 10px', borderBottom: '1px solid var(--border)',
        }}>
          {([['sources', 'Sources'], ['flagged', 'Flagged']] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: tab === key ? 'var(--accent)' : 'var(--text-dim)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              {label}
            </button>
          ))}
          <span style={{ fontSize: 10, color: 'var(--text-dim)', marginLeft: 'auto', fontFamily: 'var(--font-mono)' }}>
            {tab === 'sources' ? filtered.length : ''}
          </span>
        </div>

        {tab === 'flagged' ? (
          <FlaggedQuestionsTab />
        ) : filtered.length === 0 ? (
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

function FlaggedQuestionsTab() {
  const [rows, setRows] = useState<FlaggedQuestionRow[]>([]);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    const res = await fetch('/api/questions/flagged');
    const data = await res.json().catch(() => null) as { questions?: FlaggedQuestionRow[] } | null;
    setRows(data?.questions ?? []);
    setLoading(false);
  }

  useEffect(() => { void refresh(); }, []);

  async function unflag(questionId: string) {
    await fetch('/api/questions/flagged', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId }),
    });
    setRows(prev => prev.filter(row => row.question_id !== questionId));
  }

  if (loading) {
    return <p style={{ padding: '32px 0', color: 'var(--text-dim)', fontSize: 13 }}>Loading flagged questions...</p>;
  }

  if (!rows.length) {
    return (
      <p style={{ textAlign: 'center', padding: '32px 0', fontSize: 13, color: 'var(--text-dim)', fontStyle: 'italic', fontFamily: 'var(--font-serif)' }}>
        No flagged questions yet.
      </p>
    );
  }

  return (
    <div>
      {rows.map(row => (
        <div key={`${row.source}:${row.question_id}`} style={{
          display: 'grid',
          gridTemplateColumns: '1fr 180px auto',
          gap: 18,
          padding: '16px 0',
          borderBottom: '1px solid var(--border)',
          alignItems: 'start',
        }}>
          <div>
            <p style={{ margin: '0 0 6px', color: 'var(--text-primary)', lineHeight: 1.45 }}>{row.stem}</p>
            <p style={{ margin: 0, color: 'var(--green)', fontSize: 12 }}>Answer: {row.answer_text}</p>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            <div>{row.pdf_name}</div>
            <div>L{row.level} · {row.flag_reason ?? 'Flagged'}</div>
          </div>
          <button
            onClick={() => void unflag(row.question_id)}
            style={{
              border: '1px solid var(--border)',
              background: 'var(--bg-raised)',
              color: 'var(--text-secondary)',
              borderRadius: 'var(--r2)',
              padding: '6px 10px',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}


// ── Subject / deck detail panel ───────────────────────────────────────────────

function SubjectPanel({
  deck, pdfs, decks, getPdfDisplayName, nodeMap,
  onStudy, onDelete, onRename, onMovePdf, onShare, onRevoke,
  onShareDeck, onRevokeDeck, onStartDeckQuiz, sharedBank, shareStatus,
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
  onStartDeckQuiz: (deckId: string) => void;
  sharedBank: SharedBank | null;
  shareStatus: string | null;
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
        <Btn
          kind="primary"
          icon="play"
          disabled={totalQ <= 0}
          onClick={() => onStartDeckQuiz(deck.id)}
        >
          Start mixed quiz
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

function EmptyState() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', padding: '40px 20px' }}>
      <div style={{ textAlign: 'center', maxWidth: 400 }}>
        <div style={{ fontSize: '3rem', marginBottom: 16, animation: 'float 3s ease-in-out infinite' }}>📖</div>
        <p style={{ fontFamily: 'var(--font-serif)', fontSize: 24, fontWeight: 400, color: 'var(--text-primary)', marginBottom: 8 }}>
          No sources yet
        </p>
        <p style={{ fontSize: 14, marginBottom: 24, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          Use the Add page to join the private-generation waitlist or upload with a paid beta seat.
        </p>
      </div>
    </div>
  );
}
