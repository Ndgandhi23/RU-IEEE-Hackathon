import {
  Coordinates,
  RoutePlan,
  RouteRequestInput,
  RouteResponseMode,
  SubmitReportInput,
  TrashReport,
} from '@/types/routing';

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL?.replace(/\/$/, '') ?? '';
const walkingMetersPerSecond = 1.3;
let localLatestReport: TrashReport | null = null;

type SubmitReportResponse = {
  report: TrashReport;
  mode: RouteResponseMode;
};

type RoutePlanResponse = {
  route: RoutePlan;
  mode: RouteResponseMode;
};

export function hasRemoteBackend() {
  return Boolean(API_BASE_URL);
}

export async function submitTrashReport(input: SubmitReportInput): Promise<SubmitReportResponse> {
  if (!hasRemoteBackend()) {
    const report = createLocalReport(input);
    localLatestReport = report;
    return { report, mode: 'mock' };
  }

  const formData = new FormData();
  const file = {
    uri: input.photoUri,
    name: `trash-report-${Date.now()}.jpg`,
    type: 'image/jpeg',
  };

  formData.append('photo', file as never);
  formData.append(
    'metadata',
    JSON.stringify({
      note: input.note ?? '',
      reporterLocation: input.reporterLocation,
    })
  );

  const response = await fetch(`${API_BASE_URL}/reports`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Report upload failed with ${response.status}`);
  }

  const payload = (await response.json()) as { report: TrashReport };
  return { report: payload.report, mode: 'backend' };
}

export async function fetchLatestReport(): Promise<TrashReport | null> {
  if (!hasRemoteBackend()) {
    return localLatestReport;
  }

  const response = await fetch(`${API_BASE_URL}/reports/latest`);
  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Report fetch failed with ${response.status}`);
  }

  const payload = (await response.json()) as { report: TrashReport | null };
  return payload.report;
}

export async function sendRobotHeartbeat(location: Coordinates) {
  if (!hasRemoteBackend()) {
    return;
  }

  await fetch(`${API_BASE_URL}/robot/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      location,
      sentAt: new Date().toISOString(),
    }),
  });
}

export async function buildRoutePlan(input: RouteRequestInput): Promise<RoutePlanResponse> {
  if (!hasRemoteBackend()) {
    return {
      route: buildMockRoute(input.origin, input.destination),
      mode: 'mock',
    };
  }

  const response = await fetch(`${API_BASE_URL}/routes/apple`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      origin: input.origin,
      destination: input.destination,
      travelMode: 'walking',
    }),
  });

  if (!response.ok) {
    throw new Error(`Route request failed with ${response.status}`);
  }

  const payload = (await response.json()) as { route: RoutePlan };
  return { route: payload.route, mode: 'backend' };
}

function createLocalReport(input: SubmitReportInput): TrashReport {
  return {
    id: `local-${Date.now()}`,
    createdAt: new Date().toISOString(),
    note: input.note?.trim() || undefined,
    photoUri: input.photoUri,
    reporterLocation: input.reporterLocation,
  };
}

function buildMockRoute(origin: Coordinates, destination: Coordinates): RoutePlan {
  const distanceMeters = haversineDistance(origin, destination);
  const durationSeconds = Math.max(Math.round(distanceMeters / walkingMetersPerSecond), 30);

  return {
    provider: 'mock',
    travelMode: 'walking',
    source: origin,
    destination,
    distanceMeters,
    durationSeconds,
    steps: [
      {
        instruction: 'Leave the robot staging point and align with the destination marker.',
        distanceMeters: Math.round(distanceMeters * 0.35),
        durationSeconds: Math.round(durationSeconds * 0.3),
      },
      {
        instruction: 'Continue on the most direct safe campus walkway toward the reported trash.',
        distanceMeters: Math.round(distanceMeters * 0.5),
        durationSeconds: Math.round(durationSeconds * 0.55),
      },
      {
        instruction: 'Slow down near the target and confirm the trash photo before pickup.',
        distanceMeters: Math.round(distanceMeters * 0.15),
        durationSeconds: Math.round(durationSeconds * 0.15),
      },
    ],
  };
}

function haversineDistance(origin: Coordinates, destination: Coordinates) {
  const earthRadiusMeters = 6_371_000;
  const lat1 = degreesToRadians(origin.latitude);
  const lat2 = degreesToRadians(destination.latitude);
  const deltaLat = degreesToRadians(destination.latitude - origin.latitude);
  const deltaLon = degreesToRadians(destination.longitude - origin.longitude);

  const haversine =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1) *
      Math.cos(lat2) *
      Math.sin(deltaLon / 2) *
      Math.sin(deltaLon / 2);

  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function degreesToRadians(value: number) {
  return (value * Math.PI) / 180;
}
