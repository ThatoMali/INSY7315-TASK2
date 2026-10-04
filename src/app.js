// src/app.js
const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');

const { notFoundHandler, errorHandler } = require('./middleware');
const { authenticate } = require('./middleware');

const authRoutes      = require('./routes/auth');
const incidentsRoutes = require('./routes/incidents');
const usersRoutes     = require('./routes/users');
const alertsRoutes    = require('./routes/alerts');
const reportsRoutes   = require('./routes/reports');
const auditRoutes     = require('./routes/audit');
const chatRoutes      = require('./routes/chat');   // ← chatbot

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // ---- security headers (includes CSP that allows the chat UI) ----
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(self)');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "img-src 'self' data: https://*.tile.openstreetmap.org",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
      "font-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '));
    next();
  });

  // ---- CORS (only needed if front-end is on a different origin) ----
  if (config.CORS_ORIGIN) {
    app.use(cors({ origin: config.CORS_ORIGIN, credentials: false }));
  }

  app.use(express.json({ limit: '8mb' })); // 8 MB so photo data-URLs fit

  // ---- public ----
  app.get('/api/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

  // ---- auth ----
  app.use('/api/auth', authRoutes);

  // ---- everything below requires a valid JWT ----
  app.use('/api/incidents', authenticate, incidentsRoutes);
  app.use('/api/users',     authenticate, usersRoutes);
  app.use('/api/alerts',    authenticate, alertsRoutes);
  app.use('/api/reports',   authenticate, reportsRoutes);
  app.use('/api/audit',     authenticate, auditRoutes);
  app.use('/api/chat',      authenticate, chatRoutes);   // ← chatbot

  // ---- static front-end ----
  app.use('/uploads', express.static(config.UPLOAD_DIR, { maxAge: '7d', index: false }));
  app.use(express.static(config.PUBLIC_DIR, { index: 'index.html' }));

  app.use('/api', notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };