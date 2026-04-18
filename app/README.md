# Campus Cleanup Router

This Expo app is now the reporter-side client only:

- `Reporter` tab: take a trash photo, capture GPS latitude/longitude, and submit a report.
- `robot-console/`: separate Expo app for the robot phone that tracks robot GPS/heading, syncs the queue, and emits the raw packet for the Raspberry Pi.

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

1. Configure the relay on this laptop:

   ```bash
   cd ..\relay
   copy .env.example .env
   ```

   Set either `APPLE_MAPS_SERVER_TOKEN` or the Apple credential set:
   `APPLE_MAPS_TEAM_ID`, `APPLE_MAPS_KEY_ID`, and `APPLE_MAPS_PRIVATE_KEY_PATH` / `APPLE_MAPS_PRIVATE_KEY`.

2. Start the relay on this laptop:

   ```bash
   npm install
   npm start
   ```

3. Keep both phones on the same Wi-Fi as this laptop.

4. In the Expo app directory, `.env` is already pointed at this machine:

   ```bash
   EXPO_PUBLIC_API_BASE_URL=http://192.168.1.167:4000
   ```

5. Restart Expo after changing `.env`:

   ```bash
   cd ..\app
   npx expo start --clear
   ```

6. On the reporter phone:
   take a photo, capture GPS, then submit the report.

7. In the separate `robot-console` app on the robot phone:
   capture robot GPS, optionally start continuous tracking, then sync the robot packet. The relay auto-assigns the nearest pending task when the robot is idle.

## Backend contract

Your robot routing should run through a backend relay so transmission range depends on Wi-Fi/cellular coverage instead of phone-to-phone Bluetooth range.

### `POST /reports`

Accept multipart form data:

- `photo`: image file from the reporter phone
- `metadata`: JSON string with:
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
    "photoUri": "https://cdn.example.com/report_123.jpg",
    "photoUrl": "https://cdn.example.com/report_123.jpg",
    "reporterLocation": {
      "latitude": 40.500123,
      "longitude": -74.447321,
      "accuracy": 5.2,
      "timestamp": "2026-04-18T16:29:55.000Z"
    },
    "status": "pending"
  }
}
```

### `GET /reports/latest`

Return the most recent report:

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
    "heading": 82.1,
    "headingAccuracy": 2.0,
    "timestamp": "2026-04-18T16:32:00.000Z"
  },
  "sentAt": "2026-04-18T16:32:00.000Z"
}
```

### `GET /robot/packet`

Return the exact packet the Raspberry Pi can consume:

```json
{
  "packet": {
    "assignmentId": "report_123",
    "assignmentStatus": "assigned",
    "target": {
      "latitude": 40.500123,
      "longitude": -74.447321,
      "accuracy": 5.2,
      "heading": null,
      "headingAccuracy": null,
      "timestamp": "2026-04-18T16:29:55.000Z"
    },
    "current": {
      "latitude": 40.499900,
      "longitude": -74.446800,
      "accuracy": 4.8,
      "heading": 82.1,
      "headingAccuracy": 2.0,
      "timestamp": "2026-04-18T16:32:00.000Z"
    },
    "report": {
      "id": "report_123",
      "createdAt": "2026-04-18T16:30:00.000Z",
      "photoUrl": "https://cdn.example.com/report_123.jpg",
      "status": "assigned"
    },
    "queue": {
      "pendingCount": 3,
      "completedCount": 1,
      "assignedCount": 1,
      "pendingIds": ["report_456", "report_789", "report_999"]
    },
    "appleRouteRaw": null
  }
}
```

`appleRouteRaw` is filled with the raw Apple Maps Server API response when the relay has valid Apple credentials. If the relay is running without Apple auth, it stays `null`. The relay does not generate instructions anymore.

### `POST /routes/apple`

Accept:

```json
{
  "origin": {
    "latitude": 40.4999,
    "longitude": -74.4468,
    "heading": 82.1,
    "headingAccuracy": 2.0,
    "timestamp": "2026-04-18T16:32:00.000Z"
  },
  "destination": {
    "latitude": 40.500123,
    "longitude": -74.447321,
    "timestamp": "2026-04-18T16:29:55.000Z"
  }
}
```

Respond with:

```json
{
  "route": {
    "origin": {
      "latitude": 40.4999,
      "longitude": -74.4468,
      "heading": 82.1,
      "headingAccuracy": 2.0,
      "timestamp": "2026-04-18T16:32:00.000Z"
    },
    "destination": {
      "latitude": 40.500123,
      "longitude": -74.447321,
      "timestamp": "2026-04-18T16:29:55.000Z"
    },
    "appleRouteRaw": null
  }
}
```

This endpoint now proxies the Apple Maps Server API directly and returns the raw Apple response in `appleRouteRaw`.

### `POST /robot/task/complete`

Accept:

```json
{
  "taskId": "report_123"
}
```

This marks the current task complete, then auto-assigns the next nearest pending task.

## Demo architecture

For the demo, keep both phones online and relay all messages through the backend:

- Reporter phone uploads photo plus raw GPS.
- Backend stores a queue of reports.
- Robot phone posts heartbeat updates and the relay auto-assigns the nearest pending task whenever the robot is idle.
- Robot phone reads a single raw packet containing `target`, `current`, queue state, and the raw Apple route payload in `appleRouteRaw`.
- When a task is finished, the robot marks it complete and the relay assigns the next nearest task automatically.

That gives you transmission range equal to network coverage, which is the practical way to make the demo reliable across campus.
