import { ImageResponse } from 'next/og';
import { getSharedBankPreviewData } from '@/lib/shared-bank-preview';

export const alt = 'Cardio shared question bank';
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = 'image/png';

function formatCount(count: number, singular: string, plural = `${singular}s`) {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

function clampTitle(title: string) {
  return title.length > 78 ? `${title.slice(0, 75).trim()}...` : title;
}

export default async function Image({ params }: { params: { slug: string } }) {
  const preview = await getSharedBankPreviewData(params.slug);
  const bankTitle = preview?.bank.title ?? 'Shared Question Bank';
  const questionCount = preview?.questionCount ?? 0;
  const sourceCount = preview?.sourceCount ?? 0;
  const memberCount = preview?.memberCount ?? 0;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          background: '#F4F1EA',
          color: '#15130F',
          padding: 64,
          fontFamily: 'Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
        }}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            border: '1px solid rgba(20,18,16,0.12)',
            borderRadius: 28,
            background: '#FFFFFF',
            padding: 54,
            boxShadow: '0 22px 70px rgba(20,18,16,0.10)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                color: '#0F6E78',
                fontSize: 24,
                fontWeight: 800,
                letterSpacing: '0.18em',
              }}
            >
              <div
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 999,
                  background: '#0F6E78',
                  boxShadow: '0 0 0 8px rgba(15,110,120,0.12)',
                }}
              />
              CARDIO
            </div>
            <div
              style={{
                color: '#8C8577',
                fontSize: 23,
                fontWeight: 650,
              }}
            >
              Shared Question Bank
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
            <div
              style={{
                color: '#4A443C',
                fontSize: 28,
                fontWeight: 650,
              }}
            >
              Study-ready practice questions
            </div>
            <div
              style={{
                fontFamily: 'Georgia, Times New Roman, serif',
                fontSize: 72,
                lineHeight: 1.04,
                letterSpacing: '-0.025em',
                maxWidth: 900,
              }}
            >
              {clampTitle(bankTitle)}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            <Metric label={formatCount(questionCount, 'question')} />
            {sourceCount > 0 && <Metric label={formatCount(sourceCount, 'source')} muted />}
            {memberCount > 0 && <Metric label={`${memberCount.toLocaleString()} studying`} muted />}
          </div>
        </div>
      </div>
    ),
    size,
  );
}

function Metric({ label, muted = false }: { label: string; muted?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        border: '1px solid rgba(20,18,16,0.10)',
        borderRadius: 12,
        background: muted ? '#F4F1EA' : 'rgba(15,110,120,0.10)',
        color: muted ? '#4A443C' : '#0F6E78',
        fontSize: 28,
        fontWeight: 720,
        padding: '16px 22px',
      }}
    >
      {label}
    </div>
  );
}
