import { describe, expect, it } from 'vitest';
import {
  buildAuthCallbackUrl,
  buildJoinedAppPath,
  buildSharedBankQuizPath,
  getJoinSlugFromAuthNext,
  normalizeJoinSlug,
  normalizeSharedBankSlug,
  sanitizeAuthNextPath,
} from '@/lib/join-intent';

describe('join intent helpers', () => {
  it('builds an app redirect that carries the join slug through email confirmation', () => {
    expect(buildJoinedAppPath('preassigned-cardio')).toBe('/app?join=preassigned-cardio&joined=1');
    expect(buildSharedBankQuizPath('preassigned-cardio')).toBe('/app?view=quiz&sharedQuiz=preassigned-cardio');
    expect(
      buildAuthCallbackUrl('https://cardio.example/', '/app?join=preassigned-cardio&joined=1'),
    ).toBe('https://cardio.example/auth/callback?next=%2Fapp%3Fjoin%3Dpreassigned-cardio%26joined%3D1');
  });

  it('extracts a safe join slug from an app redirect', () => {
    expect(getJoinSlugFromAuthNext('/app?join=preassigned-cardio&joined=1')).toBe('preassigned-cardio');
    expect(getJoinSlugFromAuthNext('/app?shared=preassigned-cardio')).toBe('preassigned-cardio');
    expect(getJoinSlugFromAuthNext('/app?view=quiz&sharedQuiz=preassigned-cardio')).toBe('preassigned-cardio');
  });

  it('rejects unsafe redirect and slug inputs', () => {
    expect(sanitizeAuthNextPath('https://evil.example/app?join=preassigned-cardio')).toBe('/app');
    expect(sanitizeAuthNextPath('//evil.example/app?join=preassigned-cardio')).toBe('/app');
    expect(getJoinSlugFromAuthNext('/app?join=bad/slug')).toBeNull();
    expect(normalizeJoinSlug('bad slug')).toBeNull();
  });

  it('recovers the canonical slug from malformed shared links', () => {
    expect(normalizeSharedBankSlug('preassinged-readings Preassigned Readings: 917 questions from 12 sources on Cardio'))
      .toBe('preassinged-readings');
    expect(normalizeSharedBankSlug('preassinged-readings%20Preassigned%20Readings%3A%20917%20questions'))
      .toBe('preassinged-readings');
  });
});
