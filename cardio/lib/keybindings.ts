'use client';

import type { KeybindingAction, KeybindingMap } from '@/types';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

export const KEYBINDINGS_STORAGE_KEY = 'cardio:keybindings';

export const DEFAULT_KEYBINDINGS: KeybindingMap = {
  'quiz.previous': 'ArrowLeft',
  'quiz.next': 'ArrowRight',
  'quiz.flip': ' ',
  'study.quality1': '1',
  'study.quality2': '2',
  'study.quality3': '3',
  'study.quality4': '4',
  'library.newDeck': 'n',
  'library.renameDeck': 'r',
  'library.deleteDeck': 'Delete',
};

export const KEYBINDING_LABELS: Record<KeybindingAction, { group: string; label: string }> = {
  'quiz.previous': { group: 'Quiz navigation', label: 'Previous question' },
  'quiz.next': { group: 'Quiz navigation', label: 'Next question' },
  'quiz.flip': { group: 'Quiz navigation', label: 'Show or hide evidence' },
  'study.quality1': { group: 'Study ratings', label: 'Again' },
  'study.quality2': { group: 'Study ratings', label: 'Hard' },
  'study.quality3': { group: 'Study ratings', label: 'Good' },
  'study.quality4': { group: 'Study ratings', label: 'Easy' },
  'library.newDeck': { group: 'Library', label: 'New subdeck' },
  'library.renameDeck': { group: 'Library', label: 'Rename deck' },
  'library.deleteDeck': { group: 'Library', label: 'Delete deck' },
};

export function loadKeybindings(): KeybindingMap {
  if (typeof window === 'undefined') return DEFAULT_KEYBINDINGS;
  try {
    const parsed = JSON.parse(localStorage.getItem(KEYBINDINGS_STORAGE_KEY) ?? '{}') as Partial<KeybindingMap>;
    return { ...DEFAULT_KEYBINDINGS, ...parsed };
  } catch {
    return DEFAULT_KEYBINDINGS;
  }
}

export function saveKeybindings(bindings: KeybindingMap) {
  localStorage.setItem(KEYBINDINGS_STORAGE_KEY, JSON.stringify(bindings));
  window.dispatchEvent(new CustomEvent('cardio:keybindings-changed'));
}

export function formatKey(key: string): string {
  if (key === ' ') return 'Space';
  if (key === 'ArrowLeft') return 'Left arrow';
  if (key === 'ArrowRight') return 'Right arrow';
  return key.length === 1 ? key.toUpperCase() : key;
}

export function isBinding(e: KeyboardEvent | ReactKeyboardEvent, bindings: KeybindingMap, action: KeybindingAction) {
  return e.key === bindings[action];
}

export function normalizeCapturedKey(e: KeyboardEvent | ReactKeyboardEvent): string | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key === 'Escape') return null;
  if (e.key === ' ') return ' ';
  if (e.key.length === 1) return e.key.toLowerCase();
  return e.key;
}
