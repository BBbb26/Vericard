'use strict';
const $ = id => document.getElementById(id);
const E = window.KDZExtract;
const T = window.KDZTerms;
const params = new URLSearchParams(location.search);
const modelPreferenceKey = 'kdz-agent-use-deepseek';
const labels = E?.labels ?? {};
const coreKeys = new Set(['merchant', 'title', 'planType', 'price', 'total', 'unit', 'principal', 'bonus', 'expiryDays', 'fixedEnd', 'purchaseDays', 'coverage', 'refund', 'reservation', 'restrictions']);
const limitKeys = ['refund', 'reservation', 'coverage', 'restrictions'];
const typeUnits = { 次数: '次', 储值: '', 期限: '连续天', 时长: '分钟' };
const freqPresets = [
  { label: '每周1次', value: 1 }, { label: '每周2次', value: 2 }, { label: '每周3次', value: 3 },
  { label: '每周4次', value: 4 }, { label: '每周5次', value: 5 }, { label: '每周6次', value: 6 },
  { label: '每周7次', value: 7 },
];
let factorIndex = 0;
let images = [], groups = [], group = null, groupId = params.get('group');
let facts = [], touched = new Set(), latest = null, aiResult = null;
let requestSeq = 0, timer = null, busy = false;
const sim = { freq: 3, weeks: 4, regularPrice: '', extraFees: '0', startDate: today(), serviceId: '', assumedValidity: null };

function today() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
async function api(url, data) {
  const response = await fetch(url, data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-KDZ-Local': '1' }, body: JSON.stringify(data),
  });
  const json = await response.json();
  if (!response.ok) throw Error(json.error || '请求失败');
  return json;
}
function status(text, state = 'success') {
  const node = $('status');
  node.textContent = text;
  node.dataset.state = state;
}
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function money(cents) {
  if (cents == null || !Number.isFinite(cents)) return '—';
  const value = Math.abs(Math.round(cents));
  return (cents < 0 ? '−' : '') + '¥' + Math.floor(value / 100).toLocaleString('zh-CN') + '.' + String(value % 100).padStart(2, '0');
}
function compactMoney(cents) {
  if (cents == null || !Number.isFinite(cents)) return '—';
  return '¥' + Math.round(Math.abs(cents) / 100).toLocaleString('zh-CN');
}
function pct(part, whole) {
  if (!whole || !Number.isFinite(part)) return 0;
  return Math.max(0, Math.min(100, Math.round(part / whole * 100)));
}
function value(key) { return String(group?.fields?.[key]?.value ?? '').trim(); }
function fieldOf(key) {
  group.fields ||= {};
  group.fields[key] ||= { value: '', status: '待核对', evidence: [] };
  return group.fields[key];
}
function setValue(key, next) {
  if (!group) return;
  const field = fieldOf(key);
  if (String(field.value ?? '') === String(next ?? '')) return;
  field.value = String(next ?? '');
  field.status = '用户核对';
  touched.add(key);
  schedule();
}
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(recalc, 260);
}
function selectedType() { return value('planType') || '次数'; }

async function boot() {
  try {
    const data = await api('/api/state');
    images = data.images || [];
    groups = data.project?.groups || [];
    fillGroups();
    if (!groups.length) {
      status('还没有可分析的套餐。先上传截图，再回到这里。', 'warning');
      $('verdictTitle').textContent = '还没有套餐';
      $('verdictLead').textContent = '上传截图并确认归组后，这里会显示实时分析。';
      return;
    }
    const initial = groups.find(item => item.id === groupId) || groups[0];
    selectGroup(initial.id, true);
    setupCapabilities();
  } catch (error) {
    status('读取失败：' + error.message, 'error');
  }
}
function fillGroups() {
  $('groupSelect').replaceChildren(...groups.map(item => {
    const option = new Option(item.name + ' · ' + item.imageIds.length + ' 张截图', item.id);
    return option;
  }));
}
function selectGroup(id, initial = false) {
  const next = groups.find(item => item.id === id);
  if (!next) return;
  group = next;
  groupId = id;
  touched.clear();
  const type = selectedType();
  const days = Number.parseInt(value('expiryDays'), 10);
  sim.freq = type === '期限' ? 3 : 3;
  sim.weeks = Number.isFinite(days) && days > 0 ? Math.max(1, Math.min(12, Math.round(days / 7))) : 4;
  sim.regularPrice = '';
  sim.extraFees = '0';
  sim.startDate = today();
  sim.serviceId = '';
  sim.assumedValidity = (value('expiryDays') || value('fixedEnd') || value('validityMode')) ? null : 90;
  $('groupSelect').value = id;
  fillSim();
  facts = E?.candidates ? E.candidates(group, images) : [];
  renderLeft();
  if (!initial) history.replaceState(null, '', '?group=' + encodeURIComponent(id));
  recalc();
}
function fillSim() {
  $('freq').value = String(sim.freq);
  $('freqValue').textContent = sim.freq + ' 次 / 周';
  $('weeks').value = String(sim.weeks);
  $('extraFees').value = sim.extraFees;
  $('startDate').value = sim.startDate;
  $('serviceId').value = sim.serviceId;
  renderPresets();
}
function renderPresets() {
  $('freqPresets').replaceChildren(...freqPresets.map(item => {
    const button = el('button', item.label);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(Number(sim.freq) === item.value));
    button.addEventListener('click', () => { sim.freq = item.value; $('freq').value = String(item.value); $('freqValue').textContent = item.value + ' 次 / 周'; renderPresets(); schedule(); });
    return button;
  }));
}

