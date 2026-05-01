const LOCAL_ORIGIN = 'https://cardio.local';

export function normalizeJoinSlug(value: string | null | undefined) {
  const slug = value?.trim() ?? '';
  if (!slug || !/^[a-z0-9][a-z0-9-]{0,95}$/i.test(slug)) return null;
  return slug;
}

export function normalizeSharedBankSlug(value: string | null | undefined) {
  const raw = value?.trim() ?? '';
  if (!raw) return null;

  const decoded = (() => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  })();

  const normalized = normalizeJoinSlug(decoded);
  if (normalized) return normalized;

  if (!/\s/.test(decoded)) return null;
  return normalizeJoinSlug(decoded.split(/\s+/, 1)[0]);
}

export function buildJoinedAppPath(slug: string) {
  const normalized = normalizeSharedBankSlug(slug);
  const params = new URLSearchParams();
  if (normalized) params.set('join', normalized);
  params.set('joined', '1');
  return `/app?${params.toString()}`;
}

export function buildSharedBankQuizPath(slug: string) {
  const normalized = normalizeSharedBankSlug(slug);
  const params = new URLSearchParams();
  params.set('view', 'quiz');
  if (normalized) params.set('sharedQuiz', normalized);
  return `/app?${params.toString()}`;
}

export function sanitizeAuthNextPath(value: string | null | undefined) {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/app';

  try {
    const url = new URL(value, LOCAL_ORIGIN);
    if (url.origin !== LOCAL_ORIGIN) return '/app';
    if (url.pathname !== '/app' && url.pathname !== '/reset-password' && !/^\/s\/[a-z0-9][a-z0-9-]{0,95}$/i.test(url.pathname)) return '/app';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/app';
  }
}

export function getJoinSlugFromAuthNext(value: string | null | undefined) {
  const nextPath = sanitizeAuthNextPath(value);
  const url = new URL(nextPath, LOCAL_ORIGIN);
  return normalizeSharedBankSlug(
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
