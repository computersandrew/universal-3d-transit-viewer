// public/app.js
import * as turf from "https://cdn.jsdelivr.net/npm/@turf/turf@7/+esm";
import RBush from "https://cdn.jsdelivr.net/npm/rbush@3.0.1/+esm";

const tokenInput = document.getElementById("token");
const startBtn = document.getElementById("startBtn");
const statusEl = document.getElementById("status");

const POLL_MS = 3000;

// Spatial index search radius (degrees). 0.01 deg ~ ~1.1 km (lat)
const SEARCH_RADIUS_DEG = 0.01;

// Sanity limits
const MAX_SPEED_MPS = 60; // reject insane residuals (~134 mph)
const MAX_JUMP_KM = 2.0;  // reject huge jumps / wrong-branch snaps

// α–β filter gains (tune if desired)
const ALPHA = 0.22; // position correction fraction
const BETA = 0.06;  // velocity correction fraction

// "Stopped" detection to bleed velocity toward 0
const STOP_EPS_KM = 0.015; // ~15m residual ~= no movement
const STOP_BLEED = 0.80;   // multiply v by this if stopped for 2+ polls

// --- Global shape data ---
let shapesFC = null;          // FeatureCollection of LineStrings
let shapeMeta = null;         // [{ bbox, len_km }]
let shapeIndex = new RBush(); // RBush index over segments
let indexedSegments = 0;

// --- Train state ---
/*
train state:
{
  marker, el, speedLabel,
  lockedShapeIdx,
  shapeIdx, lineLen_km,

  // last measurement
  s_meas_km, t_meas_ms,

  // continuous filter state
  s_est_km, v_est_kmps, t_est_ms,

  stillCount
}
*/
const trains = new Map();

function setStatus(msg) {
  statusEl.textContent = msg;
}

function parseConsist(consist) {
  if (!consist) return [];
  return String(consist)
    .split(",")
    .map(s => parseInt(s.trim(), 10))
    .filter(Number.isFinite);
}

// Heuristic fleet classification
function classifyEquipment(nums) {
  const hasACS64 = nums.some(n => n >= 901 && n <= 915);
  const hasCabCar = nums.some(n => n >= 2400 && n <= 2499);
  const coachCount = nums.filter(n => n >= 2500 && n <= 2599).length;

  if (hasACS64) {
    if (hasCabCar && coachCount >= 1) return "Push-Pull (ACS-64 + Cab + Coaches)";
    if (coachCount >= 1) return "Push-Pull (ACS-64 + Coaches)";
    return "Push-Pull (ACS-64)";
  }

  const hasSLV = nums.some(n => (n >= 701 && n <= 738) || (n >= 801 && n <= 882));
  if (hasSLV) return "Silverliner V (EMU)";

  const hasSLIV = nums.some(n => (n >= 101 && n <= 188) || (n >= 200 && n <= 499));
  if (hasSLIV) return "Silverliner IV (EMU)";

  return "Unknown / Mixed";
}

function mphFromKmps(v_kmps) {
  const mps = v_kmps * 1000;
  return mps * 2.2369362920544;
}

async function fetchTrainView() {
  const r = await fetch("/api/septa/trainview");
  if (!r.ok) throw new Error(`TrainView error: ${r.status}`);
  return await r.json();
}

async function loadShapesAndIndex(map) {
  setStatus("Loading GTFS rail shapes…");

  const r = await fetch("/api/gtfs/rail/shapes");
  if (!r.ok) throw new Error(`GTFS shapes error: ${r.status}`);
  shapesFC = await r.json();

  shapeMeta = shapesFC.features.map(f => ({
    bbox: turf.bbox(f),
    len_km: turf.length(f, { units: "kilometers" })
  }));

  // Build RBush over segments
  shapeIndex.clear();
  indexedSegments = 0;

  shapesFC.features.forEach((feature, shapeIdx) => {
    const coords = feature.geometry.coordinates;
    for (let i = 0; i < coords.length - 1; i++) {
      const [x1, y1] = coords[i];
      const [x2, y2] = coords[i + 1];
      shapeIndex.insert({
        minX: Math.min(x1, x2),
        minY: Math.min(y1, y2),
        maxX: Math.max(x1, x2),
        maxY: Math.max(y1, y2),
        shapeIdx
      });
      indexedSegments++;
    }
  });

  // Render tracks
  if (!map.getSource("rail-shapes")) {
    map.addSource("rail-shapes", { type: "geojson", data: shapesFC });
    map.addLayer({
      id: "rail-shapes",
      type: "line",
      source: "rail-shapes",
      paint: {
        "line-width": 2.5,
        "line-opacity": 0.65
      }
    });
  } else {
    map.getSource("rail-shapes").setData(shapesFC);
  }

  setStatus(`Loaded shapes: ${shapesFC.features.length} (segments indexed: ${indexedSegments}).`);
}

