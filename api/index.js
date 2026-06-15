import axios from "axios";
import cors from "cors";
import express from "express";
import { transit_realtime } from "gtfs-realtime-bindings";
import Papa from "papaparse";

const app = express();
app.use(cors());

// ---------------------------------------------------------------------------
// Config HTTP per chiamate verso fonti pubbliche italiane
// ---------------------------------------------------------------------------
const GOV_AXIOS_CONFIG = {
  timeout: 8000,
  headers: {
    "User-Agent": "Mozilla/5.0 (compatible; RomaAppBFF/1.0)",
    Accept: "application/json, text/csv, application/octet-stream",
  },
};

// ---------------------------------------------------------------------------
// Helper: scarica un CSV da URL e lo converte in array di oggetti
// ---------------------------------------------------------------------------
async function fetchCsv(url, axiosConfig = {}) {
  const response = await axios.get(url, {
    ...GOV_AXIOS_CONFIG,
    ...axiosConfig,
    responseType: "text",
  });
  const { data } = Papa.parse(response.data, {
    header: true,
    skipEmptyLines: true,
    delimiter: ";", // i CSV italiani usano spesso ; come separatore
  });
  return data;
}

// ===========================================================================
// 1. ENDPOINT POI — /poi?type=nasoni|farmacie|wifi
//
//  nasoni   → Overpass API (OpenStreetMap) con tag amenity=drinking_water
//             È la fonte più aggiornata: ACEA carica i nasoni su OSM.
//
//  farmacie → dati.lazio.it — CSV ufficiale Regione Lazio, farmacie comunali
//             Roma. Per un elenco completo (private incluse) si può usare
//             Overpass con amenity=pharmacy (stessa logica dei nasoni).
//
//  wifi     → dati.comune.roma.it — dataset d192 "Digit Roma WiFi", CSV
//             ufficiale Roma Capitale. Usiamo l'anno più recente disponibile.
// ===========================================================================
app.get("/poi", async (req, res) => {
  const filterType = req.query.type || "nasoni";

  try {
    // -----------------------------------------------------------------------
    // NASONI — Overpass API (tag OSM: amenity=drinking_water)
    // BBOX Roma: sud,ovest,nord,est → 41.7,12.3,42.0,12.6
    // Documentazione: https://overpass-api.de/
    // -----------------------------------------------------------------------
    if (filterType === "nasoni") {
      const overpassUrl = "https://overpass-api.de/api/interpreter";

      // QL compatta: nodi con amenity=drinking_water nella BBOX di Roma
      const query = `[out:json][timeout:25];node["amenity"="drinking_water"](41.7,12.3,42.0,12.6);out body;`;

      const response = await axios.post(
        overpassUrl,
        `data=${encodeURIComponent(query)}`,
        {
          ...GOV_AXIOS_CONFIG,
          headers: {
            ...GOV_AXIOS_CONFIG.headers,
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );

      const elements = response.data?.elements || [];
      const mappedNasoni = elements.map((el) => ({
        id: `nasone-${el.id}`,
        type: "nasoni",
        title: el.tags?.name || el.tags?.description || "Nasone Pubblico",
        description:
          [el.tags?.["addr:street"], el.tags?.["addr:housenumber"]]
            .filter(Boolean)
            .join(" ") || "Fontanella pubblica ACEA",
        latitude: el.lat,
        longitude: el.lon,
        // metadati extra utili
        operational: el.tags?.operational_status !== "broken",
        seasonal: el.tags?.seasonal === "yes",
      }));

      return res.json(mappedNasoni);
    }

    // -----------------------------------------------------------------------
    // FARMACIE — dati.lazio.it (Regione Lazio, Open Data ufficiale)
    // Dataset: "Elenco delle farmacie comunali di Roma"
    // URL: https://dati.lazio.it/dataset/elenco-delle-farmacie-comunali-di-roma
    // Resource CSV: resource/6f72b272-eba2-46dc-99ae-f7e1b717de38
    //
    // NB: se servono anche le farmacie private, usare Overpass con
    //     amenity=pharmacy (stessa logica dei nasoni sopra).
    // -----------------------------------------------------------------------
    if (filterType === "farmacie") {
      const csvUrl =
        "https://dati.lazio.it/dataset/elenco-delle-farmacie-comunali-di-roma" +
        "/resource/6f72b272-eba2-46dc-99ae-f7e1b717de38/download/";

      // il CSV della Regione Lazio usa virgola come separatore
      const response = await axios.get(csvUrl, {
        ...GOV_AXIOS_CONFIG,
        responseType: "text",
      });
      const { data: records } = Papa.parse(response.data, {
        header: true,
        skipEmptyLines: true,
        delimiter: ",",
      });

      const mappedFarmacie = records
        .map((item, i) => ({
          id: item.CODICE || `farmacia-${i}`,
          type: "farmacie",
          title: item.DENOMINAZIONE || item.Denominazione || "Farmacia",
          description:
            item.INDIRIZZO ||
            item.Indirizzo ||
            item.LOCALITA ||
            "Farmacia comunale Roma",
          latitude: parseFloat(
            (item.LATITUDINE || item.Latitudine || "").replace(",", ".")
          ),
          longitude: parseFloat(
            (item.LONGITUDINE || item.Longitudine || "").replace(",", ".")
          ),
          phone: item.TELEFONO || item.Telefono || null,
          municipio: item.MUNICIPIO || null,
        }))
        .filter((f) => !isNaN(f.latitude) && !isNaN(f.longitude));

      return res.json(mappedFarmacie);
    }

    // -----------------------------------------------------------------------
    // WIFI — dati.comune.roma.it, dataset d192 "Digit Roma WiFi"
    // Portale: https://dati.comune.roma.it/catalog/dataset/d192
    // UUID dataset: df7b41a7-3a10-4142-a400-1f6754064402
    //
    // Il CSV elenca le sedi dotate di hotspot WiFi di Roma Capitale.
    // NOTA: il CSV non sempre include lat/lon dirette; quando mancano
    //       andrebbero ottenute via geocoding dell'indirizzo (es. Nominatim).
    //       Qui usiamo il campo latitudine/longitudine se presente.
    // -----------------------------------------------------------------------
    if (filterType === "wifi") {
      // Risorsa 2024 (la più recente trovata sul portale open data)
      // Se Roma Capitale aggiorna il dataset, cambia solo il resource_id qui sotto.
      const wifiCsvUrl =
        "https://dati.comune.roma.it/catalog/dataset/" +
        "df7b41a7-3a10-4142-a400-1f6754064402/resource/" +
        "2a7d30e8-1409-4216-a34d-4a7af3232ca7/download/sedi_digitromawifi2020_.csv";

      const response = await axios.get(wifiCsvUrl, {
        ...GOV_AXIOS_CONFIG,
        responseType: "text",
      });
      const { data: records } = Papa.parse(response.data, {
        header: true,
        skipEmptyLines: true,
        delimiter: ";",
      });

      const mappedWifi = records.map((item, i) => ({
        id: item.CODICE_SEDE || `wifi-${i}`,
        type: "wifi",
        title: `WiFi — ${item.NOME_SEDE || item.DENOMINAZIONE || "Sede Digit Roma"}`,
        description: item.INDIRIZZO || item.VIA || "Hotspot pubblico Roma Capitale",
        latitude: parseFloat(
          (item.LATITUDINE || item.LAT || "").replace(",", ".")
        ),
        longitude: parseFloat(
          (item.LONGITUDINE || item.LON || "").replace(",", ".")
        ),
        municipio: item.MUNICIPIO || null,
        // Se le coordinate sono vuote, il frontend le può ignorare
        // e mostrare solo la lista testuale con l'indirizzo
      }));

      // filtra solo quelli con coordinate (gli altri andranno geocodificati)
      const withCoords = mappedWifi.filter(
        (w) => !isNaN(w.latitude) && !isNaN(w.longitude)
      );
      const withoutCoords = mappedWifi.filter(
        (w) => isNaN(w.latitude) || isNaN(w.longitude)
      );

      if (withoutCoords.length > 0) {
        console.warn(
          `[WiFi] ${withoutCoords.length} sedi senza coordinate — considera geocoding via Nominatim`
        );
      }

      return res.json(withCoords);
    }

    return res.status(400).json({ error: "Tipo POI non valido. Usa: nasoni | farmacie | wifi" });
  } catch (error) {
    console.error(`[POI Error] Errore su tipo "${filterType}":`, error.message);
    return res.status(502).json({ error: "Sorgente dati temporaneamente non disponibile", detail: error.message });
  }
});

// ===========================================================================
// 2. ENDPOINT EVENTI CULTURALI — /events
//
//  Fonte: feed RSS ufficiale di turismoroma.it (sito istituzionale Roma Capitale
//         gestito da Zètema Progetto Cultura).
//         Non esiste un'API JSON pubblica documentata; il feed RSS è la via
//         più stabile per recuperare eventi aggiornati.
//
//  Alternative da valutare:
//  - Ministero della Cultura: https://cultura.gov.it/open-data-e-linked-data
//    (feed XML MiC.xsd con ~25.000 schede eventi nazionali)
//  - 060608.it è la banca dati ufficiale ma non ha API pubblica
// ===========================================================================
app.get("/events", async (req, res) => {
  try {
    // Importazione lazy di rss-parser (ESM)
    const { default: RssParser } = await import("rss-parser");
    const parser = new RssParser({
      customFields: {
        item: [
          ["media:thumbnail", "thumbnail"],
          ["category", "category"],
        ],
      },
    });

    // Feed RSS ufficiale eventi di turismoroma.it
    const RSS_URL = "https://www.turismoroma.it/it/eventi/rss.xml";
    const feed = await parser.parseURL(RSS_URL);

    const events = (feed.items || []).slice(0, 40).map((item, i) => ({
      id: item.guid || item.link || `evento-${i}`,
      title: item.title || "Evento Culturale",
      description: item.contentSnippet || item.content || item.summary || "",
      date: item.pubDate || item.isoDate || "In corso",
      link: item.link || "https://www.turismoroma.it",
      category: item.category || null,
      image: item.thumbnail?.$ ?.url || null,
    }));

    return res.json(events);
  } catch (error) {
    console.error("[Events Error] Fallito recupero feed RSS turismoroma.it:", error.message);

    // Fallback: restituisci link diretto al sito senza crashare l'app
    return res.json([
      {
        id: "fallback-turismoroma",
        title: "Eventi a Roma",
        description: "Scopri tutti gli eventi culturali sul sito ufficiale di Roma Capitale.",
        date: new Date().toISOString(),
        link: "https://www.turismoroma.it/it/eventi",
        category: "cultura",
        image: null,
      },
    ]);
  }
});

// ===========================================================================
// 3. ENDPOINT TRAFFICO / MOBILITÀ — /traffic
//
//  Fonte: Roma Mobilità (romamobilita.it) — feed GTFS-RT ufficiale per
//         ATAC e Roma TPL, aggiornato ogni ~30 secondi.
//
//  I file sono in formato Protocol Buffer (binario).
//  Decodifica richiede: npm install gtfs-realtime-bindings
//
//  Feed disponibili:
//    vehicle_positions → posizioni in tempo reale dei veicoli
//    trip_updates      → ritardi e aggiornamenti corse
//    alerts            → avvisi di servizio (scioperi, deviazioni)
//
//  Ref: https://romamobilita.it/it/tecnologie/open-data/dataset
//       https://github.com/transitland/transitland-atlas (conferma URL)
// ===========================================================================

const GTFS_RT_BASE = "https://romamobilita.it/sites/default/files";

const GTFS_FEEDS = {
  vehicle_positions: `${GTFS_RT_BASE}/rome_vehicle_positions.pb`,
  trip_updates: `${GTFS_RT_BASE}/rome_trip_updates.pb`,
  alerts: `${GTFS_RT_BASE}/rome_alerts.pb`,
};

// Helper: scarica e decodifica un feed GTFS-RT protobuf
async function fetchGtfsRt(feedUrl) {
  const response = await axios.get(feedUrl, {
    ...GOV_AXIOS_CONFIG,
    responseType: "arraybuffer",
    timeout: 5000,
  });
  const buffer = new Uint8Array(response.data);
  return transit_realtime.FeedMessage.decode(buffer);
}

app.get("/traffic", async (req, res) => {
  const results = [];

  // --- Vehicle positions ---
  try {
    const feed = await fetchGtfsRt(GTFS_FEEDS.vehicle_positions);
    const vehicles = (feed.entity || [])
      .filter((e) => e.vehicle?.position)
      .map((e) => ({
        id: e.id,
        type: "vehicle",
        vehicleId: e.vehicle?.vehicle?.id || e.id,
        label: e.vehicle?.vehicle?.label || null,
        routeId: e.vehicle?.trip?.routeId || null,
        tripId: e.vehicle?.trip?.tripId || null,
        latitude: e.vehicle.position.latitude,
        longitude: e.vehicle.position.longitude,
        bearing: e.vehicle.position.bearing || null,
        speed: e.vehicle.position.speed || null, // m/s
        status: e.vehicle.currentStatus || null, // IN_TRANSIT_TO, STOPPED_AT, etc.
        timestamp: e.vehicle.timestamp
          ? new Date(Number(e.vehicle.timestamp) * 1000).toISOString()
          : null,
      }));

    results.push({
      feed: "vehicle_positions",
      title: "Posizioni Veicoli ATAC / Roma TPL",
      description: `${vehicles.length} veicoli attivi in tempo reale`,
      severity: "low",
      data: vehicles,
      source: GTFS_FEEDS.vehicle_positions,
    });
  } catch (err) {
    console.warn("[Traffic] vehicle_positions non disponibile:", err.message);
    results.push({
      feed: "vehicle_positions",
      title: "Posizioni Veicoli ATAC / Roma TPL",
      description: "Feed temporaneamente non disponibile",
      severity: "unknown",
      data: [],
      source: GTFS_FEEDS.vehicle_positions,
    });
  }

  // --- Service Alerts (scioperi, deviazioni, sospensioni) ---
  try {
    const feed = await fetchGtfsRt(GTFS_FEEDS.alerts);
    const alerts = (feed.entity || [])
      .filter((e) => e.alert)
      .map((e) => {
        const alert = e.alert;
        const headerText =
          alert.headerText?.translation?.[0]?.text || "Avviso di servizio";
        const descText =
          alert.descriptionText?.translation?.[0]?.text || "";
        const routes = (alert.informedEntity || [])
          .map((ie) => ie.routeId)
          .filter(Boolean);

        return {
          id: e.id,
          type: "alert",
          title: headerText,
          description: descText,
          severity: alert.severityLevel || "UNKNOWN",
          effect: alert.effect || null, // NO_SERVICE, REDUCED_SERVICE, DETOUR, etc.
          routes: routes,
          activePeriod: (alert.activePeriod || []).map((p) => ({
            start: p.start ? new Date(Number(p.start) * 1000).toISOString() : null,
            end: p.end ? new Date(Number(p.end) * 1000).toISOString() : null,
          })),
        };
      });

    results.push({
      feed: "alerts",
      title: "Avvisi Mobilità Roma",
      description: `${alerts.length} avvisi attivi`,
      severity: alerts.length > 0 ? "medium" : "low",
      data: alerts,
      source: GTFS_FEEDS.alerts,
    });
  } catch (err) {
    console.warn("[Traffic] alerts non disponibile:", err.message);
    results.push({
      feed: "alerts",
      title: "Avvisi Mobilità Roma",
      description: "Feed temporaneamente non disponibile",
      severity: "unknown",
      data: [],
      source: GTFS_FEEDS.alerts,
    });
  }

  return res.json(results);
});

// ===========================================================================
// 4. ENDPOINT STATICO GTFS — /gtfs-static
//
//  Scarica il file GTFS statico (orari programmati, fermate, linee).
//  Fonte: dati.comune.roma.it — dataset a7dadb4a
//  Utile per pre-caching lato app: fermate, nomi linee, ecc.
// ===========================================================================
app.get("/gtfs-static", async (req, res) => {
  const GTFS_STATIC_URL =
    "https://dati.comune.roma.it/catalog/dataset/" +
    "a7dadb4a-66ae-4eff-8ded-a102064702ba/resource/" +
    "266d82e1-ba53-4510-8a81-370880c4678f/download/rome_static_gtfs.zip";

  try {
    // Redirect diretto al file ZIP — il client scarica da Roma Capitale
    return res.redirect(GTFS_STATIC_URL);
  } catch (err) {
    return res.status(502).json({ error: "GTFS statico non raggiungibile", detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Healthcheck
// ---------------------------------------------------------------------------
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    feeds: {
      nasoni: "Overpass API (OpenStreetMap) — amenity=drinking_water",
      farmacie: "Regione Lazio Open Data (dati.lazio.it)",
      wifi: "Roma Capitale Open Data (dati.comune.roma.it — Digit Roma WiFi)",
      events: "turismoroma.it RSS feed (Zètema / Roma Capitale)",
      traffic: "Roma Mobilità GTFS-RT (romamobilita.it)",
    },
  });
});

export default app;
