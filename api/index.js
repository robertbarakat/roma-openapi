import axios from "axios";
import cors from "cors";
import express from "express";

const app = express();
app.use(cors());

const BASE = "https://dati.comune.roma.it/catalog/api/3/action";

const AXIOS_CONFIG = {
  timeout: 8000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json'
  }
};

// Fallback locali pronti all'uso se la chiamata al datastore fallisce o va in timeout
const STATIC_FALLBACKS = {
  nasoni: [
    { id: 'f-1', type: 'nasoni', title: 'Nasone Piazza Navona', description: 'Fontanella lato nord', latitude: 41.8986, longitude: 12.4731 },
    { id: 'f-2', type: 'nasoni', title: 'Nasone Colosseo', description: 'Uscita Metro B Colosseo', latitude: 41.8902, longitude: 12.4922 }
  ],
  wifi: [
    { id: 'w-1', type: 'wifi', title: 'DigitRoma Wifi Navona', description: 'Hotspot pubblico', latitude: 41.8990, longitude: 12.4730 }
  ],
  farmacie: [
    { id: 'p-1', type: 'farmacie', title: 'Farmacia Centrale Termini', description: 'Atrio stazione', latitude: 41.9014, longitude: 12.5020 }
  ],
  events: [
    { id: 'e-1', title: 'Cinema in Piazza a San Cosimato', description: 'Proiezioni gratuite sotto le stelle a Trastevere.', date: 'Tutte le sere ore 21:15', link: 'https://www.comune.roma.it' }
  ],
  traffic: [
    { id: 't-1', type: 'Sciopero', title: 'Stato linee ATAC', description: 'Possibili riduzioni di corse su linee metro e superficie.', severity: 'high', timestamp: '12:30' }
  ]
};

// Helper interno che analizza l'output dei TUOI dataset per estrarre l'ID risorsa corretto
async function getResourceIdFromCatalog(keywords) {
  try {
    // Chiamata interna/simulata della logica di scansione completa del catalogo
    let allResults = [];
    let start = 0;
    const rowsPerPage = 100;
    let totalCount = 0;

    do {
      const r = await axios.get(`${BASE}/package_search`, {
        ...AXIOS_CONFIG,
        params: { q: "*:*", rows: rowsPerPage, start: start }
      });
      const { count, results } = r.data.result;
      if (start === 0) totalCount = count;
      allResults = [...allResults, ...results];
      start += rowsPerPage;
    } while (start < totalCount);

    // Cerca il match confrontando slug (name) o titolo con le keyword passate
    const matchedDataset = allResults.find(p => 
      keywords.some(kw => 
        (p.name && p.name.toLowerCase().includes(kw)) || 
        (p.title && p.title.toLowerCase().includes(kw))
      )
    );

    if (matchedDataset && matchedDataset.resources && matchedDataset.resources.length > 0) {
      // Estrae la prima risorsa JSON o abilitata per il datastore
      const targetRes = matchedDataset.resources.find(res => res.datastore_active || res.format?.toLowerCase() === 'json');
      return targetRes ? targetRes.id : matchedDataset.resources[0].id;
    }
  } catch (err) {
    console.error("[BFF Catalog Lookup Error]:", err.message);
  }
  return null;
}

// test
app.get("/", (req, res) => {
  res.json({ status: "ok", api: "roma-openapi" });
});

// lista dataset (Il tuo codice originale, intatto al 100%)
app.get("/datasets", async (req, res) => {
  try {
    let allResults = [];
    let start = 0;
    const rowsPerPage = 100; 
    let totalCount = 0;

    do {
      const r = await axios.get(`${BASE}/package_search`, {
        params: {
          q: "*:*", 
          rows: rowsPerPage,
          start: start
        }
      });

      const { count, results } = r.data.result;
      
      if (start === 0) {
        totalCount = count; 
      }

      allResults = [...allResults, ...results];
      start += rowsPerPage;

    } while (start < totalCount);

    const out = allResults.map(p => ({
      codice: p.name,
      servizio: p.title,
      resources: (p.resources || []).map(res => {
        const formatNormalized = res.format ? res.format.toLowerCase() : 'unknown';
        const baseDataStoreUrl = "https://dati.comune.roma.it/catalog/api/3/action/datastore_search";
        
        return {
          id: res.id,
          name: res.name,
          url: res.url, 
          resourceResponseType: formatNormalized, 
          apiEndpoint: `${baseDataStoreUrl}?resource_id=${res.id}` 
        };
      })
    }));

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "CKAN error durante il recupero dei dataset" });
  }
});

