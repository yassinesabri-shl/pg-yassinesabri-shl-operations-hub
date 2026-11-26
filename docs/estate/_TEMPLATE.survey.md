---
kind: service-survey
repository: <ID>
commit: <the 40-character commit the repository was read at>
template: service-survey v6
---

<!--
  Service survey template, v6. Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-28

  One survey per repository on the hub's list, at docs/estate/surveys/<ID>.md,
  written by /survey-repo and proved by scripts/check-survey.mjs. It says what
  the repository serves, what it calls and in which repository or at which
  third party's host, which data stores it touches, and which libraries it
  uses: shared inside the estate, or a third party's. It points; it is never
  cited as authority and never outranks a contract.

  The shape is fixed, and the check refuses anything else:
  - The four frontmatter keys above and no others. No date: the commit dates it.
  - The title, the disclaimer paragraph word for word, and the seven sections in
    this order, each "## ", nothing between or after them.
  - Every section holds one table. An empty one is the single line
    "None found.", or "None." for Open points.
  - Every row but an open point opens with a key, rows sorted by key, one key
    per row. A seat's part can hold its rows in any order. The join sorts them.
      http:<METHOD>:<path>   METHOD in capitals, or ANY for a route that
                             accepts every method; path in lower case,
                             except on a call to external:<host>, where it
                             keeps the case the code gives it; parameters
                             as {snake_case}; a segment can mix text and
                             parameters ({action}-instance), never two
                             parameters side by side; a :verb only at the
                             end of the last segment ({id}:detectIntent);
                             the version kept; no trailing slash, no host,
                             no query
      event:<topic>  queue:<name>  job:<name>
      event:{<property>}  queue:{<property>}  where the name is only a
                             configuration placeholder, the property name
                             as the code spells it
      store:<engine>:<name>  the logical store; its tables go in Objects
      store:<engine>:{<property>}  where the store's name is only a
                             configuration placeholder
      lib:<package>          the package name as the manifest spells it
    Serves and Calls take http, event, queue and job keys; Data stores takes
    store keys; both library sections take lib keys, and a library is in one
    of them, never both.
  - Provider is a repository id from docs/estate/repositories.json;
    external:<host> for a third party: the host the call reaches, lower case,
    no scheme, port or path (external:api.example.com); or unknown, where the
    code and its configuration name no host and no repository. A call with an
    unknown provider is still a row, so a reader of the key can find it.
    A call whose whole address is one property with no value has no path. It
    is one open point that names the property, and never a row: a key such
    as http:POST:/{send_email_url} matches every one-segment path.
    A call is a request to an API. A page's load of a stylesheet, a script,
    a font, an image or an icon is not a call, and the survey leaves it out.
    Access is read, write or read-write. Version is what the manifest declares, or "any" where it
    declares none.
  - A library row points only at a manifest that the plan of /survey-repo lists: a manifest at
    the top of its kind, a member of a workspace, or a dependency list that a build file names.
  - An open point is what the code shows but the grammar cannot key. Its
    Unresolved cell says what is open, Owner names a role, and Resolves the
    trigger that settles it. Open points are in no fixed order. A key written
    in an open point must also be a row: the check refuses one that is not,
    because only rows are read. Who serves the calls under Provider unknown
    may be an open point, once per base address, naming the base and not
    listing the calls.
  - Evidence is one or more <ID>@<first 12 of commit>:<path> L<a>-<b>, joined
    by ", ". Every pointer is proved against the repository at the commit.
  - No line cap: scripts read the rows. No HTML, no comments, no code
    fences: delete this one.
  - Write a placeholder as {word} in every cell, Objects and open points
    included. Never write <word> outside a code span. A reader's view shows it
    as an HTML tag and hides it, and the check refuses it. Inside a code span,
    such as `/opt/<sid>.sh`, a reader sees the text, and the check accepts it.
  - Section 7 lists the files the survey did not read. Every row is a rule, a
    folder, a count of files and a count of bytes. Files and Bytes are whole
    numbers with no separator. A folder ends in "/", or is "./" for the root of
    the repository. A "|" in a folder is written "\|".
    The rules, in the order of their table, are:
      archive    a file with the extension .phar, .jar, .war, .zip, .gz, .tgz
                 or .7z
      vendored   a folder named vendor, node_modules, third_party,
                 bower_components, dist, stub or stubs, or a folder below the
                 root that directly holds a licence document: a file named
                 LICENSE, LICENCE or COPYING, with an optional "-<word>" and
                 an optional extension .txt, .md, .markdown, .rst, .lib or
                 .lesser. Also a code file whose first 4096 bytes name a
                 third-party licence: the text of MIT, BSD, Apache, GPL or
                 MPL, or an @license tag that names one. A line
                 SPDX-License-Identifier alone is not enough
      test       a folder named tests, specs, __tests__, __mocks__, mock,
                 mocks, fixtures, testdata or e2e, a folder named test or
                 spec at the root or directly below a folder named src, or a
                 file named *.test.*, *.spec.*, *_test.* or *-test.*. A
                 folder named test or spec in another place is read, because
                 it can be a module of the service. A folder named simulator
                 is read, because a simulator can serve real routes
      migration  a folder named migrations, migration, migrate, seeds,
                 seeders or seed, or the folder pair db/changelog or
                 alembic/versions
      locale     a folder named translations, locale, locales, i18n or lang
      ci         a folder named .github or .circleci, or a file named
                 .gitlab-ci.yml or Jenkinsfile
      harness    the files the harness installs in a spoke: the folder
                 .githooks and the file checks.env, at the root
      lock       a file named composer.lock, package-lock.json, yarn.lock,
                 pnpm-lock.yaml, Gemfile.lock, poetry.lock, go.sum or
                 Cargo.lock. The manifest beside it is read
      data       a file with the extension .sql, .csv or .tsv, or a .json
                 file of more than 16384 bytes where at least 80% of the
                 characters are digits, "-", ".", ",", "[", "]" or white
                 space. This rule, the vendored rule and the markup rule read
                 content
      asset      a file with the extension .css, .scss, .less, .map, .svg,
                 .min.js or .min.css
      markup     a file with the extension .tpl, .html or .htm that holds
                 no sign of a call: no AJAX or fetch call, no
                 XMLHttpRequest, no socket, no form with an action and no
                 frame of another host. A link, an image or a script file
                 that the page loads is not a call
      tiny       any other file of 16 bytes or less, except a manifest, a
                 requirements file, a workspace file or a build file
      size       any other file of more than 500000 bytes
    A file takes the first rule in this order that matches it. Names and
    extensions match without regard to case.
    A rule on a folder name (vendored, test, migration, locale, ci) gives one
    row for each folder at the match nearest the root of the repository. For
    the vendored rule, a match is a folder name or a licence-marked folder. The
    row counts every file below that folder that the rule took. A rule on a
    file name, the content or the size gives one row for each folder that
    directly holds a taken file. Rows sort by folder in code-unit order, then
    by the order of the rule table. A survey with no such file holds the single line "None found.".
    No seat writes this section. The join writes it, and the check builds it
    again from the commit.
    UNRESOLVED — a path-only override for a folder of own code that holds a licence document. Owner: harness lead. Resolves: the template version that adds the override.
  - Never a secret, not even a masked one. Its location goes in the pull
    request, for the security role.
