'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { analyzeDecision } = require('./decision');
const { readLegacyProject } = require('./legacy-plan');

const all = { kind: 'all' };
const unlimited = { kind: 'unlimited' };
const sameAsPlan = { kind: 'same_as_plan' };

function stored(overrides = {}) {
  return {
    id: 'stored-example', version: 1, type: 'stored_value', offerPriceCents: 100_000,
    rules: {
      validity: unlimited, coverage: all, principalCents: 100_000, bonusCents: 20_000,
      bonusCoverage: all, bonusValidity: sameAsPlan, deduction: 'principal_first',
      ...overrides,
    },
  };
}

function pack(overrides = {}) {
  return {
    id: 'pack-example', version: 1, type: 'visit_pack', offerPriceCents: 12_000,
    rules: { validity: unlimited, coverage: all, visits: 3, redemption: 'per_visit', ...overrides },
  };
}

function pass(overrides = {}) {
  return {
    id: 'pass-example', version: 1, type: 'time_pass', offerPriceCents: 90_000,
    rules: { validity: { kind: 'from_activation', days: 2 }, coverage: all, ...overrides },
  };
}

function use(date, referencePriceCents = 20_000, serviceId = 'haircut') {
  return { date, referencePriceCents, serviceId };
}

function days(count) {
  return Array.from({ length: count }, (_, i) => use(`2026-11-${10 + i}`));
}

function scenario(uses, overrides = {}) {
  return { id: 'example', extraFeesCents: 0, uses, ...overrides };
}

function result(plan, uses, overrides) {
  return analyzeDecision(plan, [scenario(uses, overrides)]).scenarios[0].result;
}

test('stored value includes cash for the seventh use and compares identical demand', () => {
  const analysis = analyzeDecision(stored(), [
    scenario(days(6), { id: 'six' }),
    scenario(days(7), { id: 'seven' }),
  ]);
  const [six, seven] = analysis.scenarios.map(item => item.result);
  assert.equal(six.cash.totalCents, 100_000);
  assert.equal(seven.cash.totalCents, 120_000);
  assert.equal(seven.cash.outsideCents, 20_000);
  assert.equal(seven.payAsYouGoCents, 140_000);
  assert.equal(seven.economicDifferenceCents, 20_000);
  assert.deepEqual(seven.costCoverage, { numeratorCents: 120_000, denominatorCents: 100_000 });
  assert.equal(seven.entitlement.unusedPrincipalCents, 0);
  assert.equal(seven.entitlement.unusedBonusCents, 0);
});

test('an ineligible service cannot use the bonus after the principal runs out', () => {
  const output = result(stored({ bonusCoverage: { kind: 'services', serviceIds: ['massage'] } }), days(6));
  assert.equal(output.cash.outsideCents, 20_000);
  assert.equal(output.entitlement.unusedBonusCents, 20_000);
});

test('a single service can use the last part of a balance and pay the rest in cash', () => {
  const output = result(stored({ principalCents: 80, bonusCents: 10 }), [use('2026-11-10', 100)]);
  assert.equal(output.cash.outsideCents, 10);
  assert.equal(output.coveredComparableCents, 90);
});

test('bonus validity is independent from the principal and the last date is inclusive', () => {
  const output = result(stored({
    principalCents: 10_000, bonusCents: 40_000, deduction: 'bonus_first',
    bonusValidity: { kind: 'fixed', startDate: '2026-11-10', endDate: '2026-11-10' },
  }), days(2));
  assert.equal(output.cash.outsideCents, 10_000);
  assert.equal(output.entitlement.unusedBonusCents, 20_000);
  assert.equal(output.entitlement.bonusWindow.endDate, '2026-11-10');
});

test('principal first and bonus first preserve different bucket balances', () => {
  const uses = days(1);
  assert.equal(result(stored(), uses).entitlement.unusedPrincipalCents, 80_000);
  assert.equal(result(stored({ deduction: 'bonus_first' }), uses).entitlement.unusedPrincipalCents, 100_000);
});

test('proportional deduction rounds the bonus share half up and spills to the available bucket', () => {
  const plan = stored({ principalCents: 3, bonusCents: 3, deduction: 'proportional' });
  const uses = [use('2026-11-10', 1), use('2026-11-11', 1), use('2026-11-12', 1)];
  const output = result(plan, uses);
  assert.equal(output.entitlement.unusedPrincipalCents, 3);
  assert.equal(output.entitlement.unusedBonusCents, 0);
  assert.equal(result(plan, [...uses, use('2026-11-13', 4)]).cash.outsideCents, 1);
});

