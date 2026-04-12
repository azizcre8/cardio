'use client';

import { useEffect, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase';
import LibraryView from '@/components/LibraryView';
import StudyView from '@/components/StudyView';
import StatsView from '@/components/StatsView';
import SettingsView from '@/components/SettingsView';
import type { PDF } from '@/types';

export type AppView = 'library' | 'study' | 'stats' | 'settings';

export default function AppPage() {
  const [view,       setView]       = useState<AppView>('library');
  const [pdfs,       setPdfs]       = useState<PDF[]>([]);
  const [studyPdfId, setStudyPdfId] = useState<string | null>(null);
  const [examDate,   setExamDate]   = useState<string | null>(null);
  const [userId,     setUserId]     = useState<string | null>(null);

  useEffect(() => {
    supabaseBrowser.auth.getUser().then(({ data }: { data: { user: { id: string } | null } }) => {
      setUserId(data.user?.id ?? null);
    });
  }, []);

  useEffect(() => {
    if (!userId) return;
    supabaseBrowser
      .from('pdfs')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .then(({ data }: { data: PDF[] | null }) => setPdfs((data ?? []) as PDF[]));

    supabaseBrowser
      .from('users')
      .select('exam_date')
      .eq('id', userId)
      .single()
      .then(({ data }: { data: { exam_date: string | null } | null }) => setExamDate(data?.exam_date ?? null));
  }, [userId]);

  function startStudy(pdfId: string) {
    setStudyPdfId(pdfId);
    setView('study');
  }

  const navBtnClass = (v: AppView) =>
    `text-xs font-semibold tracking-widest uppercase transition-colors whitespace-nowrap px-1 py-0.5 ${
      view === v
        ? 'text-[var(--accent)]'
        : 'text-[var(--text-dim)] hover:text-[var(--text-secondary)]'
    }`;

  return (
    <div className="flex flex-col min-h-screen">
      {/* ── Nav ── */}
      <nav
        className="flex items-center gap-5 px-5 py-0 h-[56px] border-b"
        style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
      >
        {/* Brand */}
        <div
          className="cursor-pointer flex items-baseline gap-2 mr-2 flex-shrink-0"
          onClick={() => setView('library')}
        >
          <span
            className="text-base font-bold tracking-widest uppercase"
            style={{ color: 'var(--accent)' }}
          >
            Cardio
          </span>
          <span
            className="text-[0.58rem] font-medium tracking-[0.13em] uppercase hidden sm:block"
            style={{ color: 'var(--text-dim)' }}
          >
            Clinical Spaced Repetition
          </span>
        </div>

        {/* Nav links */}
        <button onClick={() => setView('library')}  className={navBtnClass('library')}>Library</button>
        <button onClick={() => setView('stats')}    className={navBtnClass('stats')}>Stats</button>
        <button onClick={() => setView('settings')} className={navBtnClass('settings')}>Settings</button>

        <div className="ml-auto">
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
      <main className="flex-1 px-4 py-6">
        {view === 'library' && (
          <LibraryView
            pdfs={pdfs}
            examDate={examDate}
            userId={userId ?? ''}
            onStartStudy={startStudy}
            onPdfsChange={setPdfs}
          />
        )}
        {view === 'study' && studyPdfId && (
          <StudyView
            pdfId={studyPdfId}
            examDate={examDate}
            onDone={() => setView('library')}
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
