const LOCAL_ORIGIN = 'https://cardio.local';

export function normalizeJoinSlug(value: string | null | undefined) {
  const slug = value?.trim() ?? '';
  if (!slug || !/^[a-z0-9][a-z0-9-]{0,95}$/i.test(slug)) return null;
  return slug;
}

export function buildJoinedAppPath(slug: string) {
  const normalized = normalizeJoinSlug(slug);
  const params = new URLSearchParams();
  if (normalized) params.set('join', normalized);
  params.set('joined', '1');
  return `/app?${params.toString()}`;
}

export function buildSharedBankQuizPath(slug: string) {
  const normalized = normalizeJoinSlug(slug);
  const params = new URLSearchParams();
  params.set('view', 'quiz');
  if (normalized) params.set('sharedQuiz', normalized);
  return `/app?${params.toString()}`;
}

export function sanitizeAuthNextPath(value: string | null | undefined) {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/app';

  try {
    const url = new URL(value, LOCAL_ORIGIN);
    if (url.origin !== LOCAL_ORIGIN || url.pathname !== '/app') return '/app';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/app';
  }
}

export function getJoinSlugFromAuthNext(value: string | null | undefined) {
  const nextPath = sanitizeAuthNextPath(value);
  const url = new URL(nextPath, LOCAL_ORIGIN);
  return normalizeJoinSlug(
    url.searchParams.get('join')
    ?? url.searchParams.get('shared')
    ?? url.searchParams.get('sharedQuiz'),
  );
}

export function buildAuthCallbackUrl(origin: string, nextPath: string) {
  const normalizedOrigin = origin.replace(/\/+$/, '');
  const safeNext = sanitizeAuthNextPath(nextPath);
  return `${normalizedOrigin}/auth/callback?next=${encodeURIComponent(safeNext)}`;
}
