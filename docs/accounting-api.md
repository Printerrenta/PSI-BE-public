# Metering, billing and manual payments

API reference for the public source mirror. All public routes go through the existing gateway. Cloud Run IAM and the application Bearer JWT remain separate layers. CUSTOMER sees only owned records; EMPLOYEE/ADMIN manage policies, contract terms, invoice issuance and payments. Business time zone: Europe/Vilnius.

## Ownership and SOLID/OOP

Seven independently built/deployed repositories: gateway, identity, rental, documents, notifications, metering and billing. No shared Java business library, cross-service entity imports or SQL joins. Each data-owning service has its own database role, schema and Flyway history. Each service has a separate database on a shared PostgreSQL server.

Rental owns contract terms and the explicit four-counter baseline. Metering owns submissions, policy versions, anomaly review and accepted-reading history. Billing owns its local contract/reading projections, immutable issued statements, correction assessments, payments and allocation history. Notifications owns user notifications. Communication uses HTTP for owner-authorized recovery/sync and Pub/Sub for asynchronous changes.

Domain objects/calculators enforce money, counter and allocation rules without HTTP or persistence. Application services coordinate transactions and authorization through narrow ports; JDBC/HTTP/PubSub adapters implement those ports. AccountStore, InvoiceStore, AdjustmentStore and PaymentStore are separate interfaces. ContractAccountingObserver lets the rental lifecycle publish an accounting snapshot without depending on consumers. Controllers delegate use cases.

## Initial contract accounting

Create/activate the rental contract with zero included-page allowances; all pages are billable. The legacy two-counter activation API remains compatible. Explicitly initialize accounting before completion; never infer unknown A3 baselines from legacy counters.

`POST /api/contracts/{id}/accounting` (staff):

```json
{"a3Capable":true,"baseline":[1000,200,100,50],"vatPercent":21,"paymentTermDays":14}
```

Counter order everywhere: A4 mono, A4 colour, A3 mono, A3 colour. VAT 21 here is an example; use the agreed contract percentage. Initial monthly/A4 fees come from the contract. A3 is exactly twice its A4 rate. GET the same route returns the authoritative snapshot and revision.

`POST /api/contracts/{id}/accounting/terms` appends a version (staff):

```json
{"revision":1,"effectiveFrom":"2026-11-15","monthlyFee":31,"monoPrice":0.01,"colorPrice":0.03,"vatPercent":21,"paymentTermDays":14}
```

Use the current revision and an effective date today or later within the planned contract, after previously scheduled terms. Mid-month changes need no boundary readings: usage is allocated by days and labelled accordingly. Earlier conditions remain available for calculation reproduction.

## Readings

- `GET /api/metering/contracts/{id}?page=0&size=20`: snapshot, stream version and submission history.
- `POST /api/metering/contracts/{id}/sync`: recover a missing/stale projection through owner-authorized rental HTTP; normal delivery is Pub/Sub.
- `POST /api/metering/policies/MODEL` or `/DEVICE` (staff): `{"key":"<modelKey or printer UUID>","minimumPerDay":0,"maximumPerDay":1000,"version":0}`. Get the current policy at the same route with `?key=...` before editing. Device overrides model. Model key is provided by the contract snapshot. Missing policy sends readings for review instead of inventing a threshold.
- `POST /api/metering/contracts/{id}/readings`: `{"requestKey":"<UUID>","version":1,"asOf":"2026-10-31","counters":[1100,220,110,55]}`. Use the returned stream version, a month-end or final usage date, and the actual cumulative counters. Observed date differs from submission time. Retrying the exact requestKey/body is idempotent.
- Corrections use a new requestKey and `supersedes` equal to the currently accepted reading ID. Valid corrections auto-accept; older history remains. Counters must remain monotonic relative to both neighbours; resets are unsupported.
- `GET /api/metering/review-queue`; `POST /api/metering/readings/{id}/review` (staff): `{"version":2,"approve":true,"reason":"Checked the device counters"}`. Review cannot override hard counter/date invariants.

Expected load uses A4 equivalents (A3 = 2) per usage day, both low and high bounds. Actual return ends page consumption; planned end still determines fixed fees. A late completion snapshot retains conflicting historical submissions but exposes them as OUTSIDE_USAGE_WINDOW and excludes them from billable consumption.

## Statements, corrections and payments

