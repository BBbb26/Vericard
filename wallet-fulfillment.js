'use strict';

const { dateWindow } = require('./decision');
const { parseFixedDebit } = require('./offer-terms');
const { yuan } = require('./plan-review');
const { activeEvents, isConsumption } = require('./wallet-ledger');

function serviceKey(value) {
  return String(value).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

function savedPromises(card) {
  const field = card.plan.evidence.fixedDebit;
  if (!field || field.verification !== '用户核对' || !field.value) return [];
  return field.value.split(/\r?\n/).flatMap(value => {
    const parsed = parseFixedDebit(value);
    const promisedCents = parsed ? yuan(parsed.amount) : null;
    if (promisedCents === null) return [];
    const match = (field.evidence ?? []).filter(item => {
      const evidence = parseFixedDebit(item.quote);
      return evidence && serviceKey(evidence.serviceId) === serviceKey(parsed.serviceId) &&
        yuan(evidence.amount) === promisedCents;
    });
    return [{
      serviceId: parsed.serviceId, promisedCents, quote: match[0]?.quote ?? value,
      origin: '办卡规则快照', evidence: match,
    }];
  });
}

function comparable(card, event) {
  if (card.plan.unsupportedRules.length) return '适用限制仍需核对。';
  const window = dateWindow(card.plan.rules.validity, card.purchase.activationDate);
  if (window.status !== 'known' || !window.startDate) return '生效或到期条件仍需核对。';
  if (event.date < window.startDate || (window.endDate && event.date > window.endDate)) return '该日期超出已确认的权益期限。';
  const scope = card.plan.rules.coverage;
  if (scope?.kind === 'none' || (scope?.kind === 'services' &&
      !scope.serviceIds.some(service => serviceKey(service) === serviceKey(event.serviceId)))) {
    return '项目适用范围与固定扣费原文仍需核对。';
  }
  return null;
}

function yuanLabel(cents) {
  const value = BigInt(Math.abs(cents));
  return '¥' + String(value / 100n) + '.' + String(value % 100n).padStart(2, '0');
}

function promisesFor(card, live) {
  const supplements = live.filter(event => event.type === 'promise').map(event => ({
    serviceId: event.serviceId, promisedCents: event.promisedCents, quote: event.quote,
    origin: '办卡前条款补录', note: event.note, eventId: event.id, evidence: [],
  }));
  return [...savedPromises(card), ...supplements];
}

function fixedEstimate(card, events, use) {
  const values = [...new Set(promisesFor(card, activeEvents(events))
    .filter(promise => serviceKey(promise.serviceId) === serviceKey(use.serviceId))
    .map(promise => promise.promisedCents))];
  if (values.length > 1) return { conflict: true };
  return { amountCents: values.length && !comparable(card, use) ? values[0] : null };
}

function fulfillmentFor(card, events) {
  const live = activeEvents(events);
  const promises = promisesFor(card, live);
  const checks = [];
  const actual = live.filter(event => isConsumption(event) && event.status === 'confirmed');
  if (card.plan.type !== 'stored_value') return { promises: [], checks, unverifiedCount: 0 };
  for (const event of actual) {
    const terms = promises.filter(promise => serviceKey(promise.serviceId) === serviceKey(event.serviceId));
    if (!terms.length) continue;
    const unique = new Set(terms.map(term => term.promisedCents));
    const context = unique.size > 1 ? '同一项目存在多个约定扣减金额。' : comparable(card, event);
    const base = { eventId: event.id, date: event.date, serviceId: event.serviceId, actualCents: event.debit.totalCents, terms };
    if (context) {
      checks.push({ ...base, status: 'needs_context', reason: context });
      continue;
    }
    const promisedCents = terms[0].promisedCents;
    const differenceCents = event.debit.totalCents - promisedCents;
    const question = differenceCents === 0 ? null :
      '您好，我在' + event.date + '消费了' + event.serviceId + '。我保存的办卡条款写明「' + terms[0].quote +
      '」，这次卡内实扣为' + yuanLabel(event.debit.totalCents) + '，与约定相差' + yuanLabel(differenceCents) +
      '。麻烦提供扣费明细，并确认是否涉及附加项目、卡外补付、条款变更或记录差异，谢谢。';
    const review = live.findLast(item => item.type === 'fulfillment_review' && item.targetId === event.id && item.promisedCents === promisedCents);
    checks.push({ ...base, status: differenceCents === 0 ? 'matched' : 'difference', promisedCents, differenceCents, question,
      ...(review ? { reviewId:review.id, reviewNote:review.note } : {}) });
  }
  return { promises, checks, unverifiedCount: actual.length - checks.length };
}

module.exports = { fulfillmentFor, fixedEstimate };
