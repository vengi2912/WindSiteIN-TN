// OpenGridIN - Consolidated JS (Basemap Auto-Recovery + Filter + City Search)
const VOLTAGE_CLASSES_URL = "data/voltage_classes.json";
const META_URL = "data/meta.json";
const IN_BBOX = [68.1, 6.7, 97.4, 35.5]; 

const SUBSTATION_COLOR = "#ffd166";
const GENERATION_COLOR = "#ef476f";

const POSITRON_STYLE = {
  version: 8,
  sources: {
    positron: {
      type: "raster",
      tiles: ["https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png", "https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png", "https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"],
      tileSize: 256, maxzoom: 19, attribution: "© OpenStreetMap contributors © CARTO",
    },
  },
  layers: [{ id: "base-raster", type: "raster", source: "positron" }],
};

const SATELLITE_STYLE = {
  version: 8,
  sources: {
    google_satellite: {
      type: "raster",
      tiles: ["https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}"],
      tileSize: 256, maxzoom: 20, attribution: "© Google Earth / Satellite",
    },
  },
  layers: [{ id: "base-raster", type: "raster", source: "google_satellite" }],
};

// Global State
window.appState = {
  voltageClasses: [],
  activeFilter: null
};

async function main() {
  const [voltageRegistry, meta] = await Promise.all([
    fetch(VOLTAGE_CLASSES_URL).then((r) => r.json()),
    fetch(META_URL).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);

  window.appState.voltageClasses = voltageRegistry.classes;
  renderLegend(window.appState.voltageClasses, meta);
  renderMeta(meta);

  const map = new maplibregl.Map({
    container: "map",
    style: POSITRON_STYLE,
    bounds: IN_BBOX,
    fitBoundsOptions: { padding: 30 },
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }), "bottom-left");

  map.on("load", () => {
    initMapLayers(map);
    setupUIBasemapSwitcher(map);
    setupAttributeFilter(map);
    setupCitySearch(map);
    wireLegendTogglesOnce(map, window.appState.voltageClasses);
  });

  // AUTO-RECOVERY: Automatically re-add layers if basemap wipes them out
  map.on("styledata", () => {
    if (map.isStyleLoaded() && !map.getSource("substations") && window.appState.voltageClasses.length > 0) {
      initMapLayers(map);
    }
  });
}

// 1. Initialize Map Layers and Restore Checkbox States
function initMapLayers(map) {
  const drawOrder = [...window.appState.voltageClasses].reverse();
  
  // Re-add Voltage Lines
  for (const vc of drawOrder) {
    addVoltageLayer(map, vc);
    const cb = document.querySelector(`input[data-voltage="${vc.id}"]`);
    if (cb && !cb.checked) map.setLayoutProperty(`lines-${vc.id}-layer`, "visibility", "none");
  }

  // Re-add Substations
  addSubstationsLayer(map);
  const subCb = document.querySelector(`input[data-layer="substations"]`);
  if (subCb && !subCb.checked) map.setLayoutProperty("substations-layer", "visibility", "none");

  // Re-add Generation Plants
  addGenerationLayer(map);
  const genCb = document.querySelector(`input[data-layer="generation"]`);
  if (genCb && !genCb.checked) map.setLayoutProperty("generation-layer", "visibility", "none");

  // Re-apply Filters
  if (window.appState.activeFilter) {
     applyFilterToAll(map, window.appState.activeFilter);
  }
}

// 2. Basemap Switcher Logic
function setupUIBasemapSwitcher(map) {
  const radios = document.querySelectorAll('input[name="basemap"]');
  radios.forEach((radio) => {
    radio.addEventListener('change', (e) => {
      const selectedStyle = e.target.value === 'satellite' ? SATELLITE_STYLE : POSITRON_STYLE;
      map.setStyle(selectedStyle);
    });
  });
}

// 3. Attribute Filter Logic
function setupAttributeFilter(map) {
  const applyBtn = document.getElementById('apply-filter');
  const clearBtn = document.getElementById('clear-filter');
  const fieldSelect = document.getElementById('filter-field');
  const valueInput = document.getElementById('filter-value');

  applyBtn.addEventListener('click', () => {
    const field = fieldSelect.value;
    const val = valueInput.value.trim();
    if (!val) { alert("Please enter a value to filter!"); return; }
    
    window.appState.activeFilter = ['==', ['get', field], val];
    applyFilterToAll(map, window.appState.activeFilter);
  });

  clearBtn.addEventListener('click', () => {
    valueInput.value = '';
    window.appState.activeFilter = null;
    applyFilterToAll(map, null);
  });
}

function applyFilterToAll(map, filterExpr) {
   const allLayers = window.appState.voltageClasses.map(vc => `lines-${vc.id}-layer`)
    .concat(['substations-layer', 'generation-layer']);
   
   allLayers.forEach(layerId => {
      if (map.getLayer(layerId)) {
        map.setFilter(layerId, filterExpr);
      }
   });
}

