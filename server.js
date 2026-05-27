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
          <title>RAILWAY GATEWAY // DASHBOARD</title>
          <script src="https://cdn.tailwindcss.com"></script>
          <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
          <style>
            @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&display=swap');
            body {
              font-family: 'JetBrains Mono', monospace;
              background-color: #0a0b10;
            }
            .cyber-glow {
              box-shadow: 0 0 15px rgba(59, 130, 246, 0.2);
            }
            .cyber-glow-green {
              box-shadow: 0 0 15px rgba(16, 185, 129, 0.4);
            }
            .neon-border {
              border: 1px solid rgba(59, 130, 246, 0.3);
            }
            .neon-border:hover {
              border-color: rgba(59, 130, 246, 0.8);
            }
            /* Custom Scrollbar */
            ::-webkit-scrollbar { width: 6px; height: 6px; }
            ::-webkit-scrollbar-track { background: #0f111a; }
            ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 3px; }
            ::-webkit-scrollbar-thumb:hover { background: #3b82f6; }
          </style>
        </head>
        <body class="text-slate-300 min-h-screen flex flex-col justify-between selection:bg-blue-600 selection:text-white">

          <header class="border-b border-slate-900 bg-[#0d0e16]/80 backdrop-blur-md sticky top-0 z-50 px-6 py-4">
            <div class="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
              <div class="flex items-center gap-3">
                <div class="h-10 w-10 rounded-lg bg-blue-600/10 border border-blue-500/30 flex items-center justify-center text-blue-400 cyber-glow animate-pulse">
                  <i class="fa-solid fa-terminal text-lg"></i>
                </div>
                <div>
                  <h1 class="text-xl font-bold tracking-wider text-white">RAILWAY_GATEWAY<span class="text-blue-500">.sys</span></h1>
                  <p class="text-xs text-slate-500">CORE NODE ACTIVE & SECURED</p>
                </div>
              </div>
              <div class="flex items-center gap-4">
                <div class="flex items-center gap-2 bg-[#121420] neon-border px-4 py-2 rounded-lg">
                  <span class="h-2.5 w-2.5 rounded-full bg-emerald-500 cyber-glow-green animate-ping"></span>
                  <span class="text-xs font-semibold text-emerald-400 tracking-wider">SYSTEM ONLINE</span>
                </div>
              </div>
            </div>
          </header>

          <main class="max-w-7xl w-full mx-auto p-6 space-y-8 flex-grow">
            
            <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div class="bg-[#0d0e16] neon-border p-5 rounded-xl flex items-center justify-between">
                <div>
                  <p class="text-xs text-slate-500 font-medium mb-1">SYSTEM UPTIME</p>
                  <p id="uptime-val" class="text-lg font-bold text-white">${Math.floor(process.uptime())}s</p>
                </div>
                <i class="fa-solid fa-clock text-slate-700 text-2xl"></i>
              </div>
              <div class="bg-[#0d0e16] neon-border p-5 rounded-xl flex items-center justify-between">
                <div>
                  <p class="text-xs text-slate-500 font-medium mb-1">RAM ALLOCATION</p>
                  <p class="text-lg font-bold text-white">${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB</p>
                </div>
                <i class="fa-solid fa-microchip text-slate-700 text-2xl"></i>
              </div>
              <div class="bg-[#0d0e16] neon-border p-5 rounded-xl flex items-center justify-between">
                <div>
                  <p class="text-xs text-slate-500 font-medium mb-1">UDP TUNNELING</p>
                  <p class="text-lg font-bold text-emerald-400">ENABLED</p>
                </div>
                <i class="fa-solid fa-bolt text-emerald-900/50 text-2xl"></i>
              </div>
              <div class="bg-[#0d0e16] neon-border p-5 rounded-xl flex items-center justify-between">
                <div>
                  <p class="text-xs text-slate-500 font-medium mb-1">NODE VERSION</p>
                  <p class="text-lg font-bold text-blue-400">${process.version}</p>
                </div>
                <i class="fa-brands fa-node-js text-blue-900/50 text-2xl"></i>
              </div>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
              
              <div class="bg-[#0d0e16] border border-slate-900 rounded-xl p-6 space-y-4">
                <div class="flex items-center gap-2 border-b border-slate-900 pb-3">
                  <i class="fa-solid fa-network-wired text-blue-400"></i>
                  <h2 class="text-md font-bold tracking-wide text-white">WEBSOCKET ROUTING ENDPOINTS</h2>
                </div>
                <div class="space-y-3 max-h-[420px] overflow-y-auto pr-1">
                  
                  <div class="bg-[#10121d] border border-slate-900/60 p-4 rounded-lg flex flex-col md:flex-row justify-between items-start md:items-center gap-3 hover:bg-[#121524] transition">
                    <div>
                      <span class="text-xs bg-blue-500/10 text-blue-400 px-2 py-0.5 rounded font-bold border border-blue-500/20">TARGET COUNTRY</span>
                      <p class="text-sm font-semibold text-slate-200 mt-2">${protocolWs}://${currentHost}/ID</p>
                    </div>
                    <button onclick="copyText('${protocolWs}://${currentHost}/ID')" class="text-xs bg-[#171a29] border border-slate-800 text-slate-400 hover:text-white hover:border-blue-500 px-3 py-1.5 rounded transition flex items-center gap-1.5 active:scale-95">
                      <i class="fa-regular fa-copy"></i> COPY
                    </button>
                  </div>

                  <div class="bg-[#10121d] border border-slate-900/60 p-4 rounded-lg flex flex-col md:flex-row justify-between items-start md:items-center gap-3 hover:bg-[#121524] transition">
                    <div>
                      <span class="text-xs bg-purple-500/10 text-purple-400 px-2 py-0.5 rounded font-bold border border-purple-500/20">MULTI-COUNTRY (ROTATE)</span>
                      <p class="text-sm font-semibold text-slate-200 mt-2">${protocolWs}://${currentHost}/PROXYLIST/ID,SG,JP</p>
                    </div>
                    <button onclick="copyText('${protocolWs}://${currentHost}/PROXYLIST/ID,SG,JP')" class="text-xs bg-[#171a29] border border-slate-800 text-slate-400 hover:text-white hover:border-blue-500 px-3 py-1.5 rounded transition flex items-center gap-1.5 active:scale-95">
                      <i class="fa-regular fa-copy"></i> COPY
                    </button>
                  </div>

                  <div class="bg-[#10121d] border border-slate-900/60 p-4 rounded-lg flex flex-col md:flex-row justify-between items-start md:items-center gap-3 hover:bg-[#121524] transition">
                    <div>
                      <span class="text-xs bg-amber-500/10 text-amber-400 px-2 py-0.5 rounded font-bold border border-amber-500/20">REGION MATRICES</span>
                      <p class="text-sm font-semibold text-slate-200 mt-2">${protocolWs}://${currentHost}/ASIA</p>
                    </div>
                    <button onclick="copyText('${protocolWs}://${currentHost}/ASIA')" class="text-xs bg-[#171a29] border border-slate-800 text-slate-400 hover:text-white hover:border-blue-500 px-3 py-1.5 rounded transition flex items-center gap-1.5 active:scale-95">
                      <i class="fa-regular fa-copy"></i> COPY
                    </button>
                  </div>

                  <div class="bg-[#10121d] border border-slate-900/60 p-4 rounded-lg flex flex-col md:flex-row justify-between items-start md:items-center gap-3 hover:bg-[#121524] transition">
                    <div>
                      <span class="text-xs bg-pink-500/10 text-pink-400 px-2 py-0.5 rounded font-bold border border-pink-500/20">GLOBAL CLUSTER</span>
                      <p class="text-sm font-semibold text-slate-200 mt-2">${protocolWs}://${currentHost}/ALL</p>
                    </div>
                    <button onclick="copyText('${protocolWs}://${currentHost}/ALL')" class="text-xs bg-[#171a29] border border-slate-800 text-slate-400 hover:text-white hover:border-blue-500 px-3 py-1.5 rounded transition flex items-center gap-1.5 active:scale-95">
                      <i class="fa-regular fa-copy"></i> COPY
                    </button>
                  </div>

                </div>
              </div>

              <div class="bg-[#0d0e16] border border-slate-900 rounded-xl p-6 space-y-4">
                <div class="flex items-center gap-2 border-b border-slate-900 pb-3">
                  <i class="fa-solid fa-gears text-emerald-400"></i>
                  <h2 class="text-md font-bold tracking-wide text-white">REST INTEGRATION ENDPOINTS</h2>
                </div>
                <div class="space-y-3">
                  
                  <div class="bg-[#10121d] border border-slate-900/60 p-4 rounded-lg flex items-center justify-between hover:bg-[#121524] transition">
                    <div>
                      <span class="text-[10px] bg-emerald-500/10 text-emerald-400 px-2 py-0.5 rounded font-bold border border-emerald-500/20 mr-2">GET</span>
                      <span class="text-xs text-slate-500 font-medium">JSON LIST DIRECTORY</span>
                      <p class="text-sm font-semibold text-slate-200 mt-2">/api/proxies</p>
                    </div>
                    <a href="${protocolHttp}://${currentHost}/api/proxies" target="_blank" class="text-xs bg-blue-600/10 border border-blue-500/20 text-blue-400 hover:bg-blue-600 hover:text-white px-3 py-1.5 rounded transition">
                      <i class="fa-solid fa-arrow-up-right-from-square"></i> TEST
                    </a>
                  </div>

                  <div class="bg-[#10121d] border border-slate-900/60 p-4 rounded-lg flex items-center justify-between hover:bg-[#121524] transition">
                    <div>
                      <span class="text-[10px] bg-emerald-500/10 text-emerald-400 px-2 py-0.5 rounded font-bold border border-emerald-500/20 mr-2">GET</span>
                      <span class="text-xs text-slate-500 font-medium">PLAIN STRING PARSED</span>
                      <p class="text-sm font-semibold text-slate-200 mt-2">/api/proxies?format=text</p>
                    </div>
                    <a href="${protocolHttp}://${currentHost}/api/proxies?format=text" target="_blank" class="text-xs bg-blue-600/10 border border-blue-500/20 text-blue-400 hover:bg-blue-600 hover:text-white px-3 py-1.5 rounded transition">
                      <i class="fa-solid fa-arrow-up-right-from-square"></i> TEST
                    </a>
                  </div>

                  <div class="bg-[#10121d] border border-slate-900/60 p-4 rounded-lg flex items-center justify-between hover:bg-[#121524] transition">
                    <div>
                      <span class="text-[10px] bg-emerald-500/10 text-emerald-400 px-2 py-0.5 rounded font-bold border border-emerald-500/20 mr-2">GET</span>
                      <span class="text-xs text-slate-500 font-medium">MICRO-CORE HEALTH MONITOR</span>
                      <p class="text-sm font-semibold text-slate-200 mt-2">/health</p>
                    </div>
                    <a href="${protocolHttp}://${currentHost}/health" target="_blank" class="text-xs bg-blue-600/10 border border-blue-500/20 text-blue-400 hover:bg-blue-600 hover:text-white px-3 py-1.5 rounded transition">
                      <i class="fa-solid fa-arrow-up-right-from-square"></i> TEST
                    </a>
                  </div>

                </div>
              </div>

            </div>

            <div class="bg-[#0d0e16] border border-slate-900 rounded-xl p-6 space-y-4">
              <div class="flex items-center gap-2 border-b border-slate-900 pb-3">
                <i class="fa-solid fa-rectangle-list text-purple-400"></i>
                <h2 class="text-md font-bold tracking-wide text-white">INTEGRATION EXECUTION EXAMPLES</h2>
              </div>
              <div class="bg-[#07080e] rounded-lg p-5 border border-slate-950 font-mono text-xs sm:text-sm text-slate-400 space-y-4 overflow-x-auto">
                <div>
                  <p class="text-slate-600 mb-1">// Query cluster via terminal cli line</p>
                  <div class="flex items-center justify-between bg-[#0a0b12] p-3 rounded border border-slate-900">
                    <span class="text-blue-400">curl ${protocolHttp}://${currentHost}/api/proxies</span>
                    <button onclick="copyText('curl ${protocolHttp}://${currentHost}/api/proxies')" class="text-slate-600 hover:text-blue-400 transition"><i class="fa-regular fa-copy"></i></button>
                  </div>
                </div>
                <div>
                  <p class="text-slate-600 mb-1">// Direct tunneling streaming live mapping</p>
                  <div class="flex items-center justify-between bg-[#0a0b12] p-3 rounded border border-slate-900">
                    <span class="text-purple-400">wscat -c ${protocolWs}://${currentHost}/ID</span>
                    <button onclick="copyText('wscat -c ${protocolWs}://${currentHost}/ID')" class="text-slate-600 hover:text-purple-400 transition"><i class="fa-regular fa-copy"></i></button>
                  </div>
                </div>
              </div>
            </div>

          </main>

          <footer class="border-t border-slate-950 bg-[#07080d] px-6 py-4 text-center text-xs text-slate-600">
            <div class="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2">
              <p>&copy; ${new Date().getFullYear()} RAILWAY GATEWAY. ALL SYSTEM VECTORS OPERATIONAL.</p>
              <p class="flex items-center gap-1"><i class="fa-solid fa-shield text-blue-500/40"></i> SECURED BY END-TO-END KERNEL TUNNEL</p>
            </div>
          </footer>

          <div id="toast" class="fixed bottom-6 right-6 bg-blue-600 text-white font-semibold px-4 py-2.5 rounded-lg shadow-lg opacity-0 pointer-events-none transition-all duration-300 transform translate-y-2 text-xs z-50 flex items-center gap-2">
            <i class="fa-solid fa-circle-check"></i> ENDPOINT COPIED TO CLIPBOARD
          </div>

          <script>
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

            // Client runtime uptime updating
            let start = ${Math.floor(process.uptime())};
            setInterval(() => {
              start++;
              document.getElementById('uptime-val').innerText = start + 's';
            }, 1000);
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
