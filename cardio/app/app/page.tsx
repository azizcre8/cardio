'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import AppContent from '@/components/AppContent';
import AppNav from '@/components/AppNav';
import CommandPalette from '@/components/CommandPalette';
import { useProcessingJob, useThemePreference, useUserLibraryData } from './use-app-state';
import type { JoinedSharedBankNotice, PDF } from '@/types';

export type AppView = 'library' | 'add' | 'processing' | 'conceptmap' | 'bankselect' | 'quiz' | 'study' | 'stats' | 'question-stats' | 'allquestions' | 'settings';

const APP_VIEWS: AppView[] = ['library', 'add', 'processing', 'conceptmap', 'bankselect', 'quiz', 'study', 'stats', 'question-stats', 'allquestions', 'settings'];

export default function AppPage() {
  const [view, setView] = useState<AppView>('library');
  const [conceptMapPdfId, setConceptMapPdfId] = useState<string | null>(null);
  const [quizPdfId, setQuizPdfId] = useState<string | null>(null);
  const [quizSharedBankSlug, setQuizSharedBankSlug] = useState<string | null>(null);
  const [studyPdfId, setStudyPdfId] = useState<string | null>(null);
  const [sharedSlug, setSharedSlug] = useState<string | null>(null);
  const [joinedBankNotice, setJoinedBankNotice] = useState<JoinedSharedBankNotice | null>(null);
  const handledSharedSlug = useRef<string | null>(null);
  const { pdfs, setPdfs, refreshPdfs, decks, setDecks, examDate, setExamDate, userId, userEmail, userPlan } = useUserLibraryData();
  const { darkMode, toggleDark } = useThemePreference();
  const setAppView = useCallback((next: AppView) => setView(next), []);
  const { activeJob, isJobRunning, startProcessing } = useProcessingJob(setAppView, setPdfs);
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

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlView = params.get('view');
    if (urlView && APP_VIEWS.includes(urlView as AppView)) setView(urlView as AppView);
    const pdfId = params.get('pdfId');
    if (pdfId) {
      setConceptMapPdfId(pdfId);
      if (urlView === 'quiz') setQuizPdfId(pdfId);
      if (urlView === 'study') setStudyPdfId(pdfId);
    } else if (urlView === 'quiz') {
      const sharedQuizSlug = params.get('sharedQuiz');
      if (sharedQuizSlug) setQuizSharedBankSlug(sharedQuizSlug);
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    params.set('view', view);
    const pdfId = view === 'quiz'
      ? quizPdfId
      : view === 'study'
      ? studyPdfId
      : view === 'conceptmap'
      ? conceptMapPdfId
      : null;
    if (pdfId) params.set('pdfId', pdfId);
    else params.delete('pdfId');
    if (view === 'quiz' && quizSharedBankSlug) params.set('sharedQuiz', quizSharedBankSlug);
    else params.delete('sharedQuiz');
    window.history.replaceState(null, '', `/app?${params.toString()}`);
  }, [conceptMapPdfId, quizPdfId, quizSharedBankSlug, studyPdfId, view]);

  /* ── Navigation helpers ── */
  const startQuiz = useCallback((pdfId: string) => {
    setQuizPdfId(pdfId);
    setQuizSharedBankSlug(null);
    setAppView('quiz');
  }, [setAppView]);

  const startMixedQuiz = useCallback((slug: string) => {
    setQuizPdfId(null);
    setQuizSharedBankSlug(slug);
    setAppView('quiz');
  }, [setAppView]);

  const startStudy = useCallback((pdfId: string) => {
    setStudyPdfId(pdfId);
    setAppView('study');
  }, [setAppView]);

  async function openConceptMap(pdfId: string) {
    try {
      const res = await fetch(`/api/pdfs/${pdfId}/has-concepts`);
      const data = await res.json().catch(() => null) as { hasConcepts?: boolean } | null;
      if (res.ok && data?.hasConcepts === false) {
        startQuiz(pdfId);
        return;
      }
    } catch { /* fall through to concept map */ }
    setConceptMapPdfId(pdfId);
    setAppView('conceptmap');
  }

  const handlePaletteNavigate = useCallback((navView: string, pdfId?: string) => {
    if (pdfId) { startQuiz(pdfId); }
    else { setAppView(navView as AppView); }
    setPaletteOpen(false);
  }, [setAppView, startQuiz]);
  function quizDone() {
    if (quizPdfId) {
      setConceptMapPdfId(quizPdfId);
      setAppView('conceptmap');
      return;
    }
    setQuizSharedBankSlug(null);
    setAppView('library');
  }
  function studyDone() {
    if (studyPdfId) setConceptMapPdfId(studyPdfId);
    setAppView('conceptmap');
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const slug = params.get('shared') ?? params.get('join');
    if (slug) {
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
        bank?: {
          slug?: string | null;
          title?: string | null;
          source_pdf_id?: string | null;
          source_pdfs?: PDF[];
        };
      } | null;

      await refreshPdfs();

      const sourcePdfs = data?.bank?.source_pdfs ?? [];
      const firstPdfId = sourcePdfs.find(pdf => !!pdf.processed_at)?.id
        ?? data?.bank?.source_pdf_id
        ?? null;
      setJoinedBankNotice({
        slug: data?.bank?.slug ?? sharedSlug,
        title: data?.bank?.title ?? 'Shared question bank',
        sourceCount: sourcePdfs.length,
        questionCount: sourcePdfs.reduce((sum, pdf) => sum + (pdf.question_count ?? 0), 0),
        firstPdfId,
      });
      setAppView('library');
    })();
  }, [refreshPdfs, setAppView, sharedSlug, userId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <AppNav
        view={view}
        isJobRunning={isJobRunning}
        darkMode={darkMode}
        onSetView={setAppView}
        onToggleDark={toggleDark}
        onOpenPalette={() => setPaletteOpen(true)}
        userEmail={userEmail}
        userPlan={userPlan}
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
        userEmail={userEmail}
        userPlan={userPlan}
        activeJob={activeJob}
        isJobRunning={isJobRunning}
        conceptMapPdfId={conceptMapPdfId}
        quizPdfId={quizPdfId}
        quizSharedBankSlug={quizSharedBankSlug}
        studyPdfId={studyPdfId}
        onSetView={setAppView}
        onStartProcessing={startProcessing}
        onOpenConceptMap={openConceptMap}
        onStartQuiz={startQuiz}
        onStartMixedQuiz={startMixedQuiz}
        onQuizDone={quizDone}
        onStartStudy={startStudy}
        onStudyDone={studyDone}
        onPdfsChange={setPdfs}
        onDecksChange={setDecks}
        onExamDateChange={setExamDate}
        joinedBankNotice={joinedBankNotice}
        onDismissJoinedBank={() => setJoinedBankNotice(null)}
      />
    </div>
  );
}
