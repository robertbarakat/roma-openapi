import axios from 'axios';

// Configurazione dei timeout per evitare che le Serverless Function rimangano appese sui server lenti del Comune
const AXIOS_CONFIG = {
  timeout: 4000, // 4 secondi di tolleranza prima di far scattare il fallback
  headers: {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  }
};

// Dati di ripiego pronti all'uso se i nodi open data del Comune sono offline
const STATIC_FALLBACKS = {
  nasoni: [
    { id: 'v-n1', type: 'nasoni', title: 'Nasone Piazza Navona', description: 'Fontanella storica, lato nord della piazza', latitude: 41.8986, longitude: 12.4731 },
    { id: 'v-n2', type: 'nasoni', title: 'Nasone Colosseo', description: 'Piazza del Colosseo, uscita metro linea B', latitude: 41.8902, longitude: 12.4922 },
    { id: 'v-n3', type: 'nasoni', title: 'Nasone Fontana di Trevi', description: 'Via delle Muratte, adiacente alla piazza', latitude: 41.9009, longitude: 12.4833 },
    { id: 'v-n4', type: 'nasoni', title: 'Nasone Pantheon', description: 'Piazza della Rotonda, vicino alla fontana centrale', latitude: 41.8992, longitude: 12.4768 }
  ],
  wifi: [
    { id: 'v-w1', type: 'wifi', title: 'DigitRoma Wifi Navona', description: 'Hotspot gratuito Comune di Roma', latitude: 41.8990, longitude: 12.4730 },
    { id: 'v-w2', type: 'wifi', title: 'DigitRoma Wifi Spagna', description: 'Copertura scale della Trinità dei Monti', latitude: 41.9060, longitude: 12.4828 },
    { id: 'v-w3', type: 'wifi', title: 'DigitRoma Wifi Popolo', description: 'Piazza del Popolo, prossimità Flaminio', latitude: 41.9105, longitude: 12.4764 }
  ],
  farmacie: [
    { id: 'v-p1', type: 'farmacie', title: 'Farmacia Piramide (H24)', description: 'Aperta continuato con servizio notturno', latitude: 41.8753, longitude: 12.4821 },
    { id: 'v-p2', type: 'farmacie', title: 'Farmacia Centrale Termini', description: 'Piazza dei Cinquecento, atrio principale stazione', latitude: 41.9014, longitude: 12.5020 },
    { id: 'v-p3', type: 'farmacie', title: 'Farmacia Corso', description: 'Via del Corso, zona Tridente', latitude: 41.9042, longitude: 12.4795 }
  ],
  events: [
    { id: 'v-e1', title: 'Mostra Van Gogh ad Altare della Patria', description: 'Esposizione capolavori provenienti dal Museo Kröller-Müller.', date: '15 Giu - 30 Set', link: 'https://www.comune.roma.it' },
    { id: 'v-e2', title: 'Roma Summer Fest - Cavea Auditorium', description: 'Grandi concerti internazionali live all\'aperto sotto la volta di Renzo Piano.', date: 'Questa settimana', link: 'https://www.comune.roma.it' },
    { id: 'v-e3', title: 'Cinema in Piazza a San Cosimato', description: 'Proiezioni gratuite e incontri con i registi nel cuore di Trastevere.', date: 'Tutte le sere ore 21:15', link: 'https://www.comune.roma.it' },
    { id: 'v-e4', title: 'Caracalla Festival - Opera di Roma', description: 'Stagione lirica e balletti estivi nello scenario delle Terme di Caracalla.', date: 'Fino al 10 Agosto', link: 'https://www.comune.roma.it' }
  ],
  traffic: [
    { id: 'v-t1', type: 'Sciopero', title: 'Stato linee ATAC & TPL', description: 'Agitazione sindacale. Possibili riduzioni di corse su linee Metro A/B e autobus di superficie.', severity: 'high', timestamp: '12:30' },
    { id: 'v-t2', type: 'Chiusura', title: 'Cantiere Notturno Tangenziale Est', description: 'Chiusura temporanea al traffico tra lo svincolo A24 e Tiburtina per rifacimento manto stradale.', severity: 'medium', timestamp: '22:00' },
    { id: 'v-t3', type: 'Rallentamenti', title: 'Code sul Grande Raccordo Anulare', description: 'Traffico intenso e code a tratti in carreggiata interna tra Uscita 23 Appia e Uscita 26 Pontina.', severity: 'medium', timestamp: '18:45' },
    { id: 'v-t4', type: 'Manifestazione', title: 'Deviazioni Area Centro Storico', description: 'Corteo autorizzato in Piazza Venezia. Moderate deviazioni o limitazioni di percorso per 10 linee bus.', severity: 'low', timestamp: '10:15' }
  ]
};

