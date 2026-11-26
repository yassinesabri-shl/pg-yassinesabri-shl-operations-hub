// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-26
/**
 * grafana.mjs — the platform adapter for Grafana: one push of labelled streams to its Loki
 * collector.
 *
 * The labels stay few: `job`, `hub` and `type`. `story`, `run_id` and every other field with many
 * values stay inside the line, never in a label. The timestamp is the send time, in nanoseconds,
 * because the collector refuses lines stamped too far back. The collector has no login of its own:
 * the write token goes to the proxy in front of it, in the Authorization header. A hub with
 * "auth": "none" gives no token, and the request then carries no Authorization header.
 *
 * Node standard library only.
 */

export const NAME = 'grafana';

/** The request for one batch of records: { url, headers, body }. */
export function request(records, { url, hub, token, sendMs }) {
  const ns = `${BigInt(Math.round(sendMs)) * 1000000n}`;
  const streams = new Map();
  for (const r of records) {
    const type = r.type || 'tokens';
    if (!streams.has(type)) streams.set(type, { stream: { job: 'harness', hub, type }, values: [] });
    streams.get(type).values.push([ns, JSON.stringify(r)]);
  }
  return {
    url: `${url.replace(/\/+$/, '')}/loki/api/v1/push`,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ streams: [...streams.values()] }),
  };
}
