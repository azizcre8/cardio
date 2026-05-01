export const DEV_LOCAL_USER_EMAIL = 'local-dev-user@localhost';

export function isDevAuthBypassEnabled(): boolean {
  const nodeEnv = typeof process !== 'undefined' ? process.env?.NODE_ENV : undefined;
  const isLocalBrowser = typeof window !== 'undefined'
    && ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);

  return nodeEnv === 'development' || isLocalBrowser;
}
