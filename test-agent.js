'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { createAgent } = require('./agent/agent');
const { createWallet } = require('./wallet');
const { createServer } = require('./server');
const { selectTopics, polishMerchantQuestions } = require('./agent/questions');

const ids = ['1', '2', '3'].map(value => value.repeat(64));
const input = {
  startDate: '2026-11-10', activationDate: '2026-11-10', serviceId: '日间自习', referencePrice: '35', extraFees: '0',
  scenarios: { low: { count: 4, everyDays: 3 }, base: { count: 6, everyDays: 3 }, high: { count: 8, everyDays: 3 } },
};

function fixture(options) {
  const lines = [
    ['套餐名称：合成自习室6次卡', '6次卡', '套餐价：¥120'],
    ['购买后15天内有效', '核销后30天有效', '适用服务：全部'],
    ['适 用 服 务 ． 仅 限 晚 间 自 习'],
  ];
  const calls = { recognize: [], extract: 0 };
  const agent = createAgent({
    readImage: id => ({ id, url: '/images/' + id + '.png', name: id.slice(0, 1),
      ocr: { height: 400, lines: lines[ids.indexOf(id)].map((text, index) => ({ text, id: index })) } }),
    recognize: async id => calls.recognize.push(id),
    extract: async () => { calls.extract++; return { candidates: [] }; },
  }, options);
  return { agent, calls };
}

const update = (agent, state, changes) => agent.decision({
  analysisId: state.analysisId, revision: state.revision, changes,
});

test('三图冲突只问一次，跳过后保留条件结果并跨页面共享', async () => {
  const { agent, calls } = fixture();
  const initial = await agent.create({ imageIds: ids, input });
  assert.equal(initial.error, null);
  assert.deepEqual(initial.questions.map(item => item.key), ['coverage']);
  assert.deepEqual(initial.review.conflicts, ['coverage']);
  assert.equal(initial.review.fields.price.verification, '试算假设');
  assert.equal(initial.review.plan.offerPriceCents, null);
  assert.deepEqual(initial.review.fields.coverage.candidates.map(item => item.imageId), ids.slice(1));
  assert.equal(initial.review.timeline.firstRedemptionDays, '15');
  assert.equal(initial.review.timeline.expiryDays, '30');
  assert.equal(initial.review.fields.principal.policy, '不适用');

  const skipped = update(agent, initial, { skip: 'coverage' });
  assert.equal(skipped.state, 'conditional_result');
  assert.deepEqual(skipped.questions, []);
  assert.deepEqual(skipped.result.ranges[0].branches.map(branch =>
    branch.outcomes.find(item => item.id === 'base').cash), [12000, 33000]);
  assert.equal(skipped.result.analysis.scenarios[1].result.payAsYouGoCents, 21000);
  assert.equal(skipped.result.analysis.scenarios[1].result.refund.amountCents, null);
  assert.deepEqual(agent.read(initial.analysisId).skipped, ['coverage']);
  assert.throws(() => update(agent, initial, { input: { referencePrice: '40' } }), { status: 409 });
  const revised = update(agent, skipped, { input: { referencePrice: '40' } });
  assert.equal(agent.read(initial.analysisId).input.referencePrice, '40');
  assert.deepEqual(revised.questions, []);
  assert.deepEqual(calls, { recognize: ids, extract: 1 });
});

test('试算答案不变成已确认事实，显式核对后才采用有依据的字段', async () => {
  const { agent } = fixture();
  let state = await agent.create({ imageIds: ids, input });
  assert.throws(() => update(agent, state, { confirm: { field: 'price', value: '1' } }), /原文依据/);
  const question = state.questions[0];
  state = update(agent, state, { answer: { key: question.key, label: question.branches[0].label } });
  assert.equal(state.answers.coverage.intent, 'assumption');
  assert.equal(state.review.plan.rules.coverage, null);
  assert.equal(state.result.analysis.scenarios[1].result.status, 'conditional');
  state = update(agent, state, { confirm: { field: 'coverage', value: '仅限晚间自习' } });
  assert.equal(state.review.fields.coverage.policy, '已确认');
  assert.deepEqual(state.review.plan.rules.coverage.serviceIds, ['晚间自习']);
  assert.equal(state.answers.coverage, undefined);
});

test('会话闲置到期后不能重建旧 ID', async () => {
  let now = 0;
  const { agent } = fixture({ clock: () => now, ttl: 100 });
  const state = await agent.create({ imageIds: ids, input });
  now = 100;
  assert.throws(() => agent.read(state.analysisId), { status: 404 });
});

