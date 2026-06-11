'use strict';

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || null;
const MAX_READINGS = 500;

// ─── In-memory store ─────────────────────────────────────
let readings      = [];
let latestReading = null;
let totalMessages = 0;
const serverStart = Date.now();

// ─── SSE clients ─────────────────────────────────────────
const sseClients = new Set();

function broadcast(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); }
    catch { sseClients.delete(res); }
  }
}

// ─── Middleware ───────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'x-api-key'] }));
app.options('*', cors());
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function guardApiKey(req, res, next) {
  if (!API_KEY) return next();
  if ((req.headers['x-api-key'] || req.query.key) !== API_KEY)
    return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── POST /api/ingest  ────────────────────────────────────
// IoT device calls this every second.
// On success the reading is immediately pushed to all open
// SSE connections — zero additional latency.
app.post('/api/ingest', guardApiKey, (req, res) => {
  const raw = req.body;
  if (!raw || typeof raw !== 'object')
    return res.status(400).json({ error: 'JSON body required' });

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

  // Push to every connected dashboard immediately
  broadcast({ type: 'reading', data: reading });

  process.stdout.write(
    `\r[INGEST] #${String(reading.measurement_num).padStart(4)} | ` +
    `DHT22: ${String(reading.temp_dht22   ?? '--').padStart(5)}°C  ` +
    `Hum: ${String(reading.humidity       ?? '--').padStart(5)}%  ` +
    `BMP085: ${String(reading.temp_bmp085 ?? '--').padStart(5)}°C  ` +
    `Press: ${String(reading.pressure_hpa ?? '--').padStart(8)} hPa  ` +
    `[SSE:${sseClients.size}]   `
  );

  res.status(201).json({ ok: true, measurement_num: reading.measurement_num });
});

// ─── GET /api/stream  (SSE) ───────────────────────────────
// Browser connects once; server pushes every new reading.
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type',        'text/event-stream');
  res.setHeader('Cache-Control',       'no-cache');
  res.setHeader('Connection',          'keep-alive');
  res.setHeader('X-Accel-Buffering',   'no');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Send existing history so the dashboard isn't blank on connect
  res.write(`data: ${JSON.stringify({ type: 'init', history: readings.slice(-60) })}\n\n`);

  sseClients.add(res);
  console.log(`\n[SSE] client connected  (total: ${sseClients.size})`);

  // Heartbeat keeps the connection alive through proxies / load balancers
  const hb = setInterval(() => {
    try { res.write(': ping\n\n'); }
    catch { clearInterval(hb); sseClients.delete(res); }
  }, 15000);

  req.on('close', () => {
    clearInterval(hb);
    sseClients.delete(res);
    console.log(`\n[SSE] client disconnected (total: ${sseClients.size})`);
  });
});

// ─── GET /api/latest ─────────────────────────────────────
app.get('/api/latest', (req, res) => {
  if (!latestReading) return res.status(404).json({ error: 'No data yet.' });
  res.json(latestReading);
});

// ─── GET /api/data ────────────────────────────────────────
app.get('/api/data', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, MAX_READINGS);
  res.json({ total: readings.length, returned: Math.min(limit, readings.length), readings: readings.slice(-limit) });
});

// ─── GET /api/status ─────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    sse_clients:    sseClients.size,
    total_readings: readings.length,
    total_messages: totalMessages,
    latest:         latestReading,
    uptime_seconds: Math.floor((Date.now() - serverStart) / 1000),
    server_time:    new Date().toISOString(),
  });
});

// ─── Start ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n' + '═'.repeat(52));
  console.log('  IoT Weather Dashboard');
  console.log('═'.repeat(52));
  console.log(`  http://localhost:${PORT}`);
  console.log(`  POST /api/ingest  →  SSE broadcast`);
  console.log('═'.repeat(52) + '\n');
});
