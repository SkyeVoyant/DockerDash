const EventEmitter = require('events');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { docker } = require('./docker');
const containersStore = require('./containersStore');

const emitter = new EventEmitter();

const latest = new Map(); // id -> payload

// Docker stats API mode (dockerode stats stream per container).
const streams = new Map(); // id -> stream
const prevDocker = new Map(); // id -> { read, write, rx, tx, ts }

// Host cgroup v2 mode (poll files per container). This is much faster and more reliable
// than Docker's stats API on some hosts (where `/containers/:id/stats` can hang).
const running = new Set(); // id
const cgroupPathById = new Map(); // id -> cgroup dir path
const memMaxById = new Map(); // id -> bytes (0 = unlimited/unknown)
const prevCgroup = new Map(); // id -> { cpuUsec, readBytes, writeBytes, ts }
let cgroupPollTimer = null;
let cgroupPollInFlight = false;

let engineVersion = '';
let started = false;

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const STATS_INTERVAL_MS = parsePositiveInt(process.env.DOCKERDASH_STATS_INTERVAL_MS, 1000);
const STATS_CONCURRENCY = parsePositiveInt(process.env.DOCKERDASH_STATS_CONCURRENCY, 64);
const CGROUP_ROOT = process.env.DOCKERDASH_CGROUP_ROOT || '/sys/fs/cgroup';
const CONFIG_MODE = String(process.env.DOCKERDASH_STATS_MODE || 'auto').toLowerCase(); // auto|docker|cgroup
let effectiveMode = null; // 'docker' | 'cgroup'

function readUptimeSec() {
  try {
    const txt = fs.readFileSync('/proc/uptime', 'utf8');
    const first = parseFloat(String(txt).split(' ')[0] || '0');
    return Number.isFinite(first) ? Math.floor(first) : 0;
  } catch {
    return 0;
  }
}

function extractIoBytes(statsObj) {
  try {
    let read = 0;
    let write = 0;
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

    if (read === 0 && write === 0 && statsObj && statsObj.storage_stats) {
      const ss = statsObj.storage_stats;
      const r = Number(ss.read_size_bytes ?? 0) || 0;
      const w = Number(ss.write_size_bytes ?? 0) || 0;
      if (r > 0 || w > 0) {
        read = r;
        write = w;
      }
    }

    return { read, write };
  } catch {
    return { read: 0, write: 0 };
  }
}

function computePayload(id, statsObj) {
  const s = statsObj || {};
  const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage || 0) - (s.precpu_stats?.cpu_usage?.total_usage || 0);
  const systemDelta = (s.cpu_stats?.system_cpu_usage || 0) - (s.precpu_stats?.system_cpu_usage || 0);
  const cpuPercent = systemDelta > 0
    ? (cpuDelta / systemDelta) * (s.cpu_stats?.online_cpus || 1) * 100
    : 0;

  const memUsage = s.memory_stats?.usage || 0;
  const memLimit = s.memory_stats?.limit || 0;
  const memPercent = memLimit > 0 ? (memUsage / memLimit) * 100 : 0;

  const net = s.networks || {};
  let rx = 0;
  let tx = 0;
  for (const k of Object.keys(net)) {
    rx += net[k].rx_bytes || 0;
    tx += net[k].tx_bytes || 0;
  }

  const io = extractIoBytes(s);
  const now = Date.now();
  let p = prevDocker.get(id);
  if (!p) {
    p = { read: io.read, write: io.write, rx, tx, ts: now, init: true };
    prevDocker.set(id, p);
  }

  const dt = Math.max(0.001, (now - (p.ts || now)) / 1000);
  let ioReadRate = (io.read - p.read) / dt;
  let ioWriteRate = (io.write - p.write) / dt;
  let rxRate = (rx - p.rx) / dt;
  let txRate = (tx - p.tx) / dt;
  if (ioReadRate < 0) ioReadRate = 0;
  if (ioWriteRate < 0) ioWriteRate = 0;
  if (rxRate < 0) rxRate = 0;
  if (txRate < 0) txRate = 0;

  prevDocker.set(id, { read: io.read, write: io.write, rx, tx, ts: now, init: true });

  return {
    id,
    cpuPercent,
    memUsage,
    memLimit,
    memPercent,
    rxRate,
    txRate,
    ioReadRate,
    ioWriteRate
  };
}

