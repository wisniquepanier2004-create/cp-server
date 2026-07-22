/**
 * CP — Serveur d'appels à distance
 * - Salles WebSocket (code à 4 caractères) qui relaient les énoncés traduits
 * - Endpoint /api/token : jeton Azure Speech éphémère (la clé reste ici)
 *
 * Démarrage :  npm install && npm start
 * Env requis :  AZURE_SPEECH_KEY, AZURE_SPEECH_REGION (ex: "eastus"), ALLOWED_ORIGIN
 */
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const AZURE_KEY = process.env.AZURE_SPEECH_KEY || '';
const AZURE_REGION = process.env.AZURE_SPEECH_REGION || 'eastus';
// Origines autorisées : domaines Equivox + GitHub Pages, extensibles via env (liste séparée par virgules)
const DEFAULT_ORIGINS = [
  'https://equivox.app',
  'https://www.equivox.app',
  'https://christopherpierre-dev.github.io',
  'https://raw.githack.com', // miroir HTTPS pour tests pendant l'émission du certificat
  'http://localhost:8080',   // tests locaux
];
const envOrigins = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = [...new Set([...DEFAULT_ORIGINS, ...envOrigins])];

const app = express();

// CORS minimal (multi-origines)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true }));

/**
 * Jeton Azure éphémère (~10 min). Le client l'utilise avec
 * SpeechTranslationConfig.fromAuthorizationToken(token, region).
 * Si la région configurée échoue, la bonne région est détectée
 * automatiquement puis mémorisée.
 */
let ACTIVE_REGION = AZURE_REGION;

async function issueToken(region) {
  const r = await fetch(
    `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
    { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': AZURE_KEY }, signal: AbortSignal.timeout(8000) }
  );
  if (!r.ok) throw new Error(`Azure ${r.status}`);
  return r.text();
}

app.get('/api/token', async (_req, res) => {
  if (!AZURE_KEY) return res.status(500).json({ error: 'AZURE_SPEECH_KEY non configurée' });
  try {
    const token = await issueToken(ACTIVE_REGION);
    return res.json({ token, region: ACTIVE_REGION });
  } catch (e) {
    // Région configurée invalide : détection automatique (en parallèle)
    const attempts = await Promise.allSettled(
      CANDIDATE_REGIONS.map(async (r) => ({ r, token: await issueToken(r) }))
    );
    const hit = attempts.find((a) => a.status === 'fulfilled');
    if (hit) {
      ACTIVE_REGION = hit.value.r;
      console.log('Région Azure détectée automatiquement :', ACTIVE_REGION);
      return res.json({ token: hit.value.token, region: ACTIVE_REGION });
    }
    console.error('token error:', e.message, '(aucune région valide)');
    res.status(502).json({ error: 'Impossible d’obtenir un jeton Azure' });
  }
});

/**
 * Diagnostic : teste la clé contre les régions Azure courantes.
 * La clé ne quitte jamais le serveur — seule la liste des régions
 * qui répondent OK est renvoyée.
 */
const CANDIDATE_REGIONS = [
  'canadacentral','canadaeast','eastus','eastus2','westus','westus2','westus3',
  'centralus','southcentralus','northcentralus','westcentralus',
  'westeurope','northeurope','francecentral','uksouth','germanywestcentral',
  'swedencentral','switzerlandnorth','japaneast','japanwest','koreacentral',
  'southeastasia','eastasia','australiaeast','brazilsouth','centralindia','uaenorth','southafricanorth'
];
app.get('/api/diagnose', async (_req, res) => {
  if (!AZURE_KEY) return res.status(500).json({ error: 'AZURE_SPEECH_KEY non configurée' });
  const working = [];
  await Promise.all(CANDIDATE_REGIONS.map(async (r) => {
    try {
      const resp = await fetch(
        `https://${r}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
        { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': AZURE_KEY }, signal: AbortSignal.timeout(8000) }
      );
      if (resp.ok) working.push(r);
    } catch (_) { /* région injoignable ou refus */ }
  }));
  res.json({
    configuredRegion: AZURE_REGION,
    workingRegions: working,
    keyLength: AZURE_KEY.length,
    keyHasWhitespace: AZURE_KEY !== AZURE_KEY.trim(),
  });
});

