# Functional requirements status

Reviewed 2026-11-11. This tracks user-facing capabilities in the Node.js/PostgreSQL application. A feature marked implemented has an application flow; it may still require provider credentials or deployment configuration to operate in a hosted environment.

## Implemented workflows

- Account registration, email verification, password reset, MFA enrollment/sign-in, broker account suspension, and account profile updates.
- Shipment requests, quotations, quote expiry, driver offers, bidding, bid withdrawal/selection, offer expiry, assignment withdrawal, cancellation audit reasons, pickup, multi-stop progress, delivery evidence, and issue resolution.
- Driver eligibility and schedule conflict checks, stop service durations/windows, route/ETA estimation when Maps is configured, live tracking maps, and a companion Expo app for background GPS.
- Driver compliance document upload, broker review, expiry status, private download, and notification preferences.
- In-app notifications with unread/read state, status update delivery through configured email/SMS/push providers, and service connection probes for configured providers.
- Delivered-shipment PDF invoices, Stripe card payments, webhook status updates, and Stripe Connect driver payouts.
- Shipment search, status filtering, pagination, CSV export, driver schedule view, broker bid comparison, exception queue with severity/owner/due time, and operational summary reports.
- Store-requested quotation revisions with archived versions, rescheduling requests with driver conflict rechecks, promised/actual pickup and delivery times, and late-target notifications.
- Pickup, stop, and final-delivery proof records with typed signatory, optional private photo/PDF, quantities received, shortages, damage, and refused items; customer claim submission and broker decisions.
- Driver-declared working days/hours/breaks used during assignment checks; payout breakdowns with audited adjustments.
- Store team access for existing verified store accounts with shipment read/write and billing permissions; account JSON export and broker-reviewed removal requests with anonymization.

## Remaining product requirements

- Let customers edit eligible shipment requests and receiving contacts in self-service, with clear rules for when a quote or assignment must be revised.
- Add brokerage team roles and shipment-level permissions; current explicit team permissions are for store accounts.
- Let brokers assign exceptions to any eligible broker and configure escalation policies.
- Expand scheduling into a full-day multi-stop calendar that combines traffic, loading/unloading, breaks, and all booked jobs.
- Improve dispatch recommendations with configurable scoring and explicit reasons for each incompatibility.
- Add customer refund requests and broker refund decisions, payment retry history, payout failure recovery, and downloadable payment receipts.
- Expand operational reports with date-range filters, driver utilization, quote conversion, and revenue/payout reconciliation.
- Add richer notification controls such as per-event preferences, notification delivery history, and channel failure/retry status.
- Complete accessibility and mobile usability review across every workflow, including keyboard-only operation, screen-reader announcements, contrast, touch targets, and field testing on driver devices.
- Replace typed signatory names with an optional drawn signature capture and add item-by-item receiving manifests.
- Extend account exports to include document file contents. Removal currently anonymizes the account and removes uploaded documents while retaining transactional shipment/financial records.

## Integration conditions

- Maps, Stripe, email, SMS, object storage, and push delivery need their respective provider credentials and production configuration.
- The PostgreSQL/Redis integration test is opt-in through `YYC_INTEGRATION_DATABASE_URL` and `YYC_INTEGRATION_REDIS_URL`; a local test run without these variables does not exercise the live service integration.
- The Expo driver app needs native iOS/Android builds and device testing before distribution.
- Photo/PDF proof upload requires configured private object storage; without it, receipt references, typed signatories, and quantities still work.
