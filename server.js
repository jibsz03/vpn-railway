const WebSocket = require('ws');
const net = require('net');
const dgram = require('dgram');
const fetch = require('node-fetch');
const http = require('http');
const https = require('https');
const url = require('url');

// Constants
const horse = Buffer.from("dHJvamFu", 'base64').toString(); // "trojan"
const flash = Buffer.from("dm1lc3M=", 'base64').toString(); // "vmess"
const v2 = Buffer.from("djJyYXk=", 'base64').toString(); // "v2ray"
const neko = Buffer.from("Y2xhc2g=", 'base64').toString(); // "clash"

const KV_PRX_URL = "https://raw.githubusercontent.com/backup-heavenly-demons/gateway/refs/heads/main/kvProxyList.json";
const DNS_SERVER_ADDRESS = "8.8.8.8";
const DNS_SERVER_PORT = 53;
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
const CORS_HEADER_OPTIONS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
  "Access-Control-Max-Age": "86400",
};

// Region Mapping
const REGION_MAP = {
  ASIA: ["ID", "SG", "MY", "PH", "TH", "VN", "JP", "KR", "CN", "HK", "TW"],
  SOUTHASIA: ["IN", "BD", "PK", "LK", "NP", "AF", "BT", "MV"],
  CENTRALASIA: ["KZ", "UZ", "TM", "KG", "TJ"],
  NORTHASIA: ["RU"],
  MIDDLEEAST: ["AE", "SA", "IR", "IQ", "JO", "IL", "YE", "SY", "OM", "KW", "QA", "BH", "LB"],
  CIS: ["RU", "UA", "BY", "KZ", "UZ", "AM", "GE", "MD", "TJ", "KG", "TM", "AZ"],
  WESTEUROPE: ["FR", "DE", "NL", "BE", "AT", "CH", "IE", "LU", "MC"],
  EASTEUROPE: ["PL", "CZ", "SK", "HU", "RO", "BG", "MD", "UA", "BY"],
  NORTHEUROPE: ["SE", "FI", "NO", "DK", "EE", "LV", "LT", "IS"],
  SOUTHEUROPE: ["IT", "ES", "PT", "GR", "HR", "SI", "MT", "AL", "BA", "RS", "ME", "MK"],
  EUROPE: ["FR", "DE", "NL", "BE", "AT", "CH", "IE", "LU", "MC", "PL", "CZ", "SK", "HU", "RO", "BG", "MD", "UA", "BY", "SE", "FI", "NO", "DK", "EE", "LV", "LT", "IS", "IT", "ES", "PT", "GR", "HR", "SI", "MT", "AL", "BA", "RS", "ME", "MK"],
  AFRICA: ["ZA", "NG", "EG", "MA", "KE", "DZ", "TN", "GH", "CI", "SN", "ET"],
  NORTHAMERICA: ["US", "CA", "MX"],
  SOUTHAMERICA: ["BR", "AR", "CL", "CO", "PE", "VE", "EC", "UY", "PY", "BO"],
  LATAM: ["MX", "BR", "AR", "CL", "CO", "PE", "VE", "EC", "UY", "PY", "BO", "CR", "GT", "PA", "DO", "HN", "NI", "SV"],
  AMERICA: ["US", "CA", "MX", "BR", "AR", "CL", "CO", "PE", "VE", "EC"],
  OCEANIA: ["AU", "NZ", "PG", "FJ"],
  GLOBAL: []
};

class GatewayServer {
  constructor() {
    this.prxIP = "";
    this.cachedPrxList = [];
    this.wss = null;
    this.httpServer = null;
    this.activeUDPConnections = new Map();
    this.CORS_HEADER_OPTIONS = CORS_HEADER_OPTIONS;
  }

  // ==================== HTTP HANDLERS ====================

  // Health check handler
  handleHealthCheck(req, res) {
    const healthData = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: 'railway-gateway',
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      version: process.env.npm_package_version || '1.0.0',
      features: {
        websocket: true,
        tcp: true,
        udp: true,
        protocols: ['trojan', 'vmess', 'ss']
      },
      network: {
        udp_supported: true,
        outbound_allowed: true
      }
    };

