'use strict';

const $ = id => document.getElementById(id);
const wallet = window.KDZWallet;
const cardId = new URLSearchParams(location.search).get('card');
const p1 = createWalletP1({ updateCard: renderDetail, wallet, cardId, reveal: () => showDetailTab("fulfillment") });
const detailTabs = [...document.querySelectorAll(".wallet-detail-tabs [role=tab]")];
const states = {
  active: '使用中', not_started: '未生效', expired: '已到期', closed: '权益已终止',
  activation_unknown: '生效日待核对', validity_unknown: '有效期待核对',
};
const deductionLabels = { principal_first: '本金优先', bonus_first: '赠送金优先', proportional: '按初始比例' };
let current;
let pendingId = null;
let busy = false;

function showDetailTab(key, focus = false) {
  for (const tab of detailTabs) {
    const selected = tab.id === "detail-tab-" + key;
    tab.setAttribute("aria-selected",String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(tab.getAttribute("aria-controls")).hidden = !selected;
    if (selected && focus) tab.focus();
  }
}

function showUsage() {
  if ($('usagePanel').open) return;
  $('usageStatus').textContent = '';
  $('usagePanel').showModal();
}

function showDetailAnchor() {
  const target = $(location.hash.slice(1));
  if (!target || !$("walletDetail").contains(target)) return;
  if (target === $("usagePanel")) { showUsage(); return; }
  const pane = target.closest("[role=tabpanel]");
  if (pane) showDetailTab(pane.id.slice("detail-pane-".length));
  requestAnimationFrame(() => target.scrollIntoView({block:"center"}));
}

function element(tag, content, className) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  if (className) node.className = className;
  return node;
}

function link(label, href) {
  const node = element('a', label);
  node.href = href;
  return node;
}