// 4. City Search Logic
function setupCitySearch(map) {
  const searchInput = document.getElementById('search-city-input');
  const searchBtn = document.getElementById('search-city-btn');

  searchBtn.addEventListener('click', async () => {
    const query = searchInput.value.trim();
    if (!query) { alert("Please enter a city name!"); return; }

    try {
      searchBtn.innerText = "Searching...";
      searchBtn.disabled = true;

      const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=in&limit=1`);
      const data = await response.json();

      if (data && data.length > 0) {
        const result = data[0];
        map.flyTo({ center: [parseFloat(result.lon), parseFloat(result.lat)], zoom: 11, essential: true });
      } else {
        alert("City not found in India! Please try another name.");
      }
    } catch (error) {
      console.error("Geocoding error:", error);
      alert("Search error. Please try again.");
    } finally {
      searchBtn.innerText = "Search City";
      searchBtn.disabled = false;
    }
  });

  searchInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') searchBtn.click(); });
}

// ---- Layer Generators & Events ----
function addVoltageLayer(map, vc) {
  const sourceId = `lines-${vc.id}`;
  const layerId = `lines-${vc.id}-layer`;

  map.addSource(sourceId, { type: "geojson", data: `data/${vc.geojson_filename}`, promoteId: "osm_id" });

  const widthScale = vc.id === "unknown" ? 0.6 : voltageWidthScale(vc.voltage_v);
  const paint = {
    "line-color": vc.color,
    "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.5 * widthScale, 8, 1.4 * widthScale, 12, 3.0 * widthScale, 16, 5.0 * widthScale],
    "line-opacity": vc.id === "unknown" ? 0.55 : 0.95,
  };
  if (vc.line_dash) paint["line-dasharray"] = vc.line_dash;

  map.addLayer({
    id: layerId, type: "line", source: sourceId, minzoom: vc.min_zoom_visible,
    layout: { "line-cap": "round", "line-join": "round", visibility: "visible" }, paint,
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
    id: "substations-layer", type: "circle", source: "substations", minzoom: 7,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 2.2, 12, 6, 16, 9],
      "circle-color": SUBSTATION_COLOR, "circle-stroke-color": "#1a1d23",
      "circle-stroke-width": 0.8, "circle-opacity": 0.95,
    },
  });
  map.on("click", "substations-layer", (e) => showPointPopup(map, e, "Substation"));
  map.on("mouseenter", "substations-layer", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "substations-layer", () => (map.getCanvas().style.cursor = ""));
}

function addGenerationLayer(map) {
  map.addSource("generation", { type: "geojson", data: "data/generation.geojson" });
  map.addLayer({
    id: "generation-layer", type: "circle", source: "generation", minzoom: 5,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 3, 12, 7.5, 16, 11],
      "circle-color": GENERATION_COLOR, "circle-stroke-color": "#1a1d23",
      "circle-stroke-width": 0.8, "circle-opacity": 0.95,
    },
  });
  map.on("click", "generation-layer", (e) => showPointPopup(map, e, "Generation plant"));
  map.on("mouseenter", "generation-layer", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "generation-layer", () => (map.getCanvas().style.cursor = ""));
}

function renderLegend(voltageClasses, meta) {
  const list = document.getElementById("voltage-list");
  const counts = (meta && meta.line_counts) || {};
  list.innerHTML = voltageClasses.map((vc) => {
    const n = counts[vc.id];
    const countLabel = n != null ? `<span class="layer-count">${n.toLocaleString()}</span>` : "";
    return `<li><label><input type="checkbox" data-voltage="${vc.id}" checked />
            <span class="swatch" style="color: ${vc.color}"></span>${vc.label}${countLabel}</label></li>`;
  }).join("");

  document.getElementById("legend-toggle").addEventListener("click", () => {
    document.getElementById("legend").classList.toggle("open");
  });
}

function wireLegendTogglesOnce(map, voltageClasses) {
  for (const vc of voltageClasses) {
    const cb = document.querySelector(`input[data-voltage="${vc.id}"]`);
    if (cb) {
      cb.addEventListener("change", () => {
        if (map.getLayer(`lines-${vc.id}-layer`)) map.setLayoutProperty(`lines-${vc.id}-layer`, "visibility", cb.checked ? "visible" : "none");
      });
    }
  }
  const subCb = document.querySelector(`input[data-layer="substations"]`);
  if (subCb) {
     subCb.addEventListener("change", () => {
        if (map.getLayer("substations-layer")) map.setLayoutProperty("substations-layer", "visibility", subCb.checked ? "visible" : "none");
     });
  }
  const genCb = document.querySelector(`input[data-layer="generation"]`);
  if (genCb) {
     genCb.addEventListener("change", () => {
        if (map.getLayer("generation-layer")) map.setLayoutProperty("generation-layer", "visibility", genCb.checked ? "visible" : "none");
     });
  }
}

function renderMeta(meta) {
  const el = document.getElementById("meta-line");
  if (!meta || !meta.built_at) { el.textContent = "Data not yet built."; return; }
  const builtAt = new Date(meta.built_at).toISOString().slice(0, 10);
  const totalKm = Object.values(meta.line_lengths_km || {}).reduce((s, v) => s + v, 0);
  el.innerHTML = `Last refreshed: ${builtAt} | ${Math.round(totalKm).toLocaleString()} km lines`;
}

function showLinePopup(map, vc, e) {
  const props = e.features[0].properties || {};
  const voltLabel = props.voltage_raw ? `${vc.label} <span style="color:var(--muted)">(${escapeHtml(props.voltage_raw)})</span>` : vc.label;
  new maplibregl.Popup({ closeButton: true, maxWidth: "320px" }).setLngLat(e.lngLat)
    .setHTML(`<div class="popup-title">${escapeHtml(props.name || vc.label + " line")}</div>
              <div class="popup-row"><b>Voltage</b><span>${voltLabel}</span></div>
              <div class="popup-row"><b>Operator</b><span>${escapeHtml(props.operator || 'Unknown')}</span></div>`)
    .addTo(map);
}

function showPointPopup(map, e, fallbackTitle) {
  const props = e.features[0].properties || {};
  new maplibregl.Popup({ closeButton: true, maxWidth: "320px" }).setLngLat(e.lngLat)
    .setHTML(`<div class="popup-title">${escapeHtml(props.name || fallbackTitle)}</div>
              <div class="popup-row"><b>Operator</b><span>${escapeHtml(props.operator || 'Unknown')}</span></div>`)
    .addTo(map);
}

function escapeHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

main().catch((err) => console.error(err));