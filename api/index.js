import axios from "axios";
import cors from "cors";
import express from "express";

const app = express();
app.use(cors());

const BASE = "https://dati.comune.roma.it/catalog/api/3/action";

// test
app.get("/", (req, res) => {
  res.json({ status: "ok", api: "roma-openapi" });
});

// lista dataset (pulita)
app.get("/datasets", async (req, res) => {
  try {
    const list = await axios.get(`${BASE}/package_list`);
    const ids = list.data.result.slice(0, 50);

    const out = [];

    for (const id of ids) {
      try {
        const r = await axios.get(`${BASE}/package_show`, {
          params: { id }
        });

        const p = r.data.result;

        out.push({
          codice: p.name,
          servizio: p.title
        });
      } catch {}
    }

    res.json(out);
  } catch (e) {
    res.status(500).json({ error: "CKAN error" });
  }
});

// search
app.get("/search", async (req, res) => {
  try {
    const q = req.query.q || "";

    const r = await axios.get(`${BASE}/package_search`, {
      params: { q, rows: 20 }
    });

    res.json(
      r.data.result.results.map(p => ({
        codice: p.name,
        servizio: p.title
      }))
    );
  } catch {
    res.status(500).json({ error: "search error" });
  }
});

export default app;