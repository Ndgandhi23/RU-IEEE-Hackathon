# Campus Cleanup Router

This Expo app is reduced to the routing demo your team described:

- `Reporter` tab: take a trash photo, capture GPS latitude/longitude, and submit a report.
- `Robot` tab: track the robot phone location, fetch the latest report, and request a walking route.

## Local run

1. Install dependencies

   ```bash
   npm install
   ```

2. Configure the relay API

   ```bash
   copy .env.example .env
   ```

   Set `EXPO_PUBLIC_API_BASE_URL` to the backend URL that both phones can reach.

3. Start Expo

   ```bash
   npx expo start
   ```

If `EXPO_PUBLIC_API_BASE_URL` is missing, the app falls back to an in-memory mock mode. That is only useful for same-device UI testing.

## Two-phone demo test

1. Start the relay on this laptop:

   ```bash
   cd ..\relay
   npm install
   npm start
   ```

2. Keep both phones on the same Wi-Fi as this laptop.

3. In the Expo app directory, `.env` is already pointed at this machine:

   ```bash
   EXPO_PUBLIC_API_BASE_URL=http://192.168.1.167:4000
   ```

4. Restart Expo after changing `.env`:

   ```bash
   cd ..\app
   npx expo start --clear
   ```

5. On the reporter phone:
   take a photo, capture GPS, then submit the report.

6. On the robot phone:
   capture robot GPS, optionally start continuous tracking, then refresh the latest report and generate the route.

The robot screen also records the phone-facing direction using heading sensors and shows both heading degrees and heading accuracy.

## Backend contract

Your robot routing should run through a backend relay so transmission range depends on Wi-Fi/cellular coverage instead of phone-to-phone Bluetooth range.

### `POST /reports`

Accept multipart form data:

- `photo`: image file from the reporter phone
- `metadata`: JSON string with:
  - `note`
  - `reporterLocation.latitude`
  - `reporterLocation.longitude`
  - `reporterLocation.accuracy`
  - `reporterLocation.timestamp`

Respond with:

```json
{
  "report": {
    "id": "report_123",
    "createdAt": "2026-04-18T16:30:00.000Z",
    "note": "soda can near bus stop",
    "photoUri": "https://cdn.example.com/report_123.jpg",
    "photoUrl": "https://cdn.example.com/report_123.jpg",
    "reporterLocation": {
      "latitude": 40.500123,
      "longitude": -74.447321,
      "accuracy": 5.2,
      "timestamp": "2026-04-18T16:29:55.000Z"
    }
  }
}
```

### `GET /reports/latest`

Return the most recent unassigned report:

```json
{
  "report": {
    "id": "report_123"
  }
}
```

### `POST /robot/heartbeat`

Accept:

```json
{
  "location": {
    "latitude": 40.4999,
    "longitude": -74.4468,
    "accuracy": 4.8,
    "timestamp": "2026-04-18T16:32:00.000Z"
  },
  "sentAt": "2026-04-18T16:32:00.000Z"
}
```

### `POST /routes/apple`

Accept:

```json
{
  "origin": {
    "latitude": 40.4999,
    "longitude": -74.4468,
    "timestamp": "2026-04-18T16:32:00.000Z"
  },
  "destination": {
    "latitude": 40.500123,
    "longitude": -74.447321,
    "timestamp": "2026-04-18T16:29:55.000Z"
  },
  "travelMode": "walking"
}
```

Respond with a normalized route object:

```json
{
  "route": {
    "provider": "apple",
    "travelMode": "walking",
    "distanceMeters": 210,
    "durationSeconds": 170,
    "source": {
      "latitude": 40.4999,
      "longitude": -74.4468,
      "timestamp": "2026-04-18T16:32:00.000Z"
    },
    "destination": {
      "latitude": 40.500123,
      "longitude": -74.447321,
      "timestamp": "2026-04-18T16:29:55.000Z"
    },
    "polyline": "encoded-polyline-if-you-have-one",
    "steps": [
      {
        "instruction": "Head north on the walkway",
        "distanceMeters": 60,
        "durationSeconds": 45
      }
    ]
  }
}
```

## Demo architecture

For the demo, keep both phones online and relay all messages through the backend:

- Reporter phone uploads photo + GPS.
- Backend stores the report and exposes the latest target.
- Robot phone posts heartbeat updates and requests the route.
- Backend calls Apple Maps Server API or native MapKit on a trusted environment and returns a normalized path.

That gives you transmission range equal to network coverage, which is the only practical way to make the demo reliable across campus.
