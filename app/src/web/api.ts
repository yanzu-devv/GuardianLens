import { useCallback, useEffect, useRef, useState } from 'react';
import type { Command, Snapshot } from '../shared/domain';

const fragment = new URLSearchParams(location.hash.slice(1));
const suppliedToken = fragment.get('token');
if (suppliedToken) {
  sessionStorage.setItem('guardianlens.token', suppliedToken);
  history.replaceState(null, '', `${location.pathname}${location.search}`);
}
const token = suppliedToken ?? sessionStorage.getItem('guardianlens.token') ?? '';

export function useGuardian() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<'owner' | 'phone' | 'none'>('none');
  const active = useRef(true);
  const apply = useCallback((next: Snapshot, failure?: string | null) => {
    if (!active.current) return;
    setSnapshot(current => !current || next.revision >= current.revision ? next : current);
    if (failure) setError(failure);
  }, []);
  const request = useCallback(async (route: string, init?: RequestInit) => {
    try {
      const response = await fetch(route, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers }, signal: AbortSignal.timeout(10_000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'The request failed.');
      if (result.snapshot) apply(result.snapshot, result.persistenceFailure);
      return result;
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : 'Connection failed.';
      if (active.current) setError(message);
      throw failure;
    }
  }, [apply]);
  const send = useCallback(async (command: Command) => { await request('/api/command', { method: 'POST', body: JSON.stringify(command) }); }, [request]);
  const pair = useCallback(async (): Promise<{ url: string; expiresAt: number }> => request('/api/pair', { method: 'POST' }), [request]);
  useEffect(() => {
    active.current = true;
    let stopped = false, socket: WebSocket | undefined, retry: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    const connect = async () => {
      try {
        const data = await request('/api/state');
        if (stopped) return;
        setRole(data.role);
        socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`, ['guardianlens', `auth.${token}`]);
        socket.onopen = () => { retries = 0; setConnected(true); };
        socket.onmessage = event => {
          try { const data = JSON.parse(event.data); if (data.type === 'snapshot') apply(data.snapshot, data.persistenceFailure); }
          catch { setError('Received an invalid state update. Refresh the private dashboard.'); }
        };
        socket.onerror = () => { setError('Connection to GuardianLens interrupted. Response delivery is not confirmed.'); };
        socket.onclose = () => { setConnected(false); if (!stopped) retry = setTimeout(connect, Math.min(1000 * 2 ** retries++, 15_000)); };
      } catch { if (!stopped) { setConnected(false); retry = setTimeout(connect, Math.min(1000 * 2 ** retries++, 15_000)); } }
    };
    void connect();
    return () => { active.current = false; stopped = true; clearTimeout(retry); socket?.close(); };
  }, [apply, request]);
  useEffect(() => window.guardianDesktop?.onInterruption(reason => { void send({ type: 'interrupt', reason }).catch(() => {}); }), [send]);
  return { snapshot, connected, error, send, pair, role, clearError: useCallback(() => setError(null), []) };
}