- `GET /api/billing/contracts/{id}`; POST the `/sync` suffix for authorized recovery.
- `POST /api/billing/contracts/{id}/invoices` (staff): `{"requestKey":"<UUID>","period":"2026-10"}`. One monthly statement per contract/month; exact retries return the same document. Period must be closed. Without accepted actual readings, estimates can issue only after the next month's 5th.
- `GET /api/billing/invoices` and `/invoices/{id}` expose immutable source calculation, fixed and four page lines, VAT, applied correction links, paid/outstanding amounts and payment state. `owner` can be selected by staff; customers cannot read someone else's records.
- Missing readings use only the last full factual month, daily normalized. Without one, issue fixed-only, label NO_HISTORY and notify staff. Accepted late readings create signed monetary adjustments; prior issued statements are never rewritten. Noncash correction credit floors the next payable amount at zero and carries the remainder.
- `POST /api/billing/contracts/{id}/reconciliation` (staff): `{"requestKey":"<UUID>"}` after planned contract end applies remaining adjustments to a separate settlement statement. Staff must finalize outstanding reconciliation after late final readings; monthly automation does not silently consume that operator action. Unused customer credit remains visible for final settlement.
- `POST /api/billing/payments` (staff): `{"id":"<UUID>","ownerSubject":"<customer subject>","amount":100.00,"receivedOn":"2026-11-06","reference":"Bank transfer reference"}`. Positive two-decimal EUR, no future received date, exact ID/payload retry only.
- Payments cover the oldest due/issued/period statements first; partial allocations are allowed. Remaining real money becomes advance, separately from noncash corrections. Due date = statement issuance date + contract paymentTermDays. Overdue begins the following day.
- `GET /api/billing/account`, `/payments`, `/adjustments`, `/allocations` expose balances and audit trails. Lists use page/size (max 100); staff can select `owner`.
- Audited reversal for a mistaken manual entry: `POST /api/billing/payments/{id}/reverse` with `{"requestKey":"<UUID>","version":<account version>,"reason":"Payment entered twice by mistake"}`. It preserves allocation history, reopens debt and reapplies remaining payments. This does not execute a bank refund.

Money is decimal. Round each displayed net line HALF_UP to two decimals, compute/round its VAT, then sum the displayed lines. Issued calculation/source versions remain immutable. These are prototype accounting statements, without a bank integration or statutory PDF/numbering workflow.

## Broker and scheduled work

Rental publishes ContractAccountingChanged; metering consumes it. Billing consumes it plus MeterReadingAccepted. Separate metering-events-v1 and billing-events-v1 topics feed billing and notifications. Durable transactional outboxes and inbox IDs handle retries/duplicates. A reading arriving before its contract remains pending in the inbox until replay; stream revisions guard stale per-date updates. Technical contract snapshots are not user notifications.

Private OIDC Scheduler calls `/internal/metering/tick` and `/internal/billing/tick` every minute. They retry inbox/outbox work; metering sends month-start/5th reminders, billing closes eligible periods (bounded batches). Public gateway never routes internal endpoints. Google OIDC restricts actual callers, subscription paths are allowlisted, and local unauthenticated emulator mode is forbidden in Cloud Run.

## Verification completed on 2026-10-22

- Local unit/MVC/architecture builds: 264 tests across the five changed Java services, zero failures.
- New PostgreSQL CI suites: metering 9, billing 13, rental accounting 4 plus 49 existing rental/repair scenarios, zero failures (see individual CI runs).
- All five changed service Docker builds passed in GitHub CI.
- Isolated expiring Neon branch: rental Flyway V9 and new services V2 startup passed, existing row counts preserved, new roles denied access to rental/identity schemas. The local env was subsequently switched to this test branch at the user’s request; the original is retained in ignored .env.before-accounting-test. GCP secrets are unchanged.
- Six standalone applications with real signed Ed25519 JWT validation against a local test JWKS, actual Google Pub/Sub emulator, restricted roles and isolated Neon database: 30 API checks passed. Full one-day example: fixed 1 EUR + page usage 2.10 EUR = 3.10 net, 0.65 VAT, 3.75 payable; manual payment 5 EUR -> zero outstanding and 1.25 advance. Broker-delivered customer notifications and request idempotency verified.
- Local Docker Desktop could not start; Docker image verification ran in CI. GCP image creation is build-only, separate from production deployment. No new production schemas or IAM permissions have been created by this feature.

Terraform has an explicit accounting_enabled switch, two private runtime identities/services, scoped secret access, topics/subscriptions with dead-letter routing, scheduler and independent repository triggers. See GCP-IFRA accounting rollout instructions; do not enable it without new runtime credentials, reviewed permissions and verified images.

## Repeating the full local test

Build identity, rental, notifications, gateway, metering and billing sibling repositories first. Install npm dependencies in PSI-BE and the official Google Pub/Sub emulator (its standalone JAR is sufficient; no Docker daemon is needed for this test). Use Java 21 or newer.

Select an isolated expiring Neon branch in .env.local (NEON_BRANCH must start accounting-test-), provision all six restricted schema roles there with scripts/provision-service-databases.mjs and point SERVICE_CREDENTIALS_FILE at that ignored credential file. Set ACCOUNTING_TEST_EXPECTED_HOST to exactly that branch's direct database hostname, PUBSUB_EMULATOR_JAR to the installed emulator JAR, and JAVA_HOME to the JDK. Run `npm run test:accounting`. Loopback ports 18301–18306, 18315 and 18316 must be free.

The runner starts/stops the six JARs, a real Pub/Sub emulator and a temporary local JWKS server. Its ephemeral signed JWTs exercise production signature verification and identity role resolution without changing managed Auth users. It retains immutable test accounting history only in the selected test branch and writes redacted logs/proof to a temporary evidence directory. It never overwrites env files or deletes issued financial documents. Restore the ignored original env file before the test branch expires.

Production verification completed: 72 real GCP API checks with managed Auth, role/owner isolation, rental and metering outboxes, actual Pub/Sub delivery into both accounting services and customer notifications. No issued financial documents were created by the production smoke; synthetic users/rental/reading projections and S3 object were cleaned. Financial calculation/payment/correction E2E remains the isolated-branch test described above.
