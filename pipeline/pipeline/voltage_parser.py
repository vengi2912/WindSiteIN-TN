"""Parse and normalize OSM `voltage` tag values into volts.

OSM voltage tags are notoriously inconsistent: units sometimes appear, typos
exist, and multi-circuit lines use semicolons. This module converts whatever
a contributor wrote into a list of voltages-in-volts.

Examples (from real Pakistan OSM data):
    "132000"          -> [132000]
    "220000;132000"   -> [220000, 132000]   # multi-circuit
    "220kw"           -> [220000]           # typo for kV
    "220 kV"          -> [220000]
    "230000"          -> [230000]           # near-220 kV mistag, kept literal
    "0"               -> []                 # junk
    None              -> []
"""

from __future__ import annotations

import re

_NUM_RE = re.compile(r"^-?\d+(?:\.\d+)?$")


def parse_voltage_tag(raw: str | None) -> list[int]:
    """Return one or more voltages (in volts) extracted from an OSM voltage tag.

    Returns an empty list for missing, malformed, or junk values.
    """
    if not raw:
        return []
    out: list[int] = []
    for piece in str(raw).split(";"):
        v = _normalize_one(piece)
        if v is not None:
            out.append(v)
    return out


def _normalize_one(piece: str) -> int | None:
    s = piece.strip().lower().replace(",", "").replace(" ", "")
    if not s:
        return None

    # Strip a trailing unit if present.
    unit_factor = 1
    for unit, factor in (("kv", 1000), ("kw", 1000), ("v", 1)):
        if s.endswith(unit):
            s = s[: -len(unit)]
            unit_factor = factor
            break

    if not _NUM_RE.match(s):
        return None
    n = float(s) * unit_factor

    # Heuristic: a bare value < 1000 with no unit was almost certainly meant
    # to be kV (e.g. "220" tagged on a 220 kV line). Apply factor of 1000.
    if unit_factor == 1 and n < 1000 and "." not in piece:
        n *= 1000

    if n <= 0 or n > 2_000_000:  # > 2 MV is not real
        return None
    return int(round(n))


# Tolerance window for matching a voltage to one of the canonical classes.
# E.g. an OSM line tagged "230000" is likely a near-220 kV mistag and gets
# placed into the 220 kV bucket. We're conservative: 5 % window.
CANONICAL_VOLTAGES = (765000, 500000, 220000, 132000, 66000, 660000)
CLASSIFY_TOLERANCE = 0.05


def classify_to_canonical(voltage_v: int) -> int | None:
    """Snap a measured voltage to the nearest canonical class within tolerance."""
    for canonical in CANONICAL_VOLTAGES:
        if abs(voltage_v - canonical) / canonical <= CLASSIFY_TOLERANCE:
            return canonical
    return None
