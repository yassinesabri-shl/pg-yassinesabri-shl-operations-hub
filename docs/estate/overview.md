---
name: estate-overview
description: What the Larder operations estate is — the warehouse work that turns a paid order into a dispatched box — for a reader who has never seen it.
globs: []
alwaysApply: false
kind: estate-overview
owner: operations architect
revision: 2026-10-20
origin: written by the operations architect from the repository list and the two READMEs, /add-context
---

# The Larder operations estate: what it is

## 1. What the system does

After a customer pays, the warehouse must pick the ingredients, pack the box and hand it to a
carrier. Each morning pg-yassinesabri-shl-fulfilment-service collects the orders paid before the cut-off, builds one
pick list for the day and moves each order to `picking`. When a box leaves, it moves the order to
`packed` and then to `dispatched`. pg-yassinesabri-shl-orders-api holds every order and is the only system that
changes an order's state.

## 2. The parts

| Part (repository id) | What it is for | Who to ask |
|---|---|---|
| `pg-yassinesabri-shl-orders-api` | The record of every order and its state, and the only place a state changes. The commerce hub governs it too. | backend lead |
| `pg-yassinesabri-shl-fulfilment-service` | The warehouse's pick lists and shipments, for each dispatch day. | operations lead |

## 3. Words the business uses

| Word | What it means here |
|---|---|
| dispatch date | The day a box leaves the warehouse, as a UTC calendar date. |
| cut-off | The last moment an order can be paid and still leave on a dispatch date. |
| pick list | The total of each recipe the warehouse must pick for one dispatch date. |
| shipment | One box handed to one carrier for one order. |
| transition | One move of an order from one state to the next, recorded with its time and its requester. |

## 4. Outside the estate

| System | What it does | Who owns it |
|---|---|---|
| The commerce estate (`pg-yassinesabri-shl-commerce-hub`) | The shop where a customer places an order, and the catalogue of recipes. | lead architect |
| The carriers | Take a packed box and deliver it, and report the delivery. | operations lead |

UNRESOLVED — how a carrier's delivery report moves an order to `delivered`. Owner: operations architect. Resolves: the first carrier integration.
