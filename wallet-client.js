if (typeof crypto !== 'undefined' && !crypto.randomUUID) { crypto.randomUUID = function(){return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0,v=c==='x'?r:(r&3|8);return v.toString(16)})}; }

'use strict';

window.KDZWallet = (() => {
  const pending = new Map();

  function money(value) {
    if (value == null) return '待核对';
    const cents = BigInt(value);
    return '¥' + (cents / 100n).toLocaleString('zh-CN') + '.' + String(cents % 100n).padStart(2, '0');
  }

  function yuan(value) {
    if (value == null) return '';
    const cents = BigInt(value);
    return String(cents / 100n) + '.' + String(cents % 100n).padStart(2, '0');
  }

  function today() {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  }

  async function request(url, data, signal) {
    const response = await fetch(url, data === undefined ? { signal } : {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'X-KDZ-Local': '1' },
      body: JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || '请求未成功');
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function saved(key) {
    try { return JSON.parse(sessionStorage.getItem('kdz-wallet-pending:' + key)) ?? pending.get(key); }
    catch { return pending.get(key); }
  }

  function remember(key, value) {
    if (value) pending.set(key, value);
    else pending.delete(key);
    try {
      const storageKey = 'kdz-wallet-pending:' + key;
      if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
      else sessionStorage.removeItem(storageKey);
    } catch {}
  }

  async function write(url, key, data) {
    let submission = saved(key);
    if (data === undefined && !submission) throw new Error('没有待重试的提交。');
    if (data !== undefined && submission && JSON.stringify(data) !== JSON.stringify(submission.data)) {
      throw new Error('上一笔提交结果待确认，请先点“重试上次提交”。');
    }
    submission ??= { data, requestId: crypto.randomUUID() };
    remember(key, submission);
    try {
      const result = await request(url, { ...submission.data, requestId: submission.requestId });
      remember(key, null);
      return result;
    } catch (error) {
      if (error.status >= 400 && error.status < 500) remember(key, null);
      throw error;
    }
  }

  function isExpiring(card) {
    return card.alerts.some(alert => Number.isInteger(alert.daysLeft) && alert.daysLeft >= 0);
  }

  function attentionText(item) {
    if (item.kind !== 'deduction') return item.text;
    return '实扣比约定' + (item.differenceCents > 0 ? '高 ' : '低 ') + money(Math.abs(item.differenceCents)) +
      '，可核实适用条件。' + (item.count > 1 ? ' 共有 ' + item.count + ' 笔待核对。' : '');
  }

  function pendingCount(card) {
    return (card.pendingCount || 0) + (card.fulfillmentDifferenceCount || 0) + (card.reconciliationReviewCount || 0);
  }

  function overview(cards) {
    return { cards: cards.length, expiring: cards.filter(isExpiring).length,
      pending: cards.reduce((total, card) => total + pendingCount(card), 0) };
  }

  function fileData(file, maxMB) {
    if (file.size > maxMB * 1024 * 1024) return Promise.reject(new Error('图片不得超过 ' + maxMB + ' MB。'));
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error('无法读取图片。'));
      reader.readAsDataURL(file);
    });
  }

  function duration(minutes) {
    const hours = Math.floor(minutes / 60), remainder = minutes % 60;
    return hours ? hours.toLocaleString('zh-CN') + ' 小时' + (remainder ? ' ' + remainder + ' 分钟' : '') : minutes + ' 分钟';
  }

  function cardLabel(card) {
    return card.offerType === 'single' ? '单次券' :
      { stored_value:'储值卡', visit_pack:'次数卡', time_pass:'期限会员', time_pack:'时长包' }[card.type];
  }

  return { money, yuan, today, request, write, isExpiring, attentionText, pendingCount, overview, fileData, duration, cardLabel, hasPending: key => Boolean(saved(key)) };
})();
