'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const wallet = window.KDZWallet;
  const types = { stored_value:'储值', visit_pack:'次数', time_pass:'期限', time_pack:'时长' };
  const states = { calculated:'已试算', conditional:'条件试算', needs_input:'待补充条件', unsupported:'规则待核对' };

  function node(tag, text, className) {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = text;
    if (className) item.className = className;
    return item;
  }

  function item(title, meta, href, icon, badge, source, tone = 'neutral') {
    const link = node('a', undefined, 'activity-row');
    link.href = href;
    const mark = node('span', undefined, 'shortcut-icon');
    mark.append(window.KDZUI.icon(icon));
    const text = node('span', undefined, 'activity-copy');
    text.append(node('strong', title), node('small', meta));
    link.append(mark, text);
    if (source) {
      const tag = node('span', source, 'badge source-badge');
      tag.dataset.tone = source === '多方案' ? 'info' : 'neutral';
      link.append(tag);
    }
    if (badge) {
      const status = node('span', badge, 'badge status-badge');
      status.dataset.tone = tone;
      link.append(status);
    }
    link.append(window.KDZUI.icon('chevron'));
    return link;
  }

  function show(id, rows, empty) {
    $(id).replaceChildren(...(rows.length ? rows : [node('p', empty, 'home-empty')]));
  }

  function activeComparison() {
    try {
      const draft = JSON.parse(sessionStorage.getItem('kdz-comparison-1'));
      if (!Array.isArray(draft?.offers) || !draft.offers.length || !Array.isArray(draft.images) || !draft.form ||
          !Array.isArray(draft.weekdays) || !draft.offers.every(offer => Array.isArray(offer?.imageIds) && offer.edits)) return null;
      return draft;
    } catch {
      return null;
    }
  }

  function refreshComparison() {
    const draft = activeComparison();
    const done = Boolean(draft?.confirmed && draft.hasResult);
    for (const link of document.querySelectorAll('[data-home-new]')) {
      if (draft) {
        link.target = '_blank';
        link.rel = 'noopener';
      } else {
        link.removeAttribute('target');
        link.removeAttribute('rel');
      }
    }
    if (draft && !done) {
      $('homeResume').hidden = false;
      $('homeResumeTitle').textContent = draft.mode === 'study' ? '自习室比较' : '咖啡比较';
      $('homeResumeMeta').textContent = draft.offers.length + ' 个方案 · ' + (draft.confirmed ? '待填写用法' : '待核对方案');
      $('homeResumeLink').href = 'comparison.html#' + (draft.confirmed ? 'profileSection' : 'optionsSection');
    } else {
      $('homeResume').hidden = true;
    }
    return { draft, done };
  }

  function stats(entries) {
    const metrics = node('dl', undefined, 'home-metrics');
    for (const [label, value] of entries) {
      const metric = node('div');
      metric.append(node('dt', label), node('dd', String(value)));
      metrics.append(metric);
    }
    return metrics;
  }

  function cardLink(card) {
    return 'wallet.html?card=' + encodeURIComponent(card.id);
  }

  async function loadRights() {
    try {
      const { cards: all } = await wallet.request('/api/wallet');
      const cards = all.filter(card => !card.archived);
      if (!cards.length) {
        show('homeRights', [], '卡包里还没有权益。实际办卡后，可以在这里查看卡片和临期提醒。');
        return;
      }
      const counts = wallet.overview(cards);
      const rows = [stats([['持有卡片', counts.cards], ['权益临期', counts.expiring], ['待核对记录', counts.pending]])];
      const important = cards.flatMap(card => (card.attention ?? []).slice(0, 1).map(notice => ({ card, notice })))
        .sort((a, b) => a.notice.priority - b.notice.priority || Math.abs(a.notice.daysLeft ?? 0) - Math.abs(b.notice.daysLeft ?? 0))[0];
      if (important) {
        const { card, notice } = important;
        rows.push(item(card.name, wallet.attentionText(notice), cardLink(card) + notice.anchor,
          notice.endDate ? 'calendar' : 'target', notice.label, null,
          notice.kind === 'deduction' || notice.windowDays ? 'warning' : 'neutral'));
      } else {
        rows.push(item(cards[0].name, '最近加入 · ' + (types[cards[0].type] || '套餐'), cardLink(cards[0]), 'wallet', '使用中', null, 'success'));
      }
      show('homeRights', rows);
    } catch {
      show('homeRights', [], '暂时无法读取卡包。请刷新后重试。');
    }
  }

  function localized(date) {
    return new Intl.DateTimeFormat('zh-CN', { timeZone:'Asia/Shanghai', month:'short', day:'numeric',
      hour:'2-digit', minute:'2-digit', hour12:false }).format(new Date(date));
  }

  function loadRecent(comparison) {
    const rows = [];
    if (comparison.done) {
      const { draft } = comparison;
      rows.push(item(
        draft.mode === 'study' ? '自习室比较' : '咖啡比较',
        '当前标签页 · ' + draft.offers.length + ' 个方案',
        'comparison.html#resultSection', 'chart', '已完成', '多方案', 'success',
      ));
    }
    for (const entry of window.KDZRecentAnalysis.read()) {
      rows.push(item(
        entry.name,
        (types[entry.type] || '套餐') + ' · ' + localized(entry.updatedAt),
        'decision.html?group=' + encodeURIComponent(entry.groupId),
        'chart', states[entry.status] || '已分析', '单套餐', 'neutral',
      ));
    }
    const visible = rows.slice(0, 6);
    show('homeRecentList', visible, '完成一次分析后，最近的比较和套餐记录会出现在这里。');
  }

  function load() {
    const comparison = refreshComparison();
    loadRights();
    loadRecent(comparison);
  }

  load();
  window.addEventListener('pageshow', event => { if (event.persisted) load(); });
})();
