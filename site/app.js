// WindSiteIN — static site bootstrap.
// Reads the canonical constraint-layer registry from data/constraints.json
// (copied there by the pipeline; same file the Python build code reads),
// wires up MapLibre layers per constraint, the grouped legend, and popups.

const CONSTRAINTS_URL = "data/constraints.json";
const META_URL = "data/meta.json";
const IN_BBOX = [68.1, 6.7, 97.4, 35.5]; // India bbox [west, south, east, north]

// CartoDB Positron — clean light basemap, no API key needed.
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
  const [registry, meta] = await Promise.all([
    fetch(CONSTRAINTS_URL).then((r) => r.json()),
    fetch(META_URL)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);

  const allLayers = registry.groups.flatMap((g) =>
    g.layers.map((l) => ({ ...l, group_id: g.id, group_label: g.label }))
  );

  renderLegend(registry.groups, meta);
  renderMeta(meta, allLayers);

  const map = new maplibregl.Map({
    container: "map",
    style: BASE_STYLE,
    bounds: IN_BBOX,
    fitBoundsOptions: { padding: 30 },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }), "bottom-left");

  map.on("load", () => {
    // Polygons first (bottom), then lines, then points (top) so nothing gets buried.
    const drawOrder = [
      ...allLayers.filter((l) => l.geometry === "polygon"),
      ...allLayers.filter((l) => l.geometry === "line"),
      ...allLayers.filter((l) => l.geometry === "point"),
    ];
    for (const layer of drawOrder) {
      if (!layer.available || !layer.overpass) continue; // no data file to load
      addConstraintLayer(map, layer);
    }
    wireLegendToggles(map, allLayers);
  });
}

// ---- layer setup ----------------------------------------------------------

function addConstraintLayer(map, layer) {
  const sourceId = `src-${layer.id}`;
  const layerId = `lyr-${layer.id}`;

  map.addSource(sourceId, {
    type: "geojson",
    data: `data/${layer.id}.geojson`,
    promoteId: "osm_id",
  });

  if (layer.geometry === "line") {
    map.addLayer({
      id: layerId,
      type: "line",
      source: sourceId,
      layout: { "line-cap": "round", "line-join": "round", visibility: "none" },
      paint: {
        "line-color": layer.color,
        "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.8, 10, 1.8, 14, 3.2],
        "line-opacity": 0.9,
      },
    });
  } else if (layer.geometry === "polygon") {
    map.addLayer({
      id: layerId,
      type: "fill",
      source: sourceId,
      layout: { visibility: "none" },
      paint: { "fill-color": layer.color, "fill-opacity": 0.35, "fill-outline-color": layer.color },
    });
  } else if (layer.geometry === "point") {
    map.addLayer({
      id: layerId,
      type: "circle",
      source: sourceId,
      layout: { visibility: "none" },
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 2.5, 12, 5.5, 16, 9],
        "circle-color": layer.color,
        "circle-stroke-color": "#1a1d23",
        "circle-stroke-width": 0.7,
        "circle-opacity": 0.9,
      },
    });
  } else {
    return; // raster (e.g. slope) is handled by a separate DEM pipeline, not here
  }

  map.on("click", layerId, (e) => showPopup(map, layer, e));
  map.on("mouseenter", layerId, () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", layerId, () => (map.getCanvas().style.cursor = ""));
}

// ---- legend / toggles -----------------------------------------------------

function renderLegend(groups, meta) {
  const container = document.getElementById("layer-groups");
  const counts = (meta && meta.layer_counts) || {};

  container.innerHTML = groups
    .map((group) => {
      const items = group.layers
        .map((l) => {
          const swatchClass = l.geometry === "point" ? "swatch--point" : l.geometry === "polygon" ? "swatch--polygon" : "swatch";
          const n = counts[l.id];
          const countLabel = l.available && n != null ? `<span class="layer-count">${n.toLocaleString()}</span>` : "";
          const disabled = l.available ? "" : "disabled";
          const liClass = l.available ? "" : "unavailable";
          const title = l.source_note.replace(/"/g, "&quot;");
          return `
            <li class="${liClass}" title="${title}">
              <label>
                <input type="checkbox" data-layer="${l.id}" ${disabled} />
                <span class="${swatchClass}" style="color: ${l.color}; background-color: ${l.geometry === "point" || l.geometry === "polygon" ? l.color : "transparent"};"></span>
                <span class="layer-label">${l.label}</span>
                ${countLabel}
              </label>
            </li>`;
        })
        .join("");
      return `<h2>${group.label}</h2><ul class="layer-list">${items}</ul>`;
    })
    .join("");

  const legend = document.getElementById("legend");
  document.getElementById("legend-toggle").addEventListener("click", () => legend.classList.toggle("open"));
}

function wireLegendToggles(map, allLayers) {
  const checkboxes = [];
  for (const layer of allLayers) {
    if (!layer.available || !layer.overpass) continue;
    const cb = document.querySelector(`input[data-layer="${layer.id}"]`);
    if (!cb) continue;
    checkboxes.push(cb);
    cb.addEventListener("change", () => {
      map.setLayoutProperty(`lyr-${layer.id}`, "visibility", cb.checked ? "visible" : "none");
    });
  }

  document.getElementById("select-all").addEventListener("click", () => {
    checkboxes.forEach((cb) => {
      cb.checked = true;
      cb.dispatchEvent(new Event("change"));
    });
  });
  document.getElementById("select-none").addEventListener("click", () => {
    checkboxes.forEach((cb) => {
      cb.checked = false;
      cb.dispatchEvent(new Event("change"));
    });
  });
}

function renderMeta(meta, allLayers) {
  const el = document.getElementById("meta-line");
  if (!meta || !meta.built_at) {
    el.textContent = "Data not yet built. Run `make refresh` (see pipeline/README).";
    return;
  }
  const builtAt = new Date(meta.built_at).toISOString().slice(0, 10);
  const totalFeatures = Object.values(meta.layer_counts || {}).reduce((s, v) => s + v, 0);
  const availableCount = allLayers.filter((l) => l.available).length;
  el.innerHTML = `
    Last refreshed: ${builtAt}<br />
    Scope: ${escapeHtml(meta.scope || "India")}<br />
    ${totalFeatures.toLocaleString()} features across ${availableCount} layers
  `;
}

// ---- popups ---------------------------------------------------------------

function showPopup(map, layer, e) {
  const props = e.features[0].properties || {};
  const tags = safeParseTags(props.tags);
  const tagRows = Object.entries(tags)
    .slice(0, 6)
    .map(([k, v]) => `<div class="popup-row"><b>${escapeHtml(k)}</b><span>${escapeHtml(v)}</span></div>`)
    .join("");
  const html = `
    <div class="popup-title">${escapeHtml(props.name || layer.label)}</div>
    <div class="popup-row"><b>Layer</b><span>${escapeHtml(layer.label)}</span></div>
    ${tagRows}
    <div class="popup-source">
      ${
        props.osm_id
          ? `<a href="https://www.openstreetmap.org/${escapeHtml(props.osm_type || "way")}/${props.osm_id}" target="_blank" rel="noopener">OSM ${escapeHtml(props.osm_type)} ${props.osm_id}</a>`
          : "OpenStreetMap"
      }
    </div>
  `;
  new maplibregl.Popup({ closeButton: true, maxWidth: "300px" }).setLngLat(e.lngLat).setHTML(html).addTo(map);
}

function safeParseTags(tags) {
  if (!tags) return {};
  if (typeof tags === "object") return tags;
  try {
    return JSON.parse(tags);
  } catch {
    return {};
  }
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
