const express = require('express');
const { docker, getContainersSnapshot } = require('../services/docker');

const router = express.Router();

router.get('/', async (_req, res) => {
  try { res.json(await getContainersSnapshot()); }
  catch { res.status(500).json({ error: 'Failed to list containers' }); }
});

// SSE stream removed in favor of WebSocket at /ws/containers/stream

router.post('/:id/start', async (req, res) => { const id = req.params.id; try { await docker.getContainer(id).start(); res.json({ ok: true }); } catch { res.status(500).json({ error: 'Failed to start' }); } });
router.post('/:id/stop', async (req, res) => { const id = req.params.id; try { await docker.getContainer(id).stop({ t: 10 }); res.json({ ok: true }); } catch { res.status(500).json({ error: 'Failed to stop' }); } });
router.post('/:id/restart', async (req, res) => { const id = req.params.id; try { await docker.getContainer(id).restart({ t: 5 }); res.json({ ok: true }); } catch { res.status(500).json({ error: 'Failed to restart' }); } });
router.post('/:id/kill', async (req, res) => { const id = req.params.id; try { await docker.getContainer(id).kill({ signal: 'KILL' }); res.json({ ok: true }); } catch { res.status(500).json({ error: 'Failed to kill' }); } });
router.post('/:id/pull', async (req, res) => {
  const id = req.params.id;
  try {
    const inspect = await docker.getContainer(id).inspect();
    const image = inspect.Config?.Image;
    if (!image) return res.status(400).json({ error: 'No image' });
    docker.pull(image, (err, stream) => {
      if (err || !stream) return res.status(500).json({ error: 'Pull failed' });
      docker.modem.followProgress(stream, () => void 0);
      res.json({ ok: true });
    });
  } catch { res.status(500).json({ error: 'Failed to pull image' }); }
});

router.get('/:id/inspect', async (req, res) => {
  try {
    const id = req.params.id;
    const inspect = await docker.getContainer(id).inspect();
    const minimal = { id: inspect.Id, name: (inspect.Name || '').replace(/^(\/)/, ''), image: inspect.Config?.Image, created: inspect.Created, state: inspect.State, NetworkSettings: inspect.NetworkSettings, Config: { Env: inspect.Config?.Env, Labels: inspect.Config?.Labels } };
    res.set('Cache-Control', 'no-store');
    res.json(minimal);
  } catch { res.status(404).json({ error: 'Container not found' }); }
});

function reqOnClose(res, cb) { const req = res.req; const onClose = () => { try { cb(); } catch {} }; req.on('close', onClose); }

module.exports = { router };


