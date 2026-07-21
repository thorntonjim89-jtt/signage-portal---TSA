# Signage Portal

A client portal for a signage company: clients submit quote requests, the team
prices them directly or pulls in supplier pricing, clients accept or decline,
and accepted quotes become projects with a 7-stage timeline, photo updates,
and a Q&A thread.

Three login roles: **client**, **team**, **supplier**. Supplier cost prices
and the markup applied on top are internal-only — see "How pricing stays
private" below.

## Stack

- Static HTML/CSS/vanilla JS frontend (`public/`) — no build step.
- Netlify Functions backend (`netlify/functions/`), Node.js.
- Postgres via [Netlify DB](https://docs.netlify.com/database/get-started/) (Neon under the hood).
- File storage (photos, quote documents, issue photos) lives directly in
  Postgres as `BYTEA` columns rather than Netlify Blobs — see "Why files are
  stored in Postgres" below.
- Auth: email/password with bcrypt, JWT session cookie (httpOnly).

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Set up a database

You need a Postgres connection string. Either:

**Use Netlify DB (recommended for deploying to Netlify):**

```bash
npx netlify login
npx netlify link      # or `netlify init` if you haven't created a site yet
npx netlify db init   # provisions a Netlify DB (Neon) and links it to your site
```

This automatically sets `NETLIFY_DATABASE_URL` for your site — you don't need
to put it in `.env` yourself when running `netlify dev` against a linked site.

**Or use any Postgres database for local development:**

Copy `.env.example` to `.env` and set `DATABASE_URL` to your connection
string, plus a `JWT_SECRET` (generate one with the command in the file).

### 3. Run the schema

```bash
psql "$DATABASE_URL" -f schema.sql
```

(or `npm run db:migrate` if `DATABASE_URL` is exported in your shell). This
creates all tables. Team/staff accounts aren't self-registered, so you'll
need to insert at least one manually — generate a bcrypt hash of a real
password:

```bash
node -e "console.log(require('bcryptjs').hashSync('your-password', 10))"
```

then run:

```sql
INSERT INTO users (email, password_hash, name, role)
VALUES ('you@example.com', '<hash from above>', 'Your Name', 'team');
```

Client and supplier accounts are created via the "Create Account" tab on the
login page.

### 4. Run it locally

```bash
npx netlify dev
```

Opens the app at `http://localhost:8888`, serving the static frontend and
proxying `/api/*` to the Netlify Functions in `netlify/functions/`.

> **Note on restricted-network environments:** `netlify dev` normally routes
> requests through an edge-function layer that fetches a small bootstrap
> script from `edge.netlify.com` on first request. If your network blocks
> that host, `netlify dev` will crash with a `Download failed with status
> code 403` error. Everything in this app runs fine without that layer — you
> can work around it with the CLI's internal flag:
> `netlify dev --internal-disable-edge-functions`.

### 5. Deploy

```bash
npx netlify deploy --prod
```

Make sure your Netlify site has `NETLIFY_DATABASE_URL` (via `netlify db
init`) and a `JWT_SECRET` environment variable set (Site configuration →
Environment variables) before deploying.

## How the quote pipeline works

1. **Client** submits a quote request (title, description, quantity).
2. **Team** either prices it directly, or requests a cost price from a
   **supplier** (`POST /api/supplier-requests`). The supplier submits a cost
   price and notes.
3. **Team** sets the client-facing price by entering a cost and a markup
   percentage (`PATCH /api/quotes/:id` with `action: "price"`); the server
   computes `client_price = cost * (1 + markup / 100)`.
4. **Client** accepts or declines the priced quote.
5. **Team** converts an accepted quote into a **project**
   (`POST /api/projects`), which seeds a 6-stage timeline: Order Confirmed →
   Design & Proofing → Client Approval → Production → Shipping →
   Installed & Complete.
6. Team advances stages, uploads progress photos, and both team and client
   can post to a per-project Q&A thread.

## Why files are stored in Postgres

Photos, quote documents, and issue photos are stored as `BYTEA` columns
directly in Postgres (`photos.file_data`, `quote_attachments.file_data`,
`project_issues.file_data`), not in Netlify Blobs. This wasn't the original
design — Netlify Blobs is the more obvious fit and is what this app used
initially — but in production `getStore()` reliably threw
`MissingBlobsEnvironmentError` regardless of a fresh deploy or dependency
bump, which pointed to a platform-side provisioning issue for that
particular site rather than anything fixable in code. Since every other
part of the app already depends on the same Postgres database working
correctly, storing file bytes there directly removes an entire external
dependency and its failure modes. Files are capped at 8MB and served back
out through their own streaming endpoint (`photo-file.js`, `quote-file.js`,
`project-issue-file.js`) rather than being embedded in list responses.

## How pricing stays private

A supplier's cost price and the markup applied on top of it must never reach
the client role. This is enforced in two places:

- **`netlify/functions/quotes.js`** — `sanitizeQuote()` is a field
  *whitelist*, not a blacklist: it explicitly lists which columns each role
  may see. The client's view includes only `client_price`; `internal_cost`
  and `internal_markup_percent` are only ever added to the response object
  when `role === 'team'`. A new column added later is excluded by default
  instead of leaking until someone remembers to blacklist it.
- **`netlify/functions/supplier-requests.js`** — where `cost_price` actually
  lives — rejects the `client` role outright at the top of the handler,
  before any query runs. Suppliers only ever see their own cost price, never
  another supplier's.

## Project structure

```
netlify/functions/        Serverless API (one file per resource)
  utils/db.js              Postgres connection pool
  utils/auth.js            JWT cookie session helpers
  auth-register.js         Client/supplier self-registration
  auth-login.js            Login, issues session cookie
  auth-logout.js
  me.js                     Current user
  quotes.js                 Quote CRUD, pricing, accept/decline
  supplier-requests.js       Supplier pricing requests (cost prices live here)
  projects.js                Quote→project conversion, 7-stage timeline
  photos.js / photo-file.js  Photo upload (stored in Postgres) and streaming
  qna.js                      Per-project Q&A thread
public/                    Static frontend (no build step)
  index.html                Login / register
  client/, team/, supplier/  Role-specific dashboards and detail pages
schema.sql                 Postgres schema + seed team account
```

## Known limitations / possible future work

- **No email notifications.** Registration, quote pricing, stage updates, and
  new Q&A messages don't trigger any email — the app is purely in-app/UI
  driven right now. Adding email (e.g. via Resend or Postmark) for things
  like "your quote has been priced" or a welcome message on signup would be
  a natural next feature.
