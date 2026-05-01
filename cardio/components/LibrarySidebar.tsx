'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { Deck, DeckNode, PDF } from '@/types';
import { isBinding, loadKeybindings } from '@/lib/keybindings';
import { Icon } from './ui';

// ─── Tree assembly ────────────────────────────────────────────────────────────

export function buildDeckTree(decks: Deck[], pdfs: PDF[]): {
  roots: DeckNode[];
  nodeMap: Map<string, DeckNode>;
} {
  const pdfCounts = new Map<string, number>();
  for (const p of pdfs) {
    if (p.deck_id) pdfCounts.set(p.deck_id, (pdfCounts.get(p.deck_id) ?? 0) + 1);
  }

  const nodeMap = new Map<string, DeckNode>();
  for (const d of decks) {
    nodeMap.set(d.id, { ...d, children: [], ownPdfCount: pdfCounts.get(d.id) ?? 0, totalPdfCount: 0 });
  }

  const roots: DeckNode[] = [];
  nodeMap.forEach(node => {
    if (node.parent_id && nodeMap.has(node.parent_id)) {
      nodeMap.get(node.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  });

  function sortNodes(nodes: DeckNode[]) {
    nodes.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    for (const n of nodes) sortNodes(n.children);
  }
  sortNodes(roots);

  function calcTotal(node: DeckNode): number {
    const sub = node.children.reduce((s, c) => s + calcTotal(c), 0);
    node.totalPdfCount = node.ownPdfCount + sub;
    return node.totalPdfCount;
  }
  for (const r of roots) calcTotal(r);

  return { roots, nodeMap };
}

/** Walk up to find the nearest ancestor exam-block due_date. */
export function findExamDeadline(deckId: string | null, nodeMap: Map<string, DeckNode>): string | null {
  let cur = deckId ? nodeMap.get(deckId) ?? null : null;
  while (cur) {
    if (cur.is_exam_block && cur.due_date) return cur.due_date;
    cur = cur.parent_id ? nodeMap.get(cur.parent_id) ?? null : null;
  }
  return null;
}

/** All deck IDs reachable from (and including) deckId. */
export function descendantIds(deckId: string, nodeMap: Map<string, DeckNode>): Set<string> {
  const ids = new Set<string>();
  function walk(id: string) {
    ids.add(id);
    for (const c of nodeMap.get(id)?.children ?? []) walk(c.id);
  }
  walk(deckId);
  return ids;
}

// ─── Expanded state (localStorage) ───────────────────────────────────────────

const EXPANDED_KEY = 'cardio_deck_expanded';

function loadExpanded(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try { return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]')); } catch { return new Set(); }
}
function saveExpanded(ids: Set<string>) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(EXPANDED_KEY, JSON.stringify(Array.from(ids)));
}

// ─── Exam badge helpers ───────────────────────────────────────────────────────

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}
function examColor(days: number): string {
  if (days <= 0)  return '#ef4444';   // red   — overdue
  if (days <= 7)  return '#f97316';   // orange — very soon
  if (days <= 21) return '#f59e0b';   // amber
  return '#6b7280';                   // gray — far out
}

// ─── Creation state ───────────────────────────────────────────────────────────

interface CreationState {
  parentId: string | null;
  name: string;
  isExamBlock: boolean;
  dueDate: string;
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  decks: Deck[];
  pdfs: PDF[];
  selectedDeckId: string | null;
  onSelectDeck: (id: string | null) => void;
  onCreateDeck: (parentId: string | null, name: string, isExamBlock: boolean, dueDate: string | null) => Promise<void>;
  onRenameDeck: (id: string, name: string) => Promise<void>;
  onDeleteDeck: (id: string) => Promise<void>;
  onMoveDeck: (id: string, newParentId: string | null) => Promise<void>;
  onMovePdf: (pdfId: string, deckId: string | null) => Promise<void>;
  onShareDeck: (deckId: string) => Promise<void>;
  sharedDeckIds: Set<string>;
}

