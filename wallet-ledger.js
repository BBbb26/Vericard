'use strict';

const { date } = require('./model');
const { dateWindow, estimateCardDebit } = require('./decision');
const { yuan } = require('./plan-review');

class WalletError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function amount(value, label, optional = false) {
  if (optional && (value == null || String(value).trim() === '')) return null;
  const cents = yuan(value);
  if (cents === null) throw new WalletError(label + '请输入非负金额，最多两位小数。');
  return cents;
}

function calendar(value, label) {
  try { return date(value); }
  catch { throw new WalletError(label + '请输入有效日期。'); }
}

function applyStoredDebit(state, debit) {
  const { totalCents, principalCents, bonusCents } = debit;
  const remainingTotal = state.totalCents - totalCents;
  if (remainingTotal < 0) throw new WalletError('扣减超过账面剩余总额，可以先保存为待核对。');
  if (principalCents === null) {
    // An observed total limits both buckets without establishing which one was used.
    state.principalMin = Math.max(0, state.principalMin - totalCents);
    state.principalMax = Math.min(state.principalMax, remainingTotal);
  } else {
    const min = Math.max(state.principalMin, principalCents);
    const max = Math.min(state.principalMax, state.totalCents - bonusCents);
    if (min > max) throw new WalletError('本金或赠送金扣减超出可用账面范围，可以先保存为待核对。');
    state.principalMin = min - principalCents;
    state.principalMax = max - principalCents;
  }
  state.totalCents = remainingTotal;
}

function activeEvents(events) {
  const reversed = new Set(events.filter(event => event.type === 'reversal').map(event => event.targetId));
  return events.filter(event => !reversed.has(event.id));
}

function isConsumption(event) {
  return event.type === 'consume' || event.type === 'consume_confirmation';
}

function projectLedger(card, events) {
  const { type, rules } = card.plan;
  const stored = type === 'stored_value' ? {
    totalCents: rules.principalCents + rules.bonusCents,
    principalMin: rules.principalCents,
    principalMax: rules.principalCents,
  } : null;
  let minutes = rules.minutes;
  let consumedMinutes = 0;
  let visits = rules.visits;
  let creditedVisits = rules.visits ?? 0;
  let consumedVisits = 0;
  let coveredUses = 0;
  let recordedUses = 0;
  let rechargeCashCents = 0;
  let refundedCashCents = 0;
  let closedAt = null;
  const redeemedDates = new Set();
  const active = activeEvents(events);
  const confirmed = new Set(active.map(event => event.confirmationFor).filter(Boolean));
  const pending = [];

  function debitBalance(debit) {
    if (stored) applyStoredDebit(stored, debit);
    if (type === 'time_pack') {
      minutes -= debit.minutes;
      if (minutes < 0) throw new WalletError('扣减超过剩余时长，可以先保存为待核对。');
    }
    if (type === 'visit_pack') {
      visits -= debit.visits;
      if (visits < 0) throw new WalletError('扣减超过账面剩余次数，可以先保存为待核对。');
    }
  }
  for (const event of active) {
    if (event.type === 'recharge') {
      rechargeCashCents += event.cashCents;
      if (stored) {
        stored.totalCents += event.credit.totalCents;
        stored.principalMin += event.credit.principalCents;
        stored.principalMax += event.credit.principalCents;
      } else {
        visits += event.credit.visits;
        creditedVisits += event.credit.visits;
      }
      if (![rechargeCashCents, visits ?? 0, creditedVisits, stored?.totalCents ?? 0].every(Number.isSafeInteger)) {
        throw new WalletError('追加权益超过可计算范围。');
      }
      continue;
    }
    if (event.type === 'refund') {
      debitBalance(event.debit);
      refundedCashCents += event.cashCents;
      if (!Number.isSafeInteger(refundedCashCents)) throw new WalletError('退款流水金额超过可计算范围。');
      if (event.terminates) closedAt = closedAt && closedAt < event.date ? closedAt : event.date;
      continue;
    }
    if (event.type === 'adjustment') {
      if (stored) {
        const { totalCents, principalCents } = event.observed;
        stored.totalCents = totalCents;
        stored.principalMin = principalCents ?? 0;
        stored.principalMax = principalCents ?? totalCents;
      } else if (type === 'time_pack') {
        minutes = event.observed.minutes;
      } else {
        visits = event.observed.visits;
      }
      continue;
    }
    if (!isConsumption(event)) continue;
    if (event.status === 'pending') {
      if (!confirmed.has(event.id)) pending.push(event);
      continue;
    }
    recordedUses++;
    debitBalance(event.debit);
    if (stored ? event.debit.totalCents > 0 : event.debit.covered) coveredUses++;
    if (type === 'time_pack') consumedMinutes += event.debit.minutes;
    if (type === 'visit_pack' && event.debit.visits > 0) {
      consumedVisits += event.debit.visits;
      redeemedDates.add(event.date);
    }
  }

  let remaining = {};
  if (stored) {
    const exact = stored.principalMin === stored.principalMax;
    remaining = {
      totalCents: stored.totalCents,
      principalCents: exact ? stored.principalMin : null,
      bonusCents: exact ? stored.totalCents - stored.principalMin : null,
      principalRange: [stored.principalMin, stored.principalMax],
      bonusRange: [stored.totalCents - stored.principalMax, stored.totalCents - stored.principalMin],
    };
  } else if (type === 'visit_pack') {
    remaining = { visits };
  } else if (type === 'time_pack') {
    remaining = { minutes };
  }
  return { remaining, pending, redeemedDates: [...redeemedDates], coveredUses, recordedUses, creditedVisits, consumedVisits, ...(type === 'time_pack' ? {consumedMinutes} : {}),
    rechargeCashCents, refundedCashCents, closedAt };
}