function inputFor(field, key, { number = false, textarea = false, placeholder = '' } = {}) {
  const node = el(textarea ? 'textarea' : 'input');
  if (textarea) node.rows = 2; else node.type = number ? 'number' : 'text';
  if (number) { node.min = '0'; node.step = 'any'; }
  node.value = field.value ?? '';
  node.placeholder = placeholder;
  node.setAttribute('aria-label', labels[key] || key);
  node.addEventListener('input', () => {
    field.value = node.value;
    field.status = '用户核对';
    touched.add(key);
    schedule();
  });
  return node;
}
function evidenceButton(key) {
  const field = group.fields?.[key];
  const count = (field?.evidence?.length ?? 0) + facts.filter(item => item.field === key).length;
  if (!count) return null;
  const button = el('button', '证据');
  button.type = 'button';
  button.addEventListener('click', () => openEvidence(key));
  return button;
}
function factor(label, content, note, key) {
  const card = el('div', undefined, 'factor');
  const head = el('div', undefined, 'factor-label');
  const title = el('span', undefined, 'factor-title');
  title.append(el('span', String(++factorIndex).padStart(2, '0'), 'factor-index'), el('span', label));
  head.append(title);
  const evidence = evidenceButton(key);
  if (evidence) head.append(evidence);
  card.append(head, content);
  if (note) card.append(el('small', note, 'factor-note'));
  return card;
}
function numericValue(key, unit, onInput) {
  const wrap = el('div', undefined, 'factor-value');
  if (key === 'price' || key === 'regularPrice') wrap.append(el('i', '¥'));
  const input = el('input');
  input.type = 'number'; input.min = '0'; input.step = 'any';
  if (key === 'price') input.id = 'factorPrice';
  input.value = numericText(onInput.value);
  input.addEventListener('input', () => onInput.set(input.value));
  wrap.append(input);
  if (unit) wrap.append(el('span', unit));
  return wrap;
}
function renderCore() {
  factorIndex = 0;
  const type = selectedType();
  const priceField = fieldOf('price');
  const priceValue = { get value() { return priceField.value ?? ''; }, set: next => setValue('price', next) };
  const factors = [];
  const priceNote = type === '次数' && totalUnits()
    ? '单次理论折合 ' + money(centsOf(priceField.value) / totalUnits())
    : type === '期限' ? '有效期内不限次使用'
      : type === '储值' ? '按本金与赠送金分别扣减' : '办卡实际支付金额';
  factors.push(factor('实付金额', numericValue('price', '元', priceValue), priceNote, 'price'));
  if (type === '储值') {
    const wrap = el('div', undefined, 'factor-pair');
    const principal = fieldOf('principal'); const bonus = fieldOf('bonus');
    const pLabel = el('label'); const pInput = numericInput(principal.value); pInput.placeholder = '0'; pLabel.append(el('span', '本金 ¥'), pInput);
    const bLabel = el('label'); const bInput = numericInput(bonus.value); bInput.placeholder = '0'; bLabel.append(el('span', '赠送 ¥'), bInput);
    pInput.addEventListener('input', () => setValue('principal', pInput.value));
    bInput.addEventListener('input', () => setValue('bonus', bInput.value));
    wrap.append(pLabel, bLabel);
    factors.push(factor('储值额度', wrap, '本金与赠送金分别参与扣减', 'principal'));
  } else if (type === '期限') {
    const content = el('div', undefined, 'factor-static', '有效期内不限次');
    factors.push(factor('权益方式', content, '期限卡按有效期判断覆盖', 'planType'));
  } else if (type === '时长') {
    const total = fieldOf('total'); const input = numericInput(total.value); input.min = '1';
    input.addEventListener('input', () => setValue('total', input.value));
    const wrap = el('div', undefined, 'factor-value'); wrap.append(input, el('span', '分钟'));
    factors.push(factor('权益总量', wrap, '单套餐分析暂不支持时长卡', 'total'));
  } else {
    const total = fieldOf('total'); const input = numericInput(total.value); input.min = '1';
    input.addEventListener('input', () => setValue('total', input.value));
    const unit = el('select');
    unit.append(new Option('按次', '次'), new Option('按使用日', '使用日'));
    unit.value = value('unit') === '使用日' ? '使用日' : '次';
    unit.addEventListener('change', () => { setValue('unit', unit.value); renderLeft(); });
    const valueRow = el('div', undefined, 'factor-value'); valueRow.append(input, el('span', '次'));
    const optionRow = el('label', undefined, 'factor-option');
    optionRow.append(el('span', '核销'), unit);
    const wrap = el('div', undefined, 'factor-content'); wrap.append(valueRow, optionRow);
    factors.push(factor('权益总量', wrap, '共可使用 ' + (total.value || '—') + ' 次', 'total'));
  }
  const expiry = fieldOf('expiryDays'); const expiryInput = numericInput(expiry.value); expiryInput.placeholder = '例如 90';
  expiryInput.addEventListener('input', () => {
    setValue('expiryDays', expiryInput.value);
    sim.assumedValidity = expiryInput.value.trim() ? null : 90;
  });
  const expiryWrap = el('div', undefined, 'factor-value'); expiryWrap.append(expiryInput, el('span', '天'));
  const validityNote = !expiryInput.value && !value('fixedEnd') && !value('validityMode') && sim.assumedValidity
    ? '未提及，暂按 ' + sim.assumedValidity + ' 天试算'
    : value('purchaseDays') ? '首次核销 ' + value('purchaseDays') + ' 天内' : '自核销或生效日起计算';
  factors.push(factor('权益有效期', expiryWrap, validityNote, 'expiryDays'));
  const regularWrap = el('div', undefined, 'factor-value');
  regularWrap.append(el('i', '¥'));
  const regular = el('input'); regular.id = 'factorRegularPrice'; regular.type = 'number'; regular.min = '0'; regular.step = 'any'; regular.value = numericText(sim.regularPrice); regular.placeholder = '单次价或折算价';
  regular.addEventListener('input', () => { sim.regularPrice = regular.value; schedule(); });
  regularWrap.append(regular);
  factors.push(factor('门市单次价 / 次卡折算', regularWrap, '不办卡的单次价，或同类次卡的折算单价', null));
  $('coreGrid').replaceChildren(...factors.slice(0, 4));
}
function centsOf(raw) {
  const number = Number.parseFloat(String(raw ?? '').replace(/[¥￥元,\s]/g, ''));
  return Number.isFinite(number) ? Math.round(number * 100) : null;
}
function numericText(raw) {
  const match = String(raw ?? '').match(/\d+(?:\.\d+)?/);
  return match ? match[0] : '';
}
function numericInput(raw) {
  const input = el('input');
  input.type = 'number'; input.min = '0'; input.step = 'any';
  input.value = numericText(raw);
  return input;
}
function totalUnits() {
  const type = selectedType();
  if (type === '储值') return (Number(value('principal')) || 0) + (Number(value('bonus')) || 0) || null;
  if (type === '期限') return Number(value('expiryDays')) || null;
  return Number(value('total')) || null;
}
function limitBadge(key, text) {
  if (!text) return ['未提及', 'neutral'];
  if (key === 'refund' && /不可退|不予退|验券后不可退|不支持退/.test(text)) return ['退款严格', 'danger'];
  if (key === 'refund') return ['可退改', 'success'];
  if (key === 'reservation' && /提前|预约|抢座|约满/.test(text)) return ['需预约', 'warning'];
  if (key === 'reservation') return ['无需预约', 'success'];
  if (key === 'coverage') return [/^全部/.test(text) ? '全部服务' : '限定范围', 'info'];
  return ['已保存原文', 'warning'];
}
function renderLimits() {
  const config = [
    ['refund', '退款规则', 'textarea'],
    ['reservation', '预约要求', 'input'],
    ['coverage', '适用范围', 'input'],
    ['restrictions', '其他关键限制', 'textarea'],
  ];
  $('limitGrid').replaceChildren(...config.map(([key, label, kind]) => {
    const field = fieldOf(key);
    const row = el('div', undefined, 'limit-field');
    const head = el('div', undefined, 'limit-head');
    const title = el('strong', label);
    const [badgeText, tone] = limitBadge(key, field.value);
    const badge = el('span', badgeText, 'badge'); badge.dataset.tone = tone;
    head.append(title, badge);
    const evidence = evidenceButton(key);
    if (evidence) head.append(evidence);
    row.append(head);
    const input = kind === 'textarea' ? el('textarea') : el('input');
    if (kind === 'textarea') input.rows = 2;
    input.value = field.value ?? '';
    input.placeholder = key === 'coverage' ? '例如：全部服务 / 仅限晚间自习' : key === 'reservation' ? '例如：需提前 2 小时预约' : '从原图提取，可修改';
    input.addEventListener('input', () => { field.value = input.value; field.status = '用户核对'; touched.add(key); schedule(); });
    row.append(input);
    return row;
  }));
  const risks = config.filter(([key]) => ['danger', 'warning'].includes(limitBadge(key, fieldOf(key).value)[1])).length;
  $('limitState').textContent = risks ? risks + ' 项需留意' : '未发现硬限制';
  $('limitState').dataset.tone = risks ? 'warning' : 'success';
}
function renderAdvanced() {
  const keys = Object.keys(labels).filter(key => !coreKeys.has(key));
  const rows = keys.map(key => {
    const field = group.fields?.[key];
    if (!field?.value?.trim()) return null;
    const wrap = el('label');
    wrap.append(el('span', labels[key] || key));
    const input = inputFor(field, key, { textarea: String(field.value).length > 60 });
    wrap.append(input);
    const meta = el('div', undefined, 'advanced-meta');
    meta.append(el('span', field.status || '待核对'));
    const evidence = evidenceButton(key);
    if (evidence) meta.append(evidence);
    wrap.append(meta);
    return wrap;
  }).filter(Boolean);
  $('advancedGrid').replaceChildren(...(rows.length ? rows : [el('p', '暂无更多字段。', 'muted')]));
  $('advancedCount').textContent = rows.length + ' 项';
}
function typeLabel(type) {
  return { 次数: '次数卡', 储值: '储值卡', 期限: '期限卡', 时长: '小时卡' }[type] || '类型待确认';
}
function renderLeft() {
  $('fieldMerchant').value = value('merchant');
  $('fieldTitle').value = value('title');
  const type = selectedType();
  for (const button of $('typeSeg').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.type === type));
  }
  $('groupConfirmed').checked = Boolean(group.confirmed);
  $('groupNote').textContent = group.confirmed ? '归组已确认。' : '归组尚未确认，当前结果只作试算预览；保存前请在完整核对页确认这些截图属于同一套餐。';
  renderCore();
  renderLimits();
  renderAdvanced();
  const filled = Object.entries(group.fields || {}).filter(([, field]) => field?.value?.trim()).length;
  $('verifyState').textContent = touched.size ? '已修改 ' + touched.size + ' 项' : '自动提取 ' + filled + ' 项';
  $('verifyState').dataset.tone = touched.size ? 'info' : 'neutral';
  $('sourceLine').textContent = [value('merchant'), value('title'), typeLabel(type), group.imageIds.length + ' 张截图'].filter(Boolean).join(' · ');
}

