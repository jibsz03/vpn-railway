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
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>J1BTNL CONFIG SNI</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700;900&display=swap');
    body {
      font-family: 'JetBrains Mono', monospace;
      background-color: #050806;
    }
    .neon-border {
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    .neon-border:hover {
      border-color: rgba(16, 185, 129, 0.8);
    }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: #080c09; }
    ::-webkit-scrollbar-thumb { background: #1b4332; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #10b981; }
  </style>
</head>
<body class="text-slate-300 min-h-screen flex flex-col justify-between selection:bg-emerald-600 selection:text-white">

  <header class="relative overflow-hidden bg-[#020403] border-b border-emerald-500/20 px-4 py-3 shadow-[0_2px_15px_rgba(16,185,129,0.03)] sticky top-0 z-50">
    <div class="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-emerald-500 to-transparent opacity-50"></div>
    <div class="max-w-7xl mx-auto flex items-center justify-between gap-2 z-10 relative">
      <div class="flex items-center gap-3">
        <div class="relative flex items-center justify-center w-9 h-9 sm:w-10 sm:h-10 rounded-lg sm:rounded-xl bg-gradient-to-br from-emerald-900 to-black border border-emerald-500/30">
          <i class="fa-solid fa-shield-halved text-sm sm:text-base text-emerald-400"></i>
          <div class="absolute inset-0 rounded-lg sm:rounded-xl border border-emerald-400/20 animate-ping opacity-20 hidden sm:block"></div>
        </div>
        <div class="flex flex-col">
          <h1 class="text-base sm:text-lg font-black tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 via-teal-300 to-cyan-500 uppercase leading-none">
            J1BTNL <span class="font-light text-slate-300">CONFIG</span>
          </h1>
          <p class="text-[8px] sm:text-[9px] uppercase tracking-[0.15em] text-emerald-500/70 font-bold mt-1">SNI Injection Protocol</p>
        </div>
      </div>
      <div class="flex items-center gap-2 bg-[#050a07] border border-emerald-800/60 px-2.5 py-1.5 rounded text-xs shadow-inner">
        <div class="relative flex h-1.5 w-1.5">
          <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
          <span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500"></span>
        </div>
        <span class="text-[9px] font-bold text-emerald-300 tracking-wider uppercase">ONLINE</span>
      </div>
    </div>
  </header>

  <main class="max-w-7xl w-full mx-auto p-4 sm:p-6 space-y-6 sm:space-y-8 flex-grow">
    
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
      <div class="bg-[#0a100c] neon-border p-4 sm:p-5 rounded-xl flex items-center justify-between">
        <div>
          <p class="text-[10px] sm:text-xs text-slate-500 font-medium mb-1">SYSTEM UPTIME</p>
          <p id="uptime-val" class="text-[11px] sm:text-xs md:text-sm font-bold text-white font-mono">Calculating...</p>
        </div>
        <i class="fa-solid fa-clock text-emerald-900/50 text-xl sm:text-2xl"></i>
      </div>
      <div class="bg-[#0a100c] neon-border p-4 sm:p-5 rounded-xl flex items-center justify-between">
        <div>
          <p class="text-[10px] sm:text-xs text-slate-500 font-medium mb-1">RAM</p>
          <p class="text-base sm:text-lg font-bold text-white">${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB</p>
        </div>
        <i class="fa-solid fa-microchip text-emerald-900/50 text-xl sm:text-2xl"></i>
      </div>
      <div class="bg-[#0a100c] neon-border p-4 sm:p-5 rounded-xl flex items-center justify-between">
        <div>
          <p class="text-[10px] sm:text-xs text-slate-500 font-medium mb-1">UDP</p>
          <p class="text-base sm:text-lg font-bold text-teal-400">ONLINE</p>
        </div>
        <i class="fa-solid fa-bolt text-teal-900/50 text-xl sm:text-2xl"></i>
      </div>
      <div class="bg-[#0a100c] neon-border p-4 sm:p-5 rounded-xl flex items-center justify-between">
        <div>
          <p id="date-val" class="text-[9px] text-slate-500 font-medium mb-1 uppercase tracking-wider">Loading Date...</p>
          <p id="clock-val" class="text-base sm:text-lg font-bold text-emerald-400 font-mono">00:00:00</p>
        </div>
        <i class="fa-solid fa-calendar-days text-emerald-900/50 text-xl sm:text-2xl"></i>
      </div>
    </div>

    <div class="bg-[#0a100c] border border-emerald-900/30 rounded-xl p-5 sm:p-6 space-y-5 shadow-lg shadow-black/50">
      <div class="flex items-center gap-2 border-b border-emerald-900/30 pb-3">
        <i class="fa-solid fa-key text-emerald-400"></i>
        <h2 class="text-sm sm:text-md font-bold tracking-wide text-white">VLESS / TROJAN GENERATOR</h2>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-6 sm:gap-8">
        
        <div class="space-y-4">
          <div>
            <label class="text-xs text-slate-400 font-medium mb-1.5 block">UUID / Password</label>
            <div class="flex gap-2">
              <input id="uuidInput" type="text" value="853b8456-0c0b-4bfa-b3b4-b2619248a9bc" 
                     class="w-full bg-[#0c130e] border border-emerald-900/50 rounded-lg px-3 py-2 text-sm text-white font-mono focus:border-emerald-500 focus:outline-none transition">
              <button id="randomUuidBtn" class="bg-emerald-600/20 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-600 hover:text-white px-3 py-2 rounded-lg text-xs transition flex items-center gap-1 whitespace-nowrap">
                <i class="fa-solid fa-shuffle"></i> RANDOM
              </button>
            </div>
          </div>

          <div>
            <label class="text-xs text-slate-400 font-medium mb-1.5 block">Host / Domain</label>
            <input id="hostInput" type="text" value="${currentHost}" 
                   class="w-full bg-[#0c130e] border border-emerald-900/50 rounded-lg px-3 py-2 text-sm text-white font-mono focus:border-emerald-500 focus:outline-none transition">
          </div>

          <div>
            <label class="text-xs text-slate-400 font-medium mb-1.5 block">Port</label>
            <input id="portInput" type="text" value="443" 
                   class="w-full bg-[#0c130e] border border-emerald-900/50 rounded-lg px-3 py-2 text-sm text-white font-mono focus:border-emerald-500 focus:outline-none transition">
          </div>

          <div>
            <label class="text-xs text-slate-400 font-medium mb-1.5 block">Path</label>
            <div class="flex flex-col sm:flex-row gap-2">
              <select id="pathSelect" 
                      class="bg-[#0c130e] border border-emerald-900/50 rounded-lg px-3 py-2 text-sm text-white font-mono focus:border-emerald-500 focus:outline-none transition w-full sm:w-auto">
                <option value="/ID">🇮🇩 /ID (Indonesia)</option>
                <option value="/SG">🇸🇬 /SG (Singapore)</option>
                <option value="/JP">🇯🇵 /JP (Japan)</option>
                <option value="/US">🇺🇸 /US (USA)</option>
				<option value="/EUROPE">🇪🇺 /EUROPE</option>
                <option value="/ASIA">🌏 /ASIA (Asia Region)</option>
				<option value="/ALL">🌍 /ALL (Rotate Global)</option>
                <option value="/AMERICA">🌎 /AMERICA</option>
              </select>
              <input id="pathInput" type="text" value="/ID" 
                     class="w-full bg-[#0c130e] border border-emerald-900/50 rounded-lg px-3 py-2 text-sm text-white font-mono focus:border-emerald-500 focus:outline-none transition">
            </div>
          </div>

          <div>
            <label class="text-xs text-slate-400 font-medium mb-1.5 block">
              <i class="fa-solid fa-fingerprint text-teal-400 mr-1"></i> SNI (Server Name Indication)
            </label>
            <div class="space-y-2 mb-2">
              <select id="sniSelect" 
                      class="w-full bg-[#0c130e] border border-emerald-900/50 rounded-lg px-3 py-2 text-sm text-white font-mono focus:border-teal-500 focus:outline-none transition">
                <option value="business.whatsapp.com">📱 business.whatsapp.com</option>
                <option value="media-sin6-3.cdn.whatsapp.net">📡 media-sin6-3.cdn.whatsapp.net</option>
                <option value="c.whatsapp.com">💬 c.whatsapp.com</option>
                <option value="web.whatsapp.com">🌐 web.whatsapp.com</option>
                <option value="v.whatsapp.net">📞 v.whatsapp.net</option>
                <option value="live.iflix.com">🎬 live.iflix.com</option>
                <option value="custom">✏️ CUSTOM SNI...</option>
              </select>
              
              <input id="sniInput" type="text" value="business.whatsapp.com" 
                     class="hidden w-full bg-[#0c130e] border border-teal-600/50 rounded-lg px-3 py-2 text-sm text-white font-mono focus:border-teal-500 focus:outline-none transition"
                     placeholder="Ketik SNI Custom Anda di sini...">
            </div>
            <p class="text-[10px] text-slate-600">Pilih dari daftar atau pilih 'CUSTOM SNI' untuk mengetik manual.</p>
          </div>

          <div>
            <label class="text-xs text-slate-400 font-medium mb-1.5 block">Nama / Remark</label>
            <input id="remarkInput" type="text" value="J1BTNL" 
                   class="w-full bg-[#0c130e] border border-emerald-900/50 rounded-lg px-3 py-2 text-sm text-white font-mono focus:border-emerald-500 focus:outline-none transition">
          </div>

          <button id="generateBtn" 
                  class="w-full bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold py-3 px-4 rounded-lg transition text-sm flex items-center justify-center gap-2 active:scale-95 shadow-lg shadow-emerald-900/50 mt-4">
            <i class="fa-solid fa-bolt"></i> GENERATE CONFIG
          </button>
        </div>

        <div class="space-y-4">
          <label class="text-sm text-emerald-400 font-bold block border-b border-emerald-900/50 pb-2">📋 Hasil Generate</label>
          
          <div class="space-y-3">
            <div class="bg-[#060a07] rounded-lg p-3 sm:p-4 border border-emerald-950 hover:border-emerald-800 transition">
              <div class="flex items-center justify-between mb-2">
                <span class="text-[10px] bg-purple-500/10 text-purple-400 px-2 py-0.5 rounded font-bold border border-purple-500/20">VLESS PROTOCOL</span>
                <button onclick="copyText(document.getElementById('vlessOutput').textContent)" 
                        class="text-[10px] sm:text-xs bg-[#0c130e] border border-emerald-900/50 text-slate-400 hover:text-emerald-400 px-2 sm:px-3 py-1.5 rounded transition flex items-center gap-1 active:scale-95">
                  <i class="fa-regular fa-copy"></i> COPY
                </button>
              </div>
              <p id="vlessOutput" class="text-[10px] sm:text-xs text-purple-300 font-mono break-all leading-relaxed bg-[#080d0a] p-2 sm:p-3 rounded border border-emerald-900/30">
                Loading...
              </p>
            </div>

            <div class="bg-[#060a07] rounded-lg p-3 sm:p-4 border border-emerald-950 hover:border-emerald-800 transition">
              <div class="flex items-center justify-between mb-2">
                <span class="text-[10px] bg-orange-500/10 text-orange-400 px-2 py-0.5 rounded font-bold border border-orange-500/20">TROJAN PROTOCOL</span>
                <button onclick="copyText(document.getElementById('trojanOutput').textContent)" 
                        class="text-[10px] sm:text-xs bg-[#0c130e] border border-emerald-900/50 text-slate-400 hover:text-emerald-400 px-2 sm:px-3 py-1.5 rounded transition flex items-center gap-1 active:scale-95">
                  <i class="fa-regular fa-copy"></i> COPY
                </button>
              </div>
              <p id="trojanOutput" class="text-[10px] sm:text-xs text-orange-300 font-mono break-all leading-relaxed bg-[#080d0a] p-2 sm:p-3 rounded border border-emerald-900/30">
                Loading...
              </p>
            </div>
          </div>

          <div class="bg-[#0c130e] border border-emerald-900/50 rounded-lg p-3 sm:p-4 mt-2">
            <div class="flex items-center justify-between mb-2">
              <p class="text-[10px] font-bold text-emerald-500/80">🔗 CLASH META / V2RAY RAW CONFIG</p>
              <button onclick="copyText(document.getElementById('clashOutput').textContent)" 
                      class="text-xs text-slate-400 hover:text-emerald-400 transition flex items-center gap-1">
                <i class="fa-regular fa-copy"></i>
              </button>
            </div>
            <pre id="clashOutput" class="text-[10px] sm:text-[11px] text-slate-400 font-mono break-all leading-relaxed whitespace-pre-wrap bg-[#080d0a] p-2 sm:p-3 rounded border border-emerald-900/30 max-h-56 overflow-y-auto">Loading...</pre>
          </div>
        </div>

      </div>
    </div>

  </main>

  <footer class="border-t border-emerald-950 bg-[#040605] px-4 sm:px-6 py-4 sm:py-5 text-center text-[10px] sm:text-xs text-slate-600">
    <div class="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 sm:gap-3">
      <p>&copy; ${new Date().getFullYear()} J1BTNL CONFIG SNI. ALL SYSTEM VECTORS OPERATIONAL.</p>
      <p class="flex items-center gap-1 sm:gap-2"><i class="fa-solid fa-shield-check text-emerald-500/60"></i> SECURED BY END-TO-END KERNEL TUNNEL</p>
    </div>
  </footer>

  <div id="toast" class="fixed bottom-6 right-6 bg-emerald-600 text-white font-semibold px-4 py-3 rounded-lg shadow-lg shadow-emerald-900/50 opacity-0 pointer-events-none transition-all duration-300 transform translate-y-2 text-xs z-50 flex items-center gap-2 border border-emerald-400/50">
    <i class="fa-solid fa-circle-check"></i> ENDPOINT COPIED TO CLIPBOARD
  </div>

  <script>
    // ==================== COPY FUNCTION ====================
    function copyText(text) {
      navigator.clipboard.writeText(text).then(() => {
        const toast = document.getElementById('toast');
        toast.classList.remove('opacity-0', 'pointer-events-none', 'translate-y-2');
        toast.classList.add('opacity-100', 'translate-y-0');
        setTimeout(() => {
          toast.classList.remove('opacity-100', 'translate-y-0');
          toast.classList.add('opacity-0', 'pointer-events-none', 'translate-y-2');
        }, 2500);
      });
    }

    // ==================== LOGIKA UPTIME & REAL-TIME CLOCK ====================
    let totalSeconds = ${Math.floor(process.uptime())};

    function updateDashboardTime() {
      // 1. Hitung Uptime Struktural (Hari, Jam, Menit, Detik)
      const d = Math.floor(totalSeconds / 86400);
      const h = Math.floor((totalSeconds % 86400) / 3600);
      const m = Math.floor((totalSeconds % 3600) / 60);
      const s = totalSeconds % 60;

      // Format string ringkas agar muat di grid: "1d 02h 15m 30s"
      const uptimeStr = (d > 0 ? d + 'd ' : '') + 
                        (h < 10 ? '0' + h : h) + 'h ' + 
                        (m < 10 ? '0' + m : m) + 'm ' + 
                        (s < 10 ? '0' + s : s) + 's';
      
      const uptimeEl = document.getElementById('uptime-val');
      if (uptimeEl) uptimeEl.innerText = uptimeStr;

      // 2. Hitung Jam dan Tanggal Nyata (Real-time Server Clock)
      const now = new Date();
      const dateOptions = { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' };
      const dateStr = now.toLocaleDateString('id-ID', dateOptions);
      const timeStr = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

      const dateEl = document.getElementById('date-val');
      const clockEl = document.getElementById('clock-val');
      
      if (dateEl) dateEl.innerText = dateStr;
      if (clockEl) clockEl.innerText = timeStr.replace(/\./g, ':'); // Pastikan separator menggunakan titik dua
    }

    // Jalankan kalkulasi pertama kali & set trigger interval per 1 detik
    updateDashboardTime();
    setInterval(() => {
      totalSeconds++;
      updateDashboardTime();
    }, 1000);

    // ==================== GENERATOR SCRIPTS ====================
    function generateUUID() {
      const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
      document.getElementById('uuidInput').value = uuid;
      generateAccounts();
    }

    function generateTrojanPass() {
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let pass = '';
      for (let i = 0; i < 36; i++) {
        if (i === 8 || i === 13 || i === 18 || i === 23) {
          pass += '-';
        } else {
          pass += chars.charAt(Math.floor(Math.random() * chars.length));
        }
      }
      return pass;
    }

    function generateAccounts() {
      try {
        const uuidEl = document.getElementById('uuidInput');
        const hostEl = document.getElementById('hostInput');
        const portEl = document.getElementById('portInput');
        const pathEl = document.getElementById('pathInput');
        const sniEl = document.getElementById('sniInput');
        const remarkEl = document.getElementById('remarkInput');
        const vlessOut = document.getElementById('vlessOutput');
        const trojanOut = document.getElementById('trojanOutput');
        const clashOut = document.getElementById('clashOutput');

        if (!uuidEl || !hostEl || !portEl || !pathEl || !sniEl || !remarkEl || !vlessOut || !trojanOut || !clashOut) {
          return;
        }

        const uuid = uuidEl.value.trim() || '853b8456-0c0b-4bfa-b3b4-b2619248a9bc';
        const host = hostEl.value.trim() || '${currentHost}';
        const port = portEl.value.trim() || '443';
        const path = pathEl.value.trim() || '/ALL';
        const sni = sniEl.value.trim() || 'business.whatsapp.com';
        const remark = remarkEl.value.trim() || 'J1BTNL';

        const encodedPath = encodeURIComponent(path);
        const encodedRemark = encodeURIComponent(remark);

        // VLESS
        const vlessUrl = 'vless://' + uuid + '@' + host + ':' + port +
                         '?encryption=none&security=tls&sni=' + sni +
                         '&fp=randomized&type=ws&host=' + host +
                         '&path=' + encodedPath + '#' + encodedRemark;

        // TROJAN
        const trojanPass = generateTrojanPass();
        const trojanUrl = 'trojan://' + trojanPass + '@' + host + ':' + port +
                          '?sni=' + sni +
                          '&type=ws&host=' + host +
                          '&path=' + encodedPath + '#' + encodedRemark;

        vlessOut.textContent = vlessUrl;
        trojanOut.textContent = trojanUrl;

        // CLASH META format
        const clashConfig = '- name: "' + remark + ' VLESS"\\n' +
                            '  type: vless\\n' +
                            '  server: ' + host + '\\n' +
                            '  port: ' + port + '\\n' +
                            '  uuid: ' + uuid + '\\n' +
                            '  network: ws\\n' +
                            '  tls: true\\n' +
                            '  udp: true\\n' +
                            '  sni: "' + sni + '"\\n' +
                            '  client-fingerprint: randomized\\n' +
                            '  ws-opts:\\n' +
                            '    path: "' + path + '"\\n' +
                            '    headers:\\n' +
                            '      host: "' + host + '"\\n\\n' +
                            '- name: "' + remark + ' TROJAN"\\n' +
                            '  type: trojan\\n' +
                            '  server: ' + host + '\\n' +
                            '  port: ' + port + '\\n' +
                            '  password: ' + trojanPass + '\\n' +
                            '  network: ws\\n' +
                            '  tls: true\\n' +
                            '  udp: true\\n' +
                            '  sni: "' + sni + '"\\n' +
                            '  ws-opts:\\n' +
                            '    path: "' + path + '"\\n' +
                            '    headers:\\n' +
                            '      host: "' + host + '"';

        clashOut.textContent = clashConfig;
      } catch (err) {
        console.error('Generator Error:', err);
      }
    }

    // ==================== EVENT LISTENERS ====================
    setTimeout(function() {
      generateAccounts();
    }, 300);

    setTimeout(function() {
      const elements = ['uuidInput', 'hostInput', 'portInput', 'pathInput', 'sniInput', 'remarkInput'];
      elements.forEach(function(id) {
        const el = document.getElementById(id);
        if (el) {
          el.addEventListener('input', generateAccounts);
        }
      });

      const pathSelect = document.getElementById('pathSelect');
      if (pathSelect) {
        pathSelect.addEventListener('change', function() {
          const pathInput = document.getElementById('pathInput');
          if (pathInput) {
            pathInput.value = this.value;
            generateAccounts();
          }
        });
      }

      // SHOW/HIDE SNI INPUT KONDISIONAL
      const sniSelect = document.getElementById('sniSelect');
      if (sniSelect) {
        sniSelect.addEventListener('change', function() {
          const sniInput = document.getElementById('sniInput');
          if (sniInput) {
            if (this.value === 'custom') {
              sniInput.classList.remove('hidden');
              sniInput.value = '';
              sniInput.focus();
            } else {
              sniInput.classList.add('hidden');
              sniInput.value = this.value;
              generateAccounts();
            }
          }
        });
      }

      const genBtn = document.getElementById('generateBtn');
      if (genBtn) {
        genBtn.addEventListener('click', function(e) {
          e.preventDefault();
          generateAccounts();
        });
      }

      const randBtn = document.getElementById('randomUuidBtn');
      if (randBtn) {
        randBtn.addEventListener('click', function(e) {
          e.preventDefault();
          generateUUID();
        });
      }
    }, 600);
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
      
      for (const [key, connection] of this.activeUDPConnections.entries()) {
        try {
          connection.socket.close();
        } catch (err) {}
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
