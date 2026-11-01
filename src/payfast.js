// PayFast (South Africa) hosted-checkout helpers: signing, ITN source check, server confirmation.
// Private values (merchant key, passphrase) are read from the environment at call time and never logged.
const crypto = require('crypto');
const dns = require('dns').promises;

const HOSTS = {
  live:    { process: 'https://www.payfast.co.za/eng/process',     validate: 'https://www.payfast.co.za/eng/query/validate' },
  sandbox: { process: 'https://sandbox.payfast.co.za/eng/process', validate: 'https://sandbox.payfast.co.za/eng/query/validate' },
};
const ITN_HOSTNAMES = ['www.payfast.co.za', 'sandbox.payfast.co.za', 'w1w.payfast.co.za', 'w2w.payfast.co.za'];

// Field order required by PayFast when signing a checkout request.
const CHECKOUT_ORDER = ['merchant_id', 'merchant_key', 'return_url', 'cancel_url', 'notify_url',
  'name_first', 'name_last', 'email_address', 'cell_number', 'm_payment_id', 'amount', 'item_name', 'item_description'];

// Overridable in tests so no real network/DNS is needed.
const deps = {
  fetch: (...a) => fetch(...a),
  lookupHosts: async () => {
    const ips = new Set();
    await Promise.all(ITN_HOSTNAMES.map(async (h) => {
      try { (await dns.lookup(h, { all: true })).forEach((r) => ips.add(r.address)); } catch { /* host unresolved */ }
    }));
    return ips;
  },
};

function cfg() {
  const e = process.env;
  const sandbox = e.PAYFAST_SANDBOX !== 'false';           // sandbox unless explicitly disabled
  return {
    merchantId: e.PAYFAST_MERCHANT_ID || '',
    merchantKey: e.PAYFAST_MERCHANT_KEY || '',
    passphrase: e.PAYFAST_PASSPHRASE || '',
    baseUrl: (e.APP_BASE_URL || '').replace(/\/+$/, ''),
    sandbox,
    urls: sandbox ? HOSTS.sandbox : HOSTS.live,
  };
}
const isConfigured = () => { const c = cfg(); return !!(c.merchantId && c.merchantKey && c.baseUrl); };

// PHP-urlencode compatible (PayFast signs values encoded this way).
const enc = (v) => encodeURIComponent(String(v).trim())
  .replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  .replace(/%20/g, '+');

function paramString(pairs, { includeEmpty = false } = {}) {
  return pairs
    .filter(([k, v]) => k !== 'signature' && v !== undefined && v !== null && (includeEmpty || String(v) !== ''))
    .map(([k, v]) => `${k}=${enc(v)}`).join('&');
}
function sign(pairs, passphrase, opts) {
  let s = paramString(pairs, opts);
  if (passphrase) s += `&passphrase=${enc(passphrase)}`;
  return crypto.createHash('md5').update(s).digest('hex');
}

function buildCheckoutUrl(fields) {
  const c = cfg();
  const pairs = CHECKOUT_ORDER.filter((k) => fields[k] !== undefined && String(fields[k]) !== '').map((k) => [k, fields[k]]);
  const signature = sign(pairs, c.passphrase);
  return `${c.urls.process}?${paramString(pairs)}&signature=${signature}`;
}

function signatureValid(body) {
  const given = String(body.signature || '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(given)) return false;
  const expected = sign(Object.entries(body), cfg().passphrase, { includeEmpty: true });
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

const normIp = (ip) => String(ip || '').replace(/^::ffff:/, '');
async function sourceValid(ip) { return (await deps.lookupHosts()).has(normIp(ip)); }

// Server-to-server confirmation. Throws on network failure (caller should let PayFast retry).
async function serverConfirms(body) {
  const res = await deps.fetch(cfg().urls.validate, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: paramString(Object.entries(body), { includeEmpty: true }),
    signal: AbortSignal.timeout(10000),
  });
  return (await res.text()).trim() === 'VALID';
}

module.exports = { cfg, isConfigured, buildCheckoutUrl, signatureValid, sourceValid, serverConfirms, sign, deps };
