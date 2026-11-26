// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-26
/**
 * record.mjs — the one record form that leaves the laptop, `harness-observability/1`, and the rule
 * that keeps content out of it.
 *
 * A record carries counts, times, keys and ids, the person who ran the command, in `person`: a
 * GitHub login or an e-mail address (person.mjs), and the Jira URLs of its story's ticket and its
 * feature's Epic, in one narrow shape. It never carries a prompt, a command argument other than a
 * key or a slug, a path, a file's content, a tool's input or output, or the assistant's text.
 * `validateRecord` enforces that by shape: a field that is not on its type's list
 * is refused, and every text field must match a narrow pattern, so free text cannot pass.
 *
 * Every record names its bucket in `scope`, and where its key came from in `key_from` (runs.mjs).
 * Its `type` says what it holds:
 *   tokens           one agent's token counts and cost, for one run, model and price tier
 *   work             one turn of the main session, or one activation of a seat
 *   wait-in-session  one wait for the person inside a run: a reply, a question or a permission prompt
 *   command          one harness command's elapsed time, with its busy, waiting and unexplained time,
 *                    and the pickup after the human gate that the command follows
 *   failure          one harness failure: a harness script's exit 2, 3 or 4, or a turn the runtime failed
 *   gate             one merge of a human gate: the time from the pull request's last hand-off to the
 *                    merge. A GitHub workflow writes it at the merge (observability-gate.mjs), never a laptop
 * The types after tokens add fields and change none, so all six share one record form. A `gate`
 * record has no run, no command and no `person`: a person's merge is no harness command.
 *
 * Node standard library only.
 */
import { COUNTS, ORCHESTRATOR, SCHEMA, isJiraKey, isKey, isSlug, isTicketUrl, iso, keyOfTicketUrl, secs, sha256 } from './common.mjs';
import { HARNESS_SCRIPTS, OUTCOMES, RUNTIME_OUTCOME, SCRIPT_REASONS, SOURCES, isFailureExit } from './failures.mjs';
import { isPerson } from './person.mjs';
import { KEY_SOURCES, SCOPES, bucketOf } from './runs.mjs';

/** Every field a tokens record may carry, in the order a reader scans them. */
export const FIELDS = [
  'schema', 'type', 'record_id',
  'hub', 'scope', 'story', 'ticket_url', 'feature', 'epic', 'epic_url', 'defect_of', 'key_from',
  'command', 'run_id', 'person', 'agent',
  'runtime', 'runtime_version', 'collector',
  'model_provider', 'model', 'log_ref',
  'calls', 'first_call_at', 'last_call_at',
  'tokens_input', 'tokens_cache_read', 'tokens_cache_write', 'tokens_cache_write_5m', 'tokens_cache_write_1h',
  'tokens_output', 'tokens_reasoning',
  'cost_usd', 'price_table', 'price_tier',
  'harness', 'synthetic',
];

/**
 * What a record holds, in its `type`. `tokens` holds token counts and cost. The next four hold work
 * time, and `failure` holds one harness failure.
 */
export const TYPES = Object.freeze(['tokens', 'work', 'wait-in-session', 'command', 'failure', 'gate']);
/** The gates of a wait for the person inside a run. */
export const SESSION_GATES = Object.freeze(['reply', 'question', 'permission-prompt']);
/** The gates of a merge: the human gates of a feature and of a story. */
export const MERGE_GATES = Object.freeze(['requirements-merge', 'decomposition-merge', 'design-merge', 'story-merge', 'validation-merge']);

