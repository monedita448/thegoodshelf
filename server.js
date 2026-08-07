// MiTienda by COLHQ — ecommerce platform backend
// (The Good Shelf is the demo store this template ships with.)
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
const SETTINGS_PATH = path.join(ROOT, 'settings.json');
const INVENTORY_HISTORY_PATH = path.join(ROOT, 'inventory_history.json');
const CUSTOMERS_PATH = path.join(ROOT, 'customers.json');
const EXPENSES_PATH = path.join(ROOT, 'expenses.json');
const PLATFORM_PATH = path.join(ROOT, 'platform.json');
fs.mkdirSync(TRASH_IMAGES_DIR, { recursive: true });

// Platform identity (MiTienda by COLHQ) lives in platform.json — git-tracked,
// so it is the same for every store the platform runs. Store identity (name,
// branding, copy) lives in settings.json instead. Keep the two separate:
// platform.json is never mixed into the store's settings.
const DEFAULT_PLATFORM = {
  platformName: 'MiTienda',
  companyName: 'COLHQ',
  displayName: 'MiTienda by COLHQ',
  showPlatformBrand: true,
};
function loadPlatform() {
  try {
    return Object.assign(deepClone(DEFAULT_PLATFORM), JSON.parse(fs.readFileSync(PLATFORM_PATH, 'utf8')));
  } catch (e) {
    return deepClone(DEFAULT_PLATFORM);
  }
}

// Store settings (branding, theme, copy, WhatsApp) live in settings.json —
// git-ignored and auto-created at runtime, mirroring the products/orders
// flat-file pattern. settings.example.json is the tracked source of defaults.
const DEFAULT_SETTINGS = (() => {
  try {
    return require('./settings.example.json');
  } catch (e) {
    // Last-resort fallback if settings.example.json is ever missing, so the
    // server still boots. Store name only — everything else is cosmetic.
    return {
      storeName: 'The Good Shelf',
      storeId: 'the-good-shelf',
      businessType: null,
      setupCompleted: false,
      paymentPreference: 'wompi',
    };
  }
})();
function deepClone(v) { return JSON.parse(JSON.stringify(v)); }

// Deleted products, photos, and orders are held here — recoverable — for
// 30 days after deletion (see TRASH_RETENTION_DAYS below).

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
// How the seller records that a sale was paid. Checkout orders start as
// 'wompi'; the admin can change it (Nequi, bank transfer, cash, other).
const PAYMENT_METHODS = ['wompi', 'nequi', 'bank', 'cash', 'other'];
// Older orders stored Wompi's raw transaction types ('CARD', 'NEQUI',
// 'PSE', ...). Treat anything outside the admin's set as 'wompi'.
function normalizePaymentMethod(m) {
  if (PAYMENT_METHODS.includes(m)) return m;
  if (m) return 'wompi';
  return null;
}
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

// ---------- customers (CRM) ----------

function loadCustomers() {
  try {
    return JSON.parse(fs.readFileSync(CUSTOMERS_PATH, 'utf8'));
  } catch (e) {
    return [];
  }
}

let customersWriteQueue = Promise.resolve();
function saveCustomers(customers) {
  customersWriteQueue = customersWriteQueue.then(() =>
    fsp.writeFile(CUSTOMERS_PATH, JSON.stringify(customers, null, 2))
  );
  return customersWriteQueue;
}

// ---------- expenses (finance / bookkeeping) ----------

const EXPENSE_CATEGORIES = ['delivery', 'advertising', 'packaging', 'rent', 'salaries', 'supplies', 'other'];
const EXPENSE_PAYMENT_METHODS = ['cash', 'bank', 'nequi', 'other'];

function loadExpenses() {
  try {
    return JSON.parse(fs.readFileSync(EXPENSES_PATH, 'utf8'));
  } catch (e) {
    return [];
  }
}

let expensesWriteQueue = Promise.resolve();
function saveExpenses(expenses) {
  expensesWriteQueue = expensesWriteQueue.then(() =>
    fsp.writeFile(EXPENSES_PATH, JSON.stringify(expenses, null, 2))
  );
  return expensesWriteQueue;
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

// ---------- store settings (branding, theme, copy) ----------

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch (e) {
    return deepClone(DEFAULT_SETTINGS);
  }
}

let settingsWriteQueue = Promise.resolve();
function saveSettings(settings) {
  settingsWriteQueue = settingsWriteQueue.then(() =>
    fsp.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2))
  );
  return settingsWriteQueue;
}

// Saved settings + defaults for any top-level key a store has never saved yet
// (e.g. new fields added after the store's settings.json was created). Lets
// the admin editor show real defaults instead of blanks until the owner saves.
function loadSettingsMerged() {
  return Object.assign(deepClone(DEFAULT_SETTINGS), loadSettings());
}

// ---------- store identity + future multi-store abstraction ----------
//
// Today the platform stores everything for the single current store in
// settings.json / products.json / orders.json. These helpers are the seam
// where per-store directories will slot in later (settings/<storeId>.json
// etc.) — for now they just wrap the single-store functions so the rest of
// the code never has to know which filesystem layout is in use.

const STORE_ID_RE = /^[a-z0-9-]+$/;
const STORE_ID_MAX = 40;

function slugifyStoreName(name) {
  return (name || '')
    .toString().toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, STORE_ID_MAX);
}

// Returns the current store's stable id. Existing stores that predate storeId
// automatically get a default derived from their store name ("The Good Shelf"
// → "the-good-shelf"), falling back to the demo-store id if there's nothing
// to slugify.
function getStoreId(settings) {
  const s = settings || loadSettings();
  if (s.storeId && STORE_ID_RE.test(s.storeId)) return s.storeId.slice(0, STORE_ID_MAX);
  return slugifyStoreName(s.storeName) || 'the-good-shelf';
}

// Abstractions over the flat-file storage. Same behavior as loadSettings /
// saveSettings for the single current store.
function loadStoreSettings() {
  return loadSettings();
}
function saveStoreSettings(settings) {
  return saveSettings(settings);
}

// ---------- inventory history (stock-change trail) ----------

function loadInventoryHistory() {
  try {
    return JSON.parse(fs.readFileSync(INVENTORY_HISTORY_PATH, 'utf8'));
  } catch (e) {
    return [];
  }
}

let inventoryWriteQueue = Promise.resolve();
// Append-style log so a slow store can never lose a stock event. The queue
// serializes read-modify-write; entries are capped so the file stays small.
function logInventoryChange(entry) {
  inventoryWriteQueue = inventoryWriteQueue.then(async () => {
    let history = loadInventoryHistory();
    history.push(Object.assign({ id: crypto.randomBytes(8).toString('hex'), createdAt: new Date().toISOString() }, entry));
    if (history.length > 2000) history = history.slice(-2000);
    await fsp.writeFile(INVENTORY_HISTORY_PATH, JSON.stringify(history, null, 2));
  }).catch((err) => console.error('inventory history write failed:', err));
  return inventoryWriteQueue;
}

