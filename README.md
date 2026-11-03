# YYC Brokers — Node.js application

A runnable standalone version of the YYC screens, preserving the supplied logo and navy, red, silver and subtle champagne-gold theme.

This is a **pilot starter**, not the complete approved production platform. Its core account and delivery workflow uses a real Node.js backend and persistent SQLite records. The separate `/demo/` route retains the fictional screen prototype.

## Requirements

- Node.js **24 or later**. Tested with Node **24.22.1**.
- A terminal and web browser.
- No npm dependencies, native database addon, build step or internet connection is needed to run the local application. SQLite uses Node's built-in `node:sqlite` API. Some Node versions may display an experimental SQLite warning.

## Start on Linux / macOS

Extract the ZIP and enter the `yyc-nodejs` directory:

```bash
cd yyc-nodejs
node --version
npm run setup-admin
npm start
```

`setup-admin` asks for a broker name, email and a password of at least 12 characters. Password input is hidden. No default administrator or fixed password is shipped.

Open **http://localhost:3000**. Log in with the broker account you created.

Store owners and drivers can register through the **Register** tab. A driver must provide truck information and wait for the broker's manual approval.

If port 3000 is already in use:

```bash
PORT=3001 npm start
```

Then open **http://localhost:3001**.

On Windows PowerShell:

```powershell
npm run setup-admin
npm start
# Alternative port:
$env:PORT=3001
npm start
```

### Development

```bash
npm run dev
```

This uses Node's file watcher. Refresh the browser after frontend edits.

## Verify a complete transaction

Use separate browser profiles/private windows for different accounts, or log out and log in between roles. Browser tabs in the same profile share the same account cookie.

1. Register a store account.
2. Register a driver and one truck. For the first test, choose a box truck with enough weight/pallet capacity for the cargo.
3. As broker, open **Approvals**, review the driver/truck information and record the manual approval. Verification itself must be performed outside this starter.
4. As store owner, request a delivery with pickup, destination, future date, cargo, contacts and receiving hours.
5. As broker, open the delivery, issue a customer quote and a separate driver rate.
6. As store owner, accept the quote.
7. As broker, select an approved suitable driver and send the job offer.
8. As driver, accept the offer, record arrival if needed, then confirm goods picked up.
9. If something goes wrong, report an issue. The broker must record a resolution before delivery can be completed.
10. As driver, enter the delivery receipt reference and recipient to confirm delivery.
11. Refresh/restart the app and check that the record and audit history remain.

The shipment-change action is available to brokers before pickup. A material destination/cargo change archives the prior quote, clears its price/acceptance and any offer/assignment, and requires a fresh quotation.

## Implemented

- Store/driver registration and broker creation through a local CLI.
- Salted password hashing using Node's `scrypt`; no plaintext stored passwords.
- Opaque server-side sessions; HttpOnly/SameSite cookies; logout revocation.
- JSON API origin validation and session CSRF tokens.
- Role and record-ownership checks on the server.
- Authentication/registration rate limiting (single-process in-memory limiter).
- Durable users, trucks, shipments, quotation versions, exceptions and audit events.
- Manual driver + truck approval.
- Customer quotations and distinct driver rates, with role-based field filtering.
- Server-enforced quote/offer/acceptance/pickup/delivery transitions.
- Driver capacity/type/liftgate checks and one active job per driver/truck.
- Atomic assignment acceptance, optimistic delivery versions and conflict errors.
- Shipment-change invalidation and retained quotation history.
- Required delivery receipt reference and recipient.
- Store profile edits preserve record ownership through stable IDs.
- Server-backed delivery search, cards, list, work board and alerts.
- Database health endpoint at `/healthz`.
- SQLite backup command and integration tests.

## Not implemented / not production-ready

