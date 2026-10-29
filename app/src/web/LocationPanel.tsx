import { useEffect, useState } from 'react';
import type { Command, IncidentLocation, LocationFix, Snapshot } from '../shared/domain';
import { LOCATION_STALE_MS } from '../shared/location';
import { useDeviceLocation } from './useDeviceLocation';
import './location.css';

interface Props {
  snapshot: Snapshot;
  send: (command: Command) => Promise<void>;
  connected: boolean;
  compact?: boolean;
}

function LocationIcon() {
  return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" /><circle cx="12" cy="10" r="2" /></svg>;
}

function elapsed(capturedAt: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - capturedAt) / 1000));
  return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`;
}

function FixReadout({ fix }: { fix: LocationFix }) {
  return <dl className="device-location-coordinates"><div><dt>Latitude</dt><dd>{fix.latitude.toFixed(6)}</dd></div><div><dt>Longitude</dt><dd>{fix.longitude.toFixed(6)}</dd></div><div><dt>Estimated accuracy</dt><dd>±{Math.max(1, Math.ceil(fix.accuracy)).toLocaleString()}<span> m</span></dd></div></dl>;
}

/** Mount once in the owner dashboard; never mount on phone/quick/check-in views. */
export function LocationPanel({ snapshot, send, connected, compact = false }: Props) {
  const location = useDeviceLocation(snapshot, send, connected);
  const [now, setNow] = useState(Date.now());
  const deviceMode = snapshot.config.locationMode === 'device';
  const fix = snapshot.location?.fix;
  const stale = Boolean(fix && now - fix.capturedAt > LOCATION_STALE_MS);
  const error = location.error ?? snapshot.location?.error ?? null;
  const status = !deviceMode ? 'Manual mode' : !connected ? 'Connection lost' : error ? 'Needs attention'
    : location.phase === 'starting' ? 'Finding location' : location.owned && fix && !stale ? 'Sharing device location'
    : snapshot.location?.tracking && fix && !stale ? 'Location shared by another window'
    : stale ? 'Location is stale' : location.automatic && location.permission !== 'granted' ? 'Location permission needed' : 'Location off';

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  return <section className={`card device-location-panel${compact ? ' device-location-compact' : ''}`} aria-label="Monitoring device location">
    <div className="device-location-heading"><div className="device-location-title"><span className="device-location-icon"><LocationIcon /></span><div><p className="eyebrow">LOCATION FOR YOUR RESPONSE PLAN</p><h2>Monitoring device location</h2></div></div><span className={`pill ${error || stale || !connected ? 'amber-pill' : location.owned && fix ? 'lime-pill' : ''}`}>{status}</span></div>
    {!deviceMode ? <div className="device-location-manual"><strong>Manual location mode</strong><p>{snapshot.config.address || 'Add the address in Response plan.'}</p><p className="small-text">Choose “Device location” in Response plan to share the monitoring device’s reported position. Location permission is requested only when you press “Use device location.”</p></div> : <>
      <p className="device-location-description">Current device location updates automatically after browser permission is granted, including when you reopen this dashboard. A fresh position is requested every 30 seconds while connected. The device may use GPS, Wi-Fi, or network information; accuracy is shown below.</p>
      {fix ? <div className={`device-location-fix${stale || error || !location.owned ? ' device-location-fix-warning' : ''}`}>
        <div className="device-location-fix-heading"><strong>{error || !location.owned ? 'Last reported position' : 'Device-reported position'}</strong><span>{elapsed(fix.capturedAt, now)}{stale ? ' · stale' : ''}</span></div>
        <FixReadout fix={fix} />
        <p className="device-location-timestamp">Reported <time dateTime={new Date(fix.capturedAt).toISOString()}>{new Date(fix.capturedAt).toLocaleString()}</time></p>
        {stale && <p className="device-location-warning">This position is older than two minutes and may no longer represent where the device is.</p>}
      </div> : <p className="device-location-empty">{location.phase === 'starting' ? 'Waiting for the device location provider…' : 'No device coordinates have been shared.'}</p>}
      {error && <p className="device-location-error" role="alert">{error}</p>}
      {!location.owned && snapshot.location?.tracking && <p className="small-text">Another dashboard may be sharing this device’s location. Only one window supplies updates at a time.</p>}
      {!location.owned && location.permission !== 'granted' && location.automatic && <p className="small-text">Choose Use device location and allow the browser request once. Future visits resume automatically while permission remains granted.</p>}
      <div className="device-location-disclosure"><span aria-hidden="true">↗</span><p>Enabling shares precise coordinates and estimated accuracy with your GuardianLens server. They are saved with incidents, shared on the protected response page, and read to opted-in contacts when real calls are enabled. Your browser or operating system’s location provider may process this request.</p></div>
      <div className="device-location-actions"><button type="button" className="button primary" disabled={!connected || location.busy || location.phase === 'watching' && !error} onClick={() => { void location.start(); }}><LocationIcon />{location.busy ? 'Starting…' : location.phase === 'watching' && !error ? 'Automatic updates on' : error || location.owned ? 'Retry location' : 'Use device location'}</button>{(location.owned || location.phase === 'starting') && <button type="button" className="button secondary" onClick={() => { void location.stop(); }}>Stop location</button>}</div>
      <p className="device-location-footnote">Stop location also turns off automatic resumption in this browser until you choose Use device location again. Past incident locations remain in their records. Camera consent is separate.</p>
    </>}
    <div className="device-location-camera-note"><strong>Your camera still needs a fixed view.</strong><p>If the device reports movement beyond its location uncertainty plus 50 m, monitoring pauses so you can check placement. Moving the laptop requires a stable view again; device location does not follow someone who leaves the camera’s view.</p></div>
  </section>;
}

/** The incident's frozen location, not the device's latest position. */
export function LocationSummary({ location, compact = false }: { location?: IncidentLocation; compact?: boolean }) {
  if (!location) return <div className="incident-location-summary"><strong>Incident location unavailable</strong><p>No location snapshot was recorded for this incident. Confirm the location directly.</p></div>;
  return <div className={`incident-location-summary${compact ? ' incident-location-compact' : ''}`}>
    <div className="device-location-title"><LocationIcon /><div><span className="eyebrow">LOCATION RECORDED AT DETECTION</span><strong>{location.label}</strong></div></div>
    {location.mode === 'manual' ? <p>{location.address || 'No manual address was recorded.'}</p> : location.fix ? <><FixReadout fix={location.fix} /><p className="device-location-timestamp">Reported <time dateTime={new Date(location.fix.capturedAt).toISOString()}>{new Date(location.fix.capturedAt).toLocaleString()}</time>{location.availability === 'stale' ? ' · already stale at detection' : ''}</p></> : <p>Device coordinates were unavailable at detection.</p>}
    <p className={location.availability === 'stale' || location.availability === 'unavailable' ? 'device-location-warning' : 'small-text'}>{location.note}</p>
    {!compact && <p className="device-location-footnote">This is the incident record. Later device-location updates do not change it.</p>}
  </div>;
}
