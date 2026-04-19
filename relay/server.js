const cors = require('cors');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const multer = require('multer');
const path = require('path');

loadEnvFiles([path.join(__dirname, '.env'), path.join(__dirname, '.env.local')]);

const PORT = Number(process.env.PORT || 4000);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '') || '';
const APPLE_MAPS_DIRECTIONS_URL =
  process.env.APPLE_MAPS_DIRECTIONS_URL || 'https://maps-api.apple.com/v1/directions';
const APPLE_MAPS_TOKEN_URL = process.env.APPLE_MAPS_TOKEN_URL || 'https://maps-api.apple.com/v1/token';
const APPLE_MAPS_TRANSPORT_TYPE = (process.env.APPLE_MAPS_TRANSPORT_TYPE || 'WALKING').toUpperCase();
const APPLE_MAPS_ROUTE_CACHE_TTL_MS = Number(process.env.APPLE_MAPS_ROUTE_CACHE_TTL_MS || 15_000);
const APPLE_MAPS_ROUTE_CACHE_DISTANCE_METERS = Number(
  process.env.APPLE_MAPS_ROUTE_CACHE_DISTANCE_METERS || 5
);
const UPLOADS_DIR = path.join(__dirname, 'uploads');

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, callback) => {
      callback(null, UPLOADS_DIR);
    },
    filename: (_request, file, callback) => {
      const originalExtension = path.extname(file.originalname || '').toLowerCase();
      const extension = originalExtension || '.jpg';
      const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1_000_000_000)}${extension}`;
      callback(null, uniqueName);
    },
  }),
});

const reports = [];
const routeCache = new Map();
let mapsAccessTokenCache = null;
let latestRobotHeartbeat = null;
let activeAssignmentId = null;

app.get('/health', async (request, response) => {
  const includeAppleRouteProbe = parseBooleanQuery(request.query.appleRouteProbe);
  const appleMapsHealth = await probeAppleMapsHealth({ includeAppleRouteProbe });

  response.json({
    ok: true,
    service: 'campus-cleanup-relay',
    appleMapsConfigured: hasAppleMapsAuth(),
    appleMapsAuthMode: getAppleMapsAuthMode(),
    activeAssignmentId,
    reportCount: reports.length,
    appleMapsHealth,
  });
});

app.post('/reports', upload.single('photo'), (request, response) => {
  try {
    if (!request.file) {
      response.status(400).json({ error: 'photo is required' });
      return;
    }

    const metadata = parseMetadata(request.body?.metadata);
    const reporterLocation = normalizeCoordinates(metadata?.reporterLocation);
    if (!reporterLocation) {
      response.status(400).json({ error: 'metadata.reporterLocation is required' });
      return;
    }

    const report = {
      id: createReportId(),
      createdAt: new Date().toISOString(),
      photoFilename: request.file.filename,
      reporterLocation,
      status: 'pending',
    };

    reports.unshift(report);
    maybeAssignNextTask();

    response.status(201).json({
      report: serializeReport(report, request),
    });
  } catch (error) {
    console.error('[reports] create failed', error);
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Could not create report',
    });
  }
});

app.get('/reports/latest', (request, response) => {
  const latest = reports[0];
  if (!latest) {
    response.status(404).json({ report: null });
    return;
  }

  response.json({
    report: serializeReport(latest, request),
  });
});

app.get('/robot/queue', (request, response) => {
  response.json({
    activeAssignmentId,
    latestRobotHeartbeat,
    reports: reports.map((report) => serializeReport(report, request)),
  });
});

app.post('/robot/heartbeat', async (request, response) => {
  try {
    const location = normalizeCoordinates(request.body?.location);
    if (!location) {
      response.status(400).json({ error: 'location is required' });
      return;
    }

    latestRobotHeartbeat = {
      location,
      sentAt: typeof request.body?.sentAt === 'string' ? request.body.sentAt : new Date().toISOString(),
    };

    maybeAssignNextTask();
    const packet = await buildRobotPacket(request);

    response.json({ packet });
  } catch (error) {
    console.error('[robot/heartbeat] failed', error);
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Could not store robot heartbeat',
    });
  }
});

app.get('/robot/packet', async (request, response) => {
  try {
    const packet = await buildRobotPacket(request);
    response.json({ packet });
  } catch (error) {
    console.error('[robot/packet] failed', error);
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Could not build robot packet',
    });
  }
});

app.post('/robot/task/complete', async (request, response) => {
  try {
    const taskId = typeof request.body?.taskId === 'string' ? request.body.taskId : null;
    if (!taskId) {
      response.status(400).json({ error: 'taskId is required' });
      return;
    }

    const location = normalizeCoordinates(request.body?.location);
    if (location) {
      latestRobotHeartbeat = {
        location,
        sentAt:
          typeof request.body?.sentAt === 'string' ? request.body.sentAt : new Date().toISOString(),
      };
    }

    const report = reports.find((candidate) => candidate.id === taskId);
    if (!report) {
      response.status(404).json({ error: 'task not found' });
      return;
    }

    report.status = 'completed';
    routeCache.delete(taskId);
    if (activeAssignmentId === taskId) {
      activeAssignmentId = null;
    }

    maybeAssignNextTask();

    const packet = await buildRobotPacket(request);
    response.json({ packet });
  } catch (error) {
    console.error('[robot/task/complete] failed', error);
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Could not complete robot task',
    });
  }
});

app.post('/routes/apple', async (request, response) => {
  await handleAppleRouteRequest(request, response, 'apple');
});

app.post('/routes/controller', async (request, response) => {
  await handleAppleRouteRequest(request, response, 'controller');
});

app.listen(PORT, () => {
  console.log(`Campus cleanup relay listening on http://0.0.0.0:${PORT}`);
});

