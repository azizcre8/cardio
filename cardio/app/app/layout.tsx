import type { ReactNode } from 'react';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 font-mono">
      {children}
    </div>
  );
}
