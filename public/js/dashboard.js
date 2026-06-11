'use strict';

// ═══════════════════════════════════════════════════════════
//  IoT Weather Station Dashboard — Client (polling mode)
//  Works on Vercel free tier — polls /api/latest every 2 s
// ═══════════════════════════════════════════════════════════

const API = window.location.origin;
const POLL_INTERVAL_MS  = 1000;   // poll at 1 s — halves worst-case lag vs 2 s device interval
const MAX_CHART_PTS     = 60;
const MAX_FEED_ROWS     = 18;

// ─── Session Statistics ───────────────────────────────────
const sessionStats = {
  dhtTemp:  { min: Infinity, max: -Infinity, sum: 0, n: 0 },
  humidity: { min: Infinity, max: -Infinity, sum: 0, n: 0 },
  bmpTemp:  { min: Infinity, max: -Infinity, sum: 0, n: 0 },
  pressure: { min: Infinity, max: -Infinity, sum: 0, n: 0 },
};

// Shared data arrays for all charts
const chartBuf = {
  labels:   [],
  dhtTemp:  [],
  bmpTemp:  [],
  humidity: [],
  pressure: [],
};

// Polling state — use server-side received_at (ms) so restarts never cause skipped readings
let lastReceivedAt  = 0;
let pollTimer       = null;
let consecutiveErrors   = 0;
let msgCount            = 0;

// ═══════════════════════════════════════════════════════════
//  CLOCK
// ═══════════════════════════════════════════════════════════
const clockEl = document.getElementById('clock');
function tickClock() {
  const d = new Date();
  clockEl.textContent =
    String(d.getHours()).padStart(2,'0')   + ':' +
    String(d.getMinutes()).padStart(2,'0') + ':' +
    String(d.getSeconds()).padStart(2,'0');
}
setInterval(tickClock, 1000);
tickClock();

// ═══════════════════════════════════════════════════════════
//  CHART.JS GLOBAL DEFAULTS
// ═══════════════════════════════════════════════════════════
Chart.defaults.color              = '#3e5272';
Chart.defaults.font.family        = "'JetBrains Mono', monospace";
Chart.defaults.font.size          = 10;
Chart.defaults.animation.duration = 280;

const SHARED_SCALE = {
  grid:   { color: 'rgba(15, 28, 48, 0.9)', lineWidth: 1 },
  ticks:  { color: '#283c56', maxRotation: 0, maxTicksLimit: 6 },
  border: { color: '#0f1c30' },
};

const SHARED_TOOLTIP = {
  backgroundColor: '#0b1222',
  borderColor:     '#162540',
  borderWidth:     1,
  titleColor:      '#3e5272',
  bodyColor:       '#c4d4ee',
  padding:         10,
  cornerRadius:    2,
  titleFont: { family: "'JetBrains Mono', monospace", size: 10 },
  bodyFont:  { family: "'JetBrains Mono', monospace", size: 11, weight: '500' },
  mode:      'index',
  intersect: false,
};

function mkGradient(ctx, area, hex, a0 = 0.18, a1 = 0) {
  const g = ctx.createLinearGradient(0, area.top, 0, area.bottom);
  g.addColorStop(0, hex + Math.round(a0 * 255).toString(16).padStart(2,'0'));
  g.addColorStop(1, hex + Math.round(a1 * 255).toString(16).padStart(2,'0'));
  return g;
}

// ─── Temperature Chart ────────────────────────────────────
const tempChart = new Chart(document.getElementById('tempChart'), {
  type: 'line',
  data: {
    labels: chartBuf.labels,
    datasets: [
      {
        label: 'DHT22 (°C)', data: chartBuf.dhtTemp,
        borderColor: '#00f5c4', borderWidth: 2,
        pointRadius: 2, pointHoverRadius: 5, pointBackgroundColor: '#00f5c4',
        tension: 0.4, fill: true,
        backgroundColor: (ctx) => {
          const { chart } = ctx;
          return chart.chartArea ? mkGradient(chart.ctx, chart.chartArea, '#00f5c4') : 'transparent';
        },
      },
      {
        label: 'BMP085 (°C)', data: chartBuf.bmpTemp,
        borderColor: '#ff7c42', borderWidth: 2,
        pointRadius: 2, pointHoverRadius: 5, pointBackgroundColor: '#ff7c42',
        tension: 0.4, fill: false,
      },
    ],
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: SHARED_TOOLTIP },
    interaction: { mode: 'index', intersect: false },
    scales: {
      x: { ...SHARED_SCALE, ticks: { ...SHARED_SCALE.ticks, maxTicksLimit: 8 } },
      y: { ...SHARED_SCALE, title: { display: true, text: '°C',   color: '#283c56', font: { size: 9 } } },
    },
  },
});