function scenarioInputs() {
  const freq = Math.max(.25, Number(sim.freq) || 1);
  const weeks = Math.max(1, Number(sim.weeks) || 4);
  const base = Math.max(1, Math.round(freq * weeks));
  const gap = Math.max(1, Math.round(7 / freq));
  return {
    low: { count: Math.max(1, Math.round(base * .7)), everyDays: gap },
    base: { count: base, everyDays: gap },
    high: { count: Math.max(1, Math.round(base * 1.3)), everyDays: gap },
  };
}
function previewFields() {
  const fields = {};
  for (const [key, field] of Object.entries(group.fields || {})) {
    if (typeof field?.value === 'string' && field.value.trim()) fields[key] = field.value;
  }
  for (const key of touched) fields[key] = group.fields?.[key]?.value ?? '';
  if (!fields.coverage) fields.coverage = '全部';
  if (fields.planType === '次数' && !fields.unit) fields.unit = '次';
  if (fields.planType === '期限' && !fields.unit) fields.unit = '连续天';
  if (!fields.planType) fields.planType = selectedType();
  if (!fields.expiryDays && !fields.fixedEnd && !fields.validityMode && sim.assumedValidity) {
    fields.expiryDays = String(sim.assumedValidity);
  }
  return fields;
}
async function recalc() {
  if (!group || busy) return;
  const seq = ++requestSeq;
  busy = true;
  status('正在按当前数值试算…', 'loading');
  $('verdictMode').textContent = '更新中…';
  try {
    const request = {
      groupId: group.id,
      previewFields: previewFields(),
      startDate: sim.startDate,
      activationDate: sim.startDate,
      serviceId: sim.serviceId,
      referencePrice: sim.regularPrice,
      extraFees: sim.extraFees,
      scenarios: scenarioInputs(),
      includeCostCurve: true,
    };
    let payload;
    try {
      payload = await api('/api/decision', { ...request, answers: { restrictions: '仅在计划符合原文限制时试算' } });
    } catch (error) {
      if (!/追问选项已失效/.test(error.message)) throw error;
      payload = await api('/api/decision', { ...request, answers: {} });
    }
    if (seq !== requestSeq) return;
    latest = payload;
    renderDecision(payload);
    status(touched.size ? '试算已更新；修改尚未保存。' : '已按当前套餐数值试算。', touched.size ? 'unsaved' : 'success');
  } catch (error) {
    if (seq !== requestSeq) return;
    status('试算失败：' + error.message, 'error');
    $('verdictMode').textContent = '';
  } finally {
    if (seq === requestSeq) busy = false;
  }
}
function knownBreakEven(payload) {
  const points = payload.costCurve?.points ?? [];
  const hit = points.find(point => point.count > 0 && Number.isSafeInteger(point.difference) && point.difference >= 0);
  if (hit) return hit.count;
  const price = payload.review?.plan?.offerPriceCents;
  const regular = centsOf(sim.regularPrice);
  return Number.isSafeInteger(price) && regular ? Math.ceil(price / regular) : null;
}
function renderDecision(payload) {
  const review = payload.review;
  const base = payload.analysis?.scenarios?.find(item => item.input.id === 'base');
  const result = base?.result;
  const diff = result?.economicDifferenceCents ?? null;
  const cash = result?.cash?.totalCents ?? null;
  const payg = result?.payAsYouGoCents ?? null;
  const expected = base?.input?.uses?.length ?? 0;
  const plan = review.plan;
  const type = plan?.type;
  const total = type === 'visit_pack' ? plan?.rules?.visits :
    type === 'stored_value' ? ((plan.rules.principalCents ?? 0) + (plan.rules.bonusCents ?? 0) || null) : null;
  const covered = result?.entitlement?.coveredUses ?? (cash != null ? expected : 0);
  const remaining = type === 'visit_pack'
    ? (result?.entitlement?.remainingVisits ?? (total ? Math.max(0, total - covered) : null))
    : null;
  const perVisit = cash != null && covered > 0 ? Math.round(cash / covered) : null;
  const breakEven = knownBreakEven(payload);
  const waste = type === 'visit_pack' && remaining != null && total
    ? Math.round(remaining * ((plan.offerPriceCents ?? 0) / total))
    : type === 'stored_value' ? (result?.entitlement?.unusedPrincipalCents ?? null) : null;
  const riskGroups = collectRisks(payload);
  const riskCount = riskGroups.questions.length + riskGroups.risks.length;
  const conditional = result?.status === 'conditional';
  const coverageAssumed = !value('coverage');
  const validityAssumed = !value('expiryDays') && !value('fixedEnd') && !value('validityMode') && Boolean(sim.assumedValidity);
  renderVerdict({ diff, cash, payg, expected, total, remaining, waste, breakEven, conditional, riskCount, coverageAssumed, validityAssumed, type });
  renderKpis({ breakEven, expected, covered, total, perVisit, diff, remaining, waste, type });
  renderTimeline({ breakEven, expected, total, type });
  renderRisks(riskGroups);
  renderBasis(payload, { conditional, coverageAssumed, validityAssumed });
  $('verdictMode').textContent = conditional ? '条件试算 · 前提见依据' : cash != null ? '按已核对数值计算' : '等待补充条件';
}
function renderVerdict({ diff, cash, payg, expected, total, remaining, waste, breakEven, conditional, riskCount, coverageAssumed, validityAssumed, type }) {
  const card = $('verdictCard');
  let tone = 'neutral', title = '还需补充条件', badge = '待补充';
  if (diff != null) {
    if (diff > 0) { tone = 'safe'; title = '建议购买 · 比单次更省'; badge = '更省'; }
    else if (diff < 0) { tone = 'risky'; title = '不建议办卡 · 比单次更贵'; badge = '更贵'; }
    else { tone = 'neutral'; title = '与单次付费持平'; badge = '持平'; }
    if (conditional) badge = '条件试算';
  }
  card.dataset.tone = tone;
  $('verdictBadge').textContent = badge;
  $('verdictBadge').dataset.tone = tone === 'safe' ? 'success' : tone === 'risky' ? 'danger' : tone === 'tight' ? 'warning' : 'neutral';
  $('verdictTitle').textContent = title;
  $('verdictLead').textContent = diff != null
    ? (conditional ? '按页面数值，并假设计划符合原文所列使用限制。' : '按页面数值和当前使用计划计算。')
    : '填写单次正价并补齐套餐要素后，这里会给出结论。';
  const points = [];
  if (breakEven) points.push('按每周 ' + sim.freq + ' 次，回本需要约 ' + breakEven + ' 次，预计第 ' + Math.ceil(breakEven / Math.max(.25, Number(sim.freq) || 1)) + ' 周到达。');
  else if (expected) points.push('计划预计使用 ' + expected + ' 次；回本临界点尚未找到。');
  if (cash != null && payg != null) points.push('预付总支出 ' + money(cash) + '，按次 ' + money(payg) + (diff >= 0 ? '，少花 ' : '，多花 ') + money(Math.abs(diff)) + '。');
  if (total && remaining != null) points.push('权益共 ' + total + ' 次，预计剩余 ' + remaining + ' 次' + (waste ? '，到期可能作废约 ' + compactMoney(waste) : '') + '。');
  if (type === 'stored_value' && waste) points.push('按当前计划消费后，预计仍有约 ' + compactMoney(waste) + ' 额度留在卡内。');
  if (coverageAssumed) points.push('截图未提及适用范围，暂按「全部服务可用」试算，建议向商家确认。');
  if (validityAssumed) points.push('截图未提及权益有效期，暂按 ' + sim.assumedValidity + ' 天试算，请核对券面有效期。');
  if (riskCount) points.push('还有 ' + riskCount + ' 项条款需要核对，见下方清单。');
  $('verdictPoints').replaceChildren(...points.map(text => el('li', text)));
}
function renderKpis({ breakEven, expected, covered, total, perVisit, diff, remaining, waste, type }) {
  $('kpiBreakEven').textContent = breakEven ? breakEven + ' 次' : '—';
  $('kpiBreakEvenNote').textContent = breakEven ? '按每周 ' + sim.freq + ' 次，约第 ' + Math.ceil(breakEven / Math.max(.25, Number(sim.freq) || 1)) + ' 周回本' : '填写单次正价后计算';
  $('kpiUsage').textContent = type === 'visit_pack' && total ? covered + ' / ' + total : expected + ' 次';
  $('kpiUsageNote').textContent = type === 'visit_pack' && remaining != null
    ? (remaining > 0 ? '预计剩余 ' + remaining + (waste ? ' · 约 ' + compactMoney(waste) : '') : '可按计划用尽')
    : type === 'stored_value' && remaining != null ? '预计剩余额度 ' + compactMoney(remaining)
      : type === 'time_pass' ? '按有效期内的到访次数' : '有效期内预计 ' + expected + ' 次';
  $('kpiCost').textContent = perVisit != null ? money(perVisit) : '—';
  $('kpiCostNote').textContent = perVisit != null && sim.regularPrice ? '门市 ' + money(centsOf(sim.regularPrice)) + ' · 约 ' + (perVisit / Math.max(1, centsOf(sim.regularPrice)) * 10).toFixed(1) + ' 折' : '预付支出摊到实际使用次数';
  const tone = diff == null ? '' : diff >= 0 ? 'tone-safe' : 'tone-risky';
  $('kpiSaving').className = tone;
  $('kpiSaving').textContent = diff == null ? '—' : (diff >= 0 ? '+' : '−') + compactMoney(diff);
  $('kpiSavingNote').textContent = diff == null ? '等待试算' : diff >= 0 ? '比单次买单少花' : '比单次买单多花';
}
function renderTimeline({ breakEven, expected, total, type }) {
  const capacity = type === 'visit_pack' && total ? total : Math.max(expected, breakEven || 0, 1);
  const recovery = Math.min(breakEven || 0, expected);
  const gain = Math.max(0, expected - (breakEven || 0));
  $('timelineBreak').style.width = pct(recovery, capacity) + '%';
  $('timelineExpected').style.left = pct(recovery, capacity) + '%';
  $('timelineExpected').style.width = pct(gain, capacity) + '%';
  $('timelineBreakLabel').textContent = breakEven ? '回本线 ' + breakEven + ' 次' : '回本线待确认';
  $('timelineExpectedLabel').textContent = '预计到访 ' + expected + ' 次';
  $('timelineTotal').textContent = type === 'visit_pack' && total ? '总权益 ' + total : '';
}
function truncateText(value, length = 90) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > length ? text.slice(0, length) + '…' : text;
}
function classifyRefund(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const percent = (/(\d+)\s*%\s*的?\s*手续费/.exec(raw) || /手续费[^。\n]{0,30}?(\d+)\s*%/.exec(raw))?.[1];
  if (/核销后.{0,12}(?:不可退|不支持退|不予退)|验券后不可退/.test(raw)) {
    return { kind: 'risk', tone: 'danger', title: '核销后不可退', detail: '截图写明核销后不支持退款，购买前需要确认。' };
  }
  if (percent) {
    return { kind: 'risk', tone: 'warning', title: '退款需扣 ' + percent + '% 手续费', detail: '未使用部分通常可退；核销后退款按未消费金额扣 ' + percent + '% 手续费。' };
  }
  if (/手续费|扣费|违约金/.test(raw)) {
    return { kind: 'risk', tone: 'warning', title: '退款可能扣手续费', detail: truncateText(raw, 100) };
  }
  if (/可退|退还/.test(raw)) {
    return { kind: 'clause', tone: 'info', title: '未使用可退', detail: '截图提到可退，具体金额和条件以商家确认为准。' };
  }
  return { kind: 'clause', tone: 'info', title: '退款规则待确认', detail: truncateText(raw, 90) };
}
function classifyReservation(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const sentences = raw.split(/[\n。；;]/).map(item => item.trim())
    .filter(item => /预约|订座|抢座/.test(item) && !/对于.{0,14}需要预约|如需预约|若需预约/.test(item));
  if (!sentences.length) return null;
  const first = sentences[0];
  if (/无需预约|免预约|不需要预约|不用预约/.test(first)) {
    return { kind: 'clause', tone: 'success', title: '无需预约', detail: '可直接到店；高峰时段可能需要排队。' };
  }
  if (/需|提前|订座|抢座|约满/.test(first)) {
    return { kind: 'risk', tone: 'warning', title: '需要预约', detail: truncateText(first, 90) };
  }
  return null;
}
function collectRisks(payload) {
  const questions = (payload.questions || []).map(question => ({
    title: question.title, detail: question.merchant || '需要进一步确认。', tone: 'warning', field: question.field, kind: 'question',
  }));
  const risks = [], clauses = [];
  const covered = new Set(questions.map(question => question.field).filter(Boolean));
  for (const [key, term] of Object.entries(payload.review?.fields || {})) {
    if (term.status === 'conflicting') {
      risks.push({ title: term.label + '存在冲突', detail: term.value || '截图里有不同写法，需要选择或确认。', tone: 'danger', field: key, kind: 'risk' });
      covered.add(key);
    } else if (term.status === 'potential_risk') {
      risks.push({ title: term.label + '需要留意', detail: truncateText(term.value, 100), tone: 'warning', field: key, kind: 'risk' });
      covered.add(key);
    }
  }
  const field = key => payload.review?.fields?.[key]?.value || '';
  if (!covered.has('refund')) {
    const result = classifyRefund(field('refund'));
    if (result) (result.kind === 'risk' ? risks : clauses).push({ ...result, field: 'refund' });
    covered.add('refund');
  }
  if (!covered.has('reservation')) {
    const result = classifyReservation(field('reservation'));
    if (result) (result.kind === 'risk' ? risks : clauses).push({ ...result, field: 'reservation' });
    covered.add('reservation');
  }
  const schedule = field('schedule') || field('restrictions');
  if (schedule && !covered.has('schedule') && /(仅限|只限|晚自习|周[一二三四五六日][^，。\n]{0,12}(?:18|19|20|21|22|23)\s*点?\s*后)/.test(schedule) && !/全天|不限时段/.test(schedule)) {
    risks.push({ title: '使用时段受限', detail: truncateText(schedule, 110), tone: 'warning', field: 'schedule', kind: 'risk' });
    covered.add('schedule');
  }
  if (!covered.has('coverage')) {
    const coverage = field('coverage');
    if (/^仅限/.test(coverage)) risks.push({ title: '仅限指定范围使用', detail: truncateText(coverage, 90), tone: 'warning', field: 'coverage', kind: 'risk' });
    else if (/^全部/.test(coverage)) clauses.push({ title: '全部服务可用', detail: '截图写明适用范围为全部。', tone: 'success', field: 'coverage', kind: 'clause' });
    else clauses.push({ title: '适用范围未提及', detail: '试算暂按全部服务可用。', tone: 'info', field: 'coverage', kind: 'clause' });
  }
  const restrictions = field('restrictions');
  if (restrictions && !covered.has('restrictions') && !risks.some(item => item.field === 'restrictions')) {
    clauses.push({ title: '其他已保存限制', detail: truncateText(restrictions, 110), tone: 'info', field: 'restrictions', kind: 'clause' });
  }
  return { questions, risks, clauses };
}
function renderRisks({ questions, risks, clauses }) {
  const count = questions.length + risks.length;
  $('riskCount').textContent = count ? count + ' 项' : '暂无';
  $('riskCount').dataset.tone = count ? 'warning' : 'success';
  const nodes = [];
  const group = (title, items) => {
    if (!items.length) return;
    const section = el('div', undefined, 'risk-group');
    section.append(el('h3', title, 'risk-group-title'));
    for (const item of items) {
      const card = el('div', undefined, 'risk-item');
      card.dataset.tone = item.tone;
      card.append(el('strong', item.title), el('p', item.detail));
      if (item.field) {
        const button = el('button', '查看原图证据');
        button.type = 'button';
        button.addEventListener('click', () => openEvidence(item.field));
        card.append(button);
      }
      section.append(card);
    }
    nodes.push(section);
  };
  group('需要你确认', questions);
  group('风险提示', risks);
  if (!count) nodes.push(el('p', '当前没有发现需要确认的风险。', 'risk-empty'));
  if (clauses.length) {
    const details = el('details', undefined, 'clause-details');
    details.append(el('summary', '已知条款（' + clauses.length + '）'));
    const list = el('ul', undefined, 'clause-list');
    for (const clause of clauses) {
      const item = el('li');
      item.append(el('strong', clause.title), el('span', ' · ' + clause.detail));
      list.append(item);
    }
    details.append(list);
    nodes.push(details);
  }
  $('riskList').replaceChildren(...nodes);
  updateRiskToggle();
}
function updateRiskToggle() {
  requestAnimationFrame(() => {
    const list = $('riskList');
    const toggle = $('riskToggle');
    const limit = 280;
    const overflowing = list.scrollHeight > limit;
    list.classList.toggle('overflowing', overflowing);
    toggle.hidden = !overflowing;
    if (!overflowing) list.classList.remove('expanded');
    toggle.textContent = list.classList.contains('expanded') ? '收起' : '展开全部';
  });
}
function renderBasis(payload, { conditional, coverageAssumed, validityAssumed }) {
  const blocks = [];
  const assumptions = [...(payload.assumptions || [])];
  if (conditional) assumptions.unshift('当前结果以「计划符合原文所列使用限制」为前提，预约、时段和附加费用仍未逐项核验。');
  if (coverageAssumed) assumptions.push('截图未提及适用范围，试算暂按全部服务可用。');
  if (validityAssumed) assumptions.push('截图未提及权益有效期，试算暂按 ' + sim.assumedValidity + ' 天。');
  if (assumptions.length) {
    const block = el('div', undefined, 'basis-block');
    block.append(el('h3', '计算前提'));
    const list = el('ul');
    assumptions.forEach(text => list.append(el('li', text)));
    block.append(list); blocks.push(block);
  }
  const base = payload.analysis?.scenarios?.find(item => item.input.id === 'base');
  const trace = base?.result?.rules;
  if (trace) {
    const block = el('div', undefined, 'basis-block');
    block.append(el('h3', '规则依据'));
    const list = el('ul');
    [...(trace.applied || []).map(rule => '本次用到：' + rule.title), ...(trace.open || []).map(rule => '待落实：' + rule.title)]
      .forEach(text => list.append(el('li', text)));
    if (!list.children.length) list.append(el('li', '当前没有额外的规则记录。'));
    block.append(list); blocks.push(block);
  }
  const evidenceFields = Object.entries(payload.review?.fields || {})
    .filter(([, term]) => term.evidence?.length || term.candidates?.length).slice(0, 3);
  if (evidenceFields.length) {
    const block = el('div', undefined, 'basis-block');
    block.append(el('h3', '原文证据'));
    const list = el('ul');
    evidenceFields.forEach(([key, term]) => {
      const quote = (term.evidence?.[0]?.quote || term.candidates?.[0]?.quote || '').slice(0, 100);
      list.append(el('li', term.label + (quote ? '：' + quote : '')));
    });
    block.append(list); blocks.push(block);
  }
  $('basisList').replaceChildren(...blocks);
  $('basisCount').textContent = blocks.length ? blocks.length + ' 组' : '';
  $('basisCount').dataset.tone = 'neutral';
}

