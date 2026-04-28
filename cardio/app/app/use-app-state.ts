'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { uploadPdfToStorage } from '@/lib/upload-pdf';
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

    const getEventPdfId = (ev: ProcessEvent): string | null => (
      typeof ev.data?.pdfId === 'string' ? ev.data.pdfId : null
    );
    const getEventNumber = (value: unknown): number => (
      typeof value === 'number' && Number.isFinite(value) ? value : 0
    );
    const isDoneEvent = (ev: ProcessEvent): boolean => (
      ev.phase === 7 || ev.message.trim().toLowerCase() === 'done'
    );

    // Streams SSE events from a response into the active job log.
    // Returns true when the caller stopped on a terminal event.
    const streamSSE = async (
      resp: Response,
      onTerminal: (ev: ProcessEvent) => boolean, // return true to stop streaming
    ): Promise<boolean> => {
      if (!resp.body) {
        throw new Error('Streaming response had no body');
      }

      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';

      const processBlock = (block: string): boolean => {
        const dataLines = block
          .split(/\r?\n/)
          .map(line => line.trimEnd())
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart());
        if (!dataLines.length) return false;

        const payload = dataLines.join('\n').trim();
        if (!payload) return false;

        try {
          const ev = JSON.parse(payload) as ProcessEvent;
          setActiveJob(prev => prev ? { ...prev, logs: [...prev.logs, ev] } : null);
          return onTerminal(ev);
        } catch {
          return false;
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          const tail = dec.decode();
          if (tail) buf += tail;
          const finalBlock = buf.trim();
          if (finalBlock && processBlock(finalBlock)) return true;
          break;
        }
        buf += dec.decode(value, { stream: true });
        const lines = buf.split(/\r?\n\r?\n/);
        buf = lines.pop() ?? '';

        for (const line of lines) {
          if (processBlock(line)) return true;
        }
      }

      return false;
    };

    try {
      const { data: { user } } = await supabaseBrowser.auth.getUser();
      if (!user?.id) {
        setActiveJob(prev => prev ? {
          ...prev,
          isRunning: false,
          logs: [...prev.logs, { phase: 0, message: 'Error: You must be signed in to upload PDFs.', pct: 0 }],
        } : null);
        return;
      }

      const storagePath = await uploadPdfToStorage(file, user.id);

      // ── Phase 1: Call /api/process (prepare: phases 1-5) ──
      const prepResp = await fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storagePath, density }),
      });
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
      let _cappedConceptCount = 0;
      let prepError = false;
      let prepCompleted = false;

      await streamSSE(prepResp, ev => {
        if (ev.phase === 0) { prepError = true; return true; }
        const pdfId = getEventPdfId(ev);
        if (ev.phase === 6 && ev.data?.readyForGenerate && pdfId) {
          preparedPdfId = pdfId;
          _cappedConceptCount = getEventNumber(ev.data.cappedConceptCount);
        }
        if (isDoneEvent(ev) && pdfId) {
          prepCompleted = true;
          preparedPdfId = pdfId;
          void fetch('/api/pdfs').then(r => r.ok ? r.json() : null).then((data: PDF[] | null) => {
            if (data) setPdfs(data);
          });
          setActiveJob(prev => prev ? { ...prev, isRunning: false, completedPdfId: pdfId } : null);
          return true;
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

      if (prepCompleted) return;

      // ── Phase 2: Call /api/process/generate in batches of 15 concepts ──
      const CONCEPTS_PER_CALL = 15;
      const totalConcepts = _cappedConceptCount || 1; // fallback: at least 1 so loop runs once
      let genOffset = 0;
      let genSawTerminal = false;
      let genError = false;

      while (!genSawTerminal && !genError) {
        const isLast = genOffset + CONCEPTS_PER_CALL >= totalConcepts;
        const genResp = await fetch('/api/process/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pdfId: preparedPdfId,
            batchOffset: genOffset,
            batchSize: CONCEPTS_PER_CALL,
            isFinal: isLast,
          }),
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

        let batchDone = false;
        await streamSSE(genResp, ev => {
          const pdfId = getEventPdfId(ev);
          if (isDoneEvent(ev) && pdfId) {
            genSawTerminal = true;
            void fetch('/api/pdfs').then(r => r.ok ? r.json() : null).then((data: PDF[] | null) => {
              if (data) setPdfs(data);
            });
            setActiveJob(prev => prev ? { ...prev, isRunning: false, completedPdfId: pdfId } : null);
            return true;
          }
          if (ev.phase === 0) {
            genError = true;
            setActiveJob(prev => prev ? { ...prev, isRunning: false } : null);
            return true;
          }
          if (ev.phase === 6 && ev.data?.batchDone) {
            batchDone = true;
            return true;
          }
          return false;
        });

        if (!genSawTerminal && !genError && !batchDone && !isLast) {
          // Stream closed without a terminal — treat as error
          setActiveJob(prev => prev ? {
            ...prev,
            isRunning: false,
            logs: [...prev.logs, { phase: 0, message: 'Error: Question generation stream ended unexpectedly. Check server logs.', pct: 0 }],
          } : null);
          return;
        }

        genOffset += CONCEPTS_PER_CALL;
        if (isLast && !genSawTerminal && !genError) {
          // Final batch ended without phase 7 — shouldn't happen but guard it
          setActiveJob(prev => prev ? {
            ...prev,
            isRunning: false,
            logs: [...prev.logs, { phase: 0, message: 'Error: Final generation batch ended without completion. Check server logs.', pct: 0 }],
          } : null);
          return;
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
