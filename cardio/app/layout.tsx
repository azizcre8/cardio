import type { Metadata } from 'next';
import { Inter, Source_Serif_4 } from 'next/font/google';
import { Analytics } from '@vercel/analytics/next';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const sourceSerif = Source_Serif_4({
  subsets: ['latin'],
  variable: '--font-serif',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Cardio',
  description: 'Shared question banks and private PDF-based study generation for medical exam prep.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${sourceSerif.variable}`}>
      <body
        className="antialiased"
        style={{
          margin: 0,
          background: 'var(--bg)',
          color: 'var(--text-primary)',
          fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
          WebkitFontSmoothing: 'antialiased',
          MozOsxFontSmoothing: 'grayscale',
        }}
      >
        {children}
        <Analytics />
      </body>
    </html>
  );
}
