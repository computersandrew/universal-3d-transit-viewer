import express from "express";
import fetch from "node-fetch";
import { loadRailShapesGeoJSON } from "./gtfs.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

// --- TrainView cache ---
let trainCache = { t: 0, data: null };
const TRAIN_CACHE_MS = 2500;

app.get("/api/septa/trainview", async (req, res) => {
  try {
    const now = Date.now();
    if (trainCache.data && (now - trainCache.t) < TRAIN_CACHE_MS) {
      return res.json(trainCache.data);
    }

    const url = "https://www3.septa.org/api/TrainView/index.php";
    const r = await fetch(url, { headers: { "User-Agent": "universal-3d-transit-viewer/1.0" } });
    if (!r.ok) return res.status(502).json({ error: `Upstream error: ${r.status}` });

    const data = await r.json();
    trainCache = { t: now, data };
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// --- GTFS shapes cache (reload occasionally) ---
let shapesCache = { t: 0, fc: null };
const SHAPES_REFRESH_MS = 6 * 60 * 60 * 1000; // 6 hours

async function ensureShapesLoaded() {
  const now = Date.now();
  if (shapesCache.fc && (now - shapesCache.t) < SHAPES_REFRESH_MS) return;
  const fc = await loadRailShapesGeoJSON();
  shapesCache = { t: now, fc };
  console.log(`Loaded rail shapes: ${fc.features.length}`);
}

app.get("/api/gtfs/rail/shapes", async (req, res) => {
  try {
    await ensureShapesLoaded();
    res.json(shapesCache.fc);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => console.log(`http://0.0.0.0:${PORT}`));
