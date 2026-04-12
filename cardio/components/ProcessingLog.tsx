'use client';

import type { ProcessEvent } from '@/types';

export default function ProcessingLog({ events }: { events: ProcessEvent[] }) {
  const latest = events[events.length - 1];
  const pct    = latest?.pct ?? 0;

  return (
    <div className="mt-3">
      {/* Progress bar */}
      <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden mb-2">
        <div
          className="h-full bg-red-500 transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Log lines — last 6 */}
      <div className="space-y-0.5 max-h-32 overflow-y-auto">
        {events.slice(-6).map((ev, i) => (
          <p key={i} className={`text-xs font-mono ${ev.phase === 0 ? 'text-red-400' : ev.phase === 7 ? 'text-green-400' : 'text-gray-400'}`}>
            {ev.message}
          </p>
        ))}
      </div>
    </div>
  );
}
