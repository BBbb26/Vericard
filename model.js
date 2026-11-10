'use strict';

const DAY_MS = 86_400_000;

function integer(value, name, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${name} must be a safe integer >= ${min}`);
  }
  return value;
}

function cents(value, name = 'amountCents') {
  return integer(value, name);
}

function date(value, name = 'date') {
  const time = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? Date.parse(value + 'T00:00:00Z')
    : NaN;
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) {
    throw new RangeError(`${name} must be a valid YYYY-MM-DD date`);
  }
  return value;
}

function lastDate(startDate, days) {
  const time = Date.parse(startDate + 'T00:00:00Z') + (days - 1) * DAY_MS;
  if (time > Date.UTC(9999, 11, 31)) throw new RangeError('Validity end exceeds year 9999');
  return new Date(time).toISOString().slice(0, 10);
}

function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`);
  return value;
}

function oneOf(value, choices, name) {
  if (!choices.includes(value)) throw new RangeError(`Unsupported ${name}: ${value}`);
  return value;
}

function record(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new RangeError(`Unsupported ${name} field: ${key}`);
  }
}

function coverage(value, name) {
  record(value, name);
  const kind = oneOf(value.kind, ['all', 'none', 'services'], name);
  onlyKeys(value, kind === 'services' ? ['kind', 'serviceIds'] : ['kind'], name);
  if (kind !== 'services') return { kind };
  if (!Array.isArray(value.serviceIds) || !value.serviceIds.length) {
    throw new TypeError(`${name}.serviceIds must be a non-empty array`);
  }
  return { kind, serviceIds: [...new Set(value.serviceIds.map(id => text(id, 'serviceId')))] };
}

function validity(value, name) {
  record(value, name);
  const kinds = ['fixed', 'from_activation', 'unlimited'];
  if (name === 'bonusValidity') kinds.push('same_as_plan');
  const kind = oneOf(value.kind, kinds, name);
  if (kind === 'fixed') {
    onlyKeys(value, ['kind', 'startDate', 'endDate'], name);
    const startDate = value.startDate == null ? null : date(value.startDate, name + '.startDate');
    const endDate = date(value.endDate, name + '.endDate');
    if (startDate && startDate > endDate) throw new RangeError(`${name} ends before it starts`);
    return { kind, startDate, endDate };
  }
  if (kind === 'from_activation') {
    onlyKeys(value, ['kind', 'days'], name);
    return { kind, days: integer(value.days, name + '.days', 1) };
  }
  onlyKeys(value, ['kind'], name);
  return { kind };
}

const commonRules = { validity, coverage };
const typeRules = new Map([
  ['stored_value', {
    principalCents: cents,
    bonusCents: cents,
    bonusCoverage: coverage,
    bonusValidity: validity,
    deduction: value => oneOf(value, ['principal_first', 'bonus_first', 'proportional'], 'deduction'),
  }],
  ['visit_pack', {
    visits: (value, name) => integer(value, name, 1),
    redemption: value => oneOf(value, ['per_visit', 'per_day'], 'redemption'),
  }],
  ['time_pass', {}],
  ['time_pack', {
    minutes: (value, name) => integer(value,name,1),
    billingMinutes: (value, name) => integer(value,name,1),
  }],
]);

function normalizeRules(type, input, partial = false) {
  record(input, 'rules');
  const validators = { ...commonRules, ...typeRules.get(type) };
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(validators, key)) throw new RangeError(`Unsupported ${type} rule: ${key}`);
  }
  const keys = partial ? Object.keys(input) : Object.keys(validators);
  return Object.fromEntries(keys.map(key => [
    key, input[key] == null ? null : validators[key](input[key], key),
  ]));
}

// Executable terms live in rules. Unconfirmed candidates stay in the source snapshot.
function createPlan(input) {
  record(input, 'plan');
  if (!typeRules.has(input.type)) throw new RangeError(`Unsupported plan type: ${input.type}`);
  const unsupportedRules = input.unsupportedRules ?? [];
  if (!Array.isArray(unsupportedRules)) throw new TypeError('unsupportedRules must be an array');
  return {
    id: text(input.id, 'plan.id'),
    version: integer(input.version, 'plan.version', 1),
    type: input.type,
    name: input.name == null ? null : text(input.name, 'plan.name'),
    offerPriceCents: input.offerPriceCents == null ? null : cents(input.offerPriceCents, 'offerPriceCents'),
    firstRedemptionWithinDays: input.firstRedemptionWithinDays == null
      ? null : integer(input.firstRedemptionWithinDays, 'firstRedemptionWithinDays', 1),
    rules: normalizeRules(input.type, input.rules ?? {}),
    evidence: structuredClone(record(input.evidence ?? {}, 'evidence')),
    unsupportedRules: unsupportedRules.map(rule => text(rule, 'unsupported rule')),
  };
}

module.exports = { createPlan, normalizeRules, cents, date, lastDate, text, record, oneOf };
