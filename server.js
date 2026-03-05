import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

app.get("/api/septa/trainview", async (req, res) => {
  try {
    const url = "https://www3.septa.org/api/TrainView/index.php";
    const r = await fetch(url, { headers: { "User-Agent": "universal-3d-transit-viewer/1.0" } });
    if (!r.ok) return res.status(502).json({ error: `Upstream error: ${r.status}` });
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => console.log(`http://0.0.0.0:${PORT}`));
