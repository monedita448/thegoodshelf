// The Good Shelf — Colombia store template backend
// Storefront checkout via Wompi (PSE / Nequi / Card), order + shipping
// tracking, and a session-authenticated admin panel for managing both
// products and orders.
//
// Run locally:  npm install && npm start
// Requires a .env file — see .env.example

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const nodemailer = require('nodemailer');

const app = express();
const ROOT = __dirname;
const PRODUCTS_PATH = path.join(ROOT, 'products.json');
const ORDERS_PATH = path.join(ROOT, 'orders.json');
const AUDIT_PATH = path.join(ROOT, 'admin_audit.json');
const IMAGES_DIR = path.join(ROOT, 'images');
const TRASH_PATH = path.join(ROOT, 'trash.json');
const TRASH_IMAGES_DIR = path.join(ROOT, 'trash', 'images');
fs.mkdirSync(TRASH_IMAGES_DIR, { recursive: true });

// Deleted products/photos are held here — recoverable — until the daily
// trash clear. "Local time" for a store means the timezone it operates in;
// set STORE_TIMEZONE in .env (defaults to Colombia) so the 11:59pm clear
// lines up with the timezone the store owner actually works in.
const STORE_TIMEZONE = process.env.STORE_TIMEZONE || 'America/Bogota';

const APP_ENV = process.env.APP_ENV === 'production' ? 'production' : 'sandbox';
const IS_PROD = APP_ENV === 'production';
const WOMPI_API_BASE = APP_ENV === 'production'
  ? 'https://production.wompi.co/v1'
  : 'https://sandbox.wompi.co/v1';

const REQUIRED_ENV = ['WOMPI_PUBLIC_KEY', 'WOMPI_INTEGRITY_SECRET', 'WOMPI_EVENTS_SECRET', 'SITE_URL', 'ADMIN_TOKEN'];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length) {
  console.warn(
    `[warn] Missing env vars: ${missingEnv.join(', ')}. ` +
    `Checkout and/or the admin panel will not work until these are set — see .env.example.`
  );
}

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn(
    '[warn] SESSION_SECRET not set — using a random one-time secret. ' +
    'Admin logins will be invalidated every time the server restarts. Set SESSION_SECRET in .env.'
  );
}

// Emailing receipts is optional — the rest of the store works fine without
// it. Without these set, "Email receipt" in /admin just returns a clear
// error instead of failing silently.
const SMTP_CONFIGURED = Boolean(process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER && process.env.SMTP_PASS);
if (!SMTP_CONFIGURED) {
  console.warn(
    '[warn] SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS not set — "Email receipt" in /admin will show an error ' +
    'until these are set. See .env.example. Viewing/printing a receipt works either way.'
  );
}
function getMailTransport() {
  if (!SMTP_CONFIGURED) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

const SHIPPING_STATUSES = ['NOT_SHIPPED', 'PROCESSING', 'SHIPPED', 'DELIVERED'];
const LOW_STOCK_THRESHOLD = 3;
const FAILED_PAYMENT_STATUSES = ['DECLINED', 'VOIDED', 'ERROR'];
const SESSION_COOKIE = 'tgs_admin_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const AJAX_HEADER = 'x-requested-with';
const AJAX_HEADER_VALUE = 'tgs-admin';

// ---------- security middleware ----------

app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      // Product photos can be pasted in from any external source, so images
      // are allowed to load from anywhere (http or https), plus data: URIs.
      imgSrc: ["'self'", 'https:', 'http:', 'data:'],
      connectSrc: ["'self'"],
      formAction: ["'self'", 'https://checkout.wompi.co'],
      frameAncestors: ["'none'"],
    },
  },
}));

app.use(express.json({ limit: '200kb' }));
app.use(cookieParser(SESSION_SECRET));

