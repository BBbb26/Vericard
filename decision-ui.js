'use strict';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const analysisId = params.get('analysisId');
const groupId = analysisId ? null : params.get('group');
const names = { low: '保守', base: '正常', high: '乐观' };
const fields = ['startDate', 'activationDate', 'serviceId', 'referencePrice', 'extraFees', 'assumedPrice'];
const scenarioStatus = { calculated: '已计算', conditional: '条件试算', needs_input: '条件不足', unsupported: '规则待核对' };
const cardTypes = { stored_value: '储值', visit_pack: '次数', time_pass: '期限', time_pack: '时长' };
const termStatus = { explicit: '已明确', missing: '当前资料未提及', ambiguous: '表述待核对', conflicting: '来源存在冲突', potential_risk: '需核查的权益条件' };
const ruleStatus = { verified: '已验证', user_confirmed: '用户确认', system: '系统口径', assumption: '试算假设', open: '待核实', unsupported: '未建模' };
const ruleTone = { verified: 'success', user_confirmed: 'info', system: 'neutral', assumption: 'warning', open: 'warning', unsupported: 'danger' };
const tools = { review_terms: '核对条款', simulate_cost: '运行计算', compare_rule_options: '比较备选条件', ask_user: '发起追问', show_conditional: '展示条件结果', show_result: '展示结果' };
const demoInputs = {
  stored: { serviceId: '洗护', referencePrice: '200', counts: [4, 6, 7], gap: 1 },
  visits: { serviceId: '私教', referencePrice: '90', counts: [8, 15, 23], gap: 4 },
  time: { serviceId: '健身', referencePrice: '80', counts: [8, 14, 30], gap: 7 },
};
let answers = {};
let skipped = [];
let requestNumber = 0;
let latest = null;
let calculationTimer;
let agentSession;
let agentWrite = Promise.resolve();
const chart = window.KDZDecisionChart;
const purchase = createPurchasePanel();

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function sourceLink(key) {
  if (analysisId) return 'agent.html?' + new URLSearchParams({ analysisId }) + (key ? '#evidence' : '');
  const query = new URLSearchParams();
  if (groupId) query.set('group', groupId);
  if (key) query.set('field', key);
  return 'extract.html' + (query.size ? '?' + query : '');
}

function money(value) {
  if (value == null) return '待确认';
  const amount = BigInt(Math.abs(value));
  return (value < 0 ? '−' : '') + '¥' + (amount / 100n).toLocaleString('zh-CN') +
    '.' + String(amount % 100n).padStart(2, '0');
}

function ratio(value) {
  if (!value) return '—';
  const denominator = BigInt(value.denominatorCents);
  const tenths = (2000n * BigInt(value.numeratorCents) + denominator) / (2n * denominator);
  return String(tenths / 10n) + '.' + String(tenths % 10n) + '%';
}

