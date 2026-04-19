import { CampusId } from '@/constants/campuses';
import { TrashReport } from '@/types/routing';

// Toggle to disable all mock overlays at once.
export const MOCK_MAP_DATA_ENABLED = true;

// Reusable photo slots for individual (singleton) markers. Replace these
// URIs with your own local assets or hosted URLs. The same photo can be
// reused across multiple singleton mock reports — that's the point.
export const MOCK_SINGLETON_PHOTOS = {
  a: 'https://images.unsplash.com/photo-1532996122724-e3c354a0b15b?auto=format&fit=crop&w=800&q=80',
  b: 'https://images.unsplash.com/photo-1586495777744-4413f21062fa?auto=format&fit=crop&w=800&q=80',
  c: 'https://images.unsplash.com/photo-1560855067-b2dcd7b1f0d7?auto=format&fit=crop&w=800&q=80',
} as const;

export type MockPhotoSlot = keyof typeof MOCK_SINGLETON_PHOTOS;

// Heatmap hotspots — rendered as cluster bubbles with a display count.
// No images, just aggregated numbers in an area.
export type MockHotspot = {
  id: string;
  campusId: CampusId;
  latitude: number;
  longitude: number;
  total: number;
  active: number;
  cleaned: number;
};

export const MOCK_HOTSPOTS: MockHotspot[] = [
  // College Avenue — red
  {
    id: 'ca-yard',
    campusId: 'college-avenue',
    latitude: 40.5014,
    longitude: -74.4478,
    total: 1240,
    active: 38,
    cleaned: 1072,
  },
  {
    id: 'ca-scott',
    campusId: 'college-avenue',
    latitude: 40.5028,
    longitude: -74.4492,
    total: 342,
    active: 14,
    cleaned: 276,
  },
  {
    id: 'ca-river',
    campusId: 'college-avenue',
    latitude: 40.4992,
    longitude: -74.4453,
    total: 88,
    active: 6,
    cleaned: 61,
  },

  // Livingston — green
  {
    id: 'lv-plaza',
    campusId: 'livingston',
    latitude: 40.5240,
    longitude: -74.4368,
    total: 420,
    active: 19,
    cleaned: 361,
  },
  {
    id: 'lv-quads',
    campusId: 'livingston',
    latitude: 40.5260,
    longitude: -74.4395,
    total: 156,
    active: 8,
    cleaned: 118,
  },
  {
    id: 'lv-lot',
    campusId: 'livingston',
    latitude: 40.5218,
    longitude: -74.4345,
    total: 54,
    active: 4,
    cleaned: 37,
  },
];

// Individual (singleton) marker reports. Each references a photo slot so
// the same image can be reused across several mock reports.
type MockSingletonSeed = {
  id: string;
  campusId: CampusId;
  latitude: number;
  longitude: number;
  photo: MockPhotoSlot;
  status: 'pending' | 'assigned' | 'completed';
  caption: string;
  minutesAgo: number;
};

const SINGLETON_SEEDS: MockSingletonSeed[] = [
  // College Ave
  {
    id: 'mock-ca-1',
    campusId: 'college-avenue',
    latitude: 40.5038,
    longitude: -74.4462,
    photo: 'a',
    status: 'pending',
    caption: 'Coffee cups near the bus stop',
    minutesAgo: 12,
  },
  {
    id: 'mock-ca-2',
    campusId: 'college-avenue',
    latitude: 40.5001,
    longitude: -74.4498,
    photo: 'b',
    status: 'completed',
    caption: 'Bottle pile cleared',
    minutesAgo: 180,
  },
  {
    id: 'mock-ca-3',
    campusId: 'college-avenue',
    latitude: 40.5046,
    longitude: -74.4440,
    photo: 'c',
    status: 'assigned',
    caption: 'Wrappers by the gate',
    minutesAgo: 4,
  },

  // Livingston
  {
    id: 'mock-lv-1',
    campusId: 'livingston',
    latitude: 40.5202,
    longitude: -74.4402,
    photo: 'a',
    status: 'pending',
    caption: 'Plastic bags near dorms',
    minutesAgo: 22,
  },
  {
    id: 'mock-lv-2',
    campusId: 'livingston',
    latitude: 40.5285,
    longitude: -74.4356,
    photo: 'c',
    status: 'completed',
    caption: 'Cleaned — courtyard',
    minutesAgo: 240,
  },
];

export const MOCK_SINGLETON_REPORTS: TrashReport[] = SINGLETON_SEEDS.map((seed) => {
  const photoUri = MOCK_SINGLETON_PHOTOS[seed.photo];
  const createdAt = new Date(Date.now() - seed.minutesAgo * 60_000).toISOString();
  return {
    id: seed.id,
    createdAt,
    photoUri,
    photoUrl: photoUri,
    reporterLocation: {
      latitude: seed.latitude,
      longitude: seed.longitude,
      timestamp: createdAt,
    },
    status: seed.status,
    caption: seed.caption,
    trashCategory: null,
  };
});

export function getMockHotspotsForCampus(campusId: CampusId) {
  if (!MOCK_MAP_DATA_ENABLED) {
    return [];
  }
  return MOCK_HOTSPOTS.filter((hotspot) => hotspot.campusId === campusId);
}

export function getMockSingletonsForCampus(campusId: CampusId) {
  if (!MOCK_MAP_DATA_ENABLED) {
    return [];
  }
  return MOCK_SINGLETON_REPORTS.filter((report) => {
    const id = SINGLETON_SEEDS.find((seed) => seed.id === report.id)?.campusId;
    return id === campusId;
  });
}

export function getAllMockSingletons() {
  if (!MOCK_MAP_DATA_ENABLED) {
    return [];
  }
  return MOCK_SINGLETON_REPORTS;
}

export function getMockMetricsForCampus(campusId: CampusId) {
  if (!MOCK_MAP_DATA_ENABLED) {
    return { total: 0, active: 0, cleaned: 0 };
  }
  const hotspots = MOCK_HOTSPOTS.filter((hotspot) => hotspot.campusId === campusId);
  const singletons = SINGLETON_SEEDS.filter((seed) => seed.campusId === campusId);

  const hotspotTotals = hotspots.reduce(
    (acc, spot) => ({
      total: acc.total + spot.total,
      active: acc.active + spot.active,
      cleaned: acc.cleaned + spot.cleaned,
    }),
    { total: 0, active: 0, cleaned: 0 }
  );

  const singletonTotals = singletons.reduce(
    (acc, seed) => ({
      total: acc.total + 1,
      active: acc.active + (seed.status === 'assigned' ? 1 : 0),
      cleaned: acc.cleaned + (seed.status === 'completed' ? 1 : 0),
    }),
    { total: 0, active: 0, cleaned: 0 }
  );

  return {
    total: hotspotTotals.total + singletonTotals.total,
    active: hotspotTotals.active + singletonTotals.active,
    cleaned: hotspotTotals.cleaned + singletonTotals.cleaned,
  };
}
