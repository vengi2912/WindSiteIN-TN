// OpenGridPK - static site bootstrap.
// Reads canonical voltage classes from data/voltage_classes.json (copied
// there by the pipeline; same file the Python build code reads), wires up
// MapLibre layers, the legend toggles, and click popups.

const VOLTAGE_CLASSES_URL = "data/voltage_classes.json";
const META_URL = "data/meta.json";
const PK_BBOX = [60.8, 23.5, 77.0, 37.1]; // [west, south, east, north]

const SUBSTATION_COLOR = "#ffd166";
const GENERATION_COLOR = "#ef476f";

// CartoDB Positron - clean light basemap that lets voltage colors pop.
// Free, no API key. Three-subdomain rotation for parallel tile loads.
const BASE_STYLE = {
  version: 8,
  sources: {
    positron: {
      type: "raster",
      tiles: [
        "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
        "https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
        "https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution:
        "© <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors © <a href='https://carto.com/attributions'>CARTO</a>",
    },
  },
  layers: [{ id: "positron", type: "raster", source: "positron" }],
};

// ---------------------------------------------------------------------------

async function main() {
  const [voltageRegistry, meta] = await Promise.all([
    fetch(VOLTAGE_CLASSES_URL).then((r) => r.json()),
    fetch(META_URL)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);

  const voltageClasses = voltageRegistry.classes;
  renderLegend(voltageClasses, meta);
  renderMeta(meta);

  const map = new maplibregl.Map({
    container: "map",
    style: BASE_STYLE,
    bounds: PK_BBOX,
    fitBoundsOptions: { padding: 30 },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }), "bottom-left");

  map.on("load", () => {
    // Add layers from lowest voltage to highest so higher voltages render on top.
    const drawOrder = [...voltageClasses].reverse();
    for (const vc of drawOrder) addVoltageLayer(map, vc);
    addSubstationsLayer(map);
    addGenerationLayer(map);
    wireLegendToggles(map, voltageClasses);
  });
}

// ---- layer setup ----------------------------------------------------------

function addVoltageLayer(map, vc) {
  const sourceId = `lines-${vc.id}`;
  const layerId = `lines-${vc.id}-layer`;

  map.addSource(sourceId, {
    type: "geojson",
    data: `data/${vc.geojson_filename}`,
    promoteId: "osm_id",
  });

  // Higher voltages slightly thicker so the eye finds the backbone first.
  const widthScale = vc.id === "unknown" ? 0.6 : voltageWidthScale(vc.voltage_v);

  const paint = {
    "line-color": vc.color,
    "line-width": [
      "interpolate", ["linear"], ["zoom"],
      4, 0.5 * widthScale,
      8, 1.4 * widthScale,
      12, 3.0 * widthScale,
      16, 5.0 * widthScale,
    ],
    "line-opacity": vc.id === "unknown" ? 0.55 : 0.95,
  };
  if (vc.line_dash) paint["line-dasharray"] = vc.line_dash;

  map.addLayer({
    id: layerId,
    type: "line",
    source: sourceId,
    minzoom: vc.min_zoom_visible,
    layout: {
      "line-cap": "round",
      "line-join": "round",
      visibility: vc.default_visible ? "visible" : "none",
    },
    paint,
  });

  map.on("click", layerId, (e) => showLinePopup(map, vc, e));
  map.on("mouseenter", layerId, () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", layerId, () => (map.getCanvas().style.cursor = ""));
}

function voltageWidthScale(v) {
  if (v >= 765000) return 1.6;
  if (v >= 500000) return 1.4;
  if (v >= 220000) return 1.15;
  if (v >= 132000) return 0.95;
  return 0.8;
}

function addSubstationsLayer(map) {
  map.addSource("substations", { type: "geojson", data: "data/substations.geojson" });
  map.addLayer({
    id: "substations-layer",
    type: "circle",
    source: "substations",
    minzoom: 7,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 2.2, 12, 6, 16, 9],
      "circle-color": SUBSTATION_COLOR,
      "circle-stroke-color": "#1a1d23",
      "circle-stroke-width": 0.8,
      "circle-opacity": 0.95,
    },
  });
  map.on("click", "substations-layer", (e) => showPointPopup(map, e, "Substation"));
  map.on("mouseenter", "substations-layer", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "substations-layer", () => (map.getCanvas().style.cursor = ""));
}

function addGenerationLayer(map) {
  map.addSource("generation", { type: "geojson", data: "data/generation.geojson" });
  map.addLayer({
    id: "generation-layer",
    type: "circle",
    source: "generation",
    minzoom: 5,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 3, 12, 7.5, 16, 11],
      "circle-color": GENERATION_COLOR,
      "circle-stroke-color": "#1a1d23",
      "circle-stroke-width": 0.8,
      "circle-opacity": 0.95,
    },
  });
  map.on("click", "generation-layer", (e) => showPointPopup(map, e, "Generation plant"));
  map.on("mouseenter", "generation-layer", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "generation-layer", () => (map.getCanvas().style.cursor = ""));
}

