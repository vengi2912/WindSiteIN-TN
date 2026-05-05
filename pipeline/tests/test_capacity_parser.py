import pytest

from pipeline.capacity_parser import parse_capacity_mw


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("50 MW", 50.0),
        ("100 MW", 100.0),
        ("1320 MW", 1320.0),
        ("49.5 MW", 49.5),
        ("1.4 MW", 1.4),
        ("1000 kW", 1.0),
        ("0.5 GW", 500.0),
        ("100", 100.0),  # bare number defaults to MW
        ("yes", None),
        ("", None),
        (None, None),
        ("garbage", None),
        ("-5 MW", None),  # negative -> None
    ],
)
def test_parse_capacity(raw, expected):
    got = parse_capacity_mw(raw)
    if expected is None:
        assert got is None
    else:
        assert got == pytest.approx(expected)
