'use client';

import { useEffect, useState } from 'react';
import type { PDF, Concept, Question, MasteryData } from '@/types';

interface Props {
  pdfs:     PDF[];
  examDate: string | null;
}

interface ConceptWithMastery {
  concept:  Concept;
  pdf:      PDF;
  mastery:  MasteryData;
}

function conceptMastery(concept: Concept, questions: Question[]): MasteryData {
  const byL: Record<number, Question[]> = { 1: [], 2: [], 3: [] };
  questions
    .filter(q => q.concept_id === concept.id)
    .forEach(q => {
      const l = Math.min(3, Math.max(1, q.level ?? 1));
      (byL[l] ??= []).push(q);
    });

  function score(qs: Question[]): number {
    const ans = qs.filter(q => (q.times_reviewed ?? 0) > 0);
    if (!ans.length) return 0;
    const tot = ans.reduce((s, q) => s + (q.times_correct ?? 0), 0);
    const att = ans.reduce((s, q) => s + (q.times_reviewed ?? 0), 0);
    return Math.min(100, Math.round((tot / att) * 100));
  }

  const l1 = score(byL[1] ?? []);
  const l2 = score(byL[2] ?? []);
  const l3 = score(byL[3] ?? []);
  const hasAny = Object.values(byL).some(qs => qs.some(q => (q.times_reviewed ?? 0) > 0));
  let overall = 0;
  if (hasAny) {
    const ws = [0.25, 0.40, 0.35];
    const cs = [byL[1]?.length ?? 0, byL[2]?.length ?? 0, byL[3]?.length ?? 0];
    const vs = [l1, l2, l3];
    let wsum = 0, wtot = 0;
    vs.forEach((v, i) => { if (cs[i]) { wsum += v * ws[i]!; wtot += ws[i]!; } });
    overall = wtot ? Math.round(wsum / wtot) : 0;
  }

  const status: MasteryData['status'] =
    !hasAny ? 'new' : overall < 40 ? 'weak' : overall < 70 ? 'medium' : overall < 90 ? 'strong' : 'mastered';

  return { conceptId: concept.id, l1, l2, l3, overall, status };
}

const STATUS_COLOR: Record<string, string> = {
  new: 'text-gray-500', weak: 'text-red-400', medium: 'text-yellow-400',
  strong: 'text-green-400', mastered: 'text-blue-400',
};

export default function StatsView({ pdfs, examDate }: Props) {
  const [data, setData] = useState<ConceptWithMastery[]>([]);

  useEffect(() => {
    if (!pdfs.length) {
      setData([]);
      return;
    }

    Promise.all(
      pdfs.map(async pdf => {
        const [conceptRes, questionRes] = await Promise.all([
          fetch(`/api/pdfs/${pdf.id}/concepts`),
          fetch(`/api/pdfs/${pdf.id}/questions`),
        ]);

        const conceptPayload = conceptRes.ok
          ? await conceptRes.json() as { concepts?: Concept[] }
          : { concepts: [] };
        const questionPayload = questionRes.ok
          ? await questionRes.json() as { questions?: Question[] }
          : { questions: [] };

        return (conceptPayload.concepts ?? []).map(c => ({
          concept: c,
          pdf,
          mastery: conceptMastery(c, questionPayload.questions ?? []),
        }));
      }),
    )
      .then(all => setData(all.flat()))
      .catch(() => setData([]));
  }, [pdfs]);

  const now = new Date();
  const daysLeft = examDate ? Math.ceil((new Date(examDate).getTime() - now.getTime()) / 86_400_000) : null;

  const counts = { new: 0, weak: 0, medium: 0, strong: 0, mastered: 0 };
  data.forEach(d => { counts[d.mastery.status]++; });
  const studied = data.filter(d => d.mastery.status !== 'new');
  const avg = studied.length
    ? Math.round(studied.reduce((s, d) => s + d.mastery.overall, 0) / studied.length)
    : 0;

  const priority = data
    .filter(d => d.mastery.status === 'weak' || d.mastery.status === 'medium')
    .sort((a, b) => a.mastery.overall - b.mastery.overall)
    .slice(0, 10);

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {daysLeft !== null && (
        <div className={`px-3 py-2 rounded text-sm ${daysLeft <= 3 ? 'bg-red-900 text-red-200' : 'bg-gray-800 text-gray-300'}`}>
          {daysLeft > 0 ? `${daysLeft} days until exam` : 'Exam day!'}
        </div>
      )}

      {/* Summary */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 text-center">
          <p className="text-2xl font-bold text-white">{data.length}</p>
          <p className="text-xs text-gray-500">Concepts</p>
        </div>
        <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 text-center">
          <p className="text-2xl font-bold text-white">{avg}%</p>
          <p className="text-xs text-gray-500">Avg Mastery</p>
        </div>
        <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 text-center">
          <p className="text-2xl font-bold text-white">{counts.mastered}</p>
          <p className="text-xs text-gray-500">Mastered</p>
        </div>
      </div>

      {/* Distribution */}
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-4">
        <p className="text-xs text-gray-500 mb-3 uppercase tracking-widest">Mastery Distribution</p>
        <div className="flex gap-2">
          {(['new', 'weak', 'medium', 'strong', 'mastered'] as const).map(s => (
            <div key={s} className="flex-1 text-center">
              <p className={`text-lg font-bold ${STATUS_COLOR[s]}`}>{counts[s]}</p>
              <p className="text-xs text-gray-600">{s}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Priority concepts */}
      {priority.length > 0 && (
        <div className="bg-gray-900 border border-gray-700 rounded-lg p-4">
          <p className="text-xs text-gray-500 mb-3 uppercase tracking-widest">Priority Concepts</p>
          <ul className="space-y-2">
            {priority.map(({ concept, pdf, mastery }) => (
              <li key={concept.id} className="flex items-center justify-between text-sm">
                <div>
                  <span className="text-gray-300">{concept.name}</span>
                  <span className="text-gray-600 text-xs ml-2">{pdf.name}</span>
                </div>
                <span className={`text-xs font-mono ${STATUS_COLOR[mastery.status]}`}>
                  {mastery.overall}% {mastery.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
