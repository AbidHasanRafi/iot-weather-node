'use strict';

// ═══════════════════════════════════════════════════════════
//  IoT Weather Station — Dashboard client
//  Transport: SSE  (server pushes each reading the instant
//  the IoT device's HTTP POST lands)
// ═══════════════════════════════════════════════════════════

const API           = window.location.origin;
const MAX_CHART_PTS = 60;
const MAX_FEED_ROWS = 18;

// ─── State ────────────────────────────────────────────────
const sessionStats = {
  dhtTemp:  { min: Infinity, max: -Infinity, sum: 0, n: 0 },
  humidity: { min: Infinity, max: -Infinity, sum: 0, n: 0 },
  bmpTemp:  { min: Infinity, max: -Infinity, sum: 0, n: 0 },
  pressure: { min: Infinity, max: -Infinity, sum: 0, n: 0 },
};

const chartBuf = { labels: [], dhtTemp: [], bmpTemp: [], humidity: [], pressure: [] };

let lastUpdateTime  = 0;
let msgCount        = 0;
let esRetryMs       = 2000;

// ═══════════════════════════════════════════════════════════
//  CLOCK
// ═══════════════════════════════════════════════════════════
(function tickClock() {
  const d = new Date();
  document.getElementById('clock').textContent =
    String(d.getHours()).padStart(2,'0')   + ':' +
    String(d.getMinutes()).padStart(2,'0') + ':' +
    String(d.getSeconds()).padStart(2,'0');
  setTimeout(tickClock, 1000 - d.getMilliseconds());
})();

// ═══════════════════════════════════════════════════════════
//  ELAPSED TICKER  — runs every 100 ms for live feeling
// ═══════════════════════════════════════════════════════════
const elapsedPill = document.getElementById('elapsedPill');
const elapsedText = document.getElementById('elapsedText');

setInterval(() => {
  if (!lastUpdateTime) return;
  const sec = (Date.now() - lastUpdateTime) / 1000;
  elapsedText.textContent = sec < 60
    ? sec.toFixed(1) + 's'
    : Math.floor(sec / 60) + 'm ' + String(Math.floor(sec % 60)).padStart(2,'0') + 's';
  elapsedPill.className = 'hud-pill ' + (sec < 3 ? 'fresh' : sec < 10 ? 'stale' : 'dead');
}, 100);

// ═══════════════════════════════════════════════════════════
//  CHART.JS
// ═══════════════════════════════════════════════════════════
Chart.defaults.color              = '#3e5272';
Chart.defaults.font.family        = "'JetBrains Mono', monospace";
Chart.defaults.font.size          = 10;
Chart.defaults.animation.duration = 220;

const SCALE = {
  grid:   { color: 'rgba(15,28,48,.9)', lineWidth: 1 },
  ticks:  { color: '#283c56', maxRotation: 0, maxTicksLimit: 6 },
  border: { color: '#0f1c30' },
};

const TIP = {
  backgroundColor: '#0b1222', borderColor: '#162540', borderWidth: 1,
  titleColor: '#3e5272', bodyColor: '#c4d4ee', padding: 10, cornerRadius: 2,
  titleFont: { family: "'JetBrains Mono', monospace", size: 10 },
  bodyFont:  { family: "'JetBrains Mono', monospace", size: 11, weight: '500' },
  mode: 'index', intersect: false,
};

function mkGrad(ctx, area, hex, a = 0.18) {
  const g = ctx.createLinearGradient(0, area.top, 0, area.bottom);
  g.addColorStop(0, hex + Math.round(a * 255).toString(16).padStart(2,'0'));
  g.addColorStop(1, hex + '00');
  return g;
}

