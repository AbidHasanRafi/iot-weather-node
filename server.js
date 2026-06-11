'use strict';

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// Optional: set API_KEY env var in Vercel dashboard to secure the ingest endpoint.
// The IoT device must then include header  x-api-key: <same value>.
// Leave unset to disable auth (fine for private/demo use).
const API_KEY = process.env.API_KEY || null;

const MAX_READINGS = 500;

// ─── In-memory state ─────────────────────────────────────────────────────────
// On Vercel, this module-level array persists across warm invocations of the
// same function instance (typically ~15 min of idle time before a cold start).
// The IoT device posts every 2 s, so data refills within seconds after any
// cold start. For hard persistence across cold starts, add Upstash Redis:
//   https://vercel.com/marketplace/upstash
let readings        = [];
let latestReading   = null;
let totalMessages   = 0;
const serverStart   = Date.now();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin:  '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 'Authorization', 'x-api-key',
    'Cache-Control', 'Accept',
  ],
}));
app.options('*', cors());
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── API key guard (optional) ─────────────────────────────────────────────────
function guardApiKey(req, res, next) {
  if (!API_KEY) return next();
  const supplied = req.headers['x-api-key'] || req.query.key;
  if (supplied !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized — bad or missing x-api-key' });
  }
  next();
}

// ─── POST /api/ingest — IoT device pushes data here ──────────────────────────
app.post('/api/ingest', guardApiKey, (req, res) => {
  const raw = req.body;

  if (!raw || typeof raw !== 'object') {
    return res.status(400).json({ error: 'JSON body required' });
  }

  totalMessages++;

  const reading = {
    temp_dht22:      typeof raw.temp_dht22   === 'number' ? +raw.temp_dht22.toFixed(2)   : null,
    humidity:        typeof raw.humidity     === 'number' ? +raw.humidity.toFixed(2)     : null,
    temp_bmp085:     typeof raw.temp_bmp085  === 'number' ? +raw.temp_bmp085.toFixed(2)  : null,
    pressure_hpa:    typeof raw.pressure_hpa === 'number' ? +raw.pressure_hpa.toFixed(2) : null,
    timestamp:       raw.timestamp       || Math.floor(Date.now() / 1000),
    measurement_num: raw.measurement_num || totalMessages,
    received_at:     Date.now(),
  };

  readings.push(reading);
  if (readings.length > MAX_READINGS) readings.shift();
  latestReading = reading;

  process.stdout.write(
    `\r[INGEST] #${String(reading.measurement_num).padStart(4)} | ` +
    `DHT22: ${String(reading.temp_dht22   ?? '--').padStart(5)}°C  ` +
    `Hum: ${String(reading.humidity       ?? '--').padStart(5)}%  ` +
    `BMP085: ${String(reading.temp_bmp085 ?? '--').padStart(5)}°C  ` +
    `Press: ${String(reading.pressure_hpa ?? '--').padStart(8)} hPa   `
  );

  res.status(201).json({ ok: true, measurement_num: reading.measurement_num });
});

// ─── GET /api/latest ─────────────────────────────────────────────────────────
app.get('/api/latest', (req, res) => {
  if (!latestReading) {
    return res.status(404).json({ error: 'No data yet — waiting for IoT device.' });
  }
  res.json(latestReading);
});

// ─── GET /api/data?limit=N&offset=M ──────────────────────────────────────────
app.get('/api/data', (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit)  || 100, MAX_READINGS);
  const offset = Math.max(parseInt(req.query.offset) || 0,   0);
  const end    = readings.length - offset;
  const start  = Math.max(end - limit, 0);
  const slice  = readings.slice(start, end > 0 ? end : undefined);
  res.json({ total: readings.length, returned: slice.length, limit, offset, readings: slice });
});

// ─── GET /api/status ─────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    total_readings:  readings.length,
    total_messages:  totalMessages,
    latest:          latestReading,
    uptime_seconds:  Math.floor((Date.now() - serverStart) / 1000),
    server_time:     new Date().toISOString(),
    auth_enabled:    !!API_KEY,
    storage:         'in-memory',
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n' + '═'.repeat(56));
  console.log('  IoT Weather Dashboard  (Vercel-compatible)');
  console.log('═'.repeat(56));
  console.log(`  Dashboard : http://localhost:${PORT}`);
  console.log(`  Ingest    : POST http://localhost:${PORT}/api/ingest`);
  console.log(`  Auth      : ${API_KEY ? '✓ API key enabled' : '✗ disabled  (set API_KEY env var)'}`);
  console.log('═'.repeat(56) + '\n');
});
