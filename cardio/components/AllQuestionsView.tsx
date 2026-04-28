'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { AllQuestionRow, PDF, QuestionLevel } from '@/types';
import { Eyebrow } from './ui';

export default function AllQuestionsView({ pdfs }: { pdfs: PDF[] }) {
  const [questions, setQuestions] = useState<AllQuestionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pdfId, setPdfId] = useState('all');
  const [level, setLevel] = useState<'all' | `${QuestionLevel}`>('all');
  const [flagged, setFlagged] = useState<'all' | 'flagged'>('all');

  useEffect(() => {
    fetch('/api/questions/all')
      .then(r => r.ok ? r.json() : { questions: [] })
      .then((data: { questions?: AllQuestionRow[] }) => setQuestions(data.questions ?? []))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => questions.filter(q => {
    if (pdfId !== 'all' && q.pdf_id !== pdfId) return false;
    if (level !== 'all' && String(q.level) !== level) return false;
    if (flagged === 'flagged' && !q.flagged) return false;
    return true;
  }), [flagged, level, pdfId, questions]);

  return (
    <div style={{ padding: '32px 40px 60px', maxWidth: 1100 }}>
      <Eyebrow>Questions</Eyebrow>
      <h1 style={{ fontFamily: 'var(--font-serif)', fontSize: 40, fontWeight: 400, margin: '4px 0 18px' }}>
        All questions
      </h1>

      <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
        <select value={pdfId} onChange={e => setPdfId(e.target.value)} style={controlStyle}>
          <option value="all">All sources</option>
          {pdfs.map(pdf => (
            <option key={pdf.id} value={pdf.id}>{pdf.display_name ?? pdf.name.replace(/\.pdf$/i, '')}</option>
          ))}
        </select>
        <select value={level} onChange={e => setLevel(e.target.value as 'all' | `${QuestionLevel}`)} style={controlStyle}>
          <option value="all">All levels</option>
          <option value="1">L1</option>
          <option value="2">L2</option>
          <option value="3">L3</option>
        </select>
        <select value={flagged} onChange={e => setFlagged(e.target.value as 'all' | 'flagged')} style={controlStyle}>
          <option value="all">All statuses</option>
          <option value="flagged">Flagged only</option>
        </select>
        <span style={{ marginLeft: 'auto', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: 12, alignSelf: 'center' }}>
          {filtered.length} rows
        </span>
      </div>

      {loading ? (
        <p style={{ color: 'var(--text-dim)' }}>Loading questions...</p>
      ) : filtered.length === 0 ? (
        <p style={{ color: 'var(--text-dim)' }}>No questions match these filters.</p>
      ) : (
        <div style={{ borderTop: '1px solid var(--border)' }}>
          {filtered.map(q => {
            const open = expanded === q.id;
            return (
              <div key={q.id} style={{ borderBottom: '1px solid var(--border)', padding: '14px 0' }}>
                <button
                  onClick={() => setExpanded(open ? null : q.id)}
                  style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                >
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 220px 70px 180px', gap: 16, alignItems: 'start' }}>
                    <span style={{ color: 'var(--text-primary)', lineHeight: 1.45 }}>{q.stem}</span>
                    <span style={{ color: 'var(--green)', fontSize: 13, lineHeight: 1.4 }}>{q.answer_text}</span>
                    <span style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>L{q.level}</span>
                    <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{q.pdf_name}</span>
                  </div>
                </button>
                {open && (
                  <div style={{ marginTop: 12, padding: 14, background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 'var(--r2)' }}>
                    <ol style={{ margin: '0 0 12px', paddingLeft: 20, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                      {q.options.map((option, index) => (
                        <li key={index} style={{ color: index === q.answer ? 'var(--green)' : 'var(--text-secondary)' }}>
                          {option}
                        </li>
                      ))}
                    </ol>
                    <p style={{ margin: 0, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{q.explanation}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const controlStyle: CSSProperties = {
  height: 34,
  borderRadius: 'var(--r2)',
  background: 'var(--bg-raised)',
  border: '1px solid var(--border)',
  color: 'var(--text-secondary)',
  padding: '0 10px',
  fontSize: 12,
};
