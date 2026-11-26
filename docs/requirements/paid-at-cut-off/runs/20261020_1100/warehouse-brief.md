---
name: paid-at-cut-off-20261020-1100-warehouse-brief
description: The warehouse brief asking that the dispatch cut-off read the time an order was paid from the order itself, version 1, that paid-at-cut-off/requirements.md was written from.
globs: []
alwaysApply: false
kind: requirements-source
owner: operations lead
revision: version 1, 2026-10-16
origin: the Larder operations team's shared folder, page "Cut-off and payment time"; copied in unchanged on 2026-10-20
---

# Brief — the cut-off reads the payment time from the order
<!-- COPIED IN, UNCHANGED, under the header above. Every citation in paid-at-cut-off/requirements.md resolves against this copy. -->

## Why we are asking

Every morning the warehouse builds the day's pick list from the orders paid before the cut-off.
Today the pick list works out when an order was paid by searching the order's history of state
changes. When we looked at a disputed order last week, two people read that history and gave two
different payment times.

## What we need

An order must say, in one place, when it was paid. An order that is not paid yet must not look
paid.

Once an order is paid, the time it was paid must never change, whatever happens to the order
afterwards.

The pick list must use that payment time to decide whether an order makes the cut-off. An order
paid one second before the cut-off makes it. An order paid at the cut-off does not.

If a paid order has no payment time, the pick list must not guess. It must leave the order out and
say so.

## Constraints

Every time is in UTC, as everywhere in operations.

## Not yet agreed

Whether customer care should see the payment time too.
