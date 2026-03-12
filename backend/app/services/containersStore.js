const EventEmitter = require('events');
const { docker, listContainersSafe, listContainersFromDisk } = require('./docker');

// Keep a continuously refreshed snapshot so the API/UI isn't blocked on Docker calls.
const emitter = new EventEmitter();

let snapshot = {
  items: [],
  source: 'init',
  updatedAt: null,
  updatedAtMs: 0
};

let refreshPromise = null;

// Best-effort enrichment: cache inspect timestamps so the UI can show "up/down" without
// paying the inspect cost on every `/api/containers` and stream update.
const inspectCache = new Map(); // id -> { startedAt, finishedAt, fetchedAtMs }
const inspectQueue = [];
let inspectActive = 0;

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const INSPECT_TTL_MS = parsePositiveInt(process.env.DOCKERDASH_INSPECT_TTL_MS, 5 * 60 * 1000);
const INSPECT_CONCURRENCY = parsePositiveInt(process.env.DOCKERDASH_INSPECT_CONCURRENCY, 4);
const REFRESH_INTERVAL_MS = parsePositiveInt(process.env.DOCKERDASH_CONTAINERS_REFRESH_MS, 2000);
const MAX_INSPECT_QUEUE = parsePositiveInt(process.env.DOCKERDASH_INSPECT_QUEUE_LIMIT, 5000);

function getSnapshot() {
  return snapshot;
}

function onUpdate(fn) {
  emitter.on('update', fn);
  return () => emitter.off('update', fn);
}

function enqueueInspect(id) {
  if (!id) return;
  if (inspectCache.has(id)) return;
  if (inspectQueue.includes(id)) return;
  if (inspectQueue.length >= MAX_INSPECT_QUEUE) return;
  inspectQueue.push(id);
  void pumpInspectQueue();
}

async function inspectContainer(id) {
  try {
    const inspect = await docker.getContainer(id).inspect();
    const startedAt = inspect?.State?.StartedAt;
    const finishedAt = inspect?.State?.FinishedAt;
    inspectCache.set(id, {
      startedAt: startedAt || undefined,
      finishedAt: finishedAt || undefined,
      fetchedAtMs: Date.now()
    });
  } catch {
    // Ignore inspect failures; container may have disappeared.
  }
}

async function pumpInspectQueue() {
  while (inspectActive < INSPECT_CONCURRENCY && inspectQueue.length > 0) {
    const id = inspectQueue.shift();
    if (!id) continue;
    inspectActive += 1;
    void inspectContainer(id).finally(() => {
      inspectActive -= 1;
      // Keep draining.
      void pumpInspectQueue();
    });
  }
}

function applyInspectCache(items) {
  const now = Date.now();
  return items.map((item) => {
    const cached = inspectCache.get(item.id);
    if (!cached) return item;
    if (now - (cached.fetchedAtMs || 0) > INSPECT_TTL_MS) {
      // Stale: keep whatever we have, but enqueue a refresh.
      inspectCache.delete(item.id);
      if (item.state === 'running' && !item.startedAt && !item.finishedAt) enqueueInspect(item.id);
      return item;
    }
    return {
      ...item,
      startedAt: cached.startedAt,
      finishedAt: cached.finishedAt
    };
  });
}

function pruneInspectState(items) {
  const now = Date.now();
  const activeIds = new Set((items || []).map((item) => item.id).filter(Boolean));

  for (const [id, cached] of inspectCache.entries()) {
    const age = now - (cached?.fetchedAtMs || 0);
    if (!activeIds.has(id) || age > (INSPECT_TTL_MS * 2)) {
      inspectCache.delete(id);
    }
  }

  if (inspectQueue.length > 0) {
    const kept = inspectQueue.filter((id) => activeIds.has(id));
    inspectQueue.length = 0;
    inspectQueue.push(...kept);
  }
}

async function refreshContainersSnapshot({ reason = 'interval' } = {}) {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const hadSnapshot = Array.isArray(snapshot.items) && snapshot.items.length > 0;
    let diskPublished = false;

    // Fast path on cold start: publish a disk-backed snapshot immediately so the UI isn't blank
    // while Docker's list API is still warming up / slow with many containers.
    if (!hadSnapshot) {
      try {
        const diskItems = await listContainersFromDisk();
        if (Array.isArray(diskItems) && diskItems.length > 0) {
          snapshot = {
            items: applyInspectCache(diskItems),
            source: 'disk',
            reason: 'disk-early',
            updatedAt: new Date().toISOString(),
            updatedAtMs: Date.now()
          };
          diskPublished = true;
          emitter.emit('update', snapshot);
        }
      } catch {
        // Ignore.
      }
    }

    const containers = await listContainersSafe();
    let items;
    let source;

    if (containers.length === 0) {
      // If Docker is slow/unavailable, keep the last known snapshot so the UI stays responsive.
      if (Array.isArray(snapshot.items) && snapshot.items.length > 0) {
        return snapshot;
      }

      // Only hit the disk when we have no cached view yet.
      items = await listContainersFromDisk();
      source = items.length > 0 ? 'disk' : 'empty';
    } else {
      items = containers.map((c) => {
        const rawName = (c.Names && c.Names[0]) ? c.Names[0].replace(/^(\/)/, '') : c.Id.substring(0, 12);
        const hostPorts = Array.isArray(c.Ports)
          ? Array.from(new Set(c.Ports.map((p) => String(p.PublicPort || '')).filter(Boolean)))
          : [];
        return {
          id: c.Id,
          name: rawName,
          image: c.Image,
          state: c.State,
          status: c.Status,
          created: c.Created,
          startedAt: undefined,
          finishedAt: undefined,
          hostPorts
        };
      });
      source = 'docker';
    }

    // Enqueue inspect only for items missing cache; do not block snapshot creation.
    for (const item of items) {
      if (item.state !== 'running') continue;
      // Disk snapshots already include started/finished timestamps; avoid expensive inspect fan-out.
      if (item.startedAt || item.finishedAt) continue;
      const cached = inspectCache.get(item.id);
      const isFresh = cached && (Date.now() - (cached.fetchedAtMs || 0) <= INSPECT_TTL_MS);
      if (!isFresh) enqueueInspect(item.id);
    }

    pruneInspectState(items);
    items = applyInspectCache(items);

    snapshot = {
      items,
      source,
      reason: diskPublished && source === 'docker' && reason === 'startup' ? 'startup+disk' : reason,
      updatedAt: new Date().toISOString(),
      updatedAtMs: Date.now()
    };

    emitter.emit('update', snapshot);
    return snapshot;
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

let started = false;
function start() {
  if (started) return;
  started = true;

  void refreshContainersSnapshot({ reason: 'startup' });
  setInterval(() => {
    void refreshContainersSnapshot({ reason: 'interval' });
  }, REFRESH_INTERVAL_MS);
}

module.exports = {
  start,
  getSnapshot,
  onUpdate,
  refreshContainersSnapshot
};
