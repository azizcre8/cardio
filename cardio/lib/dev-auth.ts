export const DEV_LOCAL_USER_EMAIL = 'local-dev-user@localhost';

export function isDevAuthBypassEnabled(): boolean {
  return process.env.NODE_ENV === 'development';
}