function button(label, action) {
  const node = element('button', label, 'secondary');
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function list(items) {
  const node = element('dl');
  for (const [key, value] of items) {
    const row = element('div');
    row.append(element('dt', key), element('dd', value));
    node.append(row);
  }
  return node;
}

function deadlineText(deadline) {
  if (!deadline?.endDate) return deadline?.knownUnlimited ? '无固定截止' : '待核对';
  const { endDate, daysLeft } = deadline;
  return endDate + (daysLeft === 0 ? ' · 今天到期' : daysLeft > 0 ? ' · 还有 ' + daysLeft + ' 天' : ' · 已到期');
}

function remainingText(card) {
  if (card.type === 'stored_value') return wallet.money(card.remaining.totalCents);
  if (card.type === 'visit_pack') return card.remaining.visits + (card.offerType === 'single' ? ' 张券' : ' 次');
  if (card.type === 'time_pack') return wallet.duration(card.remaining.minutes);
  return '已记卡内到访 ' + card.coveredUses + ' 次';
}

function alerts(target, card) {
  for (const notice of card.attention ?? []) {
    const row = element('p', wallet.attentionText(notice), 'warning');
    if (!notice.endDate) row.append(document.createTextNode(' '),link('查看' + notice.label,notice.anchor));
    target.append(row);
  }
}

function setStatus(state, message) {
  $('walletStatus').dataset.state = state;
  $('walletStatus').textContent = message;
}

function stateBadge(card) {
  const node = element('span', wallet.cardLabel(card) + ' · ' + states[card.status], 'badge');
  node.dataset.tone = card.status === 'active' ? 'success' :
    ['expired', 'closed'].includes(card.status) ? 'neutral' : 'warning';
  return node;
}

function bucket(value, range) {
  return value === null ? wallet.money(range[0]) + ' 至 ' + wallet.money(range[1]) + '（分账待核对）' : wallet.money(value);
}

function coverageText(coverage) {
  return coverage?.kind === 'services' ? coverage.serviceIds.join('、') :
    coverage?.kind === 'all' ? '全部服务' : coverage?.kind === 'none' ? '不适用' : '待核对';
}

function renderSource(card) {
  const target = $('cardSource');
  const rules = card.plan.rules;
  const items = [['实际适用服务', coverageText(rules.coverage)], ['购前规则版本', card.source.planVersion]];
  if (card.type === 'stored_value') {
    items.push(['开卡本金', wallet.money(card.initial.principalCents)], ['开卡赠送金', wallet.money(card.initial.bonusCents)]);
    if (rules.bonusCents > 0) items.push(['赠送金适用服务', coverageText(rules.bonusCoverage)]);
    items.push(['实际扣减顺序', deductionLabels[rules.deduction] ?? '待核对']);
  }
  if (card.type === 'visit_pack') {
    items.push(['实际扣次方式', rules.redemption === 'per_day' ? '同日扣一次' : rules.redemption === 'per_visit' ? '按到访扣次' : '待核对']);
  }
  if (card.type === 'time_pack') items.push(['初始时长',wallet.duration(rules.minutes)],
    ['核销单位',rules.billingMinutes ? wallet.duration(rules.billingMinutes) : '待核对']);
  target.replaceChildren(list(items));
  const analysis = card.source.analysis?.scenarios ?? [];
  if (analysis.length) {
    const scenarios = analysis.map(({ input, result }) => [input.label + '情景（购前）', wallet.money(result.cash.totalCents)]);
    target.append(list(scenarios));
  }
  for (const rule of card.source.limitations) target.append(element('p', rule.text, 'warning'));
  for (const field of Object.values(card.plan.evidence)) {
    const quote = field.evidence?.[0]?.quote;
    if (quote) target.append(element('p', field.label + ' · ' + quote, 'muted'));
  }
  if (card.source.groupId) target.append(link('打开当前截图分组', 'extract.html?group=' + encodeURIComponent(card.source.groupId)));
  else {
    target.append(element('p', card.source.kind === 'comparison' ? '来源 · 比较结果购入快照' : '来源 · 手动登记', 'muted'));
    if (card.source.comparison) target.append(element('p', '截图报价 ' + wallet.money(card.source.comparison.price) + ' · 实付见上方', 'muted'));
    for (const [index,id] of (card.source.imageIds ?? []).entries()) {
      const original = link('查看来源原图 ' + (index + 1), '/api/wallet/cards/' + encodeURIComponent(card.id) + '/source/' + id);
      original.target = '_blank';
      original.rel = 'noopener';
      target.append(original, document.createTextNode(' '));
    }
  }
}

function debitText(event, type) {
  if (!event.debit) return '扣减待核对';
  if (type === 'stored_value') {
    const { totalCents, principalCents, bonusCents } = event.debit;
    return '扣减 ' + wallet.money(totalCents) + (principalCents === null ? ' · 分账待核对' :
      ' · 本金 ' + wallet.money(principalCents) + ' · 赠送金 ' + wallet.money(bonusCents));
  }
  if (type === 'visit_pack') return '扣减 ' + event.debit.visits + (current?.offerType === 'single' ? ' 张券' : ' 次');
  if (type === 'time_pack') return '扣减 ' + wallet.duration(event.debit.minutes);
  return event.debit.covered ? '使用会员权益' : '本次未使用会员权益';
}

function renderLedger(card) {
  const rows = card.events.map(event => {
    if (!['consume', 'consume_confirmation'].includes(event.type)) {
      const row = p1.eventRow(event);
      row.id = 'event-' + event.id;
      return row;
    }
    const item = element('article', undefined, 'term');
    item.id = 'event-' + event.id;
    const status = event.status === 'pending' ? (event.resolved ? '已补录实扣 · 原待核对' : '待核对') :
      event.status === 'estimated' ? '规则估算' : event.confirmationFor ? '实扣补录' : '实际扣减';
    item.append(element('h3', event.date + ' · ' + event.serviceId), element('span', status, 'badge'));
    item.append(element('p', debitText(event, card.type)),
      element('p', '单次参考价 ' + wallet.money(event.referencePriceCents) + ' · 实际卡外支付 ' + wallet.money(event.extraPaidCents), 'muted'));
    if (event.note) item.append(element('p', event.note));
    if (event.image) {
      const proof = link('查看消费凭证', event.image.url);
      proof.target = '_blank';
      proof.rel = 'noopener';
      item.append(proof);
    }
    if (event.status === 'pending' && !event.resolved && !event.reversed) item.append(button('补录实际扣减', () => beginConfirmation(event)));
    return p1.decorate(item, event);
  });
  $('ledger').replaceChildren(...(rows.length ? rows : [element('p', '还没有消费记录。', 'muted')]));
}

function renderDetail(card) {
  current = card;
  $('walletTitle').textContent = card.name;
  const overview = $('cardOverview');
  overview.replaceChildren(element('span', wallet.cardLabel(card) + ' · ' + states[card.status], 'badge'),
    element('p', card.type === 'time_pass' ? '履约进度' : '账面剩余权益'),
    element('p', remainingText(card), 'metric'));
  const items = [
    ['实付', wallet.money(card.paidCents)], ['购买日', card.purchasedOn],
    ['生效日', card.activationDate ?? '待核对'], ['权益期限', deadlineText(card.deadline)],
    ['已记卡内到访', card.coveredUses + ' 次'],
  ];
  if (card.type === 'stored_value') {
    items.push(['账面剩余本金', bucket(card.remaining.principalCents, card.remaining.principalRange)],
      ['账面剩余赠送金', bucket(card.remaining.bonusCents, card.remaining.bonusRange)]);
    if (card.bonusDeadline) items.push(['赠送金期限', deadlineText(card.bonusDeadline)]);
  }
  if (card.type === 'visit_pack') items.push(['消费已扣次数', card.consumedVisits + ' 次']);
  if (card.type === 'time_pack') items.push(['累计核销时长',wallet.duration(card.consumedMinutes)]);
  if (card.rechargeCashCents) items.push(['追加实付', wallet.money(card.rechargeCashCents)]);
  if (card.refundedCashCents) items.push(['实际到账退款', wallet.money(card.refundedCashCents)]);
  overview.append(list(items));
  $('walletDetailCrumb').hidden = false;
  $('walletIntro').textContent = '查看已确认的办卡规则、账面权益与消费流水。';
  const brief = $('walletHighlights');
  brief.replaceChildren(stateBadge(card), element('p', remainingText(card), 'metric'),
    list([['主卡期限', deadlineText(card.deadline)], ...(card.bonusDeadline ? [['赠送金期限', deadlineText(card.bonusDeadline)]] : [])]));
  alerts(brief, card);
  $('goReconcile').hidden = card.type === 'time_pass';
  renderSource(card);
  p1.render(card);
  renderLedger(card);
  window.KDZWalletCharts.render(card,$('detailUsageChart'),$('detailUsageType'),window.KDZWalletDashboard.primary(card));
  $('walletDetail').hidden = false;
}

function active(id, visible) {
  const wrapper = $(id);
  wrapper.hidden = !visible;
  wrapper.querySelector('input,select').disabled = !visible;
}

function updateMode() {
  if (!current) return;
  const mode = $('usageMode').value;
  const type = current.type;
  const actual = mode === 'actual';
  active('debitAmountField', actual && type === 'stored_value');
  active('debitPrincipalField', actual && type === 'stored_value');
  active('debitVisitsField', actual && type === 'visit_pack');
  active('debitMinutesField', actual && type === 'time_pack');
  $('debitMinutes').required = type === 'time_pack' && actual;
  $('debitMinutes').step = current.initial.billingMinutes ?? '1';
  active('usageCoveredField', actual && ['visit_pack','time_pass'].includes(type));
  $('usageMode').querySelector('[value=estimate]').disabled = type === 'time_pack';
  $('usageCovered').required = actual && type === 'time_pass';
  $('usageHint').textContent = mode === 'pending' ? '保留消费记录，补录实扣后才会更新余额或次数。' :
    mode === 'estimate' ? '用已确认的规则推算扣减。遇到未知规则时，可改录实扣或保存待核对。' :
    type === 'stored_value' ? '只知道扣减总额时可留空本金，卡包会显示分账可能区间。' : '';
}

function resetUsage() {
  $('usageForm').reset();
  pendingId = null;
  $('usageHeading').textContent = '记录本次消费';
  const closed = current.archived || ['closed','expired'].includes(current.status) || current.remaining.visits === 0 || current.remaining.totalCents === 0 || current.remaining.minutes === 0;
  $('usageHeading').textContent = closed ? '补录历史消费' : '记录本次消费';
  $('usageDate').value = closed ? '' : $('usageDate').max;
  $('debitVisits').value = '1';
  $('usageDate').readOnly = $('usageService').readOnly = $('usageReference').readOnly = false;
  $('usageMode').disabled = false;
  $('usageCancel').hidden = true;
  updateMode();
}

function beginConfirmation(event) {
  if (busy) return;
  resetUsage();
  pendingId = event.id;
  $('usageHeading').textContent = '核对已有消费';
  $('usageDate').value = event.date;
  $('usageService').value = event.serviceId;
  $('usageReference').value = wallet.yuan(event.referencePriceCents);
  $('usageExtra').value = wallet.yuan(event.extraPaidCents);
  $('usageDate').readOnly = $('usageService').readOnly = $('usageReference').readOnly = true;
  $('usageMode').value = 'actual';
  $('usageMode').disabled = true;
  $('usageCancel').hidden = false;
  $('usageStatus').textContent = '';
  updateMode();
  showUsage();
  $('debitAmount').disabled ? $('usageNote').focus() : $('debitAmount').focus();
}

async function submit(usePending) {
  if (busy || !current || (!usePending && !$('usageForm').reportValidity())) return;
  busy = true;
  $('usageSubmit').disabled = $('usageRetry').disabled = $('closeUsage').disabled = true;
  $('usageStatus').dataset.state = 'loading';
  $('usageStatus').textContent = '正在保存流水…';
  const key = 'consume:' + cardId;
  try {
    const data = usePending ? undefined : {
      pendingId, mode: $('usageMode').value, date: $('usageDate').value, serviceId: $('usageService').value,
      referencePrice: $('usageReference').value, extraPaid: $('usageExtra').value, note: $('usageNote').value,
      debitAmount: $('debitAmount').value, debitPrincipal: $('debitPrincipal').value,
      debitVisits: $('debitVisits').value, debitMinutes: $('debitMinutes').value, covered: $('usageCovered').value,
    };
    const result = await wallet.write('/api/wallet/cards/' + encodeURIComponent(cardId) + '/consume', key, data);
    renderDetail(result.card);
    resetUsage();
    $('usageStatus').dataset.state = 'success';
    $('usageStatus').textContent = result.replayed ? '已恢复上次提交结果，流水未重复扣减。' : '消费记录已保存。';
  } catch (error) {
    $('usageStatus').dataset.state = 'error';
    $('usageStatus').textContent = error.message;
  } finally {
    busy = false;
    $('usageSubmit').disabled = $('usageRetry').disabled = $('closeUsage').disabled = false;
    $('usageRetry').hidden = !wallet.hasPending(key);
  }
}

for (const [index,tab] of detailTabs.entries()) {
  tab.addEventListener('click',() => showDetailTab(tab.id.slice('detail-tab-'.length)));
  tab.addEventListener('keydown',event => {
    const offsets = {ArrowLeft:-1,ArrowRight:1};
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? detailTabs.length - 1 :
      Object.hasOwn(offsets,event.key) ? (index + offsets[event.key] + detailTabs.length) % detailTabs.length : null;
    if (next === null) return;
    event.preventDefault();
    showDetailTab(detailTabs[next].id.slice('detail-tab-'.length),true);
  });
}
$('openUsage').addEventListener('click',showUsage);
$('walletDetail').addEventListener('click',event => {
  if (!event.target.closest('a[href="#usagePanel"]')) return;
  event.preventDefault();
  showUsage();
});
$('closeUsage').addEventListener('click',() => $('usagePanel').close());
$('usagePanel').addEventListener('cancel',event => { if (busy) event.preventDefault(); });
window.addEventListener('hashchange',() => { if (current) showDetailAnchor(); });
$('goReconcile').addEventListener('click', () => {
  showDetailTab('fulfillment');
  $('advancedType').value = 'reconciliation';
  $('advancedType').dispatchEvent(new Event('change'));
  $('advancedPanel').scrollIntoView({block:'start'});
});
$('usageMode').addEventListener('change', updateMode);
$('usageForm').addEventListener('submit', event => { event.preventDefault(); submit(false); });
$('usageCancel').addEventListener('click', resetUsage);
$('usageRetry').addEventListener('click', () => submit(true));

(async () => {
  try {
    if (!cardId) {
      await window.KDZWalletDashboard.init();
      return;
    }
    const { card, today } = await wallet.request('/api/wallet/cards/' + encodeURIComponent(cardId));
    $('usageDate').min = card.purchasedOn;
    $('usageDate').max = today;
    renderDetail(card);
    resetUsage();
    $('usageRetry').hidden = !wallet.hasPending('consume:' + cardId);
    setStatus('success', '截至 ' + today + ' · 数据保存在本机');
    showDetailAnchor();
  } catch (error) {
    setStatus('error', '无法读取卡包 · ' + error.message);
  }
})();
