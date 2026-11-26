---
name: survey-repo
description: The service-surveyor's method for reading one repository at one pinned commit and writing its service survey — what it serves, what it calls and in which repository or at which third party's host, its data stores and its libraries, shared and third-party — every row keyed in a fixed grammar and pointed at its lines.
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-28 -->

# Skill — survey a repository

Loaded by the `service-surveyor` seat (`.claude/agents/service-surveyor.md`), which `/survey-repo`
dispatches once for each part of a repository. The command owns the clone, the commit and the
pull request. `scripts/plan-survey.mjs` cuts the repository into parts, and
`scripts/join-survey.mjs` joins the parts into the survey file. `scripts/check-survey.mjs` owns
the shape and proves every pointer. This file owns how a part is read, so that the survey is
true, keyed and small.

**Why a survey exists.** When a story changes a contract — an endpoint, an event, a stored record,
a shared library — `/decompose` writes one story for every repository that reads it
(`.claude/skills/decompose-requirements/SKILL.md` § Every story leaves the trunk working). It cannot
open twenty-five repositories to find them. The surveys, and the graph a script builds from them,
point at the readers; the planner then reads each at a pinned commit and cites that read. So the
survey is an index. A missed call is a reader nobody moves; an invented one is a wasted read. Both
matter, and the first matters more.

## The sections

A survey on template v6 has seven sections. A part has the first six. You never write section 7. The join writes it, from the list of files that the plan left out.

| Section | Holds | Keys |
|---|---|---|
| 1. Serves | what other parts can reach in this repository: routes it mounts, events it publishes, queues it consumes, jobs it runs | `http`, `event`, `queue`, `job` |
| 2. Calls | what this repository reaches in another: HTTP calls, events it subscribes to, queues it sends to, jobs it triggers — each with its provider | `http`, `event`, `queue`, `job` |
| 3. Data stores | every database, bucket, cache or index it reads or writes, with the tables or prefixes it touches | `store` |
| 4. Shared libraries | libraries shared inside the estate: published under the client's own scope or group, or built from a listed repository | `lib` |
| 5. Third-party libraries | every other library the running service depends on directly: public packages and vendors' SDKs | `lib` |
| 6. Open points | what the code shows but the grammar cannot key: what is open, its owner, what settles it, and where the code shows it. Never a call the grammar can key | — |

An event appears under Serves when this repository publishes it and under Calls when it
subscribes; a queue under Serves when it consumes and under Calls when it sends. The graph matches
a Calls key against another repository's Serves key, so the two sides must be spelled alike.

## Method

1. **Orient before reading.** Read the fact sheet when the dispatch gives one. Read the manifests (`package.json`, `pyproject.toml`, `go.mod`,
   `pom.xml`, `*.csproj`, …), the entry points, and the configuration files. Find the framework's
   router, the message consumers' registration, the scheduler. Search with `grep` before you
   read. Read the narrowest file that answers. Quote every glob, as in `--include='*.php'`, and
   write no `echo` line: the shell can be `zsh`, which refuses an unquoted glob that matches
   nothing. Leave out tests, examples, fixtures, generated clients you do not
   call, and vendored code.
2. **Serves.** Every route the running service mounts: route tables, decorators, annotations,
   handler registration. An API description file (OpenAPI and its kind) counts only where the code
   mounts or generates from it; point at the code either way. Every event it publishes, queue it
   consumes, job it schedules.
