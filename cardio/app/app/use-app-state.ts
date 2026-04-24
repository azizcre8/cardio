'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import type { Deck, Density, PDF, ProcessEvent } from '@/types';
import type { ActiveJob } from '@/components/ProcessingView';
import type { AppView } from './page';
import { isDevAuthBypassEnabled } from '@/lib/dev-auth';

const THEME_KEY = 'cardio-theme';

export function useUserLibraryData() {
  const [pdfs, setPdfs] = useState<PDF[]>([]);
  const [decks, setDecks] = useState<Deck[]>([]);
  const [examDate, setExamDate] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userPlan, setUserPlan] = useState<string>('free');

  const refreshPdfs = useCallback(async () => {
    const res = await fetch('/api/pdfs');
    if (!res.ok) return;
    setPdfs(await res.json() as PDF[]);
  }, []);

  useEffect(() => {
    if (isDevAuthBypassEnabled()) {
      fetch('/api/users/me')
        .then(r => r.ok ? r.json() : null)
        .then((data: { id?: string | null } | null) => setUserId(data?.id ?? null))
        .catch(() => setUserId(null));
      return;
    }

    supabaseBrowser.auth.getUser().then(({ data }: { data: { user: { id: string } | null } }) => {
      setUserId(data.user?.id ?? null);
    });
  }, []);

  useEffect(() => {
    if (!userId) return;

    void refreshPdfs();

    fetch('/api/users/me')
      .then(r => r.ok ? r.json() : null)
      .then((data: { exam_date: string | null; email?: string | null; plan?: string } | null) => {
        setExamDate(data?.exam_date ?? null);
        setUserEmail(data?.email ?? null);
        setUserPlan(data?.plan ?? 'free');
      })
      .catch(() => setExamDate(null));

    fetch('/api/decks')
      .then(r => r.ok ? r.json() : [])
      .then((data: Deck[]) => setDecks(data))
      .catch(() => { /* decks table may not exist yet */ });
  }, [refreshPdfs, userId]);

  return {
    pdfs,
    setPdfs,
    refreshPdfs,
    decks,
    setDecks,
    examDate,
    setExamDate,
    userId,
    userEmail,
    userPlan,
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

    // Streams SSE events from a response into the active job log.
    // Returns the last pdfId seen in event data, or null if an error terminal event was seen.
    const streamSSE = async (
      resp: Response,
      onTerminal: (ev: ProcessEvent) => boolean, // return true to stop streaming
    ): Promise<void> => {
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
            if (onTerminal(ev)) return;
          } catch { /* ignore parse errors */ }
        }
      }
    };

    try {
      // ── Phase 1: Call /api/process (prepare: phases 1-5) ──
      const prepResp = await fetch('/api/process', { method: 'POST', body: form });
      if (!prepResp.ok) {
        const txt = await prepResp.text();
        setActiveJob(prev => prev ? {
          ...prev,
          isRunning: false,
          logs: [...prev.logs, { phase: 0, message: `Error: ${txt}`, pct: 0 }],
        } : null);
        return;
      }

      let preparedPdfId: string | null = null;
      let prepError = false;

      await streamSSE(prepResp, ev => {
        if (ev.phase === 0) { prepError = true; return true; }
        if (ev.phase === 6 && ev.data?.readyForGenerate && ev.data?.pdfId) {
          preparedPdfId = ev.data.pdfId as string;
        }
        return false;
      });

      if (prepError) {
        setActiveJob(prev => prev ? { ...prev, isRunning: false } : null);
        return;
      }

      if (!preparedPdfId) {
        setActiveJob(prev => prev ? {
          ...prev,
          isRunning: false,
          logs: [...prev.logs, { phase: 0, message: 'Error: Prepare phase ended without signalling readiness. Check server logs.', pct: 0 }],
        } : null);
        return;
      }

      // ── Phase 2: Call /api/process/generate (phase 6) ──
      const genResp = await fetch('/api/process/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdfId: preparedPdfId }),
      });
      if (!genResp.ok) {
        const txt = await genResp.text();
        setActiveJob(prev => prev ? {
          ...prev,
          isRunning: false,
          logs: [...prev.logs, { phase: 0, message: `Error: ${txt}`, pct: 0 }],
        } : null);
        return;
      }

      let sawGenTerminal = false;

      await streamSSE(genResp, ev => {
        if (ev.phase === 7 && ev.data?.pdfId) {
          sawGenTerminal = true;
          const pdfId = ev.data.pdfId as string;
          void fetch('/api/pdfs').then(r => r.ok ? r.json() : null).then((data: PDF[] | null) => {
            if (data) setPdfs(data);
          });
          setActiveJob(prev => prev ? { ...prev, isRunning: false, completedPdfId: pdfId } : null);
          return true;
        }
        if (ev.phase === 0) {
          sawGenTerminal = true;
          setActiveJob(prev => prev ? { ...prev, isRunning: false } : null);
          return true;
        }
        return false;
      });

      if (!sawGenTerminal) {
        setActiveJob(prev => prev ? {
          ...prev,
          isRunning: false,
          logs: [...prev.logs, { phase: 0, message: 'Error: Question generation stream ended unexpectedly. Check server logs.', pct: 0 }],
        } : null);
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
