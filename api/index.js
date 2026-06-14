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

// lista dataset (pulita e COMPLETA)
app.get("/datasets", async (req, res) => {
  try {
    let allResults = [];
    let start = 0;
    const rowsPerPage = 100; // CKAN digerisce bene 100 record a chiamata
    let totalCount = 0;

    // Ciclo per recuperare TUTTI i dataset paginati a monte da CKAN
    do {
      const r = await axios.get(`${BASE}/package_search`, {
        params: {
          q: "*:*", // Prende tutto il catalogo
          rows: rowsPerPage,
          start: start
        }
      });

      const { count, results } = r.data.result;
      
      if (start === 0) {
        totalCount = count; // Imposta il totale reale del catalogo alla prima chiamata
      }

      allResults = [...allResults, ...results];
      start += rowsPerPage;

    } while (start < totalCount);

    // Mappatura finale con i nuovi campi richiesti
    const out = allResults.map(p => ({
      codice: p.name,
      servizio: p.title,
      // Mappiamo l'array delle risorse collegate al dataset
      resources: (p.resources || []).map(res => {
        const formatNormalized = res.format ? res.format.toLowerCase() : 'unknown';
        const baseDataStoreUrl = "https://dati.comune.roma.it/catalog/api/3/action/datastore_search";
        
        return {
          id: res.id,
          name: res.name,
          url: res.url, // URL del file statico originale
          resourceResponseType: formatNormalized, // json / csv / xlsx ecc.
          apiEndpoint: `${baseDataStoreUrl}?resource_id=${res.id}` // API diretta da chiamare
        };
      })
    }));

    // Opzionale: aggiunge un header di cache per velocizzare le chiamate successive su Vercel
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');

    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "CKAN error durante il recupero dei dataset" });
  }
});

// search (aggiornato per includere i dettagli delle risorse anche qui)
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

export default app;
