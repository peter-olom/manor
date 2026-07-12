export function normalizeBrowserSessionCookies(
  cookies: Record<string, string> | undefined,
  sessionCookie: string | undefined
): Array<{ name: string; value: string }> {
  const entries = Object.entries(cookies ?? {})
    .map(([name, value]) => [name.trim(), value.trim()] as const)
    .filter(([name, value]) => name.length > 0 && value.length > 0);
  const normalizedSessionCookie = sessionCookie?.trim() ?? "";
  if (normalizedSessionCookie) entries.push(["better-auth.session_token", normalizedSessionCookie]);
  return entries.map(([name, value]) => ({ name, value }));
}