function hasHostCgroupFs() {
  try {
    return fs.existsSync(path.join(CGROUP_ROOT, 'system.slice'))
      || fs.existsSync(path.join(CGROUP_ROOT, 'docker'));
  } catch {
    return false;
  }
}

function cgroupCandidates(id) {
  const full = String(id || '').trim();
  if (!full) return [];
  const short = full.length >= 12 ? full.substring(0, 12) : full;
  return [
    // systemd driver (common on Linux)
    path.join(CGROUP_ROOT, 'system.slice', `docker-${full}.scope`),
    path.join(CGROUP_ROOT, 'system.slice', `docker-${short}.scope`),

    // cgroupfs driver fallback
    path.join(CGROUP_ROOT, 'docker', full),
    path.join(CGROUP_ROOT, 'docker', short),

    // last-resort (rare)
    path.join(CGROUP_ROOT, full),
    path.join(CGROUP_ROOT, short)
  ];
}

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveCgroupPath(id) {
  const key = String(id || '');
  if (!key) return null;
  const cached = cgroupPathById.get(key);
  if (cached) return cached;

  const candidates = cgroupCandidates(key);
  for (const p of candidates) {
    // Verify a core file exists so we don't cache wrong directories.
    if (await pathExists(path.join(p, 'cpu.stat'))) {
      cgroupPathById.set(key, p);
      return p;
    }
  }
  return null;
}

function parseCpuUsageUsec(txt) {
  if (!txt) return 0;
  const lines = String(txt).split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\s+/);
    if (parts[0] === 'usage_usec') {
      const v = Number.parseInt(parts[1] || '0', 10);
      return Number.isFinite(v) && v >= 0 ? v : 0;
    }
  }
  return 0;
}

function parseIoBytesFromCgroup(txt) {
  let read = 0;
  let write = 0;
  if (!txt) return { read, write };
  const lines = String(txt).split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\s+/);
    for (const part of parts) {
      if (part.startsWith('rbytes=')) {
        const v = Number.parseInt(part.slice('rbytes='.length) || '0', 10);
        if (Number.isFinite(v) && v > 0) read += v;
      } else if (part.startsWith('wbytes=')) {
        const v = Number.parseInt(part.slice('wbytes='.length) || '0', 10);
        if (Number.isFinite(v) && v > 0) write += v;
      }
    }
  }
  return { read, write };
}

