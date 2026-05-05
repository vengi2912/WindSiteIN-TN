"""Overpass API queries for Pakistan transmission infrastructure.

We do ONE country-wide query for power=line / minor_line / cable in PK, then
bucket by voltage in Python (see merge.py + voltage_parser.py). This is more
robust than per-voltage Overpass regex queries because OSM tagging is
inconsistent (units, typos, semicolons). It also lets us see lines without
voltage tags.

Substations and generation plants get separate queries.

Endpoints rotate; if the primary times out we fall back to mirrors. Results
are cached on disk under pipeline/.cache/ so reruns are fast.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass

import requests

from pipeline._paths import PIPELINE_CACHE

OVERPASS_ENDPOINTS: tuple[str, ...] = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.fr/api/interpreter",
)

REQUEST_TIMEOUT_S = 300
RETRY_BACKOFF_S = (5, 15, 45)


@dataclass(frozen=True)
class OverpassResult:
    label: str
    raw: dict
    fetched_at: str  # ISO 8601


def query_all_lines_pk() -> OverpassResult:
    """Fetch every power line / minor_line / cable way in Pakistan.

    Voltage is NOT filtered server-side; we bucket in Python afterwards.
    """
    return _fetch_or_cache("lines_all", _all_lines_query(), "lines_all")


def query_route_relations_pk() -> OverpassResult:
    """Fetch all `type=route route=power` relations in PK with member ids.

    Lets us propagate voltage from a relation to its member ways when the
    way itself lacks a voltage tag.
    """
    return _fetch_or_cache("route_relations", _route_relations_query(), "route_relations")


def query_substations_pk() -> OverpassResult:
    """Fetch all `power=substation` features in Pakistan."""
    return _fetch_or_cache("substations", _substations_query(), "substations")


def query_generation_pk() -> OverpassResult:
    """Fetch all `power=plant` features in Pakistan (NOT individual generators
    like rooftop solar; those are filtered out at the merge stage)."""
    return _fetch_or_cache("generation", _generation_query(), "generation")


def _all_lines_query() -> str:
    return f"""
    [out:json][timeout:{REQUEST_TIMEOUT_S - 30}];
    area["ISO3166-1"="PK"][admin_level=2]->.pk;
    (
      way(area.pk)["power"="line"];
      way(area.pk)["power"="minor_line"];
      way(area.pk)["power"="cable"];
    );
    out geom tags;
    """.strip()


def _route_relations_query() -> str:
    # `out body` returns each relation with its tags AND its member references
    # (way ids), which is exactly what we need for voltage propagation.
    return f"""
    [out:json][timeout:{REQUEST_TIMEOUT_S - 30}];
    area["ISO3166-1"="PK"][admin_level=2]->.pk;
    relation(area.pk)["type"="route"]["route"="power"];
    out body;
    """.strip()


def _substations_query() -> str:
    return f"""
    [out:json][timeout:{REQUEST_TIMEOUT_S - 30}];
    area["ISO3166-1"="PK"][admin_level=2]->.pk;
    (
      node(area.pk)["power"="substation"];
      way(area.pk)["power"="substation"];
      relation(area.pk)["power"="substation"];
    );
    out center tags;
    """.strip()


def _generation_query() -> str:
    return f"""
    [out:json][timeout:{REQUEST_TIMEOUT_S - 30}];
    area["ISO3166-1"="PK"][admin_level=2]->.pk;
    (
      node(area.pk)["power"="plant"];
      way(area.pk)["power"="plant"];
      relation(area.pk)["power"="plant"];
    );
    out center tags;
    """.strip()


def _fetch_or_cache(cache_key: str, body: str, label: str) -> OverpassResult:
    PIPELINE_CACHE.mkdir(parents=True, exist_ok=True)
    body_hash = hashlib.sha256(body.encode("utf-8")).hexdigest()[:12]
    cache_file = PIPELINE_CACHE / f"{cache_key}.{body_hash}.json"

    if cache_file.exists():
        cached = json.loads(cache_file.read_text(encoding="utf-8"))
        return OverpassResult(label, cached["raw"], cached["fetched_at"])

    raw = _post_with_failover(body)
    fetched_at = _utc_now_iso()
    cache_file.write_text(
        json.dumps({"fetched_at": fetched_at, "raw": raw}),
        encoding="utf-8",
    )
    return OverpassResult(label, raw, fetched_at)


def _post_with_failover(body: str) -> dict:
    last_err: Exception | None = None
    for endpoint in OVERPASS_ENDPOINTS:
        for backoff in RETRY_BACKOFF_S:
            try:
                resp = requests.post(
                    endpoint,
                    data={"data": body},
                    timeout=REQUEST_TIMEOUT_S,
                    headers={"User-Agent": "OpenGridPK/0.1 (https://github.com/opengridpk)"},
                )
                resp.raise_for_status()
                return resp.json()
            except requests.RequestException as e:
                last_err = e
                time.sleep(backoff)
    raise RuntimeError(f"All Overpass endpoints failed; last error: {last_err}")


def _utc_now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
