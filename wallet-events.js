'use strict';

const { parseFixedDebit } = require('./offer-terms');
const {
  WalletError, amount, calendar, projectLedger, actualDebit, minuteValue, activeEvents, isConsumption, cardSummary,
} = require('./wallet-ledger');

const reversible = new Set(['consume', 'consume_confirmation', 'recharge', 'refund', 'adjustment', 'promise', 'evidence', 'fulfillment_review']);

function visitsValue(value, label, min = 0) {
  const raw = String(value ?? '').trim();
  const visits = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(visits) || visits < min) {
    throw new WalletError(label + (min ? '须为正整数。' : '须为非负整数。'));
  }
  return visits;
}

function balanceVersion(events) {
  return events.findLast(event => ['recharge', 'refund', 'adjustment'].includes(event.type) || (event.type === 'reversal' && event.balanceAffecting) ||
    (isConsumption(event) && event.status !== 'pending'))?.id ?? null;
}

function transactionDate(card, value, today) {
  const date = calendar(value, '交易日期');
  if (date < card.purchase.purchasedOn || date > today) throw new WalletError('交易日期须介于购买日与今天之间。');
  return date;
}

function reconcile(card, projection, input) {
  if (card.plan.type === 'time_pass') throw new WalletError('期限会员按有效期核对，余额对账适用于储值、次数或时长包。');
  const expected = projection.remaining;
  if (card.plan.type === 'visit_pack') {
    const visits = visitsValue(input.observedVisits, '商家剩余次数');
    return { expected: { visits: expected.visits }, observed: { visits }, difference: visits - expected.visits };
  }
  if (card.plan.type === 'time_pack') {
    const minutes = minuteValue(input.observedMinutes,'商家剩余时长');
    return {expected:{minutes:expected.minutes},observed:{minutes},difference:minutes-expected.minutes};
  }
  const totalCents = amount(input.observedTotal, '商家余额');
  const principalCents = amount(input.observedPrincipal, '商家显示本金', true);
  if (principalCents !== null && principalCents > totalCents) throw new WalletError('本金余额不能大于总额。');
  const sameTotal = totalCents === expected.totalCents;
  const splitChanged = principalCents !== null && principalCents !== expected.principalCents;
  return {
    expected,
    observed: { totalCents, principalCents },
    difference: totalCents - expected.totalCents,
    splitChanged,
    splitConflict: principalCents !== null &&
      (principalCents < expected.principalRange[0] || principalCents > expected.principalRange[1]),
    splitOnly: sameTotal && splitChanged,
  };
}

