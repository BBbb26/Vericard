'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { reviewGroup } = require('./plan-review');
const { analyzeWorkbench, demoReview } = require('./decision-workbench');
const { createWallet, fingerprint } = require('./wallet');

const analysisInput = {
  startDate: '2026-11-10', activationDate: '2026-11-01', serviceId: '洗护', referencePrice: '200', extraFees: '0',
  scenarios: { low: { count: 1, everyDays: 1 }, base: { count: 2, everyDays: 1 }, high: { count: 3, everyDays: 1 } },
};
const now = () => new Date('2026-11-09T18:30:00Z');
const types = { 储值: 'stored_value', 次数: 'visit_pack', 期限: 'time_pass' };

function reviewed(type, overrides = {}) {
  const typed = {
    储值: { principal: '1000', bonus: '200', bonusCoverage: '全部', bonusValidity: '同主卡', deduction: '本金优先' },
    次数: { unit: '次', total: '2' },
    期限: {},
  };
  const values = { planType: type, price: '1000', coverage: '全部', validityMode: '无期限', ...typed[type], ...overrides };
  const fields = Object.fromEntries(Object.entries(values).map(([key, value]) => [
    key, { value, status: '用户核对' },
  ]));
  return reviewGroup({ id: 'real-' + types[type], name: '真实测试卡', confirmed: true, imageIds: [], fields }, []);
}

function loader(review) {
  return (id, input) => {
    assert.equal(id, review.id);
    return { review, analysis: analyzeWorkbench(review, input).analysis };
  };
}

function purchase(review, overrides = {}) {
  return {
    requestId: randomUUID(), confirmedPurchase: true, groupId: review.id, reviewTag: fingerprint(review), analysisInput,
    purchase: {
      purchasedOn: '2026-11-01', activationDate: '2026-11-01', paid: '950', coverage: { kind: 'source' },
      validity: { kind: 'unlimited' }, principal: '1000', bonus: '200', bonusCoverage: { kind: 'source' },
      bonusValidity: { kind: 'same_as_plan' }, deduction: 'principal_first', visits: '2', redemption: 'per_visit',
      ...overrides,
    },
  };
}