// Light global limiter on the API surface, defense-in-depth against abuse.
app.use('/api', rateLimit({ windowMs: 5 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

// ---------- static, explicit routes only (nothing sensitive is ever statically served) ----------

app.use('/images', express.static(IMAGES_DIR, { maxAge: '1d' }));
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(ROOT, 'admin.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(ROOT, 'admin.html')));
app.get('/products.json', (req, res) => res.json(loadProducts()));

// ---------- helpers ----------

function loadProducts() {
  return JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf8'));
}

let productsWriteQueue = Promise.resolve();
function saveProducts(products) {
  productsWriteQueue = productsWriteQueue.then(() =>
    fsp.writeFile(PRODUCTS_PATH, JSON.stringify(products, null, 2))
  );
  return productsWriteQueue;
}

function loadOrders() {
  try {
    return JSON.parse(fs.readFileSync(ORDERS_PATH, 'utf8'));
  } catch (e) {
    return [];
  }
}

let ordersWriteQueue = Promise.resolve();
function saveOrders(orders) {
  ordersWriteQueue = ordersWriteQueue.then(() =>
    fsp.writeFile(ORDERS_PATH, JSON.stringify(orders, null, 2))
  );
  return ordersWriteQueue;
}

// ---------- trash (recoverable delete for products + photos) ----------

function loadTrash() {
  try {
    return JSON.parse(fs.readFileSync(TRASH_PATH, 'utf8'));
  } catch (e) {
    return [];
  }
}

let trashWriteQueue = Promise.resolve();
function saveTrash(trash) {
  trashWriteQueue = trashWriteQueue.then(() =>
    fsp.writeFile(TRASH_PATH, JSON.stringify(trash, null, 2))
  );
  return trashWriteQueue;
}

function genTrashId() {
  return crypto.randomBytes(10).toString('hex');
}

// Moves an uploaded photo out of the public /images folder and into the
// private trash folder, so it's no longer reachable by URL but can still be
// restored. External image URLs (not one of our own uploads) have nothing to
// move — they're just remembered as a URL so the removal can still be undone.
async function trashImageFile(url) {
  const match = typeof url === 'string' && url.match(/^\/images\/([a-zA-Z0-9._-]+)$/);
  if (!match) return { url, filename: null, trashed: false };
  const filename = match[1];
  try {
    await fsp.rename(path.join(IMAGES_DIR, filename), path.join(TRASH_IMAGES_DIR, filename));
    return { url, filename, trashed: true };
  } catch (e) {
    return { url, filename: null, trashed: false };
  }
}

async function restoreImageFile(file) {
  if (!file.trashed || !file.filename) return;
  try {
    await fsp.rename(path.join(TRASH_IMAGES_DIR, file.filename), path.join(IMAGES_DIR, file.filename));
  } catch (e) {
    console.error('Could not restore trashed file', file.filename, e);
  }
}

async function purgeTrashFiles(entry) {
  for (const file of entry.files || []) {
    if (file.trashed && file.filename) {
      try { await fsp.unlink(path.join(TRASH_IMAGES_DIR, file.filename)); } catch (e) { /* already gone */ }
    }
  }
}

async function purgeAllTrash() {
  const trash = loadTrash();
  for (const entry of trash) await purgeTrashFiles(entry);
  await saveTrash([]);
  if (trash.length) await auditLog({ action: 'trash_purged', count: trash.length });
  return trash.length;
}

// Trash clears automatically once a day at 11:59pm in the store's own
// timezone (STORE_TIMEZONE) — not the server's timezone, which may be
// hosted anywhere.
let lastAutoPurgedOn = null;
setInterval(() => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: STORE_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const todayStr = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  if (hour === 23 && minute === 59 && lastAutoPurgedOn !== todayStr) {
    lastAutoPurgedOn = todayStr;
    purgeAllTrash().catch((err) => console.error('Daily trash purge failed:', err));
  }
}, 60 * 1000).unref();

function genReference() {
  return 'TGS-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
}

function signIntegrity(reference, amountInCents, currency) {
  const payload = `${reference}${amountInCents}${currency}${process.env.WOMPI_INTEGRITY_SECRET}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function getAtPath(obj, dotPath) {
  return dotPath.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const receiptMoneyFmt = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
function moneyCOP(cents) {
  return receiptMoneyFmt.format(cents / 100);
}

const RECEIPT_STATUS_LABELS = { PENDING: 'Pendiente', APPROVED: 'Pagado', DECLINED: 'Rechazado', VOIDED: 'Anulado', ERROR: 'Error' };

// Self-contained HTML receipt — viewable/printable in a new tab, and reused
// as the body of the "email receipt" send. Inline styles only, no external
// assets, so it renders identically in a browser tab and an email client.
function renderReceiptHTML(order) {
  const itemsRows = (order.items || []).map((it) => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #e7e0d5">${escapeHtml(it.name)}</td>
      <td style="padding:10px 0;border-bottom:1px solid #e7e0d5;text-align:center">${it.qty}</td>
      <td style="padding:10px 0;border-bottom:1px solid #e7e0d5;text-align:right">${moneyCOP(it.price * 100)}</td>
      <td style="padding:10px 0;border-bottom:1px solid #e7e0d5;text-align:right">${moneyCOP(it.price * it.qty * 100)}</td>
    </tr>`).join('');

  const addr = order.shippingAddress || {};
  const statusLabel = RECEIPT_STATUS_LABELS[order.status] || order.status;
  const createdAt = order.createdAt ? new Date(order.createdAt).toLocaleString('es-CO') : '';

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Recibo ${escapeHtml(order.reference)}</title>
</head>
<body style="font-family:Arial,Helvetica,sans-serif;color:#171717;background:#f7f3ec;margin:0;padding:32px">
<div style="max-width:640px;margin:0 auto;background:#fffdf8;border:1px solid #e7e0d5;border-radius:14px;padding:32px">
  <h1 style="font-size:22px;margin:0 0 4px">The Good Shelf</h1>
  <p style="color:#66625a;font-size:13px;margin:0 0 4px">Recibo del pedido ${escapeHtml(order.reference)}</p>
  <p style="color:#66625a;font-size:13px;margin:0 0 20px">
    ${escapeHtml(createdAt)} &middot;
    <span style="display:inline-block;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:bold;background:#e1efe4;color:#3f7a52">${escapeHtml(statusLabel)}</span>
  </p>

  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <tr>
      <td style="vertical-align:top;width:50%;padding-bottom:20px">
        <div style="color:#66625a;text-transform:uppercase;font-size:11px;letter-spacing:.04em;margin-bottom:4px">Facturar a</div>
        ${escapeHtml(order.customer.fullName)}<br>
        ${escapeHtml(order.customer.email)}<br>
        ${order.customer.phone ? escapeHtml(order.customer.phone) + '<br>' : ''}
      </td>
      <td style="vertical-align:top;width:50%;padding-bottom:20px">
        <div style="color:#66625a;text-transform:uppercase;font-size:11px;letter-spacing:.04em;margin-bottom:4px">Enviar a</div>
        ${escapeHtml(addr.addressLine || '')}<br>
        ${escapeHtml(addr.city || '')}${addr.region ? ', ' + escapeHtml(addr.region) : ''}
      </td>
    </tr>
  </table>

  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <thead>
      <tr>
        <th style="text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#66625a;padding-bottom:8px;border-bottom:2px solid #171717">Artículo</th>
        <th style="text-align:center;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#66625a;padding-bottom:8px;border-bottom:2px solid #171717">Cant.</th>
        <th style="text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#66625a;padding-bottom:8px;border-bottom:2px solid #171717">Precio</th>
        <th style="text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#66625a;padding-bottom:8px;border-bottom:2px solid #171717">Subtotal</th>
      </tr>
    </thead>
    <tbody>
      ${itemsRows}
      <tr><td colspan="3" style="text-align:right;padding-top:14px;font-weight:bold;font-size:16px">Total</td><td style="text-align:right;padding-top:14px;font-weight:bold;font-size:16px">${moneyCOP(order.amountInCents)}</td></tr>
    </tbody>
  </table>

  <p style="color:#66625a;font-size:13px;margin-top:28px">Gracias por comprar en The Good Shelf.</p>
</div>
</body>
</html>`;
}

// Prices customers pay always come from this — never from the client.
// Also enforces stock availability so orders can never oversell.
function priceCart(items) {
  if (!Array.isArray(items) || items.length === 0) return { error: 'Cart is empty.' };
  const products = loadProducts();
  let amountCOP = 0;
  const orderItems = [];
  for (const raw of items) {
    const product = products.find((p) => p.id === raw.id);
    const qty = Number(raw.qty);
    if (!product || !Number.isInteger(qty) || qty < 1 || qty > 50) return { error: 'Invalid item in cart.' };
    const stock = Number.isInteger(product.stock) ? product.stock : 0;
    if (qty > stock) return { error: `Only ${stock} left of "${product.name}".` };
    amountCOP += product.price * qty;
    orderItems.push({ id: product.id, name: product.name, price: product.price, qty });
  }
  return { orderItems, amountCOP };
}

// Restores stock for an order's items once, when a payment ultimately fails
// (declined/voided/errored) after stock was already reserved at checkout.
async function restockIfNeeded(order) {
  if (order.stockRestored) return;
  const products = loadProducts();
  let changed = false;
  for (const item of order.items || []) {
    const p = products.find((x) => x.id === item.id);
    if (p) {
      p.stock = (Number.isInteger(p.stock) ? p.stock : 0) + item.qty;
      changed = true;
    }
  }
  if (changed) await saveProducts(products);
  order.stockRestored = true;
}

let auditWriteQueue = Promise.resolve();
function auditLog(entry) {
  auditWriteQueue = auditWriteQueue.then(async () => {
    let log = [];
    try {
      log = JSON.parse(await fsp.readFile(AUDIT_PATH, 'utf8'));
    } catch (e) { /* file may not exist yet */ }
    log.push(Object.assign({ at: new Date().toISOString() }, entry));
    if (log.length > 2000) log = log.slice(-2000); // cap growth
    await fsp.writeFile(AUDIT_PATH, JSON.stringify(log, null, 2));
  }).catch((err) => console.error('audit log write failed:', err));
  return auditWriteQueue;
}

// ---------- admin session store (in-memory; fine for a single small store) ----------

const sessions = new Map(); // sessionId -> { createdAt, expiresAt, ip }

function createSession(ip) {
  const id = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(id, { createdAt: now, expiresAt: now + SESSION_TTL_MS, ip });
  return id;
}
function getSession(id) {
  if (!id) return null;
  const s = sessions.get(id);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    sessions.delete(id);
    return null;
  }
  return s;
}
function destroySession(id) {
  sessions.delete(id);
}
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now > s.expiresAt) sessions.delete(id);
  }
}, 15 * 60 * 1000).unref();

function passwordMatches(input) {
  const expected = process.env.ADMIN_TOKEN || '';
  if (!expected || typeof input !== 'string') return false;
  const a = crypto.createHash('sha256').update(input).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// CSRF mitigation: browsers only attach custom headers to same-origin
// fetch/XHR requests, so a cross-site form/img/script tag can't trigger
// state-changing admin requests even though the session cookie is present.
// Combined with SameSite=Strict on the cookie itself.
function requireAjaxHeader(req, res, next) {
  if (req.method !== 'GET' && req.headers[AJAX_HEADER] !== AJAX_HEADER_VALUE) {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  next();
}
app.use('/api/admin', requireAjaxHeader);

function requireAdmin(req, res, next) {
  const sessionId = req.signedCookies[SESSION_COOKIE];
  const session = getSession(sessionId);
  if (!session) return res.status(401).json({ error: 'Not logged in.' });
  req.adminSession = session;
  next();
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait and try again.' },
});

// ---------- admin auth routes ----------

app.post('/api/admin/login', loginLimiter, async (req, res) => {
  const { password } = req.body || {};
  const ip = req.ip;
  if (!passwordMatches(password)) {
    await auditLog({ action: 'login_failed', ip });
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  const sessionId = createSession(ip);
  res.cookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    signed: true,
    sameSite: 'strict',
    secure: IS_PROD,
    maxAge: SESSION_TTL_MS,
  });
  await auditLog({ action: 'login_success', ip });
  res.json({ ok: true });
});

app.post('/api/admin/logout', requireAdmin, async (req, res) => {
  destroySession(req.signedCookies[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE);
  await auditLog({ action: 'logout', ip: req.ip });
  res.json({ ok: true });
});

app.get('/api/admin/session', (req, res) => {
  const session = getSession(req.signedCookies[SESSION_COOKIE]);
  res.json({ loggedIn: Boolean(session) });
});

// ---------- storefront routes ----------

// Create a pending order and return signed Wompi Web Checkout params.
app.post('/api/checkout', async (req, res) => {
  try {
    const { items, customer, shippingAddress } = req.body || {};
    if (!customer || !customer.email || !customer.fullName) {
      return res.status(400).json({ error: 'Full name and email are required.' });
    }
    if (!shippingAddress || !shippingAddress.addressLine || !shippingAddress.city) {
      return res.status(400).json({ error: 'Shipping address and city are required.' });
    }

    const priced = priceCart(items);
    if (priced.error) return res.status(400).json({ error: priced.error });
    const amountInCents = priced.amountCOP * 100;

    if (amountInCents < 150000) {
      return res.status(400).json({ error: 'Order total is too low to process.' });
    }

    const reference = genReference();
    const currency = 'COP';
    const signature = signIntegrity(reference, amountInCents, currency);

    const order = {
      reference,
      items: priced.orderItems,
      amountInCents,
      currency,
      status: 'PENDING',
      customer: {
        fullName: String(customer.fullName).slice(0, 120),
        email: String(customer.email).slice(0, 160),
        phone: customer.phone ? String(customer.phone).slice(0, 30) : null,
      },
      shippingAddress: {
        addressLine: String(shippingAddress.addressLine).slice(0, 200),
        city: String(shippingAddress.city).slice(0, 100),
        region: shippingAddress.region ? String(shippingAddress.region).slice(0, 100) : null,
      },
      shippingStatus: 'NOT_SHIPPED',
      trackingNumber: null,
      carrier: null,
      wompiTransactionId: null,
      stockRestored: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const orders = loadOrders();
    orders.push(order);
    await saveOrders(orders);

    // Reserve stock immediately so two customers can't buy the last unit.
    // If the payment ultimately fails, restockIfNeeded() puts it back.
    const products = loadProducts();
    for (const item of priced.orderItems) {
      const p = products.find((x) => x.id === item.id);
      if (p) p.stock = Math.max(0, (Number.isInteger(p.stock) ? p.stock : 0) - item.qty);
    }
    await saveProducts(products);

    res.json({
      reference,
      amountInCents,
      currency,
      publicKey: process.env.WOMPI_PUBLIC_KEY,
      signature,
      redirectUrl: `${process.env.SITE_URL}/?ref=${reference}`,
      checkoutAction: 'https://checkout.wompi.co/p/',
    });
  } catch (err) {
    console.error('POST /api/checkout failed:', err);
    res.status(500).json({ error: 'Could not create order.' });
  }
});

app.get('/api/checkout/status', async (req, res) => {
  try {
    const { ref, id } = req.query;
    if (!ref) return res.status(400).json({ error: 'Missing reference.' });

    const orders = loadOrders();
    const order = orders.find((o) => o.reference === ref);
    if (!order) return res.status(404).json({ error: 'Order not found.' });

    if (id) {
      const wompiRes = await fetch(`${WOMPI_API_BASE}/transactions/${id}`);
      if (wompiRes.ok) {
        const body = await wompiRes.json();
        const tx = body.data;
        if (tx && tx.reference === order.reference) {
          order.status = tx.status;
          order.wompiTransactionId = tx.id;
          order.paymentMethod = tx.payment_method_type;
          order.updatedAt = new Date().toISOString();
          if (FAILED_PAYMENT_STATUSES.includes(tx.status)) await restockIfNeeded(order);
          const fresh = loadOrders();
          const idx = fresh.findIndex((o) => o.reference === ref);
          if (idx > -1) {
            fresh[idx] = order;
            await saveOrders(fresh);
          }
        }
      }
    }

    res.json({
      reference: order.reference,
      status: order.status,
      amountInCents: order.amountInCents,
      currency: order.currency,
    });
  } catch (err) {
    console.error('GET /api/checkout/status failed:', err);
    res.status(500).json({ error: 'Could not check order status.' });
  }
});

app.post('/api/webhook/wompi', async (req, res) => {
  try {
    const body = req.body;
    const { signature, timestamp, data } = body || {};
    if (!signature || !Array.isArray(signature.properties) || !data || !data.transaction) {
      return res.status(400).send('Invalid payload');
    }

    const concatenated = signature.properties.map((p) => getAtPath(data, p)).join('');
    const toHash = `${concatenated}${timestamp}${process.env.WOMPI_EVENTS_SECRET}`;
    const checksum = crypto.createHash('sha256').update(toHash).digest('hex').toUpperCase();

    if (checksum !== String(signature.checksum).toUpperCase()) {
      console.warn('Webhook checksum mismatch — ignoring event.');
      return res.status(400).send('Invalid signature');
    }

    const tx = data.transaction;
    const orders = loadOrders();
    const idx = orders.findIndex((o) => o.reference === tx.reference);
    if (idx > -1) {
      orders[idx].status = tx.status;
      orders[idx].wompiTransactionId = tx.id;
      orders[idx].paymentMethod = tx.payment_method_type;
      orders[idx].updatedAt = new Date().toISOString();
      if (FAILED_PAYMENT_STATUSES.includes(tx.status)) await restockIfNeeded(orders[idx]);
      await saveOrders(orders);
    } else {
      console.warn(`Webhook for unknown reference: ${tx.reference}`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('POST /api/webhook/wompi failed:', err);
    res.sendStatus(500);
  }
});

// ---------- admin: dashboard ----------

app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
  const orders = loadOrders();
  const products = loadProducts();

  const approvedOrders = orders.filter((o) => o.status === 'APPROVED');
  const totalSalesCOP = approvedOrders.reduce((sum, o) => sum + Math.round((o.amountInCents || 0) / 100), 0);

  const todayStr = new Date().toISOString().slice(0, 10);
  const ordersToday = orders.filter((o) => String(o.createdAt || '').slice(0, 10) === todayStr).length;

  const awaitingShipment = orders.filter((o) => o.status === 'APPROVED' && o.shippingStatus === 'NOT_SHIPPED').length;

  const lowStock = products
    .filter((p) => Number.isInteger(p.stock) && p.stock <= LOW_STOCK_THRESHOLD)
    .sort((a, b) => a.stock - b.stock)
    .map((p) => ({ id: p.id, name: p.name, stock: p.stock }));

  res.json({
    totalSalesCOP,
    ordersToday,
    totalOrders: orders.length,
    approvedOrders: approvedOrders.length,
    awaitingShipment,
    totalProducts: products.length,
    lowStockThreshold: LOW_STOCK_THRESHOLD,
    lowStock,
  });
});

// ---------- admin: orders + shipping ----------

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const orders = loadOrders().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(orders);
});

// Realistic sample orders so a demo/sales copy of this store shows a
// populated Dashboard + Orders tab without needing a real Wompi payment to
// go through. Flagged isDemo:true so they're easy to tell apart and clear.
function buildDemoOrders(products) {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const pick = (i) => products[i % products.length];
  const customers = [
    { fullName: 'Camila Torres', email: 'camila.torres@example.com', phone: '+57 300 123 4567', city: 'Bogotá' },
    { fullName: 'Santiago Ramírez', email: 'santiago.ramirez@example.com', phone: '+57 301 234 5678', city: 'Medellín' },
    { fullName: 'Valentina Rojas', email: 'valentina.rojas@example.com', phone: '+57 302 345 6789', city: 'Cali' },
    { fullName: 'Juan Pablo Herrera', email: 'juanpablo.herrera@example.com', phone: '+57 303 456 7890', city: 'Barranquilla' },
    { fullName: 'Isabella Castro', email: 'isabella.castro@example.com', phone: null, city: 'Cartagena' },
    { fullName: 'Mateo Londoño', email: 'mateo.londono@example.com', phone: '+57 304 567 8901', city: 'Bogotá' },
    { fullName: 'Daniela Vargas', email: 'daniela.vargas@example.com', phone: '+57 305 678 9012', city: 'Medellín' },
    { fullName: 'Andrés Muñoz', email: 'andres.munoz@example.com', phone: '+57 306 789 0123', city: 'Bogotá' },
  ];
  const plans = [
    { daysAgo: 6, status: 'APPROVED', shippingStatus: 'DELIVERED', items: [[pick(0), 1]], carrier: null, tracking: null },
    { daysAgo: 4, status: 'APPROVED', shippingStatus: 'SHIPPED', items: [[pick(2), 1], [pick(3), 1]], carrier: null, tracking: null },
    { daysAgo: 2, status: 'APPROVED', shippingStatus: 'PROCESSING', items: [[pick(5), 1]], carrier: null, tracking: null },
    { daysAgo: 0, status: 'APPROVED', shippingStatus: 'NOT_SHIPPED', items: [[pick(4), 1]], carrier: null, tracking: null },
    { daysAgo: 0, status: 'PENDING', shippingStatus: 'NOT_SHIPPED', items: [[pick(6), 1]], carrier: null, tracking: null },
    { daysAgo: 1, status: 'DECLINED', shippingStatus: 'NOT_SHIPPED', items: [[pick(1), 1]], carrier: null, tracking: null },
    { daysAgo: 8, status: 'APPROVED', shippingStatus: 'DELIVERED', items: [[pick(3), 2]], carrier: null, tracking: null },
    { daysAgo: 3, status: 'APPROVED', shippingStatus: 'PROCESSING', items: [[pick(0), 1], [pick(4), 1]], carrier: null, tracking: null },
  ];

  return plans.map((plan, i) => {
    const customer = customers[i % customers.length];
    const orderItems = plan.items.map(([p, qty]) => ({ id: p.id, name: p.name, price: p.price, qty }));
    const amountCOP = orderItems.reduce((sum, it) => sum + it.price * it.qty, 0);
    const createdAt = new Date(now - plan.daysAgo * DAY - i * 3600000).toISOString();
    return {
      reference: genReference(),
      items: orderItems,
      amountInCents: amountCOP * 100,
      currency: 'COP',
      status: plan.status,
      customer: { fullName: customer.fullName, email: customer.email, phone: customer.phone },
      shippingAddress: { addressLine: `Calle ${10 + i} # ${20 + i}-${30 + i}`, city: customer.city, region: null },
      shippingStatus: plan.shippingStatus,
      trackingNumber: plan.tracking,
      carrier: plan.carrier,
      wompiTransactionId: null,
      stockRestored: true, // demo orders never touch real inventory
      isDemo: true,
      createdAt,
      updatedAt: createdAt,
    };
  });
}

