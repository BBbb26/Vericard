'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const { request, money, today } = window.KDZWallet;
  const Compare = window.KDZCompare;
  const storageKey = 'kdz-agent-analysis';
  const questionsKey = 'kdz-agent-questions';
  const planIds = {
    serviceId: 'agentService', referencePrice: 'agentPrice', startDate: 'agentStart',
    activationDate: 'agentActivation', extraFees: 'agentFees',
  };
  const summaryFields = {
    planType: '卡型', price: '截图报价（元）', total: '权益数量', principal: '充值本金（元）',
    bonus: '赠送金额（元）', coverage: '适用范围',
  };
  let current;
  let comparison;
  let previewVisits;
  let previewDays;
  let chat = [];
  let pendingQuestion = '';
  let busy = false;
  let uploadController;

  function node(tag, label, className) {
    const element = document.createElement(tag);
    if (label !== undefined) element.textContent = label;
    if (className) element.className = className;
    return element;
  }

  function action(label, handler, className = 'secondary') {
    const button = node('button', label, className);
    button.type = 'button';
    button.addEventListener('click', handler);
    return button;
  }

  function link(label, href, className) {
    const anchor = node('a', label, className);
    anchor.href = href;
    return anchor;
  }

  function setStatus(message, tone = 'success') {
    const status = $('agentStatus');
    status.dataset.state = tone;
    status.textContent = message;
  }

  function endpoint(id) {
    return '/api/agent/sessions/' + encodeURIComponent(id);
  }

  function remember(id) {
    try { if (id) sessionStorage.setItem(storageKey, id); else sessionStorage.removeItem(storageKey); } catch {}
    const url = new URL(location.href);
    if (id) url.searchParams.set('analysisId', id); else url.searchParams.delete('analysisId');
    history.replaceState(null, '', url);
  }

  function initialId() {
    const queryId = new URLSearchParams(location.search).get('analysisId');
    try { return queryId || sessionStorage.getItem(storageKey); } catch { return queryId; }
  }

  function restoreChat(id) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(questionsKey));
      if (saved?.id === id && Array.isArray(saved.chat)) return saved.chat.slice(-12);
    } catch {}
    return [];
  }

  function revealLatestMessage() {
    $('conversation').lastElementChild?.scrollIntoView({ block: 'nearest' });
  }

  async function recordQuestion(question, useDeepSeek, opening = false) {
    if (!question) return;
    const previousPlan = comparison ? chat.findLast(turn => turn.plan)?.plan : null;
    const newPlan = comparison ? Compare.parseVisitPlan(question, previousPlan ?? {}) : null;
    if (opening && comparison && !newPlan) {
      chat = [{ question, opening }, ...chat.filter(turn => !turn.opening)].slice(0, 12);
      saveChat();
      return;
    }
    let selection = { provider: 'local', topics: null };
    if (useDeepSeek && current?.review) {
      pendingQuestion = question;
      render();
      revealLatestMessage();
      try {
        selection = await request(endpoint(current.analysisId) + '/ask', {
          question, useDeepSeek: true, history: chat.slice(-3).map(turn => turn.question),
        });
      } catch {
        selection = { provider: 'fallback', topics: null };
      } finally {
        pendingQuestion = '';
      }
    }
    if (newPlan) applyPlanPreview(newPlan);
    const answer = answerQuestion(question, selection.topics ?? [], newPlan ?? previousPlan, Boolean(newPlan));
    chat = [...chat, { question, answer, provider: selection.provider, opening, ...(newPlan ? { plan: newPlan } : {}) }].slice(-12);
    saveChat();
  }

  function saveChat() {
    if (current) {
      try { sessionStorage.setItem(questionsKey, JSON.stringify({ id: current.analysisId, chat })); } catch {}
    }
  }

  function takeModelChoice() {
    const input = $('agentDeepSeek');
    const enabled = !input.disabled && input.checked;
    input.checked = false;
    return enabled;
  }

  function fieldText(key, missing) {
    const field = current.review.fields[key];
    if (field?.policy === '需要确认') {
      const values = [...new Set(field.candidates.map(item => item.value))];
      return values.length ? '截图中有不同口径：' + values.join('、') + '。' : '截图中的条款有冲突，仍待核对。';
    }
    if (!field?.value) return missing;
    const prefix = field.policy === '已确认' ? '已确认：' : '截图提取，待核对：';
    return prefix + field.value + '。';
  }

  function answerQuestion(question, topics, plan, updatedPlan) {
    if (comparison) return answerComparison(question, topics, plan, updatedPlan);
    if (!current?.review) return '请先上传你要分析的套餐截图。商品页、有效期和使用须知可以一起上传，我会结合原文回答。';
    const { review, result, questions } = current;
    const parts = [];
    if (topics.includes('refund') || /退[款费钱卡]|能[不否]能退|能退|可退|退吗|退么/.test(question)) {
      const refund = review.fields.refund;
      const evidence = [...new Set(refund?.candidates.map(item => item.quote).filter(Boolean))].slice(0, 3);
      parts.push(evidence.length
        ? '截图里的退款原文：' + evidence.join(' / ') + '。能否退款及具体金额仍待核实。'
        : '截图没有可用的退款条款，能否退款及金额待商家确认。');
    }
    if (topics.includes('validity') || /有效期|到期|过期|多久|核销期限|核销截止/.test(question)) {
      const dates = review.timeline;
      const first = dates?.firstRedemptionDays ? '购买后 ' + dates.firstRedemptionDays + ' 天内' : '资料未提供';
      const expiry = dates?.expiryDate ?? (dates?.expiryDays ? '核销后 ' + dates.expiryDays + ' 天' : '资料未提供');
      const conflicting = (review.conflicts ?? []).some(key => ['purchaseDays', 'fixedStart', 'fixedEnd', 'expiryDays', 'validityMode'].includes(key));
      parts.push(conflicting
        ? '截图里的期限口径有冲突。可以展开「条款原文」核对，先不要按单一日期安排。'
        : '截图候选期限。首次核销截止为' + first + '，核销后的权益期限为' + expiry + '。');
    }
    if (topics.includes('price') || /多少[钱元]|价[格钱]|报价|售价/.test(question)) parts.push(fieldText('price', '截图暂未识别到可用报价。'));
    if (topics.includes('coverage') || /适用|覆盖|门店|通用|哪些项目|哪里.{0,3}用/.test(question)) {
      parts.push(fieldText('coverage', '截图暂未识别到明确的适用范围。'));
    }
    if (topics.includes('conflicts') || /冲突|矛盾|确认什么|还缺什么/.test(question)) {
      const labels = (review.conflicts ?? []).map(key => review.fields[key]?.label).filter(Boolean);
      if (labels.length) parts.push('需要核对的冲突项有 ' + labels.join('、') + '。');
      if (questions.length) parts.push('当前待回答：' + questions.map(item => item.title).join('、') + '。');
      if (!labels.length && !questions.length) parts.push('这份分析当前没有待回答的问题。可展开原文核对条款。');
    }
    if (topics.includes('value') || /划算|值不值|值得|便宜|省钱|试算|买不买/.test(question)) {
      const base = result?.analysis?.scenarios.find(item => item.input.id === 'base')?.result;
      const branches = (result?.ranges ?? []).flatMap(range => range.branches)
        .map(branch => ({ label: branch.label, cash: branch.outcomes.find(item => item.id === 'base')?.cash }))
        .filter(branch => branch.cash != null);
      if (base?.cash.totalCents != null && base.payAsYouGoCents != null) {
        parts.push('按当前计划，预付方案 ' + money(base.cash.totalCents) + '，按次购买 ' + money(base.payAsYouGoCents) +
          (base.status === 'conditional' ? '。这是条件试算。' : '。'));
      } else if (branches.length) {
        const comparison = branches.map(branch => branch.label + ' ' + money(branch.cash)).join('；');
        parts.push('按当前计划的条件试算：' + comparison +
          (base?.payAsYouGoCents != null ? '。按次基准 ' + money(base.payAsYouGoCents) : '') + '。');
      } else {
        parts.push('目前缺少可比较的条件。填写单次参考价和计划次数，再查看现有追问。');
      }
    }
    return parts.length ? parts.join('\n') : '我可以根据这次分析回答报价、期限、适用范围、退款条款和试算问题。可以问「这张卡什么时候到期」或「按现在的计划划算吗」。';
  }

  function answerBubble({ answer, provider }) {
    const reply = node('div', undefined, 'agent-reply agent-chat-answer');
    const heading = node('div', undefined, 'agent-reply-heading');
    heading.append(node('span', 'Vericard', 'agent-speaker'));
    const caption = { deepseek: 'DeepSeek 理解问题', fallback: '已回退到本地回答', local: '本地回答' };
    heading.append(node('span', caption[provider] ?? caption.local, 'agent-source-tag'));
    reply.append(heading, node('p', answer));
    return reply;
  }

  function renderChat(conversation) {
    for (const turn of chat) {
      if (!turn.opening) conversation.append(node('p', turn.question, 'agent-user'), answerBubble(turn));
    }
    if (pendingQuestion) {
      const reply = node('div', undefined, 'agent-reply agent-chat-answer');
      const status = node('p', '正在理解你的问题…', 'state-line');
      status.dataset.state = 'loading';
      reply.append(status);
      conversation.append(node('p', pendingQuestion, 'agent-user'), reply);
    }
  }

  function renderBadges() {
    const recognized = $('agentRecognized');
    const pending = $('agentPending');
    const count = comparison ? comparison.offers.flatMap(packageConflicts).length : (current?.questions.length ?? 0);
    recognized.hidden = !comparison && !current?.review?.type;
    recognized.querySelector('span').textContent = current?.source === 'demo' ? '次卡示例' :
      '已识别 ' + (comparison?.offers.length ?? 1) + ' 个套餐';
    pending.hidden = count === 0;
    pending.querySelector('span').textContent = comparison ? count + ' 项条款待核对' : count + ' 个待确认问题';
    $('agentBadges').hidden = recognized.hidden && pending.hidden;
  }

  function renderAttachments() {
    const list = $('agentAttachments');
    const files = [...$('agentFiles').files];
    const entries = files.map((file, index) => {
      const item = node('li');
      const remove = action('×', () => {
        const remaining = new DataTransfer();
        files.forEach((entry, i) => { if (i !== index) remaining.items.add(entry); });
        $('agentFiles').files = remaining.files;
        renderAttachments();
        const buttons = list.querySelectorAll('button');
        (buttons[Math.min(index, buttons.length - 1)] ?? $('agentChoose')).focus();
      }, 'ghost');
      remove.setAttribute('aria-label', '移除截图 ' + file.name);
      const preview = node('img');
      preview.alt = '';
      const url = URL.createObjectURL(file);
      const release = () => URL.revokeObjectURL(url);
      preview.onload = release;
      preview.onerror = () => { preview.hidden = true; release(); };
      preview.src = url;
      item.append(preview, node('span', file.name), remove);
      return item;
    });
    list.replaceChildren(...entries);
    list.hidden = entries.length === 0;
    $('agentUpload').querySelector('span').textContent = current && !files.length ? '发送问题' : '开始分析';
  }

  function collectPlan() {
    const inputs = Object.fromEntries(Object.entries(planIds).map(([key, id]) => [key, $(id).value]));
    return { ...inputs, scenarios: { base: { count: $('agentCount').value, everyDays: $('agentGap').value } } };
  }

  function fillPlan(input) {
    for (const [key, id] of Object.entries(planIds)) $(id).value = input?.[key] ?? (key === 'startDate' ? today() : '');
    $('agentCount').value = input?.scenarios?.base?.count ?? 6;
    $('agentGap').value = input?.scenarios?.base?.everyDays ?? 7;
  }

  function card(parent, heading, className = '') {
    const panel = node('section', undefined, 'agent-card ' + className);
    panel.append(node('h2', heading));
    parent.append(panel);
    return panel;
  }

  function facts(parent, items) {
    const dl = node('dl', undefined, 'agent-facts');
    for (const [key, value] of items) {
      const item = node('div');
      item.append(node('dt', key), node('dd', value));
      dl.append(item);
    }
    parent.append(dl);
  }

  function renderEvidence(parent, session) {
    const review = session.review;
    const shown = Object.entries(review.fields).filter(([, field]) => field.candidates.length && field.policy !== '不适用');
    if (!shown.length) return;
    const details = node('details', undefined, 'agent-card agent-evidence');
    details.id = 'evidence';
    details.open = location.hash === '#evidence';
    details.append(node('summary', '查看条款原文和字段状态'));
    const terms = node('ul');
    for (const [key, field] of shown) {
      const row = node('li');
      row.append(node('strong', field.label), node('p', field.policy + (field.value ? ' · ' + field.value : ''), 'muted'));
      const seen = new Set();
      for (const item of field.candidates.slice(0, 5)) {
        if (seen.has(item.value)) continue;
        seen.add(item.value);
        const image = session.images.find(image => image.id === item.imageId);
        row.append(node('p', item.quote));
        if (image) row.append(link('查看截图 · ' + image.name, image.url));
        if (session.source === 'agent' && field.policy !== '已确认' && !['actualPrice', 'refund'].includes(key)) {
          row.append(action('确认此条款 · ' + item.value, () => {
            const accepted = window.confirm('确认这条内容适用于当前套餐？\n' + item.quote);
            if (accepted) update({ confirm: { field: key, value: item.value } });
          }));
        }
      }
      terms.append(row);
    }
    details.append(terms);
    parent.append(details);
  }

  function renderCostBars(panel, base, ranges) {
    const entries = [];
    if (base.cash.totalCents != null) entries.push(['预付方案', base.cash.totalCents]);
    else for (const range of ranges) {
      for (const branch of range.branches) {
        const cash = branch.outcomes.find(item => item.id === 'base')?.cash;
        if (cash != null) entries.push([branch.label, cash]);
      }
    }
    if (base.payAsYouGoCents != null) entries.push(['按次基准', base.payAsYouGoCents]);
    if (entries.length < 2) {
      for (const [label, value] of entries) panel.append(node('p', label + ' ' + money(value)));
      return;
    }
    const chart = node('ul', undefined, 'agent-cost-bars');
    chart.setAttribute('aria-label', '正常情景支出对比');
    const ceiling = Math.max(1, ...entries.map(([, value]) => value));
    for (const [label, value] of entries) {
      const row = node('li');
      const line = node('div', undefined, 'agent-cost-line');
      line.append(node('span', label), node('strong', money(value)));
      const track = node('div', undefined, 'agent-cost-track');
      track.setAttribute('aria-hidden', 'true');
      const fill = node('span');
      fill.style.width = (value / ceiling * 100) + '%';
      track.append(fill);
      row.append(line, track);
      chart.append(row);
    }
    panel.append(chart);
  }


  const termLabels = {
    purchase: '购买后有效期', duration: '使用期限', weekday: '周一至周五', weekend: '周六、周日',
    daily: '每天最长使用', reserve: '预约要求', refund: '退款口径', fee: '退款手续费',
  };

  function packageConflicts(offer) {
    return Object.keys(termLabels).filter(key => (offer.evidence[key]?.length ?? 0) > 1)
      .map(key => ({ key, offer, entries: offer.evidence[key] }));
  }

  function term(offer, key, unknown = '未识别') {
    const values = (offer.evidence[key] ?? []).map(item => item.value);
    if (values.length > 1) return values.join(' / ') + '（待核对）';
    return values[0] ?? unknown;
  }

  function benefits(offer) {
    if (offer.type === 'visits' && offer.units) return offer.units + ' 次';
    if (offer.type === 'single') return '1 次';
    if (offer.type === 'period' && offer.duration) {
      return (offer.evidence.duration?.some(item => /连续/.test(item.quote)) ? '连续 ' : '') + offer.duration + ' 天';
    }
    return Compare.labels[offer.type] ?? '未识别';
  }

  function comparisonIntro() {
    const visits = comparison.offers.find(offer => offer.type === 'visits');
    const period = comparison.offers.find(offer => offer.type === 'period');
    const split = visits && period
      ? visits.shortName + '可分次使用，' + period.shortName + '按期限使用。'
      : '可以先对照每个套餐的权益和适用条件。';
    const weekdayDiffers = new Set(comparison.offers.map(offer => term(offer, 'weekday', '')).filter(Boolean)).size > 1;
    return '这批截图可分成 ' + comparison.offers.length + ' 个套餐。' + split +
      (weekdayDiffers ? '工作日可用时段也不同。先确认你通常几点去，再看实际到访成本。' : '再按你的实际用量看成本。');
  }

  function comparisonHref() {
    return '/comparison.html?' + new URLSearchParams({ analysisId: current.analysisId });
  }

  function renderPackageCards(parent) {
    const cards = node('div', undefined, 'agent-package-grid');
    for (const offer of comparison.offers) {
      const tile = node('article', undefined, 'agent-package');
      tile.append(node('h3', offer.shortName), node('p', offer.price === null ? '价格待确认' : money(offer.price), 'agent-package-price'));
      if (offer.detail) tile.append(node('p', offer.detail, 'muted'));
      let metric = benefits(offer);
      if (offer.price !== null && offer.type === 'visits' && offer.units) {
        metric = money(Math.round(offer.price / offer.units)) + '/次 · 按 ' + offer.units + ' 次用满';
      }
      if (offer.price !== null && offer.type === 'period' && offer.duration) {
        metric = money(Math.round(offer.price / offer.duration)) + '/天 · 按 ' + offer.duration + ' 天每天使用';
      }
      tile.append(node('p', metric, 'agent-package-metric'));
      cards.append(tile);
    }
    parent.append(cards);
  }

  function renderTermTable(parent) {
    const frame = node('div', undefined, 'agent-compare-table-frame');
    frame.tabIndex = 0;
    const table = node('table', undefined, 'agent-compare-table');
    table.setAttribute('aria-label', '套餐条款对照');
    const head = table.createTHead().insertRow();
    for (const title of ['对比项', ...comparison.offers.map(offer => offer.shortName)]) {
      const cell = node('th', title);
      cell.scope = 'col';
      head.append(cell);
    }
    const rows = table.createTBody();
    const fields = [['使用额度', benefits], ...['purchase', 'weekday', 'weekend', 'daily', 'reserve'].map(key =>
      [termLabels[key], offer => term(offer, key)])];
    for (const [label, format] of fields) {
      const row = rows.insertRow();
      const cell = node('th', label);
      cell.scope = 'row';
      row.append(cell, ...comparison.offers.map(offer => node('td', format(offer))));
    }
    frame.append(table);
    parent.append(frame);
  }

  function scenarioSummary(visits, horizon = comparison.horizon) {
    const rows = comparison.offers.map(offer => ({ offer, row: Compare.onePackPreview(offer, visits, horizon) }));
    const complete = rows.filter(item => item.row?.missing === 0).sort((a, b) => a.row.paid - b.row.paid);
    const short = rows.filter(item => item.row?.missing > 0).map(({ offer, row }) => offer.shortName + '还差 ' + row.missing + ' 天');
    let recommendation = '';
    if (complete.length > 1 && complete[0].row.paid < complete[1].row.paid) {
      recommendation = '如果都能在适用时段内用完这 ' + visits + ' 天，' + complete[0].offer.shortName + '的试算支出更低。';
    } else if (complete.length === 1 && short.length) {
      recommendation = complete[0].offer.shortName + '的额度可覆盖计划。' + short.join('，') + '，还需核实补买费用。';
    } else if (short.length) {
      recommendation = short.join('，') + '。';
    }
    return { rows, complete, recommendation };
  }

  function answerPlan(plan) {
    if (plan?.conflicting) return '你提到的用量有不同口径。请确认每周几次、持续几周，或者直接告诉我总共去几次。';
    if (!plan?.visits) {
      if (plan?.frequency) return '已按每周 ' + plan.frequency + ' 次记录。你准备持续几周？';
      if (plan?.weeks) return '已按连续 ' + plan.weeks + ' 周记录。你每周准备去几次？';
      return '你每周计划去几次、持续几周？也可以直接告诉我总次数，我会按你的用量比较。';
    }
    const { visits, weeks, frequency, days } = plan;
    if (days && visits > days) return '这段计划有 ' + visits + ' 次到访、' + days + ' 天。请确认是否同一天会去多次，再核对卡券的扣次方式。';
    const planned = frequency && weeks
      ? '每周 ' + frequency + ' 次，连续 ' + weeks + ' 周，共 ' + visits + ' 次。'
      : '按你计划的 ' + visits + ' 次比较。';
    const { rows, complete, recommendation } = scenarioSummary(visits, days ?? comparison.horizon);
    const notes = rows.filter(({ offer, row }) => !row && offer.type === 'period' && days && offer.duration && days > offer.duration)
      .map(({ offer }) => offer.shortName + '的 ' + offer.duration + ' 天使用期限无法覆盖连续 ' + weeks + ' 周。');
    const known = complete.slice(0, 2);
    const [first, second] = known;
    if (first && second && first.row.paid < second.row.paid) {
      const rest = first.offer.type === 'visits' && first.offer.units > visits
        ? '，还余 ' + (first.offer.units - visits) + ' 次' : '';
      return planned + ' 如果到访日期和时段都符合条款，建议选 ' + money(first.row.paid) + ' 的' + first.offer.shortName +
        '，可覆盖 ' + visits + ' 次' + rest + '，比' + second.offer.shortName + '（' + money(second.row.paid) +
        '）少付 ' + money(second.row.paid - first.row.paid) + '。' + notes.join('');
    }
    const details = rows.filter(({ row }) => row).map(({ offer, row }) =>
      offer.shortName + '付 ' + money(row.paid) + '，可覆盖 ' + row.covered + '/' + visits + ' 次。');
    return [planned, ...details, recommendation, ...notes].filter(Boolean).join(' ');
  }

  function applyPlanPreview(plan) {
    if (!plan?.visits || plan.visits > comparison.maximum ||
        (plan.days && plan.visits > plan.days) || (comparison.horizon && plan.days > comparison.horizon)) return;
    previewVisits = plan.visits;
    previewDays = plan.days ?? null;
  }

  function renderComparisonPreview(parent) {
    const horizonDays = previewDays ?? comparison.horizon;
    const sample = scenarioSummary(previewVisits, horizonDays);
    if (sample.rows.filter(item => item.row).length < 2) return;
    parent.append(node('h2', '实际使用成本'));
    const preview = node('section', undefined, 'agent-compare-preview');
    const caption = node('label');
    caption.htmlFor = 'agentCompareVisits';
    const slider = node('input');
    Object.assign(slider, { type: 'range', id: 'agentCompareVisits', min: '1', max: String(Math.min(comparison.maximum, horizonDays ?? comparison.maximum)), step: '1', value: String(previewVisits) });
    const grid = node('div', undefined, 'agent-preview-grid');
    const note = node('p', undefined, 'agent-compare-note');
    const refresh = () => {
      const count = Number(slider.value);
      previewVisits = count;
      const horizon = horizonDays ? horizonDays + ' 天内' : '';
      caption.textContent = '假设' + horizon + '到访 ' + count + ' 天';
      const { rows, recommendation } = scenarioSummary(count, horizonDays);
      grid.replaceChildren(...rows.map(({ offer, row }) => {
        const item = node('div');
        item.append(node('p', offer.shortName, 'muted'));
        if (!row) item.append(node('strong', '条件不足'));
        else {
          item.append(node('strong', money(row.perVisit) + '/到访日'),
            node('p', '付 ' + money(row.paid) + ' · 可覆盖 ' + row.covered + '/' + count + ' 天', 'muted'));
          if (row.missing) item.append(node('p', '另有 ' + row.missing + ' 天未覆盖', 'agent-cost-gap'));
        }
        return item;
      }));
      note.textContent = recommendation || '具体能否覆盖，要按你的到访日期与时段核对。';
    };
    slider.addEventListener('input', refresh);
    refresh();
    preview.append(caption, slider, grid,
      node('p', '按每个到访日使用一次、各买一份且符合条款试算。未覆盖的天数不计入单价，补买费用也未计。', 'muted'), note);
    parent.append(preview);
  }

  function renderComparisonRisks(parent) {
    const issues = comparison.offers.flatMap(packageConflicts);
    const fees = comparison.offers.filter(offer => offer.evidence.fee?.length === 1)
      .map(offer => ({ offer, key: 'fee', entries: offer.evidence.fee }));
    if (!issues.length && !fees.length) return;
    parent.append(node('h2', '买前需要确认的条款'));
    for (const { offer, key, entries } of [...issues, ...fees]) {
      const item = node('article', undefined, 'agent-compare-risk');
      item.append(node('h3', offer.shortName + ' · ' + termLabels[key]));
      const explanation = {
        purchase: '截图写了不同的购买后有效期，请确认最晚何时开卡。套餐的使用期限另见上表。',
        reserve: '有的页面写免预约，有的要求提前预约。请确认是否每次到店都需要预约。',
        refund: '截图对使用后能否退款的说明有出入，请确认核销后可退多少、如何扣费。',
        fee: '截图提到部分退款可能产生手续费，请确认适用条件和扣费基数。',
      };
      item.append(node('p', explanation[key] ?? '截图有不同口径，请按原文核对。'));
      for (const entry of entries) {
        const image = current.images.find(file => file.id === entry.imageId);
        const row = node('p', '「' + entry.quote + '」 ', 'agent-compare-quote');
        if (image) row.append(link('看原图', image.url));
        item.append(row);
      }
      parent.append(item);
    }
  }

  function answerComparison(question, topics, plan, updatedPlan) {
    const lines = [];
    if (updatedPlan || topics.includes('value') || /划算|值得|更省|买哪个|选哪个|怎么选|哪[个款].{0,6}合适/.test(question)) {
      lines.push(answerPlan(plan));
    }
    const collect = format => lines.push(...comparison.offers.map(offer => offer.shortName + ' · ' + format(offer)));
    if (topics.includes('refund') || /退款|能退|可退/.test(question)) {
      collect(offer => term(offer, 'refund', '退款口径待确认') + '。' + term(offer, 'fee', ''));
    }
    if (topics.includes('validity') || /有效期|过期|到期/.test(question)) {
      collect(offer => '购买后有效期 ' + term(offer, 'purchase') + '，使用期限 ' + term(offer, 'duration') + '。');
    }
    if (topics.includes('coverage') || /白天|晚上|周末|时段/.test(question)) {
      collect(offer => '工作日 ' + term(offer, 'weekday') + '，周末 ' + term(offer, 'weekend') + '。');
    }
    if (topics.includes('price') || /多少[钱元]|报价|价格/.test(question)) {
      collect(offer => offer.price === null ? '价格待确认。' : money(offer.price) + '。');
    }
    if (topics.includes('conflicts') || /冲突|矛盾|还缺什么/.test(question)) {
      const issues = comparison.offers.flatMap(packageConflicts);
      lines.push(issues.length ? '待核对的条款包括 ' +
        issues.map(({ offer, key }) => offer.shortName + '的' + termLabels[key]).join('、') + '。' : '当前截图未发现明确的条款冲突。');
    }
    return lines.length ? lines.join('\n') : comparisonIntro();
  }

  async function loadComparison(session) {
    if (session.source !== 'agent' || !session.review || session.images.length < 2) return;
    try {
      const { images } = await request(endpoint(session.analysisId) + '/comparison');
      const byId = new Map(images.map(image => [image.id, image]));
      const ordered = session.images.map(image => byId.get(image.id)).filter(Boolean);
      const grouped = Compare.groupPackages(ordered);
      if (grouped.groups.length < 2) return;
      const offers = grouped.groups.map((images, index) => {
        const offer = Compare.packageSummary(images);
        return { ...offer, shortName: offer.shortName || '方案 ' + (index + 1) };
      });
      const horizon = Math.min(60, ...offers.filter(offer => offer.type === 'period' && offer.duration).map(offer => offer.duration));
      const hasHorizon = offers.some(offer => offer.type === 'period' && offer.duration);
      const maximum = hasHorizon ? horizon : Math.min(60, Math.max(15, ...offers.map(offer => offer.units ?? 0)));
      comparison = { offers, horizon: hasHorizon ? horizon : null, maximum, ...grouped };
      previewVisits = Math.max(1, Math.round(maximum * .4));
      previewDays = null;
      let recoveredPlan;
      let changed = false;
      chat = chat.map(turn => {
        if (turn.plan) {
          recoveredPlan = turn.plan;
          return turn;
        }
        const plan = Compare.parseVisitPlan(turn.question, recoveredPlan ?? {});
        if (!plan) return turn;
        recoveredPlan = plan;
        changed = true;
        return { ...turn, plan, answer: answerComparison(turn.question, [], plan, true) };
      });
      if (changed) saveChat();
      applyPlanPreview(recoveredPlan);
    } catch {
      // The original single-package view is still available if supporting evidence cannot load.
    }
  }

  function renderComparison(parent) {
    parent.classList.add('agent-comparison');
    parent.append(node('p', comparisonIntro(), 'agent-compare-lead'), node('h2', '套餐对比'));
    renderPackageCards(parent);
    renderTermTable(parent);
    if (comparison.inferred || comparison.unmatched.length) {
      const parts = [];
      if (comparison.inferred) parts.push(comparison.inferred + ' 张条款页按上传顺序暂归入相邻套餐');
      if (comparison.unmatched.length) parts.push(comparison.unmatched.length + ' 张截图暂未分组');
      parent.append(node('p', parts.join('，') + '，请在对比面板核对。', 'muted'));
    }
    renderComparisonPreview(parent);
    renderComparisonRisks(parent);
    parent.append(node('h2', '怎么选'));
    const schedules = comparison.offers.filter(offer => offer.evidence.weekday?.length === 1)
      .sort((a, b) => term(a, 'weekday').localeCompare(term(b, 'weekday')));
    if (schedules.length === 2 && term(schedules[0], 'weekday').slice(0, 5) < term(schedules[1], 'weekday').slice(0, 5)) {
      const earlier = schedules[0];
      const later = schedules[1];
      parent.append(node('p', '需要在工作日较早到店，可以先看' + earlier.shortName + '。' +
        later.shortName + '工作日从 ' + term(later, 'weekday').slice(0, 5) + ' 开始可用。两种套餐都符合时段时，再按预计到访天数比较。'));
    } else {
      parent.append(node('p', '先确认每份套餐能覆盖你的到访日期、时段和次数，再比较所需支出。'));
    }
    parent.append(node('p', '你计划一周去几天，通常是工作日白天还是晚上？', 'agent-compare-followup'));
    const links = node('div', undefined, 'agent-actions');
    links.append(link('进入多套餐对比', comparisonHref(), 'button'),
      action('继续提问', () => $('agentPrompt').focus()));
    parent.append(links);
  }

  function render() {
    const conversation = $('conversation');
    conversation.replaceChildren();
    conversation.hidden = !current && !chat.length;
    $('agentTitle').textContent = conversation.hidden ? '今天想比较什么？' : '套餐对话';
    $('agentMain').classList.toggle('has-chat', !conversation.hidden);
    const composer = $('agentForm');
    if (conversation.hidden && conversation.previousElementSibling !== composer) conversation.before(composer);
    if (!conversation.hidden && conversation.nextElementSibling !== composer) conversation.after(composer);
    $('agentReset').hidden = !current && !chat.length;
    $('agentRetry').hidden = !current?.error;
    $('agentRecalculate').hidden = !current?.result;
    $('agentPlan').hidden = Boolean(comparison);
    $('agentDemo').hidden = !conversation.hidden;
    renderBadges();
    renderAttachments();
    if (!current) {
      renderChat(conversation);
      return;
    }
    const reply = node('div', undefined, 'agent-reply');
    reply.append(node('span', 'Vericard', 'agent-speaker'));
    conversation.append(reply);
    const userMessage = current.source === 'demo' ? '体验次卡示例' : '已上传 ' + current.images.length + ' 张截图';
    const opening = chat.find(turn => turn.opening);
    const uploadBubble = node('div', undefined, 'agent-user');
    uploadBubble.append(node('p', userMessage));
    if (comparison) {
      const thumbs = node('div', undefined, 'agent-compare-thumbnails');
      for (const [index, image] of current.images.entries()) {
        const anchor = link(undefined, image.url);
        const preview = node('img');
        preview.src = image.url;
        preview.alt = '上传截图 ' + (index + 1);
        preview.loading = 'lazy';
        anchor.append(preview);
        thumbs.append(anchor);
      }
      uploadBubble.prepend(thumbs);
    }
    if (opening) {
      uploadBubble.append(node('p', opening.question));
      if (!comparison || opening.plan) reply.replaceChildren(answerBubble(opening));
    }
    conversation.prepend(uploadBubble);
    if (comparison) {
      $('agentRecalculate').hidden = true;
      renderComparison(reply);
      renderChat(conversation);
      return;
    }
    if (current.error) reply.append(node('p', '识别没有完成：' + current.error));
    const review = current.review;
    if (review) {
      const summary = card(reply, review.name, 'agent-summary');
      const list = Object.entries(summaryFields).flatMap(([key, label]) => {
        const field = review.fields[key];
        if (!field || field.policy === '不适用' || (!field.value && !field.candidates.length)) return [];
        return [[label, field.value ? field.value + (field.policy === '已提取' ? ' · 待确认' : '') : '存在冲突']];
      });
      const dates = review.timeline;
      if (dates?.firstRedemptionDays) list.push(['首次核销截止', '购买后 ' + dates.firstRedemptionDays + ' 天内']);
      if (dates?.expiryDate || dates?.expiryDays) {
        list.push(['权益到期', dates.expiryDate ?? '核销后 ' + dates.expiryDays + ' 天']);
      }
      facts(summary, list.length ? list : [['套餐字段', '当前资料未提供可用字段']]);
      if (review.unsupportedType) {
        summary.append(node('p', review.unsupportedType), link('打开多套餐比较', '/comparison.html'));
      }
      if (review.conflicts?.length) {
        const conflicts = node('details', undefined, 'agent-card agent-evidence');
        conflicts.append(node('summary', '查看 ' + review.conflicts.length + ' 项条款冲突'));
        reply.append(conflicts);
        for (const key of review.conflicts) {
          const field = review.fields[key];
          const title = node('h3', field.label);
          conflicts.append(title);
          for (const item of field.candidates.slice(0, 4)) {
            const image = current.images.find(image => image.id === item.imageId);
            conflicts.append(node('p', item.quote));
            if (image) conflicts.append(link('查看这张截图', image.url, 'agent-conflict-link'));
          }
        }
      }

    }
    for (const question of current.questions) {
      const panel = card(reply, question.title);
      const choices = node('div', undefined, 'agent-actions');
      for (const branch of question.branches) {
        choices.append(action(branch.label, () => update({ answer: { key: question.key, label: branch.label } })));
      }
      if (['referencePriceCents', 'activationDate', 'extraFeesCents'].includes(question.key)) {
        choices.append(action('填写使用计划', () => { $('agentPlan').open = true; $('agentService').focus(); }));
      }
      choices.append(action('暂不清楚', () => update({ skip: question.key })));
      panel.append(choices);
    }
    for (const answer of Object.values(current.answers)) reply.append(node('p', answer.label, 'agent-user'));
    if (current.skipped.length) reply.append(node('p', '暂不清楚，先看可试算结果。', 'agent-user'));
    const result = current.result;
    const base = result?.analysis?.scenarios.find(item => item.input.id === 'base')?.result;
    if (base) {
      const panel = card(reply, '正常情景试算', 'agent-result');
      if (base.cash.totalCents == null) panel.append(node('p', result.ranges?.length
        ? '先看不同条款口径下的支出。' : '条件未齐，请核对条款或补充使用计划。'));
      renderCostBars(panel, base, result.ranges ?? []);
      panel.append(node('p', '退款金额待核实。', 'muted'));
      if (result.assumptions?.length) {
        const assumptions = node('details');
        const list = node('ul');
        result.assumptions.forEach(value => list.append(node('li', value)));
        assumptions.append(node('summary', '查看试算前提'), list);
        panel.append(assumptions);
      }
    }
    if (review) renderEvidence(reply, current);
    const steps = [...current.steps, ...(result?.steps ?? [])];
    if (steps.length) {
      const detail = node('details', undefined, 'agent-card');
      const list = node('ol');
      steps.forEach(step => list.append(node('li', step.result)));
      detail.append(node('summary', '查看分析步骤'), list);
      reply.append(detail);
    }
    const links = node('div', undefined, 'agent-actions');
    if (result) links.append(link('进入消费看板', '/decision.html?' + new URLSearchParams({ analysisId: current.analysisId }), 'button'));
    if (current.cardId) links.append(link('查看已登记卡片', '/wallet.html?card=' + encodeURIComponent(current.cardId), 'button secondary'));
    if (current.source === 'agent' && review) {
      links.append(link('进入多套餐对比', '/comparison.html?' + new URLSearchParams({ analysisId: current.analysisId }), 'button secondary'));
    }
    if (result) links.append(action('继续提问', () => $('agentPrompt').focus()));
    if (links.childNodes.length) reply.append(links);
    renderChat(conversation);
  }

  async function apply(session, question, useDeepSeek) {
    const isNewAnalysis = current?.analysisId !== session.analysisId;
    const needsComparison = isNewAnalysis || current?.error;
    if (isNewAnalysis) chat = restoreChat(session.analysisId);
    current = session;
    if (needsComparison) {
      comparison = undefined;
      await loadComparison(session);
    }
    remember(session.analysisId);
    fillPlan(session.input);
    await recordQuestion(question, useDeepSeek, isNewAnalysis && session.source === 'agent');
    render();
    if (question) revealLatestMessage();
    if (session.error) setStatus(session.error, 'error');
  }

  function lockComposer(locked) {
    $('agentComposer').inert = locked;
    $('agentForm').querySelector('.agent-tools').inert = locked;
    $('conversation').inert = locked;
  }

  async function run(message, operation, question = '', useDeepSeek = false) {
    if (busy) return;
    busy = true;
    lockComposer(true);
    setStatus(message, 'loading');
    try {
      await apply(await operation(), question, useDeepSeek);
      if (!current.error) setStatus('');
    } catch (error) {
      setStatus(error.name === 'AbortError' ? '已停止等待。可用已选截图再次分析。' : error.message,
        error.name === 'AbortError' ? 'warning' : 'error');
      if (error.status === 409 && current) {
        try { await apply(await request(endpoint(current.analysisId))); } catch {}
      }
    } finally {
      busy = false;
      lockComposer(false);
    }
  }

  function update(changes) {
    if (!current) return;
    run('正在更新分析…', () => request('/api/agent/decision', {
      analysisId: current.analysisId, revision: current.revision, changes,
    }));
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(Error('无法读取截图 ' + file.name));
      reader.readAsDataURL(file);
    });
  }

  $('agentCancel').addEventListener('click', () => uploadController?.abort());
  $('agentChoose').addEventListener('click', () => $('agentFiles').click());
  $('agentFiles').addEventListener('change', renderAttachments);
  $('agentPrompt').addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    $('agentForm').requestSubmit();
  });

  $('agentForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    const files = [...$('agentFiles').files];
    const question = $('agentPrompt').value.trim();
    if (!files.length) {
      if (!question) {
        setStatus('上传套餐截图，或输入一个问题。', 'warning');
        $('agentPrompt').focus();
        return;
      }
      const useDeepSeek = takeModelChoice();
      $('agentPrompt').value = '';
      setStatus('');
      busy = true;
      lockComposer(true);
      try {
        await recordQuestion(question, useDeepSeek);
        render();
        revealLatestMessage();
      } finally {
        busy = false;
        lockComposer(false);
      }
      return;
    }
    if (files.length > 8 || files.some(file => file.size > 12 * 1024 * 1024)) {
      setStatus('请选择 1–8 张截图，每张不超过 12 MB。', 'error');
      return;
    }
    if (!$('agentForm').reportValidity()) return;
    const firstQuestion = question || (!current ? chat.at(-1)?.question : '');
    const input = collectPlan();
    const useDeepSeek = takeModelChoice();
    uploadController = new AbortController();
    $('agentCancel').hidden = false;
    try {
      await run('正在读取截图…', async () => {
        const { signal } = uploadController;
        const ids = new Set();
        for (const [index, file] of files.entries()) {
          setStatus('正在上传截图 ' + (index + 1) + ' / ' + files.length + '…', 'loading');
          const image = await request('/api/upload', { name: file.name, base64: await readFile(file) }, signal);
          ids.add(image.id);
        }
        setStatus('正在识别截图、整理套餐和检查条款…', 'loading');
        const session = await request('/api/agent/sessions', { imageIds: [...ids], input, useDeepSeek }, signal);
        $('agentCancel').hidden = true;
        if (!session.error) {
          $('agentFiles').value = '';
          $('agentPrompt').value = '';
          $('agentPlan').open = false;
        }
        return session;
      }, firstQuestion, useDeepSeek);
    } finally {
      $('agentCancel').hidden = true;
      uploadController = undefined;
    }
  });
  $('agentDemo').addEventListener('click', () => run('正在读取示例…', () => request('/api/agent/sessions', { demoId: 'visits' })));
  $('agentRetry').addEventListener('click', () => {
    const useDeepSeek = takeModelChoice();
    run('正在重试识别…', () => request(endpoint(current.analysisId) + '/retry', { useDeepSeek }));
  });
  $('agentRecalculate').addEventListener('click', () => {
    if ($('agentForm').reportValidity()) update({ input: collectPlan() });
  });
  $('agentReset').addEventListener('click', () => {
    current = undefined;
    comparison = undefined;
    chat = [];
    try { sessionStorage.removeItem(questionsKey); } catch {}
    remember(null);
    fillPlan();
    $('agentFiles').value = '';
    $('agentPrompt').value = '';
    $('agentPlan').open = false;
    render();
    setStatus('');
    $('agentPrompt').focus();
  });
  request('/api/agent/capabilities').then(({ deepseek }) => {
    if (!deepseek) return;
    $('agentDeepSeek').disabled = false;
    $('agentModelLabel').textContent = '本次使用 DeepSeek · 发送脱敏文字';
  }).catch(() => {});
  fillPlan();
  const id = initialId();
  if (id) run('正在恢复本次分析…', async () => {
    try { return await request(endpoint(id)); }
    catch (error) { if (error.status === 404) remember(null); throw error; }
  });
})();
