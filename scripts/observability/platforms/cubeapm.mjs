// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-26
/**
 * cubeapm.mjs — the platform adapter for CubeAPM: one JSON object per line, posted to its
 * JSON-lines logs endpoint. `service.name` makes the stream, and every other field stays a field.
 *
 * The hub's id travels in the record's own `hub` field, never in `env`. On a live run of 2026-10-28,
 * CubeAPM showed `env` as UNSET: it does not keep the value a sender gives it. So a query for one
 * hub filters on `hub`.
 *
 * `_time` is the send time, because an observability platform refuses records stamped too far back.
 * The calls' own times stay on the record, as `first_call_at` and `last_call_at`, and a work-time
 * record keeps its own times too. `_msg` names the seat, or a work-time record's type, and the key,
 * never content. The write token goes in the Authorization header. A hub with "auth": "none" gives
 * no token, and the request then carries no Authorization header.
 *
 * CubeAPM answers 400 "unsupported path requested" to a path it does not serve. `isWrongPath` tells
 * the sender that this answer is about the URL, not the records.
 *
 * Node standard library only.
 */

export const NAME = 'cubeapm';

/** A line's message: a tokens record's seat, or a work-time record's type with its agent or gate, then the key. */
function messageOf(r) {
  const who = r.type === 'tokens' ? r.agent : [r.type, r.agent ?? r.gate].filter(Boolean).join(' ');
  return `${who} ${r.story || r.feature || r.command}`;
}

/** The request for one batch of records: { url, headers, body }. */
export function request(records, { url, token, sendMs }) {
  const time = new Date(sendMs).toISOString();
  const lines = records.map((r) => JSON.stringify({
    _time: time,
    _msg: messageOf(r),
    'service.name': 'harness',
    ...r,
  }));
  return {
    url: `${url.replace(/\/+$/, '')}/api/logs/insert/jsonline?_stream_fields=service.name`,
    headers: { 'content-type': 'application/stream+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: `${lines.join('\n')}\n`,
  };
}

/** True when CubeAPM says it serves no such path: the URL is wrong, not the records. */
export function isWrongPath(status, answer) {
  return status === 400 && answer.trimStart().startsWith('unsupported path requested');
}
