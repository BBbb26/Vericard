'use strict';

const { randomUUID } = require('node:crypto');

class AgentError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function createSessions({ clock = Date.now, ttl = 2 * 60 * 60 * 1000, capacity = 32 } = {}) {
  const entries = new Map();

  function prune() {
    const now = clock();
    for (const [id, session] of entries) {
      if (!session.processing && now - session.touchedAt >= ttl) entries.delete(id);
    }
  }

  function get(id) {
    prune();
    const session = entries.get(id);
    if (!session) throw new AgentError('这份分析已失效，请返回对话重新开始。', 404);
    session.touchedAt = clock();
    return session;
  }

  function create(source, images, input) {
    prune();
    if (entries.size >= capacity) {
      const idle = [...entries.values()].filter(session => !session.processing);
      idle.sort((a, b) => a.touchedAt - b.touchedAt);
      if (!idle.length) throw new AgentError('正在处理其他截图，请稍后再试。', 503);
      entries.delete(idle[0].analysisId);
    }
    const now = clock();
    const session = {
      schemaVersion: 1, analysisId: randomUUID(), source, state: 'idle', revision: 0,
      images, review: null, input, questions: [], answers: {}, skipped: [],
      result: null, steps: [], cardId: null, createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(), touchedAt: now,
      candidates: null, confirmation: {}, processing: false, error: null,
    };
    entries.set(session.analysisId, session);
    return session;
  }

  function save(session, changes) {
    const now = clock();
    Object.assign(session, changes, {
      revision: session.revision + 1, updatedAt: new Date(now).toISOString(), touchedAt: now,
    });
  }

  return { create, get, save };
}

module.exports = { AgentError, createSessions };
