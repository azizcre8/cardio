'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { StudyQueueItem, QueueResponse } from '@/types';

interface Props {
  pdfId:    string;
  examDate: string | null;
  onDone:   () => void;
}

const QUALITY_LABELS: Record<number, { label: string; color: string }> = {
  1: { label: 'Wrong',  color: 'border-red-700 hover:border-red-500 text-red-400' },
  2: { label: 'Hard',   color: 'border-yellow-700 hover:border-yellow-500 text-yellow-400' },
  3: { label: 'Good',   color: 'border-green-700 hover:border-green-500 text-green-400' },
  4: { label: 'Easy',   color: 'border-blue-700 hover:border-blue-500 text-blue-400' },
};

export default function StudyView({ pdfId, examDate, onDone }: Props) {
  const [queue,      setQueue]      = useState<StudyQueueItem[]>([]);
  const [idx,        setIdx]        = useState(0);
  const [revealed,   setRevealed]   = useState(false);
  const [selected,   setSelected]   = useState<number | null>(null);
  const [rated,      setRated]      = useState<Record<string, boolean>>({});
  const [loading,    setLoading]    = useState(true);
  const [correct,    setCorrect]    = useState(0);
  const [total,      setTotal]      = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    fetch(`/api/study/queue?pdfId=${pdfId}`, { signal: ctrl.signal })
      .then(r => r.json() as Promise<QueueResponse>)
      .then(data => {
        setQueue(data.queue);
        setLoading(false);
      })
      .catch(() => setLoading(false));

    return () => ctrl.abort();
  }, [pdfId]);

  const current = queue[idx];

  function selectOption(optIdx: number) {
    if (revealed) return;
    setSelected(optIdx);
    setRevealed(true);
    setTotal(t => t + 1);
    if (current && optIdx === current.answer) setCorrect(c => c + 1);
  }

  async function rateQuality(quality: number) {
    if (!current || rated[current.id]) return;

    setRated(prev => ({ ...prev, [current.id]: true }));

    await fetch('/api/study/submit', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        questionId:    current.id,
        quality,
        pdfId,
        proxiedFromId: current._proxiedFromId ?? null,
      }),
    });

    // Advance after brief pause
    setTimeout(() => {
      setIdx(i => i + 1);
      setRevealed(false);
      setSelected(null);
    }, 500);
  }

  if (loading) {
    return <div className="text-center text-gray-400 py-20">Loading queue…</div>;
  }

  if (!queue.length) {
    return (
      <div className="text-center py-20">
        <p className="text-gray-400 mb-4">No questions due right now.</p>
        <button onClick={onDone} className="text-red-400 hover:underline text-sm">Back to Library</button>
      </div>
    );
  }

  if (idx >= queue.length) {
    return (
      <div className="max-w-lg mx-auto text-center py-16">
        <h2 className="text-xl font-bold text-white mb-2">Session complete</h2>
        <p className="text-gray-400 mb-6">{correct}/{total} correct ({total > 0 ? Math.round((correct / total) * 100) : 0}%)</p>
        <button onClick={onDone} className="bg-red-600 hover:bg-red-700 text-white px-6 py-2 rounded text-sm font-medium">
          Back to Library
        </button>
      </div>
    );
  }

  if (!current) return null;

  const isCorrect = selected === current.answer;
  const optionLetters = ['A', 'B', 'C', 'D', 'E'];

  return (
    <div className="max-w-2xl mx-auto">
      {/* Progress bar */}
      <div className="flex items-center gap-3 mb-4">
        <div className="flex-1 h-1 bg-gray-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-red-500 transition-all duration-300"
            style={{ width: `${(idx / queue.length) * 100}%` }}
          />
        </div>
        <span className="text-xs text-gray-500">{idx + 1}/{queue.length}</span>
        <button onClick={onDone} className="text-xs text-gray-600 hover:text-gray-400">✕</button>
      </div>

      {/* Level badge + bucket */}
      <div className="flex gap-2 mb-3">
        <span className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded">L{current.level}</span>
        <span className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded">{current._bucket}</span>
      </div>

      {/* Stem */}
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-5 mb-4">
        <p className="text-white leading-relaxed">{current.stem}</p>
      </div>

      {/* Options */}
      <div className="space-y-2 mb-4">
        {current.options.map((opt, i) => {
          const isSelected = selected === i;
          const isAnswer   = revealed && i === current.answer;
          let cls = 'border border-gray-700 rounded-lg px-4 py-3 text-left text-sm w-full transition-colors ';
          if (!revealed) {
            cls += 'hover:border-gray-500 text-gray-300 cursor-pointer';
          } else if (isAnswer) {
            cls += 'border-green-600 bg-green-900/20 text-green-300';
          } else if (isSelected && !isAnswer) {
            cls += 'border-red-600 bg-red-900/20 text-red-300';
          } else {
            cls += 'text-gray-600';
          }

          return (
            <button
              key={i}
              onClick={() => selectOption(i)}
              disabled={revealed}
              className={cls}
            >
              <span className="font-mono mr-2 text-gray-500">{optionLetters[i]})</span>
              {opt}
            </button>
          );
        })}
      </div>

      {/* Explanation + quality buttons */}
      {revealed && (
        <div className="mt-4">
          <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 mb-4">
            <p className={`text-xs font-bold mb-1 ${isCorrect ? 'text-green-400' : 'text-red-400'}`}>
              {isCorrect ? '✓ Correct' : '✗ Incorrect'}
            </p>
            <p className="text-sm text-gray-300 leading-relaxed">{current.explanation}</p>
            {current.source_quote && current.source_quote !== 'UNGROUNDED' && (
              <p className="text-xs text-gray-600 italic mt-2 border-l-2 border-gray-700 pl-2">
                "{current.source_quote}"
              </p>
            )}
          </div>

          {!rated[current.id] && (
            <div className="flex gap-2 justify-end">
              <p className="text-xs text-gray-500 self-center mr-2">How well did you know this?</p>
              {[1, 2, 3, 4].map(q => (
                <button
                  key={q}
                  onClick={() => rateQuality(q)}
                  className={`border rounded px-3 py-1.5 text-xs font-mono transition-colors ${QUALITY_LABELS[q]?.color}`}
                >
                  {q} · {QUALITY_LABELS[q]?.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