// The public storefront only ever sees this projection of the settings, so
// future non-public fields can never leak out of GET /api/settings.
function publicSettings(settings) {
  return deepClone({
    storeId: getStoreId(settings),
    storeName: settings.storeName,
    businessType: settings.businessType || null,
    tagline: settings.tagline,
    description: settings.description,
    logo: settings.logo,
    defaultLang: settings.defaultLang,
    theme: settings.theme,
    content: settings.content,
    whatsapp: settings.whatsapp,
    socialLinks: settings.socialLinks,
    footer: settings.footer,
    platformCredit: settings.platformCredit || deepClone(DEFAULT_SETTINGS.platformCredit),
  });
}

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const RADIUS_RE = /^\d+(px|rem|%)$/;
const PHONE_RE = /^[0-9+][0-9 ]*$/;
const FONTS_URL_RE = /^https:\/\/fonts\.googleapis\.com\//;

const BUSINESS_TYPES = ['fashion', 'beauty', 'technology', 'food', 'home', 'other'];
const PAYMENT_PREFERENCES = ['wompi', 'whatsapp', 'nequi', 'bank'];

// Validates and applies an incoming theme object onto `value.theme`
// (reused by both the settings editor and the setup wizard). Returns an
// error string, or null on success. Self-contained so it can be called from
// anywhere (it does not depend on validateSettings' local helpers).
function applyThemeField(value, t) {
  const err = (msg) => ({ error: msg });
  const str = (v, label, max) => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string') return err(label + ' must be text.');
    const s = v.trim();
    if (s.length > max) return err(label + ' is too long (max ' + max + ' characters).');
    return s;
  };
  if (!t || typeof t !== 'object' || Array.isArray(t)) return 'Theme must be an object.';

  const preset = str(t.preset, 'Theme preset', 40);
  if (preset && preset.error) return preset.error;
  if (preset) value.theme.preset = preset;

  if (t.palette) {
    if (typeof t.palette !== 'object' || Array.isArray(t.palette)) return 'Palette must be an object.';
    const colors = ['bg', 'panel', 'text', 'muted', 'line', 'accent', 'accentDark', 'success'];
    for (const key of colors) {
      if (t.palette[key] === undefined) continue;
      if (typeof t.palette[key] !== 'string' || !HEX_COLOR_RE.test(t.palette[key])) {
        return 'Palette color "' + key + '" must be a hex color like #8a6f4d.';
      }
      value.theme.palette[key] = t.palette[key];
    }
  }

  const fontHeading = str(t.fontHeading, 'Heading font', 80);
  if (fontHeading && fontHeading.error) return fontHeading.error;
  if (fontHeading) value.theme.fontHeading = fontHeading;

  const fontBody = str(t.fontBody, 'Body font', 80);
  if (fontBody && fontBody.error) return fontBody.error;
  if (fontBody) value.theme.fontBody = fontBody;

  if (t.fontsUrl !== undefined) {
    const fontsUrl = str(t.fontsUrl, 'Fonts URL', 500);
    if (fontsUrl && fontsUrl.error) return fontsUrl.error;
    if (fontsUrl && !FONTS_URL_RE.test(fontsUrl)) return 'Fonts URL must be a Google Fonts link (https://fonts.googleapis.com/...).';
    value.theme.fontsUrl = fontsUrl || '';
  }

  if (t.radius !== undefined) {
    const radius = str(t.radius, 'Radius', 20);
    if (radius && radius.error) return radius.error;
    if (radius && !RADIUS_RE.test(radius)) return 'Radius must look like "20px", "1rem" or "5%".';
    if (radius) value.theme.radius = radius;
  }

  return null;
}