const HEAD = ['schema', 'type', 'record_id', 'hub', 'scope', 'story', 'ticket_url', 'feature', 'epic', 'epic_url', 'defect_of', 'key_from', 'command', 'run_id'];
/** Where a gate record's key comes from: the pull request that merged, never a run. */
export const GATE_KEY_FROM = 'pull-request';
/** The fields that the sender adds to a command record: the pickup, and the part of its waits that a gate counts. */
export const PICKUP_FIELDS = Object.freeze(['previous_gate', 'previous_gate_merged_at', 'pickup_s', 'gate_wait_s']);
const SOURCE = ['runtime', 'runtime_version', 'collector'];
const TAIL = ['harness', 'synthetic'];
/** Every field that each type may carry, in the order a reader scans them. */
export const TYPE_FIELDS = Object.freeze({
  tokens: FIELDS,
  work: [...HEAD, 'person', 'agent', ...SOURCE, 'log_ref', 'started_at', 'ended_at', 'duration_s', 'model_s', 'tool_s', ...TAIL],
  'wait-in-session': [...HEAD, 'person', 'gate', ...SOURCE, 'log_ref', 'started_at', 'ended_at', 'duration_s', 'gate_wait_s', ...TAIL],
  command: [...HEAD, 'person', ...SOURCE, 'started_at', 'ended_at', 'duration_s', 'busy_s', 'wait_s', 'gate_wait_s', 'unexplained_s', 'previous_gate', 'previous_gate_merged_at', 'pickup_s', ...TAIL],
  failure: [...HEAD, 'person', 'agent', 'source', 'check', 'exit_code', 'outcome', 'reason', ...SOURCE, 'log_ref', 'started_at', 'ended_at', 'duration_s', ...TAIL],
  gate: [...HEAD, 'gate', 'routed_to', 'repository', 'pull_request', ...SOURCE, 'opened_at', 'handoff_at', 'started_at', 'merged_at', 'gate_s', ...TAIL],
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const COLLECTOR = /^[a-z0-9-]+\/\d+$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const HEX = /^[0-9a-f]{7,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIER = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const REASON = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** Each duration is rounded to the millisecond, so a whole and the sum of its parts can differ by this much, in seconds. */
const SLACK_S = 0.003;

const fits = (value, pattern) => typeof value === 'string' && value.search(pattern) === 0;
const orNull = (value, test) => value === null || test(value);
const seconds = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isTime = (v) => fits(v, ISO_TIME);

/**
 * The id a record keeps through every retry: the same calls with the same counts always give the
 * same id, so the observability platform can find a duplicate and the queue never holds two copies.
 */
export function recordId({ runtime, logRef, runId, model, tier, calls }) {
  const sorted = [...calls].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const body = sorted.map((c) => [c.id, ...COUNTS.map((f) => c.after[f])]);
  return sha256(JSON.stringify([runtime, logRef, runId, model, tier ?? null, body]));
}

/** The id a work-time record keeps through every retry: the same piece of time always gives the same id. */
export const timeRecordId = (parts) => sha256(JSON.stringify(['time', ...parts]));

/** Every rule a record breaks, as a list of short findings without the offending value. Empty is valid. */
export function validateRecord(r) {
  const problems = [];
  if (!r || typeof r !== 'object' || Array.isArray(r)) return ['the record is not an object'];
  const time = TYPES.includes(r.type) && r.type !== 'tokens';
  const fields = TYPE_FIELDS[time ? r.type : 'tokens'];
  for (const k of Object.keys(r)) if (!fields.includes(k)) problems.push(`field ${k} is not allowed on a record`);
  const need = (name, ok) => { if (!ok) problems.push(`field ${name} has a value of the wrong shape`); };
  need('schema', r.schema === SCHEMA);
  need('type', TYPES.includes(r.type));
  need('record_id', fits(r.record_id, HEX));
  need('hub', fits(r.hub, ID));
  need('story', orNull(r.story, isKey));
  need('feature', orNull(r.feature, isSlug));
  ticketRules(r, need, problems);
  need('defect_of', orNull(r.defect_of, isKey));
  need('scope', SCOPES.includes(r.scope));
  const gate = r.type === 'gate';
  need('key_from', gate ? r.key_from === GATE_KEY_FROM : r.key_from === null || KEY_SOURCES.includes(r.key_from));
  // A story record has a story, and a feature record a feature and no story. The other two have no key and no source.
  const keyless = !r.story && !r.feature && r.key_from === null;
  const agrees = (r.scope === 'story' && Boolean(r.story)) || (r.scope === 'feature' && !r.story && Boolean(r.feature))
    || ((r.scope === 'estate' || r.scope === 'none') && keyless);
  if (SCOPES.includes(r.scope) && !agrees) problems.push(`field scope is ${r.scope}, which does not agree with the record's story, feature and key_from`);
  // A gate is a person's merge, so it has no command and no run. It always has a story or a feature.
  need('command', gate ? r.command === null : fits(r.command, NAME));
  need('run_id', gate ? r.run_id === null : fits(r.run_id, UUID));
  if (gate && r.scope !== 'story' && r.scope !== 'feature') problems.push('a gate record needs a story or a feature');
  // A record queued before the field existed has none. Any other record names a person, or null.
  if (fields.includes('person') && 'person' in r) need('person', orNull(r.person, isPerson));
  if (gate) gateRules(r, need, problems);
  else if (time) timeRules(r, need, problems);
  else tokensRules(r, need);
  need('harness', orNull(r.harness, (v) => fits(v, HEX)));
  if ('synthetic' in r) need('synthetic', r.synthetic === true);
  return problems;
}

/**
 * The Jira fields, which the sender fills from the hub's trunk. A story's ticket needs the story, and
 * an Epic needs the feature. `epic` is the key at the end of `epic_url`, so the two name one Epic.
 */
function ticketRules(r, need, problems) {
  need('ticket_url', orNull(r.ticket_url, isTicketUrl));
  need('epic', orNull(r.epic, isJiraKey));
  need('epic_url', orNull(r.epic_url, isTicketUrl));
  if (isTicketUrl(r.ticket_url) && !r.story) problems.push('field ticket_url is set on a record with no story');
  if (isJiraKey(r.epic) && !r.feature) problems.push('field epic is set on a record with no feature');
  const epicOk = orNull(r.epic, isJiraKey) && orNull(r.epic_url, isTicketUrl);
  if (epicOk && (r.epic ?? null) !== (r.epic_url ? keyOfTicketUrl(r.epic_url) : null)) problems.push('fields epic and epic_url do not name the same Epic');
}

function sourceRules(r, need) {
  need('runtime', fits(r.runtime, NAME));
  need('runtime_version', orNull(r.runtime_version, (v) => fits(v, VERSION)));
  need('collector', fits(r.collector, COLLECTOR));
}

function tokensRules(r, need) {
  need('agent', fits(r.agent, NAME));
  sourceRules(r, need);
  need('model_provider', fits(r.model_provider, NAME));
  need('model', fits(r.model, MODEL));
  need('log_ref', fits(r.log_ref, ID));
  need('calls', Number.isInteger(r.calls) && r.calls > 0);
  need('first_call_at', fits(r.first_call_at, ISO_TIME));
  need('last_call_at', fits(r.last_call_at, ISO_TIME));
  for (const f of COUNTS) {
    const v = r[`tokens_${f}`];
    const optional = f === 'cache_write_5m' || f === 'cache_write_1h' || f === 'reasoning';
    need(`tokens_${f}`, (optional && v === null) || (Number.isInteger(v) && v >= 0));
  }
  need('cost_usd', r.cost_usd === null || (typeof r.cost_usd === 'number' && Number.isFinite(r.cost_usd) && r.cost_usd >= 0));
  need('price_table', orNull(r.price_table, (v) => fits(v, DATE)));
  need('price_tier', orNull(r.price_tier, (v) => fits(v, TIER)));
}

/**
 * A failure's own fields. A script failure names a script on the list and an exit code of 2, 3 or 4,
 * with that code's outcome, and its reason is a token of the fixed list. A runtime failure names no
 * script and no code, and its reason is the runtime's own type of error.
 */
function failureRules(r, need) {
  need('source', SOURCES.includes(r.source));
  if (r.source === 'script') {
    need('reason', orNull(r.reason, (v) => SCRIPT_REASONS.includes(v)));
    need('check', HARNESS_SCRIPTS.includes(r.check));
    need('exit_code', isFailureExit(r.exit_code));
    need('outcome', isFailureExit(r.exit_code) && r.outcome === OUTCOMES[r.exit_code]);
  } else if (r.source === 'runtime') {
    need('reason', orNull(r.reason, (v) => fits(v, REASON)));
    need('check', r.check === null);
    need('exit_code', r.exit_code === null);
    need('outcome', r.outcome === RUNTIME_OUTCOME);
  }
}

/**
 * A gate's own fields. The gate wait runs from `started_at` to `merged_at`: from the pull request's
 * last hand-off, or for a story's merge from the later of that and the validation report's merge.
 * The pull request opened before both. A story's gates have a story key, and a feature's a feature.
 */
function gateRules(r, need, problems) {
  need('gate', MERGE_GATES.includes(r.gate));
  const storyGate = ['design-merge', 'story-merge', 'validation-merge'].includes(r.gate);
  if (MERGE_GATES.includes(r.gate) && (storyGate ? r.scope !== 'story' : r.scope !== 'feature')) problems.push(`a ${r.gate} record needs a ${storyGate ? 'story' : 'feature with no story'}`);
  need('routed_to', orNull(r.routed_to, (v) => fits(v, NAME)));
  need('repository', fits(r.repository, ID));
  need('pull_request', Number.isInteger(r.pull_request) && r.pull_request > 0);
  sourceRules(r, need);
  for (const f of ['opened_at', 'started_at', 'merged_at']) need(f, isTime(r[f]));
  need('handoff_at', orNull(r.handoff_at, isTime));
  need('gate_s', seconds(r.gate_s));
  if (![r.opened_at, r.started_at, r.merged_at].every(isTime)) return;
  const at = (v) => Date.parse(v);
  if (at(r.started_at) > at(r.merged_at)) problems.push('the gate wait starts after the merge');
  if (at(r.opened_at) > at(r.merged_at)) problems.push('the pull request opened after its merge');
  if (isTime(r.handoff_at) && at(r.handoff_at) > at(r.merged_at)) problems.push('the hand-off is after the merge');
  if (isTime(r.handoff_at) && at(r.started_at) < at(r.handoff_at)) problems.push('the gate wait starts before the hand-off');
  const span = (at(r.merged_at) - at(r.started_at)) / 1000;
  if (seconds(r.gate_s) && Math.abs(r.gate_s - span) > SLACK_S) problems.push('field gate_s is not the time from started_at to merged_at');
}

/**
 * The pickup fields that the sender adds to a command record. They are absent on a record that the
 * sender has not prepared, and all null when the command follows no gate or no merge was found.
 */
function pickupRules(r, need, problems) {
  if (!('previous_gate' in r) && !('previous_gate_merged_at' in r) && !('pickup_s' in r)) return;
  need('previous_gate', orNull(r.previous_gate, (v) => MERGE_GATES.includes(v)));
  need('previous_gate_merged_at', orNull(r.previous_gate_merged_at, isTime));
  need('pickup_s', orNull(r.pickup_s, seconds));
  const set = [r.previous_gate, r.previous_gate_merged_at, r.pickup_s].filter((v) => v !== null && v !== undefined).length;
  if (set !== 0 && set !== 3) problems.push('fields previous_gate, previous_gate_merged_at and pickup_s are set together or not at all');
  if (set === 3 && isTime(r.previous_gate_merged_at) && isTime(r.started_at) && seconds(r.pickup_s)) {
    const span = (Date.parse(r.started_at) - Date.parse(r.previous_gate_merged_at)) / 1000;
    if (Math.abs(r.pickup_s - span) > SLACK_S) problems.push('field pickup_s is not the time from previous_gate_merged_at to started_at');
  }
}

function timeRules(r, need, problems) {
  if (r.type === 'work' || r.type === 'failure') need('agent', fits(r.agent, NAME));
  if (r.type === 'failure') failureRules(r, need);
  if (r.type === 'wait-in-session') need('gate', SESSION_GATES.includes(r.gate));
  if (r.type === 'command') pickupRules(r, need, problems);
  sourceRules(r, need);
  if (r.type === 'work' || r.type === 'wait-in-session' || r.type === 'failure') need('log_ref', fits(r.log_ref, ID));
  need('duration_s', seconds(r.duration_s));
  clockRules(r, need, problems);
  partRules(r, need, problems);
}

/** The interval's clock times: it starts at started_at, ends no earlier, and lasts duration_s. */
function clockRules(r, need, problems) {
  need('started_at', isTime(r.started_at));
  need('ended_at', isTime(r.ended_at));
  if (!isTime(r.started_at) || !isTime(r.ended_at)) return;
  const span = (Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000;
  if (span < 0) problems.push('the interval ends before started_at');
  else if (seconds(r.duration_s) && Math.abs(r.duration_s - span) > SLACK_S) problems.push('field duration_s is not the time from started_at to the interval\'s end');
}

/** The rules of each type's parts. A whole is never smaller than its parts, and a command's parts make its whole. */
const PART_RULES = {
  failure() {},
  work(r, need, problems, whole) {
    need('model_s', seconds(r.model_s));
    need('tool_s', seconds(r.tool_s));
    if (whole !== null && seconds(r.model_s) && seconds(r.tool_s) && r.model_s + r.tool_s > whole + SLACK_S) problems.push('fields model_s and tool_s add up to more than duration_s');
  },
  // The part of the waits that a gate record counts is `gate_wait_s`, outside `wait_s`. It is absent
  // or null before the sender prepares the record.
  command(r, need, problems, whole) {
    for (const f of ['busy_s', 'wait_s', 'unexplained_s']) need(f, seconds(r[f]));
    if ('gate_wait_s' in r) need('gate_wait_s', orNull(r.gate_wait_s, seconds));
    const parts = [r.busy_s, r.wait_s, r.unexplained_s, r.gate_wait_s ?? 0];
    if (whole !== null && parts.every(seconds) && Math.abs(parts.reduce((s, v) => s + v, 0) - whole) > SLACK_S) problems.push('fields busy_s, wait_s, gate_wait_s and unexplained_s do not add up to duration_s');
  },
  'wait-in-session'(r, need, problems, whole) {
    if ('gate_wait_s' in r) need('gate_wait_s', orNull(r.gate_wait_s, seconds));
    if (whole !== null && seconds(r.gate_wait_s) && r.gate_wait_s > whole + SLACK_S) problems.push('field gate_wait_s is more than duration_s');
  },
};

function partRules(r, need, problems) {
  PART_RULES[r.type](r, need, problems, seconds(r.duration_s) ? r.duration_s : null);
}

/**
 * A gate record in field order: one merge of a human gate. `key` is { story } or { feature }, and
 * `times` holds the clock times in milliseconds: opened, handoff (or null), started and merged.
 * `ctx` holds the hub, the library commit and the source. `jira` holds the story's ticket and the
 * feature's Epic, as the sender takes them from the hub's trunk. Its id is the hub, the repository,
 * the pull request and the gate, so a second send of one merge has the same id.
 */
export function buildGateRecord({ ctx, gate, key, repository, pullRequest, routedTo = null, times, jira = {} }) {
  const story = key.story ?? null;
  const feature = key.feature ?? null;
  const record = {
    schema: SCHEMA,
    type: 'gate',
    record_id: sha256(JSON.stringify(['gate', ctx.hub, repository, pullRequest, gate])),
    hub: ctx.hub,
    scope: story ? 'story' : 'feature',
    story,
    ticket_url: (story && jira.ticket_url) || null,
    feature,
    epic: (feature && jira.epic) || null,
    epic_url: (feature && jira.epic_url) || null,
    defect_of: null,
    key_from: GATE_KEY_FROM,
    command: null,
    run_id: null,
    gate,
    routed_to: routedTo,
    repository,
    pull_request: pullRequest,
    runtime: ctx.runtime,
    runtime_version: ctx.runtimeVersion ?? null,
    collector: ctx.collector,
    opened_at: iso(times.opened),
    handoff_at: times.handoff === null ? null : iso(times.handoff),
    started_at: iso(times.started),
    merged_at: iso(times.merged),
    gate_s: secs(times.merged - times.started),
    harness: ctx.harness ?? null,
  };
  if (ctx.synthetic) record.synthetic = true;
  return record;
}

/** A record's fields in its type's order. A field that is not on the list stays last, so validateRecord refuses it. */
function inOrder(r) {
  const order = TYPES.includes(r.type) ? TYPE_FIELDS[r.type] : FIELDS;
  const keys = [...order.filter((f) => f in r), ...Object.keys(r).filter((k) => !order.includes(k))];
  return Object.fromEntries(keys.map((f) => [f, r[f]]));
}

/** A record in field order, built from one group of calls (delta.mjs) and the hub's context. */
export function buildRecord(group, ctx) {
  const totals = {};
  for (const f of COUNTS) {
    const values = group.calls.map((c) => c.diff[f]);
    totals[f] = values.every((v) => v === null) ? null : values.reduce((s, v) => s + (v ?? 0), 0);
  }
  const times = group.calls.map((c) => c.ms);
  const key = { story: group.run.story ?? null, feature: group.run.feature ?? null, command: group.run.command };
  const { scope, key_from: keyFrom } = bucketOf(key, group.run);
  const record = {
    schema: SCHEMA,
    type: 'tokens',
    record_id: recordId({ runtime: ctx.runtime, logRef: ctx.logRef, runId: group.run.run_id, model: group.model, tier: group.tier, calls: group.calls }),
    hub: ctx.hub,
    scope,
    story: key.story,
    ticket_url: null,
    feature: key.feature,
    epic: null,
    epic_url: null,
    defect_of: null,
    key_from: keyFrom,
    command: group.run.command,
    run_id: group.run.run_id,
    person: group.run.person ?? null,
    agent: ctx.seat ?? ORCHESTRATOR,
    runtime: ctx.runtime,
    runtime_version: ctx.runtimeVersion ?? null,
    collector: ctx.collector,
    model_provider: group.provider,
    model: group.model,
    log_ref: ctx.logRef,
    calls: group.calls.length,
    first_call_at: new Date(Math.min(...times)).toISOString(),
    last_call_at: new Date(Math.max(...times)).toISOString(),
  };
  for (const f of COUNTS) record[`tokens_${f}`] = totals[f];
  record.cost_usd = null;
  record.price_table = null;
  record.price_tier = group.tier ?? null;
  record.harness = ctx.harness ?? null;
  if (ctx.synthetic) record.synthetic = true;
  return record;
}

/**
 * A work-time record of `type` in field order: one piece of time from `start` to `end`, in
 * milliseconds, of the run `run`. `own` holds the type's own fields, and `ctx` the hub's and the
 * log's, as for buildRecord. `logRef` names the log of a turn, an activation or a wait in a session.
 */
export function buildTimeRecord(type, { run, ctx, start, end, own = {}, logRef = null }) {
  const key = { story: run.story ?? null, feature: run.feature ?? null, command: run.command };
  const { scope, key_from: keyFrom } = bucketOf(key, run);
  const record = {
    schema: SCHEMA,
    type,
    record_id: timeRecordId([type, ctx.runtime, logRef, run.run_id, start, end, own.agent ?? own.gate ?? null]),
    hub: ctx.hub,
    scope,
    story: key.story,
    ticket_url: null,
    feature: key.feature,
    epic: null,
    epic_url: null,
    defect_of: null,
    key_from: keyFrom,
    command: run.command,
    run_id: run.run_id,
    ...own,
    runtime: ctx.runtime,
    runtime_version: ctx.runtimeVersion ?? null,
    collector: ctx.collector,
    started_at: iso(start),
    duration_s: secs(end - start),
    harness: ctx.harness ?? null,
  };
  if (logRef) record.log_ref = logRef;
  if (TYPE_FIELDS[type].includes('person')) record.person = run.person ?? null;
  if (TYPE_FIELDS[type].includes('ended_at')) record.ended_at = iso(end);
  if (ctx.synthetic) record.synthetic = true;
  return inOrder(record);
}

/**
 * A record as it leaves the queue: with its bucket, and in its type's field order. Its id and its
 * counts stay as they are. A field that is not on the list stays too, so validateRecord refuses it.
 * The one exception is `collector_tested`, which a record queued by an older library carries. It
 * leaves without it.
 */
export function leaving(record, bucket) {
  const { collector_tested: _old, ...rest } = record;
  return inOrder({ ...rest, ...bucket });
}
