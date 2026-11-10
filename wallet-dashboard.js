'use strict';

window.KDZWalletDashboard = (() => {
  const W = window.KDZWallet;
  const $ = id => document.getElementById(id);
  const selectionKey = 'kdz-wallet-selected';
  const labels = { all:'全部', held:'使用中', expiring:'临期', pending:'待核对', info:'信息待补充', ended:'已结束', archived:'已归档' };
  const dayLabels = { active:'正常使用', not_started:'尚未生效', activation_unknown:'生效日待核对', validity_unknown:'有效期待核对', expired:'已到期', closed:'权益已终止' };
  const useTypes = ['consume','consume_confirmation'];
  let cards = [], today = '', filter = 'all', selectedId = '', detail = null, listMode = false;
  let selectionRequest;
  let selectionRevision = 0, activityRevision = 0, archiveBusy = false, swipe = null, ignoreClickUntil = 0;

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function button(text, action, className = 'secondary') {
    const node = element('button',text,className);
    node.type = 'button';
    node.addEventListener('click',action);
    return node;
  }

  function link(text, href, className) {
    const node = element('a',text,className);
    node.href = href;
    return node;
  }

  function icon(name) {
    return window.KDZUI.icon(name);
  }

  function mark(name) {
    const node = element('span',undefined,'shortcut-icon');
    node.append(icon(name));
    return node;
  }

  function badge(text, tone = 'neutral') {
    const node = element('span',text,'badge');
    node.dataset.tone = tone;
    return node;
  }

  function status(message, state = 'success') {
    $('walletStatus').textContent = message;
    $('walletStatus').dataset.state = state;
  }

  function typeIcon(card) {
    return card.type === 'stored_value' ? 'wallet' : card.type === 'visit_pack' ? 'layers' : 'calendar';
  }

  function unit(card) {
    return card.offerType === 'single' ? ' 张' : ' 次';
  }

  function exhausted(card) {
    return card.remaining.totalCents === 0 || card.remaining.visits === 0 || card.remaining.minutes === 0;
  }

  function ended(card) {
    return exhausted(card) || ['expired','closed'].includes(card.status);
  }

  function pending(card) {
    return W.pendingCount(card) > 0;
  }

  function needsInfo(card) {
    return ['activation_unknown','validity_unknown'].includes(card.status) ||
      (card.type === 'stored_value' && card.remaining.principalCents === null);
  }

  function cardStatus(card) {
    if (card.archived) return '已归档';
    if (['expired','closed'].includes(card.status)) return dayLabels[card.status];
    return exhausted(card) ? '权益已用尽' : dayLabels[card.status];
  }

  function deadline(card) {
    const value = card.deadline;
    if (value?.endDate) return value.endDate;
    return value?.knownUnlimited ? '无固定截止' : '待核对';
  }

  function primary(card) {
    if (card.type === 'stored_value') {
      const value = card.remaining.totalCents;
      const initial = card.initial.principalCents + card.initial.bonusCents;
      return {label:'账面剩余储值',value:W.money(value),total:'开卡权益 ' + W.money(initial),
        ratio:initial > 0 ? Math.min(1,value / initial) : null,
        caption:value > initial ? '账面余额含开卡后的权益变化' : '以开卡权益为基准'};
    }
    if (card.type === 'visit_pack') {
      const value = card.remaining.visits;
      const initial = card.creditedVisits ?? card.initial.visits;
      return { label:card.offerType === 'single' ? '剩余券数' : '剩余次数', value:value + unit(card),
        total:'累计取得 ' + initial + unit(card), ratio:initial > 0 ? Math.min(1,value / initial) : null,
        caption:'已记录扣减 ' + card.consumedVisits + unit(card) };
    }
    if (card.type === 'time_pack') {
      return {label:'剩余时长',value:W.duration(card.remaining.minutes),total:'开卡 ' + W.duration(card.initial.minutes),
        ratio:Math.min(1,card.remaining.minutes / card.initial.minutes),caption:'已核销 ' + W.duration(card.consumedMinutes)};
    }
    const left = card.deadline?.daysLeft;
    const start = card.deadline?.startDate || card.activationDate;
    const end = card.deadline?.endDate;
    const days = start && end ? (Date.parse(end) - Date.parse(start)) / 86400000 + 1 : 0;
    const ratio = days > 0 && left !== null ? Math.min(1,Math.max(0,(left + 1) / days)) : null;
    return { label:'有效期限', value:card.status === 'closed' ? '已终止' : card.status === 'not_started' ? '尚未生效' :
      left === 0 ? '今天到期' : left < 0 ? '已到期' : left > 0 ? '还有 ' + left + ' 天' : deadline(card),
      total:end ? '截至 ' + end : '', ratio, caption:'已记录 ' + card.coveredUses + ' 次卡内到访' };
  }

  function filtered(key = filter) {
    return cards.filter(card => {
      if (key === 'archived') return card.archived;
      if (card.archived) return false;
      if (key === 'held') return !ended(card) && card.status === 'active';
      if (key === 'expiring') return !ended(card) && W.isExpiring(card);
      if (key === 'pending') return pending(card);
      if (key === 'info') return needsInfo(card);
      return key !== 'ended' || ended(card);
    });
  }

  function route(card, hash = '') {
    return 'wallet.html?card=' + encodeURIComponent(card.id) + hash;
  }

  function remember() {
    try { localStorage.setItem(selectionKey,selectedId); } catch {}
  }

  function readingSelection() {
    try { return localStorage.getItem(selectionKey); } catch { return null; }
  }

  function changeFilter(value) {
    filter = value;
    draw();
    status('截至 ' + today + ' · 数据保存在本机');
  }

  function filters() {
    const overview = $('walletStats');
    overview.replaceChildren(...[
      ['held','使用中','layers'],['expiring','临期提醒','calendar'],['pending','待核对','target'],['info','信息待补充','message'],
    ].map(([key,label,image]) => {
      const tile = button('',() => changeFilter(key),'panel wallet-stat');
      tile.dataset.filter = key;
      tile.dataset.tone = key === 'expiring' && filtered(key).length ? 'warning' : 'neutral';
      tile.setAttribute('aria-pressed',String(filter === key));
      const copy = element('span',undefined,'wallet-stat-copy');
      copy.append(element('small',label),element('strong',filtered(key).length + ' 张'));
      tile.append(mark(image),copy,icon('chevron'));
      return tile;
    }));
    $('walletFilters').replaceChildren(...Object.entries(labels).filter(([key]) => key !== 'archived' || filtered(key).length).map(([key,label]) => {
      const control = button(label + '（' + filtered(key).length + '）',() => changeFilter(key),'secondary wallet-filter');
      control.dataset.filter = key;
      control.setAttribute('aria-pressed',String(filter === key));
      return control;
    }));
  }

  function choose(id, focus) {
    if (selectedId === id) return;
    selectedId = id;
    remember();
    renderDeck(filtered(),focus,true);
    status('截至 ' + today + ' · 数据保存在本机');
    refreshSelected();
  }

  function step(delta, focus = false) {
    const visible = filtered();
    if (visible.length < 2) return;
    const index = visible.findIndex(card => card.id === selectedId);
    choose(visible[(index + delta + visible.length) % visible.length].id,focus);
  }

  function renderDeck(visible, focus = false, animate = false) {
    const deck = $('walletDeck');
    const index = visible.findIndex(card => card.id === selectedId);
    $('walletStackView').hidden = $('walletPositions').hidden = listMode;
    $('walletListPicker').hidden = !listMode;
    $('walletViewMode').setAttribute('aria-pressed',String(listMode));
    $('walletViewMode').textContent = listMode ? '卡片模式' : '列表模式';
    $('walletScrollHint').hidden = listMode || visible.length <= 5;
    $('walletPrev').disabled = $('walletNext').disabled = visible.length < 2;
    if (listMode) {
      $('walletListPicker').replaceChildren(...visible.map(card => {
        const node = button('',() => choose(card.id,true));
        node.dataset.cardId = card.id;
        node.setAttribute('aria-pressed',String(card.id === selectedId));
        node.append(element('strong',card.name),element('span',primary(card).value,'muted'));
        return node;
      }));
    } else {
      const view = index >= 0 ? primary(visible[index]) : null;
      $('walletPocketLabel').textContent = view ? view.label : '';
      $('walletPocketValue').textContent = view ? view.value : '';
      deck.dataset.count = String(Math.min(5, visible.length));
      deck.dataset.scroll = String(visible.length > 5);
      deck.closest('.wallet-deck-panel')?.classList.toggle('single-card', visible.length === 1);
      $('walletDeckCards').replaceChildren(...visible.map((_,layer) => {
        const card = visible[(index + layer) % visible.length];
        const view = primary(card);
        const face = button('',() => { if (Date.now() >= ignoreClickUntil) choose(card.id,true); },'wallet-stack-card');
        face.dataset.cardId = card.id;
        face.dataset.type = card.type;
        face.dataset.layer = String(layer);
        face.setAttribute('aria-pressed',String(layer === 0));
        face.setAttribute('aria-label',card.name + '，' + W.cardLabel(card) + '，' + view.value);
        const top = element('span',undefined,'wallet-stack-head');
        const title = element('span');
        title.append(element('strong',card.name,'wallet-stack-name'),element('span',W.cardLabel(card) + ' · ' + cardStatus(card),'wallet-stack-type'));
        top.append(icon(typeIcon(card)),title);
        const value = element('span',undefined,'wallet-stack-value');
        value.append(element('span',view.label,'wallet-stack-caption'),element('strong',view.value));
        face.append(top,value);
        return face;
      }));
      $('walletPositions').replaceChildren(...(visible.length > 8 ?
        [element('span',(index + 1) + ' / ' + visible.length,'muted')] :
        visible.map((card,i) => {
          const dot = button('',() => choose(card.id,false),'wallet-dot');
          dot.setAttribute('aria-label','第 ' + (i + 1) + ' 张 · ' + card.name);
          dot.setAttribute('aria-pressed',String(i === index));
          return dot;
        })));
    }
    if (animate && !listMode && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      deck.querySelector('[data-layer="0"]')?.animate([{translate:'0 7px'},{translate:'0 0'}],
        {duration:220,easing:'ease-out'});
    }
    if (focus) {
      const group = listMode ? $('walletListPicker') : deck;
      group.querySelector('[aria-pressed=true]')?.focus({preventScroll:true});
    }
  }

  function meter(view) {
    const track = element('div',undefined,'wallet-meter');
    const fill = element('span');
    fill.style.width = view.ratio * 100 + '%';
    track.append(fill);
    track.setAttribute('role','img');
    track.setAttribute('aria-label',view.label + '进度 ' + Math.round(view.ratio * 100) + '%');
    return track;
  }

  function assistant(card) {
    const group = element('div',undefined,'wallet-assistant');
    const title = element('strong');
    title.append(icon('spark'),document.createTextNode('权益助手'));
    group.append(title);
    const notice = card.attention?.[0];
    const message = notice ? W.attentionText(notice) :
      pending(card) ? '有消费或对账待处理，可在详情查看。' :
        needsInfo(card) ? '点击「补充信息」补全后，剩余权益和到期日会自动计算。' : '当前没有需要处理的权益事项。';
    group.append(element('p',message,'muted'));
    if (notice) group.append(link('查看' + notice.label + ' →',route(card,notice.anchor),'home-link'));
    group.append(element('small','基于本机已记录的规则和流水','muted'));
    return group;
  }

  let infoCard = null;
  function infoRow(labelText, control) {
    const label = element('label');
    label.append(element('span', labelText), control);
    return label;
  }
  function openInfo(card) {
    infoCard = card;
    const dialog = $('walletInfoDialog');
    const fields = $('walletInfoFields');
    fields.replaceChildren();
    $('walletInfoStatus').hidden = true;
    $('walletInfoStatus').textContent = '';
    $('walletInfoLead').textContent = '正在读取卡片规则…';
    dialog.showModal();
    const render = full => {
      if (!full || infoCard?.id !== card.id) return;
      const validity = full.plan?.rules?.validity;
      const deduction = full.plan?.rules?.deduction;
      const validityMissing = !validity || ['activation_unknown','validity_unknown'].includes(full.status);
      const deductionMissing = full.plan?.type === 'stored_value' && (full.remaining?.principalCents === null || !deduction);
      const notes = [];
      if (deductionMissing) notes.push('这张储值卡还没确认先扣本金还是先扣赠送金，所以剩余金额只能显示区间。');
      if (validityMissing) notes.push('这张卡还缺生效日或有效期，所以无法计算到期日。');
      $('walletInfoLead').textContent = notes.length ? notes.join('') + ' 补充后会自动重新计算。' : '这张卡的信息已经完整。';
      if (!notes.length) return;
      if (validityMissing) {
        const activation = element('input'); activation.id = 'infoActivation';
        activation.type = 'date'; activation.max = today;
        activation.value = full.purchase?.activationDate || full.purchase?.purchasedOn || today;
        fields.append(infoRow('生效日', activation));
        const select = element('select'); select.id = 'infoValidity';
        select.append(new Option('生效后固定天数','from_activation'), new Option('固定截止日','fixed'), new Option('无固定截止','unlimited'));
        select.value = ['from_activation','fixed','unlimited'].includes(validity?.kind) ? validity.kind : 'from_activation';
        fields.append(infoRow('有效期', select));
        const days = element('input'); days.id = 'infoDays';
        days.type = 'number'; days.min = '1'; days.step = '1'; days.value = validity?.days ?? ''; days.placeholder = '例如 90';
        fields.append(infoRow('生效后有效天数', days));
        const end = element('input'); end.id = 'infoEnd';
        end.type = 'date'; end.value = validity?.endDate ?? '';
        fields.append(infoRow('固定截止日', end));
        const sync = () => {
          days.parentElement.hidden = select.value !== 'from_activation';
          end.parentElement.hidden = select.value !== 'fixed';
        };
        select.addEventListener('change', sync); sync();
      }
      if (deductionMissing) {
        const select = element('select'); select.id = 'infoDeduction';
        select.append(new Option('请选择',''), new Option('先扣本金','principal_first'), new Option('先扣赠送金','bonus_first'), new Option('按初始比例扣','proportional'));
        if (['principal_first','bonus_first','proportional'].includes(deduction)) select.value = deduction;
        fields.append(infoRow('消费先扣哪一部分', select));
      }
    };
    if (detail?.id === card.id) render(detail);
    else W.request('/api/wallet/cards/' + card.id).then(({ card: full }) => { detail = full; render(full); })
      .catch(error => { $('walletInfoLead').textContent = '读取失败：' + error.message; });
  }

  function renderSelected(card) {
    const view = primary(card);
    const head = element('div',undefined,'wallet-selected-head');
    const title = element('div');
    const tags = element('div',undefined,'wallet-selected-tags');
    tags.append(badge(W.cardLabel(card)),badge(cardStatus(card),ended(card) || card.archived ? 'neutral' : card.status === 'active' ? 'success' : 'warning'));
    if (W.isExpiring(card) && !ended(card)) tags.append(badge('临期','warning'));
    title.append(element('h2',card.name),tags);
    head.append(mark(typeIcon(card)),title);
    const balance = element('div',undefined,'wallet-balance-panel');
    const value = element('div',undefined,'wallet-balance-value');
    value.append(element('strong',view.value));
    if (view.total) value.append(element('small',view.total,'muted'));
    balance.append(element('p',view.label,'muted'),value);
    if (view.ratio !== null) balance.append(meter(view));
    const meta = element('div',undefined,'wallet-selected-meta');
    for (const [image,label,text] of [['paid','实际支付',W.money(card.paidCents)],['calendar','有效期',deadline(card)]]) {
      const row = element('div');
      row.append(icon(image),element('span',label,'muted'),element('strong',text));
      meta.append(row);
    }
    if (card.type === 'stored_value' && card.events) {
      const confirmed = consumptionRows(card).filter(event => event.status === 'confirmed');
      const total = confirmed.reduce((sum,event) => sum + BigInt(event.debit?.totalCents ?? 0),0n);
      meta.append(element('div','已记录实扣 ' + W.money(total),'muted'));
    }
    const actions = element('div',undefined,'actions wallet-selected-actions');
    if (needsInfo(card)) {
      const fix = button('补充信息',() => openInfo(card),'');
      fix.id = 'walletInfoOpen';
      actions.append(fix, link('查看完整详情',route(card),'button secondary'));
    } else {
      const quick = button(card.type === 'time_pass' ? '记录到访' : '记录消费',() => openQuick(card),'');
      quick.id = 'walletQuickOpen';
      quick.disabled = card.archived || ended(card) || card.status === 'not_started';
      actions.append(quick,link('查看详情',route(card),'button secondary'));
    }
    const result = [head,balance,meta,actions,assistant(card)];
    if (card.archived || ended(card)) {
      const action = button(card.archived ? '取消归档' : '归档此卡',() => archive(card),'ghost');
      action.disabled = archiveBusy;
      result.push(action);
    }
    $('walletSelected').replaceChildren(...result);
  }

  function consumptionRows(card) {
    return (card.events ?? []).filter(event => useTypes.includes(event.type) && !event.reversed && !event.resolved);
  }

  function activityFrom(card) {
    return consumptionRows(card).sort((a,b) => b.date.localeCompare(a.date) || b.recordedAt.localeCompare(a.recordedAt))
      .slice(0,5).map(event => ({ ...event,cardName:card.name,cardType:card.type,offerType:card.offerType }));
  }

  function activityText(event) {
    if (!event.debit) return '待核对';
    if (event.cardType === 'stored_value') return '−' + W.money(event.debit.totalCents);
    if (event.cardType === 'visit_pack') return '−' + event.debit.visits + unit(event);
    if (event.cardType === 'time_pack') return '−' + W.duration(event.debit.minutes);
    return event.debit.covered ? '使用会员权益' : '未使用权益';
  }

  function activityRow(event, fullDate = false) {
    const row = link('',route({id:event.cardId},'#event-' + event.id),'wallet-recent-entry');
    const copy = element('span');
    copy.append(element('strong',event.cardName + ' · ' + event.serviceId),
      element('small',event.status === 'pending' ? '实扣待核对' : event.status === 'estimated' ? '规则估算' : '已记实扣','muted'));
    row.append(element('span',fullDate ? event.date : event.date.slice(5),'muted'),copy,element('span',activityText(event),'wallet-recent-debit'));
    return row;
  }

  function openActivity() {
    const dialog = element('dialog',undefined,'shell-dialog wallet-activity-dialog');
    dialog.setAttribute('aria-label','全部卡片消费记录');
    const head = element('div',undefined,'section-heading');
    head.append(element('h2','全部卡片消费记录'),button('关闭',() => dialog.close(),'ghost'));
    const records = element('div');
    const feedback = element('p',undefined,'state-line');
    feedback.setAttribute('role','status');
    let offset = 0;
    const more = button('加载更多',loadPage);
    async function loadPage() {
      more.disabled = true;
      feedback.textContent = '正在读取消费记录…';
      try {
        const {events,nextOffset} = await W.request('/api/wallet/activity?offset=' + offset);
        if (!dialog.open) return;
        records.append(...events.map(event => activityRow(event,true)));
        feedback.textContent = records.childElementCount ? '' : '暂无消费记录。';
        offset = nextOffset;
        more.hidden = offset === null;
        more.textContent = '加载更多';
      } catch (error) {
        feedback.textContent = '无法读取消费记录 · ' + error.message;
        more.textContent = '重试';
      } finally {
        more.disabled = false;
      }
    }
    dialog.append(head,records,feedback,more);
    dialog.addEventListener('close',() => dialog.remove(),{once:true});
    document.body.append(dialog);
    dialog.showModal();
    loadPage();
  }

  async function renderActivity() {
    const revision = ++activityRevision;
    const area = $('walletRecent');
    area.replaceChildren(element('p','正在读取最近记录…','muted'));
    try {
      const all = $('walletRecordScope').value === 'all';
      if (!all && !detail) return;
      const events = all ? (await W.request('/api/wallet/activity')).events : activityFrom(detail);
      if (revision !== activityRevision) return;
      const rows = events.map(event => activityRow(event));
      const more = all ? button('查看全部记录',openActivity,'ghost') :
        link('查看当前卡完整流水 →',route(detail,'#ledger'),'home-link');
      area.replaceChildren(...(rows.length ? rows : [element('p','暂无消费记录。','muted')]),...(more ? [more] : []));
    } catch (error) {
      if (revision === activityRevision) area.replaceChildren(element('p','无法读取最近记录 · ' + error.message,'warning'));
    }
  }

  function renderChart(card) {
    window.KDZWalletCharts.render(card, $('walletUsageChart'), $('walletUsageType'), primary(card));
  }

  async function refreshSelected() {
    const card = cards.find(item => item.id === selectedId);
    const revision = ++selectionRevision;
    detail = null;
    selectionRequest?.abort();
    if (!card) return;
    selectionRequest = new AbortController();
    renderSelected(card);
    const area = $('walletUsageChart');
    area.setAttribute('aria-busy','true');
    area.replaceChildren(element('p','正在读取使用概览…','muted'));
    $('walletUsageType').textContent = W.cardLabel(card);
    if ($('walletRecordScope').value === 'card') renderActivity();
    try {
      const response = await W.request('/api/wallet/cards/' + encodeURIComponent(card.id),undefined,selectionRequest.signal);
      if (revision !== selectionRevision) return;
      detail = response.card;
      renderSelected(detail);
      renderChart(detail);
      if ($('walletRecordScope').value === 'card') renderActivity();
    } catch (error) {
      if (revision !== selectionRevision) return;
      area.replaceChildren(element('p','暂无法读取使用概览 · ' + error.message,'warning'),button('重试',refreshSelected));
      if ($('walletRecordScope').value === 'card') $('walletRecent').replaceChildren(element('p','暂无法读取消费记录。','warning'));
    } finally {
      if (revision === selectionRevision) area.removeAttribute('aria-busy');
    }
  }

  function draw() {
    filters();
    $('emptyWallet').hidden = cards.length > 0;
    $('walletDashboard').hidden = !cards.length;
    const visible = filtered();
    $('walletMainPanels').hidden = $('walletBottomPanels').hidden = !visible.length;
    $('walletFilteredEmpty').hidden = Boolean(visible.length);
    if (!visible.length) {
      selectedId = '';
      detail = null;
      selectionRevision++;
      selectionRequest?.abort();
      return;
    }
    if (!visible.some(card => card.id === selectedId)) {
      const active = visible.filter(card => card.status === 'active' && !ended(card) && !card.archived);
      const open = visible.filter(card => !ended(card) && !card.archived);
      const order = active.length ? active : open.length ? open : visible;
      selectedId = order.slice().sort((a,b)=>(b.lastUsedOn ?? '').localeCompare(a.lastUsedOn ?? ''))[0].id;
    }
    remember();
    renderDeck(visible);
    refreshSelected();
  }

  async function load(prefer, message) {
    const data = await W.request('/api/wallet');
    cards = data.cards;
    today = data.today;
    if (prefer) selectedId = prefer;
    else if (!selectedId) {
      const remembered = cards.find(card => card.id === readingSelection());
      if (remembered && !ended(remembered) && !remembered.archived) selectedId = remembered.id;
    }
    if (filter === 'archived' && !filtered('archived').length) filter = 'all';
    $('walletList').hidden = false;
    $('walletAdd').hidden = !cards.length;
    draw();
    if ($('walletRecordScope').value === 'all' && filtered().length) renderActivity();
    status(message || '截至 ' + today + ' · 数据保存在本机');
  }

  async function archive(card) {
    if (archiveBusy) return;
    archiveBusy = true;
    const control = $('walletSelected').querySelector('.ghost');
    if (control) control.disabled = true;
    try {
      await W.write('/api/wallet/cards/' + encodeURIComponent(card.id) + '/events','archive:' + card.id,{type:'archive',archived:!card.archived});
      filter = 'all';
      await load(card.archived ? card.id : '', card.archived ? '卡片已恢复。' : '卡片已归档，可通过「已归档」查看。');
    } catch (error) { status(error.message,'error'); }
    finally {
      archiveBusy = false;
      const current = $('walletSelected').querySelector('.ghost');
      if (current) current.disabled = false;
    }
  }

  function openQuick(card) {
    const dialog = element('dialog',undefined,'shell-dialog wallet-quick-dialog');
    dialog.setAttribute('aria-label','记录消费');
    dialog.innerHTML = '<div class="section-heading"><h2>记录消费</h2><button type="button" class="ghost">关闭</button></div>' +
      '<p class="muted" data-role="card"></p><form class="wallet-dialog-form"><div class="input-grid">' +
      '<label>消费日期<input type="date" name="date" required></label>' +
      '<label>消费项目<input name="serviceId" maxlength="120" list="walletQuickServices" required></label>' +
      '<label data-type="stored_value">商家实际扣减（元）<input name="debitAmount" type="number" min="0" step=".01"></label>' +
      '<label data-type="visit_pack">本次核销次数<input name="debitVisits" type="number" min="0" step="1" value="1"></label>' +
      '<label data-type="time_pack">商家实扣时长（分钟）<input name="debitMinutes" type="number" min="0" step="1"></label>' +
      '<label data-type="time_pass">是否使用会员权益<select name="covered"><option value="yes">是</option><option value="no">否</option></select></label>' +
      '<label class="page-check wallet-form-wide"><input type="checkbox" name="pending">实扣暂不清楚，先保存待核对</label>' +
      '<label class="wallet-form-wide">消费凭证（可选）<input type="file" name="proof" accept="image/png,image/jpeg"></label></div>' +
      '<datalist id="walletQuickServices"></datalist><p class="muted" data-role="reference" hidden></p>' +
      '<div class="actions"><button type="submit">保存消费</button><button type="button" class="secondary" data-role="retry" hidden>重试上次提交</button></div>' +
      '<p class="state-line" role="status" aria-live="polite" hidden></p></form>';
    dialog.querySelector('[data-role=card]').textContent = card.name + ' · ' + primary(card).value;
    const form = dialog.querySelector('form'), fields = form.elements;
    const feedback = dialog.querySelector('[role=status]');
    const retry = form.querySelector('[data-role=retry]'), close = dialog.querySelector('.ghost');
    const operation = 'consume:' + card.id;
    const promises = card.fulfillment?.promises ?? [];
    const recent = (card.events ?? []).filter(event => !event.reversed).map(event => event.serviceId);
    const names = [...new Set([...promises.map(item => item.serviceId), ...recent].filter(Boolean))].slice(0,12);
    const datalist = form.querySelector('datalist');
    for (const name of names) datalist.append(new Option(name));
    const reference = form.querySelector('[data-role=reference]');
    const serviceKey = value => value.normalize('NFKC').replace(/\s+/g,'').toLowerCase();
    fields.serviceId.addEventListener('input',() => {
      const amounts = new Set(promises.filter(item => serviceKey(item.serviceId) === serviceKey(fields.serviceId.value)).map(item => item.promisedCents));
      reference.hidden = !amounts.size;
      reference.textContent = amounts.size === 1 ? '条款参考 ' + W.money([...amounts][0]) + ' · 请填写商家实扣。' : '该项目有不同约定金额，需核对原文。';
    });
    let busy = false;
    fields.date.value = fields.date.max = today;
    fields.date.min = card.purchasedOn;
    if (card.initial.billingMinutes) fields.debitMinutes.step = card.initial.billingMinutes;
    if (card.offerType === 'single') fields.debitVisits.parentElement.firstChild.textContent = '本次核销券数';
    function update() {
      for (const label of form.querySelectorAll('[data-type]')) {
        label.hidden = label.dataset.type !== card.type || fields.pending.checked;
        const control = label.querySelector('input,select');
        control.disabled = label.hidden;
        control.required = !label.hidden;
      }
    }
    function report(message, tone) {
      feedback.textContent = message;
      feedback.dataset.state = tone;
      feedback.hidden = false;
    }
    async function save(replay) {
      if (busy || (!replay && !form.reportValidity())) return;
      busy = true;
      form.querySelector('.input-grid').inert = true;
      close.disabled = retry.disabled = form.querySelector('[type=submit]').disabled = true;
      report('正在保存消费…','loading');
      try {
        const file = fields.proof.files[0];
        const data = replay ? undefined : {
          mode:fields.pending.checked ? 'pending' : 'actual',date:fields.date.value,serviceId:fields.serviceId.value,
          ...(!fields.pending.checked ? {debitAmount:fields.debitAmount.value,debitVisits:fields.debitVisits.value,debitMinutes:fields.debitMinutes.value,covered:fields.covered.value} : {}),
          ...(file ? {proof:{name:file.name,base64:await W.fileData(file,3)}} : {}),
        };
        const result = await W.write('/api/wallet/cards/' + encodeURIComponent(card.id) + '/consume',operation,data);
        const next = result.card;
        const savedEvent = next.events.find(event => event.id === result.eventId);
        const message = savedEvent?.status === 'pending' ? '已保存待核对记录，账面权益未扣减。' : '消费已保存 · ' + primary(next).label + ' ' + primary(next).value;
        dialog.close();
        try { await load(card.id,message); }
        catch (error) { status('消费已保存，列表刷新失败 · ' + error.message,'warning'); }
      } catch (error) { report(error.message,'error'); }
      finally {
        busy = false;
        form.querySelector('.input-grid').inert = false;
        close.disabled = retry.disabled = form.querySelector('[type=submit]').disabled = false;
        retry.hidden = !W.hasPending(operation);
      }
    }
    fields.pending.addEventListener('change',update);
    form.addEventListener('submit',event => { event.preventDefault(); save(false); });
    retry.addEventListener('click',() => save(true));
    close.addEventListener('click',() => dialog.close());
    dialog.addEventListener('cancel',event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close',() => dialog.remove(),{once:true});
    retry.hidden = !W.hasPending(operation);
    update();
    document.body.append(dialog);
    dialog.showModal();
  }

  function init() {
    const add = () => {
      let done = false;
      try {
        const draft = JSON.parse(sessionStorage.getItem('kdz-comparison-1'));
        done = Boolean(draft?.confirmed && draft.hasResult && draft.offers?.length >= 2);
      } catch {}
      const link = $('walletFromComparison');
      link.href = done ? 'comparison.html#resultSection' : 'comparison.html#uploadHeading';
      link.textContent = done ? '从已完成比较添加' : '打开方案比较';
      $('walletAddHint').textContent = done ? '回到结果后，在实际买到的方案旁选择「我已购买」。' : '当前标签页暂无已完成比较，也可以直接手动登记。';
      $('walletAddDialog').showModal();
    };
    $('walletAdd').addEventListener('click',add);
    $('walletEmptyAdd').addEventListener('click',add);
    $('walletManualAdd').addEventListener('click',() => {
      $('walletAddDialog').close();
      window.KDZWalletEnroll.open({onSaved:id => {
        filter = 'all';
        load(id,'卡片已加入卡包。').catch(error => status('卡片已保存，列表刷新失败 · ' + error.message,'warning'));
      }});
    });
    $('walletPrev').addEventListener('click',() => step(-1));
    $('walletNext').addEventListener('click',() => step(1));
    $('walletViewMode').addEventListener('click',() => { listMode = !listMode; renderDeck(filtered()); });
    $('walletRecordScope').addEventListener('change',renderActivity);
    $('walletDeck').addEventListener('keydown',event => {
      if (!['ArrowLeft','ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      step(event.key === 'ArrowLeft' ? -1 : 1,true);
    });
    $('walletDeck').addEventListener('pointerdown',event => {
      if (event.pointerType === 'touch') swipe = {x:event.clientX,y:event.clientY};
    });
    $('walletDeck').addEventListener('pointerup',event => {
      if (!swipe) return;
      const dx = event.clientX - swipe.x, dy = event.clientY - swipe.y;
      swipe = null;
      if (Math.abs(dx) > 36 && Math.abs(dx) > Math.abs(dy) * 1.3) {
        ignoreClickUntil = Date.now() + 350;
        step(dx < 0 ? 1 : -1);
      }
    });
    $('walletDeck').addEventListener('pointercancel',() => { swipe = null; });
    $('walletInfoCancel').addEventListener('click',() => $('walletInfoDialog').close());
    $('walletInfoDialog').addEventListener('close',() => { infoCard = null; });
    $('walletInfoSave').addEventListener('click', async () => {
      if (!infoCard) return;
      const status = $('walletInfoStatus');
      const report = (message,state='error') => { status.textContent = message; status.dataset.state = state; status.hidden = false; };
      const activation = $('infoActivation'), validity = $('infoValidity');
      const days = $('infoDays'), end = $('infoEnd'), deduction = $('infoDeduction');
      const data = {};
      if (validity) {
        if (!activation?.value) return report('请填写生效日。');
        const kind = validity.value;
        data.activationDate = activation.value;
        data.validity = { kind };
        if (kind === 'from_activation') {
          const count = Number(days?.value);
          if (!Number.isInteger(count) || count < 1) return report('请填写有效天数。');
          data.validity.days = String(count);
        }
        if (kind === 'fixed') {
          if (!end?.value) return report('请填写固定截止日。');
          data.validity.endDate = end.value;
        }
      }
      if (deduction) {
        if (!deduction.value) return report('请选择消费先扣哪一部分。');
        data.deduction = deduction.value;
      }
      if (!Object.keys(data).length) return report('没有需要补充的信息。');
      $('walletInfoSave').disabled = true;
      report('正在保存…','loading');
      try {
        const id = infoCard.id;
        await W.write('/api/wallet/cards/' + id + '/profile','profile:' + id,data);
        $('walletInfoDialog').close();
        filter = 'all';
        await load(id,'卡片信息已补充，已重新计算。');
      } catch (error) { report(error.message); }
      finally { $('walletInfoSave').disabled = false; }
    });
    const maybeOpenEnroll = () => {
      let saved = null;
      try { saved = JSON.parse(sessionStorage.getItem('kdz-wallet-enroll') || 'null'); } catch {}
      if (!saved) return;
      try { sessionStorage.removeItem('kdz-wallet-enroll'); } catch {}
      try { history.replaceState(null, '', 'wallet.html'); } catch {}
      if (!window.KDZWalletEnroll) return;
      window.KDZWalletEnroll.open({
        prefill: saved,
        images: (saved.imageIds || []).map(id => ({ id })),
        offerId: saved.groupId || '',
        onSaved: id => {
          filter = 'all';
          load(id, '卡片已加入卡包。').catch(error => status('卡片已保存，列表刷新失败 · ' + error.message, 'warning'));
        },
      });
    };
    return load().catch(error => {
      status('暂无法读取卡包 · ' + error.message,'error');
      const retry = button('重新读取卡包', async () => {
        retry.disabled = true;
        try { await load(); retry.remove(); }
        catch (next) { status('暂无法读取卡包 · ' + next.message,'error'); }
        finally { retry.disabled = false; }
      });
      $('walletStatus').after(retry);
    }).finally(maybeOpenEnroll);
  }

  return { init, primary };
})();

