"""Tests for brain/io/iphone_listener.py.

Uses FastAPI's TestClient to exercise the /robot/heartbeat endpoint end-to-end
against an isolated LatestSensorState (no module-global leakage between tests).
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

from brain.io.iphone_listener import LatestSensorState, create_app

VALID_HEARTBEAT = {
    "location": {
        "latitude": 40.5,
        "longitude": -74.4,
        "accuracy": 4.8,
        "timestamp": "2026-04-18T16:32:00.000Z",
    },
    "sentAt": "2026-04-18T16:32:00.000Z",
}


@pytest.fixture
def state() -> LatestSensorState:
    return LatestSensorState()


@pytest.fixture
def client(state: LatestSensorState) -> TestClient:
    return TestClient(create_app(state))


def test_heartbeat_updates_state(client: TestClient, state: LatestSensorState) -> None:
    r = client.post("/robot/heartbeat", json=VALID_HEARTBEAT)
    assert r.status_code == 200
    assert r.json() == {"ok": True}

    reading = state.get()
    assert reading is not None
    assert reading.latitude == 40.5
    assert reading.longitude == -74.4
    assert reading.h_accuracy_m == 4.8


def test_state_empty_before_any_heartbeat(state: LatestSensorState) -> None:
    assert state.get() is None


def test_malformed_heartbeat_rejected(client: TestClient) -> None:
    # Missing `location` entirely.
    r = client.post("/robot/heartbeat", json={"sentAt": "2026-04-18T16:32:00.000Z"})
    assert r.status_code == 422  # FastAPI validation error


def test_heartbeat_missing_accuracy_rejected(client: TestClient) -> None:
    bad = {
        "location": {
            "latitude": 40.5,
            "longitude": -74.4,
            "timestamp": "2026-04-18T16:32:00.000Z",
        },
        "sentAt": "2026-04-18T16:32:00.000Z",
    }
    r = client.post("/robot/heartbeat", json=bad)
    assert r.status_code == 422


def test_stale_state_returns_none() -> None:
    # 0.01s staleness so the test finishes fast.
    state = LatestSensorState(staleness_s=0.01)
    app = create_app(state)
    client = TestClient(app)
    client.post("/robot/heartbeat", json=VALID_HEARTBEAT)
    assert state.get() is not None
    time.sleep(0.05)
    assert state.get() is None


def test_second_heartbeat_replaces_first(client: TestClient, state: LatestSensorState) -> None:
    client.post("/robot/heartbeat", json=VALID_HEARTBEAT)
    second = {
        "location": {
            "latitude": 41.0,
            "longitude": -75.0,
            "accuracy": 10.0,
            "timestamp": "2026-04-18T16:33:00.000Z",
        },
        "sentAt": "2026-04-18T16:33:00.000Z",
    }
    client.post("/robot/heartbeat", json=second)
    r = state.get()
    assert r is not None
    assert r.latitude == 41.0
    assert r.h_accuracy_m == 10.0


def test_healthz_reports_fresh_reading(client: TestClient) -> None:
    client.post("/robot/heartbeat", json=VALID_HEARTBEAT)
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["lat"] == 40.5
    assert body["lon"] == -74.4
    assert body["accuracy_m"] == 4.8
    assert body["age_s"] >= 0


def test_healthz_reports_no_heartbeat_when_empty(client: TestClient) -> None:
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["ok"] is False


def test_reset_clears_state(state: LatestSensorState, client: TestClient) -> None:
    client.post("/robot/heartbeat", json=VALID_HEARTBEAT)
    assert state.get() is not None
    state.reset()
    assert state.get() is None
