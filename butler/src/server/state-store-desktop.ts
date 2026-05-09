import type { DesktopSessionView } from "./types.js";

type DesktopSessionStoreAccess = {
  desktopSessions: Map<string, DesktopSessionView>;
  emitChange(): void;
};

export function upsertStateStoreDesktopSession(access: DesktopSessionStoreAccess, session: DesktopSessionView): void {
  const existing = access.desktopSessions.get(session.sessionId);
  access.desktopSessions.set(session.sessionId, { ...existing, ...session });
  access.emitChange();
}

export function removeStateStoreDesktopSession(access: DesktopSessionStoreAccess, sessionId: string): void {
  if (!access.desktopSessions.delete(sessionId)) {
    return;
  }
  access.emitChange();
}

export function replaceStateStoreDesktopSessions(access: DesktopSessionStoreAccess, sessions: DesktopSessionView[]): void {
  const next = new Map(sessions.map((session) => [session.sessionId, session]));
  const changed =
    next.size !== access.desktopSessions.size ||
    [...next.keys()].some((sessionId) => JSON.stringify(next.get(sessionId)) !== JSON.stringify(access.desktopSessions.get(sessionId)));
  if (!changed) {
    return;
  }
  access.desktopSessions.clear();
  for (const [sessionId, session] of next) {
    access.desktopSessions.set(sessionId, session);
  }
  access.emitChange();
}

export function listStateStoreDesktopSessions(access: DesktopSessionStoreAccess): DesktopSessionView[] {
  return [...access.desktopSessions.values()].sort((left, right) => right.lastActivityAt - left.lastActivityAt);
}
