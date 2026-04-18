"""Tests for jetson/nav/geo.py. Ground-truth values from Google Maps."""
from __future__ import annotations

import math
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from jetson.nav.geo import bearing, haversine, heading_error


# Rutgers College Avenue Student Center -> Rutgers Gateway Transit (known ~400m apart).
RUTGERS_CASC = (40.500800, -74.447700)
RUTGERS_GATEWAY = (40.497500, -74.445600)


class TestHaversine:
    def test_same_point_is_zero(self) -> None:
        assert haversine(40.0, -74.0, 40.0, -74.0) == 0.0

    def test_symmetric(self) -> None:
        a = haversine(40.5, -74.4, 40.6, -74.5)
        b = haversine(40.6, -74.5, 40.5, -74.4)
        assert a == pytest.approx(b)

    def test_known_distance_rutgers(self) -> None:
        d = haversine(*RUTGERS_CASC, *RUTGERS_GATEWAY)
        assert 350 < d < 450  # ~400m, give 50m slack

    def test_one_degree_latitude_is_about_111km(self) -> None:
        d = haversine(40.0, -74.0, 41.0, -74.0)
        assert 110_000 < d < 112_000


class TestBearing:
    def test_due_north(self) -> None:
        assert bearing(40.0, -74.0, 41.0, -74.0) == pytest.approx(0.0, abs=0.1)

    def test_due_east(self) -> None:
        # East bearings at ~40N with small lon delta.
        assert bearing(40.0, -74.0, 40.0, -73.9) == pytest.approx(90.0, abs=0.5)

    def test_due_south(self) -> None:
        assert bearing(40.0, -74.0, 39.0, -74.0) == pytest.approx(180.0, abs=0.1)

    def test_due_west(self) -> None:
        # atan2(-y, -x) gives -90 degrees; we normalize to 270.
        assert bearing(40.0, -74.0, 40.0, -74.1) == pytest.approx(270.0, abs=0.5)

    def test_range_is_zero_to_360_exclusive(self) -> None:
        b = bearing(40.0, -74.0, 41.0, -74.0)
        assert 0 <= b < 360


class TestHeadingError:
    def test_zero_when_aligned(self) -> None:
        assert heading_error(90.0, 90.0) == 0.0

    def test_positive_means_turn_right(self) -> None:
        # Facing north (0), target east (90) → turn right 90.
        assert heading_error(90.0, 0.0) == pytest.approx(90.0)

    def test_negative_means_turn_left(self) -> None:
        # Facing north (0), target west (270) → turn left 90 (-90).
        assert heading_error(270.0, 0.0) == pytest.approx(-90.0)

    def test_wraparound_through_north(self) -> None:
        # Facing 350 (nearly north), target 10 → turn right 20, not left 340.
        assert heading_error(10.0, 350.0) == pytest.approx(20.0)

    def test_wraparound_the_other_way(self) -> None:
        # Facing 10, target 350 → turn left 20.
        assert heading_error(350.0, 10.0) == pytest.approx(-20.0)

    def test_range_is_minus_180_to_180(self) -> None:
        for current in range(0, 360, 13):
            for target in range(0, 360, 17):
                err = heading_error(float(target), float(current))
                assert -180 <= err <= 180
