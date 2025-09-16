const jwt = require('jsonwebtoken');

const jwtSecret = process.env.JWT_SECRET || 'dev-secret-change';
const passwordEnv = process.env.PASSWORD || '';

function requireAuth(req, res, next) {
  if (!passwordEnv) return res.status(500).json({ error: 'PASSWORD not set on server' });
  const auth = req.headers.authorization || '';
  const headerToken = auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
  const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
  const token = headerToken || queryToken;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    jwt.verify(token, jwtSecret);
    return next();
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

function authenticateFromHeadersOrUrl(req) {
  const auth = req.headers['authorization'];
  if (auth && typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    try { jwt.verify(token, jwtSecret); return token; } catch { return null; }
  }
  try {
    const urlObj = new URL(req.url || '', 'http://localhost');
    const token = urlObj.searchParams.get('token');
    if (token) { jwt.verify(token, jwtSecret); return token; }
  } catch {}
  const cookieHeader = req.headers['cookie'];
  if (cookieHeader && typeof cookieHeader === 'string') {
    const parts = cookieHeader.split(';').map(s => s.trim());
    for (const p of parts) {
      if (p.startsWith('auth=')) {
        const token = p.slice(5);
        try { jwt.verify(token, jwtSecret); return token; } catch { return null; }
      }
    }
  }
  return null;
}

module.exports = { jwtSecret, passwordEnv, requireAuth, authenticateFromHeadersOrUrl };


