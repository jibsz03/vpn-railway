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

const KV_PRX_URL = "https://raw.githubusercontent.com/jibsz03/vpn/refs/heads/main/kvProxyList.json";
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
          <title>J1BTNL Config Lifetime | VLESS & Trojan Generator</title>
          <script src="https://cdn.tailwindcss.com"></script>
          <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
          <style>
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap');
            :root {
              --bg: #071118;
              --panel: rgba(10, 21, 31, .72);
              --panel-strong: #0d1a25;
              --line: rgba(130, 160, 185, .16);
              --line-glow: rgba(45, 212, 191, .35);
              --text: #e6f2fa;
              --muted: #8192a3;
              --field: rgba(3, 12, 19, .65);
            }
            body.light {
              --bg: #ecf7f7;
              --panel: rgba(255, 255, 255, .78);
              --panel-strong: #ffffff;
              --line: rgba(13, 148, 136, .14);
              --text: #102433;
              --muted: #647587;
              --field: rgba(237, 246, 247, .92);
            }
            * { box-sizing: border-box; }
            body {
              font-family: 'Inter', sans-serif;
              min-height: 100vh;
              color: var(--text);
              background:
                radial-gradient(circle at 10% 0%, rgba(20,184,166,.22), transparent 32%),
                radial-gradient(circle at 92% 8%, rgba(139,92,246,.25), transparent 30%),
                radial-gradient(circle at 48% 100%, rgba(14,165,233,.10), transparent 34%),
                var(--bg);
              transition: background .25s ease, color .25s ease;
            }
            .mono { font-family: 'JetBrains Mono', monospace; }
            .glass {
              background: var(--panel);
              border: 1px solid var(--line);
              backdrop-filter: blur(18px);
              -webkit-backdrop-filter: blur(18px);
              box-shadow: 0 16px 46px rgba(0,0,0,.15);
            }
            .edge:hover { border-color: var(--line-glow); }
            .field {
              width: 100%;
              color: var(--text);
              background: var(--field);
              border: 1px solid var(--line);
              border-radius: .85rem;
              outline: none;
              transition: border-color .2s, box-shadow .2s;
            }
            .field:focus {
              border-color: rgba(45,212,191,.65);
              box-shadow: 0 0 0 3px rgba(45,212,191,.12);
            }
            .field:disabled { opacity: .5; cursor: not-allowed; }
            .primary {
              background: linear-gradient(110deg, #14b8a6, #2563eb 52%, #7c3aed);
              box-shadow: 0 12px 30px rgba(20,184,166,.18);
            }
            .route-option:checked + label {
              border-color: rgba(45,212,191,.62);
              background: rgba(20,184,166,.12);
              color: #2dd4bf;
            }
            .output {
              word-break: break-all;
              white-space: pre-wrap;
              min-height: 5rem;
            }
            .pulse-dot { box-shadow: 0 0 0 0 rgba(52,211,153,.5); animation: pingSoft 2s infinite; }
            @keyframes pingSoft { 0% { box-shadow:0 0 0 0 rgba(52,211,153,.45); } 70% { box-shadow:0 0 0 8px rgba(52,211,153,0); } 100% { box-shadow:0 0 0 0 rgba(52,211,153,0); } }
            ::-webkit-scrollbar { width: 6px; height: 6px; }
            ::-webkit-scrollbar-thumb { background: rgba(100,116,139,.45); border-radius: 999px; }
          </style>
        </head>
        <body class="selection:bg-teal-500 selection:text-white">

          <header class="px-4 sm:px-6 pt-4">
            <div class="max-w-6xl mx-auto glass rounded-2xl px-4 sm:px-6 py-4 flex items-center justify-between gap-3">
              <div class="flex items-center gap-3 min-w-0">
                <div class="h-11 w-11 rounded-2xl bg-gradient-to-br from-teal-400/20 to-violet-500/20 border border-teal-400/25 flex items-center justify-center text-teal-300 shrink-0">
                  <i class="fa-solid fa-shield-halved text-xl"></i>
                </div>
                <div class="min-w-0">
                  <h1 class="text-base sm:text-lg font-bold tracking-tight truncate">J1BTNL <span class="text-teal-400">Config Lifetime</span></h1>
                  <p class="text-[11px] text-slate-400 truncate">VLESS & TROJAN GENERATOR • WS + TLS</p>
                </div>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <div class="hidden sm:flex items-center gap-2 px-3 py-2 rounded-xl border border-emerald-400/15 bg-emerald-400/5">
                  <span class="pulse-dot h-2 w-2 rounded-full bg-emerald-400"></span>
                  <span class="text-xs font-semibold text-emerald-400">ONLINE</span>
                </div>
                <button id="theme-btn" onclick="toggleTheme()" class="h-10 w-10 rounded-xl border border-slate-500/20 hover:border-teal-400/40 transition flex items-center justify-center" aria-label="Ganti tema">
                  <i id="theme-icon" class="fa-solid fa-moon text-slate-400"></i>
                </button>
              </div>
            </div>
          </header>

          <main class="max-w-6xl mx-auto px-4 sm:px-6 py-5 sm:py-8 space-y-5">
            <section class="glass rounded-3xl p-5 sm:p-7 overflow-hidden relative">
              <div class="absolute -right-16 -top-20 h-52 w-52 rounded-full bg-violet-500/10 blur-3xl pointer-events-none"></div>
              <div class="absolute -left-16 bottom-0 h-44 w-44 rounded-full bg-teal-500/10 blur-3xl pointer-events-none"></div>
              <div class="relative grid lg:grid-cols-[1.12fr_.88fr] gap-6 items-start">
                <div>
                  <div class="inline-flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-full border border-teal-400/20 text-teal-400 bg-teal-400/5 mb-4">
                    <i class="fa-solid fa-bolt"></i> CONFIG GENERATOR
                  </div>
                  <h2 class="text-2xl sm:text-3xl font-extrabold leading-tight mb-3">Buat config <span class="text-transparent bg-clip-text bg-gradient-to-r from-teal-400 to-violet-400">VLESS & Trojan</span></h2>
                  <p class="text-sm text-slate-400 leading-relaxed max-w-xl">Gunakan host gateway aktif dengan jalur negara, rotasi proxy, Asia, global, atau custom path sesuai kebutuhan koneksi.</p>
                </div>
                <div class="grid grid-cols-2 gap-3">
                  <div class="rounded-2xl bg-black/10 border border-slate-500/15 p-4">
                    <p class="text-[10px] uppercase tracking-widest text-slate-500 mb-2">Host</p>
                    <p class="mono text-xs text-teal-400 truncate">${currentHost}</p>
                  </div>
                  <div class="rounded-2xl bg-black/10 border border-slate-500/15 p-4">
                    <p class="text-[10px] uppercase tracking-widest text-slate-500 mb-2">Security</p>
                    <p class="mono text-xs text-violet-400">TLS • 443</p>
                  </div>
                  <div class="rounded-2xl bg-black/10 border border-slate-500/15 p-4">
                    <p class="text-[10px] uppercase tracking-widest text-slate-500 mb-2">Network</p>
                    <p class="mono text-xs text-sky-400">WebSocket</p>
                  </div>
                  <div class="rounded-2xl bg-black/10 border border-slate-500/15 p-4">
                    <p class="text-[10px] uppercase tracking-widest text-slate-500 mb-2">Uptime</p>
                    <p id="uptime-val" class="mono text-xs text-emerald-400">${Math.floor(process.uptime())}s</p>
                  </div>
                </div>
              </div>
            </section>

            <section class="grid lg:grid-cols-[.9fr_1.1fr] gap-5">
              <div class="glass rounded-3xl p-5 sm:p-6 space-y-5">
                <div class="flex items-center justify-between">
                  <h3 class="font-bold flex items-center gap-2"><i class="fa-solid fa-sliders text-teal-400"></i> Pengaturan Config</h3>
                  <button onclick="fillRandom()" class="text-xs text-teal-400 hover:text-teal-300 font-semibold"><i class="fa-solid fa-wand-magic-sparkles"></i> Acak Data</button>
                </div>

                <div>
                  <p class="text-xs text-slate-400 mb-2 font-medium">Pilih path routing</p>
                  <div class="grid grid-cols-2 gap-2">
                    <input class="route-option hidden" type="radio" name="route" id="path-id" value="/ID" checked onchange="routeChanged()">
                    <label for="path-id" class="cursor-pointer rounded-xl border border-slate-500/15 p-3 transition">
                      <span class="block text-xs font-semibold">Indonesia</span><span class="mono text-[10px] text-slate-500">/ID</span>
                    </label>
                    <input class="route-option hidden" type="radio" name="route" id="path-rotate" value="/PROXYLIST/ID,SG,JP" onchange="routeChanged()">
                    <label for="path-rotate" class="cursor-pointer rounded-xl border border-slate-500/15 p-3 transition">
                      <span class="block text-xs font-semibold">Rotate</span><span class="mono text-[10px] text-slate-500">ID,SG,JP</span>
                    </label>
                    <input class="route-option hidden" type="radio" name="route" id="path-asia" value="/ASIA" onchange="routeChanged()">
                    <label for="path-asia" class="cursor-pointer rounded-xl border border-slate-500/15 p-3 transition">
                      <span class="block text-xs font-semibold">Asia</span><span class="mono text-[10px] text-slate-500">/ASIA</span>
                    </label>
                    <input class="route-option hidden" type="radio" name="route" id="path-all" value="/ALL" onchange="routeChanged()">
                    <label for="path-all" class="cursor-pointer rounded-xl border border-slate-500/15 p-3 transition">
                      <span class="block text-xs font-semibold">Global</span><span class="mono text-[10px] text-slate-500">/ALL</span>
                    </label>
                  </div>
                </div>

                <label class="block">
                  <span class="text-xs text-slate-400 font-medium">Custom path <span class="text-slate-500">(opsional)</span></span>
                  <input id="custom-path" class="field mono text-sm px-4 py-3 mt-2" placeholder="/ID atau /IP=PORT" oninput="customPathChanged()">
                </label>

                <label class="block">
                  <span class="text-xs text-slate-400 font-medium">UUID VLESS</span>
                  <div class="mt-2 flex gap-2">
                    <input id="uuid" class="field mono text-xs px-4 py-3" placeholder="UUID untuk VLESS">
                    <button onclick="randomUuid()" class="px-3 rounded-xl border border-slate-500/15 hover:border-teal-400/40 text-teal-400 transition" aria-label="Generate UUID"><i class="fa-solid fa-rotate"></i></button>
                  </div>
                </label>

                <label class="block">
                  <span class="text-xs text-slate-400 font-medium">Password Trojan</span>
                  <div class="mt-2 flex gap-2">
                    <input id="password" class="field mono text-xs px-4 py-3" placeholder="Password untuk Trojan">
                    <button onclick="randomPassword()" class="px-3 rounded-xl border border-slate-500/15 hover:border-teal-400/40 text-teal-400 transition" aria-label="Generate password"><i class="fa-solid fa-rotate"></i></button>
                  </div>
                </label>

                <label class="block">
                  <span class="text-xs text-slate-400 font-medium">Nama config / Provider</span>
                  <input id="label" class="field text-sm px-4 py-3 mt-2" value="J1BTNL Lifetime" placeholder="Contoh: J1BTNL Lifetime">
                </label>

                <button onclick="generateConfigs(true)" class="primary w-full py-3.5 rounded-xl text-white text-sm font-bold hover:brightness-110 active:scale-[.99] transition">
                  <i class="fa-solid fa-bolt mr-2"></i> GENERATE CONFIG
                </button>
              </div>

              <div class="space-y-4">
                <div class="glass rounded-3xl p-5 sm:p-6">
                  <div class="flex items-center justify-between mb-4">
                    <div>
                      <h3 class="font-bold text-teal-400"><i class="fa-solid fa-link mr-2"></i>VLESS</h3>
                      <p class="text-[11px] text-slate-500 mt-1">TLS + WebSocket • UUID</p>
                    </div>
                    <button onclick="copyOutput('vless-output')" class="px-3 py-2 rounded-xl border border-teal-400/20 text-teal-400 hover:bg-teal-400/10 text-xs font-semibold transition">
                      <i class="fa-regular fa-copy mr-1"></i> COPY
                    </button>
                  </div>
                  <pre id="vless-output" class="output mono text-[11px] sm:text-xs rounded-2xl bg-black/15 border border-slate-500/10 p-4 text-slate-300">Tekan GENERATE CONFIG untuk membuat link VLESS.</pre>
                </div>

                <div class="glass rounded-3xl p-5 sm:p-6">
                  <div class="flex items-center justify-between mb-4">
                    <div>
                      <h3 class="font-bold text-violet-400"><i class="fa-solid fa-shield mr-2"></i>TROJAN</h3>
                      <p class="text-[11px] text-slate-500 mt-1">TLS + WebSocket • Password</p>
                    </div>
                    <button onclick="copyOutput('trojan-output')" class="px-3 py-2 rounded-xl border border-violet-400/20 text-violet-400 hover:bg-violet-400/10 text-xs font-semibold transition">
                      <i class="fa-regular fa-copy mr-1"></i> COPY
                    </button>
                  </div>
                  <pre id="trojan-output" class="output mono text-[11px] sm:text-xs rounded-2xl bg-black/15 border border-slate-500/10 p-4 text-slate-300">Tekan GENERATE CONFIG untuk membuat link Trojan.</pre>
                </div>

                <div class="glass rounded-3xl p-5">
                  <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
                    <h3 class="font-semibold text-sm"><i class="fa-solid fa-code-branch text-sky-400 mr-2"></i>Endpoint Tetap Aktif</h3>
                    <span class="text-[10px] text-slate-500">FUNGSI LAMA TIDAK DIUBAH</span>
                  </div>
                  <div class="grid sm:grid-cols-3 gap-2 text-xs">
                    <a href="${protocolHttp}://${currentHost}/api/proxies" target="_blank" class="edge rounded-xl border border-slate-500/15 px-3 py-3 transition hover:text-teal-400"><span class="block text-[10px] text-emerald-400 mb-1">GET</span>/api/proxies</a>
                    <a href="${protocolHttp}://${currentHost}/api/proxies?format=text" target="_blank" class="edge rounded-xl border border-slate-500/15 px-3 py-3 transition hover:text-teal-400"><span class="block text-[10px] text-emerald-400 mb-1">GET</span>/api/proxies?format=text</a>
                    <a href="${protocolHttp}://${currentHost}/health" target="_blank" class="edge rounded-xl border border-slate-500/15 px-3 py-3 transition hover:text-teal-400"><span class="block text-[10px] text-emerald-400 mb-1">GET</span>/health</a>
                  </div>
                </div>
              </div>
            </section>
          </main>

          <footer class="px-4 sm:px-6 pb-5">
            <div class="max-w-6xl mx-auto text-center text-xs text-slate-500">
              &copy; ${new Date().getFullYear()} J1BTNL Config Lifetime • Gateway host: <span class="mono">${currentHost}</span>
            </div>
          </footer>

          <div id="toast" class="fixed left-1/2 -translate-x-1/2 bottom-5 px-4 py-3 rounded-xl text-xs font-semibold text-white bg-slate-900 border border-teal-400/30 shadow-xl opacity-0 pointer-events-none transition duration-200 translate-y-2 z-50">
            <i class="fa-solid fa-circle-check text-teal-400 mr-2"></i><span id="toast-text">Berhasil</span>
          </div>

          <script>
            const CONFIG_HOST = ${JSON.stringify(currentHost)};
            let start = ${Math.floor(process.uptime())};

            function showToast(message, isError) {
              const toast = document.getElementById('toast');
              const text = document.getElementById('toast-text');
              text.innerText = message;
              toast.style.borderColor = isError ? 'rgba(248,113,113,.45)' : 'rgba(45,212,191,.35)';
              toast.classList.remove('opacity-0', 'pointer-events-none', 'translate-y-2');
              toast.classList.add('opacity-100', 'translate-y-0');
              clearTimeout(window.toastTimer);
              window.toastTimer = setTimeout(function () {
                toast.classList.remove('opacity-100', 'translate-y-0');
                toast.classList.add('opacity-0', 'pointer-events-none', 'translate-y-2');
              }, 2300);
            }

            function randomUuid() {
              const uuid = (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
                const r = Math.random() * 16 | 0;
                return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
              }));
              document.getElementById('uuid').value = uuid;
            }

            function randomPassword() {
              const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
              const values = new Uint32Array(20);
              crypto.getRandomValues(values);
              let output = '';
              values.forEach(function (v) { output += chars[v % chars.length]; });
              document.getElementById('password').value = output;
            }

            function fillRandom() {
              randomUuid();
              randomPassword();
              generateConfigs(false);
              showToast('UUID dan password baru dibuat', false);
            }

            function customPathChanged() {
              const value = document.getElementById('custom-path').value.trim();
              if (value) {
                document.querySelectorAll('input[name="route"]').forEach(function (el) { el.checked = false; });
              } else if (!document.querySelector('input[name="route"]:checked')) {
                document.getElementById('path-id').checked = true;
              }
            }

            function routeChanged() {
              document.getElementById('custom-path').value = '';
            }

            function getPath() {
              let custom = document.getElementById('custom-path').value.trim();
              if (custom) return custom.charAt(0) === '/' ? custom : '/' + custom;
              const selected = document.querySelector('input[name="route"]:checked');
              return selected ? selected.value : '/ID';
            }

            function generateConfigs(withNotice) {
              const uuid = document.getElementById('uuid').value.trim();
              const password = document.getElementById('password').value.trim();
              const label = document.getElementById('label').value.trim() || 'J1BTNL Lifetime';
              const path = getPath();

              if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(uuid)) {
                showToast('Isi UUID VLESS yang valid', true);
                return;
              }
              if (!password) {
                showToast('Isi password Trojan terlebih dahulu', true);
                return;
              }

              const hostValue = encodeURIComponent(CONFIG_HOST);
              const pathValue = encodeURIComponent(path);
              const nameValue = encodeURIComponent(label + ' ' + path.replace(/\//g, ' ').trim());
              const vless = 'vless://' + uuid + '@' + CONFIG_HOST + ':443?encryption=none&security=tls&sni=' + hostValue + '&fp=random&type=ws&host=' + hostValue + '&path=' + pathValue + '#' + nameValue;
              const trojan = 'trojan://' + encodeURIComponent(password) + '@' + CONFIG_HOST + ':443?security=tls&sni=' + hostValue + '&fp=random&type=ws&host=' + hostValue + '&path=' + pathValue + '#' + nameValue;

              document.getElementById('vless-output').textContent = vless;
              document.getElementById('trojan-output').textContent = trojan;
              if (withNotice) showToast('Config VLESS dan Trojan berhasil dibuat', false);
            }

            function copyText(text) {
              navigator.clipboard.writeText(text).then(function () {
                showToast('Config berhasil disalin', false);
              }).catch(function () {
                const tmp = document.createElement('textarea');
                tmp.value = text;
                document.body.appendChild(tmp);
                tmp.select();
                document.execCommand('copy');
                tmp.remove();
                showToast('Config berhasil disalin', false);
              });
            }

            function copyOutput(id) {
              const value = document.getElementById(id).textContent;
              if (!value || value.indexOf('Tekan GENERATE') === 0) {
                showToast('Generate config terlebih dahulu', true);
                return;
              }
              copyText(value);
            }

            function toggleTheme() {
              document.body.classList.toggle('light');
              const active = document.body.classList.contains('light');
              document.getElementById('theme-icon').className = active ? 'fa-solid fa-sun text-amber-500' : 'fa-solid fa-moon text-slate-400';
              localStorage.setItem('j1btnl-theme', active ? 'light' : 'dark');
            }

            (function init() {
              if (localStorage.getItem('j1btnl-theme') === 'light') {
                document.body.classList.add('light');
                document.getElementById('theme-icon').className = 'fa-solid fa-sun text-amber-500';
              }
              randomUuid();
              randomPassword();
              generateConfigs(false);
              setInterval(function () {
                start++;
                document.getElementById('uptime-val').innerText = start + 's';
              }, 1000);
            })();
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