app.post('/api/admin/orders/seed-demo', requireAdmin, async (req, res) => {
  const products = loadProducts();
  if (!products.length) return res.status(400).json({ error: 'Add at least one product before loading demo orders.' });
  const demoOrders = buildDemoOrders(products);
  const orders = loadOrders();
  orders.push(...demoOrders);
  await saveOrders(orders);
  await auditLog({ action: 'demo_orders_seeded', count: demoOrders.length, ip: req.ip });
  res.status(201).json({ ok: true, count: demoOrders.length });
});

app.post('/api/admin/orders/clear-demo', requireAdmin, async (req, res) => {
  const orders = loadOrders();
  const kept = orders.filter((o) => !o.isDemo);
  const removedCount = orders.length - kept.length;
  await saveOrders(kept);
  await auditLog({ action: 'demo_orders_cleared', count: removedCount, ip: req.ip });
  res.json({ ok: true, count: removedCount });
});

app.patch('/api/admin/orders/:reference/shipping', requireAdmin, async (req, res) => {
  const { shippingStatus, trackingNumber, carrier } = req.body || {};
  if (shippingStatus && !SHIPPING_STATUSES.includes(shippingStatus)) {
    return res.status(400).json({ error: `shippingStatus must be one of: ${SHIPPING_STATUSES.join(', ')}` });
  }

  const orders = loadOrders();
  const idx = orders.findIndex((o) => o.reference === req.params.reference);
  if (idx === -1) return res.status(404).json({ error: 'Order not found.' });

  if (shippingStatus) orders[idx].shippingStatus = shippingStatus;
  if (trackingNumber !== undefined) orders[idx].trackingNumber = trackingNumber ? String(trackingNumber).slice(0, 80) : null;
  if (carrier !== undefined) orders[idx].carrier = carrier ? String(carrier).slice(0, 80) : null;
  orders[idx].updatedAt = new Date().toISOString();

  await saveOrders(orders);
  await auditLog({ action: 'shipping_update', reference: req.params.reference, ip: req.ip, shippingStatus, trackingNumber, carrier });
  res.json(orders[idx]);
});

