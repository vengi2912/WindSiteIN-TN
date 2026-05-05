"""Bucket OSM lines by voltage class, apply local overrides, attach provenance.

Flow:
  1. Convert raw Overpass `way` elements into GeoJSON LineString features.
  2. Parse + normalize each line's `voltage` tag (handles units, typos, multi).
  3. If the way has no voltage but is a member of a power route relation that
     does, inherit the relation's voltage.
  4. Snap to canonical class (500 / 220 / 132 / 66 kV or HVDC) within ±5%.
  5. Lines that don't snap to any canonical class are dropped — we only show
     verified transmission voltages. Use data/overrides/add_lines.geojson to
     add specific lines that OSM lacks data for.
  6. Apply data/overrides/* on top.

Multi-circuit lines (e.g. voltage="220000;132000") appear in MULTIPLE buckets
so they show up under both layer toggles.
"""

from __future__ import annotations

import json

from pipeline._paths import OVERRIDES_DIR
from pipeline.capacity_parser import parse_capacity_mw
from pipeline.overpass import OverpassResult
from pipeline.voltage_classes import VoltageClass, load_voltage_classes
from pipeline.voltage_parser import classify_to_canonical, parse_voltage_tag

UTILITY_PLANT_MIN_MW = 5.0


def build_relation_voltage_map(rel_result: OverpassResult) -> dict[int, list[int]]:
    """Return {member_way_id: [parsed_voltages_v]} from power route relations.

    A way may be a member of more than one relation; its voltages list is the
    union. Voltages are parsed (and normalized) here — multi-voltage relation
    tags get split.
    """
    out: dict[int, list[int]] = {}
    for rel in rel_result.raw.get("elements", []):
        if rel.get("type") != "relation":
            continue
        voltages = parse_voltage_tag(rel.get("tags", {}).get("voltage"))
        if not voltages:
            continue
        for member in rel.get("members", []):
            if member.get("type") != "way":
                continue
            way_id = member.get("ref")
            if way_id is None:
                continue
            out.setdefault(way_id, []).extend(voltages)
    return out


def bucket_lines_by_voltage(
    osm_result: OverpassResult,
    relation_voltage_map: dict[int, list[int]] | None = None,
) -> dict[str, list[dict]]:
    """Return {voltage_class_id: [feature, ...]} for every voltage class.

    Includes the 'unknown' class for `power=line` ways without a parseable
    voltage tag (and not recoverable from a parent relation).
    `power=minor_line` and `power=cable` without voltage are silently dropped.
    """
    relation_voltage_map = relation_voltage_map or {}
    classes = load_voltage_classes()
    by_canonical_v: dict[int, VoltageClass] = {c.voltage_v: c for c in classes}
    buckets: dict[str, list[dict]] = {c.id: [] for c in classes}

    for el in osm_result.raw.get("elements", []):
        if el.get("type") != "way" or "geometry" not in el:
            continue
        coords = [[pt["lon"], pt["lat"]] for pt in el["geometry"]]
        if len(coords) < 2:
            continue
        tags = el.get("tags", {})
        power_kind = tags.get("power")
        if power_kind not in ("line", "minor_line", "cable"):
            continue

        voltages_v = parse_voltage_tag(tags.get("voltage"))
        voltage_inherited = False
        if not voltages_v:
            inherited = relation_voltage_map.get(el["id"])
            if inherited:
                voltages_v = inherited
                voltage_inherited = True

        is_hvdc = tags.get("frequency") == "0"

        canonical_classes_for_this_line: list[VoltageClass] = []
        for v in voltages_v:
            canonical_v = classify_to_canonical(v)
            if canonical_v is None:
                continue
            vc = by_canonical_v.get(canonical_v)
            if vc is None:
                continue
            if vc.is_hvdc and not is_hvdc:
                continue
            canonical_classes_for_this_line.append(vc)

        if not canonical_classes_for_this_line:
            # Drop: we only show lines that snap to a known transmission class.
            continue

        for vc in canonical_classes_for_this_line:
            buckets[vc.id].append(
                _make_feature(
                    coords, el, tags, vc=vc, is_hvdc=vc.is_hvdc, inherited=voltage_inherited
                )
            )

    for vc in classes:
        buckets[vc.id] = _apply_voltage_corrections(buckets[vc.id], vc)
        buckets[vc.id] = _apply_name_corrections(buckets[vc.id])
        buckets[vc.id].extend(_load_added_lines(vc))
    return buckets


def merge_substations(osm_result: OverpassResult) -> list[dict]:
    return _osm_to_geojson_points(osm_result, kind="substation", filter_fn=None)


