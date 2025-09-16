const express = require('express');
const router = express.Router();
router.use((_req, res) => res.status(410).json({ error: 'Logs API removed' }));
module.exports = { router };


