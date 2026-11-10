'use strict';

const fs = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { AgentError } = require('./session');

function createIssueHistory(file, save, now = () => new Date().toISOString()) {
  function read() {
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (state.schemaVersion !== 1 || !Array.isArray(state.events)) throw new Error('Invalid issue history');
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return { schemaVersion: 1, events: [] };
      throw new AgentError('历史疑点无法读取，请保留原文件并检查。', 500);
    }
  }

  function update(analysisId, issues, packageIds, input) {
    const state = read();
    const initialCount = state.events.length;
    const action = input?.action;
    if (!['sync', 'reply', 'defer', 'reopen'].includes(action)) throw new AgentError('无效的疑点操作。');
    const issue = issues.find(item => item.id === input.issueId);
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (action !== 'sync') {
      if (!issue) throw new AgentError('这条疑点当前已变更，请重新载入。', 409);
      if (!/^[a-f0-9-]{36}$/i.test(input.requestId ?? '')) throw new AgentError('无效的请求标识。');
      if (action === 'reply' && (!text || text.length > 1200)) throw new AgentError('商家回复需填写 1–1200 个字。');
      const previous = state.events.find(event => event.id === input.requestId);
      if (previous && (previous.action !== action || previous.issueId !== issue.id || previous.text !== (action === 'reply' ? text : undefined))) {
        throw new AgentError('请求标识已使用，请重新提交。', 409);
      }
      if (!previous) state.events.push({
        id: input.requestId, action, issueId: issue.id, packageId: issue.packageId, analysisId, at: now(),
        ...(action === 'reply' ? { text } : {}),
      });
    }
    const known = new Set(state.events.filter(event => event.action === 'observed').map(event => event.fingerprint));
    for (const item of issues) {
      const fingerprint = createHash('sha256').update(JSON.stringify(item)).digest('hex');
      if (known.has(fingerprint)) continue;
      state.events.push({ id: randomUUID(), action: 'observed', issueId: item.id, packageId: item.packageId,
        analysisId, at: now(), fingerprint, snapshot: item });
      known.add(fingerprint);
    }
    if (state.events.length !== initialCount) save(file, state);
    return state.events.filter(event => packageIds.has(event.packageId));
  }

  return { update };
}

module.exports = { createIssueHistory };
