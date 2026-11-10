'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const E = require('./extract');
const T = require('./offer-terms');
const { reviewGroup } = require('./plan-review');
const { analyzeWorkbench, demoReview } = require('./decision-workbench');

function image(id, lines) {
  return { id, ocr: { width: 1000, height: 2000, lines: lines.map((text, line) => ({
    id: line, text, box: { x: 20, y: 200 + 50 * line, width: 650, height: 50 },
  })) } };
}

function projectGroup(values = {}, images = [], overrides = {}) {
  return {
    id: 'review-test', name: '样本套餐', imageIds: images.map(item => item.id), confirmed: true,
    fields: Object.fromEntries(Object.entries(values).map(([key, value]) => [
      key, typeof value === 'string' ? { value, status: '用户核对' } : value,
    ])),
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    startDate: '2026-11-10', activationDate: '2026-11-10',
    serviceId: '洗护', referencePrice: '200', extraFees: '',
    scenarios: { low: { count: 4, everyDays: 1 }, base: { count: 6, everyDays: 1 }, high: { count: 7, everyDays: 1 } },
    ...overrides,
  };
}

const storedFields = {
  planType: '储值', price: '1000', principal: '1000', bonus: '200',
  deduction: '本金优先', coverage: '全部', validityMode: '无期限', bonusValidity: '同主卡', fee: '0',
};

test('OCR supports three types with original text and separate date fields', () => {
  const stored = E.extract(image('stored', ['商家名称：示例门店', '充¥1000赠¥200', '赠送金有效至2026年12月1日',
    '赠送金核销后30天有效', '赠送金适用项目：仅限洗护', '先扣本金', '套餐价：¥1000']));
  const field = key => stored.find(item => item.field === key);
  assert.deepEqual(['planType', 'principal', 'bonus', 'bonusEnd', 'bonusDays', 'bonusCoverage', 'deduction', 'price']
    .map(key => field(key)?.value), ['储值', '1000', '200', '2026-12-01', '30', '仅限洗护', '本金优先', '1000']);
  assert.equal(field('fixedEnd'), undefined);
  assert.equal(field('expiryDays'), undefined);
  assert.equal(field('bonusEnd').sourceType, 'ocr');
  assert.equal(field('bonusEnd').quote, '赠送金有效至2026年12月1日');
  assert.equal(field('bonusEnd').imageId, 'stored');
  assert.equal(field('bonusEnd').box.x, 20);

  const visits = E.extract(image('visits', ['¥1200购买20次私教课程']));
  assert.deepEqual(visits.map(item => item.value), ['次数', '1200', '20', '次']);
  const time = E.extract(image('time', ['¥900半年健身会员', '有效期：2026年11月10日至2027年5月9日']));
  assert.equal(time.find(item => item.field === 'planType').value, '期限');
  assert.equal(time.find(item => item.field === 'fixedStart').value, '2026-11-10');
  assert.equal(time.find(item => item.field === 'fixedEnd').value, '2027-05-09');
  assert(!time.some(item => ['total', 'expiryDays'].includes(item.field)));
});

test('a promotion never supplies paid amount, bonus validity or fee facts by default', () => {
  const promotional = E.extract(image('a', ['充¥1000赠¥200', '省¥89', '视情况加收费用']));
  assert(!promotional.some(item => ['actualPrice', 'price', 'bonusValidity', 'fee'].includes(item.field)));
  assert.equal(T.describeField('refund', null, []), 'missing');
  assert.equal(T.describeField('principal', { value: '1000', status: '待核对' }, []), 'ambiguous');
  assert.equal(T.describeField('principal', { value: '1000', status: '用户核对' }, []), 'explicit');
  assert.equal(T.describeField('restrictions', null, [{ value: '节假日另收费用' }]), 'potential_risk');
  assert.equal(T.describeField('refund', null, [{ value: '未消费可退' }, { value: '概不退款' }]), 'conflicting');
  assert.equal(T.describeField('refund', null, [{ value: '核销前可退，核销后不可退' }]), 'potential_risk');
});

