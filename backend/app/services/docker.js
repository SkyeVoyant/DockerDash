const Docker = require('dockerode');
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

async function listContainersSafe(timeoutMs) {
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

async function getContainersSnapshot() {
  const containers = await listContainersSafe(2000);
  const items = await Promise.all(containers.map(async (c) => {
    const container = docker.getContainer(c.Id);
    let startedAt, finishedAt;
    try {
      const inspect = await container.inspect();
      startedAt = inspect?.State?.StartedAt;
      finishedAt = inspect?.State?.FinishedAt;
      const containerName = (inspect?.Name || '').replace(/^(\/)/, '');
      const rawName = (c.Names && c.Names[0]) ? c.Names[0].replace(/^(\/)/, '') : c.Id.substring(0, 12);
      const displayName = containerName || rawName;
      // Derive unique host ports from listContainers data if present
      const hostPorts = Array.isArray(c.Ports) ? Array.from(new Set(c.Ports.map(p => String(p.PublicPort || '')).filter(Boolean))) : [];
      return { id: c.Id, name: displayName, image: c.Image, state: c.State, status: c.Status, created: c.Created, startedAt, finishedAt, hostPorts };
    } catch { startedAt = undefined; finishedAt = undefined; }
    const rawFallback = (c.Names && c.Names[0]) ? c.Names[0].replace(/^(\/)/, '') : c.Id.substring(0, 12);
    const hostPorts = Array.isArray(c.Ports) ? Array.from(new Set(c.Ports.map(p => String(p.PublicPort || '')).filter(Boolean))) : [];
    return { id: c.Id, name: rawFallback, image: c.Image, state: c.State, status: c.Status, created: c.Created, startedAt, finishedAt, hostPorts };
  }));
  // Do not sort here; frontend controls ordering
  return { items };
}

module.exports = { docker, listContainersSafe, getContainersSnapshot };