// Permanently removes an order record. The admin UI requires the user to
// confirm before sending this request.
app.delete('/api/admin/orders/:reference', requireAdmin, async (req, res) => {
  const orders = loadOrders();
  const idx = orders.findIndex((o) => o.reference === req.params.reference);
  if (idx === -1) return res.status(404).json({ error: 'Order not found.' });

  const [removed] = orders.splice(idx, 1);
  await saveOrders(orders);
  await auditLog({ action: 'order_deleted', reference: req.params.reference, ip: req.ip, customerEmail: removed.customer && removed.customer.email });
  res.json({ ok: true });
});

// ---------- admin: receipts ----------

// Viewable/printable in a new browser tab — the admin can save it as a PDF
// with the browser's own print dialog (Ctrl/Cmd+P -> Save as PDF).
app.get('/api/admin/orders/:reference/receipt', requireAdmin, (req, res) => {
  const orders = loadOrders();
  const order = orders.find((o) => o.reference === req.params.reference);
  if (!order) return res.status(404).send('Order not found.');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(renderReceiptHTML(order));
});

// One click: emails the same receipt straight to the customer's address on
// file. Needs SMTP_* set in .env — returns a clear error if they aren't.
app.post('/api/admin/orders/:reference/send-receipt', requireAdmin, async (req, res) => {
  const orders = loadOrders();
  const order = orders.find((o) => o.reference === req.params.reference);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (!order.customer || !order.customer.email) {
    return res.status(400).json({ error: 'This order has no customer email on file.' });
  }

  const transport = getMailTransport();
  if (!transport) {
    return res.status(400).json({
      error: 'Email sending isn’t configured yet. Add SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS to .env — see .env.example.',
    });
  }

  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: order.customer.email,
      subject: `Tu recibo de The Good Shelf — pedido ${order.reference}`,
      html: renderReceiptHTML(order),
    });
    await auditLog({ action: 'receipt_emailed', reference: order.reference, to: order.customer.email, ip: req.ip });
    res.json({ ok: true });
  } catch (err) {
    console.error(`POST /api/admin/orders/${req.params.reference}/send-receipt failed:`, err);
    res.status(500).json({ error: 'Could not send the email. Check your SMTP settings in .env.' });
  }
});

