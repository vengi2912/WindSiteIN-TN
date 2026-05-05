"""Tests for voltage tag parsing — drives the bucketing of every OSM line."""

import pytest

from pipeline.voltage_parser import classify_to_canonical, parse_voltage_tag


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("132000", [132000]),
        ("220000", [220000]),
        ("220000;132000", [220000, 132000]),
        ("220kw", [220000]),  # OSM typo seen in PK
        ("220 kV", [220000]),
        ("220kv", [220000]),
        ("220 000", [220000]),
        ("220,000", [220000]),
        ("220", [220000]),  # bare kV
        ("0", []),
        ("180", [180000]),  # could be junk; we keep it; classify will drop it
        ("", []),
        (None, []),
        ("   ", []),
        ("garbage", []),
        ("132000;junk;220000", [132000, 220000]),
    ],
)
def test_parse_voltage_tag(raw, expected):
    assert parse_voltage_tag(raw) == expected


def test_classify_snaps_to_canonical_within_tolerance():
    assert classify_to_canonical(220000) == 220000
    assert classify_to_canonical(230000) == 220000  # 4.5 % off, within tolerance
    assert classify_to_canonical(132000) == 132000
    assert classify_to_canonical(500000) == 500000


def test_classify_rejects_outside_tolerance():
    assert classify_to_canonical(110000) is None
    assert classify_to_canonical(33000) is None
    assert classify_to_canonical(11000) is None
