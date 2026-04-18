import {
  Coordinates,
  ReportFeed,
  RobotPacket,
  RouteResponseMode,
  SubmitReportInput,
  TrashReport,
} from '@/types/routing';

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL?.replace(/\/$/, '') ?? '';
let localReports: TrashReport[] = [];
let localLatestRobotLocation: Coordinates | null = null;
let localAssignedReportId: string | null = null;

type SubmitReportResponse = {
  report: TrashReport;
  mode: RouteResponseMode;
};

export function hasRemoteBackend() {
  return Boolean(API_BASE_URL);
}

export async function submitTrashReport(input: SubmitReportInput): Promise<SubmitReportResponse> {
  if (!hasRemoteBackend()) {
    const report = createLocalReport(input);
    localReports = [report, ...localReports];
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
    return localReports[0] ?? null;
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

export async function fetchReportFeed(): Promise<ReportFeed> {
  if (!hasRemoteBackend()) {
    return {
      activeAssignmentId: localAssignedReportId,
      reports: [...localReports],
    };
  }

  const response = await fetch(`${API_BASE_URL}/robot/queue`);
  if (!response.ok) {
    throw new Error(`Report feed fetch failed with ${response.status}`);
  }

  const payload = (await response.json()) as ReportFeed & {
    latestRobotHeartbeat?: unknown;
  };

  return {
    activeAssignmentId: payload.activeAssignmentId,
    reports: payload.reports ?? [],
  };
}

export async function sendRobotHeartbeat(location: Coordinates) {
  if (!hasRemoteBackend()) {
    localLatestRobotLocation = location;
    return buildLocalRobotPacket();
  }

  const response = await fetch(`${API_BASE_URL}/robot/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      location,
      sentAt: new Date().toISOString(),
    }),
  });

  if (!response.ok) {
    throw new Error(`Robot heartbeat failed with ${response.status}`);
  }

  const payload = (await response.json()) as { packet: RobotPacket };
  return payload.packet;
}

export async function fetchRobotPacket(): Promise<RobotPacket> {
  if (!hasRemoteBackend()) {
    return buildLocalRobotPacket();
  }

  const response = await fetch(`${API_BASE_URL}/robot/packet`);
  if (!response.ok) {
    throw new Error(`Robot packet fetch failed with ${response.status}`);
  }

  const payload = (await response.json()) as { packet: RobotPacket };
  return payload.packet;
}

export async function completeRobotTask(taskId: string): Promise<RobotPacket> {
  if (!hasRemoteBackend()) {
    const report = localReports.find((candidate) => candidate.id === taskId);
    if (report) {
      report.status = 'completed';
      localAssignedReportId = null;
    }

    return buildLocalRobotPacket();
  }

  const response = await fetch(`${API_BASE_URL}/robot/task/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      taskId,
      location: localLatestRobotLocation,
      sentAt: new Date().toISOString(),
    }),
  });

  if (!response.ok) {
    throw new Error(`Robot task completion failed with ${response.status}`);
  }

  const payload = (await response.json()) as { packet: RobotPacket };
  return payload.packet;
}

function createLocalReport(input: SubmitReportInput): TrashReport {
  return {
    id: `local-${Date.now()}`,
    createdAt: new Date().toISOString(),
    photoUri: input.photoUri,
    reporterLocation: input.reporterLocation,
    status: 'pending',
  };
}

function buildLocalRobotPacket(): RobotPacket {
  if (!localAssignedReportId && localLatestRobotLocation) {
    const nextReport = selectNearestPendingReport(localLatestRobotLocation, localReports);
    if (nextReport) {
      nextReport.status = 'assigned';
      localAssignedReportId = nextReport.id;
    }
  }

  const assignedReport = localReports.find((report) => report.id === localAssignedReportId) ?? null;
  const pendingIds = localReports.filter((report) => report.status === 'pending').map((report) => report.id);
  const assignedCount = localReports.filter((report) => report.status === 'assigned').length;
  const completedCount = localReports.filter((report) => report.status === 'completed').length;

  return {
    status: assignedReport ? 'assigned' : 'idle',
    current: localLatestRobotLocation,
    queue: {
      pendingCount: pendingIds.length,
    },
    task: assignedReport
      ? {
          id: assignedReport.id,
          createdAt: assignedReport.createdAt,
          destination: assignedReport.reporterLocation,
          navigation: null,
        }
      : null,
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

function selectNearestPendingReport(origin: Coordinates, reports: TrashReport[]) {
  return reports
    .filter((report) => report.status !== 'completed' && report.status !== 'assigned')
    .sort(
      (left, right) =>
        haversineDistance(origin, left.reporterLocation) - haversineDistance(origin, right.reporterLocation)
    )[0] ?? null;
}
