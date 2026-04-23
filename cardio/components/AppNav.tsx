'use client';

import type { CSSProperties } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import type { AppView } from '@/app/app/page';
import { isDevAuthBypassEnabled } from '@/lib/dev-auth';

interface Props {
  view: AppView;
  isJobRunning: boolean;
  darkMode: boolean;
  onSetView: (view: AppView) => void;
  onToggleDark: () => void;
  onOpenPalette?: () => void;
}

export default function AppNav({ view, isJobRunning, darkMode, onSetView, onToggleDark, onOpenPalette }: Props) {
  const handleSignOut = () => {
    if (isDevAuthBypassEnabled()) {
      window.location.href = '/';
      return;
    }

    void supabaseBrowser.auth.signOut().then(() => {
      window.location.href = '/login';
    });
  };

  const navButtonStyle = (target: AppView | AppView[]): CSSProperties => {
    const active = Array.isArray(target) ? target.includes(view) : view === target;
    return {
      fontSize: '0.75rem',
      fontWeight: 600,
      letterSpacing: '0.1em',
      textTransform: 'uppercase',
      whiteSpace: 'nowrap',
      padding: '2px 4px',
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      color: active ? 'var(--accent)' : 'var(--text-dim)',
      transition: 'color 0.15s',
    };
  };

  return (
    <nav
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '20px',
        padding: '0 20px',
        height: '56px',
        borderBottom: '1px solid var(--border)',
        position: 'sticky',
        top: 0,
        zIndex: 30,
        background: 'var(--bg)',
      }}
    >
      <div
        style={{
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'baseline',
          gap: '8px',
          marginRight: '8px',
          flexShrink: 0,
        }}
        onClick={() => onSetView('library')}
      >
        <span style={{ fontSize: '1rem', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--accent)' }}>
          Cardio
        </span>
        <span style={{ fontSize: '0.58rem', fontWeight: 500, letterSpacing: '0.13em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>
          Clinical SRS
        </span>
      </div>

      <NavButton view={view} target="library" onClick={() => onSetView('library')} style={navButtonStyle('library')}>
        Library
      </NavButton>

      <NavButton
        view={view}
        target={['add', 'processing']}
        onClick={() => onSetView(isJobRunning ? 'processing' : 'add')}
        style={{ ...navButtonStyle(['add', 'processing']), position: 'relative' }}
      >
        Add
        {isJobRunning && view !== 'processing' && (
          <span style={{
            position: 'absolute',
            top: '-2px',
            right: '-6px',
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: '#14B8C8',
            animation: 'processing-badge 1.0s ease-in-out infinite',
          }} />
        )}
      </NavButton>

      <NavButton view={view} target="stats" onClick={() => onSetView('stats')} style={navButtonStyle('stats')}>
        Stats
      </NavButton>

      <NavButton view={view} target="settings" onClick={() => onSetView('settings')} style={navButtonStyle('settings')}>
        Settings
      </NavButton>

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '16px' }}>
        {onOpenPalette && (
          <button
            onClick={onOpenPalette}
            title="Command palette (⌘K)"
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '4px 8px', borderRadius: 'var(--r2)',
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
          title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          style={{
            width: '32px',
            height: '32px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 'var(--radius-md)',
            background: 'var(--bg-sunken)',
            border: '1px solid var(--border)',
            cursor: 'pointer',
            fontSize: '0.9rem',
            transition: 'background 0.15s, border-color 0.15s',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.background = 'var(--accent-dim)';
            e.currentTarget.style.borderColor = 'rgba(13,154,170,0.3)';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = 'var(--bg-sunken)';
            e.currentTarget.style.borderColor = 'var(--border)';
          }}
        >
          {darkMode ? '☀️' : '🌙'}
        </button>

        <button
          onClick={handleSignOut}
          className="text-xs font-semibold tracking-widest uppercase whitespace-nowrap transition-colors"
          style={{ color: 'var(--text-dim)' }}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--red)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-dim)'; }}
        >
          Sign Out
        </button>
      </div>
    </nav>
  );
}

function NavButton({
  children,
  onClick,
  style,
  target,
  view,
}: {
  children: React.ReactNode;
  onClick: () => void;
  style: CSSProperties;
  target: AppView | AppView[];
  view: AppView;
}) {
  const isActive = Array.isArray(target) ? target.includes(view) : view === target;

  return (
    <button
      onClick={onClick}
      style={style}
      onMouseEnter={e => {
        if (!isActive) e.currentTarget.style.color = 'var(--text-secondary)';
      }}
      onMouseLeave={e => {
        if (!isActive) e.currentTarget.style.color = 'var(--text-dim)';
      }}
    >
      {children}
    </button>
  );
}
