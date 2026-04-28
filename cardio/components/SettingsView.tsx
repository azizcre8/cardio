'use client';

import { useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { KeybindingAction } from '@/types';
import { DEFAULT_KEYBINDINGS, formatKey, KEYBINDING_LABELS, loadKeybindings, normalizeCapturedKey, saveKeybindings } from '@/lib/keybindings';

interface Props {
  examDate:         string | null;
  onExamDateChange: (date: string | null) => void;
  userId:           string;
}

export default function SettingsView({ examDate, onExamDateChange, userId }: Props) {
  const [date,    setDate]    = useState(examDate ?? '');
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const [bindings, setBindings] = useState(loadKeybindings);
  const [capturing, setCapturing] = useState<KeybindingAction | null>(null);

  async function save() {
    setSaving(true);
    const res = await fetch('/api/users/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exam_date: date || null }),
    });

    if (res.ok) {
      onExamDateChange(date || null);
    }

    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function capture(action: KeybindingAction, e: ReactKeyboardEvent<HTMLButtonElement>) {
    const key = normalizeCapturedKey(e);
    if (!key) return;
    e.preventDefault();
    const next = { ...bindings, [action]: key };
    setBindings(next);
    saveKeybindings(next);
    setCapturing(null);
  }

  function resetBindings() {
    setBindings(DEFAULT_KEYBINDINGS);
    saveKeybindings(DEFAULT_KEYBINDINGS);
    setCapturing(null);
  }

  return (
    <div className="max-w-md mx-auto space-y-6">
      <h2 className="text-lg font-bold text-white">Settings</h2>

      {/* Exam date */}
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-4">
        <label className="block text-xs text-gray-500 uppercase tracking-widest mb-2">
          Exam Date
        </label>
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white w-full mb-3"
        />
        <p className="text-xs text-gray-600 mb-3">
          Setting your exam date enables cram mode (≤3 days) and caps review intervals accordingly.
        </p>
        <button
          onClick={save}
          disabled={saving}
          className="bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-4 py-1.5 rounded text-sm font-medium"
        >
          {saved ? 'Saved ✓' : saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {/* Account info */}
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-4">
        <p className="text-xs text-gray-500 uppercase tracking-widest mb-2">Account</p>
        <p className="text-xs text-gray-400">User ID: <span className="font-mono text-gray-600">{userId}</span></p>
      </div>

      <div className="bg-gray-900 border border-gray-700 rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs text-gray-500 uppercase tracking-widest">Keyboard Shortcuts</p>
          <button type="button" onClick={resetBindings} className="text-xs text-gray-500 hover:text-gray-300">Reset</button>
        </div>
        <div className="space-y-2">
          {(Object.keys(KEYBINDING_LABELS) as KeybindingAction[]).map(action => {
            const meta = KEYBINDING_LABELS[action];
            return (
              <div key={action} className="grid grid-cols-[110px_1fr_120px] gap-3 items-center text-xs">
                <span className="text-gray-600">{meta.group}</span>
                <span className="text-gray-300">{meta.label}</span>
                <button
                  type="button"
                  onClick={() => setCapturing(action)}
                  onKeyDown={e => capturing === action && capture(action, e)}
                  className="bg-gray-800 border border-gray-700 rounded px-2 py-1 font-mono text-gray-200 hover:border-cyan-700"
                >
                  {capturing === action ? 'Press key' : formatKey(bindings[action])}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
