'use strict';

const { createPlan, normalizeRules, cents, date, lastDate, text, record, oneOf } = require('./model');

function addMoney(...amounts) {
  return amounts.includes(null) ? null : cents(amounts.reduce((sum, amount) => sum + amount, 0), 'totalCents');
}

function normalizeScenario(type, input) {
  record(input, 'scenario');
  if (!Array.isArray(input.uses)) throw new TypeError('scenario.uses must be an array');
  if (input.actualPaidCents != null && input.assumedPriceCents != null) {
    throw new RangeError('actualPaidCents and assumedPriceCents are mutually exclusive');
  }
  const money = name => input[name] == null ? null : cents(input[name], name);
  const refund = record(input.refund ?? {}, 'refund');
  const refundStatus = oneOf(refund.status ?? 'unknown', ['unknown', 'confirmed', 'assumption'], 'refund.status');
  if (refundStatus === 'unknown' && refund.amountCents != null) {
    throw new RangeError('An unknown refund cannot have an amount');
  }
  const ruleAssumptions = normalizeRules(type, input.ruleAssumptions ?? {}, true);
  if (Object.values(ruleAssumptions).includes(null)) {
    throw new RangeError('A scenario assumption must specify a value');
  }
  return {
    id: text(input.id, 'scenario.id'),
    label: input.label == null ? null : text(input.label, 'scenario.label'),
    usageKind: oneOf(input.usageKind ?? 'forecast', ['forecast', 'actual'], 'usageKind'),
    activationDate: input.activationDate == null ? null : date(input.activationDate, 'activationDate'),
    actualPaidCents: money('actualPaidCents'),
    assumedPriceCents: money('assumedPriceCents'),
    extraFeesCents: money('extraFeesCents'),
    ruleAssumptions,
    refund: {
      status: refundStatus,
      amountCents: refundStatus === 'unknown' ? null : cents(refund.amountCents, 'refund.amountCents'),
    },
    uses: input.uses.map((use, index) => {
      record(use, `uses[${index}]`);
      return {
        date: date(use.date, `uses[${index}].date`),
        serviceId: use.serviceId == null ? null : text(use.serviceId, `uses[${index}].serviceId`),
        referencePriceCents: use.referencePriceCents == null
          ? null : cents(use.referencePriceCents, `uses[${index}].referencePriceCents`),
      };
    }),
  };
}

function resolveRules(plan, assumptions) {
  for (const key of Object.keys(assumptions)) {
    if (plan.rules[key] !== null) throw new RangeError(`Scenario cannot replace plan rule: ${key}`);
  }
  return { ...plan.rules, ...assumptions };
}

function dateWindow(rule, activationDate) {
  if (rule?.kind === 'fixed') {
    const startDate = rule.startDate && (!activationDate || rule.startDate > activationDate)
      ? rule.startDate : activationDate;
    return { status: startDate ? 'known' : 'unknown', startDate, endDate: rule.endDate };
  }
  if (rule?.kind === 'unlimited') return { status: 'known', startDate: activationDate, endDate: null };
  if (rule?.kind === 'from_activation' && activationDate) {
    return { status: 'known', startDate: activationDate, endDate: lastDate(activationDate, rule.days) };
  }
  return { status: 'unknown', startDate: activationDate, endDate: null };
}

function coverageAt(rule, serviceId) {
  if (!rule || (rule.kind === 'services' && serviceId === null)) return null;
  return rule.kind === 'all' || (rule.kind === 'services' && rule.serviceIds.includes(serviceId));
}

function eligibility(use, window, coverage, prefix = '') {
  const outside = (window.startDate && use.date < window.startDate) ||
    (window.endDate && use.date > window.endDate);
  const serviceCovered = coverageAt(coverage, use.serviceId);
  if (outside || serviceCovered === false) return false;
  const missing = [];
  if (window.status === 'unknown') missing.push(prefix ? 'bonusValidity' : 'validity');
  if (serviceCovered === null) missing.push(prefix ? 'bonusCoverage' : 'coverage');
  return missing.length ? { missing } : true;
}

function usageTotals(uses, applyUse) {
  let outsideCents = 0;
  let coveredComparableCents = 0;
  let coveredUses = 0;
  for (const use of uses) {
    const applied = applyUse(use);
    if (applied.missing) return applied;
    outsideCents = addMoney(outsideCents, applied.outsideCents);
    coveredComparableCents = addMoney(coveredComparableCents, applied.coveredComparableCents);
    if (applied.covered) coveredUses++;
  }
  return { outsideCents, coveredComparableCents, coveredUses };
}

