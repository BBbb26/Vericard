'use strict';

// Verified general rules only. Merchant-specific terms and historical answers stay in evidence snapshots.
const STATUS_LABELS = {
  verified: '已验证',
  user_confirmed: '用户确认',
  system: '系统口径',
  assumption: '试算假设',
  open: '待核实',
  unsupported: '未建模',
};

const PRECEDENCE = '截图明确条款 > 用户确认 > 通用规则 > 试算假设；冲突时不自动选择。';

const RULES = [
  {
    id: 'R01',
    version: 1,
    title: '核销方式',
    summary: '前提：核销方式已确认。按日核销时，同一自然日多次使用只扣一次；按次核销时，每次到访扣一次。',
    status: 'user_confirmed',
    appliesTo: ['visit_pack'],
    source: '截图字段确认 + decision.js visitPack',
    tests: ['per-day redemption covers later entries', 'visit pack tracks zero remaining visits'],
  },
  {
    id: 'R02',
    version: 1,
    title: '日期口径',
    summary: '有效期起止日都算。从核销日起算 N 天时，核销日为第 1 天，结束日为核销日加 N−1。精确时分仍以券面为准。',
    status: 'system',
    appliesTo: ['stored_value', 'visit_pack', 'time_pass'],
    source: '程序口径 + model.js lastDate / decision.js dateWindow',
    tests: ['time pass includes the activation and last dates', 'bonus validity last date is inclusive'],
  },
  {
    id: 'R03',
    version: 1,
    title: '储值扣减顺序',
    summary: '前提：扣减顺序已确认。本金优先、赠送优先或按初始本金与赠送金比例分摊；比例分摊时赠送金份额四舍五入到分。',
    status: 'user_confirmed',
    appliesTo: ['stored_value'],
    source: '截图字段确认 + decision.js storedValue',
    tests: ['proportional deduction rounds half up', 'principal first and bonus first preserve buckets'],
  },
  {
    id: 'R04',
    version: 1,
    title: '退款未知不编造',
    summary: '退款状态未知时不计算确定退款金额；剩余权益金额、实际可退款和最终净支出是不同概念。',
    status: 'verified',
    appliesTo: ['stored_value', 'visit_pack', 'time_pass', 'time_pack'],
    source: '产品边界 + decision.js normalizeScenario',
    tests: ['zero uses preserve unknown refunds', 'unknown refund cannot have an amount'],
  },
  {
    id: 'R05',
    version: 1,
    title: '首次核销期限',
    summary: '购买后的首次核销截止期与核销后的权益有效期分开记录，不能互相推导。当前单套餐计算没有购买日，未执行该期限。',
    status: 'open',
    appliesTo: ['stored_value', 'visit_pack', 'time_pass'],
    source: '截图证据 + model.js firstRedemptionWithinDays',
    tests: ['legacy drafts preserve first redemption deadline'],
  },
  {
    id: 'R06',
    version: 1,
    title: '覆盖范围',
    summary: '只匹配已确认的服务名。范围外或不适用时按次付费；服务名缺失或范围未知时不自动视为覆盖。',
    status: 'verified',
    appliesTo: ['stored_value', 'visit_pack', 'time_pass', 'time_pack'],
    source: 'decision.js coverageAt / eligibility',
    tests: ['an ineligible service cannot use the bonus', 'a single service can use the last part of a balance'],
  },
  {
    id: 'R07',
    version: 1,
    title: '时长包',
    summary: '时长包按整数分钟记录。单套餐决策尚未实现时长包策略；多套餐比较和卡包支持时长包。',
    status: 'unsupported',
    appliesTo: ['time_pack'],
    source: 'model.js / comparison.js / wallet-ledger.js',
    tests: ['hour card uses integer minutes', 'time pack keeps independent minute entitlement'],
  },
  {
    id: 'R08',
    version: 1,
    title: '未建模限制',
    summary: '截图中的预约、时段、折扣叠加等原文，如果没有转成可执行规则，就只作为证据保留，不参与计算。',
    status: 'unsupported',
    appliesTo: ['stored_value', 'visit_pack', 'time_pass', 'time_pack'],
    source: 'plan-review.js unsupportedRules',
    tests: ['unmodeled restrictions can be explicitly conditioned'],
  },
  {
    id: 'R09',
    version: 1,
    title: '未使用权益',
    summary: '账面未使用权益不等于可退款金额；期限未知时不折算确定过期损失。',
    status: 'verified',
    appliesTo: ['stored_value', 'visit_pack', 'time_pass'],
    source: '产品边界 + decision.js entitlement',
    tests: ['visit pack keeps expired unredeemed visits separate from cash'],
  },
];

const BY_ID = new Map(RULES.map(rule => [rule.id, rule]));