// Validates an incoming settings object and returns a fully-formed one
// (missing fields keep their defaults). Returns { value } or { error }.
function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Settings must be a JSON object.' };
  }
  const value = deepClone(DEFAULT_SETTINGS);

  const err = (msg) => ({ error: msg });
  const str = (v, label, max) => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string') return err(label + ' must be text.');
    const s = v.trim();
    if (s.length > max) return err(label + ' is too long (max ' + max + ' characters).');
    return s;
  };
  const bool = (v, dflt) => (typeof v === 'boolean' ? v : dflt);
  const pair = (v, label, max) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return err(label + ' must be an object with en/es text.');
    const en = str(v.en, label + ' (EN)', max);
    if (en && en.error) return en;
    const es = str(v.es, label + ' (ES)', max);
    if (es && es.error) return es;
    return { en: en || '', es: es || '' };
  };

  const storeName = str(input.storeName, 'Store name', 60);
  if (storeName && storeName.error) return storeName;
  if (!storeName) return err('Store name is required.');
  value.storeName = storeName;

  // storeId: validated if provided, otherwise derived from the store name so
  // existing stores (and the wizard) always end up with a stable slug id.
  if (input.storeId !== undefined) {
    const storeId = str(input.storeId, 'Store ID', STORE_ID_MAX);
    if (storeId && storeId.error) return storeId;
    if (storeId && !STORE_ID_RE.test(storeId)) {
      return err('Store ID must be lowercase letters, numbers, and hyphens only.');
    }
    value.storeId = storeId || slugifyStoreName(value.storeName);
  } else {
    value.storeId = slugifyStoreName(value.storeName);
  }

  if (input.businessType !== undefined) {
    if (input.businessType !== null && !BUSINESS_TYPES.includes(input.businessType)) {
      return err('businessType must be one of: ' + BUSINESS_TYPES.join(', ') + '.');
    }
    value.businessType = input.businessType || null;
  }

  if (input.setupCompleted !== undefined) {
    value.setupCompleted = bool(input.setupCompleted, value.setupCompleted);
  }

  if (input.paymentPreference !== undefined) {
    if (!PAYMENT_PREFERENCES.includes(input.paymentPreference)) {
      return err('paymentPreference must be one of: ' + PAYMENT_PREFERENCES.join(', ') + '.');
    }
    value.paymentPreference = input.paymentPreference;
  }

  if (input.tagline !== undefined) {
    const tagline = str(input.tagline, 'Tagline', 120);
    if (tagline && tagline.error) return tagline;
    value.tagline = tagline || '';
  }

  if (input.description !== undefined) {
    const description = str(input.description, 'Description', 300);
    if (description && description.error) return description;
    value.description = description || '';
  }

  if (input.logo !== undefined) {
    const logo = str(input.logo, 'Logo', 500);
    if (logo && logo.error) return logo;
    if (logo && !(/^\/[a-zA-Z0-9_.\-/]+$/.test(logo) || /^https:\/\//.test(logo))) {
      return err('Logo must be a local path (e.g. /images/logo.png) or an https URL.');
    }
    value.logo = logo || null;
  }

  if (input.defaultLang !== undefined) {
    if (input.defaultLang !== 'en' && input.defaultLang !== 'es') return err('defaultLang must be "en" or "es".');
    value.defaultLang = input.defaultLang;
  }

  if (input.theme) {
    const themeErr = applyThemeField(value, input.theme);
    if (themeErr) return { error: themeErr };
  }

  if (input.content) {
    if (typeof input.content !== 'object' || Array.isArray(input.content)) return err('Content must be an object.');
    const c = input.content;
    const textPairs = [
      ['heroEyebrow', 120], ['heroSub', 300], ['shopHeading', 200], ['shopSub', 300],
      ['aboutP1', 500], ['aboutP2', 300], ['aboutPaymentHeading', 200],
      ['aboutCheckoutIntro', 200], ['aboutShipping', 300], ['footerTagline', 200],
    ];
    for (const [key, max] of textPairs) {
      if (c[key] === undefined) continue;
      const p = pair(c[key], key, max);
      if (p.error) return p;
      value.content[key] = p;
    }
    if (c.facts !== undefined) {
      if (!Array.isArray(c.facts) || c.facts.length !== 3) return err('Facts must be a list of exactly 3 items.');
      const facts = [];
      for (let i = 0; i < 3; i++) {
        const f = c.facts[i];
        if (!f || typeof f !== 'object' || Array.isArray(f)) return err('Fact ' + (i + 1) + ' must be an object.');
        const title = pair(f.title, 'Fact ' + (i + 1) + ' title', 120);
        if (title.error) return title;
        const desc = pair(f.desc, 'Fact ' + (i + 1) + ' description', 300);
        if (desc.error) return desc;
        facts.push({ title, desc });
      }
      value.content.facts = facts;
    }
  }

  if (input.whatsapp) {
    if (typeof input.whatsapp !== 'object' || Array.isArray(input.whatsapp)) return err('WhatsApp settings must be an object.');
    if (input.whatsapp.number !== undefined) {
      const number = str(input.whatsapp.number, 'WhatsApp number', 20);
      if (number && number.error) return number;
      if (number && !PHONE_RE.test(number)) return err('WhatsApp number must contain only digits (plus an optional leading +).');
      value.whatsapp.number = number || null;
    }
    if (input.whatsapp.checkoutMode !== undefined) {
      if (input.whatsapp.checkoutMode !== 'wompi' && input.whatsapp.checkoutMode !== 'whatsapp') {
        return err('checkoutMode must be "wompi" or "whatsapp".');
      }
      value.whatsapp.checkoutMode = input.whatsapp.checkoutMode;
    }
    value.whatsapp.showButton = bool(input.whatsapp.showButton, value.whatsapp.showButton);
  }

  if (input.socialLinks) {
    if (typeof input.socialLinks !== 'object' || Array.isArray(input.socialLinks)) return err('Social links must be an object.');
    for (const key of ['instagram', 'tiktok', 'facebook']) {
      if (input.socialLinks[key] === undefined) continue;
      const link = str(input.socialLinks[key], 'Social link (' + key + ')', 300);
      if (link && link.error) return link;
      value.socialLinks[key] = link || null;
    }
  }

  if (input.footer) {
    if (typeof input.footer !== 'object' || Array.isArray(input.footer)) return err('Footer settings must be an object.');
    if (input.footer.credit !== undefined) {
      const credit = str(input.footer.credit, 'Footer credit', 120);
      if (credit && credit.error) return credit;
      value.footer.credit = credit || '';
    }
    value.footer.showMadeBy = bool(input.footer.showMadeBy, value.footer.showMadeBy);
    value.footer.showAdminLink = bool(input.footer.showAdminLink, value.footer.showAdminLink);
  }

  if (input.platformCredit) {
    if (typeof input.platformCredit !== 'object' || Array.isArray(input.platformCredit)) return err('Platform credit settings must be an object.');
    if (input.platformCredit.text !== undefined) {
      const credit = str(input.platformCredit.text, 'Platform credit', 60);
      if (credit && credit.error) return credit;
      value.platformCredit.text = credit || '';
    }
    value.platformCredit.show = bool(input.platformCredit.show, value.platformCredit.show);
  }

  return { value };
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

// If `types` is given, only entries whose `type` is in that list are
// purged (everything else stays); otherwise everything is purged. Used so
// "Empty now" on the Products bin doesn't also wipe out trashed orders,
// and vice versa. The daily auto-clear always purges everything.
async function purgeTrash(types) {
  const trash = loadTrash();
  const toPurge = types ? trash.filter((t) => types.includes(t.type)) : trash;
  const remaining = types ? trash.filter((t) => !types.includes(t.type)) : [];
  for (const entry of toPurge) await purgeTrashFiles(entry);
  await saveTrash(remaining);
  return toPurge.length;
}

async function purgeAllTrash() {
  const count = await purgeTrash(null);
  if (count) await auditLog({ action: 'trash_purged', count });
  return count;
}

// Each trashed item (product, photo, or order) clears itself out 30 days
// after it was deleted — not on a fixed daily clock, so nothing is ever
// lost sooner than 30 days regardless of what time it was deleted.
const TRASH_RETENTION_DAYS = 30;
const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

async function purgeExpiredTrash() {
  const trash = loadTrash();
  const cutoff = Date.now() - TRASH_RETENTION_MS;
  const expired = trash.filter((t) => new Date(t.deletedAt).getTime() <= cutoff);
  if (!expired.length) return 0;
  const remaining = trash.filter((t) => new Date(t.deletedAt).getTime() > cutoff);
  for (const entry of expired) await purgeTrashFiles(entry);
  await saveTrash(remaining);
  await auditLog({ action: 'trash_purged_expired', count: expired.length, retentionDays: TRASH_RETENTION_DAYS });
  return expired.length;
}

// Checked hourly (a rolling 30-day expiry doesn't need a precise clock
// time the way the old daily purge did), plus once shortly after boot so
// nothing lingers until the first hourly tick if the server was restarted.
setInterval(() => {
  purgeExpiredTrash().catch((err) => console.error('Trash expiry purge failed:', err));
}, 60 * 60 * 1000).unref();
setTimeout(() => {
  purgeExpiredTrash().catch((err) => console.error('Trash expiry purge failed:', err));
}, 10 * 1000).unref();

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
  const settings = loadSettings();
  const brandName = (settings.storeName || 'The Good Shelf').trim() || 'The Good Shelf';
  const footerCredit = (settings.footer && settings.footer.showMadeBy !== false && (settings.footer.credit || '').trim())
    ? settings.footer.credit.trim()
    : null;
  const platformCreditCfg = settings.platformCredit || deepClone(DEFAULT_SETTINGS.platformCredit);
  const platformCredit = (platformCreditCfg.show !== false && (platformCreditCfg.text || '').trim())
    ? platformCreditCfg.text.trim()
    : null;
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
  <h1 style="font-size:22px;margin:0 0 4px">${escapeHtml(brandName)}</h1>
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

  <p style="color:#66625a;font-size:13px;margin-top:28px">Gracias por comprar en ${escapeHtml(brandName)}.</p>
  ${footerCredit
    ? '<p style="color:#a39c8f;font-size:11px;margin-top:20px;padding-top:16px;border-top:1px solid #e7e0d5">' +
        '<a href="https://colhq.com" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline">' + escapeHtml(footerCredit) + '</a>' +
      '</p>'
    : ''}
  ${platformCredit
    ? '<p style="color:#a39c8f;font-size:11px;margin-top:8px">' + escapeHtml(platformCredit) + '</p>'
    : ''}
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
      const before = Number.isInteger(p.stock) ? p.stock : 0;
      p.stock = before + item.qty;
      await logInventoryChange({
        productId: p.id,
        productName: p.name,
        delta: item.qty,
        newStock: p.stock,
        reason: 'restore',
        reference: order.reference,
      });
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

// ---------- customer management (CRM) ----------
//
// Customers are built from the order/customer information already collected
// at checkout, and live in git-ignored customers.json (same flat-file
// pattern as orders). A customer is identified by phone number; orders
// without a phone fall back to email so nobody gets missed.

// Colombian mobile numbers are commonly entered without the country code
// (10 digits). Assume +57 in that case since this store is Colombia-based.
// Only digits are kept so "+57 300 123 4567" and "3001234567" match.
function normalizeCustomerPhone(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/[^0-9]/g, '').replace(/^0+/, '');
  if (digits.length === 10) digits = '57' + digits;
  return digits || null;
}

