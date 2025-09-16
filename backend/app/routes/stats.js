const express = require('express');
const router = express.Router();

// No SSE; stats stream handled via WebSocket in server.js
router.get('/:id/stats/recent', async (_req, res) => {
  res.json({ items: [] });
});

module.exports = { router };