    res.writeHead(200, {
      'Content-Type': 'application/json',
      ...this.CORS_HEADER_OPTIONS
    });
    res.end(JSON.stringify(healthData, null, 2));
  }

  // Handle CORS preflight
  handleCorsPreflight(req, res) {
    res.writeHead(200, this.CORS_HEADER_OPTIONS);
    res.end();
  }

  // API endpoint untuk mendapatkan daftar proxy
  async handleApiRequest(req, res, parsedUrl) {
    try {
      if (parsedUrl.pathname === '/api/proxies') {
        const proxies = await this.getPrxList(process.env.PRX_BANK_URL);
        const format = parsedUrl.query.format || 'json';
        
        if (format === 'text') {
          const proxyText = proxies.map(p => 
            `${p.country} - ${p.prxIP}:${p.prxPort}`
          ).join('\n');
          
          res.writeHead(200, {
            'Content-Type': 'text/plain',
            ...this.CORS_HEADER_OPTIONS
          });
          res.end(proxyText);
          return;
        }
        
        res.writeHead(200, {
          'Content-Type': 'application/json',
          ...this.CORS_HEADER_OPTIONS
        });
        res.end(JSON.stringify(proxies, null, 2));
        return;
      }
    } catch (error) {
      console.error('API error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  // Main HTTP request handler (Cyberpunk Dashboard Modern UI)
  async handleHttpRequest(req, res) {
    const parsedUrl = url.parse(req.url, true);
    
    if (req.method === 'OPTIONS') {
      this.handleCorsPreflight(req, res);
      return;
    }
    
    if (parsedUrl.pathname === '/health') {
      this.handleHealthCheck(req, res);
      return;
    }
    
    if (parsedUrl.pathname.startsWith('/api/')) {
      await this.handleApiRequest(req, res, parsedUrl);
      return;
    }
    
    if (parsedUrl.pathname === '/') {
      const currentHost = req.headers.host || 'localhost:3000';
      const protocolWs = req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
      const protocolHttp = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
      
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Khusus Config SNI | VLESS & Trojan</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
    * { box-sizing: border-box; }
    :root { color-scheme: dark; }
    body {
      font-family: Inter, system-ui, sans-serif;
      background: #070a12;
      color: #e7edf8;
      min-height: 100vh;
    }
    body:before {
      content: ''; position: fixed; inset: 0; pointer-events: none;
      background: radial-gradient(circle at 8% 3%, rgba(16,185,129,.20), transparent 30%), radial-gradient(circle at 93% 4%, rgba(124,58,237,.24), transparent 33%), radial-gradient(circle at 50% 100%, rgba(14,165,233,.10), transparent 38%);
    }
    .glass { background: rgba(13,18,31,.76); border: 1px solid rgba(148,163,184,.13); backdrop-filter: blur(16px); }
    .accent { background: linear-gradient(115deg,#2dd4bf,#38bdf8 48%,#8b5cf6); }
    .soft { background: rgba(15,23,42,.64); border: 1px solid rgba(148,163,184,.13); }
    .input { width:100%; border-radius: 14px; border: 1px solid rgba(148,163,184,.15); background:#0a1020; color:#eff6ff; padding:12px 14px; outline:none; }
    .btn { transition: transform .15s ease, border-color .15s ease, opacity .15s ease, background .15s ease; }
    .btn:active { transform: scale(.98); }
    .uri { word-break: break-all; font-family: ui-monospace,SFMono-Regular,Menlo,monospace; }
    .scroll::-webkit-scrollbar { height: 5px; width: 5px; }
    .scroll::-webkit-scrollbar-thumb { background:#24324f; border-radius:6px; }
    .dot { box-shadow: 0 0 12px rgba(52,211,153,.8); }
  </style>
</head>
<body>
  <div class="relative max-w-5xl mx-auto px-4 py-5 sm:py-8">
    <header class="glass rounded-3xl p-5 sm:p-7 mb-4">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-5">
        <div class="flex items-center gap-4">
          <div class="accent h-14 w-14 rounded-2xl flex items-center justify-center shadow-lg shadow-cyan-900/25">
            <i class="fa-solid fa-shield-halved text-2xl text-white"></i>
          </div>
          <div>
            <p class="text-xs font-semibold tracking-[.26em] text-teal-300">J1BTNL</p>
            <h1 class="text-xl sm:text-2xl font-extrabold text-white">Khusus Config SNI</h1>
            <p class="text-sm text-slate-400">VLESS & Trojan • Random UUID</p>
          </div>
        </div>
        <div class="flex items-center gap-2 rounded-full px-4 py-2 bg-emerald-500/10 border border-emerald-400/20 text-emerald-300 text-xs font-semibold">
          <span class="dot h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span> SERVER ONLINE
        </div>
      </div>
    </header>

    <section class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
      <article class="glass rounded-2xl p-4">
        <p class="text-[11px] font-semibold tracking-wider text-slate-500 mb-2">STATUS</p>
        <p id="status-val" class="text-sm sm:text-base font-bold text-emerald-300 flex items-center gap-2"><span id="status-dot" class="dot h-2 w-2 rounded-full bg-emerald-400"></span><span id="status-text">ONLINE</span></p>
      </article>
      <article class="glass rounded-2xl p-4">
        <p class="text-[11px] font-semibold tracking-wider text-slate-500 mb-2">UPTIME</p>
        <p id="uptime-val" class="text-sm sm:text-base font-bold text-white">0s</p>
      </article>
      <article class="glass rounded-2xl p-4">
        <p class="text-[11px] font-semibold tracking-wider text-slate-500 mb-2">MEMORY</p>
        <p id="memory-val" class="text-sm sm:text-base font-bold text-white">${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB</p>
      </article>
      <article class="glass rounded-2xl p-4">
        <p class="text-[11px] font-semibold tracking-wider text-slate-500 mb-2">NODE</p>
        <p class="text-sm sm:text-base font-bold text-sky-300">${process.version}</p>
      </article>
    </section>

    <main class="grid grid-cols-1 lg:grid-cols-[.94fr_1.06fr] gap-5">
      <section class="glass rounded-3xl p-5 sm:p-6">
        <div class="flex items-center justify-between mb-5">
          <div>
            <h2 class="font-bold text-white text-lg">Buat Config</h2>
            <p class="text-xs text-slate-400 mt-1">UUID otomatis untuk VLESS dan Trojan.</p>
          </div>
          <button onclick="newUuid()" class="btn text-xs font-semibold text-teal-300 border border-teal-400/25 bg-teal-400/10 rounded-xl px-3 py-2">
            <i class="fa-solid fa-rotate mr-1"></i> UUID
          </button>
        </div>

        <div class="space-y-4">
          <label class="block">
            <span class="text-xs text-slate-400 block mb-2">UUID / Password</span>
            <div class="flex gap-2">
              <input id="uuid" class="input text-sm" readonly>
              <button onclick="copyValue('uuid')" class="btn soft rounded-xl px-4 text-slate-300" aria-label="Salin UUID"><i class="fa-regular fa-copy"></i></button>
            </div>
          </label>
        </div>
      </section>

      <section class="glass rounded-3xl p-5 sm:p-6 flex flex-col gap-4">
        <div>
          <h2 class="font-bold text-white text-lg">Hasil Config</h2>
          <p class="text-xs text-slate-400 mt-1">Host mengikuti hostname halaman secara otomatis.</p>
        </div>

        <article class="soft rounded-2xl p-4">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2"><span class="rounded-lg bg-violet-500/15 text-violet-300 px-2.5 py-1 text-[11px] font-bold">VLESS</span><span class="text-[11px] text-slate-500">WS TLS</span></div>
            <button onclick="copyConfig('vless')" class="btn rounded-lg bg-violet-500/15 border border-violet-400/20 px-3 py-1.5 text-xs text-violet-200"><i class="fa-regular fa-copy mr-1"></i> Salin</button>
          </div>
          <div id="vless" class="uri scroll text-xs text-slate-300 leading-5 max-h-28 overflow-y-auto"></div>
        </article>

        <article class="soft rounded-2xl p-4">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2"><span class="rounded-lg bg-teal-500/15 text-teal-300 px-2.5 py-1 text-[11px] font-bold">TROJAN</span><span class="text-[11px] text-slate-500">WS TLS</span></div>
            <button onclick="copyConfig('trojan')" class="btn rounded-lg bg-teal-500/15 border border-teal-400/20 px-3 py-1.5 text-xs text-teal-200"><i class="fa-regular fa-copy mr-1"></i> Salin</button>
          </div>
          <div id="trojan" class="uri scroll text-xs text-slate-300 leading-5 max-h-28 overflow-y-auto"></div>
        </article>

        <div class="soft rounded-2xl p-4 mt-auto">
          <p class="text-xs text-slate-400 mb-3"><i class="fa-solid fa-link mr-2 text-sky-300"></i>Endpoint tambahan tetap tersedia</p>
          <div class="grid grid-cols-3 gap-2 text-center">
            <a class="btn rounded-xl border border-slate-700/50 py-2 text-[11px] text-slate-300 hover:border-teal-400/40" href="${protocolHttp}://${currentHost}/api/proxies" target="_blank">Proxy API</a>
            <a class="btn rounded-xl border border-slate-700/50 py-2 text-[11px] text-slate-300 hover:border-teal-400/40" href="${protocolHttp}://${currentHost}/health" target="_blank">Health</a>
            <button class="btn rounded-xl border border-slate-700/50 py-2 text-[11px] text-slate-300 hover:border-teal-400/40" onclick="copyAll()">Salin Semua</button>
          </div>
        </div>
      </section>
    </main>
    <p class="text-center text-[11px] text-slate-500 mt-6">Port dan security ditetapkan otomatis agar konfigurasi tetap sederhana.</p>
  </div>

  <div id="toast" class="fixed bottom-5 left-1/2 -translate-x-1/2 translate-y-3 opacity-0 pointer-events-none transition rounded-xl bg-slate-100 text-slate-900 px-4 py-2.5 text-xs font-semibold shadow-xl">
    <i class="fa-solid fa-circle-check text-emerald-600 mr-2"></i><span id="toastText">Tersalin</span>
  </div>

  <script>
    const FIXED_PORT = '443';
    const FIXED_SECURITY = 'tls';
    const FIXED_PATH = '/ID';
    const HEALTH_ENDPOINT = '/health';
    let uptimeSeconds = ${Math.floor(process.uptime())};
    let healthOnline = true;
    function randomUuid() {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 3 | 8);
        return v.toString(16);
      });
    }
    function activeHost() { return window.location.hostname || 'localhost'; }
    function formatUptime(total) {
      const days = Math.floor(total / 86400); total %= 86400;
      const hours = Math.floor(total / 3600); total %= 3600;
      const minutes = Math.floor(total / 60); const seconds = total % 60;
      if (days) return days + 'd ' + hours + 'h ' + minutes + 'm';
      if (hours) return hours + 'h ' + minutes + 'm ' + seconds + 's';
      if (minutes) return minutes + 'm ' + seconds + 's';
      return seconds + 's';
    }
    function renderUptime() { document.getElementById('uptime-val').textContent = formatUptime(Math.max(0, Math.floor(uptimeSeconds))); }
    function renderMemory(bytes) {
      const value = Number(bytes);
      document.getElementById('memory-val').textContent = Number.isFinite(value) ? Math.round(value / 1024 / 1024) + ' MB' : '-- MB';
    }
    function renderStatus(online) {
      const text = document.getElementById('status-text');
      const wrapper = document.getElementById('status-val');
      const dot = document.getElementById('status-dot');
      text.textContent = online ? 'ONLINE' : 'OFFLINE';
      wrapper.classList.toggle('text-emerald-300', online);
      wrapper.classList.toggle('text-rose-300', !online);
      dot.classList.toggle('bg-emerald-400', online);
      dot.classList.toggle('bg-rose-400', !online);
    }
    async function refreshStats() {
      try {
        const response = await fetch(HEALTH_ENDPOINT, { cache: 'no-store' });
        if (!response.ok) throw new Error('health request failed');
        const data = await response.json();
        if (Number.isFinite(Number(data.uptime))) uptimeSeconds = Number(data.uptime);
        if (data.memory && data.memory.heapUsed !== undefined) renderMemory(data.memory.heapUsed);
        healthOnline = true;
        renderStatus(true);
        renderUptime();
      } catch (error) {
        healthOnline = false;
        renderStatus(false);
      }
    }
    function generateConfigs() {
      const uuid = document.getElementById('uuid').value;
      const host = activeHost();
      const encodedHost = encodeURIComponent(host);
      const encodedPath = encodeURIComponent(FIXED_PATH);
      const common = 'security=' + FIXED_SECURITY + '&type=ws&host=' + encodedHost + '&path=' + encodedPath + '&sni=' + encodedHost + '&fp=random';
      document.getElementById('vless').textContent = 'vless://' + uuid + '@' + host + ':' + FIXED_PORT + '?encryption=none&' + common + '#J1BTNL%20VLESS';
      document.getElementById('trojan').textContent = 'trojan://' + uuid + '@' + host + ':' + FIXED_PORT + '?' + common + '#J1BTNL%20TROJAN';
    }
    function newUuid() { document.getElementById('uuid').value = randomUuid(); generateConfigs(); showToast('UUID baru dibuat'); }
    function putClipboard(text, message) {
      navigator.clipboard.writeText(text).then(function(){ showToast(message); }).catch(function(){ showToast('Gagal menyalin'); });
    }
    function copyValue(id) { putClipboard(document.getElementById(id).value, 'UUID disalin'); }
    function copyConfig(id) { putClipboard(document.getElementById(id).textContent, id.toUpperCase() + ' disalin'); }
    function copyAll() { putClipboard(document.getElementById('vless').textContent + '\\n' + document.getElementById('trojan').textContent, 'Semua config disalin'); }
    function showToast(message) {
      const toast = document.getElementById('toast');
      document.getElementById('toastText').textContent = message;
      toast.classList.remove('opacity-0','translate-y-3','pointer-events-none');
      clearTimeout(window.toastTimer);
      window.toastTimer = setTimeout(function(){ toast.classList.add('opacity-0','translate-y-3','pointer-events-none'); }, 1900);
    }
    document.getElementById('uuid').value = randomUuid();
    renderUptime();
    renderStatus(true);
    generateConfigs();
    refreshStats();
    setInterval(function(){ uptimeSeconds++; renderUptime(); }, 1000);
    setInterval(refreshStats, 5000);
  </script>
</body>
</html>
      `);
      return;
    }
    
    const targetReversePrx = process.env.REVERSE_PRX_TARGET;
    if (targetReversePrx) {
      await this.reverseWeb(req, res, targetReversePrx);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  }

  // ==================== PROXY LIST MANAGEMENT ====================

  async getKVPrxList(kvPrxUrl = KV_PRX_URL) {
    if (!kvPrxUrl) {
      throw new Error("No URL Provided!");
    }

    try {
      const kvPrx = await fetch(kvPrxUrl);
      if (kvPrx.status == 200) {
        return await kvPrx.json();
      } else {
        console.error(`Failed to fetch KV proxy list: ${kvPrx.status}`);
        return {};
      }
    } catch (error) {
      console.error('Error fetching KV proxy list:', error);
      return {};
    }
  }

  async getPrxList(prxBankUrl) {
    if (!prxBankUrl) {
      return [];
    }

    try {
      const response = await fetch(prxBankUrl);
      if (response.status === 200) {
        const data = await response.json();
        
        return data.map(proxy => {
          const ip = proxy.prxIP || proxy.ip || proxy.server;
          const port = proxy.prxPort || proxy.port;
          const country = proxy.country || proxy.cc || 'XX';
          
          if (!ip || !port) {
            console.warn('Invalid proxy format:', proxy);
            return null;
          }
          
          return {
            prxIP: ip,
            prxPort: port,
            country: country.toUpperCase()
          };
        }).filter(Boolean);
      } else {
        console.error(`Failed to fetch proxy list: ${response.status}`);
        return [];
      }
    } catch (error) {
      console.error('Error fetching proxy list:', error);
      return [];
    }
  }

  // ==================== REVERSE PROXY ====================

  async reverseWeb(request, response, target, targetPath) {
    try {
      const targetUrl = new URL(request.url);
      const targetChunk = target.split(":");

      targetUrl.hostname = targetChunk[0];
      targetUrl.port = targetChunk[1]?.toString() || "443";
      targetUrl.pathname = targetPath || targetUrl.pathname;

      const options = {
        hostname: targetUrl.hostname,
        port: targetUrl.port,
        path: targetUrl.pathname + targetUrl.search,
        method: request.method,
        headers: { ...request.headers }
      };

      options.headers['host'] = targetUrl.hostname;
      options.headers['x-forwarded-host'] = request.headers.host;

      const proxyReq = (targetUrl.protocol === 'https:' ? https : http).request(options, (proxyRes) => {
        response.writeHead(proxyRes.statusCode, {
          ...Object.fromEntries(Object.entries(this.CORS_HEADER_OPTIONS)),
          ...Object.fromEntries(Object.entries(proxyRes.headers)),
          'x-proxied-by': 'Railway Gateway'
        });

        proxyRes.pipe(response);
      });

      proxyReq.on('error', (err) => {
        console.error('Proxy error:', err);
        response.writeHead(500);
        response.end('Proxy error');
      });

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        let body = [];
        request.on('data', (chunk) => {
          body.push(chunk);
        }).on('end', () => {
          proxyReq.write(Buffer.concat(body));
          proxyReq.end();
        });
      } else {
        proxyReq.end();
      }
    } catch (err) {
      console.error('Reverse web error:', err);
      response.writeHead(500);
      response.end('Internal server error');
    }
  }

  // ==================== WEBSOCKET HANDLERS ====================

  async handleWebSocketConnection(ws, request) {
    try {
      const parsedUrl = url.parse(request.url, true);
      const path = parsedUrl.pathname;
      const host = request.headers.host || 'localhost';

      console.log(`WebSocket request path: ${path} from ${request.socket.remoteAddress}`);

      // Format /PROXYLIST/ID,SG,JP
      const proxyListMatch = path.match(/^\/PROXYLIST\/([A-Z]{2}(,[A-Z]{2})*)$/i);
      if (proxyListMatch) {
        const countryCodes = proxyListMatch[1].toUpperCase().split(",");
        const proxies = await this.getPrxList(process.env.PRX_BANK_URL);

        if (proxies.length === 0) {
          const kvPrx = await this.getKVPrxList();
          const availableCountries = countryCodes.filter(code => kvPrx[code] && kvPrx[code].length > 0);
          if (availableCountries.length === 0) {
            ws.close(1000, `No proxies available for countries: ${countryCodes.join(",")}`);
            return;
          }
          const prxKey = availableCountries[Math.floor(Math.random() * availableCountries.length)];
          this.prxIP = kvPrx[prxKey][Math.floor(Math.random() * kvPrx[prxKey].length)];
        } else {
          const filteredProxies = proxies.filter(proxy => countryCodes.includes(proxy.country));
          if (filteredProxies.length === 0) {
            ws.close(1000, `No proxies available for countries: ${countryCodes.join(",")}`);
            return;
          }
          const randomProxy = filteredProxies[Math.floor(Math.random() * filteredProxies.length)];
          this.prxIP = `${randomProxy.prxIP}:${randomProxy.prxPort}`;
        }

        console.log(`Selected Proxy (/PROXYLIST/${countryCodes.join(",")}): ${this.prxIP}`);
        await this.websocketHandler(ws);
        return;
      }

      // Format /ALL atau /ALLn
      const allMatch = path.match(/^\/ALL(\d+)?$/i);
      if (allMatch) {
        const index = allMatch[1] ? parseInt(allMatch[1], 10) - 1 : null;
        const proxies = await this.getPrxList(process.env.PRX_BANK_URL);

        if (proxies.length === 0) {
          const kvPrx = await this.getKVPrxList();
          const allProxies = Object.values(kvPrx).flat();
          if (allProxies.length === 0) {
            ws.close(1000, `No proxies available for /ALL${index !== null ? index + 1 : ""}`);
            return;
          }
          this.prxIP = allProxies[Math.floor(Math.random() * allProxies.length)];
        } else {
          let selectedProxy;
          
          if (index === null) {
            selectedProxy = proxies[Math.floor(Math.random() * proxies.length)];
          } else {
            const groupedByCountry = proxies.reduce((acc, proxy) => {
              if (!acc[proxy.country]) acc[proxy.country] = [];
              acc[proxy.country].push(proxy);
              return acc;
            }, {});

            const proxiesByIndex = [];
            for (const country in groupedByCountry) {
              const countryProxies = groupedByCountry[country];
              if (index < countryProxies.length) {
                proxiesByIndex.push(countryProxies[index]);
              }
            }

            if (proxiesByIndex.length === 0) {
              ws.close(1000, `No proxy at index ${index + 1} for any country`);
              return;
            }

            selectedProxy = proxiesByIndex[Math.floor(Math.random() * proxiesByIndex.length)];
          }

          this.prxIP = `${selectedProxy.prxIP}:${selectedProxy.prxPort}`;
        }

        console.log(`Selected Proxy (/ALL${index !== null ? index + 1 : ""}): ${this.prxIP}`);
        await this.websocketHandler(ws);
        return;
      }

      // Format /PUTAR atau /PUTARn
      const putarMatch = path.match(/^\/PUTAR(\d+)?$/i);
      if (putarMatch) {
        const countryCount = putarMatch[1] ? parseInt(putarMatch[1], 10) : null;
        const proxies = await this.getPrxList(process.env.PRX_BANK_URL);

        if (proxies.length === 0) {
          const kvPrx = await this.getKVPrxList();
          const countries = Object.keys(kvPrx).filter(code => kvPrx[code] && kvPrx[code].length > 0);
          
          if (countries.length === 0) {
            ws.close(1000, `No proxies available for /PUTAR${countryCount || ""}`);
            return;
          }

          let selectedCountries;
          if (countryCount === null) {
            selectedCountries = countries;
          } else {
            const shuffled = [...countries].sort(() => Math.random() - 0.5);
            selectedCountries = shuffled.slice(0, Math.min(countryCount, countries.length));
          }

          const prxKey = selectedCountries[Math.floor(Math.random() * selectedCountries.length)];
          this.prxIP = kvPrx[prxKey][Math.floor(Math.random() * kvPrx[prxKey].length)];
        } else {
          const groupedByCountry = proxies.reduce((acc, proxy) => {
            if (!acc[proxy.country]) acc[proxy.country] = [];
            acc[proxy.country].push(proxy);
            return acc;
          }, {});

          const countries = Object.keys(groupedByCountry);
          if (countries.length === 0) {
            ws.close(1000, `No proxies available`);
            return;
          }

          let selectedCountries;
          if (countryCount === null) {
            selectedCountries = countries;
          } else {
            const shuffled = [...countries].sort(() => Math.random() - 0.5);
            selectedCountries = shuffled.slice(0, Math.min(countryCount, countries.length));
          }

          const selectedProxies = selectedCountries.map(country => {
            const countryProxies = groupedByCountry[country];
            return countryProxies[Math.floor(Math.random() * countryProxies.length)];
          });

          const randomProxy = selectedProxies[Math.floor(Math.random() * selectedProxies.length)];
          this.prxIP = `${randomProxy.prxIP}:${randomProxy.prxPort}`;
        }

        console.log(`Selected Proxy (/PUTAR${countryCount || ""}): ${this.prxIP}`);
        await this.websocketHandler(ws);
        return;
      }

      // Format /REGION atau /REGIONn
      const regionMatch = path.match(/^\/([A-Z]+)(\d+)?$/i);
      if (regionMatch) {
        const regionKey = regionMatch[1].toUpperCase();
        const index = regionMatch[2] ? parseInt(regionMatch[2], 10) - 1 : null;
        
        if (REGION_MAP[regionKey] !== undefined) {
          const countries = REGION_MAP[regionKey];
          const proxies = await this.getPrxList(process.env.PRX_BANK_URL);

          if (proxies.length === 0) {
            const kvPrx = await this.getKVPrxList();
            let availableProxies = [];
            
            if (regionKey === "GLOBAL") {
              availableProxies = Object.values(kvPrx).flat();
            } else {
              for (const country of countries) {
                if (kvPrx[country] && kvPrx[country].length > 0) {
                  availableProxies.push(...kvPrx[country]);
                }
              }
            }

            if (availableProxies.length === 0) {
              ws.close(1000, `No proxies available for region: ${regionKey}`);
              return;
            }

            if (index === null) {
              this.prxIP = availableProxies[Math.floor(Math.random() * availableProxies.length)];
            } else {
              if (index < 0 || index >= availableProxies.length) {
                ws.close(1000, `Index ${index + 1} out of range for region ${regionKey}`);
                return;
              }
              this.prxIP = availableProxies[index];
            }
          } else {
            const filteredProxies = regionKey === "GLOBAL" 
              ? proxies
              : proxies.filter(p => countries.includes(p.country));

            if (filteredProxies.length === 0) {
              ws.close(1000, `No proxies available for region: ${regionKey}`);
              return;
            }

            let selectedProxy;
            if (index === null) {
              selectedProxy = filteredProxies[Math.floor(Math.random() * filteredProxies.length)];
            } else {
              if (index < 0 || index >= filteredProxies.length) {
                ws.close(1000, `Index ${index + 1} out of range for region ${regionKey}`);
                return;
              }
              selectedProxy = filteredProxies[index];
            }

            this.prxIP = `${selectedProxy.prxIP}:${selectedProxy.prxPort}`;
          }

          console.log(`Selected Proxy (/${regionKey}${index !== null ? index + 1 : ""}): ${this.prxIP}`);
          await this.websocketHandler(ws);
          return;
        }
      }

      // Format /CC atau /CCn (Country Code)
      const countryMatch = path.match(/^\/([A-Z]{2})(\d+)?$/);
      if (countryMatch) {
        const countryCode = countryMatch[1].toUpperCase();
        const index = countryMatch[2] ? parseInt(countryMatch[2], 10) - 1 : null;
        const proxies = await this.getPrxList(process.env.PRX_BANK_URL);
        
        if (proxies.length === 0) {
          const kvPrx = await this.getKVPrxList();
          if (!kvPrx[countryCode] || kvPrx[countryCode].length === 0) {
            ws.close(1000, `No proxies available for country: ${countryCode}`);
            return;
          }

          if (index === null) {
            this.prxIP = kvPrx[countryCode][Math.floor(Math.random() * kvPrx[countryCode].length)];
          } else {
            if (index < 0 || index >= kvPrx[countryCode].length) {
              ws.close(1000, `Index ${index + 1} out of range for country ${countryCode}`);
              return;
            }
            this.prxIP = kvPrx[countryCode][index];
          }
        } else {
          const filteredProxies = proxies.filter(proxy => proxy.country === countryCode);
          if (filteredProxies.length === 0) {
            ws.close(1000, `No proxies available for country: ${countryCode}`);
            return;
          }

          let selectedProxy;
          if (index === null) {
            selectedProxy = filteredProxies[Math.floor(Math.random() * filteredProxies.length)];
          } else {
            if (index < 0 || index >= filteredProxies.length) {
              ws.close(1000, `Index ${index + 1} out of range for country ${countryCode}`);
              return;
            }
            selectedProxy = filteredProxies[index];
          }

          this.prxIP = `${selectedProxy.prxIP}:${selectedProxy.prxPort}`;
        }

        console.log(`Selected Proxy (/${countryCode}${index !== null ? index + 1 : ""}): ${this.prxIP}`);
        await this.websocketHandler(ws);
        return;
      }

      // Format /ip:port atau /ip=port atau /ip-port
      const ipPortMatch = path.match(/^\/(.+[:=-]\d+)$/);
      if (ipPortMatch) {
        this.prxIP = ipPortMatch[1].replace(/[=:-]/, ":");
        console.log(`Direct Proxy IP: ${this.prxIP}`);
        await this.websocketHandler(ws);
        return;
      }

      // Format lama untuk kompatibilitas
      if (path.length === 4 || path.includes(',')) {
        const prxKeys = path.replace("/", "").toUpperCase().split(",");
        const prxKey = prxKeys[Math.floor(Math.random() * prxKeys.length)];
        const kvPrx = await this.getKVPrxList();

        if (kvPrx[prxKey] && kvPrx[prxKey].length > 0) {
          this.prxIP = kvPrx[prxKey][Math.floor(Math.random() * kvPrx[prxKey].length)];
          console.log(`Legacy Proxy (/${prxKeys.join(",")}): ${this.prxIP}`);
          await this.websocketHandler(ws);
          return;
        } else {
          ws.close(1000, `No proxies available for country: ${prxKey}`);
          return;
        }
      }

      ws.close(1000, "Invalid WebSocket path format");
    } catch (err) {
      console.error('WebSocket connection error:', err);
      ws.close(1011, 'Internal server error');
    }
  }

  async websocketHandler(ws) {
    let addressLog = "";
    let portLog = "";
    const log = (info, event) => {
      console.log(`[${addressLog}:${portLog}] ${info}`, event || "");
    };

    let remoteSocketWrapper = { value: null };

    ws.on('message', async (message) => {
      try {
        const chunk = Buffer.from(message);

        if (remoteSocketWrapper.value) {
          remoteSocketWrapper.value.write(chunk);
          return;
        }

        const protocol = await this.protocolSniffer(chunk);
        let protocolHeader;

        if (protocol === horse) {
          protocolHeader = this.readHorseHeader(chunk);
        } else if (protocol === flash) {
          protocolHeader = this.readFlashHeader(chunk);
        } else if (protocol === "ss") {
          protocolHeader = this.readSsHeader(chunk);
        } else {
          throw new Error("Unknown Protocol!");
        }

        addressLog = protocolHeader.addressRemote;
        portLog = `${protocolHeader.portRemote} -> ${protocolHeader.isUDP ? "UDP" : "TCP"}`;

        if (protocolHeader.hasError) {
          throw new Error(protocolHeader.message);
        }

        if (protocolHeader.isUDP) {
          return await this.handleUDPOutbound(
            protocolHeader.addressRemote,
            protocolHeader.portRemote,
            chunk.slice(protocolHeader.rawDataIndex),
            ws,
            protocolHeader.version,
            log
          );
        }

        this.handleTCPOutBound(
          remoteSocketWrapper,
          protocolHeader.addressRemote,
          protocolHeader.portRemote,
          protocolHeader.rawClientData,
          ws,
          protocolHeader.version,
          log
        );
      } catch (err) {
        console.error('Error processing WebSocket message:', err);
        ws.close(1011, err.message);
      }
    });

    ws.on('close', () => {
      if (remoteSocketWrapper.value) {
        remoteSocketWrapper.value.end();
      }
      this.cleanupUDPConnections(ws);
      log('WebSocket closed');
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
      this.cleanupUDPConnections(ws);
    });
  }

  // ==================== PROTOCOL SNIFFERS ====================

  async protocolSniffer(buffer) {
    if (buffer.length >= 62) {
      const horseDelimiter = buffer.slice(56, 60);
      if (horseDelimiter[0] === 0x0d && horseDelimiter[1] === 0x0a) {
        if (horseDelimiter[2] === 0x01 || horseDelimiter[2] === 0x03 || horseDelimiter[2] === 0x7f) {
          if (horseDelimiter[3] === 0x01 || horseDelimiter[3] === 0x03 || horseDelimiter[3] === 0x04) {
            return horse;
          }
        }
      }
    }

    const flashDelimiter = buffer.slice(1, 17);
    const hex = flashDelimiter.toString('hex');
    if (hex.match(/^[0-9a-f]{8}[0-9a-f]{4}4[0-9a-f]{3}[89ab][0-9a-f]{3}[0-9a-f]{12}$/i)) {
      return flash;
    }

    return "ss";
  }

  async handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, responseHeader, log) {
    const connectAndWrite = (address, port) => {
      return new Promise((resolve, reject) => {
        const tcpSocket = net.createConnection({
          host: address,
          port: port
        }, () => {
          log(`connected to ${address}:${port}`);
          tcpSocket.write(rawClientData);
          resolve(tcpSocket);
        });
        tcpSocket.on('error', reject);
      });
    };

    const retry = async () => {
      try {
        const tcpSocket = await connectAndWrite(
          this.prxIP.split(/[:=-]/)[0] || addressRemote,
          this.prxIP.split(/[:=-]/)[1] || portRemote
        );
        remoteSocket.value = tcpSocket;
        
        tcpSocket.on('close', () => { webSocket.close(); });
        tcpSocket.on('error', (error) => { webSocket.close(); });

        this.remoteSocketToWS(tcpSocket, webSocket, responseHeader, null, log);
      } catch (error) {
        webSocket.close();
      }
    };

    try {
      const tcpSocket = await connectAndWrite(addressRemote, portRemote);
      remoteSocket.value = tcpSocket;
      
      tcpSocket.on('close', () => { webSocket.close(); });
      tcpSocket.on('error', (error) => { webSocket.close(); });

      this.remoteSocketToWS(tcpSocket, webSocket, responseHeader, retry, log);
    } catch (error) {
      await retry();
    }
  }

  // ==================== UDP NATIVE HANDLER ====================

  async handleUDPOutbound(targetAddress, targetPort, dataChunk, webSocket, responseHeader, log) {
    return new Promise((resolve) => {
      try {
        let protocolHeader = responseHeader;
        const connectionKey = `${targetAddress}:${targetPort}:${Date.now()}`;
        const udpSocket = dgram.createSocket('udp4');
        
        this.activeUDPConnections.set(connectionKey, {
          socket: udpSocket,
          webSocket: webSocket
        });
        
        // AMAN: Tangani error socket langsung agar tidak memicu uncaught exceptions
        udpSocket.on('error', (error) => {
          console.error(`[UDP Socket Error] ${targetAddress}:${targetPort} ->`, error.message);
          try {
            udpSocket.close();
          } catch (_) {}
          this.activeUDPConnections.delete(connectionKey);
        });

        udpSocket.send(dataChunk, targetPort, targetAddress, (error) => {
          if (error) {
            console.error(`[UDP Send Error]`, error.message);
            try { udpSocket.close(); } catch (_) {}
            this.activeUDPConnections.delete(connectionKey);
            return;
          }
        });
        
        udpSocket.on('message', (message, rinfo) => {
          if (webSocket.readyState === WebSocket.OPEN) {
            if (protocolHeader) {
              const combined = Buffer.concat([Buffer.from(protocolHeader), message]);
              webSocket.send(combined);
              protocolHeader = null;
            } else {
              webSocket.send(message);
            }
          }
        });
        
        udpSocket.on('close', () => {
          this.activeUDPConnections.delete(connectionKey);
        });
        
        let idleTimeout = setTimeout(() => {
          if (udpSocket) {
            try { udpSocket.close(); } catch (_) {}
            this.activeUDPConnections.delete(connectionKey);
          }
        }, 30000);
        
        udpSocket.on('message', () => {
          clearTimeout(idleTimeout);
          idleTimeout = setTimeout(() => {
            if (udpSocket) {
              try { udpSocket.close(); } catch (_) {}
              this.activeUDPConnections.delete(connectionKey);
            }
          }, 30000);
        });
        
      } catch (e) {
        console.error(`Error in UDP handler execution: ${e.message}`);
      }
    });
  }

  cleanupUDPConnections(webSocket) {
    for (const [key, connection] of this.activeUDPConnections.entries()) {
      if (connection.webSocket === webSocket) {
        try {
          connection.socket.close();
        } catch (_) {}
        this.activeUDPConnections.delete(key);
      }
    }
  }

  readSsHeader(ssBuffer) {
    const addressType = ssBuffer[0];
    let addressLength = 0;
    let addressValueIndex = 1;
    let addressValue = "";

    switch (addressType) {
      case 1:
        addressLength = 4;
        addressValue = Array.from(ssBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join(".");
        break;
      case 3:
        addressLength = ssBuffer[addressValueIndex];
        addressValueIndex += 1;
        addressValue = ssBuffer.slice(addressValueIndex, addressValueIndex + addressLength).toString();
        break;
      case 4:
        addressLength = 16;
        const ipv6 = [];
        for (let i = 0; i < 8; i++) {
          ipv6.push(ssBuffer.readUInt16BE(addressValueIndex + i * 2).toString(16));
        }
        addressValue = ipv6.join(":");
        break;
      default:
        return { hasError: true, message: `Invalid addressType for SS: ${addressType}` };
    }

    if (!addressValue) {
      return { hasError: true, message: `Destination address empty, address type is: ${addressType}` };
    }

    const portIndex = addressValueIndex + addressLength;
    const portRemote = ssBuffer.readUInt16BE(portIndex);
    return {
      hasError: false,
      addressRemote: addressValue,
      addressType: addressType,
      portRemote: portRemote,
      rawDataIndex: portIndex + 2,
      rawClientData: ssBuffer.slice(portIndex + 2),
      version: null,
      isUDP: portRemote == 53,
    };
  }

  readFlashHeader(buffer) {
    const version = buffer[0];
    let isUDP = false;

    const optLength = buffer[17];
    const cmd = buffer[18 + optLength];
    
    if (cmd === 2) {
      isUDP = true;
    } else if (cmd !== 1) {
      return { hasError: true, message: `command ${cmd} is not supported` };
    }
    
    const portIndex = 18 + optLength + 1;
    const portRemote = buffer.readUInt16BE(portIndex);

    let addressIndex = portIndex + 2;
    const addressType = buffer[addressIndex];
    
    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    let addressValue = "";
    
    switch (addressType) {
      case 1:
        addressLength = 4;
        addressValue = Array.from(buffer.slice(addressValueIndex, addressValueIndex + addressLength)).join(".");
        break;
      case 2:
        addressLength = buffer[addressValueIndex];
        addressValueIndex += 1;
        addressValue = buffer.slice(addressValueIndex, addressValueIndex + addressLength).toString();
        break;
      case 3:
        addressLength = 16;
        const ipv6 = [];
        for (let i = 0; i < 8; i++) {
          ipv6.push(buffer.readUInt16BE(addressValueIndex + i * 2).toString(16));
        }
        addressValue = ipv6.join(":");
        break;
      default:
        return { hasError: true, message: `invalid addressType is ${addressType}` };
    }
    
    if (!addressValue) {
      return { hasError: true, message: `addressValue is empty, addressType is ${addressType}` };
    }

    return {
      hasError: false,
      addressRemote: addressValue,
      addressType: addressType,
      portRemote: portRemote,
      rawDataIndex: addressValueIndex + addressLength,
      rawClientData: buffer.slice(addressValueIndex + addressLength),
      version: Buffer.from([version, 0]),
      isUDP: isUDP,
    };
  }

  readHorseHeader(buffer) {
    const dataBuffer = buffer.slice(58);
    if (dataBuffer.length < 6) {
      return { hasError: true, message: "invalid request data" };
    }

    let isUDP = false;
    const cmd = dataBuffer[0];
    if (cmd == 3) {
      isUDP = true;
    } else if (cmd != 1) {
      throw new Error("Unsupported command type!");
    }

    let addressType = dataBuffer[1];
    let addressLength = 0;
    let addressValueIndex = 2;
    let addressValue = "";
    
    switch (addressType) {
      case 1:
        addressLength = 4;
        addressValue = Array.from(dataBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join(".");
        break;
      case 3:
        addressLength = dataBuffer[addressValueIndex];
        addressValueIndex += 1;
        addressValue = dataBuffer.slice(addressValueIndex, addressValueIndex + addressLength).toString();
        break;
      case 4:
        addressLength = 16;
        const ipv6 = [];
        for (let i = 0; i < 8; i++) {
          ipv6.push(dataBuffer.readUInt16BE(addressValueIndex + i * 2).toString(16));
        }
        addressValue = ipv6.join(":");
        break;
      default:
        return { hasError: true, message: `invalid addressType is ${addressType}` };
    }

    if (!addressValue) {
      return { hasError: true, message: `address is empty, addressType is ${addressType}` };
    }

    const portIndex = addressValueIndex + addressLength;
    const portRemote = dataBuffer.readUInt16BE(portIndex);
    return {
      hasError: false,
      addressRemote: addressValue,
      addressType: addressType,
      portRemote: portRemote,
      rawDataIndex: portIndex + 4,
      rawClientData: dataBuffer.slice(portIndex + 4),
      version: null,
      isUDP: isUDP,
    };
  }

  remoteSocketToWS(remoteSocket, webSocket, responseHeader, retry, log) {
    let header = responseHeader;
    let hasIncomingData = false;

    remoteSocket.on('data', (chunk) => {
      hasIncomingData = true;
      if (webSocket.readyState !== WS_READY_STATE_OPEN) {
        remoteSocket.destroy();
        return;
      }
      if (header) {
        const combined = Buffer.concat([Buffer.from(header), chunk]);
        webSocket.send(combined);
        header = null;
      } else {
        webSocket.send(chunk);
      }
    });

    remoteSocket.on('close', () => {
      if (hasIncomingData === false && retry) {
        retry();
      }
    });

    remoteSocket.on('error', (error) => {
      console.error(`remoteSocket error:`, error);
    });
  }

  // ==================== SERVER START ====================

  start(port = process.env.PORT || 3000) {
    const server = http.createServer((req, res) => {
      this.handleHttpRequest(req, res).catch(error => {
        console.error('HTTP handler error:', error);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      });
    });

    this.wss = new WebSocket.Server({ 
      server,
      perMessageDeflate: false
    });

    this.wss.on('connection', (ws, req) => {
      this.handleWebSocketConnection(ws, req);
    });

    const gracefulShutdown = () => {
      console.log('Shutting down gracefully...');
      if (this.wss) {
        this.wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.close();
          }
        });
        this.wss.close();
      }
      
      // AMAN: Bersihkan koneksi UDP dengan proteksi catch error
      for (const [key, connection] of this.activeUDPConnections.entries()) {
        try {
          connection.socket.close();
        } catch (err) {
          // Abaikan jika socket sudah ditutup sebelumnya
        }
      }
      this.activeUDPConnections.clear();
      
      if (this.httpServer) {
        this.httpServer.close(() => {
          console.log('HTTP server closed');
          process.exit(0);
        });
      }
      setTimeout(() => { process.exit(1); }, 10000);
    };

    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);

    server.listen(port, '0.0.0.0', () => {
      console.log(`✅ Gateway server running on port ${port}`);
    });

    this.httpServer = server;
    
    server.on('error', (error) => {
      console.error('Server error:', error);
      if (error.code === 'EADDRINUSE') {
        console.error(`Port ${port} is already in use`);
        process.exit(1);
      }
    });
  }
}

if (require.main === module) {
  const server = new GatewayServer();
  try {
    require('dotenv').config();
  } catch (e) {}
  const port = process.env.PORT || 3000;
  server.start(port);
}

module.exports = GatewayServer;