function paidOutside(use) {
  return { outsideCents: use.referencePriceCents, coveredComparableCents: 0, covered: false };
}

function coveredVisit(use) {
  return { outsideCents: 0, coveredComparableCents: use.referencePriceCents, covered: true };
}

function visitPack(rules, uses, window, { openingVisits = rules.visits, priorDates = [] } = {}) {
  let remainingVisits = openingVisits;
  const redeemedDates = new Set(priorDates);
  const totals = usageTotals(uses, use => {
    const alreadyRedeemed = redeemedDates.has(use.date);
    if (remainingVisits === 0 && !alreadyRedeemed) return paidOutside(use);
    const eligible = eligibility(use, window, rules.coverage);
    if (eligible === false) return paidOutside(use);
    if (eligible !== true) return eligible;
    if (remainingVisits === null) return { missing: ['visits'] };
    if (rules.redemption === null) return { missing: ['redemption'] };
    if (!alreadyRedeemed) remainingVisits--;
    if (rules.redemption === 'per_day') redeemedDates.add(use.date);
    return coveredVisit(use);
  });
  return { ...totals, entitlement: { remainingVisits } };
}

function timePass(rules, uses, window) {
  const totals = usageTotals(uses, use => {
    const eligible = eligibility(use, window, rules.coverage);
    if (eligible === false) return paidOutside(use);
    return eligible === true ? coveredVisit(use) : eligible;
  });
  return { ...totals, entitlement: {} };
}

function proportionalBonus(amount, principal, bonus, initialPrincipal, initialBonus) {
  // Half-up rounding goes to the bonus bucket. Spill any unmet share into the other bucket.
  const denominator = BigInt(initialPrincipal) + BigInt(initialBonus);
  const numerator = BigInt(amount) * BigInt(initialBonus);
  const target = Number((2n * numerator + denominator) / (2n * denominator));
  return Math.min(bonus, Math.max(amount - principal, target));
}

function storedValue(rules, uses, window, { activationDate, opening = rules }) {
  let principal = opening.principalCents;
  let bonus = opening.bonusCents;
  const bonusWindow = rules.bonusValidity?.kind === 'same_as_plan'
    ? window : dateWindow(rules.bonusValidity, activationDate);
  const totals = usageTotals(uses, use => {
    const price = use.referencePriceCents;
    if (price === 0 || (principal === 0 && bonus === 0)) return paidOutside(use);
    const eligible = eligibility(use, window, rules.coverage);
    if (eligible === false) return paidOutside(use);
    if (eligible !== true) return eligible;
    if (price === null) return { missing: ['referencePriceCents'] };
    if (principal === null) return { missing: ['principalCents'] };

    let availableBonus = 0;
    const principalSuffices = rules.deduction === 'principal_first' && principal >= price;
    if (bonus !== 0 && !principalSuffices) {
      const bonusEligible = eligibility(use, bonusWindow, rules.bonusCoverage, 'bonus');
      if (bonusEligible !== false) {
        if (bonus === null) return { missing: ['bonusCents'] };
        if (bonusEligible !== true) return bonusEligible;
        availableBonus = bonus;
      }
    }

    const fromPrincipalLimit = Math.min(price, principal);
    const covered = fromPrincipalLimit + Math.min(price - fromPrincipalLimit, availableBonus);
    let fromBonus = 0;
    if (availableBonus && covered) {
      if (principal === 0 || rules.deduction === 'bonus_first') {
        fromBonus = Math.min(availableBonus, covered);
      } else if (covered - principal >= availableBonus || rules.deduction === 'principal_first') {
        fromBonus = Math.max(0, covered - principal);
      } else if (rules.deduction === 'proportional') {
        fromBonus = proportionalBonus(covered, principal, availableBonus, rules.principalCents, rules.bonusCents);
      } else {
        return { missing: ['deduction'] };
      }
    }
    principal -= covered - fromBonus;
    if (bonus !== null) bonus -= fromBonus;
    return { outsideCents: price - covered, coveredComparableCents: covered, covered: covered > 0 };
  });
  return { ...totals, entitlement: { unusedPrincipalCents: principal, unusedBonusCents: bonus, bonusWindow } };
}

const strategies = { stored_value: storedValue, visit_pack: visitPack, time_pass: timePass };

function paymentFor(plan, scenario) {
  if (scenario.actualPaidCents !== null) return { source: 'actual', amountCents: scenario.actualPaidCents };
  if (scenario.assumedPriceCents !== null) return { source: 'assumption', amountCents: scenario.assumedPriceCents };
  if (plan.offerPriceCents !== null) return { source: 'offer', amountCents: plan.offerPriceCents };
  return { source: 'unknown', amountCents: null };
}

