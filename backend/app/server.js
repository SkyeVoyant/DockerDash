const express = require('express');
const http = require('http');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');

const { requireAuth, authenticateFromHeadersOrUrl, jwtSecret, passwordEnv } = require('./setup/auth');
const { router: containersRouter } = require('./routes/containers');
const { router: statsRouter } = require('./routes/stats');
const containersStore = require('./services/containersStore');
const statsStore = require('./services/statsStore');

const { WebSocketServer } = require('ws');
const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 8080;
const server = http.createServer(app);

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(morgan('dev'));
app.use(compression());

app.post('/api/login', (req, res) => {
  const { password } = req.body ?? {};
  if (!passwordEnv) return res.status(500).json({ error: 'PASSWORD not set on server' });
  if (password !== passwordEnv) return res.status(401).json({ error: 'Invalid password' });
  const token = jwt.sign({ role: 'admin' }, jwtSecret, { expiresIn: '30d' });
  const cookie = `auth=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60*60*24*30}`;
  res.setHeader('Set-Cookie', cookie);
  res.json({ token });
});

app.use('/api/containers', requireAuth, containersRouter);
app.use('/api/containers', requireAuth, statsRouter);

const publicDir = path.resolve(__dirname, 'public');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
app.use(express.static(publicDir));
app.get('*', (req, res, next) => { if (req.path.startsWith('/api')) return next(); res.sendFile(path.join(publicDir, 'index.html')); });

// Always-on stores: keep containers + stats warm so UI doesn't wait on-demand.
containersStore.start();
statsStore.start();

const containerStreamClients = new Set(); // ws
const allStatsClients = new Set(); // ws
const containerStatsClients = new Map(); // id -> Set(ws)
const statsStreamClients = new Set(); // ws (all containers stats stream)

function safeSend(ws, payload) {
  try {
    ws.send(payload);
    return true;
  } catch {
    try { ws.close(); } catch {}
    return false;
  }
}

function broadcast(set, data) {
  if (!set || set.size === 0) return;
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  for (const ws of Array.from(set)) {
    if (!safeSend(ws, payload)) {
      set.delete(ws);
    }
  }
}

containersStore.onUpdate((next) => {
  broadcast(containerStreamClients, next);
});

statsStore.onAggregate((agg) => {
  broadcast(allStatsClients, agg);
});

statsStore.onSample((id, sample) => {
  const payload = JSON.stringify(sample);
  const set = containerStatsClients.get(id);
  if (set && set.size) {
    for (const ws of Array.from(set)) {
      if (!safeSend(ws, payload)) set.delete(ws);
    }
    if (set.size === 0) containerStatsClients.delete(id);
  }

  // Fan-out to the single "all container stats" stream.
  if (statsStreamClients.size) {
    const msg = JSON.stringify({ type: 'stats', ...sample });
    for (const ws of Array.from(statsStreamClients)) {
      if (!safeSend(ws, msg)) statsStreamClients.delete(ws);
    }
  }
});

// WebSockets: stats per container, containers list stream
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url || '', 'http://localhost');
    const ok = authenticateFromHeadersOrUrl(req);
    if (!ok) { socket.destroy(); return; }

    // Containers stream
    if (url.pathname === '/ws/containers/stream') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        containerStreamClients.add(ws);
        safeSend(ws, JSON.stringify(containersStore.getSnapshot()));
        ws.on('close', () => { containerStreamClients.delete(ws); });
      });
      return;
    }

    // Aggregated stats for all containers
    if (url.pathname === '/ws/containers/all/stats') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        allStatsClients.add(ws);
        safeSend(ws, JSON.stringify(statsStore.getAggregate()));
        ws.on('close', () => { allStatsClients.delete(ws); });
      });
      return;
    }

    // Single stream with per-container stat updates (reduces 1-WS-per-container overhead).
    if (url.pathname === '/ws/containers/stats/stream') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        statsStreamClients.add(ws);
        safeSend(ws, JSON.stringify({ type: 'init', items: statsStore.getAllLatest() }));
        ws.on('close', () => { statsStreamClients.delete(ws); });
      });
      return;
    }

    // Stats per container (generic match)
    if (url.pathname.startsWith('/ws/containers/') && url.pathname.endsWith('/stats')) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const parts = url.pathname.split('/');
        const id = parts[3];
        if (!id) {
          try { ws.close(); } catch {}
          return;
        }

        let set = containerStatsClients.get(id);
        if (!set) {
          set = new Set();
          containerStatsClients.set(id, set);
        }
        set.add(ws);

        const last = statsStore.getLatest(id);
        if (last) safeSend(ws, JSON.stringify(last));

        ws.on('close', () => {
          const bucket = containerStatsClients.get(id);
          if (!bucket) return;
          bucket.delete(ws);
          if (bucket.size === 0) containerStatsClients.delete(id);
        });
      });
      return;
    }
    socket.destroy();
  } catch { socket.destroy(); }
});

server.listen(port, () => { console.log(`Server listening on http://localhost:${port}`); });
