export type Coordinates = {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  heading?: number | null;
  headingAccuracy?: number | null;
  timestamp: string;
};

export type TrashCategory =
  | 'plastic'
  | 'paper'
  | 'food'
  | 'glass'
  | 'hazardous'
  | 'other';

export type TrashReport = {
  id: string;
  createdAt: string;
  photoUri: string;
  photoUrl?: string;
  reporterLocation: Coordinates;
  status?: 'pending' | 'assigned' | 'completed';
  caption?: string | null;
  trashCategory?: TrashCategory | null;
};

export type RouteResponseMode = 'backend' | 'mock';

export type RobotTaskStatus = 'idle' | 'assigned';

export type NavigationWaypoint = {
  latitude: number;
  longitude: number;
};

export type RobotNavigationStep = {
  index: number;
  instruction: string | null;
  distanceMeters: number | null;
  expectedTravelTimeSeconds: number | null;
  waypoints: NavigationWaypoint[];
};

export type RobotNavigation = {
  provider: 'apple-maps';
  transportType: string;
  distanceMeters: number | null;
  expectedTravelTimeSeconds: number | null;
  waypointCount: number;
  waypoints: NavigationWaypoint[];
  steps: RobotNavigationStep[];
};

export type RobotTask = {
  id: string;
  createdAt: string;
  destination: Coordinates;
  navigation: RobotNavigation | null;
};

export type RobotPacket = {
  status: RobotTaskStatus;
  current: Coordinates | null;
  queue: {
    pendingCount: number;
  };
  task: RobotTask | null;
};

export type SubmitReportInput = {
  photoUri: string;
  reporterLocation: Coordinates;
  caption?: string | null;
  trashCategory?: TrashCategory | null;
};

export type ReportFeed = {
  activeAssignmentId: string | null;
  reports: TrashReport[];
};