function calculateScenario(plan, scenario) {
  const rules = resolveRules(plan, scenario.ruleAssumptions);
  const uses = scenario.uses.slice().sort((a, b) => a.date.localeCompare(b.date));
  const window = dateWindow(rules.validity, scenario.activationDate);
  const payment = paymentFor(plan, scenario);
  const refund = scenario.refund;
  if (payment.amountCents !== null && refund.amountCents !== null && refund.amountCents > payment.amountCents) {
    throw new RangeError('Refund exceeds the prepaid amount');
  }
  const payAsYouGoCents = uses.reduce((sum, use) => addMoney(sum, use.referencePriceCents), 0);
  const unsupported = plan.unsupportedRules.length > 0 || !Object.hasOwn(strategies,plan.type);
  const totals = unsupported ? {} : strategies[plan.type](rules, uses, window, { activationDate: scenario.activationDate });
  const complete = !unsupported && !totals.missing;
  const outsideCents = complete ? totals.outsideCents : null;
  const additionalCents = addMoney(outsideCents, scenario.extraFeesCents);
  const totalCents = addMoney(payment.amountCents, additionalCents);
  const coveredComparableCents = complete ? totals.coveredComparableCents : null;
  const unresolved = [...new Set([
    ...(totals.missing ?? []),
    ...(payment.amountCents === null ? ['prepaidPriceCents'] : []),
    ...(scenario.extraFeesCents === null ? ['extraFeesCents'] : []),
    ...(payAsYouGoCents === null ? ['referencePriceCents'] : []),
  ])];
  const usesAssumptions = Object.keys(scenario.ruleAssumptions).length > 0 ||
    payment.source === 'assumption' || refund.status === 'assumption';
  const status = unsupported ? 'unsupported' : unresolved.length ? 'needs_input'
    : usesAssumptions ? 'conditional' : 'calculated';

  return {
    status, unresolved, unsupportedRules: [...plan.unsupportedRules], window,
    payment,
    cash: { outsideCents, extraFeesCents: scenario.extraFeesCents, additionalCents, totalCents },
    payAsYouGoCents,
    coveredComparableCents,
    economicDifferenceCents: totalCents === null || payAsYouGoCents === null ? null : payAsYouGoCents - totalCents,
    costCoverage: coveredComparableCents !== null && payment.amountCents > 0
      ? { numeratorCents: coveredComparableCents, denominatorCents: payment.amountCents } : null,
    refund: {
      ...refund,
      netCashCents: totalCents === null || refund.amountCents === null ? null : totalCents - refund.amountCents,
    },
    entitlement: complete ? { ...totals.entitlement, coveredUses: totals.coveredUses } : null,
  };
}

// The analysis stores a detached plan version, input assumptions and derived results separately.
function analyzeDecision(inputPlan, inputs) {
  const plan = createPlan(inputPlan);
  if (!Array.isArray(inputs) || !inputs.length) throw new TypeError('At least one scenario is required');
  const scenarios = inputs.map(input => normalizeScenario(plan.type, input));
  if (new Set(scenarios.map(scenario => scenario.id)).size !== scenarios.length) {
    throw new RangeError('Scenario ids must be unique');
  }
  return {
    schemaVersion: 1,
    plan,
    scenarios: scenarios.map(input => ({ input, result: calculateScenario(plan, input) })),
  };
}

// Card estimates use the same rules and original proportional basis as the purchase analysis.
function estimateCardDebit(plan, activationDate, use, remaining, redeemedDates) {
  if (plan.unsupportedRules.length) return { missing: plan.unsupportedRules };
  const rules = plan.rules;
  const window = dateWindow(rules.validity, activationDate);
  if (plan.type === 'stored_value') {
    const result = storedValue(rules, [use], window, { activationDate, opening: remaining });
    if (result.missing) return result;
    const principalCents = remaining.principalCents - result.entitlement.unusedPrincipalCents;
    const bonusCents = remaining.bonusCents - result.entitlement.unusedBonusCents;
    return { totalCents: principalCents + bonusCents, principalCents, bonusCents };
  }
  if (plan.type === 'visit_pack') {
    const result = visitPack(rules, [use], window, { openingVisits: remaining.visits, priorDates: rules.redemption === 'per_day' ? redeemedDates : [] });
    if (result.missing) return result;
    return { visits: remaining.visits - result.entitlement.remainingVisits, covered: result.coveredUses > 0 };
  }
  const result = timePass(rules, [use], window);
  return result.missing ? result : { covered: result.coveredUses > 0 };
}

module.exports = { analyzeDecision, dateWindow, estimateCardDebit };
