"""Load canonical voltage classes from data/reference/voltage_classes.json.

Both the pipeline (filtering, file naming) and the static site (legend, layer
paint) read from the same JSON. This module exposes a typed Python view.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import cache

from pipeline._paths import VOLTAGE_CLASSES_FILE


@dataclass(frozen=True)
class VoltageClass:
    id: str
    label: str
    voltage_v: int
    is_hvdc: bool
    color: str
    line_dash: list[int] | None
    default_visible: bool
    min_zoom_visible: int
    geojson_filename: str


@cache
def load_voltage_classes() -> list[VoltageClass]:
    """Return the canonical voltage classes ordered as in the JSON file."""
    raw = json.loads(VOLTAGE_CLASSES_FILE.read_text(encoding="utf-8"))
    return [VoltageClass(**c) for c in raw["classes"]]


def by_id(class_id: str) -> VoltageClass:
    for vc in load_voltage_classes():
        if vc.id == class_id:
            return vc
    raise KeyError(f"Unknown voltage class id: {class_id!r}")
