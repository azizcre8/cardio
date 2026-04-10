'use client';

import { useRef, useState } from 'react';
import type { PDF, Density, ProcessEvent } from '@/types';
import ProcessingLog from './ProcessingLog';

interface Props {
  pdfs:           PDF[];
  examDate:       string | null;
  userId:         string;
  onStartStudy:   (pdfId: string) => void;
  onPdfsChange:   (pdfs: PDF[]) => void;
}

export default function LibraryView({ pdfs, examDate, userId, onStartStudy, onPdfsChange }: Props) {
  const [density,    setDensity]    = useState<Density>('standard');
  const [processing, setProcessing] = useState<string | null>(null); // pdfId being processed
  const [logs,       setLogs]       = useState<ProcessEvent[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const daysLeft = examDate
    ? Math.ceil((new Date(examDate).getTime() - Date.now()) / 86_400_000)
    : null;

  async function handleUpload(file: File) {
    setLogs([]);
    const form = new FormData();
    form.append('pdf',     file);
    form.append('density', density);

    const resp = await fetch('/api/process', { method: 'POST', body: form });

    if (!resp.ok) {
      const txt = await resp.text();
      setLogs([{ phase: 0, message: `Upload failed: ${txt}`, pct: 0 }]);
      return;
    }

    setProcessing('__uploading__');
    const reader = resp.body!.getReader();
    const dec    = new TextDecoder();
    let buf      = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.replace(/^data: /, '').trim();
        if (!trimmed) continue;
        try {
          const ev: ProcessEvent = JSON.parse(trimmed);
          setLogs(prev => [...prev, ev]);
          if (ev.phase === 7 && ev.data?.pdfId) {
            // Reload PDF list
            const res = await fetch('/api/pdfs');
            if (res.ok) onPdfsChange(await res.json() as PDF[]);
            setProcessing(null);
          }
        } catch { /* ignore malformed */ }
      }
    }
    setProcessing(null);
  }

  async function deletePdf(pdfId: string) {
    if (!confirm('Delete this PDF and all its questions?')) return;
    await fetch(`/api/pdfs/${pdfId}`, { method: 'DELETE' });
    onPdfsChange(pdfs.filter(p => p.id !== pdfId));
  }

  return (
    <div className="max-w-2xl mx-auto">
      {/* Exam countdown */}
      {daysLeft !== null && (
        <div className={`mb-4 px-3 py-2 rounded text-sm font-mono ${daysLeft <= 3 ? 'bg-red-900 text-red-200' : daysLeft <= 14 ? 'bg-yellow-900 text-yellow-200' : 'bg-gray-800 text-gray-300'}`}>
          {daysLeft > 0 ? `${daysLeft} days until exam` : 'Exam day!'}
        </div>
      )}

      {/* Upload panel */}
      <div className="border border-gray-700 rounded-lg p-4 mb-6">
        <div className="flex items-center gap-3 mb-3">
          <select
            value={density}
            onChange={e => setDensity(e.target.value as Density)}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm"
          >
            <option value="standard">Standard</option>
            <option value="comprehensive">Comprehensive</option>
            <option value="boards">Boards</option>
          </select>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={!!processing}
            className="bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-4 py-1.5 rounded text-sm font-medium"
          >
            {processing ? 'Processing…' : 'Upload PDF'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); }}
          />
        </div>
        {logs.length > 0 && <ProcessingLog events={logs} />}
      </div>

      {/* PDF list */}
      {pdfs.length === 0 ? (
        <p className="text-gray-500 text-center py-12">No PDFs yet — upload one to get started.</p>
      ) : (
        <ul className="space-y-3">
          {pdfs.map(pdf => (
            <li key={pdf.id} className="border border-gray-700 rounded-lg p-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-white">{pdf.name}</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {pdf.concept_count ?? 0} concepts · {pdf.question_count ?? 0} questions · {pdf.density}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {pdf.processed_at && (
                  <button
                    onClick={() => onStartStudy(pdf.id)}
                    className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-1 rounded text-xs"
                  >Study</button>
                )}
                <button
                  onClick={() => deletePdf(pdf.id)}
                  className="text-gray-600 hover:text-red-400 px-2 py-1 text-xs"
                >✕</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
