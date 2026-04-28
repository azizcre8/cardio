'use client';

import type { CSSProperties } from 'react';
import { useRef, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import type { AppView } from '@/app/app/page';
import { isDevAuthBypassEnabled } from '@/lib/dev-auth';

const PLAN_LABELS: Record<string, string> = {
  free: 'Free',
  student: 'Student',
  boards: 'Boards',
  institution: 'Institution',
};

interface Props {
  view: AppView;
  isJobRunning: boolean;
  darkMode: boolean;
  onSetView: (view: AppView) => void;
  onToggleDark: () => void;
  onOpenPalette?: () => void;
  userEmail?: string | null;
  userPlan?: string;
}

export default function AppNav({ view, isJobRunning, darkMode, onSetView, onToggleDark, onOpenPalette, userEmail, userPlan = 'free' }: Props) {
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);

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

      <NavButton view={view} target="question-stats" onClick={() => onSetView('question-stats')} style={navButtonStyle('question-stats')}>
        Q·Stats
      </NavButton>

      <NavButton view={view} target="allquestions" onClick={() => onSetView('allquestions')} style={navButtonStyle('allquestions')}>
        All Q
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

        <div ref={accountRef} style={{ position: 'relative' }}>
          <button
            onClick={() => setAccountOpen(o => !o)}
            title="Account"
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '4px 10px', borderRadius: 'var(--r2)',
              background: accountOpen ? 'var(--accent-dim)' : 'var(--bg-sunken)',
              border: `1px solid ${accountOpen ? 'rgba(13,154,170,0.3)' : 'var(--border)'}`,
              cursor: 'pointer', fontSize: 11, color: 'var(--text-secondary)',
              fontWeight: 600, letterSpacing: '0.05em', transition: 'background 0.15s, border-color 0.15s',
            }}
            onMouseEnter={e => {
              if (!accountOpen) {
                e.currentTarget.style.background = 'var(--accent-dim)';
                e.currentTarget.style.borderColor = 'rgba(13,154,170,0.3)';
              }
            }}
            onMouseLeave={e => {
              if (!accountOpen) {
                e.currentTarget.style.background = 'var(--bg-sunken)';
                e.currentTarget.style.borderColor = 'var(--border)';
              }
            }}
          >
            <span style={{
              width: 20, height: 20, borderRadius: '50%',
              background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 10, fontWeight: 700, color: '#fff', flexShrink: 0,
            }}>
              {userEmail?.charAt(0).toUpperCase() || '?'}
            </span>
            <span style={{ textTransform: 'capitalize' }}>{PLAN_LABELS[userPlan] ?? userPlan}</span>
          </button>

          {accountOpen && (
            <>
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 39 }}
                onClick={() => setAccountOpen(false)}
              />
              <div style={{
                position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 40,
                background: 'var(--bg-card)', border: '1px solid var(--border)',
                borderRadius: 'var(--r2)', boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
                minWidth: 200, padding: '12px 0',
              }}>
                <div style={{ padding: '4px 16px 12px', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 2 }}>Signed in as</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', wordBreak: 'break-all' }}>
                    {userEmail ?? '—'}
                  </div>
                </div>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>Plan</div>
                  <span style={{
                    display: 'inline-block',
                    fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
                    padding: '2px 8px', borderRadius: 20,
                    background: 'var(--accent-dim)', color: 'var(--accent)',
                    border: '1px solid rgba(13,154,170,0.25)',
                  }}>
                    {PLAN_LABELS[userPlan] ?? userPlan}
                  </span>
                </div>
                <div style={{ padding: '8px 0 0' }}>
                  <button
                    onClick={() => { setAccountOpen(false); handleSignOut(); }}
                    style={{
                      width: '100%', textAlign: 'left',
                      padding: '8px 16px', background: 'none', border: 'none',
                      fontSize: 12, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
                      cursor: 'pointer', color: 'var(--text-dim)',
                      transition: 'color 0.15s, background 0.15s',
                    }}
                    onMouseEnter={e => {
                      e.currentTarget.style.color = 'var(--red)';
                      e.currentTarget.style.background = 'rgba(239,68,68,0.06)';
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.color = 'var(--text-dim)';
                      e.currentTarget.style.background = 'none';
                    }}
                  >
                    Sign Out
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
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
