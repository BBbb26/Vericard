'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RULES, traceRules } = require('./rules/general');
const { analyzeWorkbench, demoReview } = require('./decision-workbench');

function input(overrides = {}) {
  return {
    startDate: '2026-11-10',
    activationDate: '2026-11-10',
    serviceId: '私教',
    referencePrice: '90',
    extraFees: '0',
    scenarios: {
      low: { count: 1, everyDays: 1 },
      base: { count: 2, everyDays: 1 },
      high: { count: 3, everyDays: 1 },
    },
    ...overrides,
  };
}

function baseTrace(review, overrides = {}) {
  const output = analyzeWorkbench(review, input(overrides));
  return output.analysis.scenarios.find(item => item.input.id === 'base').result.rules;
}

test('every rule has an id, version, owner-facing title, status and tests', () => {
  assert(RULES.length >= 8);
  for (const rule of RULES) {
    assert.match(rule.id, /^R\d{2}$/);
    assert(Number.isInteger(rule.version) && rule.version >= 1);
    assert(rule.title);
    assert(rule.summary);
    assert(rule.status);
    assert(rule.source);
    assert(Array.isArray(rule.tests) && rule.tests.length > 0);
  }
});

test('visit pack trace includes redemption and date rules', () => {
  const trace = baseTrace(demoReview('visits'));
  assert(trace.applied.some(rule => rule.id === 'R01'));
  assert(trace.applied.some(rule => rule.id === 'R02'));
  assert.match(trace.applied.find(rule => rule.id === 'R01').detail, /每次到访/);
});

test('stored value trace includes deduction order', () => {
  const trace = baseTrace(demoReview('stored'));
  assert(trace.applied.some(rule => rule.id === 'R03'));
  assert.match(trace.applied.find(rule => rule.id === 'R03').detail, /先扣本金/);
});

test('first redemption deadline is shown as open, not silently enforced', () => {
  const trace = traceRules({
    type: 'visit_pack',
    rules: {
      validity: { kind: 'from_activation', days: 90 },
      coverage: { kind: 'all' },
      visits: 10,
      redemption: 'per_day',
    },
    firstRedemptionWithinDays: 90,
    unsupportedRules: [],
  }, {
    ruleAssumptions: {},
    refund: { status: 'unknown', amountCents: null },
  }, {
    window: { status: 'known', startDate: '2026-11-10', endDate: '2027-02-07' },
    refund: { status: 'unknown', amountCents: null },
    entitlement: { remainingVisits: 5 },
    unsupportedRules: [],
  });
  const rule = trace.open.find(item => item.id === 'R05');
  assert(rule);
  assert.equal(rule.status, 'open');
  assert.match(rule.detail, /未执行/);
});

test('service-scoped coverage and unsupported rules are surfaced', () => {
  const trace = traceRules({
    type: 'stored_value',
    rules: {
      validity: { kind: 'unlimited' },
      coverage: { kind: 'services', serviceIds: ['洗护'] },
      principalCents: 100000,
      bonusCents: 0,
      bonusCoverage: null,
      bonusValidity: null,
      deduction: 'principal_first',
    },
    firstRedemptionWithinDays: null,
    unsupportedRules: ['折扣叠加待核对'],
  }, {
    ruleAssumptions: {},
    refund: { status: 'unknown', amountCents: null },
  }, {
    window: { status: 'known', startDate: '2026-11-10', endDate: null },
    refund: { status: 'unknown', amountCents: null },
    entitlement: { unusedPrincipalCents: 50000, unusedBonusCents: 0 },
    unsupportedRules: ['折扣叠加待核对'],
  });
  assert(trace.applied.some(item => item.id === 'R06'));
  assert(trace.open.some(item => item.id === 'R08'));
  assert(trace.open.some(item => item.id === 'R09'));
});

test('time pack is marked unsupported in the single-plan trace', () => {
  const trace = traceRules({
    type: 'time_pack',
    rules: {
      validity: { kind: 'unlimited' },
      coverage: { kind: 'all' },
      minutes: 600,
      billingMinutes: 30,
    },
    firstRedemptionWithinDays: null,
    unsupportedRules: [],
  }, {
    ruleAssumptions: {},
    refund: { status: 'unknown', amountCents: null },
  }, {
    window: { status: 'known', startDate: '2026-11-10', endDate: null },
    refund: { status: 'unknown', amountCents: null },
    entitlement: {},
    unsupportedRules: [],
  });
  assert(trace.open.some(item => item.id === 'R07' && item.status === 'unsupported'));
});