test('missing bonus scope is harmless while confirmed principal-first funds cover the use', () => {
  const plan = stored({ bonusCoverage: null });
  assert.equal(result(plan, days(1)).status, 'calculated');
  const unresolved = result(plan, days(6));
  assert.equal(unresolved.status, 'needs_input');
  assert.deepEqual(unresolved.unresolved, ['bonusCoverage']);
  assert.equal(unresolved.cash.totalCents, null);
  assert.equal(unresolved.payAsYouGoCents, 120_000);
});

test('scenario assumptions produce separate conditional outcomes and never change the plan', () => {
  const plan = stored({ bonusCoverage: null });
  const analysis = analyzeDecision(plan, [
    scenario(days(6), { id: 'eligible', ruleAssumptions: { bonusCoverage: all } }),
    scenario(days(6), { id: 'excluded', ruleAssumptions: { bonusCoverage: { kind: 'none' } } }),
  ]);
  assert.equal(analysis.plan.rules.bonusCoverage, null);
  assert.deepEqual(analysis.scenarios.map(item => item.result.status), ['conditional', 'conditional']);
  assert.deepEqual(analysis.scenarios.map(item => item.result.cash.totalCents), [100_000, 120_000]);
  assert.throws(() => result(stored(), days(1), { ruleAssumptions: { bonusCents: 0 } }), /cannot replace/);
});

test('unknown deduction order cannot choose a bucket when both could pay', () => {
  assert.deepEqual(result(stored({ deduction: null }), days(1)).unresolved, ['deduction']);
});

test('an unsupported combination cannot silently stack an extra discount', () => {
  const plan = { ...stored(), unsupportedRules: ['service discount and gift stacking'] };
  const output = result(plan, days(1));
  assert.equal(output.status, 'unsupported');
  assert.equal(output.cash.totalCents, null);
  assert.deepEqual(output.unsupportedRules, ['service discount and gift stacking']);
  assert.throws(() => result(stored({ serviceDiscount: 20 }), days(1)), /Unsupported stored_value rule/);
  assert.throws(() => result(stored({ coverage: { ...all, exclude: ['haircut'] } }), days(1)), /Unsupported coverage field/);
});

test('visit pack tracks zero remaining visits and prices subsequent uses separately', () => {
  const output = result(pack(), days(4));
  assert.equal(output.entitlement.remainingVisits, 0);
  assert.equal(output.entitlement.coveredUses, 3);
  assert.equal(output.cash.totalCents, 32_000);
  assert.equal(output.cash.outsideCents, 20_000);
});

test('per-day redemption covers repeated entries on the last covered day', () => {
  const output = result(pack({ visits: 1, redemption: 'per_day' }), [
    use('2026-11-11'), use('2026-11-10'), use('2026-11-10'),
  ]);
  assert.equal(output.entitlement.remainingVisits, 0);
  assert.equal(output.entitlement.coveredUses, 2);
  assert.equal(output.cash.outsideCents, 20_000);
});

test('visit pack keeps expired unredeemed visits separate from cash and service coverage', () => {
  const output = result(pack({
    coverage: { kind: 'services', serviceIds: ['haircut'] },
    validity: { kind: 'fixed', startDate: '2026-11-10', endDate: '2026-11-10' },
  }), [use('2026-11-10', 5000, 'massage'), use('2026-11-10'), use('2026-11-11')]);
  assert.equal(output.entitlement.remainingVisits, 2);
  assert.equal(output.entitlement.coveredUses, 1);
  assert.equal(output.cash.outsideCents, 25_000);
  assert.equal(output.window.endDate, '2026-11-10');
});

test('time pass includes the activation and last dates, then charges outside the window', () => {
  const uses = [use('2026-11-09'), ...days(3), use('2026-11-10')];
  const output = result(pass(), uses, { activationDate: '2026-11-10' });
  assert.equal(output.window.endDate, '2026-11-11');
  assert.deepEqual(output.entitlement, { coveredUses: 3 });
  assert.equal(output.cash.outsideCents, 40_000);
  assert.equal(output.cash.totalCents, 130_000);
});

test('unknown post-activation validity cannot be filled from a first-redemption deadline', () => {
  const plan = { ...pack({ validity: null }), firstRedemptionWithinDays: 90 };
  const output = result(plan, days(1), { activationDate: '2026-11-10' });
  assert.equal(output.status, 'needs_input');
  assert.equal(output.window.endDate, null);
  assert.deepEqual(output.unresolved, ['validity']);
  assert.equal(result(pass(), days(1)).cash.totalCents, null);
});

test('end-only validity can exclude a late use without inventing a start', () => {
  const plan = pass({ validity: { kind: 'fixed', endDate: '2026-11-10' } });
  assert.equal(result(plan, [use('2026-11-11')]).cash.outsideCents, 20_000);
  assert.equal(result(plan, [use('2026-11-10')]).status, 'needs_input');
  assert.equal(result(plan, [use('2026-11-10')], { activationDate: '2026-11-10' }).cash.outsideCents, 0);
});

