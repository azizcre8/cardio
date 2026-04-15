'use client';

import { useState } from 'react';
import AppContent from '@/components/AppContent';
import AppNav from '@/components/AppNav';
import { useProcessingJob, useThemePreference, useUserLibraryData } from './use-app-state';

export type AppView = 'library' | 'add' | 'processing' | 'conceptmap' | 'bankselect' | 'quiz' | 'stats' | 'settings';

export default function AppPage() {
  const [view, setView] = useState<AppView>('library');
  const [conceptMapPdfId, setConceptMapPdfId] = useState<string | null>(null);
  const [quizPdfId, setQuizPdfId] = useState<string | null>(null);
  const { pdfs, setPdfs, decks, setDecks, examDate, setExamDate, userId } = useUserLibraryData();
  const { darkMode, toggleDark } = useThemePreference();
  const { activeJob, isJobRunning, startProcessing } = useProcessingJob(setView, setPdfs);

  /* ── Navigation helpers ── */
  function openConceptMap(pdfId: string) {
    setConceptMapPdfId(pdfId);
    setView('conceptmap');
  }
  function startQuiz(pdfId: string) { setQuizPdfId(pdfId); setView('quiz'); }
  function quizDone() {
    if (quizPdfId) setConceptMapPdfId(quizPdfId);
    setView('conceptmap');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <AppNav
        view={view}
        isJobRunning={isJobRunning}
        darkMode={darkMode}
        onSetView={setView}
        onToggleDark={toggleDark}
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
        onSetView={setView}
        onStartProcessing={startProcessing}
        onOpenConceptMap={openConceptMap}
        onStartQuiz={startQuiz}
        onQuizDone={quizDone}
        onPdfsChange={setPdfs}
        onDecksChange={setDecks}
        onExamDateChange={setExamDate}
      />
    </div>
  );
}