function minuteValue(value, label, min = 0) {
  const raw = String(value ?? '').trim();
  const minutes = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(minutes) || minutes < min) throw new WalletError(label + '须填写整数分钟。');
  return minutes;
}

function actualDebit(type, input) {
  if (type === 'stored_value') {
    const totalCents = amount(input.debitAmount, '实际扣减总额');
    const principalCents = amount(input.debitPrincipal, '其中本金', true);
    if (principalCents !== null && principalCents > totalCents) throw new WalletError('本金扣减不能超过扣减总额。');
    return { totalCents, principalCents, bonusCents: principalCents === null ? null : totalCents - principalCents };
  }
  if (type === 'visit_pack') {
    const raw = String(input.debitVisits ?? '');
    const visits = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(visits)) throw new WalletError('请输入实际扣减的整数次数。');
    return { visits, covered: visits > 0 || input.covered === 'yes' };
  }
  if (type === 'time_pack') {
    const minutes = minuteValue(input.debitMinutes,'实扣时长');
    return { minutes, covered:minutes > 0 };
  }
  if (!['yes', 'no'].includes(input.covered)) throw new WalletError('请选择本次是否使用了会员权益。');
  return { covered: input.covered === 'yes' };
}

function newConsumption(card, events, input, today, recordedAt, resolveFixed = () => ({})) {
  const projection = projectLedger(card, events);
  const original = input.pendingId ? projection.pending.find(event => event.id === input.pendingId) : null;
  if (input.pendingId && !original) throw new WalletError('找不到该待核对记录，或该记录已经核对。', 409);
  if (original && input.mode !== 'actual') throw new WalletError('核对已有记录时，请填写实际扣减。');
  const usedOn = original?.date ?? calendar(input.date, '消费日期');
  if (usedOn < card.purchase.purchasedOn || usedOn > today) throw new WalletError('消费日期须介于购买日与今天之间。');
  const serviceId = original?.serviceId ?? String(input.serviceId ?? '').trim();
  if (!serviceId || serviceId.length > 120) throw new WalletError('请输入服务项目，最多 120 个字符。');
  const referencePriceCents = original ? original.referencePriceCents : amount(input.referencePrice, '本次参考价', true);
  const extraPaidCents = original && !String(input.extraPaid ?? '').trim() ? original.extraPaidCents :
    amount(input.extraPaid, '实际卡外支付', true);
  const note = String(input.note ?? '').trim();
  if (note.length > 1000) throw new WalletError('备注最多 1000 个字符。');

  let debit = null;
  let status = 'pending';
  if (input.mode === 'actual') {
    debit = actualDebit(card.plan.type, input);
    if (card.plan.type === 'time_pack' && card.plan.rules.billingMinutes && debit.minutes % card.plan.rules.billingMinutes !== 0) {
      throw new WalletError('实扣与已确认的核销单位不一致，可先记录为待核对。');
    }
    status = 'confirmed';
  } else if (input.mode === 'estimate') {
    if (card.plan.type === 'time_pack') throw new WalletError('时长包请按商家实扣登记，或先保存待核对。');
    if (projection.closedAt && usedOn >= projection.closedAt) throw new WalletError('卡片已终止，可记录商家实扣或待核对情况。');
    if (projection.pending.some(event => event.date <= usedOn)) {
      throw new WalletError('请先核对当日或更早的待核对消费，或直接录入本次实扣。');
    }
    if (events.some(event => event.status !== 'pending' && event.date > usedOn)) {
      throw new WalletError('早于已有扣减的消费请补录实扣，或先保存为待核对。');
    }
    if (!card.purchase.activationDate && !card.plan.rules.validity?.startDate) {
      throw new WalletError('生效日待核对，暂无法估算扣减。可以录入实扣或保存待核对。');
    }
    if (card.plan.type === 'stored_value' && projection.remaining.principalCents === null) {
      throw new WalletError('本金与赠送金尚未分清，暂无法估算扣减。可以录入实扣或保存待核对。');
    }
    const fixed = card.plan.type === 'stored_value' ? resolveFixed(card, events, { date: usedOn, serviceId }) : {};
    if (fixed.conflict) throw new WalletError('同一服务有多个固定扣费约定，请录入实扣或保存待核对。');
    debit = estimateCardDebit(card.plan, card.purchase.activationDate,
      { date: usedOn, serviceId, referencePriceCents: fixed.amountCents ?? referencePriceCents }, projection.remaining, projection.redeemedDates);
    if (debit.missing) {
      const names = {
        validity: '有效期', coverage: '适用服务', bonusValidity: '赠送金有效期', bonusCoverage: '赠送金适用范围',
        deduction: '扣减顺序', referencePriceCents: '本次参考价',
      };
      throw new WalletError('暂无法估算扣减，请核对：' + debit.missing.map(key => names[key] ?? key).join('、') +
        '。也可以录入实扣或保存待核对。');
    }
    status = 'estimated';
  } else if (input.mode !== 'pending') {
    throw new WalletError('请选择实扣、规则估算或待核对。');
  }

  return {
    type: original ? 'consume_confirmation' : 'consume',
    confirmationFor: original?.id ?? null,
    status, date: usedOn, recordedAt, serviceId, referencePriceCents, extraPaidCents, note, debit,
  };
}