test('zero uses preserve cash and unknown refunds; zero paid has no coverage ratio', () => {
  const output = result(pack(), []);
  assert.equal(output.cash.totalCents, 12_000);
  assert.equal(output.economicDifferenceCents, -12_000);
  assert.deepEqual(output.costCoverage, { numeratorCents: 0, denominatorCents: 12_000 });
  assert.deepEqual(output.refund, { status: 'unknown', amountCents: null, netCashCents: null });
  assert.equal(result(pack(), [], { actualPaidCents: 0 }).costCoverage, null);
});

test('actual prepaid amount, extra cash fees and assumed refunds are shown separately', () => {
  const output = result(pack(), days(1), {
    actualPaidCents: 11_000, extraFeesCents: 100, refund: { status: 'assumption', amountCents: 500 },
  });
  assert.equal(output.status, 'conditional');
  assert.deepEqual(output.payment, { source: 'actual', amountCents: 11_000 });
  assert.equal(output.cash.totalCents, 11_100);
  assert.equal(output.refund.netCashCents, 10_600);
  assert.equal(output.economicDifferenceCents, 8_900);
  assert.throws(() => result(pack(), [], { refund: { status: 'confirmed', amountCents: 12_001 } }), /exceeds/);
});

test('missing prices and fees preserve independent results without a definitive difference', () => {
  const noReference = result(pack(), [use('2026-11-10', null)]);
  assert.equal(noReference.cash.totalCents, 12_000);
  assert.equal(noReference.payAsYouGoCents, null);
  assert.equal(noReference.economicDifferenceCents, null);
  const unknownFees = result(pack(), days(1), { extraFeesCents: null });
  assert.deepEqual(unknownFees.unresolved, ['extraFeesCents']);
  assert.equal(unknownFees.cash.totalCents, null);
  const noPrice = result({ ...pack(), offerPriceCents: null }, []);
  assert.deepEqual(noPrice.payment, { source: 'unknown', amountCents: null });
  assert.equal(noPrice.cash.totalCents, null);
});

test('integer cents and calendar dates reject malformed values and overflow', () => {
  assert.throws(() => result(pack(), [use('2026-02-30')]), /valid YYYY-MM-DD/);
  assert.throws(() => result(pack(), [use('2026-11-10', 1.5)]), /safe integer/);
  assert.throws(() => result(pack(), [use('2026-11-10', -1)]), /safe integer/);
  assert.throws(() => result(pack(), [use('2026-11-10', Number.MAX_SAFE_INTEGER), use('2026-11-11', 1)]), /safe integer/);
});

test('analysis keeps a detached rule version, field sources and scenario inputs', () => {
  const plan = pack();
  plan.evidence = { visits: { source: 'user', status: 'confirmed', quote: '三次' } };
  const input = scenario(days(1));
  const analysis = analyzeDecision(plan, [input]);
  plan.version++;
  plan.evidence.visits.quote = '修改后';
  input.uses[0].referencePriceCents++;
  assert.equal(analysis.plan.version, 1);
  assert.equal(analysis.plan.evidence.visits.quote, '三次');
  assert.equal(analysis.scenarios[0].input.uses[0].referencePriceCents, 20_000);
  assert.equal(analysis.schemaVersion, 1);
});

test('legacy drafts preserve evidence and keep unconfirmed numbers and unsupported units out of rules', () => {
  const dataFile = path.join(__dirname, 'data', 'project.json');
  if (fs.existsSync(dataFile)) {
    const before = fs.readFileSync(dataFile);
    const project = JSON.parse(before);
    const drafts = readLegacyProject(project);
    assert.equal(drafts.length, project.groups.length);
    assert.deepEqual(drafts.map(draft => draft.source), project.groups);
    assert(drafts.every(draft => draft.status === 'needs_review' && !Object.hasOwn(draft, 'rules')));
    assert.deepEqual(fs.readFileSync(dataFile), before);
  }

  const fixture = readLegacyProject({ version: 1, groups: [
    { fields: { unit: { value: '使用日' }, price: { value: '266.9' }, total: { value: '10' }, purchaseDays: { value: '90' } } },
    { fields: { unit: { value: '连续天' }, total: { value: '30' } } },
    { fields: { unit: { value: '次' }, total: { value: '1' } } },
    { fields: { unit: { value: '小时' } } },
  ] });
  assert.deepEqual(fixture.map(draft => draft.typeHint), ['visit_pack', 'time_pass', null, null]);
  assert.equal(fixture[0].candidates.offerPriceCents, 26_690);
  assert.equal(fixture[0].candidates.redemption, 'per_day');
  assert.equal(fixture[0].candidates.firstRedemptionWithinDays, 90);
  assert.equal(fixture[1].candidates.daysFromActivation, null);
  assert.equal(fixture[1].candidates.visits, null);
});
