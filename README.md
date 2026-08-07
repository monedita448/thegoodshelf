# MiTienda by COLHQ

A resellable ecommerce platform for Colombian online stores — no Shopify, no third-party store platform. **The Good Shelf is the demo store** this template ships with: a working example store you can keep or replace entirely. The platform itself is a static front end (`index.html`), a password-protected admin panel (`admin.html`), and a small Node/Express backend (`server.js`) that you fully control. Real checkout via [Wompi](https://wompi.co): PSE (bank transfer), Nequi, and cards, all in COP. Built to be resold: the only thing that should need to change per client is cosmetics (branding, colors, copy, product catalog) — everything else, including the admin panel, works out of the box.

## What's included

- **Storefront** — product grid with search/filter/sort, cart, sold-out/low-stock badges, a full product detail view (click any product for a bigger photo gallery, description, quantity picker, and Add to Cart), Wompi checkout that collects a shipping address, and an English/Spanish toggle (flag icons) in the top nav.
- **Admin panel** (`/admin`) — password login, a dashboard (sales, orders today, low stock), full product management (multiple photos per product with drag-to-reorder and a click-to-expand viewer, inventory/stock tracking, an optional size field, add/edit/delete, category suggestions as you type), order management (shipping status, tracking, carrier, a one-click "Message on WhatsApp" button, and a printable receipt you can also email to the customer in one click), Recently Deleted lists for both products and orders so deletes are recoverable for 30 days, and an English/Spanish toggle (flag icons, top right). No coding required to run day to day.
- **Security** — session-based login (not a token in a URL), rate-limited login attempts, CSRF protection, security headers, an audit log of every admin action, and sensitive files (`.env`, `orders.json`, `server.js`, etc.) are never servable over HTTP. See "Security" below for the full list.

## How it works

- `products.json` is the catalog. The storefront fetches it to render the shop; the backend re-reads it on every order so a customer can never pay less than the real price. Edit it through `/admin` — you should never need to hand-edit the file.
- Checkout collects contact info and a shipping address, creates a `PENDING` order, cryptographically signs it, and redirects the customer to Wompi's own hosted payment page — your server never touches card numbers or bank credentials.
- Wompi calls `/api/webhook/wompi` when a payment finishes. That webhook is signature-verified, so it's the authoritative record of whether an order was actually paid.
- Once an order is paid, you (or your client) update its shipping status through `/admin` — `NOT_SHIPPED` → `PROCESSING` → `SHIPPED` → `DELIVERED`, plus a tracking number and carrier name. There's no courier API integration — you look up tracking on the carrier's own site and relay status manually.
- Every product has a `stock` count. Checkout blocks anyone from buying more than what's on hand, reserves stock the moment an order is placed, and automatically puts it back if the payment later gets declined or voided.
- Deleting a product, removing one of its photos, or deleting an order doesn't destroy it right away — it moves to a **Recently Deleted** list (products/photos at the bottom of the Products page, orders at the bottom of the Orders page), recoverable for 30 days after deletion, after which it clears itself automatically (or empty either list manually at any time).
- Each order has a **Message on WhatsApp** button. It opens a chat in the admin's own WhatsApp (app or Web) with the customer's number and a short greeting already filled in — no API keys, no setup, nothing that can break. The admin sends photos, tracking info, whatever, from inside their normal WhatsApp exactly like they would with any other contact.
- Every order also has a **receipt** — viewable/printable in a new tab (save as PDF with the browser's own print dialog) and, if `SMTP_*` is set in `.env`, a one-click **Email receipt to customer** button that sends the same receipt straight to their inbox.
- `orders.json`, `admin_audit.json`, and `trash.json` are flat files. All are git-ignored so real customer data and admin activity logs never end up in your repo.

## 1. Get Wompi sandbox keys (free, ~5 minutes)

1. Go to [comercios.wompi.co](https://comercios.wompi.co) and create an account.
2. In the dashboard, open **Developers → Secrets for technical integration**.
3. Copy your **sandbox** public key (`pub_test_...`), integrity secret (`test_integrity_...`), and events secret (`test_events_...`).
4. Set your **Events URL** for the sandbox environment to `https://<your-deployed-url>/api/webhook/wompi` once you've deployed (step 4).

## 2. Run it locally

```bash
cp .env.example .env
# paste your Wompi sandbox keys in, and set ADMIN_TOKEN + SESSION_SECRET to real random values
npm install
npm start
```

- Storefront: `http://localhost:3000`
- Admin panel: `http://localhost:3000/admin` — log in with whatever you set `ADMIN_TOKEN` to.

Try the whole loop: log into `/admin`, add a product, open the storefront and confirm it appears, add it to a cart, and checkout — you'll land on Wompi's real sandbox payment page. Use their [test data](https://docs.wompi.co/en/docs/colombia/datos-de-prueba-en-sandbox/) (e.g. financial institution "Banco que aprueba") to simulate an approved PSE payment. Then go back to `/admin`'s Orders tab and mark it shipped.

Local webhooks need a public URL — use [ngrok](https://ngrok.com) (`ngrok http 3000`) and set that as your sandbox Events URL if you want to test the webhook end to end before deploying.

## 3. Deploy

Any Node host works (Render, Railway, Fly.io, a VPS).

**Important — persistent disk required.** `products.json`, `orders.json`, `admin_audit.json`, `trash.json`, and the `images/`/`trash/` folders are all plain files/folders the server writes to directly. Some hosting free tiers (notably Render's free web service tier) wipe the filesystem on every restart/redeploy, which would silently erase products, orders, and uploaded photos. Before picking a host, confirm it gives you a persistent disk:
- **Railway** — persists by default on a standard service. Simplest option.
- **Render** — needs their paid "Persistent Disk" add-on attached to the service; the free tier alone is not safe for this.
- **A basic VPS** (Droplet, Lightsail, etc.) — persists naturally, more setup work.

Quick path with Railway or Render (paid disk):

1. Push this repo to GitHub.
2. Connect the repo as a new Web Service.
3. Build command: `npm install`. Start command: `npm start`.
4. Add every variable from `.env.example` with real values. Set `SITE_URL` to the URL your host gives you.
5. Once deployed, set the **production** Events URL in Wompi's dashboard to `https://<your-url>/api/webhook/wompi`.

## 4. Going live (real money)

- In the Wompi dashboard, complete their merchant verification (cédula/NIT + a Colombian bank account for payouts — only doable by the store owner, since it's tied to their identity).
- Swap the sandbox Wompi keys for the `pub_prod_` / `prod_integrity_` / `prod_events_` keys, and set `APP_ENV=production`.
- Set real prices through `/admin` before announcing the store.
- Wompi takes a percentage fee per transaction (check current pricing on the dashboard) and pays out on their normal schedule.

## 5. Messaging customers on WhatsApp

No setup needed. Each order in `/admin` has a **Message on WhatsApp** button — it opens a chat in the admin's own WhatsApp (app or Web, whichever the browser/device defaults to) with the customer's number and a short greeting pre-filled. From there the admin sends photos, tracking updates, whatever they'd normally send a contact — it's just their regular WhatsApp, nothing routes through this server. If a customer's phone number was entered as a plain 10-digit Colombian mobile number (no country code), the button assumes `+57` automatically.

## 6. Emailing receipts (optional)

Viewing/printing a receipt from `/admin` always works, no setup needed. To also let the admin send it straight to the customer's inbox with one click, add SMTP credentials to `.env`. The easiest free option is a Gmail account with an "app password":

1. Go to your Google Account → **Security** → turn on **2-Step Verification** (if not already on).
2. Under 2-Step Verification, open **App passwords**, generate one for "Mail".
3. In `.env`, set:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_USER=youraddress@gmail.com
   SMTP_PASS=the16charapppassword
   SMTP_FROM=The Good Shelf <youraddress@gmail.com>
   ```
4. Restart the server. The "Email receipt to customer" button in an order's Manage panel will now actually send.

Any other SMTP provider (Brevo, Resend, Mailgun, etc.) works the same way — just swap in the host/port/username/password they give you. If `SMTP_*` isn't set, the button shows a clear error instead of failing silently, and the view/print link keeps working regardless.

## 7. Platform owner dashboard (COLHQ staff only)

Two different logins exist, and they must never be confused:

- **Store admin** (`/admin`) — the individual store owner manages *their own* store (products, orders, customers, finance, settings). Logged in with `ADMIN_TOKEN`.
- **Platform owner** (`/platform-admin`) — **COLHQ/MiTienda staff** manage the platform: every store on it, its owner, plan, status, and trial. Logged in with `PLATFORM_ADMIN_TOKEN`, which is a **separate** environment variable. A store-admin session **never** grants platform access, and the platform dashboard never inherits a store's name, theme, or logo — it's always branded "MiTienda by COLHQ".

### Platform owner features (Phase F1)

- Dashboard metrics: total / active / trial / suspended stores, new this month, and an estimated MRR (provisional placeholder derived from internal plan pricing — **no real billing yet**).
- Store registry: list all stores, view a store's full record (owner/contact, business type, plan, status, trial expiration, subscription status, created/last-activity dates).
- Platform-only actions: **Activate**, **Suspend**, **Change plan**, **Extend trial** — every one is audit-logged.
- Add a new store record to the platform registry.

### Platform data & API

- `platform_stores.json` — git-ignored runtime file holding the platform's store registry (one record per store: `id, storeName, ownerName, ownerEmail, whatsapp, businessType, plan, status, trialEndsAt, subscriptionStatus, createdAt, updatedAt, lastActivityAt`). Allowed `plan`: `trial|basic|pro|enterprise`; allowed `status`: `active|trial|suspended|cancelled`; allowed `subscriptionStatus`: `none|trial|active|past_due|cancelled`. It's separate from each store's own `settings.json`/`products.json`/`orders.json` and is never served to the storefront or store admin.
- All platform routes live under `/api/platform/admin/*` and require platform authentication (`requirePlatformAdmin`, its own session cookie + CSRF header value):
  - `POST /api/platform/admin/login` · `POST /api/platform/admin/logout` · `GET /api/platform/admin/session`
  - `GET /api/platform/admin/dashboard`
  - `GET /api/platform/admin/stores` · `GET /api/platform/admin/stores/:id`
  - `POST /api/platform/admin/stores`
  - `PUT /api/platform/admin/stores/:id`
  - `PATCH /api/platform/admin/stores/:id/status`
- To use it locally: set `PLATFORM_ADMIN_TOKEN` in `.env` (see `.env.example`), then open `http://localhost:3000/platform-admin`.

### Intentionally not implemented (yet)

No real subscription billing, no "login as store", no store deletion, and no multi-store routing/tenancy — the app still runs as a single-store platform. The platform registry is the foundation those features will build on.

## Security

Built with the assumption that this will be deployed for real clients handling real customer data, so the admin panel takes reasonable precautions:

- **Session-based login**, not a password in a URL. Sessions are signed, `httpOnly` cookies (invisible to JavaScript, so they can't be stolen via XSS) and expire after 12 hours.
- **Rate-limited login** — 8 attempts per 15 minutes per IP address, to blunt password-guessing.
- **CSRF protection** — every state-changing admin request must carry a custom header that cross-site requests can't attach, on top of a `SameSite=Strict` cookie.
- **Security headers** via `helmet`, including a Content-Security-Policy restricting where scripts/styles/frames can load from.
- **Audit log** (`admin_audit.json`) — every login attempt, product change, and shipping update is recorded with a timestamp and IP.
- **No sensitive files are ever web-servable** — `.env`, `orders.json`, `admin_audit.json`, `server.js`, `package.json` are all outside the reachable static paths, verified by request (not just by convention).
- **Server-side price validation** — the client never dictates what something costs; `priceCart()` recomputes every total from `products.json` on the server.

What this setup deliberately doesn't include: multi-user accounts/roles (one shared admin password per store), 2FA, and a hosted database (it's flat JSON files — see the persistent-disk note above). If a client needs any of those, they're the natural next upgrades.

**Before selling this to a client:** make sure they set their own strong, unique `ADMIN_TOKEN` and `SESSION_SECRET` — don't ship a site with default or shared credentials.

## Reusing this for a new client

1. Duplicate the project (new repo, new deploy).
2. Update branding/copy in `index.html` (store name, hero text, colors in the `:root` CSS variables).
3. Clear out `products.json` (or leave it as a starting example) — the client fills in their own catalog through `/admin`.
4. Set up their own Wompi account and env vars (each client needs their own Wompi merchant account — payouts go to their bank, not yours). If they want the email-receipt button working, also set their own `SMTP_*` vars (see "Emailing receipts" above) — otherwise leave blank and the button just won't be offered as working until they add it.
5. Give the client their `/admin` URL and password.

## What needs backend setup, per client

Everything below works out of the box with zero configuration, except the two marked **(needs setup)**:

| Feature | Needs an account/keys? |
|---|---|
| Storefront (browse, search, cart, product detail) | No |
| Admin login | No — just set `ADMIN_TOKEN`/`SESSION_SECRET` to your own values, no external account |
| Product photos, stock, trash/undo | No — stored on the server's own disk |
| Language toggle (EN/ES) | No |
| Category suggestions | No |
| WhatsApp messaging | No — opens the admin's own WhatsApp, no API |
| View/print a receipt | No |
| **Checkout / accepting payments** | **Yes — Wompi merchant account** (free to get sandbox keys; real payouts require merchant verification with a Colombian bank account, see "Going live") |
| **Emailing receipts to customers** | **Yes — SMTP credentials** (optional; a free Gmail app password works, see "Emailing receipts" above) |

So per new client, the only things that ever need setting up are: their own `ADMIN_TOKEN`/`SESSION_SECRET` (always), their own Wompi account (always, for real checkout), and SMTP (only if they want the one-click email-receipt button).

## Files

- `index.html` — the storefront
- `admin.html` — the store owner's admin panel (dashboard, products, orders + shipping + WhatsApp, trash)
- `platform-admin.html` — the platform owner dashboard (COLHQ staff only, separate login)
- `products.json` — product catalog: photos, prices in COP, stock
- `server.js` — backend: checkout, Wompi signing + webhook verification, admin auth, product/order APIs, trash
- `orders.json` — order log (auto-created, git-ignored)
- `admin_audit.json` — admin action log (auto-created, git-ignored)
- `trash.json` / `trash/` — recoverable deletes (auto-created, git-ignored)
- `platform_stores.json` — platform store registry (auto-created, git-ignored)
- `.env` — your secrets (git-ignored, never commit this)