test('conflicting OCR and incompatible card fields do not become executable facts', () => {
  const images = [image('a', ['套餐价：¥1000']), image('b', ['套餐价：¥1100'])];
  const pending = { value: '1000', status: '待核对' };
  const review = reviewGroup(projectGroup({ ...storedFields, price: pending }, images), images);
  assert.equal(review.fields.price.status, 'conflicting');
  assert.equal(review.plan.offerPriceCents, null);
  assert.deepEqual(review.fields.price.candidates.map(item => item.imageId), ['a', 'b']);
  const mismatch = reviewGroup(projectGroup({ ...storedFields, unit: '次' }), []);
  assert.equal(mismatch.plan, null);
  assert.equal(mismatch.fields.planType.status, 'conflicting');
  assert.throws(() => reviewGroup(projectGroup({}, [], { confirmed: false }), []), /同一套餐/);
  const dates = reviewGroup(projectGroup({ ...storedFields, expiryDays: '90' }), []);
  assert.equal(dates.fields.expiryDays.status, 'conflicting');
  assert.equal(dates.plan.rules.validity, null);
  const written = reviewGroup(projectGroup({
    planType: '期限', price: '430', total: '30', unit: '连续天', expiryDays: '30天',
  }), []);
  assert.deepEqual(written.plan.rules.validity, { kind: 'from_activation', days: 30 });
});

test('field edits replace the effective version while assumed values stay outside Plan', () => {
  const group = projectGroup({
    ...storedFields, bonusCoverage: { value: '全部', status: '试算假设' },
  });
  const before = reviewGroup(group, []);
  const base = analyzeWorkbench(before, input()).analysis.scenarios[1].result;
  assert.equal(before.plan.rules.bonusCoverage, null);
  assert.equal(base.status, 'conditional');
  assert.equal(base.cash.totalCents, 100000);
  group.fields.price.value = '1100';
  const after = reviewGroup(group, []);
  assert.notEqual(before.plan.version, after.plan.version);
  assert.equal(analyzeWorkbench(after, input()).analysis.scenarios[1].result.cash.totalCents, 110000);
  assert.equal(before.plan.offerPriceCents, 100000);
});

test('sensitivity asks only when bonus coverage can matter and keeps ranges after skipping', () => {
  const review = demoReview('stored');
  const pending = analyzeWorkbench(review, input());
  const question = pending.questions[0];
  assert.equal(question.key, 'bonusCoverage');
  assert.equal(question.changesConclusion, true);
  assert.equal(question.impact, 20000);
  assert.deepEqual(question.branches.map(branch => branch.outcomes[1].cash), [100000, 120000]);
  assert(pending.steps.some(step => step.tool === 'compare_rule_options'));
  assert.equal(pending.steps.at(-1).tool, 'ask_user');
  const skipped = analyzeWorkbench(review, input({ skipped: ['bonusCoverage'] }));
  assert.equal(skipped.questions.length, 0);
  assert.equal(skipped.ranges.length, 1);
  assert.equal(skipped.steps.at(-1).tool, 'show_conditional');
  const noImpact = analyzeWorkbench(review, input({
    scenarios: { low: { count: 1, everyDays: 1 }, base: { count: 2, everyDays: 1 }, high: { count: 3, everyDays: 1 } },
  }));
  assert.equal(noImpact.questions.length, 0);
  assert.equal(noImpact.steps.at(-1).tool, 'show_result');
});

test('a scenario answer recalculates the three results without changing the source evidence', () => {
  const review = demoReview('stored');
  const output = analyzeWorkbench(review, input({ answers: { bonusCoverage: '计划中的项目适用' } }));
  assert.deepEqual(output.analysis.scenarios.map(item => item.result.cash.totalCents), [100000, 100000, 120000]);
  assert.equal(output.analysis.scenarios[1].breakEven.count, 5);
  assert.equal(output.analysis.scenarios[1].result.status, 'conditional');
  assert.match(output.assumptions.join('\n'), /赠送金/);
  assert.equal(review.plan.rules.bonusCoverage, null);
  assert.equal(output.questions.length, 0);
  assert.equal(output.merchantQuestions.length, 2);
});

test('unmodeled restrictions can be explicitly conditioned but stacking remains unsupported', () => {
  const group = projectGroup({ ...storedFields, bonusCoverage: '全部', schedule: '周末不可用' });
  const review = reviewGroup(group, []);
  const pending = analyzeWorkbench(review, input());
  assert.equal(pending.questions[0].key, 'restrictions');
  assert.equal(pending.analysis.scenarios[1].result.status, 'unsupported');
  assert.equal(pending.ranges[0].branches[0].outcomes[1].cash, 100000);
  const conditional = analyzeWorkbench(review, input({ answers: { restrictions: '仅在计划符合原文限制时试算' } }));
  assert.equal(conditional.analysis.scenarios[1].result.status, 'conditional');
  assert.match(conditional.assumptions.join(' '), /符合已列原文限制/);
  group.fields.stacking = { value: '赠送金和项目折扣同时叠加', status: '用户核对' };
  assert.equal(analyzeWorkbench(reviewGroup(group, []), input({ answers: { restrictions: '仅在计划符合原文限制时试算' } }))
    .analysis.scenarios[1].result.status, 'unsupported');
});

