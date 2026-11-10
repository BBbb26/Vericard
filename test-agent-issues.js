'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Compare = require('./comparison');
const Issues = require('./agent-issues');
const { createIssueHistory } = require('./agent/issue-history');

function page(id, ...lines) {
  return { id, url: '/images/' + id + '.png', ocr: { width: 800, height: 1000,
    lines: lines.map((text, i) => ({ text, box: { x: 12, y: 10 + i * 24, width: 500, height: 20 } })),
  } };
}

test('multi-pack coverage is a selectable scenario while the purchase limit is unknown', () => {
  const visit = Compare.packageSummary([page('pack', '10次卡【河景位】', '套餐价229元')]);
  assert.equal(Compare.packagePreview(visit, 15, 30).missing, 5);
  const branch = Compare.purchaseAlternative(visit, 15, 30);
  assert.deepEqual(branch, { paid: 45800, covered: 15, missing: 0, perVisit: 3053, quantity: 2, quota: 20, left: 5 });
  assert.deepEqual(Compare.packagePreview(visit, 15, 30, 2), branch);
  assert.equal(Compare.purchaseAlternative({ ...visit, limit: 1 }, 15, 30), null);
  assert.equal(Compare.purchaseAlternative({ ...visit, stackingBlocked: true }, 15, 30), null);
  assert.equal(Compare.packagePreview({ ...visit, stackingBlocked: true }, 15, 30, 2).quantity, 1);
});

test('matches package versions before deduplication and separates explicitly different conditions', () => {
  const one = page('v1', '晚自习月卡【河景位】', '套餐价359元', '套餐编号：sale-18', '条款版本：v1',
    '首访无需预约，后续每次需提前两小时预约', '购买后90天内有效', '连续30天使用');
  const two = page('v2', '晚自习月卡【河景位】', '套餐价359元', '套餐编号：sale-18', '条款版本：v2',
    '购买后15天内有效', '连续30天使用');
  const unknown = page('unbound', '需要提前预约');
  const { groups, unmatched } = Compare.groupPackages([one, two, unknown]);
  assert.deepEqual(groups.map(group => group.map(image => image.id)), [['v1'], ['v2']]);
  assert.deepEqual(unmatched.map(image => image.id), ['unbound']);
  const [first, second] = groups.map(Compare.packageSummary);
  assert.equal(first.packageId, second.packageId);
  assert.notEqual(first.version, second.version);
  assert.deepEqual(Issues.catalog([first, second]), []);
});

test('merges duplicate evidence, retains its original wording, and ranks by coverage impact', () => {
  const visit = Compare.packageSummary([page('pack', '10次卡【河景位】', '套餐价229元')]);
  const headline = page('month', '晚自习月卡【河景位】', '套餐价359元', '条款版本：v1', '连续30天使用',
    '购买后 90 天内有效', '验券后不可退', '未消费余额30%手续费');
  const rules = page('rules', '条款版本：v1', '购买后 90 天内有效', '购买后15天内有效', '部分未使用可退');
  const month = Compare.packageSummary([headline, rules]);
  const issues = Issues.catalog([visit, month]);
  const deadline = issues.find(issue => issue.topic === 'validity');
  assert.equal(deadline.label, '同口径待核对');
  assert.equal(deadline.evidence.find(entry => entry.value === '90 天').sources.length, 2);
  assert(deadline.evidence.some(entry => entry.sources.some(source => source.quote === '购买后 90 天内有效')));
  assert.equal(issues.filter(issue => issue.topic === 'refund').length, 1);
  const rows = [visit, month].map(offer => ({
    offer, row: Compare.packagePreview(offer, 15, 30), alternative: Compare.purchaseAlternative(offer, 15, 30),
  }));
  const ranked = Issues.rank(issues, { rows, complete: [rows[1]] }, 15);
  assert.equal(ranked[0].topic, 'validity');
  assert.match(ranked.find(issue => issue.topic === 'stacking').impact, /当前少覆盖 5 次/);
  const message = Issues.merchantMessage([...ranked, ...ranked]);
  assert.equal((message.match(/最晚何时需要首次核销/g) ?? []).length, 1);
  assert.match(message, /截图版本 v1/);
});

test('replies and deferrals are append-only, idempotent and scoped to the issue version', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vericard-issues-test-'));
  const file = path.join(dir, 'issues.json');
  t.after(() => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(dir);
  });
  let writes = 0;
  const save = (filename, state) => { writes++; fs.writeFileSync(filename, JSON.stringify(state)); };
  const v1 = Compare.packageSummary([page('a', '10次卡【河景位】', '套餐价229元', '套餐编号：sale-8', '条款版本：v1')]);
  const v2 = Compare.packageSummary([page('b', '10次卡【河景位】', '套餐价229元', '套餐编号：sale-8', '条款版本：v2')]);
  const [issue] = Issues.catalog([v1]);
  const [later] = Issues.catalog([v2]);
  const packages = new Set([issue.packageId]);
  const store = createIssueHistory(file, save);
  const update = input => store.update('test-session', [issue], packages, input);
  update({ action: 'sync' });
  update({ action: 'sync' });
  assert.equal(writes, 1);
  const reply = { action: 'reply', issueId: issue.id, requestId: randomUUID(), text: '客服回复，两份可分别核销。' };
  update(reply);
  update(reply);
  assert.equal(writes, 2);
  assert.throws(() => update({ ...reply, text: '修改同一请求' }), /已使用/);
  assert.throws(() => update({ ...reply, requestId: randomUUID(), issueId: later.id }), /当前已变更/);
  update({ action: 'defer', issueId: issue.id, requestId: randomUUID() });
  const reopened = createIssueHistory(file, save);
  const events = reopened.update('new-session', [later], packages, { action: 'sync' });
  assert.equal(events.filter(event => event.action === 'observed').length, 2);
  assert.equal(events.find(event => event.action === 'reply').text, reply.text);
  assert(events.filter(event => event.issueId === later.id).every(event => event.action === 'observed'));
  fs.writeFileSync(file, 'partial data');
  assert.throws(() => reopened.update('new-session', [later], packages, { action: 'sync' }), /无法读取/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'partial data');
});