function snapToTrack(lng, lat, preferredShapeIdx = null) {
  if (!shapesFC || !shapeMeta) return null;
  const pt = turf.point([lng, lat]);

  // 1) Try locked shape first
  if (preferredShapeIdx != null && shapesFC.features[preferredShapeIdx]) {
    const f = shapesFC.features[preferredShapeIdx];
    const snap = turf.nearestPointOnLine(f, pt, { units: "kilometers" });
    const dist_km = snap.properties.dist;
    const loc_km = snap.properties.location;
    if (loc_km != null && dist_km != null && dist_km <= 0.35) {
      return {
        shapeIdx: preferredShapeIdx,
        dist_km,
        loc_km,
        len_km: shapeMeta[preferredShapeIdx].len_km
      };
    }
  }

  // 2) Candidate shapes from RBush nearby segments
  const candidates = shapeIndex.search({
    minX: lng - SEARCH_RADIUS_DEG,
    minY: lat - SEARCH_RADIUS_DEG,
    maxX: lng + SEARCH_RADIUS_DEG,
    maxY: lat + SEARCH_RADIUS_DEG
  });

  if (!candidates || candidates.length === 0) return null;

  const unique = new Set();
  for (const c of candidates) unique.add(c.shapeIdx);

  let best = null;
  for (const shapeIdx of unique) {
    const f = shapesFC.features[shapeIdx];
    const snap = turf.nearestPointOnLine(f, pt, { units: "kilometers" });
    const dist_km = snap.properties.dist;
    const loc_km = snap.properties.location;
    if (loc_km == null || dist_km == null) continue;

    if (!best || dist_km < best.dist_km) {
      best = {
        shapeIdx,
        dist_km,
        loc_km,
        len_km: shapeMeta[shapeIdx].len_km
      };
    }
  }

  return best;
}

function pointOnShape(shapeIdx, s_km) {
  const len = shapeMeta[shapeIdx].len_km;
  const s = Math.max(0, Math.min(len, s_km));
  const p = turf.along(shapesFC.features[shapeIdx], s, { units: "kilometers" });
  return p.geometry.coordinates; // [lng, lat]
}

function bearingOnShape(shapeIdx, s_km) {
  const len = shapeMeta[shapeIdx].len_km;
  const s = Math.max(0, Math.min(len, s_km));
  const a = Math.max(0, s - 0.02);
  const b = Math.min(len, s + 0.02);
  const pa = turf.along(shapesFC.features[shapeIdx], a, { units: "kilometers" });
  const pb = turf.along(shapesFC.features[shapeIdx], b, { units: "kilometers" });
  return turf.bearing(pa, pb);
}

function makeTrainElement() {
  const el = document.createElement("div");
  el.className = "train";

  const speedLabel = document.createElement("div");
  speedLabel.style.position = "absolute";
  speedLabel.style.top = "-16px";
  speedLabel.style.left = "50%";
  speedLabel.style.transform = "translateX(-50%)";
  speedLabel.style.font = "10px/1.1 system-ui, -apple-system, Segoe UI, Roboto, Arial";
  speedLabel.style.color = "white";
  speedLabel.style.textShadow = "0 1px 2px rgba(0,0,0,.9)";
  speedLabel.style.whiteSpace = "nowrap";
  speedLabel.textContent = "";
  el.appendChild(speedLabel);

  return { el, speedLabel };
}

