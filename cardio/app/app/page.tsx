'use client';

import { useEffect, useState, useCallback } from 'react';
import { supabaseBrowser } from '@/lib/supabase';
import LibraryView from '@/components/LibraryView';
import AddView from '@/components/AddView';
import ProcessingView, { type ActiveJob } from '@/components/ProcessingView';
import StatsView from '@/components/StatsView';
import SettingsView from '@/components/SettingsView';
import ConceptMapView from '@/components/ConceptMapView';
import BankSelectView from '@/components/BankSelectView';
import QuizView from '@/components/QuizView';
import type { PDF, Density, ProcessEvent } from '@/types';

export type AppView = 'library' | 'add' | 'processing' | 'conceptmap' | 'bankselect' | 'quiz' | 'stats' | 'settings';

const THEME_KEY = 'cardio-theme';

export default function AppPage() {
  const [view,            setView]            = useState<AppView>('library');
  const [pdfs,            setPdfs]            = useState<PDF[]>([]);
  const [conceptMapPdfId, setConceptMapPdfId] = useState<string | null>(null);
  const [quizPdfId,       setQuizPdfId]       = useState<string | null>(null);
  const [examDate,        setExamDate]        = useState<string | null>(null);
  const [userId,          setUserId]          = useState<string | null>(null);
  const [darkMode,        setDarkMode]        = useState(false);
  const [activeJob,       setActiveJob]       = useState<ActiveJob | null>(null);

  /* ── Auth & initial data ── */
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
  }, [userId]);

  /* ── Dark mode ── */
  useEffect(() => {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark') { setDarkMode(true); document.documentElement.setAttribute('data-theme', 'dark'); }
  }, []);

  function toggleDark() {
    const next = !darkMode;
    setDarkMode(next);
    if (next) {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem(THEME_KEY, 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem(THEME_KEY, 'light');
    }
  }

  /* ── Background processing ── */
  const startProcessing = useCallback(async (file: File, density: Density, maxQuestions: number) => {
    const job: ActiveJob = {
      pdfName:        file.name,
      density,
      maxQuestions,
      logs:           [],
      isRunning:      true,
      startedAt:      Date.now(),
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
          ...prev, isRunning: false,
          logs: [...prev.logs, { phase: 0, message: `Error: ${txt}`, pct: 0 }],
        } : null);
        return;
      }

      const reader = resp.body!.getReader();
      const dec    = new TextDecoder();
      let buf      = '';

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
              const res   = await fetch('/api/pdfs');
              if (res.ok) setPdfs(await res.json() as PDF[]);
              setActiveJob(prev => prev ? { ...prev, isRunning: false, completedPdfId: pdfId } : null);
            }
          } catch { /* ignore parse errors */ }
        }
      }
    } catch (e) {
      setActiveJob(prev => prev ? {
        ...prev, isRunning: false,
        logs: [...prev.logs, { phase: 0, message: `Error: ${(e as Error).message}`, pct: 0 }],
      } : null);
    }
  }, []);

  /* ── Navigation helpers ── */
  function openConceptMap(pdfId: string) {
    setConceptMapPdfId(pdfId);
    setView('conceptmap');
  }
  function openBankSelect() { setView('bankselect'); }
  function startQuiz(pdfId: string) { setQuizPdfId(pdfId); setView('quiz'); }

  const conceptMapPdf = pdfs.find(p => p.id === conceptMapPdfId) ?? null;

  /* ── Nav button styles ── */
  const navBtn = (v: AppView | AppView[]) => {
    const active = Array.isArray(v) ? v.includes(view) : view === v;
    return `text-xs font-semibold tracking-widest uppercase transition-colors whitespace-nowrap px-1 py-0.5 ${
      active
        ? 'text-[var(--accent)]'
        : 'text-[var(--text-dim)] hover:text-[var(--text-secondary)]'
    }`;
  };

  const isJobRunning = activeJob?.isRunning ?? false;

  return (
    <div className="flex flex-col min-h-screen">
      {/* ── Nav ── */}
      <nav
        className="flex items-center gap-5 px-5 h-[56px] border-b sticky top-0 z-30"
        style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
      >
        {/* Brand */}
        <div
          className="cursor-pointer flex items-baseline gap-2 mr-2 flex-shrink-0"
          onClick={() => setView('library')}
        >
          <span className="text-base font-bold tracking-widest uppercase" style={{ color: 'var(--accent)' }}>
            Cardio
          </span>
          <span className="text-[0.58rem] font-medium tracking-[0.13em] uppercase hidden sm:block" style={{ color: 'var(--text-dim)' }}>
            Clinical SRS
          </span>
        </div>

        {/* Nav links */}
        <button onClick={() => setView('library')}  className={navBtn('library')}>Library</button>

        {/* Add tab with processing indicator */}
        <button
          onClick={() => setView(isJobRunning ? 'processing' : 'add')}
          className={navBtn(['add', 'processing'])}
          style={{ position: 'relative' }}
        >
          Add
          {isJobRunning && view !== 'processing' && (
            <span style={{
              position: 'absolute', top: '-2px', right: '-6px',
              width: '6px', height: '6px', borderRadius: '50%',
              background: '#14B8C8',
              animation: 'processing-badge 1.0s ease-in-out infinite',
            }} />
          )}
        </button>

        <button onClick={() => setView('stats')}    className={navBtn('stats')}>Stats</button>
        <button onClick={() => setView('settings')} className={navBtn('settings')}>Settings</button>

        <div className="ml-auto flex items-center gap-4">
          {/* Dark mode toggle */}
          <button
            onClick={toggleDark}
            title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            style={{
              width: '32px', height: '32px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: 'var(--radius-md)',
              background: 'var(--bg-sunken)', border: '1px solid var(--border)',
              cursor: 'pointer', fontSize: '0.9rem',
              transition: 'background 0.15s, border-color 0.15s',
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLButtonElement).style.background = 'var(--accent-dim)';
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(13,154,170,0.3)';
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-sunken)';
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)';
            }}
          >
            {darkMode ? '☀️' : '🌙'}
          </button>

          {/* Sign out */}
          <button
            onClick={() => supabaseBrowser.auth.signOut().then(() => window.location.href = '/login')}
            className="text-xs font-semibold tracking-widest uppercase whitespace-nowrap transition-colors"
            style={{ color: 'var(--text-dim)' }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--red)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
          >
            Sign Out
          </button>
        </div>
      </nav>

      {/* ── Body ── */}
      <main className={`flex-1 ${view === 'processing' ? '' : 'px-4 py-6'}`}>

        {view === 'library' && (
          <LibraryView
            pdfs={pdfs}
            examDate={examDate}
            userId={userId ?? ''}
            onOpenConceptMap={openConceptMap}
            onPdfsChange={setPdfs}
            onProcessingComplete={openConceptMap}
          />
        )}

        {view === 'add' && (
          <div className="px-4 py-6">
            <AddView
              pdfs={pdfs}
              isJobRunning={isJobRunning}
              onStartProcessing={startProcessing}
              onViewProcessing={() => setView('processing')}
              onOpenDeck={openConceptMap}
            />
          </div>
        )}

        {view === 'processing' && activeJob && (
          <ProcessingView
            job={activeJob}
            onBack={() => setView('library')}
          />
        )}

        {/* Redirect to add if processing view accessed without a job */}
        {view === 'processing' && !activeJob && (
          <div className="px-4 py-6">
            <AddView
              pdfs={pdfs}
              isJobRunning={false}
              onStartProcessing={startProcessing}
              onViewProcessing={() => setView('processing')}
              onOpenDeck={openConceptMap}
            />
          </div>
        )}

        {view === 'conceptmap' && conceptMapPdf && (
          <ConceptMapView
            pdf={conceptMapPdf}
            onStudyNow={() => startQuiz(conceptMapPdfId!)}
            onBack={() => setView('library')}
          />
        )}

        {view === 'bankselect' && (
          <BankSelectView
            pdfs={pdfs}
            onSelect={startQuiz}
            onBack={() => setView(conceptMapPdfId ? 'conceptmap' : 'library')}
          />
        )}

        {view === 'quiz' && quizPdfId && (
          <QuizView
            pdfId={quizPdfId}
            onDone={openBankSelect}
          />
        )}

        {view === 'stats' && (
          <StatsView pdfs={pdfs} examDate={examDate} />
        )}

        {view === 'settings' && (
          <SettingsView
            examDate={examDate}
            onExamDateChange={setExamDate}
            userId={userId ?? ''}
          />
        )}
      </main>
    </div>
  );
}
