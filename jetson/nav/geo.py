"""Pure-math GPS utilities. No state, fully unit-tested.

Coordinate conventions (from CLAUDE.md):
- lat/lon in decimal degrees, WGS84. (lat, lon) tuple order.
- Heading: degrees from true north, clockwise, [0, 360).
- Bearing error: signed degrees, [-180, 180]. Negative = turn left.
"""
from __future__ import annotations

import math

EARTH_RADIUS_M = 6_371_000.0  # mean Earth radius


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in meters between two (lat, lon) points."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


def bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Initial bearing in degrees [0, 360), from point 1 to point 2, clockwise from true north."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dlambda = math.radians(lon2 - lon1)
    y = math.sin(dlambda) * math.cos(phi2)
    x = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlambda)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def heading_error(target_bearing_deg: float, current_heading_deg: float) -> float:
    """Signed turn in degrees [-180, 180]. Negative = turn left, positive = turn right."""
    diff = (target_bearing_deg - current_heading_deg + 180) % 360 - 180
    # Python's modulo on floats keeps the sign of the divisor, so this is in (-180, 180].
    # Normalize exactly -180 and +180 for consistency.
    return -180.0 if diff == -180.0 else diff