// ─── Humidity Chart ───────────────────────────────────────
const humChart = new Chart(document.getElementById('humChart'), {
  type: 'line',
  data: {
    labels: chartBuf.labels,
    datasets: [{
      label: 'Humidity (%)', data: chartBuf.humidity,
      borderColor: '#00aaff', borderWidth: 2,
      pointRadius: 2, pointHoverRadius: 5, pointBackgroundColor: '#00aaff',
      tension: 0.4, fill: true,
      backgroundColor: (ctx) => {
        const { chart } = ctx;
        return chart.chartArea ? mkGradient(chart.ctx, chart.chartArea, '#00aaff') : 'transparent';
      },
    }],
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: SHARED_TOOLTIP },
    interaction: { mode: 'index', intersect: false },
    scales: {
      x: { ...SHARED_SCALE, ticks: { ...SHARED_SCALE.ticks, maxTicksLimit: 7 } },
      y: { ...SHARED_SCALE, min: 0, max: 100, title: { display: true, text: '% RH', color: '#283c56', font: { size: 9 } } },
    },
  },
});

// ─── Pressure Chart ───────────────────────────────────────
const pressChart = new Chart(document.getElementById('pressChart'), {
  type: 'line',
  data: {
    labels: chartBuf.labels,
    datasets: [{
      label: 'Pressure (hPa)', data: chartBuf.pressure,
      borderColor: '#ffd600', borderWidth: 2,
      pointRadius: 2, pointHoverRadius: 5, pointBackgroundColor: '#ffd600',
      tension: 0.4, fill: true,
      backgroundColor: (ctx) => {
        const { chart } = ctx;
        return chart.chartArea ? mkGradient(chart.ctx, chart.chartArea, '#ffd600', 0.14) : 'transparent';
      },
    }],
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: SHARED_TOOLTIP },
    interaction: { mode: 'index', intersect: false },
    scales: {
      x: { ...SHARED_SCALE, ticks: { ...SHARED_SCALE.ticks, maxTicksLimit: 7 } },
      y: { ...SHARED_SCALE, title: { display: true, text: 'hPa', color: '#283c56', font: { size: 9 } } },
    },
  },
});

// ═══════════════════════════════════════════════════════════
//  STATUS INDICATORS
// ═══════════════════════════════════════════════════════════
const mqttPill = document.getElementById('mqttPill');
const mqttLed  = document.getElementById('mqttLed');
const mqttText = document.getElementById('mqttText');
const sseLed   = document.getElementById('sseLed');

function setLiveStatus(receiving) {
  sseLed.className = 'led led--small ' + (receiving ? 'ok' : 'warn');
}

function setIngestStatus(ok) {
  mqttLed.className    = 'led ' + (ok ? 'ok' : 'warn');
  mqttText.textContent = ok ? 'LIVE' : 'WAITING';
  mqttPill.className   = 'hud-pill ' + (ok ? 'ok' : '');
}

// ═══════════════════════════════════════════════════════════
//  SESSION STATS
// ═══════════════════════════════════════════════════════════
function accumStat(key, value) {
  if (value === null || value === undefined) return;
  const s = sessionStats[key];
  s.n++;
  s.sum += value;
  if (value < s.min) s.min = value;
  if (value > s.max) s.max = value;
}

function renderStats(key, minId, maxId, avgId, cntId) {
  const s = sessionStats[key];
  if (s.n === 0) return;
  document.getElementById(minId).textContent = s.min.toFixed(1);
  document.getElementById(maxId).textContent = s.max.toFixed(1);
  document.getElementById(avgId).textContent = (s.sum / s.n).toFixed(1);
  document.getElementById(cntId).textContent = s.n;
}

// ═══════════════════════════════════════════════════════════
//  CARD UPDATE
// ═══════════════════════════════════════════════════════════
function updateCard({ cardId, valId, indId, value, decimals = 1, statKey, minId, maxId, avgId, cntId }) {
  const card  = document.getElementById(cardId);
  const valEl = document.getElementById(valId);
  const indEl = document.getElementById(indId);

  if (value !== null && value !== undefined) {
    valEl.textContent = value.toFixed(decimals);
    indEl.className   = 'ch-led live';
    card.classList.remove('flash');
    void card.offsetWidth;
    card.classList.add('flash');
    accumStat(statKey, value);
    renderStats(statKey, minId, maxId, avgId, cntId);
  } else {
    valEl.textContent = '--.-';
    indEl.className   = 'ch-led';
  }
}