// ---------- admin: products ----------

function validateProductInput(body, opts) {
  opts = opts || {};
  const errors = [];
  const out = {};
  function check(field, val, ok, msg) {
    if (val === undefined) {
      if (!opts.partial) errors.push(`${field} is required.`);
      return;
    }
    if (!ok(val)) errors.push(msg);
    else out[field] = val;
  }
  check('name', body.name, (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 160, 'name must be 1-160 characters.');
  check('tag', body.tag, (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 40, 'category must be 1-40 characters.');
  check('desc', body.desc, (v) => typeof v === 'string' && v.length <= 400, 'description must be under 400 characters.');
  // Accepts any http(s) URL (including long, signed CDN links from Google
  // Photos, Pinterest, Amazon, Unsplash, etc.) or a locally uploaded image
  // path. Whitespace inside the URL itself isn't allowed, but %-encoded
  // spaces and any other URL-safe characters are fine.
  const imgPattern = /^(https?:\/\/\S+|\/\S+)$/i;
  check('images', body.images, (v) => Array.isArray(v) && v.length >= 1 && v.length <= 8 && v.every((u) => typeof u === 'string' && imgPattern.test(u) && u.length <= 2000), 'images must be a list of 1-8 valid image URLs or uploaded image paths.');
  check('price', body.price, (v) => Number.isInteger(v) && v > 0 && v <= 500000000, 'price must be a positive whole number (COP).');
  check('stock', body.stock, (v) => Number.isInteger(v) && v >= 0 && v <= 1000000, 'stock must be a whole number, 0 or greater.');

  // Size is always optional, even when creating a product (unlike the
  // other fields, an empty/omitted value is never an error).
  if (body.size !== undefined) {
    if (typeof body.size !== 'string' || body.size.length > 40) {
      errors.push('size must be under 40 characters.');
    } else {
      out.size = body.size.trim() || null;
    }
  }

  return { errors, out };
}

const ALLOWED_IMAGE_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, IMAGES_DIR),
    filename: (req, file, cb) => {
      const ext = ALLOWED_IMAGE_TYPES[file.mimetype] || path.extname(file.originalname).toLowerCase();
      cb(null, crypto.randomBytes(10).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES[file.mimetype]) {
      return cb(new Error('Only PNG, JPEG, WEBP, or GIF images are allowed.'));
    }
    cb(null, true);
  },
});

