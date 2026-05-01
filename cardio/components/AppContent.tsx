'use client';

'use client';

import { useEffect, useRef } from 'react';
import AddView from '@/components/AddView';
import AllQuestionsView from '@/components/AllQuestionsView';
import BankSelectView from '@/components/BankSelectView';
import ConceptMapView from '@/components/ConceptMapView';
import LibraryView from '@/components/LibraryView';
import ProcessingView, { type ActiveJob } from '@/components/ProcessingView';
import QuestionStatsView from '@/components/QuestionStatsView';
import QuizView from '@/components/QuizView';
import SettingsView from '@/components/SettingsView';
import StatsView from '@/components/StatsView';
import StudyView from '@/components/StudyView';
import type { Deck, Density, JoinedSharedBankNotice, PDF } from '@/types';
import type { AppView, StudySessionScope } from '@/app/app/page';

interface Props {
  view: AppView;
  pdfs: PDF[];
  decks: Deck[];
  examDate: string | null;
  userId: string | null;
  userEmail: string | null;
  userPlan: string;
  activeJob: ActiveJob | null;
  isJobRunning: boolean;
  conceptMapPdfId: string | null;
  quizPdfId: string | null;
  quizSharedBankSlug: string | null;
  quizDeckId: string | null;
  studyScope: StudySessionScope | null;
  onSetView: (view: AppView) => void;
  onStartProcessing: (file: File, density: Density, maxQuestions: number) => void;
  onOpenConceptMap: (pdfId: string) => void;
  onStartQuiz: (pdfId: string) => void;
  onStartMixedQuiz: (slug: string) => void;
  onStartDeckQuiz: (deckId: string) => void;
  onStartLibraryStudy: () => void;
  onStartDeckStudy: (deckId: string) => void;
  onQuizDone: () => void;
  onStartStudy: (pdfId: string) => void;
  onStudyDone: () => void;
  onPdfsChange: (pdfs: PDF[]) => void;
  onDecksChange: (decks: Deck[]) => void;
  onExamDateChange: (date: string | null) => void;
  joinedBankNotice: JoinedSharedBankNotice | null;
  onDismissJoinedBank: () => void;
}

