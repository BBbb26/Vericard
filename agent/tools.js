'use strict';

const E = require('../extract');
const { buildReview } = require('../plan-review');

const stored = ['principal', 'bonus', 'bonusEnd', 'bonusDays', 'bonusValidity', 'bonusCoverage', 'deduction', 'fixedDebit'];
const validity = ['fixedEnd', 'expiryDays', 'validityMode'];
const bonusValidity = ['bonusEnd', 'bonusDays', 'bonusValidity'];
const executable = new Set(['planType', 'unit', 'price', 'total', 'coverage', ...validity, 'fixedStart', ...stored.filter(key => key !== 'fixedDebit')]);
const applicable = {
  次数: ['total', 'unit'],
  期限: ['unit'],
  储值: stored,
  时长: ['total', 'unit'],
};

function reviewFrom(session, confirmed) {
  const candidates = session.candidates;
  const fields = {};
  const values = key => [...new Set(candidates.filter(item => item.field === key).map(item => item.value))];
  const unambiguous = key => confirmed[key] ?? (values(key).length === 1 ? values(key)[0] : null);
  const unit = unambiguous('unit');
  const type = unambiguous('planType') ??
    (values('planType').length > 1 ? null : { 次: '次数', 使用日: '次数', 连续天: '期限', 小时: '时长' }[unit]);
  const irrelevant = [...new Set(Object.values(applicable).flat())].filter(key =>
    type && !applicable[type]?.includes(key));
  const conflicts = new Set();
  for (const set of [validity, bonusValidity]) {
    const present = set.filter(key => unambiguous(key));
    if (present.length > 1) present.forEach(key => conflicts.add(key));
  }
  for (const key of Object.keys(E.labels)) {
    const value = unambiguous(key);
    if (irrelevant.includes(key) || !value || conflicts.has(key) || key === 'actualPrice') continue;
    fields[key] = {
      value, status: confirmed[key] ? '用户核对' : executable.has(key) ? '试算假设' : '待核对',
      evidence: candidates.filter(item => item.field === key && item.value === value).slice(0, 8),
    };
  }
  const review = buildReview({ id: session.analysisId, name: unambiguous('title') || '上传的套餐', fields }, candidates, true);
  if (values('planType').length > 1 && !confirmed.planType) {
    review.type = null;
    review.plan = null;
  }
  review.agent = true;
  review.unsupportedType = type === '时长' ? '时长包请在多套餐比较中试算。' : null;
  for (const [key, field] of Object.entries(review.fields)) {
    if (conflicts.has(key)) field.status = 'conflicting';
    field.policy = irrelevant.includes(key) ? '不适用' :
      field.status === 'conflicting' ? '需要确认' :
      field.verification === '用户核对' ? '已确认' :
      field.candidates.length ? '已提取' : '未提供';
    if (field.policy === '不适用') {
      field.value = null;
      field.candidates = [];
      field.evidence = [];
      field.status = 'missing';
    }
  }
  review.conflicts = Object.entries(review.fields).filter(([, field]) => field.policy === '需要确认').map(([key]) => key);
  review.timeline = {
    purchasedOn: null, firstRedemptionDays: review.fields.purchaseDays.value,
    expiryDays: review.fields.expiryDays.value, expiryDate: review.fields.fixedEnd.value,
  };
  review.imageIds = session.images;
  return review;
}

function createTools({ readImage, recognize, extract }) {
  function imageRecords(ids) {
    return ids.map(id => readImage(id));
  }

  async function read(ids) {
    for (const id of ids) await recognize(id);
    return imageRecords(ids);
  }

  async function extractCandidates(images, useDeepSeek) {
    const result = await extract(images, useDeepSeek);
    const facts = [...images.flatMap(E.extract), ...result.candidates].map(item => item.field === 'title'
      ? { ...item, value: item.value.replace(/^(?:套餐|商品)名称[:：]/, '') }
      : item);
    const titles = facts.filter(item => item.field === 'title').map(item => item.value);
    const seen = new Set();
    const candidates = facts.filter(item => {
      if (!Object.hasOwn(E.labels, item.field) || !item.imageId || !item.quote || item.lineId == null) return false;
      if (item.sourceType === 'llm' && ['price', 'principal', 'bonus', 'total', 'purchaseDays', 'expiryDays', 'bonusDays'].includes(item.field)) {
        const value = Number(item.value);
        const numbers = item.quote.normalize('NFKC').replace(/[,\s]/g, '').match(/\d+(?:\.\d+)?/g) ?? [];
        if (!item.value.match(/^\d+(?:\.\d+)?$/) || !numbers.some(number => Number(number) === value)) return false;
      }
      if (item.field === 'title' && /^\d+次卡$/.test(item.value) &&
          titles.some(title => title !== item.value && title.endsWith(item.value))) return false;
      const key = JSON.stringify([item.field, item.value, item.imageId, item.quote]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const provider = result.fallback ? 'fallback' : result.mode === 'deepseek' ? 'deepseek' : 'local';
    return { candidates, provider };
  }

  return { imageRecords, read, extractCandidates };
}

module.exports = { createTools, reviewFrom };
