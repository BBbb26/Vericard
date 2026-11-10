'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const Issues = window.VericardIssues;
  const dialog = $('agentIssueDialog');
  const form = $('agentIssueReply');
  let reply;

  $('agentIssueClose').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { reply = null; });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!reply) return;
    const current = reply;
    const submit = form.querySelector('[type=submit]');
    const close = $('agentIssueClose');
    const status = $('agentIssueReplyStatus');
    if (submit.disabled) return;
    const text = $('agentIssueText').value.trim();
    if (current.text !== text) {
      current.text = text;
      current.requestId = crypto.randomUUID();
    }
    submit.disabled = close.disabled = true;
    try {
      await current.send({ action: 'reply', issueId: current.issue.id, text, requestId: current.requestId });
      dialog.close();
      current.after();
    } catch (error) {
      status.hidden = false;
      status.textContent = error.message;
      status.dataset.state = 'error';
    } finally {
      submit.disabled = close.disabled = false;
    }
  });
  dialog.addEventListener('cancel', event => {
    if ($('agentIssueClose').disabled) event.preventDefault();
  });

  function create({ state, send, onChange, node, action, link }) {
    const panel = node('section', undefined, 'agent-issues');
    panel.setAttribute('aria-label', '智能疑点面板');
    const heading = node('div', undefined, 'agent-issues-heading');
    const title = node('h2', '智能疑点面板');
    title.tabIndex = -1;
    const body = node('div', undefined, 'agent-issue-list');
    const status = node('p', undefined, 'state-line');
    status.setAttribute('role', 'status');
    status.hidden = true;
    const manualCopy = node('textarea');
    manualCopy.setAttribute('aria-label', '可手动复制的商家询问');
    manualCopy.readOnly = true;
    manualCopy.hidden = true;
    let summary;
    let count;
    let openIssues = [];

    function showStatus(message, tone = 'success') {
      status.hidden = !message;
      status.textContent = message;
      status.dataset.state = tone;
    }

    async function copy(issues) {
      const message = Issues.merchantMessage(issues);
      try {
        await navigator.clipboard.writeText(message);
        manualCopy.hidden = true;
        showStatus('已复制商家询问话术。');
      } catch {
        manualCopy.hidden = false;
        manualCopy.value = message;
        manualCopy.select();
        showStatus('可以手动复制下方话术。', 'warning');
      }
    }

    function evidence(issue, key) {
      const detail = node('details');
      detail.dataset.issueDetail = 'evidence:' + key;
      detail.append(node('summary', '查看原图依据与规则'));
      for (const entry of issue.evidence) {
        const evidence = node('div', undefined, 'agent-issue-evidence');
        evidence.append(node('p', entry.value + ' · ' + entry.scope + ' · ' +
          (entry.version ? '版本 ' + entry.version : '版本未标注'), 'muted'));
        for (const source of entry.sources) {
          const line = node('p', '「' + source.quote + '」 ', 'agent-compare-quote');
          if (/^\/images\/[a-f0-9]{64}\.(?:png|jpg)$/.test(source.url ?? '')) {
            const original = link('看原图', source.url);
            original.target = '_blank';
            original.rel = 'noopener noreferrer';
            line.append(original);
          }
          evidence.append(line);
        }
        detail.append(evidence);
      }
      if (!issue.evidence.length) detail.append(node('p', '当前截图未提供这项条款。', 'muted'));
      for (const rule of state.rules.filter(rule => issue.ruleIds.includes(rule.id))) {
        detail.append(node('p', rule.id + ' · ' + rule.title + '。' + rule.summary, 'muted'));
      }
      return detail;
    }

    function history(issue, key) {
      const events = (state.histories[issue.id] ?? []).filter(event => event.action !== 'observed');
      if (!events.length) return null;
      const detail = node('details', undefined, 'agent-issue-history');
      detail.dataset.issueDetail = 'history:' + key;
      detail.append(node('summary', '查看回复与处理记录（' + events.length + '）'));
      for (const event of events) {
        const label = { reply: '商家回复', defer: '暂缓确认', reopen: '恢复核对' }[event.action];
        const at = new Date(event.at).toLocaleString('zh-CN');
        detail.append(node('p', at + ' · ' + label + (event.text ? '\n' + event.text : '')));
      }
      return detail;
    }

    function refresh(message) {
      showStatus(message);
      update(summary, count);
      onChange();
      title.focus({ preventScroll: true });
    }

    function item(issue, event) {
      const card = node('article', undefined, 'agent-issue');
      const key = event?.id ?? issue.id;
      const name = issue.offerName + (issue.version ? ' · 版本 ' + issue.version : '');
      const badge = node('span', event ? '历史记录' : issue.deferred ? '已暂缓' : issue.label, 'badge');
      badge.dataset.tone = event || issue.deferred ? 'neutral' : 'warning';
      const header = node('div', undefined, 'section-heading');
      header.append(node('h3', issue.title), badge);
      if (!event && state.histories[issue.id]?.some(entry => entry.action === 'reply')) {
        const saved = node('span', '已记录商家回复', 'badge');
        saved.dataset.tone = 'info';
        header.append(saved);
      }
      card.append(header, node('p', name, 'muted'), node('p', issue.summary),
        node('p', issue.impact, 'muted'), evidence(issue, key));
      if (event) card.append(node('p', '发现时间 ' + new Date(event.at).toLocaleString('zh-CN'), 'muted'));
      const historyDetail = history(issue, key);
      if (historyDetail) card.append(historyDetail);
      if (event) return card;

      const actions = node('div', undefined, 'agent-actions');
      let requestId;
      const defer = action(issue.deferred ? '恢复核对' : '暂不确认，继续试算', async () => {
        requestId ??= crypto.randomUUID();
        defer.disabled = true;
        try {
          await send({ action: issue.deferred ? 'reopen' : 'defer', issueId: issue.id, requestId });
          refresh(issue.deferred ? '已恢复核对。' : '已暂缓这项疑点。当前比较继续按条件展示。');
        } catch (error) {
          showStatus(error.message, 'error');
        } finally {
          defer.disabled = false;
        }
      }, 'ghost');
      actions.append(action('复制此问题', () => copy([issue]), 'ghost'),
        action('记录商家回复', () => {
          reply = { issue, send, after: () => refresh('商家回复已保存。') };
          $('agentIssueSubject').textContent = name + ' · ' + issue.title;
          $('agentIssueText').value = '';
          $('agentIssueReplyStatus').hidden = true;
          dialog.showModal();
        }), defer);
      card.append(actions);
      return card;
    }

    function expandable(key, caption, cards) {
      const detail = node('details');
      detail.dataset.issueDetail = key;
      const list = node('div', undefined, 'agent-issue-list');
      list.append(...cards);
      detail.append(node('summary', caption), list);
      return detail;
    }

    function update(result, visits) {
      summary = result;
      count = visits;
      const opened = new Set(Array.from(body.querySelectorAll('details[open]'), detail => detail.dataset.issueDetail));
      const ranked = Issues.rank(state.issues, summary, count, state.histories);
      openIssues = ranked.filter(issue => !issue.deferred);
      const top = openIssues.slice(0, 2);
      const secondary = ranked.filter(issue => !top.includes(issue));
      copyAll.hidden = !openIssues.length;
      body.replaceChildren(...top.map(issue => item(issue)));
      if (!top.length) body.append(node('p', '当前没有优先核对的疑点。', 'muted'));
      if (state.historyError) {
        const retry = action('重读历史疑点', async () => {
          retry.disabled = true;
          try { await send({ action: 'sync' }); refresh('已重新读取历史疑点。'); }
          catch (error) { showStatus(error.message, 'error'); }
          finally { retry.disabled = false; }
        }, 'ghost');
        body.append(node('p', state.historyError, 'warning'), retry);
      }
      if (secondary.length) {
        body.append(expandable('secondary', '次要条款与暂缓疑点（' + secondary.length + '）', secondary.map(issue => item(issue))));
      }
      const active = new Map(state.issues.filter(issue => ranked.some(item => item.id === issue.id))
        .map(issue => [issue.id, JSON.stringify(issue)]));
      const archive = Object.values(state.histories).flatMap(events => events.filter(event => event.action === 'observed' &&
        JSON.stringify(event.snapshot) !== active.get(event.issueId)));
      if (archive.length) {
        body.append(expandable('archive', '历史疑点（' + archive.length + '）', archive.map(event => item(event.snapshot, event))));
      }
      for (const detail of body.querySelectorAll('details[data-issue-detail]')) {
        detail.open = opened.has(detail.dataset.issueDetail);
      }
    }

    const copyAll = action('复制合并后的商家询问', () => copy(openIssues));
    heading.append(title, copyAll);
    panel.append(heading, node('p', '按套餐、版本和适用条件整理，优先展示可能改变本次结果的疑点。', 'muted'),
      status, manualCopy, body);
    return { panel, update };
  }

  window.VericardIssueUI = { create };
})();