3. **Calls.** Every HTTP client and SDK constructed, with the base address it is given and where
   that comes from; every producer and subscription. A call is a request to an API. Leave out
   a page's load of a static file: a stylesheet, a script, a font, an image or an icon that a
   template or a page references, from a CDN or any other host. It is not a row and not an open
   point. The join refuses an http row whose path ends in the extension of such a file.

   A call to this repository, a self-call, is not a Calls row. Its sending side goes nowhere: no
   Calls row, no open point and no note in a Serves row. The graph that `/decompose` reads holds
   only edges between repositories, so a self-call carries no fact for it. Do not write an open
   point that only describes a self-call. When you remove a self-call row in a fix-up, remove its
   open point too.

   A call with the provider `unknown` whose http method and path this repository serves is a
   self-call. The join finds it, and `--check` finds it inside one part. Where the code names
   another host or repository for that call, name that provider. Otherwise remove the row.
   Before you write the provider `unknown`, search the clone for the path of the call. A route
   in another part, or a tool folder of this repository, can serve it. Only the join sees the
   Serves rows of other parts, and each self-call that it finds costs one more dispatch.

   Name the provider:
   - a listed repository id, when the code or its configuration names that repository — a service
     name, a host the estate overview or a README ties to it, a client package it publishes. The
     dispatch gives the id and the purpose of each listed repository;
   - `external:<host>`, when it is a third party or anything outside the list: the host the call
     reaches, as the code or its configuration names it, in lower case, with no scheme, port or
     path (`external:api.cartesia.ai`). The key is still the path alone, in the case that the
     code gives it, so a reader sees the host in the provider and the route in the key;
   - `unknown`, when neither the code nor its configuration names the host or the repository — an
     address built at run time, a base from an environment variable with no value in the
     repository, an SDK whose host is nowhere in sight. The call is still a row with its key, so a
     planner looking for the readers of that key finds it. Where many calls share one unnamed
     base, add one open point for the base — what it is, who can name the service behind it — and
     never list the calls there: a key in an open point is invisible to the graph, and the check
     refuses one no row carries.

   A call whose whole address is one configuration property with no value in the repository has
   no path, so the grammar cannot key it. Write one open point for it and no Calls row. Its
   Unresolved cell names the property and says that the property holds the whole address. Point
   at the code that sends the request and at the property. Never key the call as
   `http:POST:/{send_email_url}`: a path of one parameter matches every one-segment path in the
   graph, and the check refuses it. The check also refuses a key whose first segment is a host,
   as in `http:POST:/api.example.com/send`. Name the host in Provider, and keep only the path in
   the key.
4. **Data stores.** Connection configuration, models, migrations, bucket and cache names. The key
   names the logical store (`store:postgres:transfers`), never a host, a port or a credential;
   Objects lists the tables, collections or prefixes this repository touches. Access is `read`,
   `write` or `read-write`, from the operations the code performs, not from the grant it holds.
5. **Libraries.** Every dependency a manifest declares directly for the running service, each in
   one of two sections. A manifest is a file in the list of manifests that the dispatch gives.
   A library row points only at the lines of a manifest in that list. The join refuses any other
   pointer. The plan leaves out a dependency list in a folder below another manifest of the same
   kind, unless a workspace declaration or a build file names it. Do not record a package of a
   list that the plan leaves out. Where the running service runs code from the folder of such a
   list, record one open point that names the list and the code that runs it. A file that pins
   every package exactly, with the indirect packages, is a lock file even when the plan lists it.
   Record only the packages that the service declares directly. **Shared libraries** are the ones shared inside the estate. **Third-party
   libraries** are all the rest: public open-source packages and vendors' SDKs. Leave out what the
   running service does not load: development, test and build-only dependencies
   (`devDependencies`, a `dev` or `test` group, a `test` or `provided` scope) and a lock file's
   indirect entries. Version is what the manifest declares, exactly (`^1.4.0`, `>=0.2.2`); `any`
   where it declares none. One package in two manifests at two versions is one row, both
   versions joined by `, `, and both pointers.

## Writing keys — so two surveys match

- `http:<METHOD>:<path>`: method in capitals. Path in lower case, as a caller would send it, with
  the service's base path included where the service mounts one. Parameters as `{name}` in lower
  snake case, whatever the framework writes: `:userId`, `<user_id>` and `{userId}` all become
  `{user_id}`. Keep the version: `/v2/postings` and `/postings` are different keys on purpose.
  No host, no port, no query, no trailing slash. The root is `/`.
- A segment can mix literal text and parameters: `/v{version}/reports`, `/{action}-instance`.
  Do not put two parameters side by side, as in `{name}{ext}`. Write one parameter for the
  segment: `{file_name}`.
- A custom method of a Google API ends the last segment with `:<verb>`:
  `/v2/projects/{project_id}/agent/sessions/{session_id}:detectIntent`. The verb holds letters and
  digits. A colon is refused in every other place, so convert a framework's `:id` to `{id}`.