const tempChart = new Chart(document.getElementById('tempChart'), {
  type: 'line',
  data: {
    labels: chartBuf.labels,
    datasets: [
      { label: 'DHT22 (°C)',  data: chartBuf.dhtTemp,
        borderColor: '#00f5c4', borderWidth: 2, pointRadius: 2, pointHoverRadius: 5,
        pointBackgroundColor: '#00f5c4', tension: 0.4, fill: true,
        backgroundColor: c => c.chart.chartArea ? mkGrad(c.chart.ctx, c.chart.chartArea, '#00f5c4') : 'transparent' },
      { label: 'BMP085 (°C)', data: chartBuf.bmpTemp,
        borderColor: '#ff7c42', borderWidth: 2, pointRadius: 2, pointHoverRadius: 5,
        pointBackgroundColor: '#ff7c42', tension: 0.4, fill: false },
    ],
  },
  options: { responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: TIP },
    interaction: { mode: 'index', intersect: false },
    scales: { x: { ...SCALE, ticks: { ...SCALE.ticks, maxTicksLimit: 8 } },
              y: { ...SCALE, title: { display: true, text: '°C', color: '#283c56', font: { size: 9 } } } } },
});

const humChart = new Chart(document.getElementById('humChart'), {
  type: 'line',
  data: {
    labels: chartBuf.labels,
    datasets: [{ label: 'Humidity (%)', data: chartBuf.humidity,
      borderColor: '#00aaff', borderWidth: 2, pointRadius: 2, pointHoverRadius: 5,
      pointBackgroundColor: '#00aaff', tension: 0.4, fill: true,
      backgroundColor: c => c.chart.chartArea ? mkGrad(c.chart.ctx, c.chart.chartArea, '#00aaff') : 'transparent' }],
  },
  options: { responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: TIP },
    interaction: { mode: 'index', intersect: false },
    scales: { x: { ...SCALE, ticks: { ...SCALE.ticks, maxTicksLimit: 7 } },
              y: { ...SCALE, min: 0, max: 100, title: { display: true, text: '% RH', color: '#283c56', font: { size: 9 } } } } },
});

const pressChart = new Chart(document.getElementById('pressChart'), {
  type: 'line',
  data: {
    labels: chartBuf.labels,
    datasets: [{ label: 'Pressure (hPa)', data: chartBuf.pressure,
      borderColor: '#ffd600', borderWidth: 2, pointRadius: 2, pointHoverRadius: 5,
      pointBackgroundColor: '#ffd600', tension: 0.4, fill: true,
      backgroundColor: c => c.chart.chartArea ? mkGrad(c.chart.ctx, c.chart.chartArea, '#ffd600', 0.14) : 'transparent' }],
  },
  options: { responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: TIP },
    interaction: { mode: 'index', intersect: false },
    scales: { x: { ...SCALE, ticks: { ...SCALE.ticks, maxTicksLimit: 7 } },
              y: { ...SCALE, title: { display: true, text: 'hPa', color: '#283c56', font: { size: 9 } } } } },
});

// ═══════════════════════════════════════════════════════════
//  STATUS PILLS
// ═══════════════════════════════════════════════════════════
const mqttPill = document.getElementById('mqttPill');
const mqttLed  = document.getElementById('mqttLed');
const mqttText = document.getElementById('mqttText');
const sseLed   = document.getElementById('sseLed');

function setApiStatus(ok) {
  mqttLed.className    = 'led ' + (ok ? 'ok' : 'warn');
  mqttText.textContent = ok ? 'LIVE' : 'WAITING';
  mqttPill.className   = 'hud-pill ' + (ok ? 'ok' : '');
}

function setSseStatus(ok) {
  sseLed.className = 'led led--small ' + (ok ? 'ok' : 'warn');
}

// ═══════════════════════════════════════════════════════════
//  STATS
// ═══════════════════════════════════════════════════════════
function accumStat(key, v) {
  if (v == null) return;
  const s = sessionStats[key];
  s.n++; s.sum += v;
  if (v < s.min) s.min = v;
  if (v > s.max) s.max = v;
}

function renderStats(key, minId, maxId, avgId, cntId) {
  const s = sessionStats[key];
  if (!s.n) return;
  document.getElementById(minId).textContent = s.min.toFixed(1);
  document.getElementById(maxId).textContent = s.max.toFixed(1);
  document.getElementById(avgId).textContent = (s.sum / s.n).toFixed(1);
  document.getElementById(cntId).textContent = s.n;
}

