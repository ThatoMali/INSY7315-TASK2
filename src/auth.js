const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set when NODE_ENV=production');
}
const JWT_SECRET  = process.env.JWT_SECRET  || 'frims-dev-secret-change-me';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';

const hashPassword   = (plain) => bcrypt.hashSync(plain, 10);
const verifyPassword = (plain, hash) => bcrypt.compareSync(plain, hash);

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, username: user.username },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES, algorithm: 'HS256' }
  );
}

const verifyToken = (token) => jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });

module.exports = { hashPassword, verifyPassword, signToken, verifyToken };
