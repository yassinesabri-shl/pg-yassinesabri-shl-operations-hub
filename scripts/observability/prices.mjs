// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-26
/**
 * prices.mjs — the versioned list-price table (prices.json, beside this file) and the cost of a
 * record at list price: API-equivalent cost, a bill for API-key users and a comparison on
 * subscriptions.
 *
 * Every rate is stored as its own number. A model's row is found by its exact id first, then by the
 * id without a date suffix such as `-20251001` or `-2025-04-14`, and never by a shorter prefix:
 * `claude-opus-5` must not price `claude-opus-5-5`. A provider that `aliases` names reads the rows
 * of the provider it points to: Claude in Microsoft Foundry bills at Anthropic's rates. A model with
 * tiers is priced per call, so the collector puts each call in its tier before it adds calls up:
 * `fast` for a fast-mode call, otherwise the tier whose prompt-length limit the call fits. A row
 * with no cache-write rate prices a cache write at its input rate, as OpenAI and Google bill one. A
 * model with no row gets no cost, never a guessed one.
 *
 * Node standard library only.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const RATE_NAMES = ['input', 'cache_write_5m', 'cache_write_1h', 'cache_write', 'cache_read', 'output'];

export function loadPrices(path = join(HERE, 'prices.json')) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Every rule the table breaks, as findings. Empty means it is well formed. */
export function validatePrices(table) {
  const problems = [];
  if (!table || table.schema_version !== 1) problems.push('schema_version must be 1');
  if (!table || typeof table.version !== 'string' || table.version.search(/^\d{4}-\d{2}-\d{2}$/) !== 0) problems.push('version must be a date');
  if (!table || typeof table.effective_from !== 'string') problems.push('effective_from must be a date');
  const checkRates = (where, r) => {
    if (!r || typeof r !== 'object') { problems.push(`${where}: rates are missing`); return; }
    for (const [k, v] of Object.entries(r)) {
      if (!RATE_NAMES.includes(k)) problems.push(`${where}: ${k} is not a rate`);
      else if (typeof v !== 'number' || !(v >= 0)) problems.push(`${where}: ${k} must be a number of 0 or more`);
    }
    for (const k of ['input', 'cache_read', 'output']) if (!has(r, k)) problems.push(`${where}: ${k} is missing`);
    if (has(r, 'cache_write_1h') && !has(r, 'cache_write_5m')) problems.push(`${where}: a 1-hour cache-write rate needs a 5-minute one`);
  };
  const providers = (table && table.providers) || {};
  for (const [alias, target] of Object.entries((table && table.aliases) || {})) {
    if (has(providers, alias)) problems.push(`alias ${alias} is also a provider`);
    if (typeof target !== 'string' || !has(providers, target)) problems.push(`alias ${alias} points to no provider`);
  }
  for (const [provider, models] of Object.entries(providers)) {
    for (const [model, e] of Object.entries(models)) {
      const where = `${provider}/${model}`;
      if (e.tiers) {
        if (!Array.isArray(e.tiers) || e.tiers.length < 2) problems.push(`${where}: tiers must list at least two`);
        else e.tiers.forEach((t, i) => {
          if (typeof t.name !== 'string' || t.name.search(/^[a-z0-9][a-z0-9-]{0,31}$/) !== 0 || t.name === 'fast') problems.push(`${where}: tier ${i + 1} has no usable name`);
          if (i < e.tiers.length - 1 && !(Number.isInteger(t.max_prompt_tokens) && t.max_prompt_tokens > 0)) problems.push(`${where}: tier ${t.name} needs max_prompt_tokens`);
          checkRates(`${where} ${t.name}`, t.rates);
        });
      } else checkRates(where, e.rates);
      if (e.fast) checkRates(`${where} fast`, e.fast);
    }
  }
  return problems;
}

/**
 * The row for a model, or null. The provider's own rows, or the rows its alias points to. Exact id
 * first, then the id without a date suffix: `-20251001` or `-2025-04-14`. Never a prefix.
 */
export function findModel(table, provider, model) {
  const all = (table && table.providers) || {};
  const aliases = (table && table.aliases) || {};
  const models = has(all, provider) ? all[provider] : has(aliases, provider) ? all[aliases[provider]] : null;
  if (!models || typeof model !== 'string') return null;
  if (has(models, model)) return models[model];
  const m = model.match(/^(.+)-(?:\d{8}|\d{4}-\d{2}-\d{2})$/);
  if (m && has(models, m[1])) return models[m[1]];
  return null;
}

/** A call's prompt length, as a tier's limit counts it: input, cache reads and cache writes. */
export const promptTokens = (c) => (c.input || 0) + (c.cache_read || 0) + (c.cache_write || 0);

/** The tier a call falls in: `fast`, a named tier, or null for a model with one price or no row. */
export function tierOf(table, provider, model, counts, speed) {
  const e = findModel(table, provider, model);
  if (!e) return null;
  if (speed === 'fast' && e.fast) return 'fast';
  if (Array.isArray(e.tiers)) {
    const p = promptTokens(counts);
    const t = e.tiers.find((x) => x.max_prompt_tokens == null || p <= x.max_prompt_tokens);
    return (t || e.tiers[e.tiers.length - 1]).name;
  }
  return null;
}

/** The rates for a model in a tier, or null when the table has none. */
export function ratesFor(table, provider, model, tier) {
  const e = findModel(table, provider, model);
  if (!e) return null;
  if (tier === 'fast') return e.fast || null;
  if (Array.isArray(e.tiers)) return (e.tiers.find((t) => t.name === tier) || {}).rates || null;
  return tier == null ? e.rates || null : null;
}

/**
 * A record's API-equivalent cost in USD, rounded to the millionth, or null when the model has no row.
 * Where the split is known, each cache write is priced at its own rate. A single cache-write count
 * for a Claude model is priced at the 5-minute rate, Anthropic's default, and for an OpenAI model at
 * its `cache_write` rate, the 30-minute default. A row with no cache-write rate prices a write at
 * its input rate. Reasoning is inside output, so it is priced once.
 */
export function costOf(table, record) {
  const r = ratesFor(table, record.model_provider, record.model, record.price_tier);
  if (!r) return null;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const write5m = has(r, 'cache_write_5m') ? r.cache_write_5m : has(r, 'cache_write') ? r.cache_write : r.input;
  const write1h = has(r, 'cache_write_1h') ? r.cache_write_1h : write5m;
  let writes;
  if (record.tokens_cache_write_5m !== null || record.tokens_cache_write_1h !== null) {
    const split = n(record.tokens_cache_write_5m) + n(record.tokens_cache_write_1h);
    const rest = Math.max(0, n(record.tokens_cache_write) - split);
    writes = n(record.tokens_cache_write_5m) * write5m + n(record.tokens_cache_write_1h) * write1h + rest * write5m;
  } else {
    writes = n(record.tokens_cache_write) * write5m;
  }
  const usd = (n(record.tokens_input) * r.input + n(record.tokens_cache_read) * r.cache_read + writes + n(record.tokens_output) * r.output) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}
