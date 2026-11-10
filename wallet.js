'use strict';

const fs = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { createPlan, lastDate } = require('./model');
const { positive } = require('./plan-review');
const { WalletError, amount, calendar, projectLedger, newConsumption, cardSummary, activeEvents } = require('./wallet-ledger');

const { newWalletEvent, reconciliationState, reversible } = require('./wallet-events');
const { fulfillmentFor, fixedEstimate } = require('./wallet-fulfillment');
const { reviewWalletSource } = require('./wallet-enrollment');

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const localDay = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
  }
  return value;
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
}

function request(input) {
  if (!input || typeof input !== 'object' || typeof input.requestId !== 'string' || !idPattern.test(input.requestId)) {
    throw new WalletError('缺少有效的提交编号，请刷新页面后重试。');
  }
  return { id: input.requestId, fingerprint: fingerprint(input) };
}

function assertReplay(previous, key) {
  if (previous.fingerprint !== key.fingerprint) throw new WalletError('该提交编号已用于另一份内容，请重新提交。', 409);
}

function dateRule(input, label, activationDate, sameAllowed = false) {
  const kind = input?.kind;
  if (kind === 'unknown') return null;
  if (kind === 'unlimited' || (kind === 'same_as_plan' && sameAllowed)) return { kind };
  if (kind === 'from_activation') {
    const days = positive(input.days);
    if (!days) throw new WalletError(label + '请输入正整数天数。');
    if (activationDate) lastDate(activationDate, days);
    return { kind, days };
  }
  if (kind === 'fixed') {
    const endDate = calendar(input.endDate, label + '截止日');
    const startDate = input.startDate ? calendar(input.startDate, label + '起始日') : null;
    if (startDate && startDate > endDate) throw new WalletError(label + '截止日早于起始日。');
    return { kind, startDate, endDate };
  }
  throw new WalletError('请选择' + label + '，未知时请选择待核对。');
}

function coverageRule(input, source, label) {
  if (input?.kind === 'source') return source;
  if (input?.kind === 'unknown') return null;
  if (input?.kind === 'all' || input?.kind === 'none') return { kind: input.kind };
  if (input?.kind === 'services') {
    const serviceIds = String(input.services ?? '').split(/[、,，]/).map(value => value.trim()).filter(Boolean);
    if (serviceIds.length && serviceIds.length <= 30 && serviceIds.every(value => value.length <= 120)) {
      return { kind: 'services', serviceIds };
    }
  }
  throw new WalletError(label + '请选择适用范围或填写服务名称。');
}

function knownChoice(value, values, label) {
  if (value === 'unknown') return null;
  if (!values.includes(value)) throw new WalletError('请选择' + label + '，未知时请选择待核对。');
  return value;
}

