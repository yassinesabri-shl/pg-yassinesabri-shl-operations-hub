---
name: std-service-testing
description: How an operations service tests its HTTP endpoints, its calls to other services and its clock-dependent rules, whatever its language.
globs: ["**/*_test.go", "src/test/java/**"]
alwaysApply: false
kind: standard
status: Active
owner: QA lead
revision: v1, 2026-10-08
origin: the Larder engineering handbook, page "Testing services", section TEST
---

# std-service-testing: Testing operations services

## Applies to

Every test of an operations service, in Go or in Java. It does not cover a load test or a test
that runs against a deployed environment.

## Must

- **std-service-testing.01** MUST name each test after the behaviour it proves, such as `rejects a transition from packed to paid`. *(Source: TEST-1)*
- **std-service-testing.02** MUST replace each other service with a fake in the test, and MUST NOT call a real network address. *(Source: TEST-2)*
- **std-service-testing.03** MUST fix the clock in every test of a rule that depends on the time. *(Source: TEST-3)*
- **std-service-testing.04** MUST test each refusal an endpoint makes, including a missing `Idempotency-Key`. *(Source: TEST-4)*
- **std-service-testing.05** MUST test that a repeated `Idempotency-Key` returns the first answer and changes nothing. *(Source: TEST-5)*

## Should

- **std-service-testing.06** SHOULD test a cut-off at one second before it, at it, and one second after it. *(Source: TEST-6)*

## Values

None.

## Checked by

- **std-service-testing.01** — review: the test names read as behaviours.
- **std-service-testing.02** — review: no test reads a `*_URL` variable that points outside the test.
- **std-service-testing.03** — review: each time rule's test builds a fixed clock.
- **std-service-testing.04** — review: a negative test for each refusal in the design.
- **std-service-testing.05** — review: a test sends one key twice and asserts one change.
- **std-service-testing.06** — review.

## Relations

- Defers to: ADR-003, for what a repeated key returns. ADR-002, for the clock.

## Exceptions

The QA lead grants an exception, and the design that needs it records it in its decisions log.

## Unresolved

None.

## Origin

The Larder engineering handbook, page "Testing services", section TEST, v1 of 2026-10-08. This
summary leaves out the test data guide, because every test here builds its own data.
