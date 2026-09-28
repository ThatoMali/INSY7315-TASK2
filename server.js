require('dotenv').config();
const config = require('./src/config');
const { initDb, closeDb } = require('./src/db');
const { createApp } = require('./src/app');

try {
  initDb();
  const server = createApp().listen(config.PORT, () =>
    console.log(`FRIMS running on http://localhost:${config.PORT}`)
  );

  const shutdown = () => { server.close(() => { closeDb(); process.exit(0); }); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch (err) {
  console.error('Failed to start FRIMS:', err);
  process.exit(1);
}
