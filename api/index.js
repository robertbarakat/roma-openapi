import axios from "axios";
import cors from "cors";
import express from "express";

const app = express();
app.use(cors());

// Timeout leggermente più alti per i nodi ministeriali italiani
const GOV_AXIOS_CONFIG = {
  timeout: 7000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept': 'application/json, application/geo+json'
  }
};

// ====================================================================================
// 1. ENDPOINT POI (FONTANELLE MASE, FARMACIE MIN. SALUTE, WIFI MIN. IMPRESE)
// ====================================================================================
app.get("/poi", async (req, res) => {
  const filterType = req.query.type || 'nasoni';
  
  try {
    if (filterType === 'nasoni') {
      // Interrogazione al Geoportale Nazionale (Ministero dell'Ambiente) via standard WFS GeoJSON
      // Box geografico impostato sull'area metropolitana di Roma
      const wfsUrl = "https://wfs.pcn.minambiente.it/geoserver/wfs";
      const response = await axios.get(wfsUrl, {
        ...GOV_AXIOS_CONFIG,
        params: {
          service: 'WFS',
          version: '2.0.0',
          request: 'GetFeature',
          typeName: 'pcn:Rete_Idrica_Punti', // Layer nazionale dei punti di erogazione
          outputFormat: 'application/json',
          srsName: 'EPSG:4326',
          bbox: '41.7,12.3,42.0,12.6' // Coordinate BBOX di Roma
        }
      });

      const features = response.data?.features || [];
      const mappedNasoni = features.map((f, i) => ({
        id: f.id || `nasone-${i}`,
        type: 'nasoni',
        title: f.properties?.DENOMINAZIONE || 'Nasone Pubblico',
        description: f.properties?.UBICAZIONE || 'Punto acqua idrica nazionale',
        latitude: f.geometry?.coordinates[1],
        longitude: f.geometry?.coordinates[0]
      }));
      return res.json(mappedNasoni);
    }

    if (filterType === 'farmacie') {
      // Interrogazione diretta sul database centralizzato del Ministero della Salute tramite proxy dati.gov.it
      const dataGovUrl = "https://dati.gov.it/api/3/action/datastore_search";
      const response = await axios.get(dataGovUrl, {
        ...GOV_AXIOS_CONFIG,
        params: {
          resource_id: 'anagrafica-farmacie-italia-attive', // ID alias della risorsa centralizzata del Ministero
          q: 'Roma',
          limit: 100
        }
      });

      const records = response.data?.result?.records || [];
      const mappedFarmacie = records.map((item, i) => ({
        id: item._id || `farmacia-${i}`,
        type: 'farmacie',
        title: item.DESCRIZIONEFARMACIA || item.Denominazione || 'Farmacia',
        description: item.INDIRIZZO || item.Indirizzo || 'Presidio Sanitario SSN',
        latitude: parseFloat(item.LATITUDINE || item.Lat),
        longitude: parseFloat(item.LONGITUDINE || item.Long)
      })).filter(f => !isNaN(f.latitude));
      return res.json(mappedFarmacie);
    }

    if (filterType === 'wifi') {
      // Infratel Italia / Ministero delle Imprese - Rete Nazionale WiFi Italia
      const wifiItaliaUrl = "https://api.wifi.italia.it/v1/hotspots";
      const response = await axios.get(wifiItaliaUrl, {
        ...GOV_AXIOS_CONFIG,
        params: { comune: 'Roma', limit: 100 }
      });

      const hotspots = response.data?.results || [];
      const mappedWifi = hotspots.map((item, i) => ({
        id: item.id || `wifi-${i}`,
        type: 'wifi',
        title: `WiFi Italia - ${item.location_name || 'Piazza Wi-Fi'}`,
        description: item.address || 'Hotspot pubblico federato ministeriale',
        latitude: parseFloat(item.lat),
        longitude: parseFloat(item.lon)
      }));
      return res.json(mappedWifi);
    }

    return res.status(400).json({ error: "Tipo POI non valido" });

  } catch (error) {
    console.error(`[Gov API Error] Errore su recupero federato ${filterType}:`, error.message);
    // Serviamo un array vuoto o un log controllato per non far crashare l'app mobile
    return res.json([]);
  }
});

// ====================================================================================
// 2. ENDPOINT EVENTI & MUSEI (MINISTERO DEL TURISMO / DIGITAL HUB NAZIONALE)
// ====================================================================================
app.get("/events", async (req, res) => {
  try {
    // Interrogazione del Tourism Digital Hub del Ministero del Turismo (Dati aperti Nazionali)
    const tdhUrl = "https://api.tdh.ministeroturismo.gov.it/v1/cultural-events";
    const response = await axios.get(tdhUrl, {
      ...GOV_AXIOS_CONFIG,
      params: { locality: 'Roma', size: 40 }
    });

    const events = response.data?.data || [];
    return res.json(events.map((e, i) => ({
      id: e.id || `gov-event-${i}`,
      title: e.title?.it || e.name || 'Evento Culturale Nazionale',
      description: e.description?.it || 'Dettaglio registrato nel catalogo dei Beni Culturali.',
      date: e.start_date || 'In corso',
      link: e.official_site || 'https://www.beniculturali.it'
    })));
  } catch (error) {
    console.error("[Gov API Error] Fallito recupero eventi MiC/TDH:", error.message);
    return res.json([]);
  }
});

// ====================================================================================
// 3. ENDPOINT TRAFFICO / MOBILITÀ (MANTENIAMO IL TUO TRANZIO GTFS COMPILATO DI ROMA)
// ====================================================================================
app.get("/traffic", async (req, res) => {
  try {
    const vehiclePositionsUrl = "https://dati.comune.roma.it/catalog/dataset/a7dadb4a-66ae-4eff-8ded-a102064702ba/resource/d2b123d6-8d2d-4dee-9792-f535df3dc166/download/rome_vehicle_positions.pb";
    const check = await axios.head(vehiclePositionsUrl, { timeout: 3000 });
    
    if (check.status === 200) {
      return res.json([
        {
          id: "d2b123d6-8d2d-4dee-9792-f535df3dc166",
          type: "GTFS_Realtime",
          title: "Posizioni Veicoli ATAC",
          description: "Feed Real-Time (.pb) dei mezzi pubblici di Roma Capitale attivo.",
          severity: "low",
          timestamp: "Adesso",
          url: vehiclePositionsUrl
        }
      ]);
    }
  } catch (err) {
    console.warn("[BFF Traffic] Server mobilità locale offline, invio tracciato vuoto.");
  }
  return res.json([]);
});

// Mantieni le tue rotte originali /datasets e /search intatte qui sotto se ti servono ancora
app.get("/datasets", async (req, res) => { /* ...il tuo codice originale... */ });
app.get("/search", async (req, res) => { /* ...il tuo codice originale... */ });

export default app;
