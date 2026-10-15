import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { SOCKET_EVENT, SOCKET_JOIN, type AiJob, type SessionSnapshot } from '@classpulse/shared-types';
import { api, getToken, refreshAuth } from './api';
import { messageOf } from './components/ui';
export function useResource<T>(path: string) {
  const [data, setData] = useState<T | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const request = useRef(0);
  const reload = useCallback(async () => {
    const id = ++request.current; setLoading(true); setError('');
    try { const value = await api<T>(path); if (id === request.current) setData(value); }
    catch (e) { if (id === request.current) setError(messageOf(e)); }
    finally { if (id === request.current) setLoading(false); }
  }, [path]);
  useEffect(() => { void reload(); return () => { request.current++; }; }, [reload]);
  return { data, setData, loading, error, reload };
}
export function useSession(id: string) {
  const [data, updateData] = useState<SessionSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const generation = useRef(0);
  const setData = useCallback((snapshot: SessionSnapshot | null) => {
    if (snapshot && snapshot.id !== id) return;
    updateData(current => {
      if (snapshot && current?.id === snapshot.id && Date.parse(current.serverTime) > Date.parse(snapshot.serverTime)) return current;
      return snapshot;
    });
  }, [id]);
  const reload = useCallback(async () => {
    const currentGeneration = generation.current;
    try {
      const snapshot = await api<SessionSnapshot>(`/sessions/${id}`);
      if (currentGeneration === generation.current) { setData(snapshot); setError(''); }
    } catch (e) { if (currentGeneration === generation.current) setError(messageOf(e)); }
    finally { if (currentGeneration === generation.current) setLoading(false); }
  }, [id, setData]);
  useEffect(() => {
    let disposed = false;
    let recovering = false;
    generation.current++;
    updateData(null); setLoading(true); setError('');
    void reload();
    const socket = io({ auth: { token: getToken() }, transports: ['websocket', 'polling'] });
    const recoverAuthentication = async () => {
      if (disposed || recovering) return;
      recovering = true;
      try {
        const auth = await refreshAuth();
        if (disposed) return;
        if (auth) {
          socket.auth = { token: auth.accessToken };
          if (!socket.connected) socket.connect();
        } else window.dispatchEvent(new Event('auth:expired'));
      } finally { recovering = false; }
    };
    socket.on('connect', () => {
      if (disposed) return;
      setConnected(true); socket.emit(SOCKET_JOIN, { sessionId: id }); void reload();
    });
    socket.on('disconnect', (reason: string) => {
      if (disposed) return;
      setConnected(false);
      if (reason === 'io server disconnect') void recoverAuthentication();
    });
    socket.on('connect_error', (error: Error) => { if (!disposed) { setConnected(false); if (error.message === 'Unauthorized') void recoverAuthentication(); } });
    socket.on(SOCKET_EVENT, (snapshot: SessionSnapshot) => { if (!disposed) setData(snapshot); });
    const recover = () => { if (document.visibilityState === 'visible') void reload(); };
    document.addEventListener('visibilitychange', recover);
    const interval = window.setInterval(() => { if (!socket.connected && document.visibilityState === 'visible') void reload(); }, 5000);
    return () => { disposed = true; generation.current++; socket.disconnect(); window.clearInterval(interval); document.removeEventListener('visibilitychange', recover); };
  }, [id, reload, setData]);
  return { data: data?.id === id ? data : null, setData, loading, error, reload, connected };
}
/** Clock is rebased on every server snapshot, including after reload/reconnect. */
export function useServerCountdown(endsAt: string | null, serverTime: string) {
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    if (!endsAt) { setRemaining(null); return; }
    const serverRemaining = Date.parse(endsAt) - Date.parse(serverTime);
    const receivedAt = performance.now();
    const tick = () => setRemaining(Math.max(0, Math.ceil((serverRemaining - (performance.now() - receivedAt)) / 1000)));
    tick(); const timer = window.setInterval(tick, 200); return () => window.clearInterval(timer);
  }, [endsAt, serverTime]);
  return remaining;
}
/** Polls a background AI job until it succeeds or fails; `start` begins watching a newly created job. */
export function useAiJob<R>(initial: AiJob<R> | null = null, onDone?: (job: AiJob<R>) => void) {
  const [job, setJob] = useState<AiJob<R> | null>(initial);
  const [error, setError] = useState('');
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => { setJob(current => (current?.id === initial?.id && current?.status === initial?.status ? current : initial)); }, [initial?.id, initial?.status]);
  const active = job && (job.status === 'QUEUED' || job.status === 'RUNNING');
  useEffect(() => {
    if (!job || !active) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      api<AiJob<R>>(`/ai/jobs/${job.id}`).then(next => {
        if (cancelled) return;
        setJob(next); setError('');
        if (next.status === 'SUCCEEDED' || next.status === 'FAILED') done.current?.(next);
      }).catch(e => { if (!cancelled) setError(messageOf(e)); });
    }, 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [job?.id, active]);
  return { job, running: !!active, error, start: setJob };
}
