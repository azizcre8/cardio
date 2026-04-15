'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import type { Deck, Density, PDF, ProcessEvent } from '@/types';
import type { ActiveJob } from '@/components/ProcessingView';
import type { AppView } from './page';

const THEME_KEY = 'cardio-theme';

export function useUserLibraryData() {
  const [pdfs, setPdfs] = useState<PDF[]>([]);
  const [decks, setDecks] = useState<Deck[]>([]);
  const [examDate, setExamDate] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    supabaseBrowser.auth.getUser().then(({ data }: { data: { user: { id: string } | null } }) => {
      setUserId(data.user?.id ?? null);
    });
  }, []);

  useEffect(() => {
    if (!userId) return;

    supabaseBrowser
      .from('pdfs').select('*').eq('user_id', userId)
      .order('created_at', { ascending: false })
      .then(({ data }: { data: PDF[] | null }) => setPdfs((data ?? []) as PDF[]));

    supabaseBrowser
      .from('users').select('exam_date').eq('id', userId).single()
      .then(({ data }: { data: { exam_date: string | null } | null }) => setExamDate(data?.exam_date ?? null));

    fetch('/api/decks')
      .then(r => r.ok ? r.json() : [])
      .then((data: Deck[]) => setDecks(data))
      .catch(() => { /* decks table may not exist yet */ });
  }, [userId]);

  return {
    pdfs,
    setPdfs,
    decks,
    setDecks,
    examDate,
    setExamDate,
    userId,
  };
}

export function useThemePreference() {
  const [darkMode, setDarkMode] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark') {
      setDarkMode(true);
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  }, []);

  const toggleDark = useCallback(() => {
    const next = !darkMode;
    setDarkMode(next);
    if (next) {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem(THEME_KEY, 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem(THEME_KEY, 'light');
    }
  }, [darkMode]);

  return { darkMode, toggleDark };
}

export function useProcessingJob(setView: (view: AppView) => void, setPdfs: (pdfs: PDF[]) => void) {
  const [activeJob, setActiveJob] = useState<ActiveJob | null>(null);

  const startProcessing = useCallback(async (file: File, density: Density, maxQuestions: number) => {
    const job: ActiveJob = {
      pdfName: file.name,
      density,
      maxQuestions,
      logs: [],
      isRunning: true,
      startedAt: Date.now(),
      completedPdfId: null,
    };
    setActiveJob(job);
    setView('processing');

    const form = new FormData();
    form.append('pdf', file);
    form.append('density', density);
    if (maxQuestions > 0) form.append('maxQuestions', String(maxQuestions));

    try {
      const resp = await fetch('/api/process', { method: 'POST', body: form });
      if (!resp.ok) {
        const txt = await resp.text();
        setActiveJob(prev => prev ? {
          ...prev,
          isRunning: false,
          logs: [...prev.logs, { phase: 0, message: `Error: ${txt}`, pct: 0 }],
        } : null);
        return;
      }

      const reader = resp.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n\n');
        buf = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.replace(/^data: /, '').trim();
          if (!trimmed) continue;

          try {
            const ev: ProcessEvent = JSON.parse(trimmed);
            setActiveJob(prev => prev ? { ...prev, logs: [...prev.logs, ev] } : null);

            if (ev.phase === 7 && ev.data?.pdfId) {
              const pdfId = ev.data.pdfId as string;
              const res = await fetch('/api/pdfs');
              if (res.ok) setPdfs(await res.json() as PDF[]);
              setActiveJob(prev => prev ? { ...prev, isRunning: false, completedPdfId: pdfId } : null);
            }
          } catch {
            /* ignore parse errors */
          }
        }
      }
    } catch (e) {
      setActiveJob(prev => prev ? {
        ...prev,
        isRunning: false,
        logs: [...prev.logs, { phase: 0, message: `Error: ${(e as Error).message}`, pct: 0 }],
      } : null);
    }
  }, [setPdfs, setView]);

  return {
    activeJob,
    isJobRunning: activeJob?.isRunning ?? false,
    startProcessing,
  };
}
