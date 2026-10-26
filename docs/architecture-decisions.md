# Architecture decisions and trade-offs

## Why seven services?

This is a learning prototype for printer rental administration. A modular monolith
would usually be the simpler first production design for a small rental company.
The prototype deliberately explores independent delivery, database ownership and
recovery from asynchronous failures. There is one gateway and six domain services.
The costs are more deployments, eventual consistency, duplicated technical adapters
and more involved local setup. Repositories still depend on API/event contracts.

## OOP and SOLID

Controllers translate HTTP inputs and delegate use cases. Application services
coordinate transactions, authorization and domain operations. Domain objects
implement reading and charge rules; JDBC/JPA, messaging and HTTP adapters implement
ports. Persistence and business rules remain local to their owning service.
Architecture tests check controller/persistence separation and implementation
dependencies without allowing empty selections to pass silently.

Technical JWT, transport and messaging adapters intentionally remain in each
service rather than restoring a shared psi-common runtime library. This avoids
coordinated library releases, but security fixes must be applied and tested in
every affected repository. A small versioned technical library is an option if
that maintenance burden outweighs release independence. Business entities,
persistence models and migrations must not be shared between services.

## Outbox delivery

Business changes and outbox insertion commit in the same local transaction. A
dispatcher claims one event in a short PostgreSQL transaction using FOR UPDATE
SKIP LOCKED and a 60-second lease. It releases the connection before calling
Pub/Sub, then acknowledges using the claim token in another short transaction.
An expired worker cannot acknowledge or release another worker's newer claim.
Five events bound each dispatch request. A failed publish backs off; a crashed
worker's lease can be reclaimed after expiry.

Delivery is **at least once**, not exactly once: a successful broker publish
followed by a failed acknowledgement can redeliver the same event ID. Consumers
retain inbox deduplication and projection revision checks. Publication ordering
across workers or services is not guaranteed.

API writes do not synchronously drain the outbox. Existing authenticated Scheduler
requests invoke rental dispatch and metering/billing maintenance ticks, which
already drain their outboxes. Local Docker uses scheduled polling. Request-based
Cloud Run CPU is not treated as a reliable idle background worker. No additional
Scheduler jobs or always-on Cloud Run instances are required.

## Portfolio versus operating configuration

Project numbers, bucket names, hostnames, branch IDs and image digests identify
deployments; they are not credentials. API keys, passwords, credential-bearing
connection URLs, tokens and private keys must never be published.

The overview uses logical service names. Existing deployment files and release
records are operational evidence: do not replace their values blindly. Before
making any repository public, review its entire Git history, remove private
operational evidence in a separate public copy, and rotate exposed credentials.
This change does not publish repositories or certify historical secrecy.

## Current scope

The prototype exposes backend APIs and Postman examples. It has no customer web
frontend, bank integration or statutory invoice certification. Notifications are
application records and broker events; do not infer a production email provider.
The agreed billing rules are in metering-billing-requirements.md. A successful
unit test run is not proof of a deployed system.