function normalizeCustomerEmail(email) {
  if (!email) return null;
  return String(email).trim().toLowerCase();
}

// Creates a new customer or updates an existing one from an order. Runs on
// order creation only (not on payment status changes), so a customer's
// totals track everything they've ordered.
async function upsertCustomerFromOrder(order) {
  const oc = order.customer || {};
  const phoneKey = normalizeCustomerPhone(oc.phone);
  const emailKey = normalizeCustomerEmail(oc.email);
  const customers = loadCustomers();
  let existing = phoneKey
    ? customers.find((c) => c.phone && normalizeCustomerPhone(c.phone) === phoneKey)
    : customers.find((c) => c.email && normalizeCustomerEmail(c.email) === emailKey);
  if (!existing && emailKey) existing = customers.find((c) => c.email && normalizeCustomerEmail(c.email) === emailKey);

  const amountCOP = Math.round((order.amountInCents || 0) / 100);
  const orderAt = order.createdAt || new Date().toISOString();
  const str = (v, max) => (v == null ? null : String(v).slice(0, max));

  if (existing) {
    existing.totalOrders = (Number.isInteger(existing.totalOrders) ? existing.totalOrders : 0) + 1;
    existing.totalSpentCOP = (Number.isInteger(existing.totalSpentCOP) ? existing.totalSpentCOP : 0) + amountCOP;
    existing.lastOrderAt = orderAt;
    if (!existing.name) existing.name = str(oc.fullName, 120);
    if (!existing.email) existing.email = str(oc.email, 160);
    if (!existing.city && order.shippingAddress) existing.city = str(order.shippingAddress.city, 100);
  } else {
    customers.push({
      id: crypto.randomBytes(10).toString('hex'),
      name: str(oc.fullName, 120),
      phone: str(oc.phone, 30),
      email: str(oc.email, 160),
      city: order.shippingAddress ? str(order.shippingAddress.city, 100) : null,
      totalOrders: 1,
      totalSpentCOP: amountCOP,
      lastOrderAt: orderAt,
      createdAt: new Date().toISOString(),
    });
  }

  await saveCustomers(customers);
}