- Case: on a call with the provider `external:<host>`, keep the path as the code spells it,
  because the host can treat case as part of the path: `serviceAccounts` stays
  `serviceAccounts`. Every other http key is in lower case, so a call and a serve of the estate
  match.
- `http:ANY:<path>`: a route that accepts every method. Write `ANY` only where the route accepts
  every method.
- A second path to one endpoint is a row of its own, with the same What cell and the same
  pointers. Its key is the path that a caller sends, so the graph finds a caller of each path.
- A generic route of the router, which runs any action by its name in the path, is one row. Its
  key is the router's pattern, as in `http:ANY:/api/{controller}/{action}`, and its pointer is the
  router's rule. Do not write a second row for each action that the generic route reaches. The
  graph compares every parameter as `{}`, so a caller of any action still finds the row. One
  survey test run gave 149 extra rows to one part.
- `event:<topic>` and `queue:<name>`: the name as the broker knows it, not the variable holding it.
- A placeholder name: the code names a queue or a topic by a configuration property. When the
  repository's configuration gives the value, the key uses the value. Point at the code and at
  the configuration. When no value is in the repository, the key is the property name in braces:
  `queue:{orders.queue.name}`, `event:{kafka.topic.orders}`. Add one open point for each such key,
  in exactly these words, so that the join merges the open points of all parts into one:
  Unresolved `` The property `{orders.queue.name}` has no value in the repository ``, Owner
  `service owner`, Resolves `the deployment configuration`.
- `job:<name>`: the name the scheduler registers, in lower case.
- `store:<engine>:<name>`: engine in lower case (`postgres`, `mysql`, `mongodb`, `redis`, `s3`, …).
  The name is the logical name that the code uses for the store: the bucket, database or
  cache name, not the variable or the property that holds it.
  - A read replica or a second connection with its own name is a store of its own, with its
    own key. Never key a replica as its primary.
  - When only a configuration property names the store and the repository gives no value, the
    name is the property in braces: `store:s3:{objectstorage.bucket.name}`.
  - When the fact sheet has a row for the store, use the sheet's key.
- `lib:<package>`: the package name exactly as the manifest spells it.

For a call, write the key the provider would serve: the path the request reaches, not the
client method's name. Where a client adds a base path, include it.

A placeholder has one form for each use:

- An http parameter is `{snake_case}`: `{tpod_id}`, never `{tpod id}` or `{tpodId}`. The check
  refuses another form in a key. The graph compares paths with every parameter as `{}`, so two
  parts that name one parameter differently still give one key.
- An event, queue or store placeholder is the property name as the code spells it:
  `{orders.queue.name}`. Do not change it to snake case. The check refuses a space.
- A run-time value in a What cell, an Objects cell or an open point takes the http form:
  `{instance_ip}`, `{user_name}`. No script checks prose cells, so use this form every time.

Write a placeholder as `{word}` in every cell: a key, a What cell, Objects and an open point.
Never write `<word>`. A reader's view shows `<word>` as an HTML tag and hides it, so the join
and the check refuse it outside a code span. Inside a code span, the text stays as the code
writes it: `` `/opt/<sid>.sh` ``.

## Cases

Each case below has one answer, so that two parts write one fact in one way.

- **A page that the web server serves as a file.** A static `.html` or `.htm` page is not a Serves
  row, as the load of a static file is not a call. A script under the document root that the
  server runs, as a `.php` file, is a Serves row with the path that reaches it. Its name does not
  matter: a deployed file called "sample" is served.
- **A method the router does not check.** Write `ANY` when the route table and the router accept
  every method and no handler checks the method. Never take a method from the way a caller uses
  the route.
- **The spelling of an action.** Write the spelling that the router matches. Where it matches in
  any case, write lower case, and break words as the route table or the callers do.
- **An SDK call with no HTTP path** (a cloud SDK for a key service, a token service or a
  machine): it is not a Calls row. Write one open point for each service, in exactly these words:
  Unresolved `` The code calls `<service>` through an SDK, which the grammar cannot key ``, Owner
  `tech lead`, Resolves `a key for SDK calls`.
