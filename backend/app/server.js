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

const { WebSocketServer } = require('ws');
const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 8080;
const server = http.createServer(app);
const serverStartMs = Date.now();

// Extract block I/O bytes (read/write) from various Docker stats shapes (cgroup v1/v2)
function extractIoBytes(statsObj) {
  try {
    let read = 0, write = 0;
    const blk = statsObj && statsObj.blkio_stats ? statsObj.blkio_stats : {};
    const arr = Array.isArray(blk.io_service_bytes_recursive) ? blk.io_service_bytes_recursive
      : Array.isArray(blk.io_service_bytes) ? blk.io_service_bytes
      : [];
    if (Array.isArray(arr) && arr.length > 0) {
      for (const entry of arr) {
        const op = String(entry.op || entry.Op || '').toLowerCase();
        const val = Number(entry.value ?? entry.Value ?? 0) || 0;
        if (op.includes('read')) read += val;
        if (op.includes('write')) write += val;
      }
    }
    // Fallbacks (some engines expose storage_stats)
    if (read === 0 && write === 0 && statsObj && statsObj.storage_stats) {
      const ss = statsObj.storage_stats;
      const r = Number(ss.read_size_bytes ?? 0) || 0;
      const w = Number(ss.write_size_bytes ?? 0) || 0;
      if (r > 0 || w > 0) { read = r; write = w; }
    }
    return { read, write };
  } catch { return { read: 0, write: 0 }; }
}

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
        const { getContainersSnapshot, docker } = require('./services/docker');
        let closed = false;
        const send = async () => { try { if (!closed) ws.send(JSON.stringify(await getContainersSnapshot())); } catch {} };
        const tick = setInterval(send, 2000);
        let events;
        (async () => { try { events = await docker.getEvents(); events.on('data', ()=> { void send(); }); } catch {} })();
        void send();
        ws.on('close', () => { closed = true; clearInterval(tick); try { events?.removeAllListeners?.(); } catch {} });
      });
      return;
    }
    // Aggregated stats for all containers
    if (url.pathname === '/ws/containers/all/stats') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        (async () => {
          const { docker, listContainersSafe } = require('./services/docker');
          let engineVersion = '';
          try { const v = await docker.version(); engineVersion = (v && v.Version) || ''; } catch {}
          const latest = new Map();
          const streams = new Map();
          let closed = false;

          const readUptimeSec = () => {
            try {
              const txt = fs.readFileSync('/proc/uptime', 'utf8');
              const first = parseFloat(String(txt).split(' ')[0] || '0');
              return Number.isFinite(first) ? Math.floor(first) : 0;
            } catch { return 0; }
          };

          // Send an immediate header snapshot so UI shows version/uptime instantly
          try {
            const header = {
              engineVersion,
              uptimeSec: readUptimeSec(),
              cpuPercent: 0, memUsage: 0, memLimit: 0, memPercent: 0,
              rxBytes: 0, txBytes: 0, ioRead: 0, ioWrite: 0
            };
            ws.send(JSON.stringify(header));
          } catch {}

          const computeAndSend = () => {
            if (closed) return;
            let cpuPercentTotal = 0, memUsageTotal = 0, memLimitTotal = 0, rxTotal = 0, txTotal = 0, readTotal = 0, writeTotal = 0;
            latest.forEach((s, id) => {
              if (!s) return;
              cpuPercentTotal += s.cpuPercent || 0;
              memUsageTotal += s.memUsage || 0;
              memLimitTotal += s.memLimit || 0;
              rxTotal += s.rxBytes || 0;
              txTotal += s.txBytes || 0;
              readTotal += s.ioRead || 0;
              writeTotal += s.ioWrite || 0;
            });
            const memPercentTotal = memLimitTotal > 0 ? (memUsageTotal / memLimitTotal) * 100 : 0;
            const payload = {
              engineVersion,
              uptimeSec: readUptimeSec(),
              cpuPercent: cpuPercentTotal,
              memUsage: memUsageTotal,
              memLimit: memLimitTotal,
              memPercent: memPercentTotal,
              rxBytes: rxTotal,
              txBytes: txTotal,
              ioRead: readTotal,
              ioWrite: writeTotal
            };
            try { ws.send(JSON.stringify(payload)); } catch {}
          };

          const attach = async (c) => {
            if (streams.has(c.Id)) return;
            try {
              const stream = await docker.getContainer(c.Id).stats({ stream: true });
              streams.set(c.Id, stream);
              stream.on('data', (chunk) => {
                try {
                  const s = JSON.parse(chunk.toString('utf8'));
                  const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage || 0) - (s.precpu_stats?.cpu_usage?.total_usage || 0);
                  const systemDelta = (s.cpu_stats?.system_cpu_usage || 0) - (s.precpu_stats?.system_cpu_usage || 0);
                  const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * (s.cpu_stats?.online_cpus || 1) * 100 : 0;
                  const memUsage = s.memory_stats?.usage || 0;
                  const memLimit = s.memory_stats?.limit || 0;
                  const net = s.networks || {};
                  let rx = 0, tx = 0;
                  for (const k of Object.keys(net)) { rx += net[k].rx_bytes || 0; tx += net[k].tx_bytes || 0; }
                  const io = extractIoBytes(s);
                  latest.set(c.Id, { cpuPercent, memUsage, memLimit, rxBytes: rx, txBytes: tx, ioRead: io.read, ioWrite: io.write });
                  computeAndSend();
                } catch {}
              });
              const cleanup = () => { try { stream.destroy?.() } catch {}; streams.delete(c.Id); latest.delete(c.Id); computeAndSend(); };
              stream.on('end', cleanup);
              stream.on('error', cleanup);
            } catch {}
          };

          const detach = (id) => {
            const stream = streams.get(id);
            if (stream) { try { stream.destroy?.() } catch {}; streams.delete(id); }
            latest.delete(id);
            computeAndSend();
          };

          // Prime latest with a one-time non-stream stats fetch, then attach live streams
          try {
            const list = await listContainersSafe(2000);
            await Promise.all(list.map(async (c) => {
              if (c.State !== 'running') return;
              try {
                const cont = docker.getContainer(c.Id);
                const raw = await cont.stats({ stream: false });
                const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
                const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage || 0) - (s.precpu_stats?.cpu_usage?.total_usage || 0);
                const systemDelta = (s.cpu_stats?.system_cpu_usage || 0) - (s.precpu_stats?.system_cpu_usage || 0);
                const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * (s.cpu_stats?.online_cpus || 1) * 100 : 0;
                const memUsage = s.memory_stats?.usage || 0;
                const memLimit = s.memory_stats?.limit || 0;
                const net = s.networks || {};
                let rx = 0, tx = 0;
                for (const k of Object.keys(net)) { rx += net[k].rx_bytes || 0; tx += net[k].tx_bytes || 0; }
                const io = extractIoBytes(s);
                latest.set(c.Id, { cpuPercent, memUsage, memLimit, rxBytes: rx, txBytes: tx, ioRead: io.read, ioWrite: io.write });
              } catch {}
            }));
            computeAndSend();
            // Now attach live streams
            await Promise.all(list.map(c => c.State === 'running' ? attach(c) : undefined));
          } catch {}

          // Listen to container lifecycle events to attach/detach dynamically
          let events;
          try {
            events = await docker.getEvents();
            events.on('data', (buf) => {
              try {
                const evt = JSON.parse(buf.toString('utf8'));
                const id = evt?.id || evt?.Actor?.ID;
                const status = evt?.status || '';
                if (!id) return;
                if (status === 'start') {
                  // Fetch container info to pass to attach
                  docker.getContainer(id).inspect((err, info) => {
                    if (err || !info) return;
                    const names = info.Name ? [info.Name] : [];
                    const image = info.Config?.Image || '';
                    attach({ Id: id, Names: names, Image: image, State: 'running' });
                  });
                } else if (status === 'die' || status === 'stop' || status === 'destroy') {
                  detach(id);
                }
              } catch {}
            });
          } catch {}

          const closeAll = () => {
            closed = true;
            streams.forEach((s) => { try { s.destroy?.() } catch {} });
            streams.clear(); latest.clear();
            try { events?.removeAllListeners?.(); } catch {}
          };
          ws.on('close', closeAll);
        })();
      });
      return;
    }
    // Stats per container (generic match)
    if (url.pathname.startsWith('/ws/containers/') && url.pathname.endsWith('/stats')) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        (async () => {
          try {
            const parts = url.pathname.split('/');
            const id = parts[3];
            const { docker } = require('./services/docker');
            const stream = await docker.getContainer(id).stats({ stream: true });
            stream.on('data', (chunk) => {
              try {
                const s = JSON.parse(chunk.toString('utf8'));
                const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage || 0) - (s.precpu_stats?.cpu_usage?.total_usage || 0);
                const systemDelta = (s.cpu_stats?.system_cpu_usage || 0) - (s.precpu_stats?.system_cpu_usage || 0);
                const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * (s.cpu_stats?.online_cpus || 1) * 100 : 0;
                const memUsage = s.memory_stats?.usage || 0;
                const memLimit = s.memory_stats?.limit || 0;
                const memPercent = memLimit > 0 ? (memUsage / memLimit) * 100 : 0;
                const net = s.networks || {};
                let rx = 0, tx = 0;
                for (const k of Object.keys(net)) { rx += net[k].rx_bytes || 0; tx += net[k].tx_bytes || 0; }
                const io = extractIoBytes(s);
                const payload = { cpuPercent, memUsage, memLimit, memPercent, rxBytes: rx, txBytes: tx, ioRead: io.read, ioWrite: io.write };
                ws.send(JSON.stringify(payload));
              } catch {}
            });
            const closeAll = () => { try { stream.destroy?.() } catch {}; try { ws.close(); } catch {} };
            stream.on('end', closeAll);
            stream.on('error', closeAll);
            ws.on('close', closeAll);
          } catch { try { ws.close(); } catch {} }
        })();
      });
      return;
    }
    socket.destroy();
  } catch { socket.destroy(); }
});

server.listen(port, () => { console.log(`Server listening on http://localhost:${port}`); });