function describeDeadline(window, today, knownUnlimited = false) {
  const daysLeft = window.endDate === null ? null :
    (Date.parse(window.endDate + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000;
  return { ...window, daysLeft, knownUnlimited };
}

function expiryAlert(deadline, bonus = false) {
  const {daysLeft, endDate} = deadline;
  if (daysLeft === null || daysLeft > 30) return null;
  const label = bonus ? '赠送金' : '主卡权益';
  const stage = daysLeft < 0 ? '已到期' : daysLeft === 0 ? '今天到期' : '还有 ' + daysLeft + ' 天到期';
  const windowDays = daysLeft < 0 ? null : daysLeft <= 1 ? 1 : daysLeft <= 7 ? 7 : 30;
  return {kind:bonus ? 'bonus_expiry' : daysLeft < 0 ? 'expired' : 'expiring', endDate, daysLeft, windowDays,
    text:label + stage + '（' + endDate + '）'};
}

function cardSummary(card, events, today) {
  const { type, rules } = card.plan;
  const { activationDate, purchasedOn, paidCents } = card.purchase;
  const { pending, redeemedDates, ...usage } = projectLedger(card, events);
  const window = dateWindow(rules.validity, activationDate);
  const deadline = describeDeadline(window, today, rules.validity?.kind === 'unlimited');
  let status = 'active';
  if (usage.closedAt) status = 'closed';
  else if (deadline.daysLeft !== null && deadline.daysLeft < 0) status = 'expired';
  else if (window.startDate && window.startDate > today) status = 'not_started';
  else if (!activationDate && !window.startDate) status = 'activation_unknown';
  else if (window.status === 'unknown') status = 'validity_unknown';
  const hasRemaining = type === 'stored_value' ? usage.remaining.totalCents > 0 :
    type === 'visit_pack' ? usage.remaining.visits > 0 : type === 'time_pack' ? usage.remaining.minutes > 0 : true;
  const alerts = [];
  const mainAlert = !usage.closedAt && hasRemaining ? expiryAlert(deadline) : null;
  if (mainAlert) alerts.push(mainAlert);
  let bonusDeadline = null;
  if (type === 'stored_value' && (rules.bonusCents > 0 || usage.remaining.bonusRange[1] > 0)) {
    const same = rules.bonusValidity?.kind === 'same_as_plan';
    bonusDeadline = same ? deadline : describeDeadline(dateWindow(rules.bonusValidity, activationDate), today,
      rules.bonusValidity?.kind === 'unlimited');
    if (!usage.closedAt && !same && (deadline.endDate === null || bonusDeadline.endDate < deadline.endDate) &&
        usage.remaining.bonusRange[1] > 0) {
      const bonusAlert = expiryAlert(bonusDeadline,true);
      if (bonusAlert) alerts.push(bonusAlert);
    }
  }
  return {
    id: card.id, name: card.plan.name, type, purchasedOn, activationDate, paidCents, status, deadline, bonusDeadline,
    alerts, pendingCount: pending.length, initial: {
      principalCents: rules.principalCents ?? null, bonusCents: rules.bonusCents ?? null, visits: rules.visits ?? null,
      ...(type === 'time_pack' ? {minutes:rules.minutes,billingMinutes:rules.billingMinutes} : {}),
    }, ...usage,
  };
}

module.exports = { WalletError, amount, calendar, projectLedger, newConsumption, cardSummary, actualDebit, minuteValue, activeEvents, isConsumption };
