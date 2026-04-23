'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PDF, Deck } from '@/types';
import { Icon, Kbd } from './ui';

type ItemType = 'action' | 'pdf' | 'deck';

interface PaletteItem {
  type: ItemType;
  id: string;
  label: string;
  hint?: string;
  icon: Parameters<typeof Icon>[0]['name'];
  kbd?: string;
  run: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  pdfs: PDF[];
  decks: Deck[];
  onNavigate: (view: string, pdfId?: string) => void;
}

const TYPE_LABEL: Record<ItemType, string> = {
  action: 'Actions',
  deck:   'Subjects',
  pdf:    'Sources',
};

export default function CommandPalette({ open, onClose, pdfs, decks, onNavigate }: Props) {
  const [query, setQuery] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIdx(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    const res: PaletteItem[] = [];

    res.push({ type: 'action', id: 'library', label: 'Browse library',     hint: 'All sources', icon: 'book',     kbd: 'L', run: () => onNavigate('library') });
    res.push({ type: 'action', id: 'stats',   label: 'View stats',          hint: 'Progress',    icon: 'trend_up',          run: () => onNavigate('stats') });
    res.push({ type: 'action', id: 'settings',label: 'Settings',            hint: 'Exam date',   icon: 'target',            run: () => onNavigate('settings') });
    res.push({ type: 'action', id: 'add',     label: 'Upload a PDF',        hint: 'Add sources', icon: 'plus',    kbd: 'A', run: () => onNavigate('add') });

    decks.forEach(d => {
      res.push({
        type: 'deck', id: d.id, icon: 'layers',
        label: d.name,
        hint: d.is_exam_block ? 'Exam block' : 'Subject',
        run: () => onNavigate('library'),
      });
    });

    pdfs.filter(p => p.processed_at).forEach(p => {
      const name = p.shared_bank_title ?? p.display_name ?? p.name.replace(/\.pdf$/i, '');
      res.push({
        type: 'pdf', id: p.id, icon: 'book',
        label: name,
        hint: `${p.question_count ?? 0} Q`,
        run: () => onNavigate('quiz', p.id),
      });
    });

    return res;
  }, [pdfs, decks, onNavigate]);

  const filtered = useMemo(() => {
    const s = query.trim().toLowerCase();
    if (!s) return items;
    return items
      .map(it => {
        const hay = `${it.label} ${it.hint ?? ''}`.toLowerCase();
        const i = hay.indexOf(s);
        return { it, score: i < 0 ? Infinity : i + (it.type === 'action' ? -50 : 0) };
      })
      .filter(x => x.score < Infinity)
      .sort((a, b) => a.score - b.score)
      .map(x => x.it);
  }, [query, items]);

  useEffect(() => { setIdx(0); }, [query]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape')    { onClose(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(filtered.length - 1, i + 1)); }
      else if (e.key === 'ArrowUp')   { e.preventDefault(); setIdx(i => Math.max(0, i - 1)); }
      else if (e.key === 'Enter') {
        const it = filtered[idx];
        if (it) { it.run(); onClose(); }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, filtered, idx, onClose]);

  if (!open) return null;

  const groups: Partial<Record<ItemType, PaletteItem[]>> = {};
  filtered.forEach(it => {
    (groups[it.type] ??= []).push(it);
  });

  let ci = -1;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(20,18,16,0.30)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: '11vh', backdropFilter: 'blur(6px)',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 620, maxWidth: '92vw',
          background: 'var(--bg-raised)', borderRadius: 'var(--r3)',
          boxShadow: 'var(--shadow-3)', border: '1px solid var(--border)',
          overflow: 'hidden', fontFamily: 'var(--font-sans)',
        }}
      >
        {/* Search row */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '14px 16px', borderBottom: '1px solid var(--border)',
        }}>
          <Icon name="search" size={16} color="var(--text-dim)" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Jump to… type action, subject, or source"
            style={{
              flex: 1, border: 'none', outline: 'none',
              fontSize: 15, fontFamily: 'var(--font-sans)',
              color: 'var(--text-primary)', background: 'transparent',
            }}
          />
          <Kbd>esc</Kbd>
        </div>

        {/* Results */}
        <div style={{ maxHeight: '55vh', overflow: 'auto', padding: '6px 0' }}>
          {filtered.length === 0 && (
            <div style={{
              padding: 28, textAlign: 'center',
              color: 'var(--text-dim)', fontSize: 13,
              fontStyle: 'italic', fontFamily: 'var(--font-serif)',
            }}>
              No matches for &ldquo;{query}&rdquo;
            </div>
          )}

          {(Object.keys(groups) as ItemType[]).map(g => (
            <div key={g}>
              <div style={{
                padding: '8px 16px 4px',
                fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
                textTransform: 'uppercase', color: 'var(--text-dim)',
              }}>
                {TYPE_LABEL[g]}
              </div>
              {(groups[g] ?? []).map(it => {
                ci++;
                const active = ci === idx;
                return (
                  <button
                    key={g + it.id}
                    onClick={() => { it.run(); onClose(); }}
                    onMouseEnter={() => setIdx(filtered.indexOf(it))}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 12,
                      width: '100%', padding: '9px 16px',
                      background: active ? 'var(--bg-sunken)' : 'transparent',
                      border: 'none',
                      borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
                      cursor: 'pointer', textAlign: 'left',
                      fontFamily: 'var(--font-sans)', color: 'var(--text-primary)',
                    }}
                  >
                    <Icon name={it.icon} size={15} color={active ? 'var(--accent)' : 'var(--text-dim)'} />
                    <span style={{ fontSize: 13.5, fontWeight: 500 }}>{it.label}</span>
                    <span style={{
                      marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8,
                      color: 'var(--text-dim)', fontSize: 12,
                    }}>
                      {it.hint}
                      {it.kbd && <Kbd>{it.kbd}</Kbd>}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={{
          padding: '10px 16px', background: 'var(--bg-sunken)',
          borderTop: '1px solid var(--border)',
          display: 'flex', gap: 14, fontSize: 11, color: 'var(--text-dim)',
        }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Kbd>↵</Kbd> select</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Kbd>⌘</Kbd><Kbd>K</Kbd> toggle</span>
        </div>
      </div>
    </div>
  );
}
