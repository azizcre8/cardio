'use client';

import type { CSSProperties, ReactNode } from 'react';
import { useState } from 'react';

// ── Mastery pill ──────────────────────────────────────────────────────────────

export function MasteryPill({ v, size = 'sm' }: { v: number; size?: 'sm' | 'lg' }) {
  const color = v >= 80 ? 'var(--green)' : v >= 55 ? 'var(--amber)' : 'var(--red)';
  const bg    = v >= 80 ? 'var(--green-dim)' : v >= 55 ? 'var(--amber-dim)' : 'var(--red-dim)';
  const pad   = size === 'lg' ? '3px 9px' : '1px 7px';
  const fs    = size === 'lg' ? 12 : 10.5;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      fontSize: fs, fontWeight: 600, fontFamily: 'var(--font-mono)',
      color, background: bg, padding: pad, borderRadius: 99,
      fontVariantNumeric: 'tabular-nums',
    }}>
      <span style={{ width: 5, height: 5, borderRadius: 99, background: color, flexShrink: 0 }} />
      {v}%
    </span>
  );
}

// ── Mastery bar ───────────────────────────────────────────────────────────────

export function MasteryBar({ v, width = 56 }: { v: number; width?: number }) {
  const color = v >= 80 ? 'var(--green)' : v >= 55 ? 'var(--amber)' : 'var(--red)';
  return (
    <div style={{ width, height: 3, background: 'var(--bg-sunken)', borderRadius: 99, overflow: 'hidden', flexShrink: 0 }}>
      <div style={{ width: `${Math.min(100, v)}%`, height: '100%', background: color }} />
    </div>
  );
}

// ── Sparkbar ──────────────────────────────────────────────────────────────────

export function Sparkbar({ data, w = 120, h = 28, color }: { data: number[]; w?: number; h?: number; color?: string }) {
  const max = Math.max(...data, 1);
  const bw = w / data.length;
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      {data.map((v, i) => {
        const bh = Math.max(1, (v / max) * (h - 2));
        return (
          <rect key={i} x={i * bw + 1} y={h - bh} width={bw - 2} height={bh}
            fill={v === 0 ? 'var(--border)' : (color ?? 'var(--text-dim)')} rx={1} />
        );
      })}
    </svg>
  );
}

// ── Kbd hint ──────────────────────────────────────────────────────────────────

export function Kbd({ children, dim }: { children: ReactNode; dim?: boolean }) {
  return (
    <kbd style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600,
      padding: '2px 6px', minWidth: 18, height: 18,
      background: dim ? 'transparent' : 'var(--bg-raised)',
      border: '1px solid var(--border)',
      borderBottom: '1.5px solid var(--border)',
      borderRadius: 4, color: 'var(--text-secondary)',
    }}>{children}</kbd>
  );
}

// ── Section eyebrow ───────────────────────────────────────────────────────────

export function Eyebrow({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
      textTransform: 'uppercase', color: color ?? 'var(--text-dim)',
    }}>{children}</div>
  );
}

// ── SVG icon set ──────────────────────────────────────────────────────────────

type IconName =
  | 'book' | 'play' | 'lightning' | 'target' | 'layers' | 'clock' | 'flame'
  | 'sparkle' | 'search' | 'chevron' | 'check' | 'x' | 'plus' | 'dots'
  | 'trend_up' | 'trend_down' | 'pause' | 'arrow_r' | 'arrow_l' | 'filter'
  | 'flag' | 'eye';

const ICON_PATHS: Record<IconName, string> = {
  book:       'M4 4h5a3 3 0 0 1 3 3v13M20 4h-5a3 3 0 0 0-3 3v13M4 4v16M20 4v16',
  play:       'M7 5v14l11-7z',
  lightning:  'M13 3L5 13h6l-1 8 8-10h-6l1-8z',
  target:     'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  layers:     'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17l9 5 9-5',
  clock:      'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  flame:      'M12 3c0 5-5 6-5 11a5 5 0 0 0 10 0c0-3-3-3-3-6 0 0 2 1 3 3 0-4-5-5-5-8z',
  sparkle:    'M12 3v7M12 14v7M3 12h7M14 12h7',
  search:     'M10 10m-6 0a6 6 0 1 0 12 0a6 6 0 1 0-12 0M14.5 14.5L19 19',
  chevron:    'M9 5l7 7-7 7',
  check:      'M4 12l5 5L20 6',
  x:          'M6 6l12 12M18 6L6 18',
  plus:       'M12 5v14M5 12h14',
  dots:       'M5 12m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M12 12m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M19 12m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0',
  trend_up:   'M3 17l6-6 4 4 8-8M15 7h6v6',
  trend_down: 'M3 7l6 6 4-4 8 8M15 17h6v-6',
  pause:      'M6 4h4v16H6zM14 4h4v16h-4z',
  arrow_r:    'M5 12h14M13 5l7 7-7 7',
  arrow_l:    'M19 12H5M11 5l-7 7 7 7',
  filter:     'M3 5h18l-7 8v6l-4-2v-4z',
  flag:       'M5 3v18M5 4h13l-3 4 3 4H5',
  eye:        'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
};

export function Icon({ name, size = 16, color = 'currentColor' }: { name: IconName; size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block', flexShrink: 0 }}>
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

// ── Button primitive ──────────────────────────────────────────────────────────

type BtnKind = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Btn({
  children, kind = 'ghost', onClick, kbd, icon, style = {},
  disabled, type,
}: {
  children: ReactNode;
  kind?: BtnKind;
  onClick?: () => void;
  kbd?: string;
  icon?: IconName;
  style?: CSSProperties;
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  const [hov, setHov] = useState(false);

  const variants: Record<BtnKind, CSSProperties> = {
    primary:   { background: hov ? '#0a5962' : 'var(--accent)', color: 'var(--accent-ink)' },
    secondary: { background: hov ? 'var(--bg-sunken)' : 'var(--bg-raised)', color: 'var(--text-primary)', border: '1px solid var(--border)' },
    ghost:     { background: hov ? 'var(--bg-sunken)' : 'transparent', color: 'var(--text-secondary)' },
    danger:    { background: hov ? 'var(--red-dim)' : 'transparent', color: 'var(--red)' },
  };

  return (
    <button
      type={type ?? 'button'}
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        padding: '8px 12px', border: 'none', borderRadius: 'var(--r2)',
        fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'background 0.12s, color 0.12s, border-color 0.12s',
        letterSpacing: '-0.005em',
        ...variants[kind],
        ...style,
      }}
    >
      {icon && <Icon name={icon} size={14} />}
      <span>{children}</span>
      {kbd && <Kbd dim={kind === 'primary'}>{kbd}</Kbd>}
    </button>
  );
}