function openEvidence(key) {
  const field = key ? group.fields?.[key] : null;
  const label = key ? labels[key] || key : '本组截图';
  const evidence = key ? ((field?.evidence || []).find(item => item.imageId) ||
    facts.find(item => item.field === key && item.imageId)) : null;
  const imageId = evidence?.imageId || group.imageIds[0];
  const image = images.find(item => item.id === imageId);
  $('drawerTitle').textContent = label + (key ? ' · 原图证据' : ' · 原图');
  $('drawerQuote').textContent = evidence?.quote || evidence?.text ||
    (key ? '该字段来自手动填写或历史审阅，以下是本组原图。' : '本组共 ' + group.imageIds.length + ' 张截图；点击字段旁的证据可以定位具体原文。');
  if (image) {
    $('drawerImage').hidden = false; $('drawerImage').src = image.url;
    $('drawerFull').hidden = false; $('drawerFull').href = image.url;
    $('drawerOcr').textContent = (image.ocr?.lines || []).map(line => line.text).join('\n') || '尚未识别';
  } else {
    $('drawerImage').hidden = true; $('drawerFull').hidden = true; $('drawerOcr').textContent = '';
  }
  $('evidenceDrawer').hidden = false; $('drawerScrim').hidden = false;
  $('drawerClose').focus();
}
function closeDrawer() {
  $('evidenceDrawer').hidden = true; $('drawerScrim').hidden = true;
}