// Orders belonging to a customer, newest first. Matches by the same
// phone-then-email keys used at checkout.
function customerOrders(customer) {
  const phoneKey = customer.phone ? normalizeCustomerPhone(customer.phone) : null;
  const emailKey = normalizeCustomerEmail(customer.email);
  return loadOrders()
    .filter((o) => {
      const oc = o.customer || {};
      const op = normalizeCustomerPhone(oc.phone);
      const oe = normalizeCustomerEmail(oc.email);
      if (phoneKey && op && op === phoneKey) return true;
      return Boolean(emailKey && oe && oe === emailKey);
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// Builds the customer file from existing orders on first run, so a store
// that already has order history doesn't start with an empty CRM (and its
// list/detail totals can't disagree). Idempotent: it only fills the file
// when customers.json is missing or empty — after that, per-order upserts
// keep it current.
async function backfillCustomersFromOrders() {
  let customers = null;
  try {
    customers = JSON.parse(fs.readFileSync(CUSTOMERS_PATH, 'utf8'));
  } catch (e) { /* file missing — safe to backfill */ }
  if (Array.isArray(customers) && customers.length) return; // already has data
  if (!Array.isArray(customers)) customers = [];

  const byKey = new Map();
  const orders = loadOrders().slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  for (const o of orders) {
    const oc = o.customer || {};
    const phoneKey = normalizeCustomerPhone(oc.phone);
    const emailKey = normalizeCustomerEmail(oc.email);
    const key = phoneKey ? 'p:' + phoneKey : (emailKey ? 'e:' + emailKey : null);
    if (!key) continue;
    const amountCOP = Math.round((o.amountInCents || 0) / 100);
    const orderAt = o.createdAt || new Date().toISOString();
    let c = byKey.get(key);
    if (!c) {
      c = {
        id: crypto.randomBytes(10).toString('hex'),
        name: oc.fullName ? String(oc.fullName).slice(0, 120) : null,
        phone: oc.phone ? String(oc.phone).slice(0, 30) : null,
        email: oc.email ? String(oc.email).slice(0, 160) : null,
        city: (o.shippingAddress && o.shippingAddress.city) ? String(o.shippingAddress.city).slice(0, 100) : null,
        totalOrders: 0,
        totalSpentCOP: 0,
        lastOrderAt: null,
        createdAt: orderAt,
      };
      byKey.set(key, c);
      customers.push(c);
    }
    c.totalOrders += 1;
    c.totalSpentCOP += amountCOP;
    if (!c.lastOrderAt || new Date(orderAt) > new Date(c.lastOrderAt)) c.lastOrderAt = orderAt;
    if (!c.city && o.shippingAddress && o.shippingAddress.city) c.city = String(o.shippingAddress.city).slice(0, 100);
  }

  if (customers.length) await saveCustomers(customers);
}

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
      paymentMethod: 'wompi',
      stockRestored: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const orders = loadOrders();
    orders.push(order);
    await saveOrders(orders);

    // Keep the customer file in sync with every order, so the CRM always
    // reflects what was actually ordered.
    await upsertCustomerFromOrder(order);

    // Reserve stock immediately so two customers can't buy the last unit.
    // If the payment ultimately fails, restockIfNeeded() puts it back.
    const products = loadProducts();
    for (const item of priced.orderItems) {
      const p = products.find((x) => x.id === item.id);
      if (p) {
        const before = Number.isInteger(p.stock) ? p.stock : 0;
        p.stock = Math.max(0, before - item.qty);
        await logInventoryChange({
          productId: p.id,
          productName: p.name,
          delta: -(item.qty),
          newStock: p.stock,
          reason: 'order',
          reference,
        });
      }
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
          if (!order.paymentMethod) order.paymentMethod = 'wompi';
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

// Date bucketing uses the server's local time, which is what a small
// Colombian store expects to see on its own machine.
function localDateKey(iso) {
  const d = iso ? new Date(iso) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// Expense dates are plain calendar dates (YYYY-MM-DD), not datetimes. Parsing
// them with new Date() shifts a day in negative-UTC-offset timezones, so treat
// a bare YYYY-MM-DD string literally and only convert real timestamps.
function dateKey(iso) {
  if (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  return localDateKey(iso);
}
function startOfWeekKey(now) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = d.getDay(); // 0 = Sunday … 6 = Saturday; weeks start Monday
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  return localDateKey(d);
}
function productCostById(products) {
  const map = new Map();
  for (const p of products) if (p && Number.isInteger(p.id)) map.set(p.id, p);
  return map;
}
// Estimated gross profit for an order from current product cost prices.
// Items whose product is missing or has no costPrice contribute nothing and
// mark the estimate as incomplete (the admin UI shows a hint to fill costs).
function orderProfit(order, productsById) {
  let profit = 0;
  let complete = true;
  for (const it of order.items || []) {
    const qty = Number.isInteger(it.qty) ? it.qty : 0;
    if (!qty) continue;
    const price = Number.isInteger(it.price) ? it.price : 0;
    const cost = (() => {
      const p = productsById.get(it.id);
      return p && Number.isInteger(p.costPrice) ? p.costPrice : null;
    })();
    if (cost === null) {
      complete = false;
      continue;
    }
    profit += (price - cost) * qty;
  }
  return { profit, complete };
}

app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
  const orders = loadOrders();
  const products = loadProducts();

  const approvedOrders = orders.filter((o) => o.status === 'APPROVED');
  const totalSalesCOP = approvedOrders.reduce((sum, o) => sum + Math.round((o.amountInCents || 0) / 100), 0);

  const todayStr = new Date().toISOString().slice(0, 10);
  const ordersToday = orders.filter((o) => String(o.createdAt || '').slice(0, 10) === todayStr).length;

  const awaitingShipment = orders.filter((o) => o.status === 'APPROVED' && o.shippingStatus === 'NOT_SHIPPED').length;

  // A product's own minStock wins; the global threshold is the fallback
  // for products that never set one.
  const lowStockThreshold = (p) => (Number.isInteger(p.minStock) ? p.minStock : LOW_STOCK_THRESHOLD);
  const lowStock = products
    .filter((p) => Number.isInteger(p.stock) && p.stock <= lowStockThreshold(p))
    .sort((a, b) => a.stock - b.stock)
    .map((p) => ({ id: p.id, name: p.name, stock: p.stock, minStock: p.minStock }));

  const inventoryValueCOP = products.reduce(
    (sum, p) => sum + (Number.isInteger(p.stock) ? p.stock : 0) * (Number.isInteger(p.price) ? p.price : 0),
    0
  );

  // Business-overview metrics. Sales buckets and profit count approved
  // (paid) orders only; orderCount counts every order.
  const now = new Date();
  const todayKey = localDateKey(now);
  const weekStartKey = startOfWeekKey(now);
  const monthKey = localDateKey(now).slice(0, 7); // YYYY-MM
  const productsById = productCostById(products);
  let salesTodayCOP = 0;
  let salesWeekCOP = 0;
  let salesMonthCOP = 0;
  let estimatedProfitCOP = 0;
  let profitEstimateComplete = true;
  for (const o of approvedOrders) {
    const key = localDateKey(o.createdAt);
    const totalCOP = Math.round((o.amountInCents || 0) / 100);
    if (key === todayKey) salesTodayCOP += totalCOP;
    if (key >= weekStartKey) salesWeekCOP += totalCOP;
    if (key.slice(0, 7) === monthKey) salesMonthCOP += totalCOP;
    const { profit, complete } = orderProfit(o, productsById);
    estimatedProfitCOP += profit;
    if (!complete) profitEstimateComplete = false;
  }
  const averageOrderValueCOP = approvedOrders.length ? Math.round(totalSalesCOP / approvedOrders.length) : 0;

  // Customer relationship metrics. A customer exists once they've placed an
  // order; repeat customers are those who've ordered more than once.
  const customers = loadCustomers();
  const totalCustomers = customers.length;
  const newCustomersThisMonth = customers.filter((c) => String(c.createdAt || '').slice(0, 7) === monthKey).length;
  const repeatCustomers = customers.filter((c) => (Number.isInteger(c.totalOrders) ? c.totalOrders : 0) > 1).length;

  // Expense buckets use the same local-day keys as the sales buckets above.
  // Monthly net profit reconciles exactly: sales − product costs − expenses,
  // all for the current month. Product costs are revenue minus estimated
  // profit per order, so the estimate caveat (profitEstimateComplete) applies.
  const expenses = loadExpenses();
  let expensesTodayCOP = 0;
  let expensesWeekCOP = 0;
  let expensesMonthCOP = 0;
  for (const e of expenses) {
    const key = dateKey(e.date);
    const amountCOP = Math.round(Number(e.amountCOP) || 0);
    if (key === todayKey) expensesTodayCOP += amountCOP;
    if (key >= weekStartKey) expensesWeekCOP += amountCOP;
    if (key.slice(0, 7) === monthKey) expensesMonthCOP += amountCOP;
  }
  let productCostsMonthCOP = 0;
  for (const o of approvedOrders) {
    if (localDateKey(o.createdAt).slice(0, 7) !== monthKey) continue;
    const revenue = Math.round((o.amountInCents || 0) / 100);
    const { profit } = orderProfit(o, productsById);
    productCostsMonthCOP += revenue - profit;
  }
  const netProfitCOP = salesMonthCOP - productCostsMonthCOP - expensesMonthCOP;
  const profitMarginPercent =
    salesMonthCOP > 0 ? Math.round((netProfitCOP / salesMonthCOP) * 1000) / 10 : 0;

  res.json({
    totalSalesCOP,
    ordersToday,
    totalOrders: orders.length,
    orderCount: orders.length,
    approvedOrders: approvedOrders.length,
    awaitingShipment,
    totalProducts: products.length,
    lowStockThreshold: LOW_STOCK_THRESHOLD,
    inventoryValueCOP,
    salesTodayCOP,
    salesWeekCOP,
    salesMonthCOP,
    averageOrderValueCOP,
    estimatedProfitCOP,
    profitEstimateComplete,
    totalCustomers,
    newCustomersThisMonth,
    repeatCustomers,
    expensesTodayCOP,
    expensesWeekCOP,
    expensesMonthCOP,
    productCostsMonthCOP,
    netProfitCOP,
    profitMarginPercent,
    lowStock,
  });
});

// ---------- admin: inventory history ----------

app.get('/api/admin/inventory/history', requireAdmin, (req, res) => {
  const history = loadInventoryHistory()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 200);
  res.json(history);
});

// ---------- admin: sales history (business overview) ----------

function salesHistoryEntries(limit) {
  const orders = loadOrders().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const productsById = productCostById(loadProducts());
  return orders.slice(0, limit || 30).map((o) => {
    const { profit, complete } = orderProfit(o, productsById);
    return {
      reference: o.reference,
      createdAt: o.createdAt,
      status: o.status,
      isDemo: Boolean(o.isDemo),
      customerName: o.customer ? o.customer.fullName : null,
      itemCount: (o.items || []).reduce((s, it) => s + (Number.isInteger(it.qty) ? it.qty : 0), 0),
      itemNames: (o.items || []).map((it) => it.name).join(', '),
      totalCOP: Math.round((o.amountInCents || 0) / 100),
      estimatedProfitCOP: profit,
      profitComplete: complete,
      paymentMethod: normalizePaymentMethod(o.paymentMethod),
    };
  });
}

app.get('/api/admin/sales', requireAdmin, (req, res) => {
  res.json({ orders: salesHistoryEntries(30) });
});

// Monthly P&L-style summary export: sales, product costs, expenses and net
// profit for each month that has activity, newest month first.
app.get('/api/admin/sales/export', requireAdmin, (req, res) => {
  const orders = loadOrders();
  const products = loadProducts();
  const productsById = productCostById(products);
  const approvedOrders = orders.filter((o) => o.status === 'APPROVED');

  const monthly = new Map(); // YYYY-MM -> { sales, costs, expenses }
  function bucket(monthKey) {
    if (!monthly.has(monthKey)) monthly.set(monthKey, { sales: 0, costs: 0, expenses: 0 });
    return monthly.get(monthKey);
  }
  for (const o of approvedOrders) {
    const key = localDateKey(o.createdAt).slice(0, 7);
    const b = bucket(key);
    const revenue = Math.round((o.amountInCents || 0) / 100);
    b.sales += revenue;
    const { profit } = orderProfit(o, productsById);
    // Mirrors the dashboard: known costs are revenue minus estimated profit,
    // so the three columns reconcile exactly with net profit.
    b.costs += revenue - profit;
  }
  for (const e of loadExpenses()) {
    const key = dateKey(e.date).slice(0, 7);
    bucket(key).expenses += Math.round(Number(e.amountCOP) || 0);
  }

  const header = ['month', 'salesCOP', 'productCostsCOP', 'expensesCOP', 'netProfitCOP'];
  const rows = Array.from(monthly.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([month, b]) => [
      month,
      b.sales,
      b.costs,
      b.expenses,
      b.sales - b.costs - b.expenses,
    ]);
  const csv = [header, ...rows].map((r) => r.map(csvField).join(',')).join('\r\n');
  const stamp = localDateKey(new Date()).replace(/-/g, '');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="sales-summary-${stamp}.csv"`);
  res.send('\uFEFF' + csv);
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
    { daysAgo: 6, status: 'APPROVED', shippingStatus: 'DELIVERED', items: [[pick(0), 1]], carrier: null, tracking: null, pay: 'wompi' },
    { daysAgo: 4, status: 'APPROVED', shippingStatus: 'SHIPPED', items: [[pick(2), 1], [pick(3), 1]], carrier: null, tracking: null, pay: 'nequi' },
    { daysAgo: 2, status: 'APPROVED', shippingStatus: 'PROCESSING', items: [[pick(5), 1]], carrier: null, tracking: null, pay: 'bank' },
    { daysAgo: 0, status: 'APPROVED', shippingStatus: 'NOT_SHIPPED', items: [[pick(4), 1]], carrier: null, tracking: null, pay: 'cash' },
    { daysAgo: 0, status: 'PENDING', shippingStatus: 'NOT_SHIPPED', items: [[pick(6), 1]], carrier: null, tracking: null, pay: 'wompi' },
    { daysAgo: 1, status: 'DECLINED', shippingStatus: 'NOT_SHIPPED', items: [[pick(1), 1]], carrier: null, tracking: null, pay: 'wompi' },
    { daysAgo: 8, status: 'APPROVED', shippingStatus: 'DELIVERED', items: [[pick(3), 2]], carrier: null, tracking: null, pay: 'nequi' },
    { daysAgo: 3, status: 'APPROVED', shippingStatus: 'PROCESSING', items: [[pick(0), 1], [pick(4), 1]], carrier: null, tracking: null, pay: 'other' },
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
      paymentMethod: plan.pay,
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

// Records how the sale was actually paid (Wompi, Nequi, bank transfer,
// cash, other). Wompi-checkout orders default to 'wompi'; the admin can
// correct this for off-site payments like cash on delivery.
app.patch('/api/admin/orders/:reference/payment', requireAdmin, async (req, res) => {
  const { paymentMethod } = req.body || {};
  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    return res.status(400).json({ error: `paymentMethod must be one of: ${PAYMENT_METHODS.join(', ')}` });
  }

  const orders = loadOrders();
  const idx = orders.findIndex((o) => o.reference === req.params.reference);
  if (idx === -1) return res.status(404).json({ error: 'Order not found.' });

  orders[idx].paymentMethod = paymentMethod;
  orders[idx].updatedAt = new Date().toISOString();
  await saveOrders(orders);
  await auditLog({ action: 'payment_update', reference: req.params.reference, ip: req.ip, paymentMethod });
  res.json(orders[idx]);
});

// Soft-delete: the order moves to the trash (same "Recently Deleted"
// system used for products) and can be restored until it's cleared.
// The admin UI requires the user to confirm before sending this request.
app.delete('/api/admin/orders/:reference', requireAdmin, async (req, res) => {
  const orders = loadOrders();
  const idx = orders.findIndex((o) => o.reference === req.params.reference);
  if (idx === -1) return res.status(404).json({ error: 'Order not found.' });

  const [removed] = orders.splice(idx, 1);
  await saveOrders(orders);

  const trash = loadTrash();
  trash.push({
    id: genTrashId(),
    type: 'order',
    deletedAt: new Date().toISOString(),
    orderReference: removed.reference,
    customerName: removed.customer && removed.customer.fullName,
    order: removed,
    files: [],
  });
  await saveTrash(trash);

  await auditLog({ action: 'order_trashed', reference: req.params.reference, ip: req.ip, customerEmail: removed.customer && removed.customer.email });
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

  const brandName = (loadSettings().storeName || 'The Good Shelf').trim() || 'The Good Shelf';

  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: order.customer.email,
      subject: `Tu recibo de ${brandName} — pedido ${order.reference}`,
      html: renderReceiptHTML(order),
    });
    await auditLog({ action: 'receipt_emailed', reference: order.reference, to: order.customer.email, ip: req.ip });
    res.json({ ok: true });
  } catch (err) {
    console.error(`POST /api/admin/orders/${req.params.reference}/send-receipt failed:`, err);
    res.status(500).json({ error: 'Could not send the email. Check your SMTP settings in .env.' });
  }
});

// ---------- admin: customers (CRM) ----------

// Customer list, most recent activity first. Uses the stored totals (fast);
// the per-customer detail endpoint recomputes from the actual orders.
app.get('/api/admin/customers', requireAdmin, (req, res) => {
  const customers = loadCustomers().slice().sort((a, b) => new Date(b.lastOrderAt || 0) - new Date(a.lastOrderAt || 0));
  res.json(customers);
});

function csvField(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Registered before the /:id route so "export" isn't swallowed as an id.
// GET requests pass the auth cookie like any other admin page, so the admin
// UI can just link to it. BOM + CRLF keep Excel happy on Windows.
app.get('/api/admin/customers/export', requireAdmin, (req, res) => {
  const customers = loadCustomers().slice().sort((a, b) => new Date(b.lastOrderAt || 0) - new Date(a.lastOrderAt || 0));
  const header = ['id', 'name', 'phone', 'email', 'city', 'totalOrders', 'totalSpentCOP', 'lastOrderAt', 'createdAt'];
  const rows = customers.map((c) => [
    c.id, c.name, c.phone, c.email, c.city,
    Number.isInteger(c.totalOrders) ? c.totalOrders : 0,
    Number.isInteger(c.totalSpentCOP) ? c.totalSpentCOP : 0,
    c.lastOrderAt, c.createdAt,
  ]);
  const csv = [header, ...rows].map((r) => r.map(csvField).join(',')).join('\r\n');
  const stamp = localDateKey(new Date()).replace(/-/g, '');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="customers-${stamp}.csv"`);
  res.send('\uFEFF' + csv);
});

// Customer profile + their full order history + recomputed totals.
app.get('/api/admin/customers/:id', requireAdmin, (req, res) => {
  const customers = loadCustomers();
  const customer = customers.find((c) => c.id === req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found.' });

  const orders = customerOrders(customer);
  const totalSpentCOP = orders.reduce((sum, o) => sum + Math.round((o.amountInCents || 0) / 100), 0);
  const lastOrderAt = orders.length ? orders[0].createdAt : customer.lastOrderAt;

  res.json({
    customer,
    orders: orders.map((o) => ({
      reference: o.reference,
      createdAt: o.createdAt,
      status: o.status,
      isDemo: Boolean(o.isDemo),
      items: (o.items || []).map((it) => ({ name: it.name, qty: it.qty, price: it.price })),
      amountInCents: o.amountInCents,
      paymentMethod: normalizePaymentMethod(o.paymentMethod),
    })),
    totals: {
      totalOrders: orders.length,
      totalSpentCOP,
      avgOrderValueCOP: orders.length ? Math.round(totalSpentCOP / orders.length) : 0,
      lastOrderAt,
    },
  });
});

// ---------- admin: expenses (finance / bookkeeping) ----------

// A cost price (product price) is a floor for what an expense could be,
// but expenses like rent or salaries aren't tied to products at all, so
// there's no shared price lookup here — amounts are entered by hand in COP.

function validateExpenseInput(body, opts) {
  opts = opts || {};
  const errors = [];
  const out = {};
  function check(field, val, ok, msg) {
    if (val === undefined) {
      if (!opts.partial) errors.push(`${field} is required.`);
      return;
    }
    if (!ok) errors.push(msg);
    else out[field] = val;
  }
  check('date', body.date, /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')), 'date must be a YYYY-MM-DD string.');
  check('category', body.category, EXPENSE_CATEGORIES.includes(body.category), 'category is invalid.');
  check('description', body.description, typeof body.description === 'string' && body.description.trim().length <= 200, 'description must be 200 characters or fewer.');
  check('amountCOP', body.amountCOP, Number.isInteger(body.amountCOP) && body.amountCOP > 0 && body.amountCOP <= 1000000000, 'amountCOP must be a positive whole number.');
  check('paymentMethod', body.paymentMethod, EXPENSE_PAYMENT_METHODS.includes(body.paymentMethod), 'paymentMethod is invalid.');
  if (out.description !== undefined) out.description = String(out.description).trim();
  return { errors, out };
}

app.get('/api/admin/expenses', requireAdmin, (req, res) => {
  const expenses = loadExpenses().slice().sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  res.json(expenses);
});

function expenseToCsvRow(e) {
  return [
    e.id, e.date, e.category, e.description, e.amountCOP, e.paymentMethod, e.createdAt,
  ];
}

// Registered before the /:id route so "export" isn't swallowed as an id.
// GET requests pass the auth cookie like any other admin page, so the admin
// UI can just link to it. BOM + CRLF keep Excel happy on Windows.
app.get('/api/admin/expenses/export', requireAdmin, (req, res) => {
  const expenses = loadExpenses().slice().sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  const header = ['id', 'date', 'category', 'description', 'amountCOP', 'paymentMethod', 'createdAt'];
  const rows = expenses.map(expenseToCsvRow);
  const csv = [header, ...rows].map((r) => r.map(csvField).join(',')).join('\r\n');
  const stamp = localDateKey(new Date()).replace(/-/g, '');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="expenses-${stamp}.csv"`);
  res.send('\uFEFF' + csv);
});

app.post('/api/admin/expenses', requireAdmin, (req, res) => {
  const { errors, out } = validateExpenseInput(req.body || {});
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });
  const expenses = loadExpenses();
  const expense = Object.assign({}, out, {
    id: crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(36).slice(2)),
    createdAt: new Date().toISOString(),
  });
  expenses.push(expense);
  saveExpenses(expenses);
  auditLog({ action: 'expense.create', detail: `${expense.category} $${expense.amountCOP} ${expense.date}` });
  res.status(201).json(expense);
});

app.put('/api/admin/expenses/:id', requireAdmin, (req, res) => {
  const expenses = loadExpenses();
  const idx = expenses.findIndex((e) => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Expense not found.' });
  const { errors, out } = validateExpenseInput(req.body || {}, { partial: true });
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });
  const expense = Object.assign({}, expenses[idx], out);
  expenses[idx] = expense;
  saveExpenses(expenses);
  auditLog({ action: 'expense.update', detail: `${expense.category} $${expense.amountCOP} ${expense.date}` });
  res.json(expense);
});

app.delete('/api/admin/expenses/:id', requireAdmin, (req, res) => {
  const expenses = loadExpenses();
  const idx = expenses.findIndex((e) => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Expense not found.' });
  const [removed] = expenses.splice(idx, 1);
  saveExpenses(expenses);
  auditLog({ action: 'expense.delete', detail: `${removed.category} $${removed.amountCOP} ${removed.date}` });
  res.json({ ok: true });
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

  // Inventory fields (SKU, supplier, cost price, min stock) are all
  // optional, so existing catalogs keep working untouched. An empty value
  // is stored as null (unknown); costPrice/minStock are integers or null.
  function optionalText(field, max, label) {
    if (body[field] === undefined) return;
    if (typeof body[field] !== 'string' || body[field].length > max) {
      errors.push(`${label} must be under ${max} characters.`);
    } else {
      out[field] = body[field].trim() || null;
    }
  }
  optionalText('sku', 60, 'SKU');
  optionalText('supplier', 100, 'supplier');

  function optionalInt(field, max, label) {
    if (body[field] === undefined) return;
    if (body[field] === null || body[field] === '') {
      out[field] = null;
    } else if (!Number.isInteger(body[field]) || body[field] < 0 || body[field] > max) {
      errors.push(`${label} must be a whole number, 0 or greater.`);
    } else {
      out[field] = body[field];
    }
  }
  optionalInt('costPrice', 500000000, 'cost price');
  optionalInt('minStock', 1000000, 'minimum stock');

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
  const product = { id: nextId, tag: out.tag.trim(), name: out.name.trim(), desc: out.desc, images: out.images, price: out.price, stock: out.stock, size: out.size !== undefined ? out.size : null, sku: out.sku !== undefined ? out.sku : null, costPrice: out.costPrice !== undefined ? out.costPrice : null, supplier: out.supplier !== undefined ? out.supplier : null, minStock: out.minStock !== undefined ? out.minStock : null };
  products.push(product);
  await saveProducts(products);
  if (Number.isInteger(product.stock) && product.stock > 0) {
    await logInventoryChange({ productId: product.id, productName: product.name, delta: product.stock, newStock: product.stock, reason: 'initial', ip: req.ip });
  }
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

  const prevStock = Number.isInteger(products[idx].stock) ? products[idx].stock : 0;
  products[idx] = Object.assign({}, products[idx], out);
  const newStock = Number.isInteger(products[idx].stock) ? products[idx].stock : 0;
  if (newStock !== prevStock) {
    const reason = (req.body && typeof req.body.stockChangeReason === 'string' && req.body.stockChangeReason.trim())
      ? req.body.stockChangeReason.trim().slice(0, 40)
      : 'adjustment';
    await logInventoryChange({
      productId: id,
      productName: products[idx].name,
      delta: newStock - prevStock,
      newStock,
      reason,
      ip: req.ip,
    });
  }
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
    if (Number.isInteger(restored.stock) && restored.stock > 0) {
      await logInventoryChange({
        productId: restored.id,
        productName: restored.name,
        delta: restored.stock,
        newStock: restored.stock,
        reason: 'restore',
        ip: req.ip,
      });
    }
    trash.splice(idx, 1);
    await saveTrash(trash);
    await auditLog({ action: 'trash_restore_product', productId: restored.id, ip: req.ip });
    return res.json({ ok: true, type: 'product', product: restored });
  }

  if (entry.type === 'order') {
    const orders = loadOrders();
    const refExists = orders.some((o) => o.reference === entry.order.reference);
    const restored = refExists ? Object.assign({}, entry.order, { reference: genReference() }) : entry.order;
    orders.push(restored);
    await saveOrders(orders);
    trash.splice(idx, 1);
    await saveTrash(trash);
    await auditLog({ action: 'trash_restore_order', reference: restored.reference, ip: req.ip });
    return res.json({ ok: true, type: 'order', order: restored });
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

// Body may include { types: ['product','image'] } or { types: ['order'] }
// to empty just that bin. Omitting types (or sending an empty array)
// empties everything, for backward compatibility.
app.post('/api/admin/trash/empty', requireAdmin, async (req, res) => {
  const types = Array.isArray(req.body && req.body.types) && req.body.types.length ? req.body.types : null;
  const count = await purgeTrash(types);
  await auditLog({ action: 'trash_emptied_manually', count, types: types || 'all', ip: req.ip });
  res.json({ ok: true, count });
});

// ---------- store settings API ----------

// Public platform identity (MiTienda by COLHQ) — used by the admin panel to
// brand its login/header, and by the storefront if it wants to show credit.
// Public like /api/settings: it's just brand metadata.
app.get('/api/platform', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(loadPlatform());
});

// Public storefront settings (branding, theme, copy) — this is what the
// storefront fetches to render itself. No auth: it's intentionally public.
app.get('/api/settings', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(publicSettings(loadSettings()));
});

// Full settings for the admin editor (saved values merged over defaults so
// brand-new settings keys show their default instead of a blank).
app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json(loadSettingsMerged());
});

// Save settings. Validated server-side; invalid input is rejected with a
// clear message before anything is written.
app.put('/api/admin/settings', requireAdmin, async (req, res) => {
  const { error, value } = validateSettings(req.body);
  if (error) return res.status(400).json({ error });
  await saveSettings(value);
  await auditLog({ action: 'settings_update', ip: req.ip });
  res.json({ ok: true, settings: publicSettings(value) });
});

// Restore the out-of-the-box defaults from settings.example.json.
app.post('/api/admin/settings/reset', requireAdmin, async (req, res) => {
  const defaults = deepClone(DEFAULT_SETTINGS);
  await saveSettings(defaults);
  await auditLog({ action: 'settings_reset', ip: req.ip });
  res.json({ ok: true, settings: publicSettings(defaults) });
});

// ---------- first-run store setup ----------

// Whether the current store has finished its first-run setup wizard. The
// admin front end checks this after login to decide between showing the
// wizard and showing the normal panel. Stores that predate the setup flow
// report completed:false and get walked through the wizard once.
app.get('/api/admin/setup-status', requireAdmin, (req, res) => {
  const settings = loadSettings();
  res.json({ completed: settings.setupCompleted === true, storeId: getStoreId(settings) });
});

// Complete the first-run wizard: saves store name, business category, theme,
// contact info, and payment preference, then marks the store as set up.
// Only the wizard fields are touched — the rest of the store's settings
// (catalog copy, footer, existing social links, etc.) are left intact.
app.post('/api/admin/setup', requireAdmin, async (req, res) => {
  const err400 = (msg) => res.status(400).json({ error: msg });
  const body = req.body || {};
  const str = (v, label, max) => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string') return err400(label + ' must be text.');
    const s = v.trim();
    if (s.length > max) return err400(label + ' is too long (max ' + max + ' characters).');
    return s;
  };

  const storeName = str(body.storeName, 'Store name', 60);
  if (!storeName) return err400('Store name is required.');

  if (body.businessType !== undefined && body.businessType !== null && !BUSINESS_TYPES.includes(body.businessType)) {
    return err400('businessType must be one of: ' + BUSINESS_TYPES.join(', ') + '.');
  }
  if (body.paymentPreference !== undefined && !PAYMENT_PREFERENCES.includes(body.paymentPreference)) {
    return err400('paymentPreference must be one of: ' + PAYMENT_PREFERENCES.join(', ') + '.');
  }
  if (body.defaultLang !== undefined && body.defaultLang !== 'en' && body.defaultLang !== 'es') {
    return err400('defaultLang must be "en" or "es".');
  }

  const whatsappNumber = str(body.whatsapp, 'WhatsApp number', 20);
  if (whatsappNumber && !PHONE_RE.test(whatsappNumber)) {
    return err400('WhatsApp number must contain only digits (plus an optional leading +).');
  }
  const instagram = str(body.instagram, 'Instagram', 300);
  const storeId = body.storeId !== undefined ? str(body.storeId, 'Store ID', STORE_ID_MAX) : null;
  if (storeId && !STORE_ID_RE.test(storeId)) {
    return err400('Store ID must be lowercase letters, numbers, and hyphens only.');
  }

  const value = Object.assign(deepClone(DEFAULT_SETTINGS), loadSettings());
  value.storeName = storeName;
  value.storeId = (storeId && STORE_ID_RE.test(storeId)) ? storeId : slugifyStoreName(storeName);
  value.businessType = body.businessType !== undefined ? (body.businessType || null) : value.businessType;
  value.paymentPreference = body.paymentPreference !== undefined ? body.paymentPreference : value.paymentPreference;
  if (body.defaultLang !== undefined) value.defaultLang = body.defaultLang;
  if (body.whatsapp !== undefined) value.whatsapp.number = whatsappNumber || null;
  if (body.instagram !== undefined) value.socialLinks.instagram = instagram || null;
  if (body.theme) {
    const themeErr = applyThemeField(value, body.theme);
    if (themeErr) return err400(themeErr);
  }
  value.setupCompleted = true;

  await saveStoreSettings(value);
  await auditLog({ action: 'setup_completed', storeId: value.storeId, ip: req.ip });
  res.json({ ok: true, settings: publicSettings(value) });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, env: APP_ENV, missingEnv });
});

const PORT = process.env.PORT || 3000;
// Populate the CRM from existing order history on first run (idempotent).
backfillCustomersFromOrders().catch((err) => console.error('customer backfill failed:', err));
app.listen(PORT, () => {
  console.log(`${loadPlatform().displayName} server running on port ${PORT} [${APP_ENV}]`);
});
