"""Parse OSM `plant:output:electricity` tag values into MW.

Real-world values seen in PK OSM data:
    "50 MW", "100 MW", "1320 MW"   -> 50, 100, 1320
    "49.5 MW", "1.4 MW"            -> 49.5, 1.4
    "1000 kW"                      -> 1.0
    "0.5 GW"                       -> 500
    "yes"                          -> None  (sentinel only, no number)
    None / ""                      -> None
"""

from __future__ import annotations

import re

_CAPACITY_RE = re.compile(
    r"""
    ^\s*
    (?P<num>-?\d+(?:\.\d+)?)
    \s*
    (?P<unit>kw|mw|gw|w)?
    \s*$
    """,
    re.IGNORECASE | re.VERBOSE,
)

_TO_MW = {
    "w": 1e-6,
    "kw": 1e-3,
    "mw": 1.0,
    "gw": 1e3,
}


def parse_capacity_mw(raw: str | None) -> float | None:
    """Return capacity in MW, or None if unparseable / sentinel-only."""
    if not raw:
        return None
    s = str(raw).strip()
    m = _CAPACITY_RE.match(s)
    if not m:
        return None
    num = float(m.group("num"))
    unit = (m.group("unit") or "mw").lower()
    factor = _TO_MW.get(unit)
    if factor is None:
        return None
    mw = num * factor
    if mw <= 0:
        return None
    return mw