- **A service in front of a store.** A request to the service is a call. A store row needs the
  store's own client or driver in the code.
- **A call to `localhost` or `127.0.0.1`.** It is a Calls row with the provider `unknown`. Add one
  open point that names the port: a process deployed beside the service listens there.
- **A queue that this repository both sends to and consumes.** It is a Serves row only. The send
  is a self-call.
- **A redirect or a link.** A browser navigation is not a call, even with data in the address.
- **A command with no scheduler in the repository.** It is not a `job:` row. Write one open point
  that names the command and its entry point.
- **A cache inside the process** (APCu, a file cache, an in-memory map): no row. A cache that
  other processes share is a store.
- **The session store of the language.** It is a store row only where the code sets the handler,
  with that engine and name. Otherwise write nothing.
- **A connection used only on a fallback path or only in a transaction.** It is a store row as any
  other.
- **A connection used only to check that the store answers.** Add its pointer to the row of the
  store. Where no other code uses the store, write a row with Access `read` and Objects
  `connection check`.
- **Engine names.** Use `mysql`, `postgres`, `mongodb`, `redis`, `memcached`, `aerospike`,
  `elasticsearch`, `s3`, `azureblob`, `gcs`, `dynamodb`, `firestore` and `firebase` (the Realtime
  Database). For another engine, write its product name in lower case.
- **A property inside an INI section.** Write `<section>.<key>`.
- **A value that is a placeholder of the deployment** (`%name%`, `${name}`, or the name of the
  property itself): the repository gives no value.

## Evidence

Each pointer is `<ID>@<first 12 of the commit>:<path> L<a>-<b>`, into this repository only, at the
commit you were given. Point at the narrowest range that shows the fact — the route line and its
handler signature, not the whole file. Two places for one key are one row with two pointers. The
check proves the file exists at the commit and the range ends inside it; the person who merges
reads whether the lines say what the row says.

## Parts

`scripts/plan-survey.mjs` cuts the files of the repository into parts of a fixed size or less. It
first leaves out the files that its rule table matches, such as vendored code, tests and data. A
single file over that size is a part of its own. A small repository is one part. The command
dispatches you once for each part, with the part id and the files of the part. Each file comes
with its size in bytes. Your part is exactly those files. Do not build the list again from the
folders, because the plan already left out the excluded files and the binary files.

- Read the files of your part. Read any other file of the clone that you need to settle a value.
  An example is a base address in a configuration file.
- Record a fact in the part whose files name it. A route, a client, a producer, a consumer, a
  scheduler, a manifest and a store configuration name a fact.
- A send names its destination where the code gives the literal, the constant or the property
  of the queue, the topic, the store or the address. A caller in your part can pass that name to
  a helper or an adapter in another part. Then your part records the row. Point at the call and
  at the helper.
- A generic helper or adapter that only receives the destination as an argument names nothing.
  Its part records no row for that send.
- Leave out a fact that only the files of another part name.
- A pointer can name a file outside your part, for example the configuration file that gives a
  value.
- Return a partial survey: the survey's shape, with two changes to the frontmatter. The kind is
  `service-survey-part`, and a fifth key, `part`, names the part id.
- Follow every rule of a survey in the part, with two exceptions:
  - An open point can name a key whose row is in another part.
  - The rows of a section can be in any order. The join sorts them by key.
- A part with no fact has every section empty: `None found.`, and `None.` for Open points. Return
  that part too.

```
---
kind: service-survey-part
repository: <ID>
commit: <the 40-character commit>
template: service-survey v6
part: P1
---
```

`scripts/join-survey.mjs` merges the parts into one survey. Rows of one section with one key
merge into one row. Two parts that give one key a different What or Provider cell are a
conflict. A library under Shared libraries in one part and under Third-party libraries in
another is a conflict too. The command then dispatches you once more as the part `R`, with the
conflicting rows and the part that gave each one. Return part `R` with one row for each
conflicting key.

The command checks your part when you return it, with `join-survey.mjs --check`. The check
gives the form findings of the part, and each self-call (§ Method step 3) to a key that your
part serves. Where it finds one, the command sends you the findings in the same dispatch, or in
a new dispatch when the runtime cannot continue one. Return the whole part again, with each
finding fixed. A self-call to a key that only another part serves comes later, from the join.

