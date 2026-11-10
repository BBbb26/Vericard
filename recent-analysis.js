'use strict';

window.KDZRecentAnalysis = (() => {
  const key = 'kdz-recent-real-analysis';

  function read() {
    try {
      const items = JSON.parse(localStorage.getItem(key));
      if (!Array.isArray(items)) return [];
      return items.filter(item => typeof item?.groupId === 'string' && typeof item.name === 'string' &&
        Number.isFinite(Date.parse(item.updatedAt))).slice(0, 8);
    } catch {
      return [];
    }
  }

  function remember(payload, groupId) {
    if (!groupId || payload.review?.demo || !payload.reviewTag || !payload.analysis) return;
    const base = payload.analysis.scenarios.find(item => item.input.id === 'base');
    const entry = { groupId, name: payload.review.name, type: payload.review.type,
      status: base?.result.status, updatedAt: new Date().toISOString() };
    try {
      localStorage.setItem(key, JSON.stringify([entry, ...read().filter(item => item.groupId !== groupId)].slice(0, 8)));
    } catch {}
  }

  return { read, remember };
})();

