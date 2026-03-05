import fetch from "node-fetch";
import AdmZip from "adm-zip";
import { parse } from "csv-parse/sync";

const GTFS_PUBLIC_URL =
  "https://github.com/septadev/GTFS/releases/latest/download/gtfs_public.zip";

function csvFromZip(zip, name) {
  const entry = zip.getEntry(name);
  if (!entry) throw new Error(`Missing ${name}`);
  return parse(entry.getData().toString("utf8"), { columns: true, skip_empty_lines: true });
}

export async function loadRailShapesGeoJSON() {
  // Download gtfs_public.zip
  const r = await fetch(GTFS_PUBLIC_URL);
  if (!r.ok) throw new Error(`GTFS download failed: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const publicZip = new AdmZip(buf);

  // Find google_rail.zip within gtfs_public.zip
  const railEntry = publicZip.getEntries().find(e => e.entryName.endsWith("google_rail.zip"));
  if (!railEntry) throw new Error("Could not find google_rail.zip inside gtfs_public.zip");

  const railZip = new AdmZip(railEntry.getData());

  // Load shapes.txt
  const shapesRows = csvFromZip(railZip, "shapes.txt");

  // Group points by shape_id
  const byShape = new Map();
  for (const row of shapesRows) {
    const sid = row.shape_id;
    const seq = Number(row.shape_pt_sequence);
    const lat = Number(row.shape_pt_lat);
    const lon = Number(row.shape_pt_lon);
    if (!sid || !Number.isFinite(seq) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!byShape.has(sid)) byShape.set(sid, []);
    byShape.get(sid).push({ seq, lat, lon });
  }

  // Build GeoJSON FeatureCollection (one LineString per shape_id)
  const features = [];
  for (const [shape_id, pts] of byShape.entries()) {
    pts.sort((a, b) => a.seq - b.seq);
    const coords = pts.map(p => [p.lon, p.lat]);
    if (coords.length < 2) continue;

    features.push({
      type: "Feature",
      properties: { shape_id },
      geometry: { type: "LineString", coordinates: coords }
    });
  }

  return { type: "FeatureCollection", features };
}