function purchasedCard(key, input, review, analysis, now) {
  if (input.confirmedPurchase !== true) throw new WalletError('请确认已经实际办卡。');
  const details = input.purchase;
  if (!details || typeof details !== 'object') throw new WalletError('请填写实际办卡信息。');
  const purchasedOn = calendar(details.purchasedOn, '购买日');
  const activationDate = details.activationDate ? calendar(details.activationDate, '生效日') : null;
  if (purchasedOn > localDay.format(now)) throw new WalletError('实际购买日不能晚于今天。');
  if (activationDate && activationDate < purchasedOn) throw new WalletError('生效日不能早于购买日。');
  const paidCents = amount(details.paid, '实际支付');
  const original = review.plan;
  const rules = {
    validity: dateRule(details.validity, '主卡有效期', activationDate),
    coverage: coverageRule(details.coverage, original.rules.coverage, '适用服务'),
  };
  if (original.type === 'stored_value') {
    const principalCents = amount(details.principal, '实际充值本金');
    const bonusCents = amount(details.bonus, '实际赠送金');
    if (!Number.isSafeInteger(principalCents + bonusCents) || principalCents + bonusCents === 0) {
      throw new WalletError('实际开卡权益合计必须大于零且在可计算范围内。');
    }
    Object.assign(rules, {
      principalCents, bonusCents,
      bonusCoverage: bonusCents ? coverageRule(details.bonusCoverage, original.rules.bonusCoverage, '赠送金适用服务') : null,
      bonusValidity: bonusCents ? dateRule(details.bonusValidity, '赠送金有效期', activationDate, true) : null,
      deduction: knownChoice(details.deduction, ['principal_first', 'bonus_first', 'proportional'], '扣减顺序'),
    });
  } else if (original.type === 'visit_pack') {
    if (review.walletSource?.offerType === 'single' && details.unredeemed !== true) throw new WalletError('仅可登记实际购买且尚未核销的单次券。');
    const visits = positive(details.visits);
    if (!visits) throw new WalletError('实际取得次数须为正整数。');
    Object.assign(rules, {
      visits, redemption: review.walletSource?.offerType === 'single' ? 'per_visit' : knownChoice(details.redemption, ['per_day', 'per_visit'], '扣次方式'),
    });
  }
  if (original.type === 'time_pack') {
    const minutes = positive(details.minutes);
    const billingMinutes = details.billingMinutes ? positive(details.billingMinutes) : null;
    if (!minutes) throw new WalletError('实际获得时长须填写正整数分钟。');
    if (details.billingMinutes && (!billingMinutes || billingMinutes > 1440)) throw new WalletError('核销单位须为 1–1440 分钟。');
    Object.assign(rules,{minutes,billingMinutes});
  }
  const limitations = (review.restrictions ?? []).map(rule => ({ ...rule }));
  const plan = createPlan({
    ...original,
    rules,
    unsupportedRules: [
      ...original.unsupportedRules,
      ...(limitations.length ? ['截图中有时段、预约或其他未建模限制'] : []),
    ],
  });
  return {
    ...key, createdAt: now.toISOString(),
    purchase: { paidCents, purchasedOn, activationDate },
    plan,
    source: { ...(review.walletSource ?? { groupId: review.id }), planVersion: original.version, analysis, limitations },
  };
}