function parseCgroupNumber(txt) {
  const s = String(txt || '').trim();
  if (!s) return 0;
  if (s === 'max') return 0;
  const v = Number.parseInt(s, 10);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

async function sampleCgroup(id) {
  const key = String(id || '');
  if (!key) return;

  const base = await resolveCgroupPath(key);
  if (!base) return;

  let memLimit = memMaxById.get(key);
  if (memLimit == null) memLimit = null;

  let cpuStat;
  let memCur;
  let memMax;
  let ioStat;
  try {
    const reads = [
      fsp.readFile(path.join(base, 'cpu.stat'), 'utf8'),
      fsp.readFile(path.join(base, 'memory.current'), 'utf8'),
      memLimit == null ? fsp.readFile(path.join(base, 'memory.max'), 'utf8') : Promise.resolve(null),
      fsp.readFile(path.join(base, 'io.stat'), 'utf8').catch(() => '')
    ];
    [cpuStat, memCur, memMax, ioStat] = await Promise.all(reads);
  } catch {
    // Container may have stopped, or permissions aren't sufficient.
    return;
  }

  const cpuUsec = parseCpuUsageUsec(cpuStat);
  const memUsage = parseCgroupNumber(memCur);

  if (memLimit == null) {
    const maxRaw = memMax == null ? '' : memMax;
    const parsed = parseCgroupNumber(maxRaw);
    memLimit = parsed > 0 ? parsed : 0;
    memMaxById.set(key, memLimit);
  }

  const io = parseIoBytesFromCgroup(ioStat);
  const readBytes = io.read;
  const writeBytes = io.write;

  const now = Date.now();
  const prev = prevCgroup.get(key);
  let cpuPercent = 0;
  let ioReadRate = 0;
  let ioWriteRate = 0;
  if (prev) {
    const dt = Math.max(0.001, (now - (prev.ts || now)) / 1000);
    cpuPercent = ((cpuUsec - (prev.cpuUsec || 0)) / 1e6) / dt * 100;
    ioReadRate = (readBytes - (prev.readBytes || 0)) / dt;
    ioWriteRate = (writeBytes - (prev.writeBytes || 0)) / dt;
    if (cpuPercent < 0) cpuPercent = 0;
    if (ioReadRate < 0) ioReadRate = 0;
    if (ioWriteRate < 0) ioWriteRate = 0;
  }

  prevCgroup.set(key, { cpuUsec, readBytes, writeBytes, ts: now });

  const memPercent = memLimit > 0 ? (memUsage / memLimit) * 100 : 0;
  const payload = {
    id: key,
    cpuPercent,
    memUsage,
    memLimit,
    memPercent,
    // Network rates require per-netns inspection; keep 0 in cgroup mode.
    rxRate: 0,
    txRate: 0,
    ioReadRate,
    ioWriteRate
  };
  latest.set(key, payload);
  emitter.emit('sample', key, payload);
}

async function pollCgroupOnce() {
  if (cgroupPollInFlight) return;
  cgroupPollInFlight = true;
  try {
    const ids = Array.from(running.values());
    if (ids.length === 0) return;

    for (let i = 0; i < ids.length; i += STATS_CONCURRENCY) {
      const slice = ids.slice(i, i + STATS_CONCURRENCY);
      await Promise.all(slice.map((id) => sampleCgroup(id)));
    }
  } finally {
    cgroupPollInFlight = false;
  }
}

async function attach(id) {
  if (!id || streams.has(id)) return;
  try {
    const stream = await docker.getContainer(id).stats({ stream: true });
    streams.set(id, stream);

    stream.on('data', (chunk) => {
      try {
        const parsed = JSON.parse(chunk.toString('utf8'));
        const payload = computePayload(id, parsed);
        latest.set(id, payload);
        emitter.emit('sample', id, payload);
      } catch {
        // Ignore parse errors.
      }
    });

    const cleanup = () => {
      try { stream.destroy?.(); } catch {}
      streams.delete(id);
      latest.delete(id);
      prevDocker.delete(id);
      prevCgroup.delete(id);
      cgroupPathById.delete(id);
      memMaxById.delete(id);
    };

    stream.on('end', cleanup);
    stream.on('error', cleanup);
  } catch {
    // Ignore attach errors; container may have stopped.
  }
}

function detach(id) {
  const stream = streams.get(id);
  if (stream) {
    try { stream.destroy?.(); } catch {}
  }
  streams.delete(id);
  latest.delete(id);
  prevDocker.delete(id);
  prevCgroup.delete(id);
  cgroupPathById.delete(id);
  memMaxById.delete(id);
}

async function refreshEngineVersion() {
  try {
    const v = await docker.version();
    engineVersion = (v && v.Version) || '';
  } catch {
    engineVersion = engineVersion || '';
  }
}

function syncRunningFromSnapshot(nextSnap) {
  const items = nextSnap && Array.isArray(nextSnap.items) ? nextSnap.items : [];
  const nextRunning = new Set(items.filter((c) => c && c.id && c.state === 'running').map((c) => c.id));

  // Remove stopped containers.
  for (const id of Array.from(running.values())) {
    if (nextRunning.has(id)) continue;
    running.delete(id);
    detach(id);
  }

  // Add newly running containers.
  for (const id of Array.from(nextRunning.values())) {
    if (running.has(id)) continue;
    running.add(id);
    if (effectiveMode === 'docker') void attach(id);
  }
}

function getLatest(id) {
  return latest.get(id) || null;
}

function getAllLatest() {
  return Array.from(latest.values());
}

function getAggregate() {
  let cpuPercent = 0;
  let memUsage = 0;
  let memLimit = 0;
  let rxRate = 0;
  let txRate = 0;
  let ioReadRate = 0;
  let ioWriteRate = 0;

  for (const s of latest.values()) {
    cpuPercent += s.cpuPercent || 0;
    memUsage += s.memUsage || 0;
    memLimit += s.memLimit || 0;
    rxRate += s.rxRate || 0;
    txRate += s.txRate || 0;
    ioReadRate += s.ioReadRate || 0;
    ioWriteRate += s.ioWriteRate || 0;
  }

  const memPercent = memLimit > 0 ? (memUsage / memLimit) * 100 : 0;
  return {
    engineVersion,
    uptimeSec: readUptimeSec(),
    cpuPercent,
    memUsage,
    memLimit,
    memPercent,
    rxRate,
    txRate,
    ioReadRate,
    ioWriteRate
  };
}

let aggregateTimer = null;
let engineTimer = null;
let unsubscribeContainers = null;

function start() {
  if (started) return;
  started = true;

  void refreshEngineVersion();

  // Track running containers based on the warmed container snapshot store.
  try {
    syncRunningFromSnapshot(containersStore.getSnapshot());
    unsubscribeContainers = containersStore.onUpdate((snap) => syncRunningFromSnapshot(snap));
  } catch {
    // Ignore.
  }

  // Choose the least-cost mode by default: cgroup polling if available, else Docker stats API.
  if (CONFIG_MODE === 'docker') effectiveMode = 'docker';
  else if (CONFIG_MODE === 'cgroup') effectiveMode = 'cgroup';
  else effectiveMode = hasHostCgroupFs() ? 'cgroup' : 'docker';

  if (effectiveMode === 'docker') {
    // Attach to current running containers.
    for (const id of Array.from(running.values())) void attach(id);
  } else {
    // Start polling immediately so the UI receives non-zero values quickly.
    void pollCgroupOnce();
    cgroupPollTimer = setInterval(() => { void pollCgroupOnce(); }, STATS_INTERVAL_MS);
    if (cgroupPollTimer && typeof cgroupPollTimer.unref === 'function') cgroupPollTimer.unref();
  }

  // Keep engine version reasonably fresh.
  engineTimer = setInterval(() => { void refreshEngineVersion(); }, 5 * 60 * 1000);
  if (engineTimer && typeof engineTimer.unref === 'function') engineTimer.unref();

  // Emit at a fixed cadence so charts have consistent spacing.
  aggregateTimer = setInterval(() => {
    try {
      emitter.emit('aggregate', getAggregate());
    } catch {
      // Ignore.
    }
  }, 1000);
  if (aggregateTimer && typeof aggregateTimer.unref === 'function') aggregateTimer.unref();

  // No Docker event stream: we rely on the containersStore refresh loop.
}

function stop() {
  try { unsubscribeContainers?.(); } catch {}
  unsubscribeContainers = null;
  if (aggregateTimer) clearInterval(aggregateTimer);
  if (engineTimer) clearInterval(engineTimer);
  if (cgroupPollTimer) clearInterval(cgroupPollTimer);
  aggregateTimer = null;
  engineTimer = null;
  cgroupPollTimer = null;
  streams.forEach((s) => { try { s.destroy?.(); } catch {} });
  streams.clear();
  latest.clear();
  prevDocker.clear();
  prevCgroup.clear();
  running.clear();
  cgroupPathById.clear();
  memMaxById.clear();
}

module.exports = {
  start,
  stop,
  getLatest,
  getAllLatest,
  getAggregate,
  onSample(fn) { emitter.on('sample', fn); return () => emitter.off('sample', fn); },
  onAggregate(fn) { emitter.on('aggregate', fn); return () => emitter.off('aggregate', fn); }
};
