const path = require('path');
const ROOT = path.join(__dirname, '..');

module.exports = {
  ROOT,
  PORT: process.env.PORT || 3000,
  DATA_DIR: process.env.DATA_DIR || path.join(ROOT, 'data'),
  UPLOAD_DIR: process.env.UPLOAD_DIR || path.join(ROOT, 'uploads'),
  PUBLIC_DIR: path.join(ROOT, 'public'),
  CORS_ORIGIN: process.env.CORS_ORIGIN || '',
  ALLOW_REGISTRATION: process.env.ALLOW_REGISTRATION === 'true',
};
