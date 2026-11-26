# The human and agent entry point. One name, one implementation.
.PHONY: dev-ready
dev-ready:
	@HARNESS_TRUNK=main node scripts/check-dev-ready.js $(KEY)

.PHONY: test-gate
test-gate:
	@node tests/check-dev-ready/run.mjs

# The validation-report check, by hand, against the trunk: what /qa-sprint's
# final invocation runs before the work item moves to DONE.
.PHONY: validation
validation:
	@HARNESS_TRUNK=main node scripts/check-validation.js $(KEY)

.PHONY: test-validation
test-validation:
	@node tests/check-validation/run.mjs

# The spoke's qa-gate, by hand: is there a merged, passing report for this
# repository at this head commit? REPO is the spoke's id, HEAD the pull
# request's full head commit.
.PHONY: qa-gate
qa-gate:
	@HARNESS_TRUNK=main HARNESS_REPO=$(REPO) node scripts/check-qa-gate.mjs $(KEY) --head $(HEAD)

.PHONY: test-qa-gate
test-qa-gate:
	@node tests/check-qa-gate/run.mjs

# The requirements-document check and the decomposition check, by hand, against
# the trunk: what /decompose reads before it cuts, and before it creates.
.PHONY: requirements
requirements:
	@HARNESS_TRUNK=main node scripts/check-requirements.js $(SLUG)

.PHONY: test-requirements
test-requirements:
	@node tests/check-requirements/run.mjs

# The same check on the branch you are on, as requirements-gate runs it: a
# candidate trunk built from HEAD, never the branch ref. Refuses while anything
# under docs/requirements/ is uncommitted.
.PHONY: requirements-candidate
requirements-candidate:
	@HARNESS_TRUNK=main node scripts/check-requirements-candidate.mjs $(SLUG)

.PHONY: decomposition
decomposition:
	@HARNESS_TRUNK=main node scripts/check-decomposition.js $(SLUG)

.PHONY: test-decomposition
test-decomposition:
	@node tests/check-decomposition/run.mjs

# Is the feature finished? Derived from the hub's trunk and every spoke's trunk
# when asked, never stored. A report, not a gate.
.PHONY: fan-in
fan-in:
	@HARNESS_TRUNK=main node scripts/check-fan-in.mjs $(SLUG)

.PHONY: test-fan-in
test-fan-in:
	@node tests/check-fan-in/run.mjs

# How far the hub is behind the global context repository, by hand: what the
# global-report workflow runs each week. A report, not a gate.
.PHONY: report-global
report-global:
	@HARNESS_TRUNK=main node scripts/report-global.mjs

.PHONY: test-report-global
test-report-global:
	@node tests/report-global/run.mjs

# The escalation record, by hand: every escalation and the table CLAR-log.md shows. Reads the hub's
# [shl-harness] issues through gh, writes nothing.
.PHONY: escalations
escalations:
	@HARNESS_TRUNK=main node scripts/escalation.mjs print --all

.PHONY: test-escalation
test-escalation:
	@node tests/escalation/run.mjs

# The tracker connection and its links, by hand, offline: no tracker configured is a pass.
.PHONY: trackers
trackers:
	@node scripts/check-trackers.mjs

.PHONY: test-trackers
test-trackers:
	@node tests/check-trackers/run.mjs

.PHONY: test-jira
test-jira:
	@node tests/jira-sync/run.mjs

# The context /feedback adds to a ticket: a path never appears in it.
.PHONY: test-feedback
test-feedback:
	@node tests/feedback-context/run.mjs

# The harness watermark: the local commit check, the pull-request check, every path.
.PHONY: test-watermark
test-watermark:
	@node tests/check-watermark/run.mjs

# The commit checks every harness commit in a spoke must pass: format, lint, types.
.PHONY: test-staged
test-staged:
	@node tests/check-staged/run.mjs

# The two coverage floors: the trunk's checks.env, both figures, the record line.
.PHONY: test-coverage
test-coverage:
	@node tests/check-coverage/run.mjs

# The protected-test guard behind /dev-sprint: the TEST_GUARD_PATHS contract, the
# in-agent guard, the finalizer's one candidate commit and the acceptance.
.PHONY: test-guard
test-guard:
	@node tests/test-guard/run.mjs

# The one path from the harness to a story's pull request, against a fake GitHub.
.PHONY: test-pull-request
test-pull-request:
	@node tests/pull-request/run.mjs

# The test-quality scan behind every test-review critic launch and the spoke's story-gate step:
# the scanner and the hook against a scripted stand-in for semgrep. Needs nothing installed.
.PHONY: test-quality
test-quality:
	@node tests/test-quality/run.mjs

.PHONY: charters
charters:
	@node scripts/check-charters.mjs
	@node scripts/check-agent-registry.mjs

.PHONY: test-agent-registry
test-agent-registry:
	@node tests/check-agent-registry/run.mjs
