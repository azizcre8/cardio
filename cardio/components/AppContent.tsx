'use client';

import AddView from '@/components/AddView';
import BankSelectView from '@/components/BankSelectView';
import BanksView from '@/components/BanksView';
import ConceptMapView from '@/components/ConceptMapView';
import ProcessingView, { type ActiveJob } from '@/components/ProcessingView';
import QuizView from '@/components/QuizView';
import SettingsView from '@/components/SettingsView';
import StatsView from '@/components/StatsView';
import type { Deck, Density, PDF } from '@/types';
import type { AppView } from '@/app/app/page';

interface Props {
  view: AppView;
  pdfs: PDF[];
  decks: Deck[];
  examDate: string | null;
  userId: string | null;
  activeJob: ActiveJob | null;
  isJobRunning: boolean;
  conceptMapPdfId: string | null;
  quizPdfId: string | null;
  onSetView: (view: AppView) => void;
  onStartProcessing: (file: File, density: Density, maxQuestions: number) => void;
  onOpenConceptMap: (pdfId: string) => void;
  onStartQuiz: (pdfId: string) => void;
  onQuizDone: () => void;
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
  activeJob,
  isJobRunning,
  conceptMapPdfId,
  quizPdfId,
  onSetView,
  onStartProcessing,
  onOpenConceptMap,
  onStartQuiz,
  onQuizDone,
  onPdfsChange,
  onDecksChange,
  onExamDateChange,
}: Props) {
  const conceptMapPdf = pdfs.find(p => p.id === conceptMapPdfId) ?? null;

  return (
    <main
      style={{
        flex: 1,
        padding: (view === 'processing' || view === 'library' || view === 'quiz') ? '0' : '24px 16px',
        overflow: 'auto',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {view === 'library' && (
        <BanksView
          pdfs={pdfs}
          decks={decks}
          onStartQuiz={onStartQuiz}
          onOpenConceptMap={onOpenConceptMap}
          onSetView={() => onSetView('add')}
          onPdfsChange={onPdfsChange}
        />
      )}

      {view === 'add' && (
        <AddView
          pdfs={pdfs}
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

      {view === 'stats' && (
        <StatsView pdfs={pdfs} examDate={examDate} />
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