function setupCapabilities() {
  api('/api/agent/capabilities').then(({ deepseek }) => {
    if (!deepseek) return;
    const box = $('aiDeepSeek');
    box.disabled = false; $('aiModel').hidden = false;
    try { box.checked = localStorage.getItem(modelPreferenceKey) === 'true'; } catch {}
    box.addEventListener('change', () => { try { localStorage.setItem(modelPreferenceKey, String(box.checked)); } catch {} });
  }).catch(() => {});
}
function aiRequested() { const box = $('aiDeepSeek'); return Boolean(box && !box.disabled && box.checked); }
async function openAi() {
  if (!group) return;
  const imageIds = group.imageIds.filter(id => images.find(item => item.id === id)?.ocr?.lines?.length);
  if (!imageIds.length) { status('本组还没有可用的 OCR 文本。', 'warning'); return; }
  $('aiDialog').showModal();
  $('aiStatus').dataset.state = 'loading';
  $('aiStatus').textContent = '正在整理本组截图…';
  $('aiMeta').replaceChildren(); $('aiRows').replaceChildren(); $('aiAdopt').hidden = true;
  try {
    aiResult = await api('/api/ai/extract', { imageIds, useDeepSeek: aiRequested() });
    renderAi(aiResult);
  } catch (error) {
    $('aiStatus').dataset.state = 'error';
    $('aiStatus').textContent = 'AI 整理失败：' + error.message;
  }
}
function renderAi(result) {
  const deep = result.mode === 'deepseek' && !result.fallback;
  const meta = [];
  const mode = el('span', deep ? 'DeepSeek 文本整理' : '本地规则整理', 'badge');
  mode.dataset.tone = deep ? 'success' : result.fallback ? 'warning' : 'neutral';
  meta.push(mode);
  if (result.redactions?.total) {
    const redacted = el('span', '已脱敏 ' + result.redactions.total + ' 处', 'badge'); redacted.dataset.tone = 'info'; meta.push(redacted);
  }
  if (aiRequested() && !deep) {
    const stale = el('span', '服务端未加载 DeepSeek 路由，请重启服务', 'badge'); stale.dataset.tone = 'warning'; meta.push(stale);
  }
  $('aiMeta').replaceChildren(...meta);
  $('aiStatus').dataset.state = result.fallback ? 'warning' : 'success';
  $('aiStatus').textContent = result.fallback ? 'DeepSeek 未成功，已用本地规则整理。' : deep ? 'DeepSeek 已完成文本提取。' : '本地规则整理，未调用外部 API。';
  const candidates = (result.candidates || []).filter(item => item.quote && item.confidence >= .6);
  const rows = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.field)) continue;
    seen.add(candidate.field);
    const row = el('div', undefined, 'ai-row');
    row.append(el('strong', labels[candidate.field] || candidate.field), el('span', candidate.value + (candidate.quote ? ' · ' + String(candidate.quote).slice(0, 80) : '')));
    rows.push(row);
  }
  $('aiRows').replaceChildren(...(rows.length ? rows : [el('p', '没有提取到可采用的字段，请检查截图或手动填写。', 'muted')]));
  $('aiAdopt').hidden = !rows.length;
  $('aiAdopt').textContent = '采用全部并确认（' + rows.length + '）';
}
function adoptAi() {
  if (!aiResult || !group) return;
  let changed = 0;
  for (const candidate of aiResult.candidates || []) {
    if (!candidate.quote || candidate.confidence < .6) continue;
    const field = fieldOf(candidate.field);
    if (field.value && field.value !== candidate.value) continue;
    field.value = candidate.value;
    field.status = '用户核对';
    field.evidence = [{ ...candidate, sourceType: 'ai', method: 'AI 整理并由用户一次性确认' }];
    touched.add(candidate.field);
    changed++;
  }
  if (changed) {
    renderLeft();
    schedule();
    status('已采用并确认 ' + changed + ' 项，右侧正在重算。', 'unsaved');
  }
  $('aiDialog').close();
}