def merge_generation(osm_result: OverpassResult) -> list[dict]:
    """Convert plant data to GeoJSON, filtering out DERs (rooftop solar etc.).

    Keep a plant if EITHER:
      - capacity (plant:output:electricity) parses to >= 5 MW, OR
      - it has both a `name` and a `plant:source` tag (named utility plant)
    """
    return _osm_to_geojson_points(osm_result, kind="generation", filter_fn=_is_utility_plant)


def _is_utility_plant(tags: dict) -> bool:
    cap_mw = parse_capacity_mw(tags.get("plant:output:electricity"))
    if cap_mw is not None and cap_mw >= UTILITY_PLANT_MIN_MW:
        return True
    if tags.get("name") and tags.get("plant:source"):
        return True
    return False


# --- internals -------------------------------------------------------------


def _make_feature(
    coords: list[list[float]],
    el: dict,
    tags: dict,
    *,
    vc: VoltageClass | None,
    is_hvdc: bool,
    inherited: bool,
) -> dict:
    return {
        "type": "Feature",
        "geometry": {"type": "LineString", "coordinates": coords},
        "properties": {
            "source": "osm-relation" if inherited else "osm",
            "osm_id": el["id"],
            "voltage": vc.voltage_v if vc else None,
            "voltage_raw": tags.get("voltage"),
            "is_hvdc": is_hvdc,
            "name": tags.get("name"),
            "operator": tags.get("operator"),
            "power_kind": tags.get("power"),
        },
    }


def _osm_to_geojson_points(result: OverpassResult, kind: str, filter_fn) -> list[dict]:
    elements = result.raw.get("elements", [])
    features: list[dict] = []
    for el in elements:
        lon, lat = _extract_point(el)
        if lon is None:
            continue
        tags = el.get("tags", {})
        if filter_fn is not None and not filter_fn(tags):
            continue
        cap_mw = parse_capacity_mw(tags.get("plant:output:electricity"))
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {
                    "source": "osm",
                    "osm_id": el["id"],
                    "osm_type": el["type"],
                    "kind": kind,
                    "name": tags.get("name"),
                    "voltage": tags.get("voltage"),
                    "operator": tags.get("operator"),
                    "plant_source": tags.get("plant:source"),
                    "plant_output": tags.get("plant:output:electricity"),
                    "capacity_mw": cap_mw,
                },
            }
        )
    return features


def _extract_point(el: dict) -> tuple[float | None, float | None]:
    if el.get("type") == "node":
        return el.get("lon"), el.get("lat")
    center = el.get("center")
    if center:
        return center.get("lon"), center.get("lat")
    return None, None


def _apply_voltage_corrections(features: list[dict], vc: VoltageClass) -> list[dict]:
    path = OVERRIDES_DIR / "voltage_corrections.json"
    if not path.exists():
        return features
    raw = json.loads(path.read_text(encoding="utf-8"))
    corrections: dict[str, int] = {k: int(v) for k, v in raw.items() if not k.startswith("$")}
    if not corrections:
        return features

    out: list[dict] = []
    for f in features:
        osm_id = str(f["properties"].get("osm_id", ""))
        corrected_v = corrections.get(osm_id)
        if corrected_v is None:
            out.append(f)
            continue
        if corrected_v == vc.voltage_v:
            f["properties"]["source"] = "override"
            f["properties"]["voltage"] = corrected_v
            out.append(f)
    return out


def _apply_name_corrections(features: list[dict]) -> list[dict]:
    path = OVERRIDES_DIR / "name_corrections.json"
    if not path.exists():
        return features
    raw = json.loads(path.read_text(encoding="utf-8"))
    name_map: dict[str, str] = {k: v for k, v in raw.items() if not k.startswith("$")}
    if not name_map:
        return features
    for f in features:
        osm_id = str(f["properties"].get("osm_id", ""))
        new_name = name_map.get(osm_id)
        if new_name is not None:
            f["properties"]["name"] = new_name
            f["properties"]["source"] = "override"
    return features


def _load_added_lines(vc: VoltageClass) -> list[dict]:
    path = OVERRIDES_DIR / "add_lines.geojson"
    if not path.exists():
        return []
    fc = json.loads(path.read_text(encoding="utf-8"))
    out: list[dict] = []
    for f in fc.get("features", []):
        props = f.get("properties", {})
        v = int(props.get("voltage", 0)) if props.get("voltage") else 0
        if v != vc.voltage_v:
            continue
        f = dict(f)
        f["properties"] = {**props, "source": "override", "is_hvdc": vc.is_hvdc}
        out.append(f)
    return out