// ---- legend / toggles -----------------------------------------------------

function renderLegend(voltageClasses, meta) {
  const list = document.getElementById("voltage-list");
  const counts = (meta && meta.line_counts) || {};
  list.innerHTML = voltageClasses
    .map((vc) => {
      const n = counts[vc.id];
      const countLabel = n != null ? `<span class="layer-count">${n.toLocaleString()}</span>` : "";
      const checked = vc.default_visible ? "checked" : "";
      return `
        <li>
          <label>
            <input type="checkbox" data-voltage="${vc.id}" ${checked} />
            <span class="swatch" style="color: ${vc.color}"></span>
            ${vc.label}
            ${countLabel}
          </label>
        </li>`;
    })
    .join("");

  const legend = document.getElementById("legend");
  document.getElementById("legend-toggle").addEventListener("click", () => {
    legend.classList.toggle("open");
  });
}

function wireLegendToggles(map, voltageClasses) {
  for (const vc of voltageClasses) {
    const cb = document.querySelector(`input[data-voltage="${vc.id}"]`);
    if (!cb) continue;
    cb.addEventListener("change", () => {
      map.setLayoutProperty(`lines-${vc.id}-layer`, "visibility", cb.checked ? "visible" : "none");
    });
  }
  for (const layer of ["substations", "generation"]) {
    const cb = document.querySelector(`input[data-layer="${layer}"]`);
    cb.addEventListener("change", () => {
      map.setLayoutProperty(`${layer}-layer`, "visibility", cb.checked ? "visible" : "none");
    });
  }
}

function renderMeta(meta) {
  const el = document.getElementById("meta-line");
  if (!meta || !meta.built_at) {
    el.textContent = "Data not yet built. Run `make refresh`.";
    return;
  }
  const builtAt = new Date(meta.built_at).toISOString().slice(0, 10);
  const totalKm = Object.values(meta.line_lengths_km || {}).reduce((s, v) => s + v, 0);
  el.innerHTML = `
    Last refreshed: ${builtAt}<br />
    ${Math.round(totalKm).toLocaleString()} km of line · ${meta.substation_count.toLocaleString()} substations · ${meta.generation_count.toLocaleString()} plants
  `;
}

// ---- popups ---------------------------------------------------------------

function showLinePopup(map, vc, e) {
  const props = e.features[0].properties || {};
  const voltLabel =
    vc.id === "unknown"
      ? "<i>not tagged in OSM</i>"
      : (props.voltage_raw ? `${vc.label} <span style="color:var(--muted)">(${escapeHtml(props.voltage_raw)})</span>` : vc.label);
  const html = `
    <div class="popup-title">${escapeHtml(props.name || vc.label + " line")}</div>
    <div class="popup-row"><b>Voltage</b><span>${voltLabel}</span></div>
    ${props.operator ? `<div class="popup-row"><b>Operator</b><span>${escapeHtml(props.operator)}</span></div>` : ""}
    ${props.power_kind ? `<div class="popup-row"><b>OSM tag</b><span>power=${escapeHtml(props.power_kind)}</span></div>` : ""}
    <div class="popup-source">
      Source: ${escapeHtml(props.source || "osm")}${
        props.osm_id
          ? ` · <a href="https://www.openstreetmap.org/way/${props.osm_id}" target="_blank" rel="noopener">OSM way ${props.osm_id}</a>`
          : ""
      }
    </div>
  `;
  new maplibregl.Popup({ closeButton: true, maxWidth: "320px" })
    .setLngLat(e.lngLat)
    .setHTML(html)
    .addTo(map);
}

function showPointPopup(map, e, fallbackTitle) {
  const props = e.features[0].properties || {};
  const html = `
    <div class="popup-title">${escapeHtml(props.name || fallbackTitle)}</div>
    ${props.voltage ? `<div class="popup-row"><b>Voltage</b><span>${escapeHtml(props.voltage)} V</span></div>` : ""}
    ${props.operator ? `<div class="popup-row"><b>Operator</b><span>${escapeHtml(props.operator)}</span></div>` : ""}
    ${props.plant_source ? `<div class="popup-row"><b>Source</b><span>${escapeHtml(props.plant_source)}</span></div>` : ""}
    ${props.plant_output ? `<div class="popup-row"><b>Output</b><span>${escapeHtml(props.plant_output)}</span></div>` : ""}
    <div class="popup-source">
      Source: ${escapeHtml(props.source || "osm")}${
        props.osm_id
          ? ` · <a href="https://www.openstreetmap.org/${escapeHtml(props.osm_type || "node")}/${props.osm_id}" target="_blank" rel="noopener">OSM ${escapeHtml(props.osm_type)} ${props.osm_id}</a>`
          : ""
      }
    </div>
  `;
  new maplibregl.Popup({ closeButton: true, maxWidth: "320px" })
    .setLngLat(e.lngLat)
    .setHTML(html)
    .addTo(map);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

main().catch((err) => {
  console.error(err);
  document.getElementById("meta-line").textContent = "Failed to load. See console.";
});