- **Google Maps API, live phone GPS, ETA calculation or native background location.** The real-account screens show an explicit unconnected state instead of fictional locations. A React Native/native phone app is still required for the planned driver tracking design.
- **Clojure, ClojureScript or XTDB.** This requested package is Node.js + browser JavaScript + SQLite; it does not claim to use the earlier proposed stack.
- Email verification, password reset, staff invitations, MFA, account suspension UI, document upload/scanning/expiry, photo/signature capture and formal identity/insurance verification.
- Online payments, invoicing/tax calculation, automatic payouts, bidding, automatic matching, multi-stop loads or route optimization.
- Expiring job offers/quotations, phone GPS ingestion, notification delivery, push/SMS/email providers and automatic live multiuser updates. Use **Refresh** to load other users' latest changes.
- Advanced scheduling. This starter deliberately allows only **one Assigned/In transit job per driver/truck**. It is not a full time-window/travel-time scheduling engine.
- Private uploaded files. The Documents tab shows database summaries and receipt references, not uploaded PDFs or photos.
- Automated off-site backups, tested disaster-recovery hosting, external monitoring, penetration testing or app-store distribution.

Production hardening must include reviewed account recovery and verification, multi-factor broker access, provider configuration, vulnerability/security review, monitoring, backup/restore drills, consent/retention rules, operational procedures and field-tested tracking. Existing presentation code uses inline event handlers; the CSP permits inline scripts for those handlers. Migrate to a stricter CSP/event-binding approach before broad public deployment.

## Data and configuration

Records are saved to **`data/yyc.sqlite`**, outside the publicly served directory. A running SQLite database can also have `-wal` and `-shm` files. Do not copy only the main database while it is being written; use the backup command.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen address; local-only by default |
| `PORT` | `3000` | HTTP port |
| `YYC_DATA_DIR` | `./data` | Directory containing `yyc.sqlite` |
| `PUBLIC_ORIGIN` | Derived from request host/protocol | Set the exact browser origin behind a reverse proxy |
| `NODE_ENV` | Unset/development | `production` enables Secure cookies and HSTS; use only with HTTPS |

The `.env.example` file documents configuration. To use a local `.env` file:

```bash
node --env-file=.env src/server.js
```

For HTTPS hosting, terminate TLS at a trusted reverse proxy and set `NODE_ENV=production` and `PUBLIC_ORIGIN=https://your-domain.example`. Keep the data directory on durable storage. Do not use ephemeral free-host filesystems for live records. The application is designed as a single server process; multi-instance hosting needs a reviewed shared-database architecture and shared rate limiting.

## Tests

```bash
npm test
```

Tests use isolated temporary databases and cover public role restriction, authentication, origin/CSRF checks, cross-store isolation, stale versions, approval, simultaneous offer acceptance, conflicting active jobs, material-change invalidation, delivery exceptions/evidence, profile ownership, restart persistence and logout.

## Backup

```bash
npm run backup
```

This uses SQLite's backup API and writes a permission-restricted snapshot to `backups/`. It can run while the app is running. Copy backups to a separately protected off-site destination using your operational process. The application does not do that automatically.

### Restore

1. Stop the server and all database writers.
2. Preserve the existing `data/` directory as a rollback copy.
3. Create a new empty data directory owned by the server user, with owner-only access.
4. Copy the selected backup to `yyc.sqlite` inside that directory. Do not mix an older database with leftover WAL/SHM files from another state.
5. Set `YYC_DATA_DIR` to the restored directory, start the app, and verify accounts, shipments, evidence and audit history.
6. Treat backup files as private: they contain password hashes, sessions and business records. Rotate/revoke account sessions as part of a real incident recovery.

## Optional Docker setup

Docker files are provided, but the Docker build was not executed in this environment.

```bash
docker compose up --build -d
docker compose exec yyc npm run setup-admin
```

Open http://localhost:3000. The named `yyc-data` volume preserves the database; the host port is bound to localhost. Do not remove the volume unless you deliberately intend to delete its records. Configure HTTPS and origin settings before exposing it publicly.

## Project layout

```text
src/server.js       HTTP server, cookies, origin/CSRF and routes
src/store.js        SQLite schema, authentication and business rules
public/             Branded browser interface with server adapter
public/runtime.js   Server-backed frontend behavior
public/demo/        Original fictional screen prototype
scripts/            Broker setup and database backup
test/              Integration tests
```

No real accounts, default login credentials, production records, API keys, database files or sessions are included in the ZIP. Integration tests contain clearly fictional test credentials.
