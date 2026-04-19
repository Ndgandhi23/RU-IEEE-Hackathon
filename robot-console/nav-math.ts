// Pure geo/nav helpers used by the robot navigator.
//
// All functions operate on lat/lon in degrees and return SI units
// (meters, degrees). They have no side effects, no imports, and are
// safe to exercise in node or a browser. Keep this file tiny.

export type LatLon = {
  latitude: number;
  longitude: number;
};

const EARTH_RADIUS_M = 6_371_000;

/**
 * Great-circle distance between two points, in meters.
 */
export function haversineMeters(a: LatLon, b: LatLon): number {
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);

  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Initial bearing from `from` to `to` in degrees (0..360, 0 = North, 90 = East).
 */
export function bearingDegrees(from: LatLon, to: LatLon): number {
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);
  const dLon = toRadians(to.longitude - from.longitude);

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const deg = toDegrees(Math.atan2(y, x));
  return (deg + 360) % 360;
}

/**
 * Signed heading error in degrees, wrapped to (-180, 180].
 * Positive => target is clockwise of current heading (turn right).
 * Negative => target is counter-clockwise (turn left).
 */
export function headingErrorDegrees(currentHeadingDeg: number, targetBearingDeg: number): number {
  let err = targetBearingDeg - currentHeadingDeg;
  while (err > 180) err -= 360;
  while (err <= -180) err += 360;
  return err;
}

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toDegrees(rad: number): number {
  return (rad * 180) / Math.PI;
}
