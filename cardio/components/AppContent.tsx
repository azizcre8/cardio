'use client';

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
import type { Deck, Density, PDF } from '@/types';
import type { AppView } from '@/app/app/page';

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
  studyPdfId: string | null;
  onSetView: (view: AppView) => void;
  onStartProcessing: (file: File, density: Density, maxQuestions: number) => void;
  onOpenConceptMap: (pdfId: string) => void;
  onStartQuiz: (pdfId: string) => void;
  onQuizDone: () => void;
  onStartStudy: (pdfId: string) => void;
  onStudyDone: () => void;
  onPdfsChange: (pdfs: PDF[]) => void;
  onDecksChange: (decks: Deck[]) => void;
  onExamDateChange: (date: string | null) => void;
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
  studyPdfId,
  onSetView,
  onStartProcessing,
  onOpenConceptMap,
  onStartQuiz,
  onQuizDone,
  onStartStudy,
  onStudyDone,
  onPdfsChange,
  onDecksChange,
  onExamDateChange,
}: Props) {
  const conceptMapPdf = pdfs.find(p => p.id === conceptMapPdfId) ?? null;

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
        />
      )}

      {view === 'add' && (
        <AddView
          pdfs={pdfs}
          userEmail={userEmail}
          userPlan={userPlan}
          isJobRunning={isJobRunning}
          onStartProcessing={onStartProcessing}
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
          userEmail={userEmail}
          userPlan={userPlan}
          isJobRunning={false}
          onStartProcessing={onStartProcessing}
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

      {view === 'quiz' && quizPdfId && (
        <QuizView pdfId={quizPdfId} onDone={onQuizDone} />
      )}

      {view === 'study' && studyPdfId && (
        <StudyView pdfId={studyPdfId} examDate={examDate} onDone={onStudyDone} />
      )}

      {view === 'stats' && (
        <StatsView pdfs={pdfs} examDate={examDate} />
      )}

      {view === 'question-stats' && (
        <QuestionStatsView pdfs={pdfs} />
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
