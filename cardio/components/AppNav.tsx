'use client';

import { supabaseBrowser } from '@/lib/supabase-browser';
import type { AppView } from '@/app/app/page';
import { isDevAuthBypassEnabled } from '@/lib/dev-auth';

interface Props {
  view: AppView;
  isJobRunning: boolean;
  darkMode: boolean;
  totalPdfs: number;
  totalQuestions: number;
  onSetView: (view: AppView) => void;
  onToggleDark: () => void;
  onOpenPalette?: () => void;
}

const tabs: { label: string; target: AppView | AppView[] }[] = [
  { label: 'Banks',    target: 'library' },
  { label: 'Add',      target: ['add', 'processing'] },
  { label: 'Stats',    target: 'stats' },
  { label: 'Settings', target: 'settings' },
];

export default function AppNav({
  view, isJobRunning, darkMode,
  totalPdfs, totalQuestions,
  onSetView, onToggleDark, onOpenPalette,
}: Props) {
  const handleSignOut = () => {
    if (isDevAuthBypassEnabled()) { window.location.href = '/'; return; }
    void supabaseBrowser.auth.signOut().then(() => { window.location.href = '/login'; });
  };

  function isActive(target: AppView | AppView[]) {
    return Array.isArray(target) ? target.includes(view) : view === target;
  }

  function handleTabClick(target: AppView | AppView[]) {
    if (Array.isArray(target)) {
      onSetView(target[0] === 'add' && isJobRunning ? 'processing' : target[0]);
    } else {
      onSetView(target);
    }
  }

  return (
    <header style={{
      padding: '20px 40px 0',
      borderBottom: '1px solid var(--border)',
      position: 'sticky',
      top: 0,
      zIndex: 30,
      background: 'var(--bg)',
    }}>
      {/* Top row: brand + actions */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ cursor: 'pointer' }} onClick={() => onSetView('library')}>
          <div style={{
            fontFamily: 'var(--font-serif)',
            fontSize: '1.6rem',
            fontWeight: 400,
            letterSpacing: '-0.02em',
            color: 'var(--text-primary)',
            lineHeight: 1,
            marginBottom: 4,
          }}>
            Carido
          </div>
          <div style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.68rem',
            color: 'var(--text-dim)',
            letterSpacing: '0.02em',
          }}>
            {totalQuestions > 0
              ? `${totalQuestions.toLocaleString()} questions · ${totalPdfs} PDF${totalPdfs !== 1 ? 's' : ''}`
              : totalPdfs > 0
                ? `${totalPdfs} PDF${totalPdfs !== 1 ? 's' : ''} — no questions yet`
                : 'No banks yet — add a PDF to get started'}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {onOpenPalette && (
            <button
              onClick={onOpenPalette}
              title="Command palette (⌘K)"
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '5px 10px', borderRadius: 'var(--r2)',
                background: 'var(--bg-sunken)', border: '1px solid var(--border)',
                cursor: 'pointer', fontSize: 11, color: 'var(--text-dim)',
                fontFamily: 'var(--font-mono)', fontWeight: 600,
              }}
            >
              ⌘K
            </button>
          )}
          <button
            onClick={onToggleDark}
            title={darkMode ? 'Light mode' : 'Dark mode'}
            style={{
              width: 30, height: 30,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: 'var(--radius-md)',
              background: 'var(--bg-sunken)', border: '1px solid var(--border)',
              cursor: 'pointer', fontSize: '0.85rem', transition: 'background 0.15s',
            }}
          >
            {darkMode ? '☀️' : '🌙'}
          </button>
          <button
            onClick={handleSignOut}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.1em',
              textTransform: 'uppercase', color: 'var(--text-dim)',
              transition: 'color 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--red)'; }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-dim)'; }}
          >
            Sign Out
          </button>
        </div>
      </div>

      {/* Tab row */}
      <nav style={{ display: 'flex', gap: 4 }}>
        {tabs.map(({ label, target }) => {
          const active = isActive(target);
          const showDot = label === 'Add' && isJobRunning && !active;
          return (
            <button
              key={label}
              onClick={() => handleTabClick(target)}
              style={{
                position: 'relative',
                padding: '8px 16px',
                background: 'none',
                border: 'none',
                borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: -1,
                cursor: 'pointer',
                fontSize: '0.82rem',
                fontWeight: active ? 600 : 500,
                color: active ? 'var(--accent)' : 'var(--text-dim)',
                transition: 'color 0.15s, border-color 0.15s',
              }}
              onMouseEnter={e => { if (!active) e.currentTarget.style.color = 'var(--text-secondary)'; }}
              onMouseLeave={e => { if (!active) e.currentTarget.style.color = 'var(--text-dim)'; }}
            >
              {label}
              {showDot && (
                <span style={{
                  position: 'absolute', top: 6, right: 8,
                  width: 5, height: 5, borderRadius: '50%',
                  background: 'var(--accent)',
                }} />
              )}
            </button>
          );
        })}
      </nav>
    </header>
  );
}