// ═══════════════════════════════════════════════════════════
//  CHART BUFFER PUSH
// ═══════════════════════════════════════════════════════════
function pushChart(label, dhtTemp, bmpTemp, humidity, pressure) {
  chartBuf.labels.push(label);
  chartBuf.dhtTemp.push(dhtTemp);
  chartBuf.bmpTemp.push(bmpTemp);
  chartBuf.humidity.push(humidity);
  chartBuf.pressure.push(pressure);

  if (chartBuf.labels.length > MAX_CHART_PTS) {
    chartBuf.labels.shift();
    chartBuf.dhtTemp.shift();
    chartBuf.bmpTemp.shift();
    chartBuf.humidity.shift();
    chartBuf.pressure.shift();
  }

  tempChart.update('none');
  humChart.update('none');
  pressChart.update('none');
}

// ═══════════════════════════════════════════════════════════
//  FEED TABLE
// ═══════════════════════════════════════════════════════════
const feedBody  = document.getElementById('feedBody');
const feedCount = document.getElementById('feedCount');

function addFeedRow(r) {
  const emptyRow = feedBody.querySelector('.empty-row');
  if (emptyRow) emptyRow.remove();

  const t = new Date(r.received_at);
  const timeStr =
    String(t.getHours()).padStart(2,'0')   + ':' +
    String(t.getMinutes()).padStart(2,'0') + ':' +
    String(t.getSeconds()).padStart(2,'0');

  const tr = document.createElement('tr');
  tr.innerHTML =
    `<td>${r.measurement_num}</td>` +
    `<td>${r.temp_dht22   !== null ? r.temp_dht22.toFixed(1)   + '°' : '--'}</td>` +
    `<td>${r.humidity     !== null ? r.humidity.toFixed(1)     + '%' : '--'}</td>` +
    `<td>${r.temp_bmp085  !== null ? r.temp_bmp085.toFixed(1)  + '°' : '--'}</td>` +
    `<td>${r.pressure_hpa !== null ? r.pressure_hpa.toFixed(1)       : '--'}</td>` +
    `<td>${timeStr}</td>`;

  feedBody.insertBefore(tr, feedBody.firstChild);

  while (feedBody.children.length > MAX_FEED_ROWS) {
    feedBody.removeChild(feedBody.lastChild);
  }

  feedCount.textContent = feedBody.children.length + ' records';
}

// ═══════════════════════════════════════════════════════════
//  PROCESS ONE READING
// ═══════════════════════════════════════════════════════════
function processReading(r) {
  msgCount++;
  document.getElementById('msgCount').textContent = msgCount;

  updateCard({ cardId: 'card-dht-temp', valId: 'val-dht-temp', indId: 'ind-dht-temp',
    value: r.temp_dht22,   statKey: 'dhtTemp',
    minId: 'min-dht-temp', maxId: 'max-dht-temp', avgId: 'avg-dht-temp', cntId: 'cnt-dht-temp' });

  updateCard({ cardId: 'card-humidity', valId: 'val-humidity', indId: 'ind-humidity',
    value: r.humidity,     statKey: 'humidity',
    minId: 'min-humidity', maxId: 'max-humidity', avgId: 'avg-humidity', cntId: 'cnt-humidity' });

  updateCard({ cardId: 'card-bmp-temp', valId: 'val-bmp-temp', indId: 'ind-bmp-temp',
    value: r.temp_bmp085,  statKey: 'bmpTemp',
    minId: 'min-bmp-temp', maxId: 'max-bmp-temp', avgId: 'avg-bmp-temp', cntId: 'cnt-bmp-temp' });

  updateCard({ cardId: 'card-pressure', valId: 'val-pressure', indId: 'ind-pressure',
    value: r.pressure_hpa, statKey: 'pressure',
    minId: 'min-pressure', maxId: 'max-pressure', avgId: 'avg-pressure', cntId: 'cnt-pressure' });

  const t = new Date(r.received_at);
  const label =
    String(t.getHours()).padStart(2,'0')   + ':' +
    String(t.getMinutes()).padStart(2,'0') + ':' +
    String(t.getSeconds()).padStart(2,'0');

  pushChart(label, r.temp_dht22, r.temp_bmp085, r.humidity, r.pressure_hpa);
  addFeedRow(r);

  document.getElementById('lastUpdateEl').textContent = `LAST MSG: ${label}`;
  document.getElementById('alertBanner').classList.add('hidden');
  setIngestStatus(true);
  setLiveStatus(true);
  consecutiveErrors = 0;
}