export default function LibrarySidebar({
  decks, pdfs, selectedDeckId, onSelectDeck,
  onCreateDeck, onRenameDeck, onDeleteDeck, onMoveDeck, onMovePdf, onShareDeck, sharedDeckIds,
}: Props) {
  const [expanded,   setExpanded]   = useState<Set<string>>(new Set());
  const [renaming,   setRenaming]   = useState<string | null>(null);
  const [renameVal,  setRenameVal]  = useState('');
  const [creating,   setCreating]   = useState<CreationState | null>(null);
  const [dragOver,   setDragOver]   = useState<string | 'root' | null>(null);
  const [errorToast, setErrorToast] = useState<string | null>(null);
  const [keybindings, setKeybindings] = useState(loadKeybindings);
  const renameRef      = useRef<HTMLInputElement>(null);
  const createRef      = useRef<HTMLInputElement>(null);
  const expandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { setExpanded(loadExpanded()); }, []);
  useEffect(() => {
    function refresh() { setKeybindings(loadKeybindings()); }
    window.addEventListener('storage', refresh);
    window.addEventListener('cardio:keybindings-changed', refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener('cardio:keybindings-changed', refresh);
    };
  }, []);

  const { roots, nodeMap } = useMemo(() => buildDeckTree(decks, pdfs), [decks, pdfs]);

  const totalPdfs = pdfs.length;
  const uncategorized = pdfs.filter(p => !p.deck_id).length;

  // ── Expand / collapse ──────────────────────────────────────────────────────

  const toggle = useCallback((id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      saveExpanded(next);
      return next;
    });
  }, []);

  // ── Rename ────────────────────────────────────────────────────────────────

  function startRename(node: DeckNode) {
    setRenaming(node.id);
    setRenameVal(node.name);
    setTimeout(() => renameRef.current?.select(), 30);
  }

  async function commitRename() {
    if (!renaming) return;
    const trimmed = renameVal.trim();
    if (trimmed && trimmed !== nodeMap.get(renaming)?.name) {
      await onRenameDeck(renaming, trimmed);
    }
    setRenaming(null);
  }

  // ── Creation ──────────────────────────────────────────────────────────────

  function startCreate(parentId: string | null) {
    setCreating({ parentId, name: '', isExamBlock: false, dueDate: '' });
    if (parentId) {
      setExpanded(prev => {
        const next = new Set(prev); next.add(parentId); saveExpanded(next); return next;
      });
    }
    setTimeout(() => createRef.current?.focus(), 30);
  }

  async function commitCreate() {
    if (!creating || !creating.name.trim()) { setCreating(null); return; }
    await onCreateDeck(
      creating.parentId,
      creating.name.trim(),
      creating.isExamBlock,
      creating.isExamBlock && creating.dueDate ? creating.dueDate : null,
    );
    setCreating(null);
  }

  // ── Drag helpers ──────────────────────────────────────────────────────────

  function clearDragState() {
    setDragOver(null);
    if (expandTimerRef.current) { clearTimeout(expandTimerRef.current); expandTimerRef.current = null; }
  }

  function onDragStart(e: React.DragEvent, type: 'deck' | 'pdf', id: string) {
    e.dataTransfer.setData(`cardio/${type}`, id);
    e.dataTransfer.effectAllowed = 'move';
  }

  function onDragOver(e: React.DragEvent, target: string | 'root') {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(target);
    if (typeof target === 'string' && target !== 'root') {
      if (!expanded.has(target)) {
        if (expandTimerRef.current) clearTimeout(expandTimerRef.current);
        expandTimerRef.current = setTimeout(() => {
          setExpanded(prev => {
            const next = new Set(prev); next.add(target); saveExpanded(next); return next;
          });
          expandTimerRef.current = null;
        }, 700);
      }
    } else {
      if (expandTimerRef.current) { clearTimeout(expandTimerRef.current); expandTimerRef.current = null; }
    }
  }

  async function onDrop(e: React.DragEvent, targetDeckId: string | null) {
    e.preventDefault();
    clearDragState();
    const deckId = e.dataTransfer.getData('cardio/deck');
    const pdfId  = e.dataTransfer.getData('cardio/pdf');
    if (deckId && deckId !== targetDeckId) {
      if (targetDeckId && descendantIds(deckId, nodeMap).has(targetDeckId)) {
        setErrorToast("Can't move a deck into one of its own subdecks.");
        setTimeout(() => setErrorToast(null), 3000);
        return;
      }
      await onMoveDeck(deckId, targetDeckId);
    } else if (pdfId) {
      await onMovePdf(pdfId, targetDeckId);
    }
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (!selectedDeckId || selectedDeckId === '__uncategorized__') return;
    const node = nodeMap.get(selectedDeckId);
    if (!node) return;
    if (isBinding(e, keybindings, 'library.newDeck')) { e.preventDefault(); startCreate(selectedDeckId); }
    if (isBinding(e, keybindings, 'library.renameDeck')) { e.preventDefault(); startRename(node); }
    if (isBinding(e, keybindings, 'library.deleteDeck') && !renaming && !creating) {
      e.preventDefault();
      if (confirm(`Delete "${node.name}"? PDFs will become uncategorized.`)) void onDeleteDeck(selectedDeckId);
    }
  }

  // ── Render helpers ────────────────────────────────────────────────────────

  const s = styles;

  function renderCreationRow(parentId: string | null, depth: number) {
    if (!creating || creating.parentId !== parentId) return null;
    const indent = 12 + depth * 16;
    return (
      <div style={{ paddingLeft: indent, paddingRight: 8, paddingTop: 2, paddingBottom: 2 }}>
        <div style={{ ...s.createBox }}>
          <input
            ref={createRef}
            value={creating.name}
            placeholder="Deck name…"
            onChange={e => setCreating(c => c ? { ...c, name: e.target.value } : c)}
            onKeyDown={e => {
              if (e.key === 'Enter') commitCreate();
              if (e.key === 'Escape') setCreating(null);
            }}
            style={s.createInput}
          />
          <label style={s.examToggle}>
            <input
              type="checkbox"
              checked={creating.isExamBlock}
              onChange={e => setCreating(c => c ? { ...c, isExamBlock: e.target.checked } : c)}
              style={{ accentColor: '#f59e0b', marginRight: 4 }}
            />
            <span style={{ color: '#f59e0b', fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.08em' }}>EXAM</span>
          </label>
          {creating.isExamBlock && (
            <input
              type="date"
              value={creating.dueDate}
              onChange={e => setCreating(c => c ? { ...c, dueDate: e.target.value } : c)}
              style={{ ...s.createInput, marginTop: 4, width: '100%' }}
            />
          )}
          <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
            <button onClick={commitCreate} style={s.confirmBtn}>Create</button>
            <button onClick={() => setCreating(null)} style={s.cancelBtn}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  function renderNode(node: DeckNode, depth: number): React.ReactNode {
    const isExpanded  = expanded.has(node.id);
    const isSelected  = selectedDeckId === node.id;
    const isRenaming  = renaming === node.id;
    const isDragOver  = dragOver === node.id;
    const hasChildren = node.children.length > 0 || (creating?.parentId === node.id);
    const isShared    = sharedDeckIds.has(node.id);
    const indent      = 12 + depth * 16;

    let examLabel: React.ReactNode = null;
    if (node.is_exam_block && node.due_date) {
      const days = daysUntil(node.due_date);
      const col  = examColor(days);
      const label = days <= 0 ? 'OVERDUE' : days === 1 ? '1d' : `${days}d`;
      examLabel = (
        <span style={{ ...s.examBadge, color: col, borderColor: `${col}44` }}>
          {label}
        </span>
      );
    } else if (node.is_exam_block) {
      examLabel = <span style={{ ...s.examBadge, color: '#f59e0b', borderColor: '#f59e0b44' }}>EXAM</span>;
    }

    return (
      <div key={node.id}>
        {/* Row */}
        <div
          draggable
          onDragStart={e => onDragStart(e, 'deck', node.id)}
          onDragOver={e => onDragOver(e, node.id)}
          onDragLeave={clearDragState}
          onDrop={e => onDrop(e, node.id)}
          onClick={() => onSelectDeck(node.id)}
          onDoubleClick={() => startRename(node)}
          style={{
            ...s.row,
            position: 'relative',
            paddingLeft: indent,
            background: isSelected
              ? 'var(--accent-dim)'
              : isDragOver
              ? 'rgba(13,154,170,0.12)'
              : undefined,
            color: isSelected ? 'var(--accent)' : 'var(--text-secondary)',
            outline: isDragOver ? '1px solid var(--accent)' : undefined,
          }}
          className={`deck-row${isSelected ? ' deck-row-selected' : ''}`}
        >
          {/* Indent guides */}
          {depth > 0 && Array.from({ length: depth }, (_, i) => (
            <span key={i} aria-hidden style={{
              position: 'absolute',
              left: 12 + i * 16 + 8,
              top: 0, bottom: 0,
              width: 1,
              background: 'rgba(128,128,128,0.08)',
              pointerEvents: 'none',
            }} />
          ))}
          {/* Chevron */}
          <button
            onClick={e => { e.stopPropagation(); toggle(node.id); }}
            style={{
              ...s.chevronBtn,
              transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
              opacity: hasChildren ? 1 : 0,
            }}
          >
            <ChevronIcon />
          </button>

          {/* Icon */}
          <span style={{ marginRight: 5, fontSize: '0.75rem', flexShrink: 0 }}>
            {node.is_exam_block ? '📅' : '◻'}
          </span>

          {/* Name (or rename input) */}
          {isRenaming ? (
            <input
              ref={renameRef}
              value={renameVal}
              onChange={e => setRenameVal(e.target.value)}
              onBlur={commitRename}
              onKeyDown={e => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setRenaming(null);
              }}
              onClick={e => e.stopPropagation()}
              style={s.renameInput}
            />
          ) : (
            <span style={s.nodeName} title={node.name}>{node.name}</span>
          )}

          {examLabel}

          {isShared && (
            <span title="Shared folder" style={s.sharedBadge}>🔗</span>
          )}

          {/* Count badge */}
          {node.totalPdfCount > 0 && (
            <span style={s.countBadge}>{node.totalPdfCount}</span>
          )}

          {/* Hover actions */}
          {!isRenaming && (
            <span className="row-actions" style={s.rowActions}>
              <ActionBtn title="Add subdeck" onClick={e => { e.stopPropagation(); startCreate(node.id); }}>+</ActionBtn>
              <ActionBtn title="Share folder" onClick={e => { e.stopPropagation(); void onShareDeck(node.id); }}>
                <Icon name="share" size={14} />
              </ActionBtn>
              <ActionBtn title="Rename" onClick={e => { e.stopPropagation(); startRename(node); }}>✎</ActionBtn>
              <ActionBtn
                title="Delete deck"
                danger
                onClick={e => {
                  e.stopPropagation();
                  if (confirm(`Delete "${node.name}"? PDFs will become uncategorized.`)) onDeleteDeck(node.id);
                }}
              >✕</ActionBtn>
            </span>
          )}
        </div>

        {/* Children */}
        {isExpanded && (
          <div>
            {node.children.map(child => renderNode(child, depth + 1))}
            {renderCreationRow(node.id, depth + 1)}
          </div>
        )}
      </div>
    );
  }

  return (
    <aside
      style={s.sidebar}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onDragOver={e => onDragOver(e, 'root')}
      onDragLeave={clearDragState}
      onDrop={e => onDrop(e, null)}
    >
      {/* Header */}
      <div style={s.header}>
        <span style={s.headerLabel}>Library</span>
        <ActionBtn title="New deck" onClick={() => startCreate(null)}>+ New</ActionBtn>
      </div>

      {/* All decks row */}
      <div
        onClick={() => onSelectDeck(null)}
        style={{
          ...s.row,
          paddingLeft: 12,
          background: selectedDeckId === null ? 'var(--accent-dim)' : undefined,
          color: selectedDeckId === null ? 'var(--accent)' : 'var(--text-secondary)',
          fontWeight: 600,
        }}
        className="deck-row"
      >
        <span style={{ marginRight: 5, fontSize: '0.75rem' }}>◈</span>
        <span style={s.nodeName}>All Decks</span>
        {totalPdfs > 0 && <span style={s.countBadge}>{totalPdfs}</span>}
      </div>

      {/* Tree */}
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {roots.map(node => renderNode(node, 0))}
        {renderCreationRow(null, 0)}

        {/* Uncategorized */}
        {uncategorized > 0 && (
          <div
            onClick={() => onSelectDeck('__uncategorized__')}
            style={{
              ...s.row,
              paddingLeft: 12,
              marginTop: 4,
              background: selectedDeckId === '__uncategorized__' ? 'var(--accent-dim)' : undefined,
              color:      selectedDeckId === '__uncategorized__' ? 'var(--accent)'     : 'var(--text-dim)',
            }}
            className="deck-row"
          >
            <span style={{ marginRight: 5, fontSize: '0.75rem' }}>◌</span>
            <span style={{ ...s.nodeName, fontStyle: 'italic' }}>Uncategorized</span>
            <span style={s.countBadge}>{uncategorized}</span>
          </div>
        )}
      </div>

      {/* Error toast */}
      {errorToast && (
        <div style={{
          position: 'absolute', bottom: 12, left: 8, right: 8,
          background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)',
          color: '#ef4444', borderRadius: 6, padding: '7px 10px',
          fontSize: '0.72rem', fontWeight: 500, pointerEvents: 'none',
          animation: 'fade-up 0.2s ease',
        }}>
          {errorToast}
        </div>
      )}

      {/* Inline styles for hover/focus states */}
      <style>{`
        .deck-row:hover { background: var(--bg-raised) !important; }
        .deck-row:hover .row-actions,
        .deck-row-selected .row-actions { opacity: 1 !important; }
        .deck-row .row-actions { opacity: 0.3; transition: opacity 0.12s; }
      `}</style>
    </aside>
  );
}

// ─── Small reusable components ────────────────────────────────────────────────

function ChevronIcon() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polyline points="2,1 6,4 2,7" />
    </svg>
  );
}