function start(map) {
  async function poll() {
    try {
      const data = await fetchTrainView();
      const nowPerf = performance.now();

      setStatus(`Tracks: ${shapesFC?.features?.length ?? 0} | Trains: ${data.length}`);

      for (const tr of data) {
        const trainno = String(tr.trainno ?? "").trim();
        const rawLat = Number(tr.lat);
        const rawLng = Number(tr.lon);

        if (!trainno || !Number.isFinite(rawLat) || !Number.isFinite(rawLng)) continue;

        const existing = trains.get(trainno) || null;
        const lockIdx = existing ? existing.lockedShapeIdx : null;

        const snapped = snapToTrack(rawLng, rawLat, lockIdx);
        if (!snapped) continue;

        const shapeIdx = snapped.shapeIdx;
        const s_meas_km = snapped.loc_km;
        const lineLen_km = snapped.len_km;

        const nums = parseConsist(tr.consist);
        const equip = classifyEquipment(nums);
        const vehicles = Math.max(1, nums.length);

        // Create train
        if (!existing) {
          const { el, speedLabel } = makeTrainElement();
          el.style.width = `${14 + vehicles * 7}px`;

          const [lng0, lat0] = pointOnShape(shapeIdx, s_meas_km);
          const hdg0 = bearingOnShape(shapeIdx, s_meas_km);

          const popupHtml = `
            <div style="font:12px/1.35 system-ui">
              <div style="font-weight:800;">Train ${trainno} — ${tr.line ?? ""}</div>
              <div>To: ${tr.dest ?? ""}</div>
              <div>Now: ${tr.currentstop ?? ""}</div>
              <div>Next: ${tr.nextstop ?? ""}</div>
              <div>Late: ${tr.late ?? 0} min</div>
              <div style="margin-top:6px; font-weight:700;">${equip}</div>
              <div style="opacity:.9;">Consist: ${tr.consist ?? ""}</div>
              <div style="margin-top:6px; opacity:.9;">Speed: (estimated)</div>
            </div>
          `;

          const marker = new mapboxgl.Marker({ element: el, rotationAlignment: "map" })
            .setLngLat([lng0, lat0])
            .setRotation(hdg0 || 0)
            .setPopup(new mapboxgl.Popup({ offset: 12 }).setHTML(popupHtml))
            .addTo(map);

          trains.set(trainno, {
            marker, el, speedLabel,

            lockedShapeIdx: shapeIdx,
            shapeIdx,
            lineLen_km,

            s_meas_km,
            t_meas_ms: nowPerf,

            s_est_km: s_meas_km,
            v_est_kmps: 0,
            t_est_ms: nowPerf,

            stillCount: 0
          });

          continue;
        }

        // Update sizing
        existing.el.style.width = `${14 + vehicles * 7}px`;

        // --- α–β filter update ---
        // 1) Predict to now from last estimate
        const dt_s = Math.max(0.05, (nowPerf - existing.t_est_ms) / 1000.0);
        let s_pred = existing.s_est_km + existing.v_est_kmps * dt_s;

        // clamp prediction
        s_pred = Math.max(0, Math.min(existing.lineLen_km, s_pred));

        // 2) Residual vs measurement
        const r_km = s_meas_km - s_pred;

        // sanity reject (branch hops / glitches)
        const v_implied_mps = Math.abs(r_km / dt_s) * 1000.0;
        if (Math.abs(r_km) > MAX_JUMP_KM || v_implied_mps > MAX_SPEED_MPS) {
          existing.lockedShapeIdx = shapeIdx;
          existing.shapeIdx = shapeIdx;
          existing.lineLen_km = lineLen_km;

          existing.s_meas_km = s_meas_km;
          existing.t_meas_ms = nowPerf;

          existing.s_est_km = s_meas_km;
          existing.v_est_kmps *= 0.5;
          existing.t_est_ms = nowPerf;
          existing.stillCount = 0;
          continue;
        }

        // 3) Correct
        existing.s_est_km = s_pred + ALPHA * r_km;
        existing.v_est_kmps = existing.v_est_kmps + (BETA * r_km) / dt_s;
        existing.t_est_ms = nowPerf;

        // Update bookkeeping + lock
        existing.lockedShapeIdx = shapeIdx;
        existing.shapeIdx = shapeIdx;
        existing.lineLen_km = lineLen_km;

        existing.s_meas_km = s_meas_km;
        existing.t_meas_ms = nowPerf;

        // Stop bleed
        if (Math.abs(r_km) < STOP_EPS_KM) {
          existing.stillCount = (existing.stillCount || 0) + 1;
          if (existing.stillCount >= 2) existing.v_est_kmps *= STOP_BLEED;
        } else {
          existing.stillCount = 0;
        }
      }
    } catch (e) {
      setStatus(`Error polling: ${e}`);
    }

    setTimeout(poll, POLL_MS);
  }

  function animate() {
    const nowPerf = performance.now();

    for (const st of trains.values()) {
      const dt_s = Math.max(0, (nowPerf - st.t_est_ms) / 1000.0);
      let s = st.s_est_km + st.v_est_kmps * dt_s;

      // clamp to line
      s = Math.max(0, Math.min(st.lineLen_km, s));

      const [lng, lat] = pointOnShape(st.shapeIdx, s);
      const hdg = bearingOnShape(st.shapeIdx, s);

      st.marker.setLngLat([lng, lat]);
      st.marker.setRotation(hdg || 0);

      const mph = mphFromKmps(st.v_est_kmps);
      st.speedLabel.textContent = `${Math.max(0, mph).toFixed(0)} mph`;
    }

    requestAnimationFrame(animate);
  }

  poll();
  animate();
}

function boot() {
  const token = tokenInput.value.trim();
  if (!token || !token.startsWith("pk.")) {
    setStatus("Use a Mapbox public token starting with pk.");
    return;
  }

  mapboxgl.accessToken = token;

  const map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/satellite-streets-v12",
    center: [-75.1652, 39.9526],
    zoom: 10.8,
    pitch: 65,
    bearing: -20,
    antialias: true
  });

  map.on("load", async () => {
    // 3D terrain + sky
    map.addSource("mapbox-dem", {
      type: "raster-dem",
      url: "mapbox://mapbox.mapbox-terrain-dem-v1",
      tileSize: 512,
      maxzoom: 14
    });
    map.setTerrain({ source: "mapbox-dem", exaggeration: 1.2 });
    map.addLayer({ id: "sky", type: "sky", paint: { "sky-type": "atmosphere" } });

    await loadShapesAndIndex(map);
    start(map);
  });

  map.on("error", (e) => setStatus(`Map error: ${e?.error?.message ?? "unknown"}`));
  setStatus("Map loading…");
}

startBtn.addEventListener("click", boot);
