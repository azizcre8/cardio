'use client';

import React, { useEffect, useMemo, useState } from 'react';
import type { Deck, DeckNode, PDF } from '@/types';
import type { PdfSrsSummary } from '@/app/api/study/summary/route';
import { buildDeckTree } from './LibrarySidebar';

interface Props {
  pdfs: PDF[];
  decks: Deck[];
  onStartQuiz: (pdfId: string) => void;
  onOpenConceptMap: (pdfId: string) => void;
  onSetView: (view: 'add') => void;
  onPdfsChange: (pdfs: PDF[]) => void;
  onViewBank: (pdfId: string) => void;
}

export default function BanksView({ pdfs, decks, onStartQuiz, onOpenConceptMap, onSetView, onPdfsChange, onViewBank }: Props) {
  const { roots } = useMemo(() => buildDeckTree(decks, pdfs), [decks, pdfs]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(roots.map(r => r.id)));
  const [srsByPdf, setSrsByPdf] = useState<Record<string, PdfSrsSummary>>({});

  useEffect(() => {
    if (pdfs.length === 0) return;
    fetch('/api/study/summary')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.byPdf) setSrsByPdf(d.byPdf as Record<string, PdfSrsSummary>); })
      .catch(() => {});
  }, [pdfs.length]);

  function toggle(id: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const uncategorized = pdfs.filter(p => !p.deck_id);
  const totalPdfs = pdfs.length;
  const totalQuestions = pdfs.reduce((s, p) => s + (p.question_count ?? 0), 0);
  const isEmpty = decks.length === 0 && pdfs.length === 0;

  // Aggregate SRS counts for a list of PDF ids
  function sumSrs(pdfIds: string[]): PdfSrsSummary {
    return pdfIds.reduce(
      (acc, id) => {
        const s = srsByPdf[id];
        if (!s) return acc;
        return { new: acc.new + s.new, due: acc.due + s.due, learning: acc.learning + s.learning };
      },
      { new: 0, due: 0, learning: 0 },
    );
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '32px 40px' }}>
      <div style={{ maxWidth: 660, margin: '0 auto' }}>

        {/* Heading */}
        <div style={{ marginBottom: 28 }}>
          <h2 style={{
            fontFamily: 'var(--font-serif)',
            fontSize: '1.25rem',
            fontWeight: 400,
            color: 'var(--text-primary)',
            margin: '0 0 6px',
          }}>
            Your Banks
          </h2>
          {!isEmpty && (
            <p style={{ fontSize: 13, color: 'var(--text-dim)', margin: 0 }}>
              <span style={{ color: 'var(--accent)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                {totalPdfs}
              </span>
              {' '}PDF{totalPdfs !== 1 ? 's' : ''}
              {totalQuestions > 0 && (
                <>
                  {' · '}
                  <span style={{ color: 'var(--green)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                    {totalQuestions.toLocaleString()}
                  </span>
                  {' '}questions
                </>
              )}
            </p>
          )}
        </div>

        {isEmpty ? (
          <EmptyState onAdd={() => onSetView('add')} />
        ) : (
          <>
            {roots.map(node => (
              <DeckCard
                key={node.id}
                node={node}
                pdfs={pdfs}
                decks={decks}
                expanded={expanded}
                srsByPdf={srsByPdf}
                sumSrs={sumSrs}
                onToggle={toggle}
                onStartQuiz={onStartQuiz}
                onOpenConceptMap={onOpenConceptMap}
                onPdfsChange={onPdfsChange}
                onViewBank={onViewBank}
                level={0}
              />
            ))}

            {uncategorized.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <UncategorizedCard
                  pdfs={uncategorized}
                  allPdfs={pdfs}
                  decks={decks}
                  srsByPdf={srsByPdf}
                  onStartQuiz={onStartQuiz}
                  onOpenConceptMap={onOpenConceptMap}
                  onPdfsChange={onPdfsChange}
                  onViewBank={onViewBank}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function DeckCard({
  node, pdfs, decks, expanded, srsByPdf, sumSrs, onToggle, onStartQuiz, onOpenConceptMap, onPdfsChange, onViewBank, level,
}: {
  node: DeckNode;
  pdfs: PDF[];
  decks: Deck[];
  expanded: Set<string>;
  srsByPdf: Record<string, PdfSrsSummary>;
  sumSrs: (ids: string[]) => PdfSrsSummary;
  onToggle: (id: string) => void;
  onStartQuiz: (pdfId: string) => void;
  onOpenConceptMap: (pdfId: string) => void;
  onPdfsChange: (pdfs: PDF[]) => void;
  onViewBank: (pdfId: string) => void;
  level: number;
}) {
  const [hovered, setHovered] = useState(false);
  const isOpen = expanded.has(node.id);
  const hasChildren = node.children.length > 0;
  const ownPdfs = pdfs.filter(p => p.deck_id === node.id);
  const hasItems = hasChildren || ownPdfs.length > 0;

  // Collect all PDF ids in this subtree for SRS aggregation
  function subtreePdfIds(n: DeckNode): string[] {
    const own = pdfs.filter(p => p.deck_id === n.id).map(p => p.id);
    return [...own, ...n.children.flatMap(c => subtreePdfIds(c))];
  }
  const allPdfIds = subtreePdfIds(node);
  const srs = sumSrs(allPdfIds);
  const hasSrs = srs.due > 0 || srs.learning > 0 || srs.new > 0;
  const studyPdf = ownPdfs.find(p => (p.question_count ?? 0) > 0)
    ?? (hasChildren ? pdfs.find(p => allPdfIds.includes(p.id) && (p.question_count ?? 0) > 0) : undefined);

  return (
    <div style={{ marginBottom: 4 }}>
      <div
        onClick={() => hasItems && onToggle(node.id)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: `13px ${16 + level * 20}px`,
          borderRadius: 8,
          background: hovered ? 'var(--bg-sunken)' : 'transparent',
          cursor: hasItems ? 'pointer' : 'default',
          transition: 'background 0.15s',
          userSelect: 'none',
        }}
      >
        {/* Chevron */}
        <div style={{ width: 20, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {hasItems && (
            <span style={{
              fontSize: 10,
              color: 'var(--text-dim)',
              transform: isOpen ? 'rotate(90deg)' : 'rotate(0)',
              transition: 'transform 0.2s',
              display: 'inline-block',
            }}>
              ▶
            </span>
          )}
        </div>

        {/* Name + stats */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 14,
            fontWeight: 500,
            color: 'var(--text-primary)',
            marginBottom: 3,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>
            {node.name}
          </div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            {hasSrs ? (
              <>
                {srs.due > 0 && <StatBadge value={srs.due} label="due" color="var(--amber)" />}
                {srs.learning > 0 && <StatBadge value={srs.learning} label="learning" color="var(--green)" />}
                {srs.new > 0 && <StatBadge value={srs.new} label="new" color="var(--accent)" />}
              </>
            ) : node.totalPdfCount > 0 ? (
              <span style={{ fontSize: 11, color: 'var(--text-disabled)' }}>all done</span>
            ) : (
              <span style={{ fontSize: 11, color: 'var(--text-disabled)' }}>empty</span>
            )}
          </div>
        </div>

        {/* Study button */}
        {studyPdf && hovered && (
          <StudyBtn onClick={e => { e.stopPropagation(); onStartQuiz(studyPdf.id); }} />
        )}
      </div>

      {/* Children: sub-decks + own PDFs */}
      {isOpen && (
        <>
          {node.children.map(child => (
            <DeckCard
              key={child.id}
              node={child}
              pdfs={pdfs}
              decks={decks}
              expanded={expanded}
              srsByPdf={srsByPdf}
              sumSrs={sumSrs}
              onToggle={onToggle}
              onStartQuiz={onStartQuiz}
              onOpenConceptMap={onOpenConceptMap}
              onPdfsChange={onPdfsChange}
              onViewBank={onViewBank}
              level={level + 1}
            />
          ))}
          {ownPdfs.map(pdf => (
            <PdfRow
              key={pdf.id}
              pdf={pdf}
              decks={decks}
              allPdfs={pdfs}
              srs={srsByPdf[pdf.id]}
              level={level + 1}
              onStudy={() => onStartQuiz(pdf.id)}
              onOpen={() => onOpenConceptMap(pdf.id)}
              onPdfsChange={onPdfsChange}
              onViewBank={() => onViewBank(pdf.id)}
            />
          ))}
        </>
      )}
    </div>
  );
}

function UncategorizedCard({
  pdfs, allPdfs, decks, srsByPdf, onStartQuiz, onOpenConceptMap, onPdfsChange, onViewBank,
}: {
  pdfs: PDF[];
  allPdfs: PDF[];
  decks: Deck[];
  srsByPdf: Record<string, PdfSrsSummary>;
  onStartQuiz: (pdfId: string) => void;
  onOpenConceptMap: (pdfId: string) => void;
  onPdfsChange: (pdfs: PDF[]) => void;
  onViewBank: (pdfId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);

  return (
    <div>
      <div
        onClick={() => setOpen(o => !o)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '13px 16px', borderRadius: 8,
          background: hovered ? 'var(--bg-sunken)' : 'transparent',
          cursor: 'pointer', transition: 'background 0.15s', userSelect: 'none',
        }}
      >
        <div style={{ width: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{
            fontSize: 10, color: 'var(--text-dim)',
            transform: open ? 'rotate(90deg)' : 'rotate(0)',
            transition: 'transform 0.2s', display: 'inline-block',
          }}>▶</span>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-dim)', marginBottom: 3 }}>
            Uncategorized
          </div>
          {(() => {
            const srs = pdfs.reduce(
              (acc, p) => {
                const s = srsByPdf[p.id];
                if (!s) return acc;
                return { new: acc.new + s.new, due: acc.due + s.due, learning: acc.learning + s.learning };
              },
              { new: 0, due: 0, learning: 0 },
            );
            return srs.due > 0 || srs.learning > 0 || srs.new > 0 ? (
              <div style={{ display: 'flex', gap: 14 }}>
                {srs.due > 0 && <StatBadge value={srs.due} label="due" color="var(--amber)" />}
                {srs.learning > 0 && <StatBadge value={srs.learning} label="learning" color="var(--green)" />}
                {srs.new > 0 && <StatBadge value={srs.new} label="new" color="var(--accent)" />}
              </div>
            ) : (
              <StatBadge value={pdfs.length} label={pdfs.length === 1 ? 'PDF' : 'PDFs'} color="var(--text-dim)" />
            );
          })()}
        </div>
      </div>
      {open && pdfs.map(pdf => (
        <PdfRow
          key={pdf.id}
          pdf={pdf}
          decks={decks}
          allPdfs={allPdfs}
          srs={srsByPdf[pdf.id]}
          level={1}
          onStudy={() => onStartQuiz(pdf.id)}
          onOpen={() => onOpenConceptMap(pdf.id)}
          onPdfsChange={onPdfsChange}
          onViewBank={() => onViewBank(pdf.id)}
        />
      ))}
    </div>
  );
}

function PdfRow({
  pdf, decks, allPdfs, srs, level, onStudy, onOpen, onPdfsChange, onViewBank,
}: {
  pdf: PDF;
  decks: Deck[];
  allPdfs: PDF[];
  srs?: PdfSrsSummary;
  level: number;
  onStudy: () => void;
  onOpen: () => void;
  onPdfsChange: (pdfs: PDF[]) => void;
  onViewBank: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [subMenu, setSubMenu] = useState<'move' | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState(pdf.display_name ?? pdf.name);
  const [moving, setMoving] = useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const hasQuestions = (pdf.question_count ?? 0) > 0;
  const hasSrs = srs && (srs.due > 0 || srs.learning > 0 || srs.new > 0);

  function closeMenu() { setMenuOpen(false); setSubMenu(null); }

  React.useEffect(() => {
    if (!menuOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) closeMenu();
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  async function moveTo(deckId: string | null) {
    closeMenu();
    setMoving(true);
    try {
      const res = await fetch(`/api/pdfs/${pdf.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deck_id: deckId }),
      });
      if (res.ok) {
        onPdfsChange(allPdfs.map(p => p.id === pdf.id ? { ...p, deck_id: deckId } : p));
      }
    } finally {
      setMoving(false);
    }
  }

  async function submitRename() {
    const trimmed = renameVal.trim();
    setRenaming(false);
    if (!trimmed || trimmed === (pdf.display_name ?? pdf.name)) return;
    const res = await fetch(`/api/pdfs/${pdf.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: trimmed }),
    });
    if (res.ok) {
      onPdfsChange(allPdfs.map(p => p.id === pdf.id ? { ...p, display_name: trimmed } : p));
    }
  }

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ position: 'relative' }}
    >
      <div
        onClick={renaming ? undefined : onOpen}
        style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: `10px ${16 + level * 20}px`,
          borderRadius: 6,
          cursor: renaming ? 'default' : 'pointer',
          background: hovered ? 'var(--bg-sunken)' : 'transparent',
          transition: 'background 0.15s',
          opacity: moving ? 0.5 : 1,
        }}
      >
        <div style={{ width: 20, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: 13, opacity: 0.4 }}>📄</span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {renaming ? (
            <input
              autoFocus
              value={renameVal}
              onChange={e => setRenameVal(e.target.value)}
              onBlur={() => void submitRename()}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); void submitRename(); }
                if (e.key === 'Escape') { setRenaming(false); setRenameVal(pdf.display_name ?? pdf.name); }
              }}
              onClick={e => e.stopPropagation()}
              style={{
                width: '100%', fontSize: 13, fontWeight: 400,
                color: 'var(--text-primary)',
                background: 'var(--bg-raised)',
                border: '1px solid var(--accent)',
                borderRadius: 4, padding: '2px 6px',
                fontFamily: 'var(--font-sans)', outline: 'none',
              }}
            />
          ) : (
            <div style={{
              fontSize: 13, fontWeight: 400, color: 'var(--text-secondary)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {pdf.display_name ?? pdf.name}
            </div>
          )}
          {!renaming && (
            <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
              {hasSrs ? (
                <>
                  {srs!.due > 0 && <StatBadge value={srs!.due} label="due" color="var(--amber)" />}
                  {srs!.learning > 0 && <StatBadge value={srs!.learning} label="learning" color="var(--green)" />}
                  {srs!.new > 0 && <StatBadge value={srs!.new} label="new" color="var(--accent)" />}
                </>
              ) : hasQuestions ? (
                <span style={{ fontSize: 10, color: 'var(--text-disabled)', fontFamily: 'var(--font-mono)' }}>
                  {pdf.question_count}q · all done
                </span>
              ) : pdf.processed_at === null ? (
                <span style={{ fontSize: 10, color: 'var(--amber)' }}>processing…</span>
              ) : null}
            </div>
          )}
        </div>

        {/* Three-dot menu button */}
        {hovered && !renaming && (
          <button
            onClick={e => { e.stopPropagation(); setMenuOpen(o => !o); setSubMenu(null); }}
            title="Options"
            style={{
              width: 26, height: 26, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: menuOpen ? 'var(--bg-raised)' : 'transparent',
              border: `1px solid ${menuOpen ? 'var(--border-med)' : 'transparent'}`,
              borderRadius: 5, cursor: 'pointer',
              fontSize: 14, color: 'var(--text-dim)',
              transition: 'all 0.1s',
            }}
          >
            ···
          </button>
        )}
      </div>

      {/* Kebab dropdown */}
      {menuOpen && (
        <div
          ref={menuRef}
          onClick={e => e.stopPropagation()}
          style={{
            position: 'absolute', top: '100%', right: 16, zIndex: 50,
            background: 'var(--bg-raised)',
            border: '1px solid var(--border-med)',
            borderRadius: 'var(--r2)',
            boxShadow: 'var(--shadow-2)',
            minWidth: 180, overflow: 'hidden',
          }}
        >
          {subMenu === 'move' ? (
            <>
              <div style={{
                padding: '6px 10px 4px', fontSize: 10, fontWeight: 600,
                letterSpacing: '0.08em', textTransform: 'uppercase',
                color: 'var(--text-dim)', borderBottom: '1px solid var(--border)',
                display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
              }}
                onClick={() => setSubMenu(null)}
              >
                ← Move to bank
              </div>
              {pdf.deck_id && (
                <PickerOption label="No bank (uncategorized)" onSelect={() => void moveTo(null)} />
              )}
              {decks.map(d => (
                d.id !== pdf.deck_id && (
                  <PickerOption key={d.id} label={d.name} indent={d.depth ?? 0} onSelect={() => void moveTo(d.id)} />
                )
              ))}
              {decks.length === 0 && (
                <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text-dim)' }}>No banks yet</div>
              )}
            </>
          ) : (
            <>
              {hasQuestions && (
                <MenuOption label="View Questions" onClick={() => { closeMenu(); onViewBank(); }} />
              )}
              {hasQuestions && (
                <MenuOption label="Study" onClick={() => { closeMenu(); onStudy(); }} />
              )}
              {hasQuestions && <MenuDivider />}
              <MenuOption label="Rename" onClick={() => { closeMenu(); setRenaming(true); setRenameVal(pdf.display_name ?? pdf.name); }} />
              <MenuOption label="Move to…" onClick={() => setSubMenu('move')} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MenuOption({ label, onClick }: { label: string; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        padding: '8px 14px', fontSize: 13,
        color: 'var(--text-secondary)',
        background: hovered ? 'var(--bg-sunken)' : 'transparent',
        border: 'none', cursor: 'pointer', transition: 'background 0.1s',
      }}
    >
      {label}
    </button>
  );
}

function MenuDivider() {
  return <div style={{ height: 1, background: 'var(--border)', margin: '3px 0' }} />;
}

function PickerOption({ label, indent = 0, onSelect }: { label: string; indent?: number; onSelect: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        padding: `8px ${12 + indent * 14}px`,
        fontSize: 13, color: 'var(--text-secondary)',
        background: hovered ? 'var(--bg-sunken)' : 'transparent',
        border: 'none', cursor: 'pointer', transition: 'background 0.1s',
      }}
    >
      {label}
    </button>
  );
}

function StatBadge({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <span style={{
        fontSize: 11, fontWeight: 700,
        fontFamily: 'var(--font-mono)', color,
      }}>{value}</span>
      <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{label}</span>
    </div>
  );
}

function StudyBtn({ onClick, small }: { onClick: (e: React.MouseEvent) => void; small?: boolean }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: small ? '4px 10px' : '6px 14px',
        background: hovered ? 'var(--accent)' : 'var(--accent-dim)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        fontSize: small ? 11 : 12,
        fontWeight: 600,
        color: hovered ? 'var(--accent-ink)' : 'var(--accent)',
        cursor: 'pointer',
        transition: 'all 0.15s',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      Study
    </button>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div style={{
      padding: '48px 32px',
      background: 'var(--bg-raised)',
      borderRadius: 12,
      border: '1px solid var(--border)',
      textAlign: 'center',
    }}>
      <div style={{
        fontFamily: 'var(--font-serif)',
        fontSize: '1.1rem',
        fontWeight: 400,
        color: 'var(--text-primary)',
        marginBottom: 8,
      }}>
        No banks yet
      </div>
      <p style={{ fontSize: 13, color: 'var(--text-dim)', margin: '0 0 20px' }}>
        Upload a PDF to generate your first question bank.
      </p>
      <button
        onClick={onAdd}
        style={{
          padding: '8px 20px',
          background: 'var(--accent)',
          border: 'none',
          borderRadius: 8,
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--accent-ink)',
          cursor: 'pointer',
        }}
      >
        Add PDF
      </button>
    </div>
  );
}