test('missing inputs limit a round to two questions and do not imply a refund', () => {
  const group = projectGroup({ planType: '次数', unit: '次' });
  const output = analyzeWorkbench(reviewGroup(group, []), input({ referencePrice: '' }));
  assert.equal(output.questions.length, 2);
  assert.equal(output.merchantQuestions.length, 3);
  assert(output.analysis.scenarios.every(item => item.result.cash.totalCents === null));
  assert(output.analysis.scenarios.every(item => item.result.refund.amountCents === null));
});

test('visit and time demos compare scheduled overage and locate break-even dates', () => {
  const scenarios = { low: { count: 8, everyDays: 4 }, base: { count: 15, everyDays: 4 }, high: { count: 24, everyDays: 4 } };
  const visit = analyzeWorkbench(demoReview('visits'), input({ scenarios, referencePrice: '90' }));
  assert.equal(visit.analysis.scenarios[1].breakEven.count, 14);
  assert.equal(visit.analysis.scenarios[2].result.entitlement.remainingVisits, 0);
  assert.equal(visit.analysis.scenarios[2].result.cash.outsideCents, 36000);
  const time = analyzeWorkbench(demoReview('time'), input({
    scenarios: { ...scenarios, high: { count: 30, everyDays: 7 } }, referencePrice: '80',
  }));
  assert.equal(time.analysis.scenarios[2].result.entitlement.coveredUses, 26);
  assert.equal(time.analysis.scenarios[2].result.cash.outsideCents, 32000);
  assert.equal(time.analysis.scenarios[2].breakEven.count, 12);
});

test('interacting unknown rules are ranked with a bounded, visible joint assumption', () => {
  const source = { ...storedFields };
  delete source.coverage;
  const group = projectGroup(source);
  const review = reviewGroup(group, []);
  const analyzed = analyzeWorkbench(review, input());
  const question = analyzed.questions[0];
  assert.equal(question.key, 'coverage');
  assert.equal(question.context.key, 'bonusCoverage');
  assert(question.impact > 0);
  assert.equal(analyzed.analysis.scenarios[1].result.cash.totalCents, null);
  const answered = analyzeWorkbench(review, input({ answers: { coverage: '计划中的项目适用' } }));
  assert.equal(answered.questions[0].key, 'bonusCoverage');
  assert.equal(answered.analysis.scenarios[1].input.ruleAssumptions.bonusCoverage, undefined);
});

test('cost curve keeps zero use, an exact break-even point and overage from engine results', () => {
  const options = input({ includeCostCurve: true, answers: { bonusCoverage: '计划中的项目适用' } });
  const { costCurve, analysis } = analyzeWorkbench(demoReview('stored'), options);
  assert.equal(costCurve.normalCount, 6);
  assert.deepEqual(costCurve.points[0], { count: 0, prepaid: 100000, payAsYouGo: 0, difference: -100000 });
  assert.deepEqual(costCurve.points[5], { count: 5, prepaid: 100000, payAsYouGo: 100000, difference: 0 });
  assert.equal(costCurve.points[6].prepaid, analysis.scenarios[1].result.cash.totalCents);
  assert.deepEqual(costCurve.points[7], { count: 7, prepaid: 120000, payAsYouGo: 140000, difference: 20000 });
  assert.equal(analyzeWorkbench(demoReview('stored'), input()).costCurve, undefined);
});

test('a conditional cost curve preserves unknown points and reuses the same conditions', () => {
  const { costCurve } = analyzeWorkbench(demoReview('stored'), input({ includeCostCurve: true }));
  assert.equal(costCurve.points[5].difference, 0);
  assert.equal(costCurve.points[6].prepaid, null);
  assert.deepEqual(costCurve.variants.map(branch => branch.points[7].prepaid), [120000, 140000]);
  const fields = { ...storedFields };
  delete fields.coverage;
  const joint = analyzeWorkbench(reviewGroup(projectGroup(fields), []), input({ includeCostCurve: true }));
  assert.equal(joint.ranges[0].context.key, 'bonusCoverage');
  assert.deepEqual(joint.costCurve.variants.map(branch => branch.points[6].prepaid), [100000, 220000]);
});

test('the extended count axis uses normal cadence and charges uses outside the validity window', () => {
  const scenarios = { low: { count: 1, everyDays: 1 }, base: { count: 3, everyDays: 60 }, high: { count: 5, everyDays: 1 } };
  const { costCurve } = analyzeWorkbench(demoReview('time'), input({ scenarios, referencePrice: '80', includeCostCurve: true }));
  assert.equal(costCurve.points.length, 6);
  assert.equal(costCurve.points[3].prepaid, 90000);
  assert.equal(costCurve.points[4].prepaid, 98000);
  assert.equal(costCurve.points[5].prepaid, 106000);
});