function newWalletEvent(card, events, input, today, recordedAt, lookupImage) {
  const type = input.type;
  const note = String(input.note ?? '').trim();
  if (note.length > 1000) throw new WalletError('备注最多 1000 个字符。');
  const common = { type, recordedAt, date: today, note };
  const live = activeEvents(events);
  const projection = projectLedger(card, events);
  const cardType = card.plan.type;

  if (type === 'archive') {
    if (typeof input.archived !== 'boolean') throw new WalletError('请选择归档状态。');
    const summary = cardSummary(card, events, today);
    if (input.archived && !['closed','expired'].includes(summary.status) &&
        summary.remaining.totalCents !== 0 && summary.remaining.visits !== 0 && summary.remaining.minutes !== 0) {
      throw new WalletError('只有已结束或权益已用完的卡片可以归档。');
    }
    return { ...common, archived:input.archived };
  }
  if (type === 'reconciliation') {
    const observed = reconcile(card, projection, input);
    const reasons = [
      ...(projection.pending.length ? ['有消费仍待核对扣减。'] : []),
      ...(live.some(event => event.status === 'estimated') ? ['有扣减来自规则估算。'] : []),
      ...(observed.splitConflict ? ['商家本金与当前账面区间不一致。'] : []),
      '可核实未登记消费、附加收费、赠送权益到期及商家显示口径。',
    ];
    return { ...common, ...observed, reasons, balanceVersion: balanceVersion(events) };
  }
  if (type === 'adjustment') {
    if (input.confirmed !== true || !note) throw new WalletError('请确认按商家记录校正，并填写依据。');
    const source = live.findLast(event => event.type === 'reconciliation');
    if (!source || source.id !== input.reconciliationId || (source.difference === 0 && !source.splitChanged)) throw new WalletError('请选择有差异或需确认分账的对账记录。');
    if (source.date !== today || source.balanceVersion !== balanceVersion(events)) throw new WalletError('账面已变动，请重新对账后再校正。', 409);
    return { ...common, reconciliationId: source.id, observed: source.observed, before: projection.remaining, difference: source.difference };
  }
  if (type === 'reversal') {
    if (input.confirmed !== true || !note) throw new WalletError('请确认撤销并填写原因。');
    const target = live.find(event => event.id === input.targetId && reversible.has(event.type));
    if (!target) throw new WalletError('该记录无法撤销，或已经撤销。', 409);
    if (target.status === 'pending' && live.some(event => event.confirmationFor === target.id)) {
      throw new WalletError('请先撤销对应的实扣补录。', 409);
    }
    const laterAdjustment = live.slice(live.indexOf(target) + 1).some(event => event.type === 'adjustment');
    if (laterAdjustment && (isConsumption(target) && target.status !== 'pending' ||
        ['refund', 'recharge', 'adjustment'].includes(target.type))) {
      throw new WalletError('该流水已纳入后续余额校正，请先核对或撤销后续校正。', 409);
    }
    if (target.type === 'refund' && target.terminates &&
        live.slice(live.indexOf(target) + 1).some(event => event.type === 'refund' && event.terminates)) {
      throw new WalletError('该卡有后续终止记录，请按由近及远顺序核对。', 409);
    }
    const balanceAffecting = isConsumption(target) && target.status !== 'pending' ||
      ['recharge', 'refund', 'adjustment'].includes(target.type);
    if (balanceAffecting && live.slice(live.indexOf(target) + 1).some(event => event.status === 'estimated')) {
      throw new WalletError('后续有基于当时余额的规则估算，请先核对或撤销相关估算。', 409);
    }
    return { ...common, targetId: target.id, balanceAffecting };
  }
  if (type === 'promise') {
    if (cardType !== 'stored_value') throw new WalletError('固定金额履约核验用于储值卡。');
    const quote = String(input.quote ?? '').trim();
    const parsed = parseFixedDebit(quote);
    if (!parsed || input.confirmed !== true || !note) {
      throw new WalletError('请录入办卡前固定扣费原文（例如“洗护每次扣减80元”），并确认来源。');
    }
    return { ...common, serviceId: parsed.serviceId, promisedCents: amount(parsed.amount, '约定扣减'), quote };
  }
  if (type === 'evidence') {
    if (!['purchase', 'statement', 'terms', 'other'].includes(input.category)) throw new WalletError('请选择凭证类别。');


    if (!input.proof && !note) throw new WalletError('请添加图片或填写凭证来源。');
    const linkedId = input.linkedId || null;
    if (linkedId && !events.some(event => event.id === linkedId)) throw new WalletError('找不到要关联的流水。');
    const image = input.proof ? lookupImage(input.proof) : null;
    if (input.proof && !image) throw new WalletError('找不到该图片凭证。');
    return { ...common, category: input.category, image, linkedId };
  }
  if (type === 'recharge') {
    if (['time_pass','time_pack'].includes(cardType) || projection.closedAt) throw new WalletError('该卡不支持追加储值或次数。');
    if (input.sameTerms !== true) throw new WalletError('请确认追加权益沿用原卡规则和期限。');
    const cashCents = amount(input.cash, '本次实际支付');
    const date = transactionDate(card, input.date, today);
    if (cardType === 'visit_pack') return { ...common, date, cashCents, credit: { visits: visitsValue(input.creditVisits, '增加次数', 1) } };
    const principalCents = amount(input.creditPrincipal, '追加本金');
    const bonusCents = amount(input.creditBonus, '追加赠送金');
    const totalCents = principalCents + bonusCents;
    if (!Number.isSafeInteger(totalCents) || totalCents === 0) throw new WalletError('追加权益须大于零且在可计算范围内。');
    return { ...common, date, cashCents, credit: { principalCents, bonusCents, totalCents } };
  }
  if (type === 'refund') {
    const cashCents = amount(input.cash, '实际到账退款');
    const date = transactionDate(card, input.date, today);
    const terminates = input.terminates === true;
    if (terminates && projection.closedAt) throw new WalletError('已有终止记录。', 409);
    const debit = cardType === 'time_pass' ? {} : actualDebit(cardType, input);
    if (!terminates && cashCents === 0 && !(debit.totalCents || debit.visits || debit.minutes)) throw new WalletError('请填写到账退款、收回权益或确认终止。');
    return { ...common, date, cashCents, debit, terminates };
  }
  throw new WalletError('未知的流水类型。');
}

function reconciliationState(event, events, live, today) {
  const correction = live.find(item => item.type === 'adjustment' && item.reconciliationId === event.id);
  if (correction) return 'adjusted';
  if (!event.difference && !event.splitChanged) return 'matched';
  if (live.findLast(item => item.type === 'reconciliation')?.id !== event.id ||
      event.date !== today || event.balanceVersion !== balanceVersion(events)) return 'stale';
  return event.splitOnly && !event.splitConflict ? 'split_review' : 'needs_review';
}

module.exports = { newWalletEvent, reconciliationState, reversible };
