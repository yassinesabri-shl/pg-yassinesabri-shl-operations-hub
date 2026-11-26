---
name: ADR-001
description: An order moves through one fixed state machine, and pg-yassinesabri-shl-orders-api is the only system that writes an order's state; every other system asks it for a transition.
globs: ["**/*"]
alwaysApply: true
kind: adr
status: Accepted
owner: operations architect
revision: v1, 2026-10-20
origin: the Larder architecture decision log, record O-001, "One owner for order state"
---

# ADR-001: pg-yassinesabri-shl-orders-api owns an order's state, and the state machine is fixed

## Decision

An order moves only along the transitions below, and only pg-yassinesabri-shl-orders-api changes an order's state, when another system asks it over HTTP.

## Rules

- MUST allow only these transitions: `placed` to `paid`, `paid` to `picking`, `picking` to `packed`, `packed` to `dispatched`, `dispatched` to `delivered`, and `placed` or `paid` to `cancelled`.
- MUST answer a request for any other transition with 409 and the error code `invalid_transition`.
- MUST change an order's state only through `POST /v1/orders/{id}/transitions` on pg-yassinesabri-shl-orders-api.
- MUST NOT keep a copy of an order's state in another system as the record of truth. A copy is a cache, and it is read again before a decision.
- MUST record the time and the requesting system of every transition on the order.

## Why

Picking started on a cancelled order twice in the pilot, because the warehouse kept its own status column.
Source: the Larder operations pilot review of 2026-10-03.

## Rejected

- Not a state column in each system, kept in step by a nightly job, because the warehouse picks within minutes of payment.
- Not a workflow engine, because the estate has one state machine with seven states.

## Accepted costs

- pg-yassinesabri-shl-fulfilment-service cannot start a pick list while pg-yassinesabri-shl-orders-api is down. Picking waits.
