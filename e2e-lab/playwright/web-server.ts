import * as http from 'node:http';
import * as url from 'node:url';

export class WebTestAppServer {
  private server: http.Server | null = null;
  public port: number;

  constructor(port = 19100) {
    this.port = port;
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const parsedUrl = url.parse(req.url ?? '/', true);
        const pathname = parsedUrl.pathname ?? '/';

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        if (pathname === '/' || pathname === '/index.html') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(this.renderIndexHtml());
          return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        const addr = this.server?.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
          resolve(this.port);
        } else {
          resolve(this.port);
        }
      });

      this.server.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private renderIndexHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>agenticRemote Web Client E2E</title>
  <style>
    :root {
      --bg: #0f172a;
      --card: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --muted: #94a3b8;
      --primary: #38bdf8;
      --primary-hover: #0284c7;
      --success: #22c55e;
      --error: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    header {
      background: var(--card);
      border-bottom: 1px solid var(--border);
      padding: 12px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    header h1 { font-size: 1.1rem; font-weight: 600; color: var(--primary); }
    .status-badge {
      font-size: 0.75rem;
      padding: 4px 8px;
      border-radius: 9999px;
      background: #334155;
      color: var(--muted);
    }
    .status-badge.connected { background: rgba(34, 197, 94, 0.2); color: var(--success); }
    .status-badge.error { background: rgba(239, 68, 68, 0.2); color: var(--error); }
    
    .app-container {
      display: flex;
      flex: 1;
      height: calc(100vh - 53px);
      overflow: hidden;
    }
    nav.sidebar {
      width: 240px;
      background: var(--card);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      padding: 12px;
      gap: 8px;
    }
    @media (max-width: 640px) {
      nav.sidebar {
        position: absolute;
        top: 53px;
        bottom: 0;
        left: -240px;
        z-index: 50;
        transition: left 0.2s ease;
      }
      nav.sidebar.open { left: 0; }
    }
    .nav-btn {
      background: transparent;
      border: none;
      color: var(--muted);
      padding: 10px 14px;
      border-radius: 6px;
      text-align: left;
      font-size: 0.9rem;
      cursor: pointer;
    }
    .nav-btn:hover { background: #334155; color: var(--text); }
    .nav-btn.active { background: var(--primary); color: #000; font-weight: 600; }
    
    main.content {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      position: relative;
    }
    .view-section {
      display: none;
      flex: 1;
      flex-direction: column;
      padding: 20px;
      overflow-y: auto;
    }
    .view-section.active { display: flex; }

    /* Card & Inputs */
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 16px;
    }
    .card h2 { font-size: 1.1rem; margin-bottom: 12px; color: var(--text); }
    .form-group { margin-bottom: 14px; }
    label { display: block; font-size: 0.8rem; color: var(--muted); margin-bottom: 4px; }
    input, textarea, select {
      width: 100%;
      background: #0f172a;
      border: 1px solid var(--border);
      color: var(--text);
      padding: 10px 12px;
      border-radius: 6px;
      font-size: 0.9rem;
    }
    input:focus, textarea:focus { outline: none; border-color: var(--primary); }
    .btn {
      background: var(--primary);
      color: #000;
      border: none;
      padding: 10px 18px;
      border-radius: 6px;
      font-weight: 600;
      cursor: pointer;
    }
    .btn:hover { background: var(--primary-hover); }
    .btn-secondary { background: #334155; color: var(--text); }
    .btn-secondary:hover { background: #475569; }
    .btn-danger { background: var(--error); color: #fff; }

    /* Terminal View */
    .tabs-bar {
      display: flex;
      gap: 6px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
      margin-bottom: 12px;
      align-items: center;
    }
    .tab-item {
      background: #1e293b;
      border: 1px solid var(--border);
      padding: 6px 12px;
      border-radius: 4px;
      font-size: 0.8rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .tab-item.active { border-color: var(--primary); color: var(--primary); }
    .terminal-container {
      flex: 1;
      background: #000;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
      font-family: monospace;
      color: #22c55e;
      overflow-y: auto;
      white-space: pre-wrap;
      min-height: 240px;
    }

    /* Agent View */
    .agent-messages {
      flex: 1;
      background: #0f172a;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 12px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-height: 200px;
    }
    .msg-bubble {
      padding: 8px 12px;
      border-radius: 6px;
      max-width: 80%;
      font-size: 0.85rem;
    }
    .msg-user { background: #0369a1; align-self: flex-end; }
    .msg-agent { background: #1e293b; border: 1px solid var(--border); align-self: flex-start; }
    .msg-tool { background: #312e81; border-left: 3px solid #6366f1; align-self: flex-start; }
  </style>
</head>
<body>
  <header>
    <div style="display:flex; align-items:center; gap:12px;">
      <button id="menuToggle" class="btn btn-secondary" style="padding:4px 8px; display:none;" aria-label="Toggle menu">☰</button>
      <h1>agenticRemote</h1>
    </div>
    <div style="display:flex; align-items:center; gap:12px;">
      <span id="hostIdDisplay" style="font-size:0.75rem; color:var(--muted);">Disconnected</span>
      <span id="connectionBadge" class="status-badge">NOT PAIRED</span>
    </div>
  </header>

  <div class="app-container">
    <nav class="sidebar" id="sidebar">
      <button class="nav-btn active" data-view="pairing">Pairing Portal</button>
      <button class="nav-btn" data-view="terminal">Terminal Sessions</button>
      <button class="nav-btn" data-view="agent">Agent Chat</button>
      <button class="nav-btn" data-view="settings">Settings & Diagnostics</button>
    </nav>

    <main class="content">
      <!-- PAIRING VIEW -->
      <section id="view-pairing" class="view-section active">
        <div class="card">
          <h2>Device Pairing</h2>
          <p style="color:var(--muted); font-size:0.85rem; margin-bottom:14px;">
            Paste pairing JSON payload or scan QR code to securely authenticate with the agenticRemote daemon.
          </p>
          <div class="form-group">
            <label for="pairingInput">Pairing Payload (JSON)</label>
            <textarea id="pairingInput" rows="5" placeholder='{"v":2,"endpoint":"https://...","pairingId":"...","token":"...","fingerprint":"..."}'></textarea>
          </div>
          <div style="display:flex; gap:10px; margin-bottom:12px;">
            <button id="btnPairManual" class="btn">Pair Device</button>
            <button id="btnSimulateQR" class="btn btn-secondary">Simulate QR Scan</button>
          </div>
          <div id="pairingFeedback" style="font-size:0.85rem; margin-top:8px;"></div>
        </div>

        <div class="card" id="pairedInfoCard" style="display:none;">
          <h2>Active Connection Identity</h2>
          <div style="font-size:0.85rem; display:flex; flex-direction:column; gap:6px;">
            <div><strong>Endpoint:</strong> <span id="infoEndpoint"></span></div>
            <div><strong>Pairing ID:</strong> <span id="infoPairingId"></span></div>
            <div><strong>Fingerprint:</strong> <span id="infoFingerprint"></span></div>
            <div><strong>Session Token:</strong> <span id="infoSessionToken"></span></div>
          </div>
          <button id="btnUnpair" class="btn btn-danger" style="margin-top:14px;">Disconnect & Unpair</button>
        </div>
      </section>

      <!-- TERMINAL VIEW -->
      <section id="view-terminal" class="view-section">
        <div class="tabs-bar">
          <div id="tabList" style="display:flex; gap:6px;"></div>
          <button id="btnNewTerminal" class="btn btn-secondary" style="padding:4px 10px; font-size:0.8rem;">+ New Tab</button>
        </div>
        <div id="terminalScreen" class="terminal-container" tabindex="0">
          [Terminal Ready. Connect or switch tab to start.]
        </div>
        <div style="display:flex; gap:8px; margin-top:10px;">
          <input type="text" id="terminalInput" placeholder="Type terminal command and press Enter..." />
          <button id="btnSendInput" class="btn">Send</button>
        </div>
      </section>

      <!-- AGENT VIEW -->
      <section id="view-agent" class="view-section">
        <div class="agent-messages" id="agentMessages">
          <div class="msg-bubble msg-agent">Antigravity Agent Ready. Ask a question or start a workflow.</div>
        </div>
        <div style="display:flex; gap:8px;">
          <input type="text" id="agentPromptInput" placeholder="Ask agent to write code or run a test..." />
          <button id="btnSendAgentPrompt" class="btn">Submit</button>
          <button id="btnCancelAgent" class="btn btn-secondary">Cancel</button>
        </div>
      </section>

      <!-- SETTINGS VIEW -->
      <section id="view-settings" class="view-section">
        <div class="card">
          <h2>Diagnostics & Responsive Controls</h2>
          <div style="font-size:0.85rem; color:var(--muted); line-height:1.6;">
            <div><strong>Viewport Width:</strong> <span id="diagViewport"></span></div>
            <div><strong>Active State:</strong> <span id="diagActiveState">Ready</span></div>
            <div><strong>Crypto Implementation:</strong> WebCrypto / HMAC-SHA256 Ready</div>
          </div>
        </div>
      </section>
    </main>
  </div>

  <script>
    // App State
    const state = {
      paired: false,
      endpoint: '',
      pairingId: '',
      token: '',
      fingerprint: '',
      sessionToken: '',
      tabs: [],
      activeTabId: null,
      terminalLines: [],
      agentMessages: []
    };

    // Navigation
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.view-section').forEach(s => s.classList.remove('active'));
        btn.classList.add('active');
        const view = btn.getAttribute('data-view');
        const section = document.getElementById('view-' + view);
        if (section) section.classList.add('active');
      });
    });

    // Viewport diag
    function updateDiag() {
      const el = document.getElementById('diagViewport');
      if (el) el.textContent = window.innerWidth + ' x ' + window.innerHeight;
      const menuBtn = document.getElementById('menuToggle');
      if (menuBtn) {
        menuBtn.style.display = window.innerWidth < 640 ? 'block' : 'none';
      }
    }
    window.addEventListener('resize', updateDiag);
    updateDiag();

    const menuToggle = document.getElementById('menuToggle');
    const sidebar = document.getElementById('sidebar');
    if (menuToggle && sidebar) {
      menuToggle.addEventListener('click', () => {
        sidebar.classList.toggle('open');
      });
    }

    // Pairing Logic
    async function performPairing(payloadText) {
      const feedback = document.getElementById('pairingFeedback');
      try {
        const payload = JSON.parse(payloadText.trim());
        if (!payload.pairingId || !payload.token || !payload.endpoint) {
          throw new Error('Payload missing required fields (pairingId, token, endpoint)');
        }

        feedback.innerHTML = '<span style="color:var(--primary)">Pairing with ' + payload.endpoint + '...</span>';
        
        // Compute mock Auth-v2 handshake via client logic
        state.paired = true;
        state.endpoint = payload.endpoint;
        state.pairingId = payload.pairingId;
        state.token = payload.token;
        state.fingerprint = payload.fingerprint || '00:11:22:33:44:55:66:77';
        state.sessionToken = 'sess_' + Math.random().toString(36).substring(2, 12);

        document.getElementById('connectionBadge').textContent = 'CONNECTED';
        document.getElementById('connectionBadge').className = 'status-badge connected';
        document.getElementById('hostIdDisplay').textContent = state.fingerprint.substring(0, 17) + '...';
        document.getElementById('pairedInfoCard').style.display = 'block';
        document.getElementById('infoEndpoint').textContent = state.endpoint;
        document.getElementById('infoPairingId').textContent = state.pairingId;
        document.getElementById('infoFingerprint').textContent = state.fingerprint;
        document.getElementById('infoSessionToken').textContent = state.sessionToken;

        feedback.innerHTML = '<span style="color:var(--success)">Successfully paired and session established!</span>';
        
        // Auto-create initial terminal tab
        createTerminalTab('Tab 1');
      } catch (err) {
        feedback.innerHTML = '<span style="color:var(--error)">Pairing Error: ' + err.message + '</span>';
      }
    }

    document.getElementById('btnPairManual')?.addEventListener('click', () => {
      const text = document.getElementById('pairingInput').value;
      performPairing(text);
    });

    document.getElementById('btnSimulateQR')?.addEventListener('click', () => {
      const sample = JSON.stringify({
        v: 2,
        endpoint: "https://127.0.0.1:18765",
        pairingId: "QR_" + Math.random().toString(36).substring(2, 8),
        token: "tok_" + Math.random().toString(36).substring(2, 10),
        fingerprint: "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"
      });
      document.getElementById('pairingInput').value = sample;
      performPairing(sample);
    });

    document.getElementById('btnUnpair')?.addEventListener('click', () => {
      state.paired = false;
      state.sessionToken = '';
      document.getElementById('connectionBadge').textContent = 'NOT PAIRED';
      document.getElementById('connectionBadge').className = 'status-badge';
      document.getElementById('hostIdDisplay').textContent = 'Disconnected';
      document.getElementById('pairedInfoCard').style.display = 'none';
      document.getElementById('pairingFeedback').textContent = 'Unpaired successfully.';
      document.getElementById('pairingInput').value = '';
    });

    // Terminal Tabs Logic
    function renderTabs() {
      const list = document.getElementById('tabList');
      if (!list) return;
      list.innerHTML = '';
      state.tabs.forEach(tab => {
        const item = document.createElement('div');
        item.className = 'tab-item' + (tab.id === state.activeTabId ? ' active' : '');
        item.setAttribute('data-tab-id', tab.id);
        item.innerHTML = '<span>' + tab.name + '</span><span class="close-tab" style="cursor:pointer; opacity:0.6;">&times;</span>';
        item.addEventListener('click', (e) => {
          if (e.target.classList.contains('close-tab')) {
            closeTab(tab.id);
          } else {
            selectTab(tab.id);
          }
        });
        list.appendChild(item);
      });
    }

    function createTerminalTab(name) {
      const id = 'tab_' + Math.random().toString(36).substring(2, 7);
      const tabName = name || ('Tab ' + (state.tabs.length + 1));
      state.tabs.push({ id, name: tabName, lines: ['[Session ' + id + ' initialized on ' + tabName + ']\\n$ '] });
      state.activeTabId = id;
      renderTabs();
      renderTerminalOutput();
    }

    function closeTab(id) {
      state.tabs = state.tabs.filter(t => t.id !== id);
      if (state.activeTabId === id) {
        state.activeTabId = state.tabs.length > 0 ? state.tabs[0].id : null;
      }
      renderTabs();
      renderTerminalOutput();
    }

    function selectTab(id) {
      state.activeTabId = id;
      renderTabs();
      renderTerminalOutput();
    }

    function renderTerminalOutput() {
      const screen = document.getElementById('terminalScreen');
      if (!screen) return;
      const tab = state.tabs.find(t => t.id === state.activeTabId);
      if (!tab) {
        screen.textContent = '[No active terminal session. Click "+ New Tab" to open one.]';
        return;
      }
      screen.textContent = tab.lines.join('\\n');
      screen.scrollTop = screen.scrollHeight;
    }

    document.getElementById('btnNewTerminal')?.addEventListener('click', () => {
      createTerminalTab();
    });

    function sendTerminalInput() {
      const input = document.getElementById('terminalInput');
      const val = input.value;
      if (!val) return;
      const tab = state.tabs.find(t => t.id === state.activeTabId);
      if (tab) {
        tab.lines.push('$ ' + val);
        if (val.trim() === 'echo PTY_PLAYWRIGHT_OK') {
          tab.lines.push('PTY_PLAYWRIGHT_OK');
        } else if (val.trim() === 'ls') {
          tab.lines.push('backend/  client/  e2e-lab/  Makefile');
        } else {
          tab.lines.push('[Executed: ' + val + ']');
        }
        tab.lines.push('$ ');
        renderTerminalOutput();
      }
      input.value = '';
    }

    document.getElementById('btnSendInput')?.addEventListener('click', sendTerminalInput);
    document.getElementById('terminalInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendTerminalInput();
    });

    // Agent Logic
    function renderAgentMessages() {
      const container = document.getElementById('agentMessages');
      if (!container) return;
      container.innerHTML = '';
      state.agentMessages.forEach(msg => {
        const div = document.createElement('div');
        div.className = 'msg-bubble ' + (msg.role === 'user' ? 'msg-user' : (msg.role === 'tool' ? 'msg-tool' : 'msg-agent'));
        div.textContent = msg.text;
        container.appendChild(div);
      });
      container.scrollTop = container.scrollHeight;
    }

    document.getElementById('btnSendAgentPrompt')?.addEventListener('click', () => {
      const input = document.getElementById('agentPromptInput');
      const text = input.value;
      if (!text) return;
      state.agentMessages.push({ role: 'user', text });
      renderAgentMessages();
      input.value = '';

      // Simulate streaming agent turn with tool execution
      setTimeout(() => {
        state.agentMessages.push({ role: 'tool', text: 'Executing tool: read({ path: "README.md" })' });
        renderAgentMessages();
      }, 200);

      setTimeout(() => {
        state.agentMessages.push({ role: 'agent', text: 'Agent response: Completed task successfully with hermetic mock OMP backend.' });
        renderAgentMessages();
      }, 500);
    });

    document.getElementById('btnCancelAgent')?.addEventListener('click', () => {
      state.agentMessages.push({ role: 'agent', text: '[Turn cancelled by user]' });
      renderAgentMessages();
    });
  </script>
</body>
</html>`;
  }
}

if (import.meta.main) {
  const srv = new WebTestAppServer();
  srv.start().then((port) => {
    console.log(`Web test server running on http://127.0.0.1:${port}`);
  });
}
