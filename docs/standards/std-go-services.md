---
name: std-go-services
description: How a Go service in the operations estate bounds the time of a request, passes a context and shuts down.
globs: ["**/*.go"]
alwaysApply: false
kind: standard
status: Active
owner: backend lead
revision: v1, 2026-10-08
origin: the Larder engineering handbook, page "Go in operations", section GOOPS
---

# std-go-services: Go services in operations

## Applies to

Every Go file of a service the operations estate runs, its tests included. It covers time limits,
contexts and shutdown only. The layout and the dependencies of a Go service are the commerce
hub's standard of the same name, where a service belongs to both hubs.

## Must

- **std-go-services.01** MUST pass a `context.Context` as the first parameter of every function that does I/O. *(Source: GOOPS-1)*
- **std-go-services.02** MUST set `ReadHeaderTimeout`, `ReadTimeout` and `WriteTimeout` on every `http.Server`. *(Source: GOOPS-2)*
- **std-go-services.03** MUST set a timeout on every outgoing `http.Client`. *(Source: GOOPS-3)*
- **std-go-services.04** MUST stop on `SIGTERM` with `http.Server.Shutdown`, and finish the requests in progress. *(Source: GOOPS-4)*
- **std-go-services.05** MUST guard state that two requests can reach with a `sync.Mutex`, and MUST pass `go test -race`. *(Source: GOOPS-5)*

## Should

- **std-go-services.06** SHOULD return a sentinel error from a store, and map it to a status code in the handler. *(Source: GOOPS-6)*

## Values

| Value | Setting | Applies to | Source |
|---|---|---|---|
| A server's read and write timeout | 10 seconds | std-go-services.02 | GOOPS-2 |
| An outgoing client's timeout | 3 seconds | std-go-services.03 | GOOPS-3 |

## Checked by

- **std-go-services.01** — review: each new I/O function takes `ctx context.Context` first.
- **std-go-services.02** — review: the server literal sets the three fields.
- **std-go-services.03** — review: no `http.DefaultClient`, and each client sets `Timeout`.
- **std-go-services.04** — review: `main` handles `SIGTERM`.
- **std-go-services.05** — TEST_COMMAND: `go test -race ./...`.
- **std-go-services.06** — review.

## Relations

- Defers to: ADR-003, for repeated state-changing calls. ADR-002, for times.
- Settled on ingest: the commerce hub keeps a standard with the same name. The two govern different topics and do not conflict. Answer given by the operations architect, 2026-10-20.

## Exceptions

The backend lead grants an exception, and the design that needs it records it in its decisions log.

## Unresolved

None.

## Origin

The Larder engineering handbook, page "Go in operations", section GOOPS, v1 of 2026-10-08. This
summary leaves out the profiling guide, which is advice and binds no design.
