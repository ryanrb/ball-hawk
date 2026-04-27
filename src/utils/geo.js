const R = 6371000; // Earth radius in meters

export function haversineDistance(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function destinationPoint(lat, lng, bearingDeg, distanceMeters) {
  const δ = distanceMeters / R;
  const θ = bearingDeg * Math.PI / 180;
  const φ1 = lat * Math.PI / 180;
  const λ1 = lng * Math.PI / 180;
  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) +
    Math.cos(φ1) * Math.sin(δ) * Math.cos(θ)
  );
  const λ2 = λ1 + Math.atan2(
    Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
    Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
  );
  return { lat: φ2 * 180 / Math.PI, lng: λ2 * 180 / Math.PI };
}

// distance = (ball_diameter_m * focal_px) / bbox_px_diameter
export function ballDistanceMeters(focalPx, bboxPxDiameter) {
  const BALL_DIAMETER_M = 0.04267; // 1.68 inches
  return (BALL_DIAMETER_M * focalPx) / bboxPxDiameter;
}

// Approximate focal length in pixels from image width and optical zoom level.
// Assumes ~65° horizontal FOV at 1× (iPhone main camera). tan(32.5°) ≈ 0.637
export function focalLengthPx(imageWidth, zoom = 1) {
  return (imageWidth / (2 * 0.637)) * zoom;
}

// Build a GeoJSON Polygon approximating a circle of radiusMeters around [centerLng, centerLat]
export function circlePolygon(centerLng, centerLat, radiusMeters, steps = 64) {
  const latRad = centerLat * Math.PI / 180;
  const mPerLat = 111320;
  const mPerLng = 111320 * Math.cos(latRad);
  const coords = [];
  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * 2 * Math.PI;
    coords.push([
      centerLng + Math.cos(angle) * radiusMeters / mPerLng,
      centerLat + Math.sin(angle) * radiusMeters / mPerLat,
    ]);
  }
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [coords] },
    properties: {},
  };
}

export const SEARCH_RADIUS_M = 22.86; // 25 yards
