import axios from "axios";
import cors from "cors";
import express from "express";

const app = express();
app.use(cors());

const GOV_AXIOS_CONFIG = {
  timeout: 8000,
  headers: {
    "User-Agent": "Mozilla/5.0 (compatible; RomaAppBFF/1.0)",
    Accept: "application/json, text/csv, text/plain",
  },
};

// ---------------------------------------------------------------------------
// Helper CSV — parse manuale senza papaparse (zero dipendenze extra)
// ---------------------------------------------------------------------------
function parseCsv(text, delimiter = ",") {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(delimiter).map((h) => h.trim().replace(/^"|"$/g, ""));
  return lines.slice(1).map((line) => {
    const values = line.split(delimiter).map((v) => v.trim().replace(/^"|"$/g, ""));
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ""]));
  });
}

// ---------------------------------------------------------------------------
// Helper RSS — parse manuale senza rss-parser (zero dipendenze extra)
// ---------------------------------------------------------------------------
function parseRss(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, "i"))
        || block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
      return m ? m[1].trim() : "";
    };
    const imgMatch = block.match(/<media:thumbnail[^>]+url="([^"]+)"/i)
      || block.match(/<enclosure[^>]+url="([^"]+)"/i);
    items.push({
      title: get("title"),
      description: get("description"),
      link: get("link"),
      pubDate: get("pubDate"),
      category: get("category"),
      image: imgMatch ? imgMatch[1] : null,
    });
  }
  return items;
}

// ===========================================================================
// 1. POI — /poi?type=nasoni|farmacie|wifi
// ===========================================================================
app.get("/poi", async (req, res) => {
  const filterType = req.query.type || "nasoni";

  try {
    // NASONI — Overpass API (OSM, tag amenity=drinking_water, BBOX Roma)
    if (filterType === "nasoni") {
      const query = `[out:json][timeout:25];node["amenity"="drinking_water"](41.7,12.3,42.0,12.6);out body;`;
      const response = await axios.post(
        "https://overpass-api.de/api/interpreter",
        `data=${encodeURIComponent(query)}`,
        {
          ...GOV_AXIOS_CONFIG,
          headers: { ...GOV_AXIOS_CONFIG.headers, "Content-Type": "application/x-www-form-urlencoded" },
        }
      );
      const elements = response.data?.elements || [];
      return res.json(
        elements.map((el) => ({
          id: `nasone-${el.id}`,
          type: "nasoni",
          title: el.tags?.name || "Nasone Pubblico",
          description:
            [el.tags?.["addr:street"], el.tags?.["addr:housenumber"]].filter(Boolean).join(" ") ||
            "Fontanella pubblica ACEA",
          latitude: el.lat,
          longitude: el.lon,
          operational: el.tags?.operational_status !== "broken",
          seasonal: el.tags?.seasonal === "yes",
        }))
      );
    }

    // FARMACIE — Overpass API (OSM, tag amenity=pharmacy, BBOX Roma)
    // Usiamo Overpass anche per le farmacie: più completo delle sole comunali
    // e zero dipendenze CSV.
    if (filterType === "farmacie") {
      const query = `[out:json][timeout:25];node["amenity"="pharmacy"](41.7,12.3,42.0,12.6);out body;`;
      const response = await axios.post(
        "https://overpass-api.de/api/interpreter",
        `data=${encodeURIComponent(query)}`,
        {
          ...GOV_AXIOS_CONFIG,
          headers: { ...GOV_AXIOS_CONFIG.headers, "Content-Type": "application/x-www-form-urlencoded" },
        }
      );
      const elements = response.data?.elements || [];
      return res.json(
        elements.map((el) => ({
          id: `farmacia-${el.id}`,
          type: "farmacie",
          title: el.tags?.name || "Farmacia",
          description:
            [el.tags?.["addr:street"], el.tags?.["addr:housenumber"]].filter(Boolean).join(" ") ||
            "Farmacia Roma",
          latitude: el.lat,
          longitude: el.lon,
          phone: el.tags?.phone || el.tags?.["contact:phone"] || null,
          openingHours: el.tags?.opening_hours || null,
        }))
      );
    }

    // WIFI — dati.comune.roma.it, dataset Digit Roma WiFi (CSV statico)
    if (filterType === "wifi") {
      const wifiCsvUrl =
        "https://dati.comune.roma.it/catalog/dataset/" +
        "df7b41a7-3a10-4142-a400-1f6754064402/resource/" +
        "2a7d30e8-1409-4216-a34d-4a7af3232ca7/download/sedi_digitromawifi2020_.csv";

      const response = await axios.get(wifiCsvUrl, { ...GOV_AXIOS_CONFIG, responseType: "text" });

      // Prova ; poi , come delimiter
      let records = parseCsv(response.data, ";");
      if (records.length === 0) records = parseCsv(response.data, ",");

      const mapped = records
        .map((item, i) => ({
          id: item.CODICE_SEDE || item.ID || `wifi-${i}`,
          type: "wifi",
          title: `WiFi — ${item.NOME_SEDE || item.DENOMINAZIONE || "Sede Digit Roma"}`,
          description: item.INDIRIZZO || item.VIA || "Hotspot pubblico Roma Capitale",
          latitude: parseFloat((item.LATITUDINE || item.LAT || "").replace(",", ".")),
          longitude: parseFloat((item.LONGITUDINE || item.LON || "").replace(",", ".")),
          municipio: item.MUNICIPIO || null,
        }))
        .filter((w) => !isNaN(w.latitude) && !isNaN(w.longitude));

      return res.json(mapped);
    }

    return res.status(400).json({ error: "Tipo POI non valido. Usa: nasoni | farmacie | wifi" });
  } catch (error) {
    console.error(`[POI Error] tipo="${filterType}":`, error.message);
    return res.status(502).json({ error: "Sorgente dati non disponibile", detail: error.message });
  }
});

