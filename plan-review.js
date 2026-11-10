'use strict';

const { createHash } = require('node:crypto');
const E = require('./extract');
const T = require('./offer-terms');
const { date } = require('./model');

const typeNames = { 储值: 'stored_value', 次数: 'visit_pack', 期限: 'time_pass' };
const unitTypes = { 次: 'visit_pack', 使用日: 'visit_pack', 连续天: 'time_pass' };
const deductionNames = { 本金优先: 'principal_first', 赠送优先: 'bonus_first', 初始比例: 'proportional' };
const rawRiskFields = ['schedule', 'reservation', 'restrictions'];

function yuan(value) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value ?? '').trim());
  const cents = match ? Number(match[1] + (match[2] ?? '').padEnd(2, '0')) : null;
  return Number.isSafeInteger(cents) ? cents : null;
}

function positive(value) {
  const count = /^\d+$/.test(String(value ?? '')) ? Number(value) : null;
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

function dayCount(value) {
  const match = /^(\d+)\s*(?:天|日)?$/.exec(String(value ?? '').trim());
  const count = match ? Number(match[1]) : null;
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

function day(value) {
  try { return date(value); } catch { return null; }
}

function serviceCoverage(value) {
  if (/^全部(?:项目|服务)?$/.test(value ?? '')) return { kind: 'all' };
  if (value === '不适用') return { kind: 'none' };
  if (!value?.startsWith('仅限') || /节假日|时段|折扣|除外|且|不含|不可/.test(value)) return null;
  const serviceIds = value.slice(2).replace(/(?:可用|使用)$/, '').split(/[、,，]/).map(name => name.trim()).filter(Boolean);
  return serviceIds.length ? { kind: 'services', serviceIds } : null;
}

function validity(read, bonus = false) {
  const ends = read(bonus ? 'bonusEnd' : 'fixedEnd');
  const start = read('fixedStart');
  const days = read(bonus ? 'bonusDays' : 'expiryDays');
  const mode = read(bonus ? 'bonusValidity' : 'validityMode');
  const selected = [ends, days, mode].filter(Boolean).length;
  if (selected !== 1) return null;
  if (mode === '同主卡' && bonus) return { kind: 'same_as_plan' };
  if (mode === '无期限') return { kind: 'unlimited' };
  if (days && dayCount(days)) return { kind: 'from_activation', days: dayCount(days) };
  if (ends && day(ends) && (bonus || !start || (day(start) && start <= ends))) {
    return { kind: 'fixed', startDate: bonus ? null : day(start), endDate: day(ends) };
  }
  return null;
}

function reviewGroup(group, images) {
  if (!group || !group.confirmed) throw new Error('请先回到套餐确认页，勾选「以上截图属于同一套餐」。');
  return buildReview(group, E.candidates(group, images));
}

function buildReview(group, candidates, agent = false) {
  const fields = Object.fromEntries(Object.keys(E.labels).map(key => {
    const field = group.fields?.[key];
    const fieldCandidates = candidates.filter(item => item.field === key);
    const attached = field?.evidence ?? [];
    return [key, {
      label: E.labels[key],
      value: field?.value?.trim() || null,
      verification: field?.status || '待核对',
      status: T.describeField(key, field, fieldCandidates),
      source: attached.some(item => item.sourceType === 'ocr' || item.method?.startsWith('本地OCR')) ? 'OCR 原图' :
        attached.length ? '关联材料或历史审阅' : field?.value ? '用户填写' : '当前无已采用来源',
      evidence: attached.slice(0, 12),
      candidates: fieldCandidates.slice(0, 12),
    }];
  }));
  const read = (key, accepted) => {
    const field = fields[key];
    return accepted.includes(field?.verification) ? field.value : null;
  };
  const confirmed = key => read(key, ['用户核对']);
  const withAssumptions = key => read(key, ['用户核对', '试算假设']);
  const typeValue = (agent ? withAssumptions : confirmed)('planType');
  const unit = (agent ? withAssumptions : confirmed)('unit');
  const explicitType = Object.hasOwn(typeNames, typeValue) ? typeNames[typeValue] : null;
  const unitType = unitTypes[unit] ?? null;
  const typeConflict = (explicitType && unitType && explicitType !== unitType) ||
    /^(?:小时|组合|待确认)$/.test(unit ?? '');
  const type = typeConflict ? null : typeValue ? explicitType : unitType;
  if (typeConflict) fields.planType.status = 'conflicting';
  for (const keys of [['fixedEnd', 'expiryDays', 'validityMode'], ['bonusEnd', 'bonusDays', 'bonusValidity']]) {
    const choices = keys.filter(key => withAssumptions(key));
    if (choices.length > 1) choices.forEach(key => { fields[key].status = 'conflicting'; });
  }
  const ruleInputs = {
    validity: validity(confirmed),
    coverage: serviceCoverage(confirmed('coverage')),
  };
  const optional = {
    validity: validity(withAssumptions),
    coverage: serviceCoverage(withAssumptions('coverage')),
  };
  if (type === 'stored_value') {
    const stored = input => ({
      principalCents: yuan(input('principal')),
      bonusCents: yuan(input('bonus')),
      bonusCoverage: serviceCoverage(input('bonusCoverage')),
      bonusValidity: validity(input, true),
      deduction: Object.hasOwn(deductionNames, input('deduction')) ? deductionNames[input('deduction')] : null,
    });
    Object.assign(ruleInputs, stored(confirmed));
    Object.assign(optional, stored(withAssumptions));
  }
  if (type === 'visit_pack') {
    const visit = input => {
      const redemptionUnit = input('unit');
      return {
        visits: positive(input('total')),
        redemption: redemptionUnit === '使用日' ? 'per_day' : redemptionUnit === '次' ? 'per_visit' : null,
      };
    };
    Object.assign(ruleInputs, visit(confirmed));
    Object.assign(optional, visit(withAssumptions));
  }
  const evidenceText = key => fields[key].value || fields[key].candidates.map(item => item.value).join('；');
  const restrictions = rawRiskFields.map(key => ({ key, text: evidenceText(key) })).filter(item => item.text);
  const stacking = evidenceText('stacking');
  const facts = Object.fromEntries(Object.entries(fields).filter(([, value]) => value.verification === '用户核对'));
  const version = Number.parseInt(createHash('sha256').update(JSON.stringify({ facts, stacking })).digest('hex').slice(0, 12), 16) || 1;
  return {
    id: group.id,
    name: (agent ? withAssumptions : confirmed)('title') || group.name || '未命名套餐',
    type: type ?? null,
    fields,
    restrictions,
    plan: type ? {
      id: group.id, version, type, name: (agent ? withAssumptions : confirmed)('title') || group.name || '未命名套餐',
      offerPriceCents: yuan(confirmed('price')),
      firstRedemptionWithinDays: positive(confirmed('purchaseDays')),
      rules: ruleInputs,
      evidence: facts,
      unsupportedRules: stacking ? ['未建模的折扣或复杂扣减：' + stacking] : [],
    } : null,
    assumptions: Object.fromEntries(Object.entries(optional).filter(([key, value]) => ruleInputs[key] === null && value !== null)),
    assumedPriceCents: yuan(read('price', ['试算假设'])),
    feeCents: yuan(withAssumptions('fee')),
    feeIsAssumed: fields.fee.verification === '试算假设',
    actualPriceCents: yuan(confirmed('actualPrice')),
  };
}

module.exports = { reviewGroup, buildReview, yuan, positive, serviceCoverage };
