"""Smoke tests for the canonical voltage class registry."""

from pipeline.voltage_classes import by_id, load_voltage_classes


def test_loads_all_classes():
    classes = load_voltage_classes()
    ids = [c.id for c in classes]
    # 765 kV omitted: no PK lines tagged at that voltage in OSM.
    # 'unknown' bucket dropped: lines without a parseable canonical voltage
    # are dropped from the output rather than shown ambiguously.
    assert ids == ["500kv", "hvdc", "220kv", "132kv", "66kv"]


def test_all_classes_visible_by_default():
    for c in load_voltage_classes():
        assert c.default_visible is True


def test_hvdc_flagged_correctly():
    assert by_id("hvdc").is_hvdc is True
    assert by_id("500kv").is_hvdc is False


def test_filenames_unique():
    files = [c.geojson_filename for c in load_voltage_classes()]
    assert len(files) == len(set(files))


def test_colors_are_hex():
    for c in load_voltage_classes():
        assert c.color.startswith("#") and len(c.color) == 7
