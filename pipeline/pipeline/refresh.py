"""Orchestrate a full data refresh.

Run via: `python -m pipeline.refresh`
or:      `make refresh` (from pipeline/)

Steps:
  1. One country-wide Overpass query for all power lines in PK.
  2. Bucket lines by voltage in Python (handles tag variance, multi-circuit).
  3. Pull substations + generation plants via Overpass.
  4. Validate.
  5. Simplify.
  6. Write GeoJSON + meta.json to site/data/.
  7. Print regression warnings.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone

from pipeline import overpass
from pipeline.export import copy_reference_files, write_feature_collection, write_meta
from pipeline.merge import (
    build_relation_voltage_map,
    bucket_lines_by_voltage,
    merge_generation,
    merge_substations,
)
from pipeline.simplify import line_length_km, simplify_line_features
from pipeline.validate import regression_check, validate_lines
from pipeline.voltage_classes import load_voltage_classes


def main() -> int:
    started_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    print(f"[refresh] start {started_at}")

    copy_reference_files()
    print("[refresh] copied reference files into site/data/")

    print("[refresh] fetching all power lines in PK (single query)...")
    lines_result = overpass.query_all_lines_pk()
    raw_count = len(lines_result.raw.get("elements", []))
    print(f"[refresh] received {raw_count} raw power ways")

    print("[refresh] fetching power route relations for voltage propagation...")
    rel_result = overpass.query_route_relations_pk()
    rel_voltage_map = build_relation_voltage_map(rel_result)
    print(f"[refresh] {len(rel_voltage_map)} ways inherit voltage from a parent relation")

    buckets = bucket_lines_by_voltage(lines_result, rel_voltage_map)

    voltage_classes = load_voltage_classes()
    line_counts: dict[str, int] = {}
    line_lengths_km: dict[str, float] = {}

    for vc in voltage_classes:
        features = buckets[vc.id]
        validate_lines(features, vc)
        simplified = simplify_line_features(features)
        write_feature_collection(vc.geojson_filename, simplified)
        line_counts[vc.id] = len(simplified)
        line_lengths_km[vc.id] = line_length_km(simplified)
        print(f"[refresh] {vc.id}: {len(simplified)} lines, {line_lengths_km[vc.id]:.0f} km")

    print("[refresh] substations: querying overpass...")
    sub_result = overpass.query_substations_pk()
    substations = merge_substations(sub_result)
    write_feature_collection("substations.geojson", substations)
    print(f"[refresh] substations: {len(substations)} features")

    print("[refresh] generation: querying overpass...")
    gen_result = overpass.query_generation_pk()
    generation = merge_generation(gen_result)
    write_feature_collection("generation.geojson", generation)
    print(f"[refresh] generation: {len(generation)} features")

    warnings = regression_check(line_lengths_km, line_counts)

    write_meta(
        {
            "built_at": started_at,
            "line_counts": line_counts,
            "line_lengths_km": {k: round(v, 1) for k, v in line_lengths_km.items()},
            "substation_count": len(substations),
            "generation_count": len(generation),
            "regression_warnings": warnings,
        }
    )

    if warnings:
        print("[refresh] WARNINGS:")
        for w in warnings:
            print(f"  - {w}")

    print("[refresh] done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