async function handleAppleRouteRequest(request, response, label) {
  try {
    if (!hasAppleMapsAuth()) {
      response.status(503).json({
        error:
          'Apple Maps auth is not configured. Set APPLE_MAPS_SERVER_TOKEN or the Apple Developer key variables in relay/.env.',
      });
      return;
    }

    const origin = normalizeCoordinates(request.body?.origin);
    const destination = normalizeCoordinates(request.body?.destination);
    const transportType = normalizeTransportType(request.body?.transportType);

    if (!origin || !destination) {
      response.status(400).json({ error: 'origin and destination are required' });
      return;
    }

    console.log(`[routes/${label}] request ${JSON.stringify({ origin, destination, transportType }, null, 2)}`);

    const appleRouteRaw = await fetchAppleDirections({
      origin,
      destination,
      transportType,
      forceRefresh: true,
      cacheKey: `adhoc:${label}`,
    });

    console.log(
      `[routes/${label}] raw apple response ${JSON.stringify(appleRouteRaw, null, 2)}`
    );

    response.json({
      route: {
        origin: cloneCoordinates(origin),
        destination: cloneCoordinates(destination),
        navigation: summarizeAppleWalkingRoute(appleRouteRaw, normalizedTransportType),
      },
    });
  } catch (error) {
    console.error(`[routes/${label}] failed`, error);
    const statusCode = typeof error?.statusCode === 'number' ? error.statusCode : 500;
    response.status(statusCode).json({
      error: error instanceof Error ? error.message : 'Apple Maps route fetch failed',
      details: error?.details ?? null,
    });
  }
}

