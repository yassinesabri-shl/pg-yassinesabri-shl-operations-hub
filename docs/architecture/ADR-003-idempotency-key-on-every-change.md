---
name: ADR-003
description: Every HTTP call that changes state in the operations estate carries an Idempotency-Key header, and the server answers a repeated key with the first answer.
globs: ["**/*"]
alwaysApply: true
kind: adr
status: Accepted
owner: operations architect
revision: v1, 2026-10-20
origin: the Larder architecture decision log, record O-003, "Idempotency key on every change"
---

# ADR-003: A state-changing call carries an Idempotency-Key, and a repeat gets the first answer

## Decision

Every `POST`, `PUT`, `PATCH` and `DELETE` between operations systems carries an `Idempotency-Key` header, and the server answers a repeated key with the answer it gave first.

## Rules

- MUST send an `Idempotency-Key` header, a UUID v4, on every state-changing call.
- MUST reuse the same key when a call is retried.
- MUST answer a state-changing request that has no `Idempotency-Key` with 400 and the error code `idempotency_key_required`.
- MUST answer a repeated key with the status and body of the first answer, and MUST NOT apply the change twice.
- MUST answer a repeated key with a different request body with 422 and the error code `idempotency_key_reused`.
- MUST keep a key for at least 24 hours.

## Why

pg-yassinesabri-shl-fulfilment-service retries a call that times out. In the pilot a retried `packed` transition reached pg-yassinesabri-shl-orders-api twice and wrote two transition records.
Source: the Larder operations pilot review of 2026-10-03.

## Rejected

- Not a check of the current state before each change, because two retries can both read the old state.

## Accepted costs

- Each server keeps one record per key for 24 hours. A server with an in-memory store loses the records on a restart.