// Uploads a product photo and returns the path to use as `img`.
// Files are saved under /images with a random filename (originals are
// never trusted) and served back through the existing static images route.
app.post('/api/admin/upload', requireAdmin, (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Image must be under 5MB.' : (err.message || 'Upload failed.');
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    await auditLog({ action: 'image_upload', filename: req.file.filename, ip: req.ip });
    res.status(201).json({ url: '/images/' + req.file.filename });
  });
});

app.get('/api/admin/products', requireAdmin, (req, res) => {
  res.json(loadProducts());
});

app.post('/api/admin/products', requireAdmin, async (req, res) => {
  const { errors, out } = validateProductInput(req.body || {});
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });

  const products = loadProducts();
  const nextId = products.reduce((max, p) => Math.max(max, p.id), 0) + 1;
  const product = { id: nextId, tag: out.tag.trim(), name: out.name.trim(), desc: out.desc, images: out.images, price: out.price, stock: out.stock, size: out.size !== undefined ? out.size : null };
  products.push(product);
  await saveProducts(products);
  await auditLog({ action: 'product_create', productId: product.id, ip: req.ip });
  res.status(201).json(product);
});

app.put('/api/admin/products/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { errors, out } = validateProductInput(req.body || {}, { partial: true });
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });

  const products = loadProducts();
  const idx = products.findIndex((p) => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Product not found.' });

  if (out.tag) out.tag = out.tag.trim();
  if (out.name) out.name = out.name.trim();

  // Any photos dropped from the images list get moved to the trash (no
  // longer publicly reachable) instead of silently orphaned on disk.
  if (out.images) {
    const before = Array.isArray(products[idx].images) ? products[idx].images : [];
    const removedUrls = before.filter((u) => !out.images.includes(u));
    if (removedUrls.length) {
      const trash = loadTrash();
      for (const url of removedUrls) {
        const file = await trashImageFile(url);
        trash.push({
          id: genTrashId(),
          type: 'image',
          deletedAt: new Date().toISOString(),
          productId: id,
          productName: products[idx].name,
          files: [file],
        });
      }
      await saveTrash(trash);
      await auditLog({ action: 'image_trashed', productId: id, count: removedUrls.length, ip: req.ip });
    }
  }

  products[idx] = Object.assign({}, products[idx], out);
  await saveProducts(products);
  await auditLog({ action: 'product_update', productId: id, ip: req.ip });
  res.json(products[idx]);
});