async function buildRobotPacket(request) {
  maybeAssignNextTask();

  const assignedReport = getActiveAssignedReport();
  const currentLocation = latestRobotHeartbeat?.location || null;

  if (!assignedReport) {
    console.log(
      `[robot/packet] no active assignment; current=${JSON.stringify(currentLocation, null, 2)} pending=${reports.filter((report) => report.status === 'pending').length}`
    );
  } else if (!currentLocation) {
    console.log(
      `[robot/packet] assignment ${assignedReport.id} exists but robot heartbeat is missing`
    );
  } else {
    console.log(
      `[robot/packet] fetching Apple route for assignment ${assignedReport.id} from ${formatCoordinatePair(currentLocation)} to ${formatCoordinatePair(assignedReport.reporterLocation)}`
    );
  }

  const appleRouteRaw =
    assignedReport && currentLocation
      ? await fetchAppleDirections({
          assignmentId: assignedReport.id,
          origin: currentLocation,
          destination: assignedReport.reporterLocation,
        }).catch((error) => {
          console.error('[robot/packet] apple route fetch failed', error);
          return null;
        })
      : null;

  if (assignedReport && currentLocation) {
    if (appleRouteRaw === null) {
      console.log(
        `[robot/packet] appleRouteRaw is null for assignment ${assignedReport.id}; authMode=${getAppleMapsAuthMode()} configured=${hasAppleMapsAuth()}`
      );
    } else {
      console.log(
        `[robot/packet] appleRouteRaw populated for assignment ${assignedReport.id}: ${JSON.stringify(appleRouteRaw, null, 2)}`
      );
    }
  }

  return {
    status: assignedReport ? 'assigned' : 'idle',
    current: cloneCoordinates(currentLocation),
    queue: {
      pendingCount: reports.filter((report) => report.status === 'pending').length,
    },
    task: assignedReport
      ? {
          id: assignedReport.id,
          createdAt: assignedReport.createdAt,
          destination: cloneCoordinates(assignedReport.reporterLocation),
          navigation: summarizeAppleWalkingRoute(appleRouteRaw),
        }
      : null,
  };
}