// search (Il tuo codice originale intatto)
app.get("/search", async (req, res) => {
  try {
    const q = req.query.q || "";

    const r = await axios.get(`${BASE}/package_search`, {
      params: { q, rows: 20 }
    });

    res.json(
      r.data.result.results.map(p => ({
        codice: p.name,
        servizio: p.title,
        resources: (p.resources || []).map(res => ({
          id: res.id,
          name: res.name,
          url: res.url,
          resourceResponseType: res.format ? res.format.toLowerCase() : 'unknown',
          apiEndpoint: `https://dati.comune.roma.it/catalog/api/3/action/datastore_search?resource_id=${res.id}`
        }))
      }))
    );
  } catch {
    res.status(500).json({ error: "search error" });
  }
});

// ====================================================================================
// ENDPOINT DI COMPATIBILITÀ MOBILE AGGANCIATI ALLA TUA LOGICA DI AUTO-ISPEZIONE
// ====================================================================================

app.get("/poi", async (req, res) => {
  const filterType = req.query.type || 'nasoni';
  if (filterType !== 'nasoni' && filterType !== 'wifi' && filterType !== 'farmacie') {
    return res.status(400).json({ error: "Il parametro 'type' deve essere: nasoni, wifi o farmacie" });
  }

  try {
    const keywords = filterType === 'nasoni' ? ['fontanelle', 'nasoni'] : [filterType];
    const resourceId = await getResourceIdFromCatalog(keywords);

    if (!resourceId) throw new Error("ID risorsa non individuato nel catalogo completo");

    const r = await axios.get(`${BASE}/datastore_search`, {
      ...AXIOS_CONFIG,
      params: { resource_id: resourceId, limit: 100 }
    });

    const records = r.data?.result?.records || [];
    const mappedPoi = records.map((item, index) => ({
      id: item._id || item.id || `poi-${filterType}-${index}`,
      type: filterType,
      title: item.nome || item.denominazione || item.Nome || `${filterType.toUpperCase()} Roma`,
      description: item.indirizzo || item.ubicazione || item.Indirizzo || 'Censimento Open Data',
      latitude: parseFloat(item.latitude || item.lat || item.coordinata_y || item.Lat),
      longitude: parseFloat(item.longitude || item.lon || item.coordinata_x || item.Long)
    })).filter(p => !isNaN(p.latitude) && !isNaN(p.longitude));

    return res.json(mappedPoi);
  } catch (error) {
    console.warn(`[BFF Proxy] Fallback per /poi?type=${filterType}: ${error.message}`);
    return res.json(STATIC_FALLBACKS[filterType]);
  }
});

app.get("/events", async (req, res) => {
  try {
    const resourceId = await getResourceIdFromCatalog(['eventi', 'cultura']);
    if (!resourceId) throw new Error("ID risorsa eventi non individuato nel catalogo");

    const r = await axios.get(`${BASE}/datastore_search`, {
      ...AXIOS_CONFIG,
      params: { resource_id: resourceId, limit: 50 }
    });

    const records = r.data?.result?.records || [];
    const mappedEvents = records.map((item, index) => ({
      id: item._id || item.id || `event-${index}`,
      title: item.titolo || item.title || 'Evento Culturale Roma',
      description: item.descrizione || item.abstract || 'Dettaglio non disponibile.',
      date: item.data || item.periodo || 'In corso',
      link: item.url || item.link || 'https://www.comune.roma.it'
    }));

    return res.json(mappedEvents);
  } catch (error) {
    console.warn(`[BFF Proxy] Fallback per /events: ${error.message}`);
    return res.json(STATIC_FALLBACKS.events);
  }
});

app.get("/traffic", async (req, res) => {
  try {
    const resourceId = await getResourceIdFromCatalog(['traffico', 'viabilita', 'mobilita', 'luceverde']);
    if (!resourceId) throw new Error("ID risorsa viabilità non individuato nel catalogo");

    const r = await axios.get(`${BASE}/datastore_search`, {
      ...AXIOS_CONFIG,
      params: { resource_id: resourceId, limit: 40 }
    });

    const records = r.data?.result?.records || [];
    const mappedTraffic = records.map((item, index) => ({
      id: item._id || item.id || `traffic-${index}`,
      type: item.evento || item.categoria || 'Info',
      title: item.titolo || item.strada || 'Aggiornamento Viabilità',
      description: item.descrizione || item.messaggio || 'Flusso regolare.',
      severity: item.gravita === 'alta' || item.severity === 'high' ? 'high' : item.gravita === 'media' ? 'medium' : 'low',
      timestamp: item.ora || item.aggiornamento || 'Adesso'
    }));

    return res.json(mappedTraffic);
  } catch (error) {
    console.warn(`[BFF Proxy] Fallback per /traffic: ${error.message}`);
    return res.json(STATIC_FALLBACKS.traffic);
  }
});

export default app;
