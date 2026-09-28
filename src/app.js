const path = require('path');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const { getDb } = require('./db');
const { authenticate, notFoundHandler, errorHandler } = require('./middleware');

// Same-origin front-end: scripts/styles only from self; map tiles from OpenStreetMap.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(self)');
  next();
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);            // behind Render's proxy → correct client IP / https

  app.use(securityHeaders);
  if (config.CORS_ORIGIN) app.use(cors({ origin: config.CORS_ORIGIN.split(',').map((s) => s.trim()) }));
  app.use(express.json({ limit: '10mb' }));   // photos arrive as base64 data URLs

  app.use('/uploads', express.static(config.UPLOAD_DIR));

  // -------- API --------
  app.get('/api/health', (req, res) => {
    try {
      getDb().prepare('SELECT 1').get();
      res.json({ status: 'ok', db: 'ok', time: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'error', db: 'unavailable' });
    }
  });

  app.use('/api/auth',      require('./routes/auth'));
  app.use('/api/incidents', authenticate, require('./routes/incidents'));
  app.use('/api/users',     authenticate, require('./routes/users'));
  app.use('/api/alerts',    authenticate, require('./routes/alerts'));
  app.use('/api/reports',   authenticate, require('./routes/reports'));
  app.use('/api/audit',     authenticate, require('./routes/audit'));
  app.use('/api', notFoundHandler);

  // -------- Front-end --------
  app.use(express.static(config.PUBLIC_DIR));

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
