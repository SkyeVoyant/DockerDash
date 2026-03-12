const Docker = require('dockerode');
const fs = require('fs/promises');
const path = require('path');
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

function containersDir() {
  return process.env.DOCKERDASH_CONTAINERS_DIR || '/host_docker_containers';
}

function getListTimeoutMs() {
  const raw = process.env.DOCKER_LIST_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(String(raw), 10) : NaN;
  // Favor responsiveness: callers can fall back to cached/disk snapshots.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4000;
}

async function listContainersSafe(timeoutMs = getListTimeoutMs()) {
  try {
    const timeout = new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error('docker_list_timeout')), timeoutMs);
      if (t && typeof t.unref === 'function') t.unref();
    });
    const result = await Promise.race([docker.listContainers({ all: true }), timeout]);
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

function normalizeState(stateObj) {
  const st = stateObj || {};
  if (st.Running) return 'running';
  if (st.Paused) return 'paused';
  if (st.Restarting) return 'restarting';
  if (st.Dead) return 'dead';
  return 'exited';
}

function uniq(arr) {
  const out = [];
  for (const v of arr) {
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

async function listContainersFromDisk() {
  const root = containersDir();
  let ids;
  try {
    ids = await fs.readdir(root);
  } catch {
    return [];
  }

  const items = [];
  for (const id of ids) {
    if (!id || id.length < 12) continue;
    const configPath = path.join(root, id, 'config.v2.json');
    let data;
    try {
      data = JSON.parse(await fs.readFile(configPath, 'utf8'));
    } catch {
      continue;
    }

    const name = String(data.Name || '').replace(/^(\/)/, '') || id.substring(0, 12);
    const image = data?.Config?.Image || data?.Image || '';
    const state = normalizeState(data.State);
    const startedAt = data?.State?.StartedAt;
    const finishedAt = data?.State?.FinishedAt;

    const portsObj = data?.NetworkSettings?.Ports || {};
    const hostPorts = uniq(Object.values(portsObj)
      .flatMap((arr) => Array.isArray(arr) ? arr : [])
      .map((m) => String(m?.HostPort || ''))
      .filter(Boolean));

    let created = data.Created;
    try {
      const ms = Date.parse(String(created));
      if (!Number.isNaN(ms)) created = Math.floor(ms / 1000);
    } catch {
      // Keep as-is.
    }

    items.push({
      id: data.ID || id,
      name,
      image,
      state,
      status: state,
      created,
      startedAt,
      finishedAt,
      hostPorts
    });
  }

  return items;
}

async function getContainersSnapshot() {
  const containers = await listContainersSafe();
  if (containers.length === 0) {
    const diskItems = await listContainersFromDisk();
    if (diskItems.length > 0) {
      return { items: diskItems };
    }
  }

  // Do not `inspect()` every container here; it is expensive with many containers.
  // Uptime/ports can be enriched via cached inspect elsewhere if needed.
  const items = containers.map((c) => {
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
  // Do not sort here; frontend controls ordering
  return { items };
}

module.exports = { docker, listContainersSafe, listContainersFromDisk, getContainersSnapshot };