function fixture(t, clock = now) {
  const temporary = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporary, 'kadezhi-wallet-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), temporary);
    assert(path.basename(root).startsWith('kadezhi-wallet-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(root, 'wallet.json');
  return { file, wallet: createWallet(file, clock) };
}

function use(overrides = {}) {
  return { requestId: randomUUID(), date: '2026-11-10', serviceId: '洗护', mode: 'actual', ...overrides };
}

test('explicit actual purchase and matching source are required; reading leaves storage absent', t => {
  const { file, wallet } = fixture(t);
  const review = reviewed('储值');
  const base = purchase(review);
  assert.deepEqual(wallet.list(), { today: '2026-11-10', cards: [] });
  assert.equal(fs.existsSync(file), false);
  assert.throws(() => wallet.create({ ...base, confirmedPurchase: false }, loader(review)), /实际办卡/);
  assert.throws(() => wallet.create({ ...base, purchase: { ...base.purchase, paid: '' } }, loader(review)), /实际支付/);
  assert.throws(() => wallet.create({ ...base, reviewTag: 'stale' }, loader(review)), /证据有更新/);
  const demo = demoReview('stored');
  assert.throws(() => wallet.create(purchase(demo), loader(demo)), /真实套餐/);
  assert.equal(fs.existsSync(file), false);
});

test('stored card keeps actual purchase and immutable original plan and analysis separate', t => {
  const { file, wallet } = fixture(t);
  const review = reviewed('储值');
  const originalVersion = review.plan.version;
  const input = purchase(review, { paid: '925.30', principal: '950' });
  const first = wallet.create(input, loader(review));
  assert.equal(first.replayed, false);
  const snapshot = createWallet(file, now).get(first.cardId).card;
  assert.equal(snapshot.paidCents, 92530);
  assert.equal(snapshot.initial.principalCents, 95000);
  assert.equal(snapshot.source.analysis.plan.offerPriceCents, 100000);
  assert.equal(snapshot.source.analysis.plan.rules.principalCents, 100000);
  assert.equal(snapshot.source.planVersion, originalVersion);
  review.plan.rules.principalCents = 1;
  assert.equal(wallet.get(first.cardId).card.source.analysis.plan.rules.principalCents, 100000);
  assert.deepEqual(wallet.create(input, () => { throw Error('replay must not reload source'); }),
    { cardId: first.cardId, replayed: true });
  assert.throws(() => wallet.create({ ...input, purchase: { ...input.purchase, paid: '900' } }, loader(review)), error => error.status === 409);
  assert.equal(wallet.list().cards.length, 1);
});

test('a total-only stored-value deduction keeps the exact total and constrains both buckets', t => {
  const { wallet } = fixture(t);
  const review = reviewed('储值');
  const { cardId } = wallet.create(purchase(review), loader(review));
  const event = use({ debitAmount: '200', referencePrice: '220', extraPaid: '20' });
  const first = wallet.consume(cardId, event).card;
  assert.deepEqual(first.remaining, {
    totalCents: 100000, principalCents: null, bonusCents: null,
    principalRange: [80000, 100000], bonusRange: [0, 20000],
  });
  assert.equal(first.events[0].extraPaidCents, 2000);
  assert.equal(wallet.consume(cardId, event).replayed, true);
  assert.equal(wallet.get(cardId).card.events.length, 1);
  assert.throws(() => wallet.consume(cardId, { ...event, debitAmount: '201' }), error => error.status === 409);
  assert.throws(() => wallet.consume(cardId, use({ mode: 'estimate', referencePrice: '50' })), /本金与赠送金尚未分清/);
  const next = wallet.consume(cardId, use({ debitAmount: '200', debitPrincipal: '0' })).card;
  assert.equal(next.remaining.principalCents, 80000);
  assert.equal(next.remaining.bonusCents, 0);
  assert.throws(() => wallet.consume(cardId, use({ debitAmount: '801' })), /超过账面剩余总额/);
});

test('estimation uses original proportional basis, and unknown rules stay pending', t => {
  const { wallet } = fixture(t);
  const review = reviewed('储值');
  const { cardId } = wallet.create(purchase(review, { principal: '3', bonus: '3', deduction: 'proportional' }), loader(review));
  wallet.consume(cardId, use({ debitAmount: '2', debitPrincipal: '2' }));
  const next = wallet.consume(cardId, use({ mode: 'estimate', referencePrice: '1' })).card;
  assert.deepEqual(next.events[0].debit, { totalCents: 100, principalCents: 50, bonusCents: 50 });
  const missing = wallet.create(purchase(review, { validity: { kind: 'unknown' }, coverage: { kind: 'unknown' } }), loader(review));
  assert.throws(() => wallet.consume(missing.cardId, use({ mode: 'estimate', referencePrice: '20' })), /有效期/);
  const pending = wallet.consume(missing.cardId, use({ mode: 'pending' })).card;
  assert.equal(pending.pendingCount, 1);
  assert.equal(pending.remaining.totalCents, 120000);
});

test('pending confirmation appends a traceable actual event and deducts exactly once', t => {
  const { file, wallet } = fixture(t);
  const review = reviewed('次数');
  const { cardId } = wallet.create(purchase(review), loader(review));
  const pending = wallet.consume(cardId, use({ mode: 'pending', referencePrice: '90', note: '账单待核实' }));
  assert.equal(pending.card.remaining.visits, 2);
  assert.equal(pending.card.pendingCount, 1);
  assert.throws(() => wallet.consume(cardId, use({ mode: 'estimate' })), /先核对/);
  const confirm = use({ pendingId: pending.eventId, debitVisits: '1', extraPaid: '10' });
  const verified = wallet.consume(cardId, confirm).card;
  assert.equal(verified.remaining.visits, 1);
  assert.equal(verified.pendingCount, 0);
  assert.equal(verified.events[0].confirmationFor, pending.eventId);
  assert.equal(verified.events[0].referencePriceCents, 9000);
  assert.equal(verified.events[1].resolved, true);
  assert.equal(verified.events[1].note, '账单待核实');
  assert.equal(wallet.consume(cardId, confirm).replayed, true);
  assert.throws(() => wallet.consume(cardId, { ...confirm, requestId: randomUUID() }), error => error.status === 409);
  assert.deepEqual(createWallet(file, now).get(cardId).card, verified);
});

test('per-day redemption covers later entries that day and per-visit cards stop at zero', t => {
  const { wallet } = fixture(t);
  const review = reviewed('次数');
  const perDay = wallet.create(purchase(review, { visits: '1', redemption: 'per_day' }), loader(review)).cardId;
  wallet.consume(perDay, use({ debitVisits: '1' }));
  const repeat = wallet.consume(perDay, use({ mode: 'estimate' })).card;
  assert.deepEqual(repeat.events[0].debit, { visits: 0, covered: true });
  const perVisit = wallet.create(purchase(review, { visits: '1' }), loader(review)).cardId;
  wallet.consume(perVisit, use({ debitVisits: '1' }));
  const outside = wallet.consume(perVisit, use({ mode: 'estimate' })).card;
  assert.deepEqual(outside.events[0].debit, { visits: 0, covered: false });
  assert.equal(outside.remaining.visits, 0);
  assert.throws(() => wallet.consume(perVisit, use({ debitVisits: '1' })), /超过账面剩余次数/);
});

test('time pass deadline is inclusive and attendance is independent of days remaining', t => {
  const { file, wallet } = fixture(t);
  const review = reviewed('期限');
  const { cardId } = wallet.create(purchase(review, { validity: { kind: 'from_activation', days: '10' } }), loader(review));
  const before = wallet.get(cardId).card;
  assert.equal(before.deadline.daysLeft, 0);
  assert.equal(before.alerts[0].kind, 'expiring');
  const valid = wallet.consume(cardId, use({ mode: 'estimate' })).card;
  assert.equal(valid.coveredUses, 1);
  assert.deepEqual(valid.remaining, {});
  const nextDay = createWallet(file, () => new Date('2026-11-11T05:00:00Z'));
  const expired = nextDay.consume(cardId, use({ date: '2026-11-11', mode: 'estimate' })).card;
  assert.equal(expired.status, 'expired');
  assert.equal(expired.alerts[0].kind, 'expired');
  assert.deepEqual(expired.events[0].debit, { covered: false });
  assert.equal(expired.coveredUses, 1);
});

test('bonus can expire earlier, and unknown deadlines have no guessed alerts', t => {
  const { wallet } = fixture(t);
  const review = reviewed('储值');
  const { cardId } = wallet.create(purchase(review, {
    validity: { kind: 'fixed', endDate: '2026-12-01' }, bonusValidity: { kind: 'fixed', endDate: '2026-11-14' },
  }), loader(review));
  const before = wallet.get(cardId).card;
  assert.equal(before.bonusDeadline.daysLeft, 4);
  assert.deepEqual(before.alerts.map(item => [item.kind,item.windowDays]), [['expiring',30],['bonus_expiry',7]]);
  assert.equal(before.attention[0].kind,'bonus_expiry');
  assert.equal(before.attention[0].endDate,'2026-11-14');
  const unknown = wallet.create(purchase(review, {
    validity: { kind: 'unknown' }, bonusValidity: { kind: 'unknown' }, activationDate: '',
  }), loader(review));
  assert.deepEqual(wallet.get(unknown.cardId).card.alerts, []);
  assert.equal(wallet.get(unknown.cardId).card.deadline.daysLeft, null);
});

test('bad dates, future usage and backdated estimates never mutate the ledger', t => {
  const { wallet } = fixture(t);
  const review = reviewed('次数');
  assert.throws(() => wallet.create(purchase(review, { purchasedOn: '2026-11-11' }), loader(review)), /晚于今天/);
  const { cardId } = wallet.create(purchase(review), loader(review));
  assert.throws(() => wallet.consume(cardId, use({ date: '2026-02-30', debitVisits: '1' })), /有效日期/);
  assert.throws(() => wallet.consume(cardId, use({ date: '2026-11-11', debitVisits: '1' })), /介于/);
  wallet.consume(cardId, use({ mode: 'estimate' }));
  assert.throws(() => wallet.consume(cardId, use({ date: '2026-11-08', mode: 'estimate' })), /补录实扣/);
  assert.equal(wallet.get(cardId).card.events.length, 1);
});

test('corrupt wallet data fails closed and is not replaced by an empty wallet', t => {
  const { file, wallet } = fixture(t);
  fs.writeFileSync(file, '{ broken data', 'utf8');
  const review = reviewed('次数');
  assert.throws(() => wallet.list(), error => error.status === 500);
  assert.throws(() => wallet.create(purchase(review), loader(review)), error => error.status === 500);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ broken data');
});

test('verified fixed deduction compares only actual records and preserves original evidence', t => {
  const { wallet } = fixture(t);
  const review = reviewed('储值', { fixedDebit: '洗护每次扣减80元' });
  const { cardId } = wallet.create(purchase(review), loader(review));
  wallet.consume(cardId, use({ mode: 'estimate', referencePrice: '80' }));
  assert.equal(wallet.get(cardId).card.fulfillment.checks.length, 0);
  const actual = wallet.consume(cardId, use({ debitAmount: '100', debitPrincipal: '100' }));
  const check = actual.card.fulfillment.checks[0];
  assert.equal(check.differenceCents, 2000);
  assert.equal(check.terms[0].quote, '洗护每次扣减80元');
  assert.match(check.question, /¥100\.00.*¥20\.00/);
  review.plan.evidence.fixedDebit.value = '洗护每次扣减90元';
  assert.equal(wallet.get(cardId).card.fulfillment.checks[0].promisedCents, 8000);
  const reversed = wallet.record(cardId, { requestId: randomUUID(), type: 'reversal', targetId: actual.eventId,
    confirmed: true, note: '实扣录入错误' }).card;
  assert.equal(reversed.fulfillment.checks.length, 0);
  assert.equal(reversed.events[1].reversed, true);
});

test('supplemental quotes require clear currency and conflicting terms stay unresolved', t => {
  const { wallet } = fixture(t);
  const review = reviewed('储值', { fixedDebit: '洗护每次扣减80元' });
  const { cardId } = wallet.create(purchase(review), loader(review));
  const record = quote => ({ requestId: randomUUID(), type: 'promise', confirmed: true, quote, note: '办卡时签订的合同' });
  assert.throws(() => wallet.record(cardId, record('洗护每次扣减90')), /固定扣费原文/);
  assert.throws(() => wallet.record(cardId, record('周末另收费用，洗护每次扣减90元')), /固定扣费原文/);
  wallet.record(cardId, record('洗护每次扣减90元'));
  const result = wallet.consume(cardId, use({ debitAmount: '100' })).card.fulfillment.checks[0];
  assert.equal(result.status, 'needs_context');
  assert.equal(result.differenceCents, undefined);
  assert.equal(result.terms.length, 2);
});

test('reconciliation preserves original balance until explicit, idempotent correction', t => {
  const { wallet } = fixture(t);
  const review = reviewed('储值');
  const { cardId } = wallet.create(purchase(review), loader(review));
  const comparison = wallet.record(cardId, { requestId: randomUUID(), type: 'reconciliation', observedTotal: '950' });
  assert.equal(comparison.card.remaining.totalCents, 120000);
  assert.equal(comparison.card.events[0].difference, -25000);
  assert.equal(comparison.card.events[0].reconciliationStatus, 'needs_review');
  const adjustment = { requestId: randomUUID(), type: 'adjustment', reconciliationId: comparison.eventId,
    confirmed: true, note: '已核对商家当前账单' };
  assert.throws(() => wallet.record(cardId, { ...adjustment, confirmed: false }), /请确认/);
  const changed = wallet.record(cardId, adjustment);
  assert.equal(changed.card.remaining.totalCents, 95000);
  assert.deepEqual(changed.card.remaining.principalRange, [0, 95000]);
  assert.equal(changed.card.events[0].before.totalCents, 120000);
  assert.equal(changed.card.events[1].reconciliationStatus, 'adjusted');
  assert.equal(wallet.record(cardId, adjustment).replayed, true);
  assert.equal(wallet.get(cardId).card.events.length, 2);
});

test('stale checks are rejected and a split-only confirmation preserves the exact total', t => {
  const { wallet } = fixture(t);
  const review = reviewed('储值');
  const { cardId } = wallet.create(purchase(review), loader(review));
  const compare = (total, principal = '') => wallet.record(cardId,
    { requestId: randomUUID(), type: 'reconciliation', observedTotal: total, observedPrincipal: principal });
  const adjust = eventId => wallet.record(cardId, { requestId: randomUUID(), type: 'adjustment',
    reconciliationId: eventId, confirmed: true, note: '商家书面确认' });
  const stale = compare('1000');
  wallet.consume(cardId, use({ debitAmount: '200' }));
  assert.throws(() => adjust(stale.eventId), error => error.status === 409);
  const fresh = compare('1000', '850');
  assert.equal(fresh.card.events[0].reconciliationStatus, 'split_review');
  assert.equal(adjust(fresh.eventId).card.remaining.principalCents, 85000);
});

test('recharge, actual refund and reversal replay balances without changing earlier records', t => {
  const { wallet } = fixture(t);
  const review = reviewed('次数');
  const { cardId } = wallet.create(purchase(review), loader(review));
  const recharge = wallet.record(cardId, { requestId: randomUUID(), type: 'recharge', cash: '50',
    date: '2026-11-10', creditVisits: '3', sameTerms: true });
  assert.equal(recharge.card.remaining.visits, 5);
  const refunded = wallet.record(cardId, { requestId: randomUUID(), type: 'refund', date: '2026-11-10', cash: '35', debitVisits: '2' });
  assert.equal(refunded.card.remaining.visits, 3);
  assert.equal(refunded.card.refundedCashCents, 3500);
  wallet.consume(cardId, use({ debitVisits: '3' }));
  const reverse = id => wallet.record(cardId, { requestId: randomUUID(), type: 'reversal', targetId: id,
    confirmed: true, note: '按商家新账单冲正' });
  assert.throws(() => reverse(recharge.eventId), /超过账面/);
  const reversed = reverse(refunded.eventId).card;
  assert.equal(reversed.remaining.visits, 2);
  assert.equal(reversed.refundedCashCents, 0);
  assert.equal(reversed.events.find(event => event.id === refunded.eventId).cashCents, 3500);
  assert.equal(reversed.consumedVisits, 3);
});

test('terminating refund records cash and prevents later estimates until reversed', t => {
  const { wallet } = fixture(t);
  const review = reviewed('期限');
  const { cardId } = wallet.create(purchase(review), loader(review));
  const closing = wallet.record(cardId, { requestId: randomUUID(), type: 'refund', cash: '100',
    date: '2026-11-10', terminates: true });
  assert.equal(closing.card.status, 'closed');
  assert.throws(() => wallet.consume(cardId, use({ mode: 'estimate' })), /已终止/);
  const reversal = wallet.record(cardId, { requestId: randomUUID(), type: 'reversal', targetId: closing.eventId,
    confirmed: true, note: '退款已退回商家，恢复权益' });
  assert.equal(reversal.card.status, 'active');
  assert.equal(reversal.card.refundedCashCents, 0);
});

test('proof attachment stays separate and is linked to its transaction', t => {
  const { file, wallet } = fixture(t);
  const review = reviewed('储值');
  const { cardId } = wallet.create(purchase(review), loader(review));
  const consumption = wallet.consume(cardId, use({ debitAmount: '20', debitPrincipal: '20' }));
  const { saveWalletProof } = require('./wallet-proof');
  const root = path.join(path.dirname(file), 'wallet-proof');
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/bl8AAAAASUVORK5CYII=';
  const event = { requestId: randomUUID(), type: 'evidence', category: 'statement', linkedId: consumption.eventId,
    proof: { name: '账单.png', base64 } };
  const attached = wallet.record(cardId, event, proof => saveWalletProof(root, proof));
  assert.equal(attached.card.events[0].linkedId, consumption.eventId);
  const img = attached.card.events[0].image;
  assert.match(img.url, /^\/wallet-proof\/[a-f0-9]{64}\.png$/);
  assert.deepEqual(fs.readFileSync(path.join(root, path.basename(img.url))), Buffer.from(base64, 'base64'));
  assert.equal(fs.readFileSync(file, 'utf8').includes(base64), false);
  assert.equal(wallet.record(cardId, event, () => { throw Error('must reuse previous proof'); }).replayed, true);
});

test('fixed debit drives estimates and reversal protects later dependent estimates', t => {
  const { wallet } = fixture(t);
  const review = reviewed('储值', { fixedDebit: '洗护每次扣减80元' });
  const { cardId } = wallet.create(purchase(review), loader(review));
  const first = wallet.consume(cardId, use({ debitAmount: '100', debitPrincipal: '100' }));
  const estimated = wallet.consume(cardId, use({ mode: 'estimate', referencePrice: '120' }));
  assert.equal(estimated.card.events[0].referencePriceCents, 12000);
  assert.equal(estimated.card.events[0].debit.totalCents, 8000);
  const reversal = id => wallet.record(cardId, { requestId: randomUUID(), type: 'reversal', targetId: id,
    confirmed: true, note: '补正原始流水' });
  assert.throws(() => reversal(first.eventId), /后续有基于当时余额的规则估算/);
  reversal(estimated.eventId);
  assert.equal(reversal(first.eventId).card.remaining.totalCents, 120000);
});

test('a prior-day balance observation cannot silently adjust a newer current balance', t => {
  const { file, wallet } = fixture(t);
  const review = reviewed('次数');
  const { cardId } = wallet.create(purchase(review), loader(review));
  const observed = wallet.record(cardId, { requestId: randomUUID(), type: 'reconciliation', observedVisits: '1' });
  const tomorrow = createWallet(file, () => new Date('2026-11-11T05:00:00Z'));
  assert.equal(tomorrow.get(cardId).card.events[0].reconciliationStatus, 'stale');
  assert.throws(() => tomorrow.record(cardId, { requestId: randomUUID(), type: 'adjustment',
    reconciliationId: observed.eventId, confirmed: true, note: '使用昨天截图' }), error => error.status === 409);
  assert.equal(tomorrow.get(cardId).card.remaining.visits, 2);
});


test('manual enrollment requires actual purchase, saves a retry once and single vouchers require unused confirmation', t => {
  const { wallet } = fixture(t);
  const draft = {requestId:randomUUID(),confirmedPurchase:true,source:{kind:'manual',type:'single',name:'咖啡单次券'},
    purchase:{paid:'29',purchasedOn:'2026-11-01',activationDate:'2026-11-01',visits:'1',
      validity:{kind:'unlimited'},coverage:{kind:'unknown'}}};
  assert.throws(() => wallet.create({...draft,confirmedPurchase:false}),/实际办卡/);
  assert.throws(() => wallet.create(draft),/尚未核销/);
  draft.purchase.unredeemed = true;
  const saved = wallet.create(draft);
  assert.equal(wallet.create(draft).replayed,true);
  const {card} = wallet.get(saved.cardId);
  assert.equal(card.offerType,'single');
  assert.equal(card.plan.rules.redemption,'per_visit');
  assert.equal(card.remaining.visits,1);
  assert.throws(() => wallet.create({...draft,requestId:randomUUID(),source:{kind:'manual',type:'other',name:'其他卡'}}),/暂未开放/);
});

test('comparison enrollment saves original quote, actual paid and registered image references independently', t => {
  const { wallet } = fixture(t);
  const imageId='a'.repeat(64);
  const draft = {requestId:randomUUID(),confirmedPurchase:true,
    source:{kind:'comparison',type:'visits',name:'我的自习卡',imageIds:[imageId],
      offer:{name:'自习室次卡',type:'visits',units:'10',price:'229',validity:'unlimited'}},
    purchase:{paid:'209',purchasedOn:'2026-11-01',activationDate:'2026-11-01',visits:'10',redemption:'per_visit',
      validity:{kind:'unlimited'},coverage:{kind:'unknown'}}};
  assert.throws(() => wallet.create(draft),/来源截图/);
  const created=wallet.create(draft,null,ids=>Array.from(ids,id=>({id,ocr:{height:100,lines:[]}})));
  const {card}=wallet.get(created.cardId);
  assert.equal(card.source.kind,'comparison');
  assert.equal(card.name,'我的自习卡');
  assert.equal(card.source.comparison.name,'自习室次卡');
  assert.equal(card.source.comparison.price,22900);
  assert.equal(card.paidCents,20900);
  assert.deepEqual(card.source.imageIds,[imageId]);
  assert.equal(card.remaining.visits,10);
});

test('recent activity deduplicates pending confirmations, proof survives and balance history reflects posted debits', t => {
  const { wallet } = fixture(t);
  const review=reviewed('储值');
  const {cardId}=wallet.create(purchase(review),loader(review));
  assert.deepEqual(wallet.get(cardId).card.balanceHistory,[]);
  const provisional=wallet.consume(cardId,use({mode:'pending'}));
  assert.equal(wallet.get(cardId).card.remaining.totalCents,120000);
  assert.equal(wallet.activity().length,1);
  assert.equal(wallet.activity()[0].status,'pending');
  const paid=use({pendingId:provisional.eventId,debitAmount:'80',debitPrincipal:'80',proof:{name:'凭证'}});
  const image={id:'proof',url:'/wallet-proof/sample.png',name:'凭证'};
  const result=wallet.consume(cardId,paid,()=>image);
  assert.equal(wallet.consume(cardId,paid,()=>assert.fail('proof should not save twice')).replayed,true);
  assert.deepEqual(result.card.balanceHistory.map(point=>point.amountCents),[120000,112000]);
  assert.equal(wallet.activity().length,1);
  assert.deepEqual(wallet.activity(1,20),[]);
  assert.deepEqual(wallet.activity()[0].image,image);
  assert.equal(wallet.activity()[0].confirmationFor,provisional.eventId);
});

test('only ended cards can be archived, archives retain events and can be restored', t => {
  const { wallet }=fixture(t);
  const review=reviewed('次数');
  const {cardId}=wallet.create(purchase(review),loader(review));
  assert.throws(()=>wallet.record(cardId,{requestId:randomUUID(),type:'archive',archived:true}),/已结束|用完/);
  wallet.consume(cardId,use({debitVisits:'2'}));
  wallet.record(cardId,{requestId:randomUUID(),type:'archive',archived:true});
  assert.equal(wallet.list().cards[0].archived,true);
  assert.equal(wallet.activity().length,1);
  wallet.record(cardId,{requestId:randomUUID(),type:'archive',archived:false});
  assert.equal(wallet.get(cardId).card.archived,false);
  assert.equal(wallet.get(cardId).card.remaining.visits,0);
});


test('reminder windows and current balance discrepancy remain distinct after fulfillment review', t => {
  const { wallet } = fixture(t);
  const review = reviewed('储值', { fixedDebit: '洗护每次扣减80元' });
  const { cardId } = wallet.create(purchase(review,{
    validity:{kind:'fixed',endDate:'2026-11-11'},bonusValidity:{kind:'fixed',endDate:'2026-11-11'},
  }),loader(review));
  const actual = wallet.consume(cardId,use({debitAmount:'100',debitPrincipal:'100'}));
  assert.deepEqual(actual.card.attention.map(item=>[item.kind,item.windowDays]),[['deduction',undefined],['expiring',1]]);
  const first = wallet.record(cardId,{type:'reconciliation',requestId:randomUUID(),observedTotal:'1050'});
  const latest = wallet.record(cardId,{type:'reconciliation',requestId:randomUUID(),observedTotal:'1030'});
  assert.equal(latest.card.reconciliationReviewCount,1);
  assert.equal(latest.card.events.find(event=>event.id===first.eventId).reconciliationStatus,'stale');
  const reviewInput = {type:'fulfillment_review',requestId:randomUUID(),targetId:actual.eventId,confirmed:true,note:'商家答复已记录'};
  const checked = wallet.record(cardId,reviewInput);
  assert.equal(checked.card.remaining.totalCents,110000);
  assert.equal(checked.card.fulfillment.checks[0].differenceCents,2000);
  assert.deepEqual(checked.card.attention.map(item=>item.kind),['expiring','balance']);
  assert.equal(wallet.record(cardId,reviewInput).replayed,true);
});

test('stored balance history keeps merchant observations separate and only changes with ledger events', t => {
  const {wallet}=fixture(t);
  const review=reviewed('储值');
  const {cardId}=wallet.create(purchase(review),loader(review));
  wallet.consume(cardId,use({debitAmount:'400',debitPrincipal:'400'}));
  const observation=wallet.record(cardId,{requestId:randomUUID(),type:'reconciliation',observedTotal:'700'});
  const point=observation.card.balanceHistory.at(-1);
  assert.deepEqual([point.amountCents,point.merchantCents,point.principalCents,point.bonusCents],[80000,70000,60000,20000]);
  const after=wallet.consume(cardId,use({debitAmount:'80',debitPrincipal:'80'})).card;
  assert.equal(after.balanceHistory.at(-1).amountCents,72000);
  assert.equal(after.balanceHistory.at(-1).debitCents,8000);
  assert.equal(after.balanceHistory.find(p=>p.merchantCents).amountCents,80000);
});

test('time packs record only known actual minutes, validate unit and keep corrections auditable', t => {
  const {wallet}=fixture(t);
  const {cardId}=wallet.create({requestId:randomUUID(),confirmedPurchase:true,source:{kind:'manual',type:'hours',name:'10 小时自习包'},
    purchase:{paid:'200',purchasedOn:'2026-11-01',activationDate:'2026-11-01',minutes:'600',billingMinutes:'30',
      validity:{kind:'unlimited'},coverage:{kind:'all'}}});
  assert.throws(()=>wallet.consume(cardId,use({debitMinutes:'45'})),/核销单位/);
  assert.throws(()=>wallet.consume(cardId,use({debitMinutes:'630'})),/超过剩余时长/);
  const current=wallet.consume(cardId,use({debitMinutes:'90'}));
  assert.equal(current.card.remaining.minutes,510);
  assert.equal(current.card.consumedMinutes,90);
  assert.equal(wallet.get(cardId).card.initial.billingMinutes,30);
  const observation=wallet.record(cardId,{requestId:randomUUID(),type:'reconciliation',observedMinutes:'480'});
  assert.equal(observation.card.remaining.minutes,510);
  assert.equal(observation.card.events[0].difference,-30);
  const corrected=wallet.record(cardId,{requestId:randomUUID(),type:'adjustment',reconciliationId:observation.eventId,confirmed:true,note:'核对账单'});
  assert.equal(corrected.card.remaining.minutes,480);
  assert.equal(corrected.card.events.find(event=>event.id===current.eventId).debit.minutes,90);
});
