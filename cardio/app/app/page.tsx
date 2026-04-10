'use client';

import { useEffect, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase';
import LibraryView from '@/components/LibraryView';
import StudyView from '@/components/StudyView';
import StatsView from '@/components/StatsView';
import SettingsView from '@/components/SettingsView';
import type { PDF, StudyQueueItem } from '@/types';

export type AppView = 'library' | 'study' | 'stats' | 'settings';

export default function AppPage() {
  const [view,       setView]       = useState<AppView>('library');
  const [pdfs,       setPdfs]       = useState<PDF[]>([]);
  const [studyPdfId, setStudyPdfId] = useState<string | null>(null);
  const [examDate,   setExamDate]   = useState<string | null>(null);
  const [userId,     setUserId]     = useState<string | null>(null);

  useEffect(() => {
    supabaseBrowser.auth.getUser().then(({ data }) => {
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
      .then(({ data }) => setPdfs((data ?? []) as PDF[]));

    supabaseBrowser
      .from('users')
      .select('exam_date')
      .eq('id', userId)
      .single()
      .then(({ data }) => setExamDate(data?.exam_date ?? null));
  }, [userId]);

  function startStudy(pdfId: string) {
    setStudyPdfId(pdfId);
    setView('study');
  }

  return (
    <div className="flex flex-col min-h-screen">
      {/* Nav */}
      <nav className="border-b border-gray-800 px-4 py-3 flex items-center gap-6">
        <span className="text-red-500 font-bold text-lg tracking-wider">CARDIO</span>
        <button
          onClick={() => setView('library')}
          className={`text-sm ${view === 'library' ? 'text-white' : 'text-gray-400 hover:text-white'}`}
        >Library</button>
        <button
          onClick={() => setView('stats')}
          className={`text-sm ${view === 'stats' ? 'text-white' : 'text-gray-400 hover:text-white'}`}
        >Stats</button>
        <button
          onClick={() => setView('settings')}
          className={`text-sm ${view === 'settings' ? 'text-white' : 'text-gray-400 hover:text-white'}`}
        >Settings</button>
        <div className="ml-auto">
          <button
            onClick={() => supabaseBrowser.auth.signOut().then(() => window.location.href = '/login')}
            className="text-xs text-gray-500 hover:text-red-400"
          >Sign out</button>
        </div>
      </nav>

      {/* Body */}
      <main className="flex-1 p-4">
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
