export type Coordinates = {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  heading?: number | null;
  headingAccuracy?: number | null;
  timestamp: string;
};

export type TrashReport = {
  id: string;
  createdAt: string;
  note?: string;
  photoUri: string;
  photoUrl?: string;
  reporterLocation: Coordinates;
};

export type RouteStep = {
  instruction: string;
  distanceMeters: number;
  durationSeconds: number;
};

export type RoutePlan = {
  provider: 'apple' | 'mock';
  travelMode: 'walking';
  distanceMeters: number;
  durationSeconds: number;
  source: Coordinates;
  destination: Coordinates;
  polyline?: string;
  steps: RouteStep[];
};

export type RouteResponseMode = 'backend' | 'mock';

export type SubmitReportInput = {
  photoUri: string;
  reporterLocation: Coordinates;
  note?: string;
};

export type RouteRequestInput = {
  origin: Coordinates;
  destination: Coordinates;
};