// ===========================================================================
// 2. EVENTI — /events
// Fonte: feed RSS turismoroma.it — parse manuale, zero dipendenze
// ===========================================================================
app.get("/events", async (req, res) => {
  const RSS_URLS = [
    "https://www.turismoroma.it/it/eventi/rss.xml",
    "https://www.turismoroma.it/it/rss.xml",
  ];

  for (const url of RSS_URLS) {
    try {
      const response = await axios.get(url, { ...GOV_AXIOS_CONFIG, responseType: "text", timeout: 6000 });
      const items = parseRss(response.data);
      if (items.length === 0) continue;

      return res.json(
        items.slice(0, 40).map((item, i) => ({
          id: item.link || `evento-${i}`,
          title: item.title || "Evento Culturale",
          description: item.description || "",
          date: item.pubDate ? new Date(item.pubDate).toLocaleDateString("it-IT") : "In corso",
          link: item.link || "https://www.turismoroma.it",
          category: item.category || null,
          image: item.image || null,
        }))
      );
    } catch (err) {
      console.warn(`[Events] ${url} fallito:`, err.message);
    }
  }

  // Fallback statico
  return res.json([
    { id: "e1", title: "Scopri gli eventi di Roma", description: "Tutti gli eventi culturali della Capitale.", date: "Oggi", link: "https://www.turismoroma.it/it/eventi", category: "cultura", image: null },
  ]);
});

// ===========================================================================
// 3. TRAFFICO — /traffic
// Fonte: Roma Mobilità — feed JSON alert (no protobuf, no dipendenze native)
// URL alert JSON: romamobilita.it (fallback su array informativo se offline)
// ===========================================================================

const TRAFFIC_FALLBACK = [
  {
    feed: "alerts",
    title: "Avvisi Mobilità Roma",
    description: "Dati temporaneamente non disponibili. Consulta romamobilita.it per aggiornamenti.",
    severity: "unknown",
    effect: null,
    routes: [],
    data: [],
    source: "https://romamobilita.it",
  },
];

app.get("/traffic", async (req, res) => {
  // Roma Mobilità espone gli alert anche in JSON (stesso contenuto del .pb ma leggibile)
  const ALERT_URLS = [
    "https://romamobilita.it/sites/default/files/rome_alerts.json",
    "https://dati.comune.roma.it/catalog/dataset/a7dadb4a-66ae-4eff-8ded-a102064702ba/resource/d2b123d6-8d2d-4dee-9792-f535df3dc166/download/rome_vehicle_positions.pb",
  ];

  try {
    const response = await axios.get(ALERT_URLS[0], { ...GOV_AXIOS_CONFIG, timeout: 5000 });
    const entities = response.data?.entity || [];

    if (entities.length === 0) return res.json(TRAFFIC_FALLBACK);

    const alerts = entities
      .filter((e) => e.alert)
      .map((e) => ({
        feed: "alerts",
        id: e.id,
        type: "alert",
        title: e.alert?.headerText?.translation?.[0]?.text || "Avviso di servizio",
        description: e.alert?.descriptionText?.translation?.[0]?.text || "",
        severity: mapSeverity(e.alert?.severityLevel),
        effect: e.alert?.effect || null,
        routes: (e.alert?.informedEntity || []).map((ie) => ie.routeId).filter(Boolean),
        activePeriod: (e.alert?.activePeriod || []).map((p) => ({
          start: p.start ? new Date(Number(p.start) * 1000).toISOString() : null,
          end: p.end ? new Date(Number(p.end) * 1000).toISOString() : null,
        })),
        data: [],
        source: "https://romamobilita.it",
      }));

    return res.json(alerts.length ? alerts : TRAFFIC_FALLBACK);
  } catch (err) {
    console.warn("[Traffic] feed JSON non disponibile:", err.message);
    return res.json(TRAFFIC_FALLBACK);
  }
});

function mapSeverity(level) {
  if (!level) return "unknown";
  if (level === "SEVERE") return "high";
  if (level === "WARNING") return "medium";
  return "low";
}

// ===========================================================================
// 4. GTFS STATICO — /gtfs-static (redirect)
// ===========================================================================
app.get("/gtfs-static", (_req, res) => {
  res.redirect(
    "https://dati.comune.roma.it/catalog/dataset/" +
    "a7dadb4a-66ae-4eff-8ded-a102064702ba/resource/" +
    "266d82e1-ba53-4510-8a81-370880c4678f/download/rome_static_gtfs.zip"
  );
});

// ===========================================================================
// HEALTH
// ===========================================================================
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    deps: "zero external deps beyond axios + cors + express",
    feeds: {
      nasoni:   "Overpass API — amenity=drinking_water",
      farmacie: "Overpass API — amenity=pharmacy",
      wifi:     "dati.comune.roma.it — Digit Roma WiFi CSV",
      events:   "turismoroma.it RSS (parse manuale)",
      traffic:  "romamobilita.it — rome_alerts.json",
    },
  });
});

export default app;