function detailFor(id, resolved, result, scenario) {
  const assumed = new Set(Object.keys(scenario.ruleAssumptions ?? {}));
  if (id === 'R01') {
    if (resolved.redemption === 'per_day') return '同一自然日多次到访只扣一次；同日后续到访不重复扣次。';
    if (resolved.redemption === 'per_visit') return '每次到访扣一次。';
    return '核销方式仍待确认。';
  }
  if (id === 'R02') {
    const kind = resolved.validity?.kind;
    if (kind === 'fixed') return '固定起止日按含首尾处理。';
    if (kind === 'from_activation') return '核销日为第 1 天，N 天结束日为核销日加 N−1。';
    if (kind === 'unlimited') return '已确认无固定截止日。';
    return '有效期仍待确认。';
  }
  if (id === 'R03') {
    if (resolved.deduction === 'principal_first') return '先扣本金，本金不足再扣赠送金。';
    if (resolved.deduction === 'bonus_first') return '先扣赠送金，赠送金不足再扣本金。';
    if (resolved.deduction === 'proportional') return '按初始本金与赠送金比例分摊，赠送金份额四舍五入到分。';
    return '扣减顺序仍待确认。';
  }
  if (id === 'R04') return result.refund?.status === 'unknown' || result.refund?.amountCents == null
    ? '本次退款规则未知，未计算确定退款金额。' : '退款按已明确的条件单独计算。';
  if (id === 'R05') return '截图记录了首次核销截止期 ' + resolved.firstRedemptionWithinDays + ' 天，但当前输入没有购买日，未执行该期限。';
  if (id === 'R06') {
    if (resolved.coverage?.kind === 'none') return '适用范围为不适用，本次消费按次付费。';
    if (resolved.coverage?.kind === 'services') return '只匹配已确认服务名；范围外按次付费。';
    if (resolved.coverage?.kind === 'all') return '适用范围为全部服务。';
    return '适用范围仍待确认，未自动视为覆盖。';
  }
  if (id === 'R07') return '单套餐决策暂不计算时长包；可改用多套餐比较或卡包记录。';
  if (id === 'R08') return resolved.unsupportedRules?.length
    ? '仅保留证据：' + resolved.unsupportedRules.join('；') : '没有未建模限制。';
  if (id === 'R09') {
    const entitlement = result.entitlement;
    const remaining = entitlement?.remainingVisits ?? entitlement?.unusedPrincipalCents ?? entitlement?.unusedBonusCents ?? 0;
    return remaining > 0
      ? '账面仍有未使用权益；未知期限不折算确定过期损失。' : '本次计划没有剩余权益或权益已覆盖。';
  }
  return '';
}

function traceRules(plan, scenario, result) {
  const resolved = {
    ...plan.rules,
    ...(scenario.ruleAssumptions ?? {}),
    firstRedemptionWithinDays: plan.firstRedemptionWithinDays,
    unsupportedRules: plan.unsupportedRules,
  };
  const assumed = new Set(Object.keys(scenario.ruleAssumptions ?? {}));
  const applied = [];
  const open = [];
  const add = (id, status) => {
    const meta = BY_ID.get(id);
    applied.push({ ...meta, status: status ?? meta.status, detail: detailFor(id, resolved, result, scenario) });
  };
  const note = (id, status) => {
    const meta = BY_ID.get(id);
    open.push({ ...meta, status: status ?? meta.status, detail: detailFor(id, resolved, result, scenario) });
  };

  if (plan.type === 'visit_pack' && resolved.redemption) {
    add('R01', assumed.has('redemption') ? 'assumption' : 'user_confirmed');
  }
  if (resolved.validity && resolved.validity.kind !== 'unknown' && result.window?.status === 'known') {
    add('R02', assumed.has('validity') ? 'assumption' : 'system');
  }
  if (plan.type === 'stored_value' && resolved.deduction) {
    add('R03', assumed.has('deduction') ? 'assumption' : 'user_confirmed');
  }
  if (result.refund?.status === 'unknown' || result.refund?.amountCents == null) {
    add('R04');
  }
  if (plan.firstRedemptionWithinDays != null) {
    note('R05', 'open');
  }
  if (resolved.coverage && resolved.coverage.kind !== 'unknown' && resolved.coverage.kind !== 'all') {
    add('R06');
  }
  if (plan.type === 'time_pack') {
    note('R07', 'unsupported');
  }
  if (resolved.unsupportedRules?.length) {
    note('R08', 'unsupported');
  }
  if (result.entitlement) {
    const remaining = result.entitlement.remainingVisits ?? result.entitlement.unusedPrincipalCents ?? result.entitlement.unusedBonusCents ?? 0;
    if (remaining > 0) {
      note('R09', 'verified');
    }
  }

  return { applied, open, precedence: PRECEDENCE, statusLabels: STATUS_LABELS };
}

module.exports = { RULES, traceRules, PRECEDENCE, STATUS_LABELS };
