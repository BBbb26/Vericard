(function (root) {
  'use strict';

  const topics = {
    validity: {
      keys: ['purchase', 'duration'], title: '核销截止与使用期限', priority: 45, ruleIds: ['R02', 'R05'],
      question: '这款套餐最晚何时需要首次核销？从哪个时点开始计算使用期，可使用多久？',
      impact: '适用的开卡期限和使用期限可能改变能覆盖的到访日期。',
    },
    schedule: {
      keys: ['weekday', 'weekend', 'daily'], title: '可用时段与单日时长', priority: 40, ruleIds: ['R06', 'R08'],
      question: '请按工作日、周末和节假日分别说明可到店时段，以及每天或每次可使用多久。',
      impact: '部分日期或时段可能无法使用，实际覆盖可能低于试算。',
    },
    booking: {
      keys: ['reserve'], title: '到店是否需要预约', priority: 24, ruleIds: ['R08'],
      question: '请问首访和后续每次到访分别要预约吗？如需预约，提前多久、约满时如何处理？',
      impact: '如果需要预约，约满可能影响能否按计划到访。',
    },
    refund: {
      keys: ['refund', 'fee'], title: '退款条件与手续费', priority: 12, ruleIds: ['R04', 'R09'],
      question: '请分别说明未核销、已核销和部分使用后的退款条件，手续费按什么基数计算？',
      impact: '这会影响购买后的退款损失，当前比较按购买支出展示。',
    },
    stacking: {
      keys: ['limit', 'stack'], title: '可买几份、权益能否合用', priority: 38, ruleIds: ['R01', 'R08'],
      question: '同一个人或账号最多可以买几份？买多份后能否在同一使用计划中使用，各份怎样核销和计算有效期？',
      impact: '限购及合用条件决定多份权益能否覆盖计划，也会影响总支出。',
    },
  };

  const termNames = {
    purchase: '购买后首次核销', duration: '核销后或连续使用期', weekday: '工作日', weekend: '周末',
    daily: '每日时长', reserve: '预约', refund: '退款', fee: '手续费', limit: '购买数量', stack: '权益合用',
  };

  function applicableScope(claim) {
    const text = (claim.conditionText ?? claim.quote).normalize('NFKC').replace(/\s+/g, '');
    const phase = /首次到店|首访|首次使用|仅首日/.test(text) ? '首访' :
      /后续到访|再次到店|后续每次/.test(text) ? '后续到访' :
      /每次到访|每次到店|每次入场/.test(text) ? '每次到访' :
      /未核销|核销前|验券前|未验券/.test(text) ? '核销前' :
      /部分未使用|部分使用|剩余(?:天数|次数|金额)/.test(text) ? '部分使用或剩余权益' :
      /核销后|验券后|激活后|开卡后/.test(text) ? '核销后' : null;
    const day = /节假日/.test(text) ? '节假日' :
      /工作日|周一(?:至|到|[-—~])周五/.test(text) && claim.key !== 'weekend' ? '工作日' :
      /周末|周六.{0,4}周日/.test(text) && claim.key !== 'weekday' ? '周末' : null;
    const inferred = ['purchase', 'duration', 'weekday', 'weekend', 'daily'].includes(claim.key) ? termNames[claim.key] : null;
    const limited = /仅限|除外|例外|特价|指定(?:门店|座位|区域|场次)|部分(?:门店|场次)|新客|会员专享/.test(text);
    const scope = [phase ?? inferred, day && day !== inferred ? day : null].filter(Boolean).join(' · ');
    if (limited) return { label: (scope ? scope + ' · ' : '') + '有限定条件', known: false, key: text, phase, day };
    return { label: scope || '适用范围未标注', known: Boolean(scope), key: scope || '?', phase, day };
  }

  function collectEvidence(offer) {
    const groups = new Map();
    const images = new Map(offer.images.map(image => [image.id, image]));
    for (const claim of offer.claims) {
      if (claim.code && offer.code && claim.code !== offer.code) continue;
      const scope = applicableScope(claim);
      const key = JSON.stringify([claim.key, claim.value, claim.code, claim.version, scope.key]);
      if (!groups.has(key)) groups.set(key, {
        key: claim.key, value: claim.value, version: claim.version, scope: scope.label,
        scopeKnown: scope.known, phase: scope.phase, day: scope.day, sources: [],
      });
      const record = groups.get(key);
      if (!record.sources.some(source => source.imageId === claim.imageId && source.quote === claim.quote)) {
        record.sources.push({ imageId: claim.imageId, url: images.get(claim.imageId)?.url, quote: claim.quote });
      }
    }
    for (const record of groups.values()) {
      record.sources.sort((a, b) => a.imageId.localeCompare(b.imageId) || a.quote.localeCompare(b.quote));
    }
    return [...groups.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }

  function disjointScope(first, second) {
    const pair = (a, b, left, right) => (a === left && b === right) || (a === right && b === left);
    return pair(first.day, second.day, '工作日', '周末') ||
      pair(first.phase, second.phase, '首访', '后续到访') ||
      pair(first.phase, second.phase, '核销前', '核销后');
  }

  function differences(entries) {
    return entries.flatMap((item, index) => entries.slice(index + 1)
      .filter(other => item.key === other.key && item.value !== other.value && !disjointScope(item, other))
      .map(other => [item, other]));
  }

  function needsReview(entries, topic, offer, differing) {
    if (topic === 'refund') return differing.length > 0 || entries.some(item => item.key === 'fee');
    if (topic === 'stacking') return ['visits', 'single', 'hours'].includes(offer.type) &&
      (offer.limit === null || differing.length > 0 || offer.stackingBlocked);
    return differing.length > 0;
  }

  function catalog(offers) {
    const all = new Map();
    for (const offer of offers) {
      const evidence = collectEvidence(offer);
      for (const [topic, config] of Object.entries(topics)) {
        const entries = evidence.filter(item => config.keys.includes(item.key));
        const differing = differences(entries);
        if (!needsReview(entries, topic, offer, differing)) continue;
        const sameScope = differing.some(([item, other]) => item.version && item.scopeKnown &&
          item.version === other.version && other.scopeKnown && item.scope === other.scope);
        const distinctVersions = new Set(entries.map(item => item.version).filter(Boolean)).size > 1;
        const label = sameScope ? '同口径待核对' : distinctVersions ? '适用版本待核对' : '适用条件待核对';
        const version = offer.version ?? null;
        const summary = sameScope ? '同一版本、同一适用条件下读到不同表述，请按原图向商家核实。' :
          distinctVersions ? '原图出现多个版本，需核对本次购买适用哪一版。' :
          differing.length ? '原图读到不同表述，版本、适用日期或使用阶段仍需核对。' :
          topic === 'stacking' ? offer.stackingBlocked ? '原图写有同款不可叠加使用，需要核实是否适用于此次购买。' :
            '原图尚未提供明确的购买上限和多份使用方式。' : '手续费和退款条件要结合核销状态、已使用部分与适用版本核对。';
        const id = JSON.stringify([offer.packageId, version, topic]);
        const issue = { id, packageId: offer.packageId, version, offerName: offer.shortName || offer.name || '此套餐',
          topic, title: config.title, label, summary, impact: config.impact, question: config.question,
          ruleIds: config.ruleIds, evidence: entries };
        const existing = all.get(id);
        if (existing) {
          const combined = new Map([...existing.evidence, ...entries].map(item => [JSON.stringify(item), item]));
          existing.evidence = [...combined.values()];
        } else all.set(id, issue);
      }
    }
    return [...all.values()];
  }

  function rank(issues, comparison, visits, histories = {}) {
    const best = comparison.complete[0];
    const rows = new Map(comparison.rows.map(item => [JSON.stringify([item.offer.packageId, item.offer.version ?? null]), item]));
    return issues.flatMap(issue => {
      const item = rows.get(JSON.stringify([issue.packageId, issue.version]));
      if (!item) return [];
      const { offer, row, alternative, durationScenario } = item;
      const history = Object.hasOwn(histories, issue.id) ? histories[issue.id] : [];
      if (issue.topic === 'stacking' && row && !row.missing && row.quantity === 1 && !history.some(event => event.action !== 'observed')) return [];
      let score = topics[issue.topic].priority;
      let impact = issue.impact;
      const onBest = best?.offer === offer;
      if (issue.topic === 'stacking' && row?.missing && alternative?.missing === 0) {
        score += 35 + (!best || alternative.paid < best.row.paid ? 25 : 0);
        impact = '当前少覆盖 ' + row.missing + ' 次。若允许买并合用 ' + alternative.quantity + ' 份，试算可覆盖 ' + visits + ' 次。';
      } else if (issue.topic === 'stacking' && row?.quantity > 1) {
        score += 30;
        impact = '当前结果使用了 ' + row.quantity + ' 份权益，若无法合用，可能无法覆盖计划。';
      } else if (issue.topic === 'validity' && durationScenario) {
        score += 30 + (!best || durationScenario.row.paid < best.row.paid ? 25 : 0);
        impact = '若商家确认适用 ' + durationScenario.days + ' 天使用期，这款在当前天数和到访量下可覆盖 ' +
          visits + ' 次，可能改变可选方案。';
      } else if (['validity', 'schedule', 'booking'].includes(issue.topic)) {
        score += onBest ? 30 : row && row.missing === 0 ? 14 : 0;
        if (onBest) impact += ' 这款目前在可覆盖方案中支出最低。';
      }
      const status = history.filter(event => event.action === 'defer' || event.action === 'reopen').at(-1)?.action;
      return [{ ...issue, impact, score, deferred: status === 'defer', history }];
    }).sort((a, b) => Number(a.deferred) - Number(b.deferred) || b.score - a.score || a.id.localeCompare(b.id));
  }

  function merchantMessage(issues) {
    const groups = new Map();
    for (const issue of issues) {
      const key = JSON.stringify([issue.packageId, issue.version]);
      if (!groups.has(key)) groups.set(key, { name: issue.offerName, version: issue.version, questions: new Set() });
      groups.get(key).questions.add(issue.question);
    }
    return [...groups.values()].map(({ name, version, questions }) =>
      '您好，想确认「' + name + '」' + (version ? '（截图版本 ' + version + '）' : '') + '的购买规则。\n' +
      [...questions].map((question, index) => (index + 1) + '. ' + question).join('\n'),
    ).join('\n\n');
  }

  const api = { catalog, rank, merchantMessage };
  if (typeof module !== 'undefined') module.exports = api;
  else root.VericardIssues = api;
})(globalThis);