export default async function handler(req, res) {
  // Abilitazione immediata delle intestazioni CORS per evitare blocchi di sicurezza durante le chiamate da dispositivo mobile
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  // Risposta immediata per i preflight request di tipo OPTIONS
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Estrazione della rotta pulita eliminando i prefissi della query
  const urlPath = req.url.split('?')[0];

  // ----------------------------------------------------------------------------------------------------------------
  // GESTIONE ENDPOINT: /poi (Punti di Interesse: Nasoni, Wifi, Farmacie)
  // ----------------------------------------------------------------------------------------------------------------
  if (urlPath === '/poi' || urlPath === '/api/poi') {
    const filterType = req.query.type || 'nasoni';
    
    if (filterType !== 'nasoni' && filterType !== 'wifi' && filterType !== 'farmacie') {
      return res.status(400).json({ error: "Il parametro 'type' deve essere: nasoni, wifi o farmacie" });
    }

    try {
      // Endpoint CKAN del Comune di Roma per l'estrazione degli open data di catalogo
      const comuneUrl = `https://dati.comune.roma.it/catalog/api/3/action/datastore_search?resource_id=${
        filterType === 'nasoni' ? 'nasoni-id-dataset' : filterType === 'wifi' ? 'wifi-id-dataset' : 'farmacie-id-dataset'
      }`;

      const response = await axios.get(comuneUrl, AXIOS_CONFIG);
      const records = response.data?.result?.records || [];

      if (records.length === 0) {
        throw new Error("L'API del Comune ha restituito un array vuoto");
      }

      // Mappatura dei record nativi del Comune nel formato pulito accettato dal client mobile
      const mappedPoi = records.map((item, index) => ({
        id: item.id || `ckan-${filterType}-${index}`,
        type: filterType,
        title: item.nome || item.denominazione || `${filterType.toUpperCase()} Roma`,
        description: item.indirizzo || item.ubicazione || 'Posizione censita nel catalogo open data',
        latitude: parseFloat(item.latitude || item.lat || item.coordinata_y),
        longitude: parseFloat(item.longitude || item.lon || item.coordinata_x)
      })).filter(p => !isNaN(p.latitude) && !isNaN(p.longitude));

      return res.status(200).json(mappedPoi);

    } catch (error) {
      console.warn(`[Vercel Proxy] Fallimento API Comune per /poi?type=${filterType} (${error.message}). Invio Fallback.`);
      // Restituisce l'array corposo corrispondente al filtro per non bloccare la mappa
      return res.status(200).json(STATIC_FALLBACKS[filterType]);
    }
  }

  // ----------------------------------------------------------------------------------------------------------------
  // GESTIONE ENDPOINT: /events (Eventi Culturali)
  // ----------------------------------------------------------------------------------------------------------------
  if (urlPath === '/events' || urlPath === '/api/events') {
    try {
      const response = await axios.get('https://dati.comune.roma.it/catalog/api/3/action/datastore_search?resource_id=eventi-culturali-id', AXIOS_CONFIG);
      const records = response.data?.result?.records || [];

      if (records.length === 0) throw new Error("Array eventi vuoto");

      const mappedEvents = records.map((item, index) => ({
        id: item.id || `event-${index}`,
        title: item.titolo || item.title || 'Evento Culturale Roma',
        description: item.descrizione || item.abstract || 'Nessun dettaglio aggiuntivo disponibile.',
        date: item.data || item.periodo || 'In corso',
        link: item.url || item.link || 'https://www.comune.roma.it'
      }));

      return res.status(200).json(mappedEvents);

    } catch (error) {
      console.warn(`[Vercel Proxy] Fallimento API Comune per /events (${error.message}). Invio Fallback.`);
      return res.status(200).json(STATIC_FALLBACKS.events);
    }
  }

  // ----------------------------------------------------------------------------------------------------------------
  // GESTIONE ENDPOINT: /traffic (St