// ═══════════════════════════════════════════════════════════
//  LOAD HISTORY (called once on startup)
// ═══════════════════════════════════════════════════════════
function loadHistory(history) {
  if (!history || history.length === 0) return;

  const slice = history.slice(-MAX_CHART_PTS);

  for (const r of slice) {
    const t = new Date(r.received_at);
    chartBuf.labels.push(
      String(t.getHours()).padStart(2,'0')   + ':' +
      String(t.getMinutes()).padStart(2,'0') + ':' +
      String(t.getSeconds()).padStart(2,'0')
    );
    chartBuf.dhtTemp.push(r.temp_dht22);
    chartBuf.bmpTemp.push(r.temp_bmp085);
    chartBuf.humidity.push(r.humidity);
    chartBuf.pressure.push(r.pressure_hpa);

    accumStat('dhtTemp',  r.temp_dht22);
    accumStat('humidity', r.humidity);
    accumStat('bmpTemp',  r.temp_bmp085);
    accumStat('pressure', r.pressure_hpa);
  }

  // Show most recent values
  const latest = slice[slice.length - 1];
  if (latest) {
    if (latest.temp_dht22   !== null) document.getElementById('val-dht-temp').textContent  = latest.temp_dht22.toFixed(1);
    if (latest.humidity     !== null) document.getElementById('val-humidity').textContent   = latest.humidity.toFixed(1);
    if (latest.temp_bmp085  !== null) document.getElementById('val-bmp-temp').textContent   = latest.temp_bmp085.toFixed(1);
    if (latest.pressure_hpa !== null) document.getElementById('val-pressure').textContent   = latest.pressure_hpa.toFixed(1);

    ['ind-dht-temp','ind-humidity','ind-bmp-temp','ind-pressure'].forEach(id => {
      document.getElementById(id).className = 'ch-led live';
    });

    renderStats('dhtTemp',  'min-dht-temp', 'max-dht-temp', 'avg-dht-temp', 'cnt-dht-temp');
    renderStats('humidity', 'min-humidity', 'max-humidity', 'avg-humidity', 'cnt-humidity');
    renderStats('bmpTemp',  'min-bmp-temp', 'max-bmp-temp', 'avg-bmp-temp', 'cnt-bmp-temp');
    renderStats('pressure', 'min-pressure', 'max-pressure', 'avg-pressure', 'cnt-pressure');

    lastReceivedAt = latest.received_at;
    msgCount = slice.length;
    document.getElementById('msgCount').textContent = msgCount;
    document.getElementById('alertBanner').classList.add('hidden');
    setIngestStatus(true);
  }

  // Populate feed (newest first)
  const feedSlice = slice.slice(-MAX_FEED_ROWS).reverse();
  for (const r of feedSlice) addFeedRow(r);

  tempChart.update('none');
  humChart.update('none');
  pressChart.update('none');
}

// ═══════════════════════════════════════════════════════════
//  POLLING
// ═══════════════════════════════════════════════════════════
async function pollLatest() {
  try {
    const res = await fetch(`${API}/api/latest`, { cache: 'no-store' });

    if (res.status === 404) {
      // No data yet — IoT device hasn't posted anything
      consecutiveErrors = 0;
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const reading = await res.json();

    // Skip if we've already rendered this reading (compare server timestamp, not device counter)
    if (reading.received_at <= lastReceivedAt) return;

    lastReceivedAt = reading.received_at;
    processReading(reading);

  } catch (e) {
    consecutiveErrors++;
    console.warn(`[POLL] Error (${consecutiveErrors}):`, e.message);
    if (consecutiveErrors >= 3) {
      setLiveStatus(false);
      setIngestStatus(false);
    }
  }
}

async function fetchHistory() {
  try {
    const res = await fetch(`${API}/api/data?limit=60`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (data.readings && data.readings.length > 0) {
      loadHistory(data.readings);
    }
  } catch (e) {
    console.warn('[INIT] History fetch error:', e.message);
  }
}

function startPolling() {
  fetchHistory().then(() => {
    setLiveStatus(true);
    pollTimer = setInterval(pollLatest, POLL_INTERVAL_MS);
  });
}

// ═══════════════════════════════════════════════════════════
//  UPTIME POLL (every 10 s)
// ═══════════════════════════════════════════════════════════
function pollUptime() {
  fetch(`${API}/api/status`, { cache: 'no-store' })
    .then(r => r.json())
    .then(data => {
      const s = data.uptime_seconds || 0;
      const h   = String(Math.floor(s / 3600)).padStart(2,'0');
      const m   = String(Math.floor((s % 3600) / 60)).padStart(2,'0');
      const sec = String(s % 60).padStart(2,'0');
      document.getElementById('uptimeEl').textContent = `UPTIME: ${h}:${m}:${sec}`;
    })
    .catch(() => {});
}

setInterval(pollUptime, 10000);
pollUptime();

// ═══════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════
setIngestStatus(false);
setLiveStatus(false);
startPolling();
