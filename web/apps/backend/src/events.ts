import { Injectable, Logger } from '@nestjs/common';

/** Serialize broadcasts per session so an older snapshot cannot replace a newer one. */
@Injectable()
export class SessionEvents {
  private readonly logger = new Logger(SessionEvents.name);
  private readonly listeners = new Set<(sessionId: string) => Promise<void>>();
  private readonly pending = new Map<string, Promise<void>>();
  subscribe(listener: (sessionId: string) => Promise<void>) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  publish(sessionId: string) {
    const next = (this.pending.get(sessionId) ?? Promise.resolve()).then(async () => {
      await Promise.all([...this.listeners].map(async listener => {
        try { await listener(sessionId); } catch { this.logger.error(JSON.stringify({ event: 'session_broadcast_failed', sessionId })); }
      }));
    });
    this.pending.set(sessionId, next);
    void next.finally(() => { if (this.pending.get(sessionId) === next) this.pending.delete(sessionId); });
    return next;
  }
}