app.delete('/api/admin/products/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const products = loadProducts();
  const idx = products.findIndex((p) => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Product not found.' });

  const [removed] = products.splice(idx, 1);
  await saveProducts(products);

  // Soft-delete: the product record and its photos move to the trash
  // (photos come off the public /images route immediately) and can be
  // restored until the trash is cleared.
  const files = [];
  for (const url of removed.images || []) {
    files.push(await trashImageFile(url));
  }
  const trash = loadTrash();
  trash.push({
    id: genTrashId(),
    type: 'product',
    deletedAt: new Date().toISOString(),
    productId: id,
    productName: removed.name,
    product: removed,
    files,
  });
  await saveTrash(trash);

  await auditLog({ action: 'product_delete', productId: id, ip: req.ip });
  res.json({ ok: true, removed });
});

// ---------- admin: trash ----------

app.get('/api/admin/trash', requireAdmin, (req, res) => {
  const trash = loadTrash().sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));
  res.json(trash);
});

// Streams a trashed photo back so the admin can preview it before deciding
// to restore or permanently delete it. Not publicly listed anywhere.
app.get('/api/admin/trash-image/:trashId/:filename', requireAdmin, (req, res) => {
  const trash = loadTrash();
  const entry = trash.find((t) => t.id === req.params.trashId);
  if (!entry) return res.status(404).end();
  const filename = path.basename(req.params.filename);
  const known = (entry.files || []).some((f) => f.trashed && f.filename === filename);
  if (!known) return res.status(404).end();
  res.sendFile(path.join(TRASH_IMAGES_DIR, filename));
});