-->

# Service survey: <ID>

Generated by /survey-repo from the repository at the commit above. It describes what the code does and points at it; it is never cited as authority and never outranks a contract. Where the two disagree, the contract wins and this survey is refreshed.

## 1. Serves

| Key | What | Evidence |
|---|---|---|
| <http:GET:/example/{id}> | <one line: what a caller gets> | <ID@123456789abc:src/routes/example.ts L10-24> |

## 2. Calls

| Key | Provider | Evidence |
|---|---|---|
| <http:POST:/example> | <repository id, external:<host>, or unknown> | <ID@123456789abc:src/clients/example.ts L5-18> |

## 3. Data stores

| Key | Access | Objects | Evidence |
|---|---|---|---|
| <store:postgres:example> | <read, write or read-write> | <table_one, table_two> | <ID@123456789abc:src/db/models.ts L1-40> |

## 4. Shared libraries

| Key | Version | Evidence |
|---|---|---|
| <lib:@example/shared-client> | <the version the manifest declares> | <ID@123456789abc:package.json L12-12> |

## 5. Third-party libraries

| Key | Version | Evidence |
|---|---|---|
| <lib:express> | <the version the manifest declares, or any> | <ID@123456789abc:package.json L14-14> |

## 6. Open points

| Unresolved | Owner | Resolves | Evidence |
|---|---|---|---|
| <what the survey could not pin down> | <role> | <the trigger that settles it> | <ID@123456789abc:src/clients/example.ts L20-26> |

## 7. Not read

| Rule | Folder | Files | Bytes |
|---|---|---|---|
| test | tests/ | 108 | 5904112 |
