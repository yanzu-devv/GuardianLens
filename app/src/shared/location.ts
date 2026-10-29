import type { IncidentLocation, LocationFix, Snapshot } from './domain.js';

export const LOCATION_STALE_MS = 120_000;
export const DEVICE_MOVEMENT_THRESHOLD_METERS = 50;

/** Capture once at detection. Later device updates must not replace this record. */
export function locationForIncident(snapshot: Snapshot, now = Date.now()): IncidentLocation {
  const label = snapshot.config.room.trim() || 'My laptop';
  // Legacy plans remain manual; switching modes is an explicit user choice.
  if (snapshot.config.locationMode !== 'device') {
    return {
      mode: 'manual', label, address: snapshot.config.address.trim(), fix: null,
      availability: 'manual', note: 'User-configured location. Confirm that this is where the incident occurred.',
    };
  }
  const device = snapshot.location;
  if (!device?.tracking || !device.fix) {
    return {
      mode: 'device', label, address: '', fix: null, availability: 'unavailable',
      note: device?.error || 'Device location was unavailable when this incident was detected.',
    };
  }
  const stale = now - device.fix.capturedAt > LOCATION_STALE_MS;
  return {
    mode: 'device', label, address: '', fix: { ...device.fix },
    availability: stale ? 'stale' : 'current',
    note: (stale
      ? 'Last device location is older than two minutes. It may not be the current location.'
      : 'Device-reported coordinates with estimated accuracy. Confirm the location with the person requesting help.')
      + (device.error ? ` Location update issue: ${device.error}` : ''),
  };
}

/** Location readiness is informational; unavailable GPS must not block detection. */
export function locationReady(snapshot: Snapshot, now = Date.now()): boolean {
  if (snapshot.config.locationMode !== 'device') return Boolean(snapshot.config.address.trim());
  return Boolean(snapshot.location?.tracking && snapshot.location.fix && now - snapshot.location.fix.capturedAt <= LOCATION_STALE_MS);
}

/** Distance between reported device fixes, not evidence of patient movement. */
export function fixMovementMeters(previous: LocationFix, next: LocationFix): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const lat = radians(next.latitude - previous.latitude);
  const lon = radians(next.longitude - previous.longitude);
  const a = Math.sin(lat / 2) ** 2 + Math.cos(radians(previous.latitude)) * Math.cos(radians(next.latitude)) * Math.sin(lon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a)));
}

export function validLocationFix(value: unknown, now = Date.now()): value is LocationFix {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 4 || Object.keys(v).some(key => !['latitude', 'longitude', 'accuracy', 'capturedAt'].includes(key))) return false;
  return typeof v.latitude === 'number' && Number.isFinite(v.latitude) && Math.abs(v.latitude) <= 90
    && typeof v.longitude === 'number' && Number.isFinite(v.longitude) && Math.abs(v.longitude) <= 180
    && typeof v.accuracy === 'number' && Number.isFinite(v.accuracy) && v.accuracy > 0 && v.accuracy <= 10_000_000
    && typeof v.capturedAt === 'number' && Number.isFinite(v.capturedAt) && v.capturedAt >= 0 && v.capturedAt <= now + 10_000;
}