app.post('/api/admin/trash/:id/restore', requireAdmin, async (req, res) => {
  const trash = loadTrash();
  const idx = trash.findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Trash item not found.' });
  const entry = trash[idx];

  for (const file of entry.files || []) await restoreImageFile(file);

  if (entry.type === 'product') {
    const products = loadProducts();
    const idExists = products.some((p) => p.id === entry.product.id);
    const restored = idExists
      ? Object.assign({}, entry.product, { id: products.reduce((max, p) => Math.max(max, p.id), 0) + 1 })
      : entry.product;
    products.push(restored);
    await saveProducts(products);
    trash.splice(idx, 1);
    await saveTrash(trash);
    await auditLog({ action: 'trash_restore_product', productId: restored.id, ip: req.ip });
    return res.json({ ok: true, type: 'product', product: restored });
  }

  // type === 'image'
  const products = loadProducts();
  const pIdx = products.findIndex((p) => p.id === entry.productId);
  const url = entry.files && entry.files[0] && entry.files[0].url;
  let attached = false;
  if (pIdx > -1 && url) {
    if (!products[pIdx].images.includes(url)) {
      products[pIdx].images.push(url);
      attached = true;
    }
    await saveProducts(products);
  }
  trash.splice(idx, 1);
  await saveTrash(trash);
  await auditLog({ action: 'trash_restore_image', productId: entry.productId, attached, ip: req.ip });
  res.json({ ok: true, type: 'image', attached });
});

app.delete('/api/admin/trash/:id', requireAdmin, async (req, res) => {
  const trash = loadTrash();
  const idx = trash.findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Trash item not found.' });
  await purgeTrashFiles(trash[idx]);
  trash.splice(idx, 1);
  await saveTrash(trash);
  await auditLog({ action: 'trash_delete_forever', trashId: req.params.id, ip: req.ip });
  res.json({ ok: true });
});

app.post('/api/admin/trash/empty', requireAdmin, async (req, res) => {
  const count = await purgeAllTrash();
  await auditLog({ action: 'trash_emptied_manually', count, ip: req.ip });
  res.json({ ok: true, count });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, env: APP_ENV, missingEnv });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`The Good Shelf server running on port ${PORT} [${APP_ENV}]`);
});