function button(label, action, className = 'secondary') {
  const node = element('button', label, className);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function inputField(parent, title, id, min, max) {
  const label = element('label', title);
  const input = element('input');
  Object.assign(input, { id, type: 'number', min, max, step: 1, required: true });
  label.append(input);
  parent.append(label);
}

for (const [id, label] of Object.entries(names)) {
  const fieldset = element('fieldset');
  fieldset.append(element('legend', label));
  inputField(fieldset, '计划次数', id + 'Count', 0, 52);
  inputField(fieldset, '每隔几天使用一次', id + 'Gap', 1, 365);
  $('scenarioInputs').append(fieldset);
}
$('backToSource').href = sourceLink();
$('demoPicker').hidden = Boolean(groupId || analysisId);
if (analysisId) $('backToSource').textContent = '返回本次对话';

function collect() {
  return {
    groupId, demoId: $('demoId').value, answers, skipped,
    ...Object.fromEntries(fields.map(id => [id, $(id).value])),
    scenarios: Object.fromEntries(Object.keys(names).map(id => [
      id, { count: $(id + 'Count').value, everyDays: $(id + 'Gap').value },
    ])),
  };
}

function cacheKey() {
  return 'kdz-workbench:' + (groupId || 'demo:' + $('demoId').value);
}

function loadInputs(saved = null) {
  const demo = demoInputs[$('demoId').value];
  const today = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const defaults = groupId || analysisId ? {
    startDate: today, activationDate: '', serviceId: '', referencePrice: '', extraFees: '', assumedPrice: '',
  } : {
    startDate: '2026-11-10', activationDate: '2026-11-10', serviceId: demo.serviceId,
    referencePrice: demo.referencePrice, extraFees: '', assumedPrice: '',
  };
  if (!analysisId) {
    try { saved = JSON.parse(sessionStorage.getItem(cacheKey()) || 'null'); } catch { saved = null; }
  }
  for (const id of fields) $(id).value = saved?.[id] ?? defaults[id];
  const counts = groupId || analysisId ? [4, 6, 8] : demo.counts;
  Object.keys(names).forEach((id, i) => {
    $(id + 'Count').value = saved?.scenarios?.[id]?.count ?? counts[i];
    $(id + 'Gap').value = saved?.scenarios?.[id]?.everyDays ?? (groupId || analysisId ? 7 : demo.gap);
  });
  answers = Object.fromEntries(Object.entries(saved?.answers ?? {}).filter(([, value]) => typeof value === 'string'));
  skipped = saved?.skipped ?? [];
}

function status(state, message) {
  $('status').dataset.state = state;
  $('status').textContent = message;
  document.body.dataset.analysisState = state;
}

function lockResults() {
  purchase.hide();
  latest = null;
  $('download').disabled = true;
  $('chartCondition').disabled = true;
  $('resultsPanel').inert = true;
  $('questionsPanel').inert = true;
  $('rulesPanel').hidden = true;
  $('resultsPanel').setAttribute('aria-busy', 'true');
  $('judgmentStatus').textContent = '正在更新';
}

function persist(input) {
  if (analysisId) return;
  try { sessionStorage.setItem(cacheKey(), JSON.stringify(input)); } catch {}
}

function markEdited(schedule = true) {
  ++requestNumber;
  clearTimeout(calculationTimer);
  lockResults();
  status('loading', '计划已修改，正在更新试算…');
  if (schedule) {
    persist(collect());
    calculationTimer = setTimeout(() => calculate(), 300);
  }
}

function submitAnswer(key, label) {
  if (analysisId) {
    calculate(false, label === null ? { skip: key } : { answer: { key, label } });
    return;
  }
  if (label === null) skipped = [...new Set([...skipped, key])];
  else answers = { ...answers, [key]: label };
  calculate();
}

function renderQuestions(items) {
  const nodes = items.map(question => {
    const card = element('article', undefined, 'question');
    card.append(element('h3', question.title));
    if (question.context) card.append(element('p', '联合试算前提 · '+question.context.title+' '+question.context.option, 'muted'));
    if (question.changesConclusion) card.append(element('p', '备选条件可能改变是否划算的判断。', 'warning'));
    else if (question.impact !== null) card.append(element('p', '备选条件的最大经济差额跨度 ' + money(question.impact) + '。'));
    const actions = element('div', undefined, 'actions');
    question.branches.forEach(branch => actions.append(button(branch.label, () => submitAnswer(question.key, branch.label))));
    if ((groupId || analysisId) && question.field && question.key !== 'restrictions') {
      const link = element('a', '去核对相关字段');
      link.href = sourceLink(question.field);
      actions.append(link);
    }
    if (question.key === 'referencePriceCents' || question.key === 'activationDate' || question.key === 'extraFeesCents' || question.key === 'prepaidPriceCents') {
      const target = { referencePriceCents: 'referencePrice', activationDate: 'activationDate', extraFeesCents: 'extraFees', prepaidPriceCents: 'assumedPrice' }[question.key];
      actions.append(button('填写计划输入', () => $(target).focus()));
    }
    actions.append(button('暂不清楚', () => submitAnswer(question.key, null)));
    card.append(actions);
    return card;
  });
  $('questions').replaceChildren(...nodes);
  $('questionsPanel').hidden = !nodes.length;
  $('questionCount').textContent = nodes.length + ' 项';
}

function definitionList(items) {
  const list = element('dl');
  for (const [label, value] of items) {
    const row = element('div');
    row.append(element('dt', label), element('dd', value));
    list.append(row);
  }
  return list;
}

function badge(text, tone = 'neutral') {
  const node = element('span', text, 'badge');
  node.dataset.tone = tone;
  return node;
}

function shortMoney(value) {
  return money(value).replace(/\.00$/, '');
}

function spread(values, formatter = shortMoney) {
  const min = Math.min(...values), max = Math.max(...values);
  return min === max ? formatter(min) : formatter(min) + ' 至 ' + formatter(max);
}

function milestoneText(breakEven) {
  if (!breakEven || breakEven.status === 'unknown') return '条件不足';
  if (breakEven.status === 'outside_schedule') return '计划内未达到';
  return '第 ' + breakEven.count + ' 次 · ' + breakEven.date;
}

function differenceText(value) {
  if (value === null) return '待确认';
  if (value === 0) return '持平';
  return (value > 0 ? '少支出 ' : '多支出 ') + shortMoney(Math.abs(value));
}

function normalMilestone(payload, item) {
  const known = item && chart.knownMilestone(payload);
  return known ? { status: 'found', count: known.count, date: item.input.uses[known.count - 1].date } : item?.breakEven;
}

function renderScenario(item, payload) {
  const { input, result, breakEven } = item;
  const card = element('article', undefined, 'panel result-card scenario-card');
  card.dataset.scenario = input.id;
  const heading = element('div', undefined, 'section-heading');
  const options = chart.projectedValues(payload, input.id, 'cash');
  const diffOptions = chart.projectedValues(payload, input.id, 'difference');
  const label = result.status === 'unsupported' && options.length ? '条件试算' : scenarioStatus[result.status];
  heading.append(element('h3', input.label), badge(label,
    options.length ? 'warning' : { calculated: 'success', conditional: 'warning', needs_input: 'warning', unsupported: 'danger' }[result.status]));
  const conditional = result.cash.totalCents === null && options.length > 0;
  const amount = conditional ? spread(options) : money(result.cash.totalCents);
  const usage = input.uses.length + ' 次 · 每 ' + $(input.id + 'Gap').value + ' 天一次';
  card.append(heading, element('p', usage, 'scenario-context'),
    element('p', conditional ? '备选条件下预付总支出' : '预计预付总支出', 'muted'),
    element('p', amount, 'metric'));
  card.append(definitionList([
    ['全部按次', money(result.payAsYouGoCents)],
    ['经济差额', diffOptions.length ? spread(diffOptions) : differenceText(result.economicDifferenceCents)],
  ]));
  const payment = { actual: '已核对实付', offer: '已核对报价', assumption: '试算价格', unknown: '价格待核对' }[result.payment.source];
  const details = element('details', undefined, 'scenario-detail');
  details.append(element('summary', '费用与权益明细'));
  const items = [
    [payment, money(result.payment.amountCents)],
    ['卡外支付', money(result.cash.outsideCents)],
    ['额外费用', money(result.cash.extraFeesCents)],
    ['成本覆盖进度', ratio(result.costCoverage)],
    ['计划内首次持平或更省', milestoneText(input.id === 'base' ? normalMilestone(payload, item) : breakEven)],
    ['卡内覆盖的到访', result.entitlement ? result.entitlement.coveredUses + ' / ' + input.uses.length : '待确认'],
  ];
  if (result.entitlement && Object.hasOwn(result.entitlement, 'remainingVisits')) {
    items.push(['账面剩余次数', result.entitlement.remainingVisits ?? '待确认']);
  }
  if (result.entitlement && Object.hasOwn(result.entitlement, 'unusedPrincipalCents')) {
    items.push(['账面未使用本金', money(result.entitlement.unusedPrincipalCents)]);
    items.push(['账面未使用赠送金', money(result.entitlement.unusedBonusCents)]);
    items.push(['赠送金截止日', result.entitlement.bonusWindow.endDate ||
      (result.entitlement.bonusWindow.status === 'known' ? '无固定截止' : '待确认')]);
  }
  items.push(['权益截止日', result.window.endDate || (result.window.status === 'known' ? '无固定截止' : '待确认')]);
  details.append(definitionList(items));
  for (const rule of result.unsupportedRules) details.append(element('p', rule, 'warning'));
  card.append(details);
  return card;
}

function summaryCard(iconName, label, value, detail) {
  const card = element('article', undefined, 'panel summary-card');
  const title = element('div', undefined, 'summary-card-title');
  const icon = element('span', undefined, 'summary-card-icon');
  icon.append(window.KDZUI.icon(iconName));
  title.append(icon, element('span', label));
  card.append(title, element('p', value, 'metric'), element('p', detail, 'muted'));
  return card;
}

function renderPlanSummary(payload, base) {
  const plan = payload.review.plan;
  const rules = plan?.rules;
  const payment = base?.result.payment;
  let paymentNote = { actual: '依据已核对的实际支付', offer: '已核对报价 · 实付待确认',
    assumption: '采用试算价 · 非实际支付', unknown: '请核对报价或输入试算价' }[payment?.source] || '请先核对套餐类型';
  if (payment?.source === 'assumption' && payload.review.actualPriceCents != null) {
    paymentNote = '实际支付 ' + money(payload.review.actualPriceCents) + ' · 图表采用试算价';
  }
  let entitlement = ['待核对', '保留字段原文与来源'];
  if (plan?.type === 'stored_value') {
    const { principalCents, bonusCents } = rules;
    const total = Number.isSafeInteger(principalCents) && Number.isSafeInteger(bonusCents) &&
      Number.isSafeInteger(principalCents + bonusCents) ? principalCents + bonusCents : null;
    entitlement = [total === null ? '额度待核对' : money(total),
      '本金 ' + money(principalCents) + ' · 赠送 ' + money(bonusCents)];
  } else if (plan?.type === 'visit_pack') {
    entitlement = [rules.visits == null ? '待核对' : rules.visits + ' 次',
      { per_day: '按自然日核销', per_visit: '按到访核销' }[rules.redemption] ?? '核销方式待确认'];
  } else if (plan?.type === 'time_pass') {
    entitlement = [rules.validity?.days ? rules.validity.days + ' 天' : rules.validity?.kind === 'fixed' ? '固定期限' : '期限会员',
      '权益依据会员有效期'];
  }
  const window = base?.result.window;
  const rulesValidity = rules?.validity;
  const validityValue = window?.endDate ?? (window?.status === 'known' ? '无固定截止' :
    rulesValidity?.days ? '生效后 ' + rulesValidity.days + ' 天' :
    rulesValidity?.kind === 'unlimited' ? '无固定截止' :
    rulesValidity?.kind === 'fixed' ? rulesValidity.endDate : '待核对');
  const validityNote = base?.input.ruleAssumptions?.validity ? '截止日采用试算条件' :
    window?.startDate ? '生效日 ' + window.startDate : '期限以已核对条款为准';
  const items = [
    ['预付金额', money(payment?.amountCents), paymentNote],
    ['套餐权益', ...entitlement],
    ['权益期限', validityValue, validityNote],
    ['正常情景', base ? base.input.uses.length + ' 次' : '待试算',
      base ? '每 ' + $('baseGap').value + ' 天一次 · ' + ($('serviceId').value.trim() || '项目待填写') : '计划参数可编辑'],
  ];
  $('planSummary').replaceChildren(...items.map(([label, value, detail]) => {
    const item = element('div', undefined, 'context-item');
    item.append(element('span', label, 'context-label'), element('strong', value, 'context-value'), element('small', detail, 'context-detail'));
    return item;
  }));
  $('planSummary').hidden = false;
}

function renderBlocked(payload) {
  const blocked = !payload.analysis || !payload.review.plan;
  $('blockedPanel').hidden = !blocked;
  document.body.dataset.blocked = String(blocked);
  $('adjustPlan').hidden = blocked;
  $('download').hidden = blocked;
  for (const id of ['planSummary', 'decisionSummary', 'resultsPanel', 'planPanel', 'basisDrawer', 'questionsPanel']) {
    $(id).hidden = blocked;
  }
  if (!blocked) {
    $('planPanel').hidden = false;
    $('basisDrawer').hidden = false;
    $('download').hidden = false;
    return;
  }
  $('resultsPanel').hidden = true;
  purchase.hide();
  $('download').disabled = true;
  const review = payload.review;
  const items = [];
  const add = (label, detail, key) => {
    if (!items.some(item => item.key === key)) items.push({ label, detail, key });
  };
  const type = review.fields.planType;
  if (type?.status === 'conflicting') {
    add('套餐类型存在冲突', '截图中的类型与权益单位指向不同卡型，请回到确认页选择准确类型。', 'planType');
  } else if (!type?.value) {
    add('套餐类型还没有值', '截图中未找到卡型，请回到确认页手动填写。', 'planType');
  } else if (type.verification !== '用户核对') {
    add('套餐类型待确认', '已提取「' + type.value + '」，回到确认页点一次「确认无误」即可。', 'planType');
  }
  const price = review.fields.price;
  if (!price?.value) add('价格还没有值', '截图中未找到报价，请核对价格页。', 'price');
  else if (price.verification !== '用户核对' && price.verification !== '试算假设') {
    add('价格待确认', '已提取 ¥' + price.value + '，回到确认页确认后即可试算。', 'price');
  }
  if (!items.length) add('关键信息未确认', '请回到确认页检查套餐类型和价格。', 'planType');
  $('blockedList').replaceChildren(...items.map(({ label, detail, key }) => {
    const li = element('li');
    const link = element('a', label);
    link.href = sourceLink(key);
    li.append(link, element('p', detail, 'muted'));
    return li;
  }));
  $('blockedBack').href = sourceLink(items[0].key);
  $('blockedBack').textContent = '去补充信息';
  status('warning', '还差 ' + items.length + ' 项确认，才能开始试算。');
}

function showBlockError(message) {
  document.body.dataset.blocked = 'true';
  $('blockedPanel').hidden = false;
  $('adjustPlan').hidden = true;
  $('download').hidden = true;
  purchase.hide();
  for (const id of ['planSummary', 'decisionSummary', 'resultsPanel', 'planPanel', 'basisDrawer', 'questionsPanel', 'purchasePanel']) {
    $(id).hidden = true;
  }
  const li = element('li');
  const link = element('a', '回到套餐确认页');
  link.href = sourceLink('planType');
  li.append(link, element('p', message, 'muted'));
  $('blockedList').replaceChildren(li);
  $('blockedBack').href = sourceLink('planType');
  $('blockedBack').textContent = '回到套餐确认页';
  status('error', message);
}

function renderJudgment(payload, base) {
  const result = base?.result;
  const value = result?.economicDifferenceCents ?? null;
  const options = chart.projectedValues(payload, 'base', 'difference');
  const risk = payload.questions[0]?.title ?? payload.ranges?.[0]?.title;
  const unresolved = result?.unresolved ?? [];
  const plan = payload.review.plan;
  let guidance = null, action = null;
  if (value === null && !options.length) {
    if (!plan?.rules?.validity && plan?.type === 'time_pass') {
      guidance = '这张卡的权益有效期还没有确认，先补齐「核销后期限」或「截止日」，才能判断能否覆盖计划。';
      action = { label: '去确认有效期', href: sourceLink('expiryDays') };
    } else if (unresolved.includes('referencePriceCents')) {
      guidance = '还缺同店同服务的单次参考价。填好计划参数后，就能比较预付和按次支出。';
      action = { label: '填写计划参数', plan: true, focus: 'referencePrice' };
    } else if (unresolved.includes('extraFeesCents')) {
      guidance = '如果这次没有额外费用，在计划里填 0 即可继续试算。';
      action = { label: '填写额外费用', plan: true, focus: 'extraFees' };
    } else if (unresolved.some(key => ['coverage', 'validity', 'bonusValidity', 'activationDate'].includes(key))) {
      const routes = {
        coverage: { text: '适用范围还没有确认。回到套餐确认页补充「适用范围」后，才能判断能否使用。', action: { label: '去确认适用范围', href: sourceLink('coverage') } },
        validity: { text: '权益有效期还没有确认。回到套餐确认页补充「有效期」。', action: { label: '去确认有效期', href: sourceLink('expiryDays') } },
        bonusValidity: { text: '赠送金有效期还没有确认。回到套餐确认页补充「赠送金期限」。', action: { label: '去确认赠送金期限', href: sourceLink('bonusDays') } },
        activationDate: { text: '还缺实际或预计生效日。在计划里补上日期后即可计算。', action: { label: '填写生效日', plan: true, focus: 'activationDate' } },
      };
      const route = routes[unresolved.find(key => routes[key])];
      guidance = route.text;
      action = route.action;
    } else if (unresolved.length) {
      const labels = { referencePriceCents: '单次参考价', serviceId: '服务项目', startDate: '计划开始日', extraFeesCents: '额外费用' };
      guidance = '还缺：' + unresolved.map(key => labels[key] ?? key).join('、') + '。补齐后即可计算。';
    } else if (payload.questions?.length) {
      guidance = '先回答下面「需要你确认」中的问题，或选择「暂不清楚」查看可算的条件结果。';
    }
  }
  $('judgmentStatus').textContent = value !== null ? scenarioStatus[result.status] :
    options.length ? '条件对比' : '待补充';
  $('judgmentValue').textContent = value !== null ? differenceText(value) :
    options.length ? spread(options) : guidance ? '还需一步' : '需补充条件';
  $('judgmentText').textContent = value !== null ?
    (result.status === 'conditional' ? '在当前所列试算前提下，与相同消费计划的按次付费相比。' :
      '按本次计划和已核对的条件，与按次付费比较。') :
    options.length ? '备选条件下的经济差额。正值表示预付方案支出更少。' :
      guidance ?? risk ?? '补充已知条款与计划参数后，再判断两种方案的经济差额。';
  const actionNode = $('judgmentAction');
  actionNode.replaceChildren();
  if (action && value === null) {
    if (action.plan) {
      const button = element('button', action.label, 'secondary');
      button.type = 'button';
      button.addEventListener('click', () => {
        $('planPanel').open = true;
        $('planPanel').scrollIntoView({ block: 'start' });
        $(action.focus || 'referencePrice').focus({ preventScroll: true });
      });
      actionNode.append(button);
    } else {
      const link = element('a', action.label, 'button secondary');
      link.href = action.href;
      actionNode.append(link);
    }
    actionNode.hidden = false;
  } else actionNode.hidden = true;
  const facts = definitionList([
    ['按次对照支出', money(result?.payAsYouGoCents)],
    ['本计划内持平／更省', milestoneText(normalMilestone(payload, base))],
    ['关键待确认', risk ?? '当前无优先追问'],
    ...(payload.assumptions?.length ? [['当前前提', payload.assumptions[0]]] : []),
  ]);
  $('judgmentFacts').replaceChildren(...facts.children);
}

function renderKeyTerms(payload) {
  const fields = Object.values(payload.review.fields).filter(term => ['conflicting', 'potential_risk'].includes(term.status));
  const terms = [
    ...fields.map(term => [term.label, termStatus[term.status], term.status === 'conflicting' ? 'danger' : 'warning']),
    ...payload.review.restrictions.map(rule => [rule.text, '已保存限制', 'neutral']),
    ...(payload.review.fields.refund?.status === 'missing' ? [['退款条件', '资料未提及', 'neutral']] : []),
  ].slice(0, 3);
  $('keyTerms').replaceChildren(...terms.map(([name, state, tone]) => {
    const item = element('div', undefined, 'key-term');
    item.append(badge(state, tone), element('p', name));
    return item;
  }));
  $('keyTermsPanel').hidden = !terms.length;
}

function ruleRow(rule) {
  const item = element('div', undefined, 'rule-row' + (['open', 'unsupported'].includes(rule.status) ? ' rule-open' : ''));
  item.append(badge(ruleStatus[rule.status] ?? rule.status, ruleTone[rule.status] ?? 'neutral'));
  const copy = element('span', undefined, 'rule-copy');
  copy.append(element('strong', rule.title), element('small', rule.detail || rule.summary));
  item.append(copy);
  return item;
}

function renderRules(payload) {
  const base = payload.analysis?.scenarios.find(item => item.input.id === 'base');
  const trace = base?.result?.rules;
  if (!trace) {
    $('rulesPanel').hidden = true;
    return;
  }
  const applied = trace.applied ?? [];
  const open = trace.open ?? [];
  const children = [];
  if (applied.length) {
    children.push(element('p', '本次用到', 'rule-section-title'));
    applied.forEach(rule => children.push(ruleRow(rule)));
  }
  if (open.length) {
    children.push(element('p', '仍未落实 / 需要核对', 'rule-section-title'));
    open.forEach(rule => children.push(ruleRow(rule)));
  }
  $('ruleTrace').replaceChildren(...children);
  $('ruleCount').textContent = applied.length + ' 条';
  $('ruleCount').dataset.tone = applied.length ? 'success' : 'neutral';
  $('rulePrecedence').textContent = trace.precedence ?? '';
  $('rulesPanel').hidden = false;
}

function renderRanges(items) {
  $('ranges').replaceChildren(...items.map(question => {
    const card = element('article', undefined, 'panel');
    card.append(element('h3', '条件对比 · ' + question.title));
    if (question.context) card.append(element('p', '联合试算前提 · '+question.context.title+' '+question.context.option, 'muted'));
    const list = element('ul');
    for (const branch of question.branches) {
      const results = branch.outcomes.map(item => names[item.id] + ' ' + money(item.cash));
      list.append(element('li', branch.label + ' · 总支出 ' + results.join(' / ')));
    }
    card.append(list);
    return card;
  }));
}

function renderEvidence(payload) {
  $('merchantText').value = payload.merchantQuestions.map((value, i) => (i + 1) + '. ' + value).join('\n');
  $('copyStatus').textContent = '';
  const mustShow = ['planType', 'price', 'coverage', 'refund', 'transfer', 'extension'];
  const terms = Object.entries(payload.review.fields)
    .filter(([key, term]) => term.policy !== '不适用' && (mustShow.includes(key) || term.value || term.candidates.length))
    .map(([key, term]) => {
      const card = element('article', undefined, 'term');
      card.append(element('strong', term.label), element('p', termStatus[term.status] + ' · ' + term.verification + ' · ' + term.source));
      if (term.value) card.append(element('p', term.value));
      const evidence = [...new Set([...term.evidence, ...term.candidates].map(item => item.quote).filter(Boolean))];
      for (const quote of evidence.slice(0, 3)) card.append(element('p', '原文 · ' + quote, 'muted'));
      if (groupId || analysisId) {
        const link = element('a', '在工作台定位字段与原图');
        link.href = sourceLink(key);
        card.append(link);
      }
      return card;
    });
  $('terms').replaceChildren(...terms);
  $('trace').replaceChildren(...payload.steps.map(step => element('li', tools[step.tool] + ' · ' + step.result)));
  $('evidencePanel').hidden = false;
}

function hasNumbers(payload) {
  return (payload.analysis?.scenarios ?? []).some(item => {
    const total = item.result?.cash?.totalCents;
    return (total !== null && total !== undefined) || chart.projectedValues(payload, item.input.id, 'cash').length > 0;
  });
}

function render(payload) {
  $('sourceName').textContent = payload.review.name;
  $('sourceType').textContent = cardTypes[payload.review.type] ?? '类型待核对';
  $('sourceType').hidden = false;
  $('demoBadge').hidden = !payload.review.demo;
  renderBlocked(payload);
  const blocked = document.body.dataset.blocked === 'true';
  renderQuestions(blocked ? [] : payload.questions);
  if (blocked) {
    $('download').disabled = true;
    return;
  }
  const scenarios = payload.analysis?.scenarios ?? [];
  const base = scenarios.find(item => item.input.id === 'base');
  const numbers = hasNumbers(payload);
  renderPlanSummary(payload, base);
  renderJudgment(payload, base);
  renderKeyTerms(payload);
  renderRules(payload);
  $('resultsPanel').hidden = !payload.analysis || !numbers;
  if (scenarios.length && numbers) chart.render(payload, money);
  $('results').replaceChildren(...(numbers ? scenarios.map(item => renderScenario(item, payload)) : []));
  $('resultScope').textContent = '持平点采用本情景录入的额外费用合计。退款规则和金额单独核实。';
  const assumptions = [...payload.assumptions ?? []];
  if (payload.ranges?.[0]?.context) assumptions.push('联合试算仅采用已标注的备选前提。');
  $('assumptions').replaceChildren(...assumptions.map(value => element('li', value)));
  $('assumptionsPanel').hidden = !assumptions.length;
  renderRanges(payload.ranges);
  $('resultsPanel').inert = false;
  $('questionsPanel').inert = false;
  $('resultsPanel').setAttribute('aria-busy', 'false');
  $('download').disabled = !payload.analysis;
  renderEvidence(payload);
  const basisCount = (payload.review.restrictions?.length ?? 0) +
    Object.values(payload.review.fields).filter(term => term.status === 'conflicting' || term.status === 'potential_risk').length;
  $('basisCount').textContent = basisCount ? basisCount + ' 项待核对' : '';
  $('basisCount').dataset.tone = basisCount ? 'warning' : 'neutral';
}

function applyResult(payload, input) {
  latest = payload;
  render(payload);
  if (!analysisId) window.KDZRecentAnalysis.remember(payload, groupId);
  if (!agentSession?.cardId) {
    if (hasNumbers(payload)) purchase.show(payload, input);
    else purchase.hide();
  }
  if (payload.analysis) status('success', '已更新本次试算。');
}

function saveAgentInput(input, change) {
  const { groupId: group, demoId, answers, skipped, ...plan } = input;
  const work = agentWrite.then(async () => {
    agentSession = await window.KDZWallet.request('/api/agent/decision', {
      analysisId, revision: agentSession.revision, changes: { input: plan, ...change },
    });
    return agentSession.result;
  });
  agentWrite = work.catch(() => {});
  return work;
}

async function openAgentSession() {
  $('decisionForm').inert = true;
  try {
    agentSession = await window.KDZWallet.request('/api/agent/sessions/' + encodeURIComponent(analysisId));
    loadInputs(agentSession.input);
    $('clearAnswers').hidden = !Object.keys(agentSession.answers).length && !agentSession.skipped.length;
    $('decisionForm').inert = false;
    if (agentSession.result) applyResult(agentSession.result, agentSession.input);
    else if (agentSession.error) status('error', agentSession.error + '。请返回对话重试。');
    else calculate();
  } catch (error) {
    status('error', error.message);
  }
}

async function calculate(interactive = false, change = {}) {
  if (analysisId && !agentSession) return;
  clearTimeout(calculationTimer);
  const valid = interactive ? $('decisionForm').reportValidity() : $('decisionForm').checkValidity();
  if (!valid) {
    lockResults();
    $('judgmentStatus').textContent = '输入待检查';
    status('warning', '请检查计划日期、次数或使用间隔。');
    return;
  }
  const request = ++requestNumber;
  const input = collect();
  lockResults();
  status('loading', '正在核对条款并计算…');
  $('clearAnswers').hidden = !Object.keys(answers).length && !skipped.length;
  try {
    persist(input);
    const payload = analysisId
      ? await saveAgentInput(input, change)
      : await window.KDZWallet.request('/api/decision', { ...input, includeCostCurve: true });
    if (request !== requestNumber) return;
    if (analysisId) $('clearAnswers').hidden = !Object.keys(agentSession.answers).length && !agentSession.skipped.length;
    applyResult(payload, input);
  } catch (error) {
    if (request !== requestNumber) return;
    if (analysisId && error.status === 409) {
      await openAgentSession();
      status('warning', '已读取最新分析，请检查后再提交修改。');
      return;
    }
    latest = null;
    showBlockError(error.message);
  }
}

$('decisionForm').addEventListener('input', () => markEdited());
$('decisionForm').addEventListener('submit', event => { event.preventDefault(); calculate(true); });
$('clearAnswers').addEventListener('click', () => {
  if (analysisId) calculate(false, { reopen: true });
  else { answers = {}; skipped = []; calculate(); }
});
$('demoId').addEventListener('change', () => { markEdited(false); loadInputs(); calculate(); });
$('adjustPlan').addEventListener('click', event => {
  event.preventDefault();
  $('planPanel').open = true;
  $('planPanel').scrollIntoView({ block: 'start' });
  $('startDate').focus({ preventScroll: true });
});
$('planPanel').addEventListener('toggle', () => {
  if (!$('planPanel').open) return;
  $('planPanel').scrollIntoView({ block: 'start' });
});
$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('merchantText').value);
    $('copyStatus').textContent = '已复制核实问题。';
  } catch {
    $('merchantText').focus();
    $('merchantText').select();
    $('copyStatus').textContent = '已选中话术，可用 Ctrl+C 复制。';
  }
});
$('download').addEventListener('click', () => {
  if (!latest) return;
  const link = element('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(latest, null, 2)], { type: 'application/json' }));
  link.download = 'Vericard-消费决策.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});
if (analysisId) openAgentSession();
else { loadInputs(); calculate(); }
