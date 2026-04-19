export type CampusId = 'college-avenue' | 'busch' | 'livingston';

export type CampusBoundingBox = {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
};

export type CampusDefinition = {
  id: CampusId;
  name: string;
  shortName: string;
  accent: string;
  boundingBox: CampusBoundingBox;
  region: {
    latitude: number;
    longitude: number;
    latitudeDelta: number;
    longitudeDelta: number;
  };
};

// Bounding boxes and region centers are inferred from Rutgers–New Brunswick
// campus maps. Cook/Douglass is intentionally excluded.
export const CAMPUSES: CampusDefinition[] = [
  {
    id: 'college-avenue',
    name: 'College Avenue',
    shortName: 'College Ave',
    accent: '#CC0033',
    boundingBox: {
      minLat: 40.4960,
      maxLat: 40.5060,
      minLon: -74.4520,
      maxLon: -74.4430,
    },
    region: {
      latitude: 40.5008,
      longitude: -74.4474,
      latitudeDelta: 0.018,
      longitudeDelta: 0.018,
    },
  },
  {
    id: 'busch',
    name: 'Busch Campus',
    shortName: 'Busch',
    accent: '#0A84FF',
    boundingBox: {
      minLat: 40.5150,
      maxLat: 40.5315,
      minLon: -74.4720,
      maxLon: -74.4540,
    },
    region: {
      latitude: 40.5228,
      longitude: -74.4631,
      latitudeDelta: 0.022,
      longitudeDelta: 0.024,
    },
  },
  {
    id: 'livingston',
    name: 'Livingston Campus',
    shortName: 'Livingston',
    accent: '#147154',
    boundingBox: {
      minLat: 40.5160,
      maxLat: 40.5325,
      minLon: -74.4445,
      maxLon: -74.4275,
    },
    region: {
      latitude: 40.5242,
      longitude: -74.4371,
      latitudeDelta: 0.022,
      longitudeDelta: 0.022,
    },
  },
];

export function getCampusById(id: CampusId) {
  return CAMPUSES.find((campus) => campus.id === id) ?? CAMPUSES[0];
}