function createWallet(file, clock = () => new Date()) {
  function read() {
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.cards) || !Array.isArray(state.events)) {
        throw new Error('invalid wallet schema');
      }
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, cards: [], events: [] };
      throw new WalletError('卡包文件无法读取，请从备份核对本地卡包文件。', 500);
    }
  }

  function write(state) {
    const temporary = file + '.' + randomUUID() + '.tmp';
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx');
      fs.writeFileSync(fd, JSON.stringify(state, null, 2));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, file);
    } catch {
      throw new WalletError('保存卡包失败，请保留本次提交后重试。', 500);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') console.warn('Wallet temporary cleanup failed'); }
    }
  }

  function find(state, id) {
    const card = state.cards.find(item => item.id === id);
    if (!card) throw new WalletError('找不到该卡片。', 404);
    return card;
  }

  const eventsFor = (state, id) => state.events.filter(event => event.cardId === id);
  const publicEvent = ({ fingerprint: ignored, ...event }) => event;

  function consumptionRows(events) {
    const live = activeEvents(events);
    const resolved = new Set(live.map(event => event.confirmationFor).filter(Boolean));
    return live.filter(event => ['consume','consume_confirmation'].includes(event.type) && !resolved.has(event.id));
  }

  function compareActivity(a, b) {
    return b.date.localeCompare(a.date) || b.recordedAt.localeCompare(a.recordedAt);
  }

  function balanceHistory(card, events) {
    if (card.plan.type !== 'stored_value') return [];
    const relevant = events.flatMap((event,index) => event.debit || event.balanceAffecting ||
      ['recharge','refund','adjustment','reconciliation'].includes(event.type) ? [index] : []);
    if (!relevant.length) return [];
    const points = new Set();
    for (let step = 0; step <= 7; step++) points.add(relevant[Math.round(step * (relevant.length - 1) / 7)]);
    const observation = events.findLastIndex(event => event.type === 'reconciliation');
    if (observation >= 0) points.add(observation);
    const project = (recorded,label,entry) => {
      const {totalCents,principalCents,bonusCents} = projectLedger(card,recorded).remaining;
      return {amountCents:totalCents,principalCents,bonusCents,label,kind:entry?.type ?? 'opening',
        estimated:activeEvents(recorded).some(event => event.status === 'estimated'),
        ...(entry?.serviceId ? {serviceId:entry.serviceId,eventDate:entry.date,debitCents:entry.debit?.totalCents} : {}),
        ...(entry?.type === 'reconciliation' ? {merchantCents:entry.observed.totalCents} : {})};
    };
    return [project([],card.purchase.purchasedOn), ...Array.from(points).sort((a,b)=>a-b).map(index =>
      project(events.slice(0,index+1),localDay.format(new Date(events[index].recordedAt)),events[index]))];
  }

  function summary(card, events, today, fulfillment = fulfillmentFor(card, events)) {
    const live = activeEvents(events);
    const projection = cardSummary(card, events, today);
    const openDifference = fulfillment.checks.filter(item => item.status === 'difference' && !item.reviewId);
    const pendingBalance = live.findLast(event => event.type === 'reconciliation');
    const balanceReview = pendingBalance && ['needs_review','split_review'].includes(reconciliationState(pendingBalance,events,live,today)) ? pendingBalance : null;
    const deadlines = projection.alerts.slice().sort((a,b) => Math.abs(a.daysLeft) - Math.abs(b.daysLeft));
    const attention = [
      ...openDifference.slice(-1).map(check => ({kind:'deduction',priority:0, label:'扣费差异', anchor:'#check-' + check.eventId,
        differenceCents:check.differenceCents, count:openDifference.length})),
      ...deadlines.map(alert => ({ ...alert, priority:alert.daysLeft >= 0 && alert.daysLeft <= 1 ? 1 : alert.daysLeft < 0 ? 2 : alert.windowDays === 7 ? 3 : 4,
        label:alert.daysLeft < 0 ? '已到期' : '临期', anchor:'#walletHighlights' })),
      ...(balanceReview ? [{kind:'balance',priority:5,label:'余额待核对',anchor:'#event-' + balanceReview.id,text:'商家余额与账面有差异，可查看对账明细。'}] : []),
      ...(projection.pendingCount ? [{kind:'pending',priority:6,label:'消费待核对',anchor:'#ledger',text:'有 ' + projection.pendingCount + ' 笔消费待补录实扣。'}] : []),
    ].sort((a,b)=>a.priority-b.priority);
    return {
      ...projection, attention,
      offerType: card.source?.offerType ?? null,
      archived: live.findLast(event => event.type === 'archive')?.archived === true,
      lastUsedOn: consumptionRows(events).sort(compareActivity)[0]?.date ?? null,
      fulfillmentDifferenceCount: openDifference.length,
      reconciliationReviewCount: balanceReview ? 1 : 0,
    };
  }

  function detail(state, card, today) {
    const events = eventsFor(state, card.id);
    const live = activeEvents(events);
    const liveIds = new Set(live.map(event => event.id));
    const resolved = new Set(live.map(event => event.confirmationFor).filter(Boolean));
    const fulfillment = fulfillmentFor(card, events);
    return {
      ...summary(card, events, today, fulfillment),
      plan: card.plan, source: card.source, createdAt: card.createdAt,
      fulfillment, balanceHistory: balanceHistory(card, events),
      events: events.map(event => ({
        ...publicEvent(event), resolved: resolved.has(event.id), reversed: !liveIds.has(event.id),
        canReverse: reversible.has(event.type) && liveIds.has(event.id),
        ...(event.type === 'reconciliation' ? { reconciliationStatus: reconciliationState(event, events, live, today) } : {}),
      })).reverse(),
    };
  }

  function create(input, loadReview, loadImages = () => [], loadAgent) {
    const key = request(input);
    const state = read();
    const previous = state.cards.find(card => card.id === key.id);
    if (previous) {
      assertReplay(previous, key);
      return { cardId: previous.id, replayed: true };
    }
    if (input.confirmedPurchase !== true) throw new WalletError('请确认已经实际办卡。');
    if (input.source?.kind === 'agent') {
      if (!loadAgent) throw new WalletError('找不到这份对话分析。', 404);
      const { review, analysis, reviewTag } = loadAgent(input.source.analysisId);
      if (!review.plan || review.demo || !analysis) throw new WalletError('请从有效的截图分析进入办卡流程。');
      if (input.source.reviewTag !== reviewTag) throw new WalletError('分析有更新，请回看板核对后再办卡。', 409);
      const card = purchasedCard(key, input, review, analysis, clock());
      state.cards.push(card);
      write(state);
      return { cardId: card.id, replayed: false };
    }
    if (input.source !== undefined) {
      const review = reviewWalletSource(input.source, loadImages);
      const card = purchasedCard(key, input, review, null, clock());
      state.cards.push(card);
      write(state);
      return { cardId: card.id, replayed: false };
    }
    if (typeof input.groupId !== 'string' || !input.groupId || !input.analysisInput) {
      throw new WalletError('请从已核对的真实套餐分析进入办卡流程。');
    }
    const { review, analysis } = loadReview(input.groupId, input.analysisInput);
    if (!review.plan || review.demo || !analysis) throw new WalletError('请从已核对的真实套餐分析进入办卡流程。');
    if (input.reviewTag !== fingerprint(review)) throw new WalletError('套餐证据有更新，请回到看板重新计算再办卡。', 409);
    const card = purchasedCard(key, input, review, analysis, clock());
    state.cards.push(card);
    write(state);
    return { cardId: card.id, replayed: false };
  }

  function append(id, input, buildEvent, attachProof) {
    const key = request(input);
    const state = read();
    const card = find(state, id);
    const events = eventsFor(state, id);
    const previous = events.find(event => event.id === key.id);
    const now = clock();
    const today = localDay.format(now);
    if (previous) {
      assertReplay(previous, key);
      return { card: detail(state, card, today), eventId: previous.id, replayed: true };
    }
    const event = { ...key, cardId: id, ...buildEvent(card, events, input, today, now.toISOString()) };
    projectLedger(card, [...events, event]);
    if (attachProof && input.proof) event.image = attachProof(input.proof);
    state.events.push(event);
    write(state);
    return { card: detail(state, card, today), eventId: event.id, replayed: false };
  }

  return {
    create,
    consume: (id, input, attachProof) => append(id, input, (card, events, data, today, recordedAt) =>
      newConsumption(card, events, data, today, recordedAt, fixedEstimate), attachProof),
    activity(offset = 0, limit = 5) {
      const state = read();
      const cards = new Map(state.cards.map(card => [card.id, card]));
      return consumptionRows(state.events).sort(compareActivity).slice(offset, offset + limit).flatMap(event => {
        const card = cards.get(event.cardId);
        return card ? [{ ...publicEvent(event), cardName:card.plan.name, cardType:card.plan.type, offerType:card.source?.offerType }] : [];
      });
    },
    record(id, input, lookupImage = () => null) {
      return append(id, input, (card, events, data, today, recordedAt) => {
        if (data.type !== 'fulfillment_review') return newWalletEvent(card, events, data, today, recordedAt, lookupImage);
        const check = fulfillmentFor(card, events).checks.find(item => item.eventId === data.targetId && item.status === 'difference' && !item.reviewId);
        if (!check) throw new WalletError('该扣费差异已经核对，或当前无法比较。', 409);
        const note = String(data.note ?? '').trim();
        if (data.confirmed !== true || !note || note.length > 1000) throw new WalletError('请确认并填写核对结果，最多 1000 字。');
        return {type:data.type, date:today, recordedAt, targetId:check.eventId, promisedCents:check.promisedCents, note};
      });
    },
    list() {
      const state = read();
      const today = localDay.format(clock());
      return { today, cards: state.cards.map(card => summary(card, eventsFor(state, card.id), today)).reverse() };
    },
    get(id) {
      const state = read();
      const today = localDay.format(clock());
      return { today, card: detail(state, find(state, id), today) };
    },
  };
}

module.exports = { createWallet, fingerprint, WalletError };
