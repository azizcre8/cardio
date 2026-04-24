'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import AppContent from '@/components/AppContent';
import AppNav from '@/components/AppNav';
import CommandPalette from '@/components/CommandPalette';
import { useProcessingJob, useThemePreference, useUserLibraryData } from './use-app-state';

export type AppView = 'library' | 'add' | 'processing' | 'conceptmap' | 'bankselect' | 'quiz' | 'study' | 'stats' | 'settings';

export default function AppPage() {
  const [view, setView] = useState<AppView>('library');
  const [conceptMapPdfId, setConceptMapPdfId] = useState<string | null>(null);
  const [quizPdfId, setQuizPdfId] = useState<string | null>(null);
  const [studyPdfId, setStudyPdfId] = useState<string | null>(null);
  const [sharedSlug, setSharedSlug] = useState<string | null>(null);
  const handledSharedSlug = useRef<string | null>(null);
  const { pdfs, setPdfs, refreshPdfs, decks, setDecks, examDate, setExamDate, userId } = useUserLibraryData();
  const { darkMode, toggleDark } = useThemePreference();
  const { activeJob, isJobRunning, startProcessing } = useProcessingJob(setView, setPdfs);
  const [paletteOpen, setPaletteOpen] = useState(false);

  /* ── Cmd+K keyboard shortcut ── */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setPaletteOpen(p => !p);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* ── Navigation helpers ── */
  function openConceptMap(pdfId: string) {
    setConceptMapPdfId(pdfId);
    setView('conceptmap');
  }
  function startQuiz(pdfId: string) { setQuizPdfId(pdfId); setView('quiz'); }
  function startStudy(pdfId: string) { setStudyPdfId(pdfId); setView('study'); }

  const handlePaletteNavigate = useCallback((navView: string, pdfId?: string) => {
    if (pdfId) { startQuiz(pdfId); }
    else { setView(navView as AppView); }
    setPaletteOpen(false);
  }, []);
  function quizDone() {
    if (quizPdfId) setConceptMapPdfId(quizPdfId);
    setView('conceptmap');
  }
  function studyDone() {
    if (studyPdfId) setConceptMapPdfId(studyPdfId);
    setView('conceptmap');
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const slug = params.get('shared') ?? params.get('join') ?? localStorage.getItem('pendingJoin');
    if (slug) {
      localStorage.removeItem('pendingJoin');
      setSharedSlug(slug);
    }
  }, []);

  useEffect(() => {
    if (!userId || !sharedSlug || handledSharedSlug.current === sharedSlug) return;

    handledSharedSlug.current = sharedSlug;

    void (async () => {
      const res = await fetch(`/api/shared-banks/${encodeURIComponent(sharedSlug)}/join`, {
        method: 'POST',
      });
      if (!res.ok) return;

      const data = await res.json().catch(() => null) as {
        bank?: { source_pdf_id?: string | null };
      } | null;

      await refreshPdfs();

      const sharedPdfId = data?.bank?.source_pdf_id ?? null;
      if (sharedPdfId) {
        setConceptMapPdfId(sharedPdfId);
        setView('conceptmap');
      }
    })();
  }, [refreshPdfs, sharedSlug, userId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <AppNav
        view={view}
        isJobRunning={isJobRunning}
        darkMode={darkMode}
        onSetView={setView}
        onToggleDark={toggleDark}
        onOpenPalette={() => setPaletteOpen(true)}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        pdfs={pdfs}
        decks={decks}
        onNavigate={handlePaletteNavigate}
      />
      <AppContent
        view={view}
        pdfs={pdfs}
        decks={decks}
        examDate={examDate}
        userId={userId}
        activeJob={activeJob}
        isJobRunning={isJobRunning}
        conceptMapPdfId={conceptMapPdfId}
        quizPdfId={quizPdfId}
        studyPdfId={studyPdfId}
        onSetView={setView}
        onStartProcessing={startProcessing}
        onOpenConceptMap={openConceptMap}
        onStartQuiz={startQuiz}
        onQuizDone={quizDone}
        onStartStudy={startStudy}
        onStudyDone={studyDone}
        onPdfsChange={setPdfs}
        onDecksChange={setDecks}
        onExamDateChange={setExamDate}
      />
    </div>
  );
}