async function fetchAppleDirections({
  assignmentId = null,
  origin,
  destination,
  transportType = APPLE_MAPS_TRANSPORT_TYPE,
  forceRefresh = false,
  cacheKey = null,
  fallbackToCache = true,
}) {
  if (!hasAppleMapsAuth()) {
    console.warn('[apple] auth missing; returning null route payload');
    return null;
  }

  const normalizedTransportType = normalizeTransportType(transportType);
  const resolvedCacheKey =
    cacheKey ||
    assignmentId ||
    `${formatCoordinatePair(origin)}:${formatCoordinatePair(destination)}:${normalizedTransportType}`;

  const cached = routeCache.get(resolvedCacheKey);
  if (!forceRefresh && cached && !shouldRefreshCachedRoute(cached, origin, destination, normalizedTransportType)) {
    console.log(
      `[apple] cache hit for ${resolvedCacheKey}; ageMs=${Date.now() - cached.fetchedAt}`
    );
    return cached.raw;
  }

  console.log(
    `[apple] cache miss for ${resolvedCacheKey}; mode=${getAppleMapsAuthMode()} transportType=${normalizedTransportType}`
  );

  const accessToken = await getAppleMapsAccessToken();
  const requestUrl = new URL(APPLE_MAPS_DIRECTIONS_URL);
  requestUrl.searchParams.set('origin', formatCoordinatePair(origin));
  requestUrl.searchParams.set('destination', formatCoordinatePair(destination));
  requestUrl.searchParams.set('transportType', normalizedTransportType);

  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
  };

  if (process.env.APPLE_MAPS_TOKEN_ORIGIN) {
    headers.Origin = process.env.APPLE_MAPS_TOKEN_ORIGIN;
  }

  try {
    console.log(`[apple] requesting ${requestUrl.toString()}`);
    const routeResponse = await fetch(requestUrl, {
      method: 'GET',
      headers,
    });

    const rawBody = await readResponseBody(routeResponse);
    console.log(`[apple] response status=${routeResponse.status}`);
    if (!routeResponse.ok) {
      const error = new Error(`Apple Maps directions failed with ${routeResponse.status}`);
      error.statusCode = routeResponse.status;
      error.details = rawBody;
      console.error('[apple] response body', JSON.stringify(rawBody, null, 2));
      throw error;
    }

    console.log('[apple] response body', JSON.stringify(rawBody, null, 2));

    routeCache.set(resolvedCacheKey, {
      fetchedAt: Date.now(),
      origin: cloneCoordinates(origin),
      destination: cloneCoordinates(destination),
      transportType: normalizedTransportType,
      raw: rawBody,
    });

    return rawBody;
  } catch (error) {
    if (fallbackToCache && cached?.raw) {
      console.warn(
        `[apple] fetch failed for ${resolvedCacheKey}; using cached response instead`
      );
      return cached.raw;
    }

    console.error('[apple] fetch failed without cached fallback', {
      cacheKey: resolvedCacheKey,
      statusCode: error?.statusCode ?? null,
      details: error?.details ?? null,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function shouldRefreshCachedRoute(cacheEntry, origin, destination, transportType) {
  if (!cacheEntry) {
    return true;
  }

  if (cacheEntry.transportType !== transportType) {
    return true;
  }

  if (Date.now() - cacheEntry.fetchedAt > APPLE_MAPS_ROUTE_CACHE_TTL_MS) {
    return true;
  }

  if (haversineDistance(cacheEntry.origin, origin) > APPLE_MAPS_ROUTE_CACHE_DISTANCE_METERS) {
    return true;
  }

  if (haversineDistance(cacheEntry.destination, destination) > 1) {
    return true;
  }

  return false;
}

function hasAppleMapsAuth() {
  return Boolean(
    process.env.APPLE_MAPS_SERVER_TOKEN ||
      (process.env.APPLE_MAPS_TEAM_ID &&
        process.env.APPLE_MAPS_KEY_ID &&
        (process.env.APPLE_MAPS_PRIVATE_KEY || process.env.APPLE_MAPS_PRIVATE_KEY_PATH))
  );
}

function getAppleMapsAuthMode() {
  if (process.env.APPLE_MAPS_SERVER_TOKEN) {
    return 'server-token';
  }

  if (
    process.env.APPLE_MAPS_TEAM_ID &&
    process.env.APPLE_MAPS_KEY_ID &&
    (process.env.APPLE_MAPS_PRIVATE_KEY || process.env.APPLE_MAPS_PRIVATE_KEY_PATH)
  ) {
    return 'runtime-jwt';
  }

  return 'unconfigured';
}

async function probeAppleMapsHealth({ includeAppleRouteProbe = false } = {}) {
  const authMode = getAppleMapsAuthMode();
  const activeReport = getActiveAssignedReport();
  const currentLocation = latestRobotHeartbeat?.location || null;

  if (!hasAppleMapsAuth()) {
    return {
      ok: false,
      authMode,
      tokenProbe: {
        ok: false,
        stage: 'config',
        error: 'Apple Maps auth is not configured',
      },
      routeProbe: {
        requested: includeAppleRouteProbe,
        ok: false,
        skipped: true,
        reason: 'Apple Maps auth is not configured',
      },
    };
  }

  const health = {
    ok: false,
    authMode,
    tokenProbe: null,
    routeProbe: {
      requested: includeAppleRouteProbe,
      ok: false,
      skipped: true,
      reason: includeAppleRouteProbe ? 'No active assignment or robot heartbeat available' : 'Route probe not requested',
    },
  };

  try {
    const accessToken = await getAppleMapsAccessToken();
    health.tokenProbe = {
      ok: true,
      stage: authMode === 'runtime-jwt' ? 'token-exchange' : 'token-source',
      accessTokenPresent: typeof accessToken === 'string' && accessToken.length > 0,
    };
  } catch (error) {
    health.tokenProbe = serializeAppleHealthError(error, authMode === 'runtime-jwt' ? 'token-exchange' : 'token-source');
    return health;
  }

  if (includeAppleRouteProbe) {
    if (!activeReport || !currentLocation) {
      health.routeProbe = {
        requested: true,
        ok: false,
        skipped: true,
        reason: !activeReport
          ? 'No active assignment available for route probe'
          : 'Robot heartbeat is missing for route probe',
      };
    } else {
      try {
        await fetchAppleDirections({
          assignmentId: activeReport.id,
          origin: currentLocation,
          destination: activeReport.reporterLocation,
          forceRefresh: true,
          cacheKey: `health-route-probe:${activeReport.id}`,
          fallbackToCache: false,
        });
        health.routeProbe = {
          requested: true,
          ok: true,
          skipped: false,
          assignmentId: activeReport.id,
          origin: cloneCoordinates(currentLocation),
          destination: cloneCoordinates(activeReport.reporterLocation),
        };
      } catch (error) {
        health.routeProbe = {
          requested: true,
          ok: false,
          skipped: false,
          assignmentId: activeReport.id,
          origin: cloneCoordinates(currentLocation),
          destination: cloneCoordinates(activeReport.reporterLocation),
          ...serializeAppleHealthError(error, 'directions'),
        };
      }
    }
  }

  health.ok = health.tokenProbe?.ok === true && (!includeAppleRouteProbe || health.routeProbe?.ok === true);
  return health;
}

async function getAppleMapsAccessToken() {
  if (process.env.APPLE_MAPS_SERVER_TOKEN) {
    console.log('[apple] using APPLE_MAPS_SERVER_TOKEN from relay env');
    return process.env.APPLE_MAPS_SERVER_TOKEN.trim();
  }

  if (mapsAccessTokenCache && mapsAccessTokenCache.expiresAt > Date.now()) {
    console.log(
      `[apple] using cached Maps access token; expiresInMs=${mapsAccessTokenCache.expiresAt - Date.now()}`
    );
    return mapsAccessTokenCache.accessToken;
  }

  const teamId = process.env.APPLE_MAPS_TEAM_ID;
  const keyId = process.env.APPLE_MAPS_KEY_ID;
  const privateKey = readApplePrivateKey();

  if (!teamId || !keyId || !privateKey) {
    throw new Error(
      'Apple Maps auth is not configured. Set APPLE_MAPS_SERVER_TOKEN or APPLE_MAPS_TEAM_ID, APPLE_MAPS_KEY_ID, and a private key.'
    );
  }

  console.log('[apple] generating runtime JWT from Apple Developer credentials');

  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 60 * 60;
  const header = {
    alg: 'ES256',
    kid: keyId,
    typ: 'JWT',
  };
  const payload = {
    iss: teamId,
    iat: issuedAt,
    exp: expiresAt,
  };

  if (process.env.APPLE_MAPS_TOKEN_ORIGIN) {
    payload.origin = process.env.APPLE_MAPS_TOKEN_ORIGIN;
  }

  const signedJwt = signJwt(header, payload, privateKey);
  return await exchangeJwtForMapsAccessToken(signedJwt);
}

function readApplePrivateKey() {
  if (process.env.APPLE_MAPS_PRIVATE_KEY) {
    return process.env.APPLE_MAPS_PRIVATE_KEY.replace(/\\n/g, '\n').trim();
  }

  if (process.env.APPLE_MAPS_PRIVATE_KEY_PATH) {
    const privateKeyPath = path.isAbsolute(process.env.APPLE_MAPS_PRIVATE_KEY_PATH)
      ? process.env.APPLE_MAPS_PRIVATE_KEY_PATH
      : path.join(__dirname, process.env.APPLE_MAPS_PRIVATE_KEY_PATH);

    return fs.readFileSync(privateKeyPath, 'utf8').trim();
  }

  return null;
}

function signJwt(header, payload, privateKey) {
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.sign('sha256', Buffer.from(unsignedToken), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });

  return `${unsignedToken}.${base64UrlEncode(signature)}`;
}

async function exchangeJwtForMapsAccessToken(signedJwt) {
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${signedJwt}`,
  };

  if (process.env.APPLE_MAPS_TOKEN_ORIGIN) {
    headers.Origin = process.env.APPLE_MAPS_TOKEN_ORIGIN;
  }

  console.log(`[apple] exchanging signed JWT for Maps access token via ${APPLE_MAPS_TOKEN_URL}`);
  const tokenResponse = await fetch(APPLE_MAPS_TOKEN_URL, {
    method: 'GET',
    headers,
  });
  const tokenBody = await readResponseBody(tokenResponse);
  console.log(`[apple] token exchange status=${tokenResponse.status}`);
  console.log('[apple] token exchange body', JSON.stringify(tokenBody, null, 2));

  if (!tokenResponse.ok) {
    const error = new Error(`Apple Maps token exchange failed with ${tokenResponse.status}`);
    error.statusCode = tokenResponse.status;
    error.details = tokenBody;
    throw error;
  }

  if (!tokenBody || typeof tokenBody !== 'object' || typeof tokenBody.accessToken !== 'string') {
    const error = new Error('Apple Maps token exchange response is missing accessToken');
    error.statusCode = 502;
    error.details = tokenBody;
    throw error;
  }

  const expiresInSeconds =
    typeof tokenBody.expiresInSeconds === 'number' && Number.isFinite(tokenBody.expiresInSeconds)
      ? tokenBody.expiresInSeconds
      : 1_800;
  mapsAccessTokenCache = {
    accessToken: tokenBody.accessToken,
    expiresAt: Date.now() + Math.max(0, expiresInSeconds - 60) * 1_000,
  };

  console.log(
    `[apple] token exchange succeeded; cached access token for ~${Math.max(0, expiresInSeconds - 60)}s`
  );

  return mapsAccessTokenCache.accessToken;
}

function serializeAppleHealthError(error, stage) {
  return {
    ok: false,
    stage,
    error: error instanceof Error ? error.message : String(error),
    statusCode: typeof error?.statusCode === 'number' ? error.statusCode : null,
    details: error?.details ?? null,
  };
}

function base64UrlEncode(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function maybeAssignNextTask() {
  const activeReport = getActiveAssignedReport();
  if (activeReport) {
    return activeReport;
  }

  activeAssignmentId = null;
  if (!latestRobotHeartbeat?.location) {
    return null;
  }

  const nextReport = selectNearestPendingReport(latestRobotHeartbeat.location, reports);
  if (!nextReport) {
    return null;
  }

  nextReport.status = 'assigned';
  activeAssignmentId = nextReport.id;
  return nextReport;
}

function getActiveAssignedReport() {
  if (!activeAssignmentId) {
    return null;
  }

  const activeReport = reports.find((candidate) => candidate.id === activeAssignmentId);
  if (!activeReport || activeReport.status !== 'assigned') {
    return null;
  }

  return activeReport;
}

function selectNearestPendingReport(origin, candidates) {
  return candidates
    .filter((report) => report.status === 'pending')
    .sort(
      (left, right) =>
        haversineDistance(origin, left.reporterLocation) - haversineDistance(origin, right.reporterLocation)
    )[0];
}

function serializeReport(report, request) {
  const photoUrl = buildUploadUrl(report.photoFilename, request);
  return {
    id: report.id,
    createdAt: report.createdAt,
    photoUri: photoUrl,
    photoUrl,
    reporterLocation: cloneCoordinates(report.reporterLocation),
    status: report.status,
  };
}

function summarizeAppleWalkingRoute(rawRoute, transportType = APPLE_MAPS_TRANSPORT_TYPE) {
  if (!rawRoute || typeof rawRoute !== 'object') {
    return null;
  }

  const envelope = Array.isArray(rawRoute?.data?.routes) && rawRoute.data.routes.length
    ? rawRoute.data
    : rawRoute;

  const route = extractPrimaryRoute(rawRoute);

  // Apple Maps Server API puts steps + polylines at the TOP level of the
  // response and references them from each route by index:
  //   envelope.steps:      Step[]           (pool)
  //   envelope.stepPaths:  LatLon[][]       (pool of coordinate arrays)
  //   route.stepIndexes:   number[]         (indices into envelope.steps)
  //   step.stepPathIndex:  number           (index into envelope.stepPaths)
  //
  // We also keep the older Google-shaped fallbacks (route.steps,
  // route.legs[].steps, step.polyline) so tests and alt providers keep
  // working.
  const stepsPool = Array.isArray(envelope?.steps) ? envelope.steps : [];
  const stepPathsPool = Array.isArray(envelope?.stepPaths) ? envelope.stepPaths : [];

  const stepRefs = extractRouteSteps(route, stepsPool);
  const steps = stepRefs.map((step, index) => summarizeRouteStep(step, index, stepPathsPool));

  const routeWaypoints = firstNonEmptyCoordinateSeries([
    route?.waypoints,
    route?.path,
    route?.coordinates,
    route?.polyline,
    envelope?.waypoints,
    envelope?.path,
    envelope?.coordinates,
    envelope?.polyline,
    steps.flatMap((step) => step.waypoints),
    // Last resort: flatten every stepPath Apple sent back. Even if
    // extractRouteSteps couldn't reconstruct the step list, the polyline
    // points still let nav compute distance/bearing.
    stepPathsPool.flatMap((p) => (Array.isArray(p) ? p : [])),
  ]);

  // Apple occasionally returns routes[].distanceMeters = 0 for very short
  // walks even when the steps themselves carry real distances. Sum the
  // steps as a fallback so the UI doesn't read "0.0 m" next to a 52s ETA.
  const stepDistanceSum = steps.reduce(
    (total, step) => (step.distanceMeters != null ? total + step.distanceMeters : total),
    0
  );
  const aggregateDistance = pickNumber(
    route?.distanceMeters,
    route?.distance,
    envelope?.distanceMeters,
    envelope?.distance
  );
  const distanceMeters =
    aggregateDistance != null && aggregateDistance > 0
      ? aggregateDistance
      : stepDistanceSum > 0
        ? stepDistanceSum
        : aggregateDistance; // preserves 0 / null for downstream UI

  return {
    provider: 'apple-maps',
    transportType,
    distanceMeters,
    expectedTravelTimeSeconds: pickNumber(
      route?.expectedTravelTimeSeconds,
      route?.expectedTravelTime,
      route?.durationSeconds,
      route?.duration,
      envelope?.expectedTravelTimeSeconds,
      envelope?.expectedTravelTime
    ),
    waypointCount: routeWaypoints.length,
    waypoints: routeWaypoints,
    steps,
  };
}

function summarizeRouteStep(step, index, stepPathsPool = []) {
  let waypoints = firstNonEmptyCoordinateSeries([
    step?.waypoints,
    step?.path,
    step?.coordinates,
    step?.polyline,
  ]);

  // Apple's step objects reference a polyline by index into the top-level
  // stepPaths pool — resolve it when the step itself didn't embed one.
  if (waypoints.length === 0 && typeof step?.stepPathIndex === 'number') {
    const path = stepPathsPool[step.stepPathIndex];
    waypoints = extractCoordinateSeries(path);
  }

  return {
    index,
    instruction: normalizeInstruction(
      step?.instructions ?? step?.instruction ?? step?.stepInstruction ?? null
    ),
    distanceMeters: pickNumber(step?.distanceMeters, step?.distance),
    expectedTravelTimeSeconds: pickNumber(
      step?.expectedTravelTimeSeconds,
      step?.expectedTravelTime,
      step?.durationSeconds,
      step?.duration
    ),
    waypoints,
  };
}

function extractPrimaryRoute(rawRoute) {
  if (Array.isArray(rawRoute?.routes) && rawRoute.routes.length) {
    return rawRoute.routes[0];
  }

  if (Array.isArray(rawRoute?.data?.routes) && rawRoute.data.routes.length) {
    return rawRoute.data.routes[0];
  }

  return rawRoute;
}

function extractRouteSteps(route, stepsPool = []) {
  // Apple shape: route.stepIndexes -> indices into top-level steps pool.
  if (Array.isArray(route?.stepIndexes) && stepsPool.length) {
    const resolved = route.stepIndexes
      .map((idx) => (Number.isInteger(idx) ? stepsPool[idx] : null))
      .filter((step) => step && typeof step === 'object');
    if (resolved.length) {
      return resolved;
    }
  }

  // Some providers inline the steps on the route itself.
  if (Array.isArray(route?.steps)) {
    return route.steps;
  }

  // Google-style legs.
  if (Array.isArray(route?.legs)) {
    return route.legs.flatMap((leg) => (Array.isArray(leg?.steps) ? leg.steps : []));
  }

  return [];
}

function firstNonEmptyCoordinateSeries(candidates) {
  for (const candidate of candidates) {
    const coordinates = extractCoordinateSeries(candidate);
    if (coordinates.length) {
      return coordinates;
    }
  }

  return [];
}

function extractCoordinateSeries(candidate) {
  if (!candidate) {
    return [];
  }

  if (Array.isArray(candidate)) {
    return candidate
      .map((item) => normalizeCoordinatePoint(item))
      .filter(Boolean);
  }

  if (Array.isArray(candidate.coordinates)) {
    return extractCoordinateSeries(candidate.coordinates);
  }

  if (Array.isArray(candidate.points)) {
    return extractCoordinateSeries(candidate.points);
  }

  return [];
}

function normalizeCoordinatePoint(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const latitude = pickNumber(value.latitude, value.lat);
  const longitude = pickNumber(value.longitude, value.lng, value.lon);
  if (latitude == null || longitude == null) {
    return null;
  }

  return { latitude, longitude };
}

function normalizeInstruction(value) {
  if (typeof value === 'string') {
    return value.trim() || null;
  }

  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean).join(' ') || null;
  }

  return null;
}

function pickNumber(...values) {
  for (const value of values) {
    const parsed = parseOptionalNumber(value);
    if (parsed != null) {
      return parsed;
    }
  }

  return null;
}

function buildUploadUrl(photoFilename, request) {
  return `${getPublicBaseUrl(request)}/uploads/${photoFilename}`;
}

function getPublicBaseUrl(request) {
  if (PUBLIC_BASE_URL) {
    return PUBLIC_BASE_URL;
  }

  if (!request) {
    return `http://localhost:${PORT}`;
  }

  return `${request.protocol}://${request.get('host')}`;
}

function parseMetadata(rawMetadata) {
  if (typeof rawMetadata !== 'string' || !rawMetadata.trim()) {
    return null;
  }

  try {
    return JSON.parse(rawMetadata);
  } catch {
    const error = new Error('metadata must be valid JSON');
    error.statusCode = 400;
    throw error;
  }
}

function parseBooleanQuery(value) {
  if (Array.isArray(value)) {
    return parseBooleanQuery(value[0]);
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function normalizeCoordinates(input) {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return {
    latitude,
    longitude,
    accuracy: parseOptionalNumber(input.accuracy),
    heading: parseOptionalNumber(input.heading),
    headingAccuracy: parseOptionalNumber(input.headingAccuracy),
    timestamp:
      typeof input.timestamp === 'string' && input.timestamp
        ? input.timestamp
        : new Date().toISOString(),
  };
}

function parseOptionalNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTransportType(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return APPLE_MAPS_TRANSPORT_TYPE;
  }

  return value.trim().toUpperCase();
}

function createReportId() {
  return `report_${Date.now()}_${Math.floor(Math.random() * 100_000)}`;
}

function cloneCoordinates(coordinates) {
  return coordinates ? { ...coordinates } : null;
}

function formatCoordinatePair(coordinates) {
  return `${coordinates.latitude},${coordinates.longitude}`;
}

function haversineDistance(origin, destination) {
  const earthRadiusMeters = 6_371_000;
  const lat1 = degreesToRadians(origin.latitude);
  const lat2 = degreesToRadians(destination.latitude);
  const deltaLat = degreesToRadians(destination.latitude - origin.latitude);
  const deltaLon = degreesToRadians(destination.longitude - origin.longitude);

  const haversine =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);

  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function degreesToRadians(value) {
  return (value * Math.PI) / 180;
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function loadEnvFiles(filePaths) {
  for (const filePath of filePaths) {
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const contents = fs.readFileSync(filePath, 'utf8');
    for (const rawLine of contents.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) {
        continue;
      }

      const separatorIndex = line.indexOf('=');
      if (separatorIndex <= 0) {
        continue;
      }

      const key = line.slice(0, separatorIndex).trim();
      let value = line.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }
}