test('Agent 办卡校验当前版本并保留证据，重复提交返回同一卡', async t => {
  const { agent } = fixture();
  const initial = await agent.create({ imageIds: ids, input });
  const ready = update(agent, initial, { skip: 'coverage' });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kdz-agent-wallet-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const wallet = createWallet(path.join(directory, 'wallet.json'), () => new Date('2026-11-10T04:00:00Z'));
  const request = { requestId: randomUUID(), source: { kind: 'agent', analysisId: ready.analysisId,
    reviewTag: ready.result.reviewTag }, confirmedPurchase: true, purchase: {
    paid: '118', purchasedOn: '2026-11-10', activationDate: '2026-11-10',
    visits: '6', redemption: 'per_visit', validity: { kind: 'from_activation', days: '30' }, coverage: { kind: 'all' },
  } };
  const create = data => wallet.create(data, () => assert.fail('Agent 不读取项目分组'), undefined, agent.purchase);
  assert.throws(() => create({ ...request, confirmedPurchase: false }), /确认已经实际办卡/);
  assert.throws(() => create({ ...request, source: { ...request.source, reviewTag: initial.result.reviewTag } }), { status: 409 });
  const first = create(request);
  agent.purchased(ready.analysisId, first.cardId);
  assert.deepEqual(create(request), { cardId: first.cardId, replayed: true });
  assert.throws(() => create({ ...request, requestId: randomUUID() }), { status: 409 });
  const card = wallet.get(first.cardId).card;
  assert.equal(card.paidCents, 11800);
  assert.equal(card.source.kind, 'agent');
  assert.deepEqual(card.source.imageIds, ids);
  assert.equal(card.source.fields.price.verification, '试算假设');
  const demo = await agent.create({ demoId: 'visits' });
  assert.throws(() => agent.purchase(demo.analysisId), /上传截图/);
});

test('DeepSeek 理解续问前脱敏，且只接受已知主题', async () => {
  const fetchImpl = async (url, request) => {
    const body = JSON.parse(request.body);
    assert.equal(body.response_format.type, 'json_object');
    const payload = JSON.parse(body.messages[1].content);
    assert.match(payload.previousQuestions[0], /\[已脱敏\]/);
    assert.doesNotMatch(JSON.stringify(payload), /13800138000|2026110912345678/);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"topics":["validity","value"]}' } }] }),
    };
  };
  const result = await selectTopics('那之后呢，订单号：2026110912345678', ['手机号：13800138000，有效期和费用？'], {
    apiKey: 'test-credential', fetchImpl,
  });
  assert.deepEqual(result, ['validity', 'value']);
  await assert.rejects(selectTopics('能退吗', [], {
    apiKey: 'test-credential',
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"topics":["invent"]}' } }] }) }),
  }), /主题无效/);
});

test('商家润色只传脱敏问题，拒绝新增金额或天数', async () => {
  const request = ['可使用多久？手机号13800138000','工作日可用吗？'];
  const options = answers => ({
    apiKey:'test-credential',
    fetchImpl:async (url,init) => {
      const { messages } = JSON.parse(init.body);
      const input = JSON.parse(messages[1].content);
      assert.equal(input.questions.length,2);
      assert(!messages[1].content.includes('13800138000'));
      return { ok:true, json:async () => ({ choices:[{ message:{ content:JSON.stringify({ questions:answers }) } }] }) };
    },
  });
  const polished = ['请问使用期限有多久？','请问工作日可以使用吗？'];
  assert.deepEqual(await polishMerchantQuestions(request, options(polished)), polished);
  await assert.rejects(polishMerchantQuestions(request, options(['请问可以使用30天吗？',polished[1]])),/格式不正确/);
  await assert.rejects(polishMerchantQuestions(request, options([polished[0]])),/格式不正确/);
});

test('根首页、旧工作台和本地决策路由都可访问', async t => {
  const server = createServer(0);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  function send(url, data, headers = {}) {
    return new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, path: url, method: data ? 'POST' : 'GET',
        headers: { Host: '127.0.0.1:0', 'Content-Type': 'application/json', 'X-KDZ-Local': '1', ...headers } },
      response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body }));
      });
      request.on('error', reject);
      request.end(data && JSON.stringify(data));
    });
  }
  assert.match((await send('/')).body, /id="agentPrompt"/);
  assert.match((await send('/agent.html')).body, /id="agentPrompt"/);
  assert.match((await send('/home.html')).body, /购前分析/);
  assert.equal((await send('/agent-ui.js')).status, 200);
  assert.equal((await send('/agent.css')).status, 200);
  assert.equal((await send('/agent-issues.js')).status, 200);
  assert.equal((await send('/agent-issue-ui.js')).status, 200);
  assert.equal((await send('/assets/home-threads.js')).status, 200);
  assert.equal((await send('/assets/home-threads.css')).status, 200);
  assert.equal((await send('/agent/session.js')).status, 404);
  assert.equal((await send('/api/decision', { demoId: 'visits', ...input })).status, 200);
  assert.equal((await send('/api/agent/sessions', { demoId: 'visits' }, { 'X-KDZ-Local': '0' })).status, 403);
  const demo = await send('/api/agent/sessions', { demoId: 'visits' });
  assert.equal(demo.status, 201);
  const state = JSON.parse(demo.body);
  assert.equal(state.result.reviewTag, null);
  const endpoint = '/api/agent/sessions/' + state.analysisId;
  assert.equal((await send(endpoint)).status, 200);
  assert.deepEqual(JSON.parse((await send(endpoint + '/ask', { question: '能退吗' })).body),
    { provider: 'local', topics: null });
  assert.equal((await send(endpoint + '/ask', { question: '' })).status, 400);
  assert.equal((await send(endpoint + '/comparison')).status, 409);
  assert.equal((await send(endpoint + '/issues', { action: 'sync' })).status, 409);
  const capability = JSON.parse((await send('/api/agent/capabilities')).body);
  assert.deepEqual(Object.keys(capability), ['deepseek']);
  assert.equal(typeof capability.deepseek, 'boolean');
});
