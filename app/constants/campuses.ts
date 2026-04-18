export type CampusId = 'new-brunswick' | 'newark' | 'camden';

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

// Campus framing boxes are inferred from Rutgers public campus maps and visit pages.
export const CAMPUSES: CampusDefinition[] = [
  {
    id: 'new-brunswick',
    name: 'Rutgers–New Brunswick',
    shortName: 'New Brunswick',
    accent: '#147154',
    boundingBox: {
      minLat: 40.4625,
      maxLat: 40.5369,
      minLon: -74.4898,
      maxLon: -74.3994,
    },
    region: {
      latitude: 40.4997,
      longitude: -74.4446,
      latitudeDelta: 0.085,
      longitudeDelta: 0.105,
    },
  },
  {
    id: 'newark',
    name: 'Rutgers–Newark',
    shortName: 'Newark',
    accent: '#D96B2B',
    boundingBox: {
      minLat: 40.7286,
      maxLat: 40.7489,
      minLon: -74.1876,
      maxLon: -74.1645,
    },
    region: {
      latitude: 40.73875,
      longitude: -74.17605,
      latitudeDelta: 0.025,
      longitudeDelta: 0.03,
    },
  },
  {
    id: 'camden',
    name: 'Rutgers–Camden',
    shortName: 'Camden',
    accent: '#8A4DFF',
    boundingBox: {
      minLat: 39.936,
      maxLat: 39.9505,
      minLon: -75.1295,
      maxLon: -75.112,
    },
    region: {
      latitude: 39.94325,
      longitude: -75.12075,
      latitudeDelta: 0.02,
      longitudeDelta: 0.022,
    },
  },
];

export function getCampusById(id: CampusId) {
  return CAMPUSES.find((campus) => campus.id === id) ?? CAMPUSES[0];
}

