'use client';

import { useEffect, useState, useCallback } from 'react';
import type { CSSProperties } from 'react';
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
  function startQuiz(pdfId: string) { setQuizPdfId(pdfId); setView('quiz'); }
  function quizDone() {
    // Return to concept map for the quiz's PDF
    if (quizPdfId) setConceptMapPdfId(quizPdfId);
    setView('conceptmap');
  }

  const conceptMapPdf = pdfs.find(p => p.id === conceptMapPdfId) ?? null;

  const isJobRunning = activeJob?.isRunning ?? false;
  const navButtonStyle = (v: AppView | AppView[]): CSSProperties => {
    const active = Array.isArray(v) ? v.includes(view) : view === v;
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
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
      }}
    >
      {/* ── Nav ── */}
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
        {/* Brand */}
        <div
          style={{
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'baseline',
            gap: '8px',
            marginRight: '8px',
            flexShrink: 0,
          }}
          onClick={() => setView('library')}
        >
          <span style={{ fontSize: '1rem', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--accent)' }}>
            Cardio
          </span>
          <span style={{ fontSize: '0.58rem', fontWeight: 500, letterSpacing: '0.13em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>
            Clinical SRS
          </span>
        </div>

        {/* Nav links */}
        <button
          onClick={() => setView('library')}
          style={navButtonStyle('library')}
          onMouseEnter={e => { if (view !== 'library') e.currentTarget.style.color = 'var(--text-secondary)'; }}
          onMouseLeave={e => { if (view !== 'library') e.currentTarget.style.color = 'var(--text-dim)'; }}
        >
          Library
        </button>

        {/* Add tab with processing indicator */}
        <button
          onClick={() => setView(isJobRunning ? 'processing' : 'add')}
          style={{ ...navButtonStyle(['add', 'processing']), position: 'relative' }}
          onMouseEnter={e => { if (!['add', 'processing'].includes(view)) e.currentTarget.style.color = 'var(--text-secondary)'; }}
          onMouseLeave={e => { if (!['add', 'processing'].includes(view)) e.currentTarget.style.color = 'var(--text-dim)'; }}
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

        <button
          onClick={() => setView('stats')}
          style={navButtonStyle('stats')}
          onMouseEnter={e => { if (view !== 'stats') e.currentTarget.style.color = 'var(--text-secondary)'; }}
          onMouseLeave={e => { if (view !== 'stats') e.currentTarget.style.color = 'var(--text-dim)'; }}
        >
          Stats
        </button>
        <button
          onClick={() => setView('settings')}
          style={navButtonStyle('settings')}
          onMouseEnter={e => { if (view !== 'settings') e.currentTarget.style.color = 'var(--text-secondary)'; }}
          onMouseLeave={e => { if (view !== 'settings') e.currentTarget.style.color = 'var(--text-dim)'; }}
        >
          Settings
        </button>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '16px' }}>
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
      <main
        style={{
          flex: 1,
          padding: view === 'processing' ? '0' : '24px 16px',
        }}
      >

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
          <div style={{ padding: '24px 16px' }}>
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
          <div style={{ padding: '24px 16px' }}>
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
            onDone={quizDone}
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
