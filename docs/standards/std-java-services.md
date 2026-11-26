---
name: std-java-services
description: How a Java Spring Boot service in the operations estate is laid out, injects its dependencies, calls other services and is tested.
globs: ["src/main/java/**", "src/test/java/**", "pom.xml"]
alwaysApply: false
kind: standard
status: Active
owner: backend lead
revision: v1, 2026-10-08
origin: the Larder engineering handbook, page "Java services", section JAVA
---

# std-java-services: Java Spring Boot services

## Applies to

Every Java file under `src/main/java/` and `src/test/java/`, and the `pom.xml` of a Spring Boot
service. It does not cover the shape of a response, which each service's own rules set, or its
tests, which std-service-testing governs.

## Must

- **std-java-services.01** MUST inject a dependency through the constructor, and MUST NOT use field injection with `@Autowired`. *(Source: JAVA-1)*
- **std-java-services.02** MUST model a request body and a response body as a Java `record`. *(Source: JAVA-2)*
- **std-java-services.03** MUST call another service through one client class per service, built on Spring's `RestClient`. *(Source: JAVA-3)*
- **std-java-services.04** MUST NOT add a dependency to `pom.xml` outside the Spring Boot starters unless a decision record allows it. A dependency in the `test` scope needs no record. *(Source: JAVA-4)*
- **std-java-services.05** MUST take the current time from an injected `java.time.Clock`. *(Source: JAVA-5)*

## Should

- **std-java-services.06** SHOULD keep a controller free of business rules, and call one service class for each request. *(Source: JAVA-6)*

## Values

| Value | Setting | Applies to | Source |
|---|---|---|---|
| The Java version a service builds and runs on | 21 | std-java-services.04 | JAVA-4 |

## Checked by

- **std-java-services.01** — review: no `@Autowired` on a field.
- **std-java-services.02** — review: each new body type is a `record`.
- **std-java-services.03** — review: each outgoing call is in a class named `<Service>Client`.
- **std-java-services.04** — review: each new `dependency` in `pom.xml` names its record, or is in the `test` scope.
- **std-java-services.05** — review: no call to `Instant.now()` or `LocalDate.now()` without a `Clock`.
- **std-java-services.06** — review.

## Relations

- Defers to: ADR-002, for the time zone of every time. ADR-003, for the header on a state-changing call.

## Exceptions

The backend lead grants an exception, and the design that needs it records it in its decisions log.

## Unresolved

- UNRESOLVED — whether services move from Spring MVC to virtual threads. Owner: backend lead. Resolves: the first load test of pg-yassinesabri-shl-fulfilment-service.

## Origin

The Larder engineering handbook, page "Java services", section JAVA, v1 of 2026-10-08. This
summary leaves out the IDE settings and the code style, which each service's `checks.env` makes a command.
