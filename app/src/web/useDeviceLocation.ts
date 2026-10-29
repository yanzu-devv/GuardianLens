import { useEffect, useRef, useState } from 'react';
import type { Command, LocationFix, Snapshot } from '../shared/domain';
import { validLocationFix } from '../shared/location';

type Phase = 'off' | 'starting' | 'watching' | 'error';
type Send = (command: Command) => Promise<void>;
const AUTO_LOCATION_KEY = 'guardianlens-auto-location';
const readAutomatic = () => { try { return localStorage.getItem(AUTO_LOCATION_KEY) !== 'off'; } catch { return true; } };
const optedIntoAutomatic = () => { try { return localStorage.getItem(AUTO_LOCATION_KEY) === 'on'; } catch { return false; } };

const providerError = (code: number) => ({
  1: 'Location permission was denied. Allow location for this app in browser and system settings, then retry.',
  2: 'The device location provider is unavailable. Check system Location Services, then retry.',
  3: 'The device location request timed out. The last reported position may be out of date; retry when ready.',
}[code] ?? 'The device could not report its location. Retry or choose a manual location in Response plan.');

/** One same-origin producer. Automatic resumption requires an existing browser grant. */
export function useDeviceLocation(snapshot: Snapshot, send: Send, connected: boolean) {
  const [phase, setPhase] = useState<Phase>('off');
  const [owned, setOwned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [automatic, setAutomatic] = useState(readAutomatic);
  const [permission, setPermission] = useState<PermissionState | 'unknown'>('unknown');
  const mounted = useRef(true);
  const generation = useRef(0);
  const watch = useRef<number | null>(null);
  const refresh = useRef<ReturnType<typeof setInterval> | null>(null);
  const owns = useRef(false);
  const releasing = useRef(false);
  const starting = useRef(false);
  const confirmedTracking = useRef(false);
  const automaticAttempted = useRef(false);
  const releaseLock = useRef<(() => void) | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const snapshotRef = useRef(snapshot);
  const sendRef = useRef(send);
  const connectedRef = useRef(connected);
  snapshotRef.current = snapshot;
  sendRef.current = send;
  connectedRef.current = connected;

  function clearWatch() {
    if (watch.current !== null) navigator.geolocation?.clearWatch(watch.current);
    watch.current = null;
    if (refresh.current !== null) clearInterval(refresh.current);
    refresh.current = null;
  }

  function rememberAutomatic(enabled: boolean) {
    setAutomatic(enabled);
    try { localStorage.setItem(AUTO_LOCATION_KEY, enabled ? 'on' : 'off'); } catch { /* Memory preference still applies in this window. */ }
  }

  function enqueue(command: Command, ownGeneration: number, final = false): Promise<boolean> {
    const operation = queue.current.catch(() => {}).then(async () => {
      if (!final && (!mounted.current || generation.current !== ownGeneration || !owns.current)) return false;
      await sendRef.current(command);
      return true;
    });
    queue.current = operation.catch(() => {});
    return operation;
  }

  function unlock() {
    releaseLock.current?.();
    releaseLock.current = null;
  }

  async function acquireLock(ownGeneration: number): Promise<boolean> {
    return new Promise(resolve => {
      void navigator.locks.request('guardianlens-device-location', { ifAvailable: true }, async lock => {
        if (!lock || !mounted.current || generation.current !== ownGeneration) { resolve(false); return; }
        const hold = new Promise<void>(release => { releaseLock.current = release; });
        resolve(true);
        await hold;
      }).catch(() => resolve(false));
    });
  }

  async function stop(manual = true) {
    if (manual) rememberAutomatic(false);
    if (releasing.current) return;
    releasing.current = true;
    generation.current++;
    clearWatch();
    const wasOwner = owns.current;
    owns.current = false;
    starting.current = false;
    confirmedTracking.current = false;
    if (mounted.current) { setOwned(false); setBusy(true); setPhase('off'); setError(null); }
    try {
      // Hold the lease until prior fixes and the stop command have been ordered.
      // Other mounted dashboards must not stop a watch they never owned.
      if (wasOwner) await enqueue({ type: 'location_tracking', enabled: false }, generation.current, true);
    } catch {
      if (mounted.current) setError('Location capture stopped on this device, but the server did not confirm the stop. Check the connection.');
    } finally {
      unlock();
      releasing.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function failUpdate(message: string, ownGeneration: number) {
    if (!mounted.current || generation.current !== ownGeneration || !owns.current) return;
    setError(message);
    setPhase('error');
    void enqueue({ type: 'location_error', message }, ownGeneration).catch(() => {
      if (mounted.current && generation.current === ownGeneration) {
        generation.current++;
        clearWatch();
        setError('Location updates could not reach GuardianLens. Capture has stopped; reconnect and retry.');
      }
    });
  }

  async function start(manual = true) {
    if (starting.current || releasing.current || !connectedRef.current || snapshotRef.current.config.locationMode !== 'device') return;
    if (manual) rememberAutomatic(true);
    setError(null);
    if (!window.isSecureContext || !navigator.geolocation) {
      setError('Device location requires a supported browser on HTTPS or localhost. You can use a manual address in Response plan.');
      setPhase('error');
      return;
    }
    if (!navigator.locks) {
      setError('This browser cannot safely coordinate device location between dashboard windows. Use a current browser or a manual address.');
      setPhase('error');
      return;
    }

    starting.current = true;
    setBusy(true);
    setPhase('starting');
    const ownGeneration = ++generation.current;
    clearWatch();
    try {
      if (!owns.current) {
        const acquired = await acquireLock(ownGeneration);
        if (generation.current !== ownGeneration || !mounted.current) return;
        if (!acquired) {
          if (!manual) { setPhase('off'); return; }
          throw new Error('Device location is already in use by another dashboard window. Stop it there before enabling it here.');
        }
        owns.current = true;
        setOwned(true);
      }
      const accepted = await enqueue({ type: 'location_tracking', enabled: true }, ownGeneration);
      if (!accepted || !mounted.current || generation.current !== ownGeneration) return;
      if (snapshotRef.current.config.locationMode !== 'device') { await stop(false); return; }

      const onPosition = (position: GeolocationPosition) => {
        if (!mounted.current || generation.current !== ownGeneration || !owns.current) return;
        const fix: LocationFix = {
          latitude: position.coords.latitude, longitude: position.coords.longitude,
          accuracy: position.coords.accuracy, capturedAt: position.timestamp,
        };
        if (!validLocationFix(fix)) { failUpdate('The device returned an invalid location. Retry or use a manual address.', ownGeneration); return; }
        void enqueue({ type: 'location_fix', fix }, ownGeneration).then(applied => {
          if (!applied || !mounted.current || generation.current !== ownGeneration) return;
          setPhase('watching');
          setError(null);
        }).catch(() => {
          if (!mounted.current || generation.current !== ownGeneration) return;
          generation.current++;
          clearWatch();
          setPhase('error');
          setError('Location updates could not reach GuardianLens. Capture has stopped; reconnect and retry.');
        });
      };
      const onFailure = (failure: GeolocationPositionError) => {
        if (generation.current !== ownGeneration || !owns.current) return;
        if (failure.code === 1) clearWatch();
        failUpdate(providerError(failure.code), ownGeneration);
      };
      const options = { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 };
      watch.current = navigator.geolocation.watchPosition(onPosition, onFailure, options);
      // A stationary device may not produce watch events. Request a fresh fix
      // periodically so that an old coordinate is not presented as current.
      refresh.current = setInterval(() => {
        if (mounted.current && owns.current && generation.current === ownGeneration && connectedRef.current) {
          navigator.geolocation.getCurrentPosition(onPosition, onFailure, options);
        }
      }, 30_000);
    } catch (failure) {
      if (!mounted.current || generation.current !== ownGeneration) return;
      clearWatch();
      setPhase('error');
      setError(failure instanceof Error ? failure.message : 'Device location could not start. Try a manual address.');
      if (!owns.current) unlock();
    } finally {
      if (generation.current === ownGeneration) {
        starting.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  }

  useEffect(() => {
    if (snapshot.config.locationMode !== 'device' && (owns.current || starting.current)) void stop(false);
  }, [snapshot.config.locationMode]);

  useEffect(() => {
    if (!owns.current) return;
    if (snapshot.location?.tracking) confirmedTracking.current = true;
    else if (confirmedTracking.current && !starting.current) void stop(false);
  }, [snapshot.location?.tracking]);

  useEffect(() => {
    let cancelled = false;
    let status: PermissionStatus | undefined;
    const update = () => { if (!cancelled && status) setPermission(status.state); };
    if (navigator.permissions?.query) {
      void navigator.permissions.query({ name: 'geolocation' }).then(value => {
        if (cancelled) return;
        status = value;
        update();
        status.addEventListener('change', update);
      }).catch(() => { if (!cancelled) setPermission('prompt'); });
    } else setPermission('prompt');
    return () => { cancelled = true; status?.removeEventListener('change', update); };
  }, []);

  useEffect(() => {
    const permittedToRequest = permission === 'granted' || permission === 'prompt' && optedIntoAutomatic();
    if (!automatic || !permittedToRequest || !connected || snapshot.config.locationMode !== 'device') {
      automaticAttempted.current = false;
      return;
    }
    if (watch.current !== null || starting.current || releasing.current || automaticAttempted.current) return;
    automaticAttempted.current = true;
    void start(false);
  }, [automatic, permission, connected, snapshot.config.locationMode, busy]);

  useEffect(() => {
    const onPreference = (event: StorageEvent) => {
      if (event.key !== AUTO_LOCATION_KEY) return;
      const enabled = readAutomatic();
      setAutomatic(enabled);
      if (!enabled && (owns.current || starting.current)) void stop(false);
    };
    window.addEventListener('storage', onPreference);
    return () => window.removeEventListener('storage', onPreference);
  }, []);

  useEffect(() => {
    if (connected || !owns.current) return;
    generation.current++;
    clearWatch();
    starting.current = false;
    setBusy(false);
    setPhase('error');
    setError('The server connection was lost. Location capture stopped; reconnect and retry.');
  }, [connected]);

  useEffect(() => {
    mounted.current = true;
    const onLeaving = () => { if (owns.current || starting.current) void stop(false); };
    window.addEventListener('pagehide', onLeaving);
    return () => {
      mounted.current = false;
      window.removeEventListener('pagehide', onLeaving);
      if (owns.current || starting.current) void stop(false);
    };
  }, []);

  return { phase, owned, busy, error, automatic, permission, start, stop };
}