export default function AppContent({
  view,
  pdfs,
  decks,
  examDate,
  userId,
  userEmail,
  userPlan,
  activeJob,
  isJobRunning,
  conceptMapPdfId,
  quizPdfId,
  quizSharedBankSlug,
  quizDeckId,
  studyScope,
  onSetView,
  onStartProcessing,
  onOpenConceptMap,
  onStartQuiz,
  onStartMixedQuiz,
  onStartDeckQuiz,
  onStartLibraryStudy,
  onStartDeckStudy,
  onQuizDone,
  onStartStudy,
  onStudyDone,
  onPdfsChange,
  onDecksChange,
  onExamDateChange,
  joinedBankNotice,
  onDismissJoinedBank,
}: Props) {
  const conceptMapPdf = pdfs.find(p => p.id === conceptMapPdfId) ?? null;
  const previousPdfIdsRef = useRef<Set<string>>(new Set(pdfs.map(pdf => pdf.id)));
  const pendingUploadOptionsRef = useRef<{ name?: string; deckId?: string | null } | null>(null);

  function handleStartProcessing(
    file: File,
    density: Density,
    maxQuestions: number,
    name?: string,
    deckId?: string | null,
  ) {
    pendingUploadOptionsRef.current = {
      name: name?.trim() || undefined,
      deckId: deckId ?? null,
    };
    onStartProcessing(file, density, maxQuestions);
  }

  useEffect(() => {
    const previousIds = previousPdfIdsRef.current;
    const added = pdfs.filter(pdf => !previousIds.has(pdf.id));
    previousPdfIdsRef.current = new Set(pdfs.map(pdf => pdf.id));

    const options = pendingUploadOptionsRef.current;
    if (!options || added.length === 0) return;

    const newPdf = [...added].sort((a, b) => (
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    ))[0];
    if (!newPdf) return;
    pendingUploadOptionsRef.current = null;

    const patch: { display_name?: string; deck_id?: string | null } = {};
    if (options.name) patch.display_name = options.name;
    if (options.deckId) patch.deck_id = options.deckId;
    if (Object.keys(patch).length === 0) return;

    void fetch(`/api/pdfs/${newPdf.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(res => {
      if (!res.ok) return;
      onPdfsChange(pdfs.map(pdf => (
        pdf.id === newPdf.id
          ? {
              ...pdf,
              display_name: patch.display_name ?? pdf.display_name,
              deck_id: 'deck_id' in patch ? patch.deck_id ?? null : pdf.deck_id,
            }
          : pdf
      )));
    });
  }, [pdfs, onPdfsChange]);

  return (
    <main
      style={{
        flex: 1,
        padding: (view === 'processing' || view === 'library' || view === 'quiz' || view === 'study') ? '0' : '24px 16px',
        overflow: 'auto',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {view === 'library' && (
        <LibraryView
          pdfs={pdfs}
          decks={decks}
          examDate={examDate}
          onOpenConceptMap={onOpenConceptMap}
          onPdfsChange={onPdfsChange}
          onDecksChange={onDecksChange}
          joinedBankNotice={joinedBankNotice}
          onDismissJoinedBank={onDismissJoinedBank}
          onStartMixedQuiz={onStartMixedQuiz}
          onStartDeckQuiz={onStartDeckQuiz}
          onStartLibraryStudy={onStartLibraryStudy}
          onStartDeckStudy={onStartDeckStudy}
        />
      )}

      {view === 'add' && (
        <AddView
          pdfs={pdfs}
          decks={decks}
          userEmail={userEmail}
          userPlan={userPlan}
          isJobRunning={isJobRunning}
          onStartProcessing={handleStartProcessing}
          onViewProcessing={() => onSetView('processing')}
          onOpenDeck={onOpenConceptMap}
        />
      )}

      {view === 'processing' && activeJob && (
        <ProcessingView job={activeJob} onBack={() => onSetView('library')} />
      )}

      {view === 'processing' && !activeJob && (
        <AddView
          pdfs={pdfs}
          decks={decks}
          userEmail={userEmail}
          userPlan={userPlan}
          isJobRunning={false}
          onStartProcessing={handleStartProcessing}
          onViewProcessing={() => onSetView('processing')}
          onOpenDeck={onOpenConceptMap}
        />
      )}

      {view === 'conceptmap' && conceptMapPdf && (
        <ConceptMapView
          pdf={conceptMapPdf}
          onStudyNow={() => onStartQuiz(conceptMapPdfId!)}
          onReviewDue={() => onStartStudy(conceptMapPdfId!)}
          onBack={() => onSetView('library')}
        />
      )}

      {view === 'bankselect' && (
        <BankSelectView
          pdfs={pdfs}
          onSelect={onStartQuiz}
          onBack={() => onSetView(conceptMapPdfId ? 'conceptmap' : 'library')}
        />
      )}

      {view === 'quiz' && (quizPdfId || quizSharedBankSlug || quizDeckId) && (
        <QuizView
          pdfId={quizPdfId ?? undefined}
          sharedBankSlug={quizSharedBankSlug ?? undefined}
          deckId={quizDeckId ?? undefined}
          onDone={onQuizDone}
        />
      )}

      {view === 'study' && studyScope && (
        <StudyView
          scope={studyScope.type}
          pdfId={studyScope.type === 'pdf' ? studyScope.id : undefined}
          deckId={studyScope.type === 'deck' ? studyScope.id : undefined}
          examDate={examDate}
          onDone={onStudyDone}
        />
      )}

      {view === 'stats' && (
        <StatsView pdfs={pdfs} examDate={examDate} />
      )}

      {view === 'question-stats' && (
        <QuestionStatsView pdfs={pdfs} userEmail={userEmail} />
      )}

      {view === 'allquestions' && (
        <AllQuestionsView pdfs={pdfs} />
      )}

      {view === 'settings' && (
        <SettingsView
          examDate={examDate}
          onExamDateChange={onExamDateChange}
          userId={userId ?? ''}
        />
      )}
    </main>
  );
}