async function save() {
  if (!group) return false;
  for (const key of touched) {
    const field = group.fields?.[key];
    if (field) field.status = '用户核对';
  }
  try {
    await api('/api/project', { version: 1, groups });
    touched.clear();
    renderLeft();
    status('已保存到本机项目。', 'success');
    return true;
  } catch (error) {
    status('保存失败：' + error.message, 'error');
    return false;
  }
}

$('typeSeg').addEventListener('click', event => {
  const button = event.target.closest('button[data-type]');
  if (!button) return;
  setValue('planType', button.dataset.type);
  if (!value('unit')) setValue('unit', typeUnits[button.dataset.type] || '次');
  renderCore(); renderLimits(); renderLeft(); schedule();
});
$('fieldMerchant').addEventListener('input', event => { setValue('merchant', event.target.value); $('sourceLine').textContent = [event.target.value, value('title'), typeLabel(selectedType()), group.imageIds.length + ' 张截图'].filter(Boolean).join(' · '); });
$('fieldTitle').addEventListener('input', event => { setValue('title', event.target.value); $('sourceLine').textContent = [value('merchant'), event.target.value, typeLabel(selectedType()), group.imageIds.length + ' 张截图'].filter(Boolean).join(' · '); });
$('groupConfirmed').addEventListener('change', event => { group.confirmed = event.target.checked; touched.add('__group'); $('groupNote').textContent = group.confirmed ? '归组已确认。' : '归组尚未确认，当前结果只作试算预览；保存前请在完整核对页确认这些截图属于同一套餐。'; });
$('groupSelect').addEventListener('change', event => {
  if (touched.size && !confirm('当前套餐有未保存的修改，切换后会丢失。继续切换？')) {
    event.target.value = groupId; return;
  }
  selectGroup(event.target.value);
});
$('freq').addEventListener('input', event => {
  sim.freq = Math.max(1, Math.min(7, Math.round(Number(event.target.value) || 1)));
  event.target.value = String(sim.freq);
  $('freqValue').textContent = sim.freq + ' 次 / 周';
  renderPresets(); schedule();
});
for (const id of ['weeks', 'extraFees', 'startDate', 'serviceId']) {
  $(id).addEventListener('input', event => {
    sim[id] = event.target.value;
    schedule();
  });
}
$('save').addEventListener('click', save);
$('groupEvidence').addEventListener('click', () => openEvidence(null));
function prefillCoverage(text) {
  const raw = String(text ?? '').trim();
  if (/^全部/.test(raw)) return { kind: 'all' };
  if (/^仅限/.test(raw)) return { kind: 'services', services: raw.slice(2).replace(/(?:可用|使用)$/, '') };
  return { kind: 'unknown' };
}
function prefillValidity() {
  const days = Number(numericText(value('expiryDays')));
  if (value('fixedEnd')) return { kind: 'fixed', startDate: value('fixedStart'), endDate: value('fixedEnd') };
  if (days > 0) return { kind: 'from_activation', days };
  if (value('validityMode') === '无期限') return { kind: 'unlimited' };
  if (sim.assumedValidity) return { kind: 'from_activation', days: sim.assumedValidity, assumed: true };
  return { kind: 'unknown' };
}
function prefillBonusValidity() {
  const days = Number(numericText(value('bonusDays')));
  if (value('bonusEnd')) return { kind: 'fixed', endDate: value('bonusEnd') };
  if (days > 0) return { kind: 'from_activation', days };
  if (value('bonusValidity') === '同主卡') return { kind: 'same_as_plan' };
  if (value('bonusValidity') === '无期限') return { kind: 'unlimited' };
  return { kind: 'unknown' };
}
function walletPrefill() {
  const typeMap = { 次数: 'visits', 储值: 'stored_value', 期限: 'period', 时长: 'hours' };
  const deductionMap = { 本金优先: 'principal_first', 赠送优先: 'bonus_first', 初始比例: 'proportional' };
  const type = selectedType();
  const validity = prefillValidity();
  const notes = [];
  if (!value('coverage')) notes.push('适用范围未提及，登记时保留待核对');
  if (validity.assumed) notes.push('有效期未提及，暂按 ' + sim.assumedValidity + ' 天预填');
  return {
    groupId: group.id,
    imageIds: group.imageIds.slice(0, 8),
    sourceLine: '来自套餐分析：' + (value('title') || group.name) + '。已填入页面核对值，请确认实付和实际权益。' +
      (notes.length ? '（' + notes.join('；') + '）' : ''),
    name: value('title') || group.name,
    type: typeMap[type] || '',
    paid: value('actualPrice') || value('price') || '',
    purchasedOn: today(),
    activationDate: today(),
    validity,
    coverage: prefillCoverage(value('coverage')),
    principal: value('principal'),
    bonus: value('bonus'),
    deduction: deductionMap[value('deduction')] || 'unknown',
    bonusCoverage: prefillCoverage(value('bonusCoverage')),
    bonusValidity: prefillBonusValidity(),
    visits: value('total'),
    redemption: value('unit') === '使用日' ? 'per_day' : 'per_visit',
    minutes: type === '时长' ? value('total') : '',
    billingMinutes: value('billing'),
  };
}
$('toWallet').addEventListener('click', async event => {
  event.preventDefault();
  if (!group) return;
  if (touched.size && !(await save())) return;
  try { sessionStorage.setItem('kdz-wallet-enroll', JSON.stringify(walletPrefill())); } catch {}
  location.href = 'wallet.html?enroll=1';
});
$('aiOpen').addEventListener('click', openAi);
$('aiClose').addEventListener('click', () => $('aiDialog').close());
$('aiCloseBottom').addEventListener('click', () => $('aiDialog').close());
$('aiAdopt').addEventListener('click', adoptAi);
$('drawerClose').addEventListener('click', closeDrawer);
$('drawerScrim').addEventListener('click', closeDrawer);
$('riskToggle').addEventListener('click', () => {
  const list = $('riskList');
  const expanded = list.classList.toggle('expanded');
  $('riskToggle').textContent = expanded ? '收起' : '展开全部';
});
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('evidenceDrawer').hidden) closeDrawer(); });
$('exportGroup').addEventListener('click', async () => {
  if (!group) return;
  const link = el('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, group, images: images.filter(item => group.imageIds.includes(item.id)) }, null, 2)], { type: 'application/json' }));
  link.download = 'Vericard-套餐证据-' + group.id + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});
window.addEventListener('beforeunload', event => {
  if (touched.size && !event.defaultPrevented) { event.preventDefault(); event.returnValue = ''; }
});

boot();
