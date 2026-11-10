'use strict';

function createWalletP1({ updateCard, wallet, cardId, reveal }) {
  const $ = id => document.getElementById(id);
  const eventNames = {
    recharge: '追加充值或次数', refund: '退款记录', reconciliation: '商家余额对账', adjustment: '余额校正',
    reversal: '撤销错误记录', profile_update: '补充卡片信息', promise: '补录办卡前约定', evidence: '凭证记录', fulfillment_review: '扣费差异核对',
  };
  const categories = { purchase: '支付凭证', statement: '消费或余额账单', terms: '原始套餐条款', other: '其他材料' };
  const statuses = { matched: '账面一致', needs_review: '差异待核对', split_review: '分账待确认',
    adjusted: '已校正', stale: '账面已变动，需重新对账' };
  const legalUrl = 'https://www.court.gov.cn/zixun/xiangqing/459321.html';
  let card, target = null, busy = false;
  const form = $('advancedForm');
  const select = $('advancedType');

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function action(text, run) {
    const button = node('button', text, 'secondary');
    button.type = 'button';
    button.addEventListener('click', run);
    return button;
  }

  const money = value => wallet.money(value);
  const signed = (value, monetary, duration = false) => (value < 0 ? '−' : value > 0 ? '+' : '') +
    (monetary ? money(Math.abs(value)) : duration ? wallet.duration(Math.abs(value)) : Math.abs(value) + ' 次');
  const balance = (value) => card.type === 'stored_value' ? money(value.totalCents) : card.type === 'time_pack' ? wallet.duration(value.minutes) : value.visits + ' 次';

  function field(id, text, type, { value = '', required = false, items = [], step = '.01' } = {}) {
    const label = node('label', text);
    const input = node(type === 'select' ? 'select' : 'input');
    input.id = id;
    if (type !== 'select') input.type = type;
    else items.forEach(([key, title]) => input.add(new Option(title, key)));
    if (type === 'number') Object.assign(input, { min: 0, step });
    if (type === 'file') input.accept = 'image/png,image/jpeg';
    input.required = required;
    input.value = value;
    label.append(input);
    $('advancedFields').append(label);
  }

  function choices(preferred) {
    const options = [
      ...(card.type === 'time_pass' ? [] : ['reconciliation']),
      ...(['time_pass','time_pack'].includes(card.type) || card.closedAt ? [] : ['recharge']),
      'refund',
      ...(card.type === 'stored_value' ? ['promise'] : []),
      'evidence',
    ];
    if (target && ['adjustment', 'reversal', 'fulfillment_review'].includes(preferred)) options.push(preferred);
    select.replaceChildren(...options.map(value => new Option(eventNames[value], value)));
    if (options.includes(preferred)) select.value = preferred;
  }

  function renderFields() {
    const type = select.value;
    $('advancedFields').replaceChildren();
    $('advancedConfirm').checked = false;
    $('advancedConfirm').required = ['adjustment', 'reversal', 'promise', 'recharge', 'fulfillment_review'].includes(type);
    $('advancedConfirmLabel').hidden = !$('advancedConfirm').required;
    $('advancedNote').required = ['adjustment', 'reversal', 'promise', 'fulfillment_review'].includes(type);
    $('advancedConfirmText').textContent = ({
      recharge: '我已核对追加权益沿用原卡的规则、比例和期限',
      adjustment: '我确认按这条商家记录校正账面',
      reversal: '我确认撤销这条记录',
      fulfillment_review: '我已核实这笔差异并记录结果',
      promise: '这段原文来自办卡前的约定并适用于这张卡',
    })[type] ?? '';
    const stored = card.type === 'stored_value';
    const visits = card.type === 'visit_pack';
    const today = wallet.today();
    const date = () => field('advDate', '实际交易日', 'date', { value: today, required: true });
    if (type === 'reconciliation') {
      if (stored) {
        field('advTotal', '商家当前显示总额（元）', 'number', { required: true });
        field('advPrincipal', '其中本金（可选）', 'number');
      } else if (card.type === 'time_pack') field('advMinutes', '商家当前剩余分钟', 'number', {required:true,step:'1'});
      else field('advVisits', '商家当前剩余次数', 'number', { required: true, step: '1' });
    } else if (type === 'recharge') {
      date();
      field('advCash', '本次实付（元）', 'number', { required: true });
      if (stored) {
        field('advPrincipal', '增加本金（元）', 'number', { required: true });
        field('advBonus', '增加赠送金（元，无则填 0）', 'number', { value: '0', required: true });
      } else field('advVisits', '增加次数', 'number', { required: true, step: '1' });
    } else if (type === 'refund') {
      date();
      field('advCash', '实际到账退款（元）', 'number', { required: true });
      if (stored) {
        field('advTotal', '实际收回的卡内权益总额（元）', 'number', { required: true });
        field('advPrincipal', '其中本金（可选）', 'number');
      }
      if (card.type === 'time_pack') field('advMinutes', '实际收回分钟（无则填 0）', 'number', {required:true,step:'1'});
      if (visits) field('advVisits', '实际收回次数', 'number', { required: true, step: '1' });
      field('advTerminates', '卡片状态', 'select', { value: 'no', items: [['no', '保留卡片'], ['yes', '商家已终止权益']] });
    } else if (type === 'promise') {
      field('advQuote', '原文（例如 洗护每次扣减80元）', 'text', { required: true });
    } else if (type === 'evidence') {
      field('advCategory', '凭证类别', 'select', { value: 'purchase', items: Object.entries(categories) });
      field('advProof', '图片（PNG/JPEG，3 MB 以内）', 'file');
      field('advLinked', '关联流水（可选）', 'select', { value: '',
        items: [['', '整张卡'], ...card.events.filter(event => ['consume', 'consume_confirmation', 'reconciliation'].includes(event.type))
          .map(event => [event.id, event.date + ' · ' + (event.serviceId ?? '余额对账')])] });
    }
    $('advancedHint').textContent = ({
      reconciliation: '按当前账面比较。保存商家显示值后，可另行确认校正。',
      adjustment: target ? '确认将这条对账记录应用到账面。填写依据后保存。' : '',
      reversal: target ? '会新增一条撤销记录，原记录保留。填写撤销原因后保存。' : '',
      promise: '适用明确到项目和金额的固定扣费。备注写明合同、海报或商家答复来源。',
      fulfillment_review: '填写商家答复或核对结果。实扣和历史流水照常保留。',
      evidence: '图片和文字来源保存在本机，可关联到具体流水。',
    })[type] ?? '';
  }

  function begin(type, event) {
    if (busy) return;
    reveal();
    form.reset();
    target = event;
    choices(type);
    renderFields();
    $('advancedStatus').textContent = '';
    $('advancedPanel').scrollIntoView({ block: 'start' });
  }

  function readDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('读取凭证失败。'));
      reader.readAsDataURL(blob);
    });
  }

  async function payload() {
    const value = id => $(id)?.value;
    const type = select.value;
    const data = {
      type, note: value('advancedNote'), date: value('advDate'), cash: value('advCash'),
      sameTerms: $('advancedConfirm').checked, confirmed: $('advancedConfirm').checked,
      creditPrincipal: value('advPrincipal'), creditBonus: value('advBonus'), creditVisits: value('advVisits'),
      debitAmount: value('advTotal'), debitPrincipal: value('advPrincipal'), debitVisits: value('advVisits'),
      observedTotal: value('advTotal'), observedPrincipal: value('advPrincipal'), observedVisits: value('advVisits'),
      debitMinutes: value('advMinutes'), observedMinutes: value('advMinutes'),
      reconciliationId: target?.id, targetId: target?.id, terminates: value('advTerminates') === 'yes',
      quote: value('advQuote'), category: value('advCategory'), linkedId: value('advLinked'),
    };
    const image = $('advProof')?.files?.[0];
    if (image) {
      if (image.size > 3 * 1024 * 1024) throw new Error('凭证图片须在 3 MB 以内。');
      data.proof = { name: image.name, base64: (await readDataUrl(image)).split(',')[1] };
    }
    return data;
  }

  async function submit(retry) {
    if (!card || busy || (!retry && !form.reportValidity())) return;
    busy = true;
    $('advancedSubmit').disabled = $('advancedRetry').disabled = true;
    $('advancedStatus').dataset.state = 'loading';
    const key = 'event:' + cardId;
    $('advancedStatus').textContent = '正在保存流水…';
    try {
      const result = await wallet.write('/api/wallet/cards/' + encodeURIComponent(cardId) + '/events', key,
        retry ? undefined : await payload());
      target = null;
      form.reset();
      updateCard(result.card);
      $('advancedStatus').dataset.state = 'success';
      $('advancedStatus').textContent = result.replayed ? '已恢复上次提交，流水没有重复新增。' : '已保存流水。';
    } catch (error) {
      $('advancedStatus').dataset.state = 'error';
      $('advancedStatus').textContent = error.message;
    } finally {
      busy = false;
      $('advancedSubmit').disabled = $('advancedRetry').disabled = false;
      $('advancedRetry').hidden = !wallet.hasPending(key);
    }
  }

  function proofLink(image) {
    const link = node('a', '打开本机原图 · ' + image.name);
    link.href = image.url;
    link.target = '_blank';
    link.rel = 'noopener';
    return link;
  }

  function decorate(item, event) {
    if (event.reversed) item.append(node('p', '已撤销 · 原记录保留', 'badge'));
    if (event.canReverse) item.append(action('撤销这条记录', () => begin('reversal', event)));
    return item;
  }

  function eventRow(event) {
    const item = node('article', undefined, 'term');
    item.append(node('h3', event.date + ' · ' + (eventNames[event.type] ?? '流水')));
    if (event.type === 'reconciliation') {
      item.append(node('span', statuses[event.reconciliationStatus], 'badge'),
        node('p', '账面 ' + balance(event.expected) + ' · 商家 ' + balance(event.observed) +
          ' · 差额 ' + signed(event.difference, card.type === 'stored_value', card.type === 'time_pack')));
      if (event.splitChanged) {
        item.append(node('p', '商家显示本金 ' + money(event.observed.principalCents) +
          (event.splitConflict ? ' · 超出原账面区间' : ' · 可确认分账')));
      }
      event.reasons.forEach(reason => item.append(node('p', reason, 'muted')));
      if (['needs_review', 'split_review'].includes(event.reconciliationStatus)) {
        const supplement = node('a', '补录遗漏消费');
        supplement.href = '#usagePanel';
        item.append(action('确认余额校正', () => begin('adjustment', event)), document.createTextNode(' '), supplement);
      }
    } else if (event.type === 'adjustment') {
      item.append(node('p', '原账面 ' + balance(event.before) + ' · 校正后 ' + balance(event.observed)),
        node('small', '对账记录 ' + event.reconciliationId));
    } else if (event.type === 'recharge') {
      item.append(node('p', '实付 ' + money(event.cashCents) + ' · 新增权益 ' + balance(event.credit)));
    } else if (event.type === 'refund') {
      const removed = card.type === 'time_pass' ? '' : ' · 收回权益 ' + balance(event.debit);
      item.append(node('p', '到账 ' + money(event.cashCents) + removed + (event.terminates ? ' · 权益终止' : '')));
    } else if (event.type === 'promise') {
      item.append(node('p', event.quote));
    } else if (event.type === 'evidence') {
      item.append(node('p', categories[event.category]));
      if (event.image) item.append(proofLink(event.image));
      if (event.linkedId) item.append(node('p', '关联流水 ' + event.linkedId, 'muted'));
    } else if (event.type === 'archive') {
      item.append(node('p', event.archived ? '卡片已归档' : '卡片已取消归档'));
    } else if (event.type === 'reversal') {
      item.append(node('p', '被撤销的记录 ' + event.targetId, 'muted'));
    } else if (event.type === 'profile_update') {
      item.append(node('p', '已补充生效日、有效期或扣减顺序', 'muted'));
    }
    if (event.note) item.append(node('p', event.note));
    return decorate(item, event);
  }

  function message() {
    const difference = card.fulfillment.checks.find(check => check.status === 'difference' && !check.reviewId);
    const type = $('merchantPurpose').value;
    const remaining = card.type === 'time_pass' ? '目前的权益期限' : '账面剩余 ' + balance(card.remaining);
    if (type === 'refund') {
      return '您好，我在' + card.purchasedOn + '办理了' + card.name + '，开卡实付' + money(card.paidCents) +
        '。麻烦提供已使用项目、计价与余额明细，并告知可申请退款的条件、扣除项目和处理时间，谢谢。';
    }
    if (type === 'extension') {
      return '您好，我想核对' + card.name + '的有效期' + (card.deadline.endDate ? '（记录为' + card.deadline.endDate + '）' : '') +
        '以及' + remaining + '。请问可以申请延期吗？需要满足什么条件、如何办理，谢谢。';
    }
    if (difference) return difference.question;
    const reconciliation = card.events.find(event => event.type === 'reconciliation' && event.reconciliationStatus === 'needs_review');
    if (reconciliation) return '您好，' + card.name + '的本机账面为' + balance(reconciliation.expected) +
      '，商家显示为' + balance(reconciliation.observed) + '。请提供截至' + reconciliation.date + '的扣减、退款和余额明细，方便核对，谢谢。';
    return '您好，我想核对' + card.name + '的消费流水。麻烦提供各笔日期、服务、卡内扣减和实际余额明细，谢谢。';
  }

  function renderFulfillment() {
    const checks = card.fulfillment.checks.map(check => {
      const item = node('article', undefined, 'term');
      item.id = 'check-' + check.eventId;
      item.append(node('h3', check.date + ' · ' + check.serviceId));
      item.append(node('p', check.status === 'needs_context' ? '待核对 · ' + check.reason :
        (check.status === 'matched' ? '扣费一致' : check.reviewId ? '差异已核对' : '扣费差异待核对') + ' · 约定 ' + money(check.promisedCents) +
          ' · 实扣 ' + money(check.actualCents) + ' · 差额 ' + signed(check.differenceCents, true)));
      for (const term of check.terms) {
        item.append(node('p', term.origin + ' · ' + term.quote + (term.note ? ' · ' + term.note : ''), 'muted'));
        const evidence = term.evidence.find(entry => entry.imageId);
        if (evidence && card.source.groupId) {
          const original = node('a', '定位固定扣费原文');
          original.href = 'extract.html?group=' + encodeURIComponent(card.source.groupId) + '&field=fixedDebit';
          item.append(original);
        }
      }
      if (check.reviewId) item.append(node('p', '核对结果 · ' + check.reviewNote));
      else if (check.status === 'difference') item.append(action('记录核对结果', () => begin('fulfillment_review', {id:check.eventId})));
      return item;
    });
    if (card.type === 'stored_value' && card.fulfillment.unverifiedCount) {
      checks.push(node('p', card.fulfillment.unverifiedCount + ' 笔实扣缺少可匹配的固定扣费原文。', 'muted'));
    }
    if (!checks.length) checks.push(node('p', '暂无可比较的固定扣费和实扣记录。', 'muted'));
    $('fulfillmentChecks').replaceChildren(...checks);
    $('merchantCopyText').value = message();
  }

  async function download() {
    if (!card) return;
    $('exportEvidence').disabled = true;
    $('evidenceStatus').textContent = '正在整理证据…';
    const snapshot = card;
    try {
      const attachments = [];
      for (const item of snapshot.events.filter(event => event.image && !event.reversed)) {
        const response = await fetch(item.image.url);
        if (!response.ok) throw new Error('无法读取凭证原图：' + item.image.name);
        attachments.push({ ...item.image, eventId: item.id, dataUrl: await readDataUrl(await response.blob()) });
      }
      const data = { schemaVersion: 1, exportedAt: new Date().toISOString(), card: snapshot, attachments, legalReference: legalUrl };
      const link = node('a');
      link.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      link.download = 'Vericard-消费证据.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      $('evidenceStatus').textContent = '已导出证据包。';
    } catch (error) {
      $('evidenceStatus').textContent = error.message;
    } finally {
      $('exportEvidence').disabled = false;
    }
  }

  select.addEventListener('change', () => { target = null; renderFields(); });
  form.addEventListener('submit', event => { event.preventDefault(); submit(false); });
  $('advancedRetry').addEventListener('click', () => submit(true));
  $('merchantPurpose').addEventListener('change', () => { if (card) $('merchantCopyText').value = message(); });
  $('exportEvidence').addEventListener('click', download);
  $('copyMerchant').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('merchantCopyText').value);
      $('evidenceStatus').textContent = '话术已复制。';
    } catch {
      $('merchantCopyText').focus();
      $('merchantCopyText').select();
      $('evidenceStatus').textContent = '话术已选中，可手动复制。';
    }
  });

  return {
    render(next) {
      card = next;
      choices(select.value);
      renderFields();
      renderFulfillment();
      $('advancedRetry').hidden = !wallet.hasPending('event:' + cardId);
    },
    eventRow, decorate,
  };
}