## The fact sheet

A plan of two parts or more lists fact files: configuration, constants, routers, HTTP helpers
and the root's README and INSTALL documents. `scripts/plan-survey.mjs` picks them by path. The
command dispatches you once for the fact sheet, before any part, with the paths of those files.
Read them, and any other file of the clone that settles a name. Return the sheet below. Never
copy a value that is a secret: write `secret, not copied` in its Value cell.

```
---
kind: service-survey-facts
repository: <ID>
commit: <the 40-character commit>
---

# Fact sheet of <ID>

## Stores

| Key | What | Evidence |
|---|---|---|

## Configuration properties

| Property | Holds | Value | Evidence |
|---|---|---|---|

## Routes

| Rule | Evidence |
|---|---|

## HTTP helpers

| Helper | Method | Evidence |
|---|---|---|
```

- Stores: one row for each store the code connects to, keyed as in § Writing keys. What names
  the engine and the logical name. A replica has a row of its own. Where a property gives the
  name of a store, the Stores row uses the value, and the property has its own row under
  Configuration properties.
- Configuration properties: each property that holds a host, a base address, a queue, a topic,
  a bucket or a database name. Holds is one of `host`, `base address`, `queue`, `topic`,
  `bucket` and `database`. Value is the value the repository gives, `none in the repository`,
  or `secret, not copied`.
- Routes: each rule that turns a request path into a handler: the router's prefix rules, the
  base path, the document root and the paths that skip the rewrite.
- HTTP helpers: each function that sends HTTP requests for other code, with the method rule it
  uses. An example is "the method is the second argument".
- Every row has a pointer, as in § Evidence. A table with no row holds `None found.`
- The sheet holds names and rules only. It holds no row of a survey section.
- One store key or one property has one row.

The command checks the sheet with `plan-survey.mjs --check-facts` before any part starts. The
check proves every pointer against the clone. Where it finds a fault, the command sends you
the findings. Return the whole sheet again, with each finding fixed.

The command gives the sheet to every part seat. In a part:

- Use the sheet's key for a store, and the sheet's property name in a placeholder key. Two
  parts then give one fact one key.
- The sheet is not evidence. Read the lines of a sheet row before you rest a row on them. Point
  at those lines, not at the sheet.
- Where the code of your part disagrees with the sheet, the code wins. Record the fact from the
  code.

## A refresh

The command hands you the rows of your part to look at again, and the files changed since the
previous survey's commit. Look at those rows and at every added or changed file of your part for
new facts. A row whose only evidence was deleted is dropped unless you find the fact elsewhere.
Each row you keep gets new pointers at the commit you were given. Return only the rows of your
part. A script carries every other row, and re-pins its pointers at the new commit. Never
re-survey the whole repository on a refresh. That is a full survey, and the command asks for one
when it wants one.

## Secrets

Never copy a secret into the survey — not a password, a token, a key, a connection string with a
password in it, masked or truncated. `check-survey.mjs` refuses the shapes it knows.

Report the location of each secret that you see in the code, in the `## Secrets` block of your
summary. The Gitleaks scan does not find every secret, and the command gives your locations to
the security role. Write one line for each location, and never the value:

```
## Secrets
- <path> L<a>-<b>: <kind>
```

The kind is one of `password`, `token`, `key` or `connection string`. Write `None.` when you see
no secret.

## Size

A survey has no line cap. Scripts read its rows, and no seat loads it whole. Write every row the
code shows. The one limit is yours: one part returns whole, in one reply. A part too long for one
reply is an escalation, never a trimmed part, because a missing row is a reader nobody moves. The
command then cuts the part into two halves and dispatches each half.

## Never

- Never write a row without a pointer, or a pointer into another repository.
- Never guess a provider; `external:<host>` only where the code or its configuration names the
  host, and `unknown` where nothing names it.
- Never write a key in an open point that is not also a row. The row can be in another part.
- Never write "should", "risk", or advice. Describe.
- Never add a date, an author or a section the template does not have.
- Never leave the template's comment or its example rows in the survey.
