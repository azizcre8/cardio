'use client';

import { useState } from 'react';

interface Props {
  examDate:         string | null;
  onExamDateChange: (date: string | null) => void;
  userId:           string;
}

export default function SettingsView({ examDate, onExamDateChange, userId }: Props) {
  const [date,   setDate]   = useState(examDate ?? '');
  const [saving, setSaving] = useState(false);
  const [saved,  setSaved]  = useState(false);

  async function save() {
    setSaving(true);
    const res = await fetch('/api/users/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exam_date: date || null }),
    });
    if (res.ok) onExamDateChange(date || null);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  const card: React.CSSProperties = {
    background: 'var(--bg-raised)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--r3)',
    padding: '20px 24px',
  };

  const label: React.CSSProperties = {
    display: 'block',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: 'var(--text-dim)',
    marginBottom: 10,
  };

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: '32px 40px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h2 style={{
        fontFamily: 'var(--font-serif)',
        fontSize: '1.25rem',
        fontWeight: 400,
        color: 'var(--text-primary)',
        margin: '0 0 8px',
      }}>
        Settings
      </h2>

      {/* Exam date */}
      <div style={card}>
        <label style={label}>Exam Date</label>
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          style={{
            width: '100%',
            padding: '8px 12px',
            background: 'var(--bg-sunken)',
            border: '1px solid var(--border-med)',
            borderRadius: 'var(--r2)',
            fontSize: 13,
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-sans)',
            marginBottom: 10,
            boxSizing: 'border-box',
            colorScheme: 'light',
          }}
        />
        <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: '0 0 14px' }}>
          Setting your exam date enables cram mode (≤3 days) and caps review intervals accordingly.
        </p>
        <button
          onClick={save}
          disabled={saving}
          style={{
            padding: '7px 18px',
            background: saved ? 'var(--green)' : 'var(--accent)',
            border: 'none',
            borderRadius: 'var(--r2)',
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--accent-ink)',
            cursor: saving ? 'default' : 'pointer',
            opacity: saving ? 0.7 : 1,
            transition: 'background 0.2s, opacity 0.2s',
          }}
        >
          {saved ? 'Saved ✓' : saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {/* Account */}
      <div style={card}>
        <p style={label}>Account</p>
        <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: 0 }}>
          User ID:{' '}
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-disabled)', fontSize: 11 }}>
            {userId}
          </span>
        </p>
      </div>
    </div>
  );
}
