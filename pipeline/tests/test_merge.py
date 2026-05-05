"""Tests for the bucket-by-voltage merge logic."""

from pipeline.merge import bucket_lines_by_voltage, build_relation_voltage_map
from pipeline.overpass import OverpassResult


def _osm_way(way_id: int, voltage: str | None, name: str = "Test", power: str = "line", **extra_tags) -> dict:
    tags = {"power": power, "name": name}
    if voltage is not None:
        tags["voltage"] = voltage
    tags.update(extra_tags)
    return {
        "type": "way",
        "id": way_id,
        "geometry": [{"lon": 70.0, "lat": 30.0}, {"lon": 71.0, "lat": 31.0}],
        "tags": tags,
    }


def _result(elements: list[dict]) -> OverpassResult:
    return OverpassResult("test", {"elements": elements}, "2026-05-04T00:00:00Z")


def test_220kv_line_lands_in_220kv_bucket():
    out = bucket_lines_by_voltage(_result([_osm_way(111, "220000")]))
    assert len(out["220kv"]) == 1
    assert out["220kv"][0]["properties"]["voltage"] == 220000
    assert out["220kv"][0]["properties"]["source"] == "osm"


def test_multi_circuit_line_appears_in_both_buckets():
    out = bucket_lines_by_voltage(_result([_osm_way(222, "220000;132000")]))
    assert len(out["220kv"]) == 1
    assert len(out["132kv"]) == 1
    assert out["220kv"][0]["properties"]["osm_id"] == 222
    assert out["132kv"][0]["properties"]["osm_id"] == 222


def test_typo_220kw_normalizes_to_220kv():
    out = bucket_lines_by_voltage(_result([_osm_way(333, "220kw")]))
    assert len(out["220kv"]) == 1


def test_no_voltage_tag_drops_line():
    out = bucket_lines_by_voltage(_result([_osm_way(444, None)]))
    assert sum(len(v) for v in out.values()) == 0


def test_minor_line_without_voltage_dropped():
    out = bucket_lines_by_voltage(_result([_osm_way(445, None, power="minor_line")]))
    assert sum(len(v) for v in out.values()) == 0


def test_cable_without_voltage_dropped():
    out = bucket_lines_by_voltage(_result([_osm_way(446, None, power="cable")]))
    assert sum(len(v) for v in out.values()) == 0


def test_relation_voltage_propagates_to_member_way_without_voltage():
    rel_payload = {
        "elements": [
            {
                "type": "relation",
                "id": 9001,
                "tags": {"type": "route", "route": "power", "voltage": "220000"},
                "members": [{"type": "way", "ref": 4040, "role": ""}],
            }
        ]
    }
    rel_result = OverpassResult("rels", rel_payload, "2026-05-04T00:00:00Z")
    rel_map = build_relation_voltage_map(rel_result)
    assert rel_map == {4040: [220000]}

    way_no_voltage = _osm_way(4040, None)
    out = bucket_lines_by_voltage(_result([way_no_voltage]), rel_map)
    assert len(out["220kv"]) == 1
    assert out["220kv"][0]["properties"]["source"] == "osm-relation"


def test_distribution_voltage_dropped():
    # 33 kV is below our smallest transmission class (66 kV); drop entirely.
    out = bucket_lines_by_voltage(_result([_osm_way(555, "33000")]))
    assert sum(len(v) for v in out.values()) == 0


def test_lines_under_two_points_dropped():
    bad = {
        "type": "way",
        "id": 666,
        "geometry": [{"lon": 70.0, "lat": 30.0}],
        "tags": {"power": "line", "voltage": "220000"},
    }
    out = bucket_lines_by_voltage(_result([bad]))
    assert sum(len(v) for v in out.values()) == 0


def test_hvdc_only_classified_when_frequency_zero():
    # 660 kV AC mistag should NOT land in HVDC and (no canonical AC class for
    # 660 kV) is dropped.
    out_ac = bucket_lines_by_voltage(_result([_osm_way(777, "660000")]))
    assert sum(len(v) for v in out_ac.values()) == 0

    # 660 kV with frequency=0 is real HVDC.
    out_dc = bucket_lines_by_voltage(_result([_osm_way(888, "660000", frequency="0")]))
    assert len(out_dc["hvdc"]) == 1
    assert out_dc["hvdc"][0]["properties"]["is_hvdc"] is True