function ActionBtn({
  title, onClick, danger = false, children,
}: { title: string; onClick: (e: React.MouseEvent) => void; danger?: boolean; children: React.ReactNode }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        padding: '0 5px', height: '20px', minWidth: '20px',
        borderRadius: 'var(--radius-sm)',
        fontSize: '0.72rem', fontWeight: 600,
        background: hov ? (danger ? 'rgba(239,68,68,0.12)' : 'var(--accent-dim)') : 'transparent',
        color:      hov ? (danger ? '#ef4444'               : 'var(--accent)')    : 'var(--text-dim)',
        border: 'none', cursor: 'pointer', transition: 'all 0.12s',
      }}
    >
      {children}
    </button>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  sidebar: {
    width: '224px',
    minWidth: '224px',
    maxWidth: '224px',
    display: 'flex',
    flexDirection: 'column' as const,
    borderRight: '1px solid var(--border)',
    background: 'var(--bg)',
    overflowY: 'hidden' as const,
    userSelect: 'none' as const,
    position: 'relative' as const,
    outline: 'none',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 10px 8px 12px',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  },
  headerLabel: {
    fontSize: '0.62rem',
    fontWeight: 800,
    letterSpacing: '0.13em',
    textTransform: 'uppercase' as const,
    color: 'var(--text-dim)',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    height: '30px',
    paddingRight: 6,
    borderRadius: 4,
    margin: '1px 4px',
    cursor: 'pointer',
    transition: 'background 0.1s',
    fontSize: '0.8rem',
    gap: 2,
    overflow: 'hidden',
  },
  nodeName: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    fontSize: '0.8rem',
  },
  countBadge: {
    fontSize: '0.65rem',
    fontWeight: 600,
    padding: '1px 5px',
    borderRadius: '99px',
    background: 'var(--bg-sunken)',
    color: 'var(--text-dim)',
    flexShrink: 0,
    marginLeft: 2,
  },
  examBadge: {
    fontSize: '0.6rem',
    fontWeight: 700,
    letterSpacing: '0.07em',
    padding: '1px 4px',
    borderRadius: '3px',
    border: '1px solid',
    flexShrink: 0,
    marginLeft: 2,
  },
  sharedBadge: {
    fontSize: '0.68rem',
    lineHeight: 1,
    color: 'var(--accent)',
    flexShrink: 0,
    marginLeft: 2,
  },
  chevronBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '16px',
    height: '16px',
    flexShrink: 0,
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--text-dim)',
    transition: 'transform 0.15s',
    padding: 0,
  },
  renameInput: {
    flex: 1,
    background: 'var(--bg-raised)',
    border: '1px solid var(--accent)',
    borderRadius: 3,
    padding: '1px 5px',
    fontSize: '0.8rem',
    color: 'var(--text-primary)',
    outline: 'none',
    minWidth: 0,
  },
  rowActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 1,
    flexShrink: 0,
    marginLeft: 2,
  },
  createBox: {
    background: 'var(--bg-raised)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    padding: '8px 10px',
    marginBottom: 4,
  },
  createInput: {
    width: '100%',
    background: 'var(--bg-sunken)',
    border: '1px solid var(--border)',
    borderRadius: 3,
    padding: '4px 7px',
    fontSize: '0.78rem',
    color: 'var(--text-primary)',
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  examToggle: {
    display: 'flex',
    alignItems: 'center',
    marginTop: 6,
    cursor: 'pointer',
    fontSize: '0.72rem',
  },
  confirmBtn: {
    flex: 1,
    padding: '3px 0',
    background: 'var(--accent)',
    color: 'white',
    border: 'none',
    borderRadius: 3,
    fontSize: '0.72rem',
    fontWeight: 600,
    cursor: 'pointer',
  },
  cancelBtn: {
    flex: 1,
    padding: '3px 0',
    background: 'var(--bg-sunken)',
    color: 'var(--text-dim)',
    border: '1px solid var(--border)',
    borderRadius: 3,
    fontSize: '0.72rem',
    cursor: 'pointer',
  },
} as const;