// ═══════════════════════════════════════════════════════════
//  CARD UPDATE  (number pop on change)
// ═══════════════════════════════════════════════════════════
function updateCard({ cardId, valId, indId, value, decimals = 1, statKey, minId, maxId, avgId, cntId }) {
  const card  = document.getElementById(cardId);
  const valEl = document.getElementById(valId);
  const indEl = document.getElementById(indId);

  if (value != null) {
    const fmt = value.toFixed(decimals);
    if (valEl.textContent !== fmt) {
      valEl.classList.remove('pop');
      void valEl.offsetWidth;
      valEl.classList.add('pop');
      valEl.textContent = fmt;
    }
    indEl.className = 'ch-led live';
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
//  CHART PUSH
// ═══════════════════════════════════════════════════════════
function pushChart(label, dhtTemp, bmpTemp, humidity, pressure) {
  chartBuf.labels.push(label);
  chartBuf.dhtTemp.push(dhtTemp);
  chartBuf.bmpTemp.push(bmpTemp);
  chartBuf.humidity.push(humidity);
  chartBuf.pressure.push(pressure);
  if (chartBuf.labels.length > MAX_CHART_PTS)
    ['labels','dhtTemp','bmpTemp','humidity','pressure'].forEach(k => chartBuf[k].shift());
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
  feedBody.querySelector('.empty-row')?.remove();
  const t  = new Date(r.received_at);
  const ts = String(t.getHours()).padStart(2,'0') + ':' +
             String(t.getMinutes()).padStart(2,'0') + ':' +
             String(t.getSeconds()).padStart(2,'0');
  const tr = document.createElement('tr');
  tr.innerHTML =
    `<td>${r.measurement_num}</td>` +
    `<td>${r.temp_dht22   != null ? r.temp_dht22.toFixed(1)   + '°' : '--'}</td>` +
    `<td>${r.humidity     != null ? r.humidity.toFixed(1)     + '%' : '--'}</td>` +
    `<td>${r.temp_bmp085  != null ? r.temp_bmp085.toFixed(1)  + '°' : '--'}</td>` +
    `<td>${r.pressure_hpa != null ? r.pressure_hpa.toFixed(1)       : '--'}</td>` +
    `<td>${ts}</td>`;
  feedBody.insertBefore(tr, feedBody.firstChild);
  while (feedBody.children.length > MAX_FEED_ROWS) feedBody.removeChild(feedBody.lastChild);
  feedCount.textContent = feedBody.children.length + ' records';
}

// ═══════════════════════════════════════════════════════════
//  PROCESS ONE READING  (called for both history and live)
// ═══════════════════════════════════════════════════════════
function processReading(r) {
  msgCount++;
  document.getElementById('msgCount').textContent = msgCount;
  lastUpdateTime = Date.now();

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
  const label = String(t.getHours()).padStart(2,'0') + ':' +
                String(t.getMinutes()).padStart(2,'0') + ':' +
                String(t.getSeconds()).padStart(2,'0');

  pushChart(label, r.temp_dht22, r.temp_bmp085, r.humidity, r.pressure_hpa);
  addFeedRow(r);
  document.getElementById('lastUpdateEl').textContent = `LAST MSG: ${label}`;
  document.getElementById('alertBanner').classList.add('hidden');
  setApiStatus(true);
}

// ═══════════════════════════════════════════════════════════
//  LOAD HISTORY  (sent by server on first SSE connect)
// ═══════════════════════════════════════════════════════════
function loadHistory(history) {
  if (!history?.length) return;
  const slice = history.slice(-MAX_CHART_PTS);
  for (const r of slice) {
    const t = new Date(r.received_at);
    chartBuf.labels.push(String(t.getHours()).padStart(2,'0') + ':' +
                         String(t.getMinutes()).padStart(2,'0') + ':' +
                         String(t.getSeconds()).padStart(2,'0'));
    chartBuf.dhtTemp.push(r.temp_dht22);
    chartBuf.bmpTemp.push(r.temp_bmp085);
    chartBuf.humidity.push(r.humidity);
    chartBuf.pressure.push(r.pressure_hpa);
    accumStat('dhtTemp',  r.temp_dht22);
    accumStat('humidity', r.humidity);
    accumStat('bmpTemp',  r.temp_bmp085);
    accumStat('pressure', r.pressure_hpa);
  }
  const latest = slice[slice.length - 1];
  if (!latest) return;
  if (latest.temp_dht22   != null) document.getElementById('val-dht-temp').textContent = latest.temp_dht22.toFixed(1);
  if (latest.humidity     != null) document.getElementById('val-humidity').textContent  = latest.humidity.toFixed(1);
  if (latest.temp_bmp085  != null) document.getElementById('val-bmp-temp').textContent  = latest.temp_bmp085.toFixed(1);
  if (latest.pressure_hpa != null) document.getElementById('val-pressure').textContent  = latest.pressure_hpa.toFixed(1);
  ['ind-dht-temp','ind-humidity','ind-bmp-temp','ind-pressure'].forEach(id =>
    document.getElementById(id).className = 'ch-led live');
  renderStats('dhtTemp',  'min-dht-temp', 'max-dht-temp', 'avg-dht-temp', 'cnt-dht-temp');
  renderStats('humidity', 'min-humidity', 'max-humidity', 'avg-humidity', 'cnt-humidity');
  renderStats('bmpTemp',  'min-bmp-temp', 'max-bmp-temp', 'avg-bmp-temp', 'cnt-bmp-temp');
  renderStats('pressure', 'min-pressure', 'max-pressure', 'avg-pressure', 'cnt-pressure');
  msgCount = slice.length;
  lastUpdateTime = latest.received_at;
  document.getElementById('msgCount').textContent = msgCount;
  document.getElementById('alertBanner').classList.add('hidden');
  setApiStatus(true);
  slice.slice(-MAX_FEED_ROWS).reverse().forEach(addFeedRow);
  tempChart.update('none');
  humChart.update('none');
  pressChart.update('none');
}

// ═══════════════════════════════════════════════════════════
//  SSE CONNECTION  (auto-reconnects on drop)
// ═══════════════════════════════════════════════════════════
function connectSSE() {
  setSseStatus(false);

  const es = new EventSource(`${API}/api/stream`);

  es.onopen = () => {
    setSseStatus(true);
    esRetryMs = 2000;
    console.log('[SSE] connected');
  };

  es.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'init')    loadHistory(msg.history);
      if (msg.type === 'reading') processReading(msg.data);
    } catch (e) {
      console.warn('[SSE] parse error', e);
    }
  };

  es.onerror = () => {
    setSseStatus(false);
    es.close();
    console.warn(`[SSE] disconnected — retry in ${esRetryMs}ms`);
    setTimeout(() => {
      esRetryMs = Math.min(esRetryMs * 1.5, 15000);
      connectSSE();
    }, esRetryMs);
  };
}

// ═══════════════════════════════════════════════════════════
//  UPTIME POLL  (every 10 s — low-frequency, just for footer)
// ═══════════════════════════════════════════════════════════
function pollUptime() {
  fetch(`${API}/api/status`, { cache: 'no-store' })
    .then(r => r.json())
    .then(d => {
      const s  = d.uptime_seconds || 0;
      const hh = String(Math.floor(s / 3600)).padStart(2,'0');
      const mm = String(Math.floor((s % 3600) / 60)).padStart(2,'0');
      const ss = String(s % 60).padStart(2,'0');
      document.getElementById('uptimeEl').textContent = `UPTIME: ${hh}:${mm}:${ss}`;
    })
    .catch(() => {});
}

setInterval(pollUptime, 10000);
pollUptime();

// ═══════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════
setApiStatus(false);
setSseStatus(false);
connectSSE();