// ── Salles WebSocket ────────────────────────────────────────────
// rooms: code -> Map<ws, {name, lang}>
const rooms = new Map();
const ROOM_TTL_MS = 30 * 60 * 1000; // salle vide supprimée après 30 min
// Le serveur ne relaie que du texte traduit (pas d'audio) : le coût par
// participant est minime. Ajustable sans redéploiement via MAX_PARTICIPANTS.
const MAX_PARTICIPANTS = Number(process.env.MAX_PARTICIPANTS) || 50;

function newRoomCode() {
  let code;
  do {
    code = crypto.randomBytes(3).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase();
  } while (!code || rooms.has(code));
  return code;
}

function broadcast(code, payload, except = null) {
  const room = rooms.get(code);
  if (!room) return;
  const msg = JSON.stringify(payload);
  for (const ws of room.keys()) {
    if (ws !== except && ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function roster(code) {
  const room = rooms.get(code);
  return room ? [...room.values()].map(p => ({ name: p.name, lang: p.lang })) : [];
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.meta = { room: null, name: null, lang: null };

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    switch (m.type) {
      case 'create': {
        const code = newRoomCode();
        rooms.set(code, new Map());
        joinRoom(ws, code, m.name, m.lang);
        break;
      }
      case 'join': {
        const code = String(m.room || '').toUpperCase();
        if (!rooms.has(code)) return ws.send(JSON.stringify({ type: 'error', error: 'Salle introuvable' }));
        if (rooms.get(code).size >= MAX_PARTICIPANTS)
          return ws.send(JSON.stringify({ type: 'error', error: 'Salle pleine' }));
        joinRoom(ws, code, m.name, m.lang);
        break;
      }
      case 'lang': { // changement de langue en cours d'appel
        if (!ws.meta.room) return;
        ws.meta.lang = m.lang;
        rooms.get(ws.meta.room)?.set(ws, { name: ws.meta.name, lang: m.lang });
        broadcast(ws.meta.room, { type: 'roster', participants: roster(ws.meta.room) });
        break;
      }
      case 'utterance': { // {original, translations:{en:"...",fr:"..."}, srcLang}
        if (!ws.meta.room) return;
        broadcast(ws.meta.room, {
          type: 'utterance',
          from: ws.meta.name,
          srcLang: m.srcLang,
          original: String(m.original || '').slice(0, 2000),
          translations: m.translations || {},
          at: Date.now(),
        }, ws);
        break;
      }
      case 'partial_utterance': { // aperçu en cours de phrase (texte provisoire)
        if (!ws.meta.room) return;
        broadcast(ws.meta.room, {
          type: 'partial_utterance',
          from: ws.meta.name,
          srcLang: m.srcLang,
          original: String(m.original || '').slice(0, 2000),
          translations: m.translations || {},
        }, ws);
        break;
      }
      case 'audio_chunk': { // voix originale (morceaux MediaRecorder base64, ~200 ms)
        if (!ws.meta.room) return;
        const data = String(m.data || '');
        if (!data || data.length > 131072) return; // garde-fou : 128 Ko max par morceau
        broadcast(ws.meta.room, {
          type: 'audio_chunk',
          from: ws.meta.name,
          data,
          mimeType: String(m.mimeType || 'audio/webm'),
          isFirst: !!m.isFirst,
          seq: m.seq | 0,
        }, ws);
        break;
      }
    }
  });

  ws.on('close', () => leaveRoom(ws));
});

function joinRoom(ws, code, name, lang) {
  ws.meta = { room: code, name: String(name || 'Invité').slice(0, 40), lang: String(lang || 'en') };
  rooms.get(code).set(ws, { name: ws.meta.name, lang: ws.meta.lang });
  ws.send(JSON.stringify({ type: 'joined', room: code, participants: roster(code) }));
  broadcast(code, { type: 'roster', participants: roster(code) }, ws);
}

function leaveRoom(ws) {
  const code = ws.meta?.room;
  if (!code || !rooms.has(code)) return;
  rooms.get(code).delete(ws);
  broadcast(code, { type: 'roster', participants: roster(code) });
  if (rooms.get(code).size === 0) {
    setTimeout(() => {
      if (rooms.get(code)?.size === 0) rooms.delete(code);
    }, ROOM_TTL_MS);
  }
}

server.listen(PORT, () => console.log(`CP server prêt sur :${PORT}`));
