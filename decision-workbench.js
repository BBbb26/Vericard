'use strict';

const { analyzeDecision } = require('./decision');
const { date, lastDate } = require('./model');
const { reviewGroup, yuan, positive, serviceCoverage } = require('./plan-review');
const { traceRules } = require('./rules/general');

const SCENARIOS = { low: '保守', base: '正常', high: '乐观' };
const options = (label, value) => ({ label, value });
const restrictionsOption = '仅在计划符合原文限制时试算';
const all = { kind: 'all' };
const none = { kind: 'none' };
const demos = {
  stored: {
    name: '储值示例 · 充值 ¥1,000 赠 ¥200', service: '洗护', referencePrice: '200',
    fields: { planType: '储值', price: '1000', principal: '1000', bonus: '200', deduction: '本金优先',
      validityMode: '无期限', bonusValidity: '同主卡', coverage: '全部', fee: '0' },
  },
  visits: {
    name: '次卡示例 · ¥1,200 / 20 次', service: '私教', referencePrice: '90',
    fields: { planType: '次数', unit: '次', price: '1200', total: '20', expiryDays: '90', coverage: '全部', fee: '0' },
  },
  time: {
    name: '期限示例 · ¥900 / 180 天', service: '健身', referencePrice: '80',
    fields: { planType: '期限', unit: '连续天', price: '900', expiryDays: '180', coverage: '全部', fee: '0' },
  },
};

const prompts = {
  planType: ['先核对套餐类型', '请问这份套餐是储值、按次数核销，还是在有效期内使用的会员？', 'planType'],
  prepaidPriceCents: ['预付价格是多少？', '请问办理这个套餐实际需支付多少，是否还有开卡费用？', 'price'],
  extraFeesCents: ['计划是否还会产生额外费用？', '请问这项服务还有开卡费、预约费或其他额外收费吗？', 'fee'],
  referencePriceCents: ['该项目的可比单次价格是多少？', '请问同门店相同服务单独购买一次是多少钱？', null],
  principalCents: ['充值本金是多少？', '请问实际进入本金余额的是多少元？', 'principal'],
  bonusCents: ['赠送金是多少？', '请问赠送金额是多少，是否单独记账？', 'bonus'],
  visits: ['套餐包含多少次权益？', '请问套餐一共可以核销多少次？', 'total'],
  redemption: ['按到访还是按使用日扣次？', '请问同一天多次到店会扣一次还是每次都扣？', 'unit'],
  coverage: ['计划中的项目是否适用？', '请问这张卡能否用于我计划消费的项目？', 'coverage'],
  bonusCoverage: ['赠送金能否用于计划中的项目？', '请问赠送金能否用于我计划消费的项目，有没有额外限制？', 'bonusCoverage'],
  deduction: ['消费时如何扣减本金和赠送金？', '请问先扣本金、先扣赠送金，还是按初始金额比例分摊？', 'deduction'],
  validity: ['计划日期是否在套餐有效期内？', '请问权益从哪天生效、哪天到期？首次核销的截止日也请单独说明。', 'expiryDays'],
  bonusValidity: ['赠送金在计划日期是否有效？', '请问赠送金与主卡一起到期吗？如有独立期限，具体到哪天？', 'bonusEnd'],
  activationDate: ['预计或实际何时生效？', '请问办卡后立即生效，还是从激活或首次核销日起生效？', 'expiryDays'],
  restrictions: ['计划是否符合原文里的使用限制？', '请帮我确认计划中的日期和项目是否受时段、预约、加价或节假日限制。', 'restrictions'],
  refund: ['核实退款条件', '请问未使用或使用一部分后能否退款，金额如何计算？', 'refund'],
};

function demoReview(id) {
  const demo = Object.hasOwn(demos, id) && demos[id];
  if (!demo) throw new Error('请选择可用的演示案例。');
  const fields = Object.fromEntries(Object.entries(demo.fields).map(([key, value]) => [
    key, { value, status: '用户核对', evidence: [{ method: '合成演示数据', quote: value }] },
  ]));
  return { ...reviewGroup({ id: 'demo-' + id, name: demo.name, fields, confirmed: true }, []), demo: true };
}

function scenariosFrom(input, review) {
  const start = date(input.startDate, '计划开始日');
  const serviceId = String(input.serviceId ?? '').trim();
  const optionalMoney = (value, label) => {
    if (value == null || String(value).trim() === '') return null;
    const amount = yuan(value);
    if (amount === null) throw new Error(label + '请输入非负金额，最多两位小数。');
    return amount;
  };
  const reference = optionalMoney(input.referencePrice, '单次参考价');
  const fees = optionalMoney(input.extraFees, '额外费用');
  const assumedPrice = optionalMoney(input.assumedPrice, '预付试算价');
  const activationDate = input.activationDate ? date(input.activationDate, '生效日') : null;
  return Object.entries(SCENARIOS).map(([id, label]) => {
    const item = input.scenarios?.[id];
    const count = String(item?.count ?? '');
    const everyDays = positive(item?.everyDays);
    if (!/^\d+$/.test(count) || Number(count) > 52 || everyDays === null || everyDays > 365) {
      throw new Error(label + '情景请输入 0–52 次及 1–365 天的使用间隔。');
    }
    return {
      id, label, activationDate, usageKind: 'forecast',
      actualPaidCents: assumedPrice === null ? review.actualPriceCents : null,
      assumedPriceCents: assumedPrice ?? (review.actualPriceCents === null ? review.assumedPriceCents : null),
      extraFeesCents: fees ?? review.feeCents,
      uses: Array.from({ length: Number(count) }, (_, index) => ({
        date: lastDate(start, 1 + index * everyDays), serviceId: serviceId || null, referencePriceCents: reference,
      })),
    };
  });
}

function alternatives(key, scenarios, review) {
  if (['visits', 'principalCents', 'bonusCents'].includes(key)) {
    const candidates = review.fields[prompts[key][2]].candidates;
    const parse = key === 'visits' ? positive : yuan;
    const values = [...new Set(candidates.map(candidate => parse(candidate.value)).filter(value => value !== null))];
    return values.slice(0, 4).map(value => options(
      '采用候选作试算 · ' + (key === 'visits' ? value + ' 次' : '¥' + (value / 100).toFixed(2)), value,
    ));
  }
  if (key === 'coverage' || key === 'bonusCoverage') {
    if (review.agent) {
      const term = review.fields[key];
      const choices = [...new Set(term.candidates.map(candidate => candidate.value))]
        .map(value => options('若按「' + value + '」试算', serviceCoverage(value)))
        .filter(choice => choice.value);
      if (choices.length > 1) return choices.slice(0, 4);
    }
    return [options('计划中的项目适用', all), options('计划中的项目不适用', none)];
  }
  if (key === 'deduction') {
    return [options('本金优先', 'principal_first'), options('赠送金优先', 'bonus_first'), options('按初始比例', 'proportional')];
  }
  if (key === 'redemption') {
    return [options('每次到访扣一次', 'per_visit'), options('同一自然日只扣一次', 'per_day')];
  }
  if (key !== 'validity' && key !== 'bonusValidity') return [];
  const dates = scenarios.flatMap(scenario => scenario.uses.map(use => use.date)).sort();
  if (!dates.length || dates[0] === '0000-01-01') return [];
  const before = new Date(Date.parse(dates[0] + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  return [
    options('边界试算 · 期限覆盖计划（仍受生效日约束）', { kind: 'fixed', startDate: dates[0], endDate: dates.at(-1) }),
    options('边界试算 · 计划开始前已到期', { kind: 'fixed', startDate: before, endDate: before }),
  ];
}

function makeQuestion(key, branches = [], impact = null, changesConclusion = false) {
  const [title, merchant, field] = prompts[key];
  return { key, title, merchant, field, branches, impact, changesConclusion };
}

function holdPoint(plan, scenario, result) {
  if (result.economicDifferenceCents === null) return { status: 'unknown' };
  for (let count = 1; count <= scenario.uses.length; count++) {
    const prefix = { ...scenario, uses: scenario.uses.slice(0, count) };
    const evaluated = analyzeDecision(plan, [prefix]).scenarios[0].result;
    if (evaluated.economicDifferenceCents !== null && evaluated.economicDifferenceCents >= 0) {
      return { status: 'found', count, date: prefix.uses.at(-1).date };
    }
  }
  return { status: 'outside_schedule' };
}

function compareSensitivity(plan, scenarios, key, branches, review, ruleAssumptions, jointBudget) {
  const evaluate = (branch, context = {}) => {
    const analysis = analyzeDecision(plan, scenarios.map(scenario => ({
      ...scenario, ruleAssumptions: { ...ruleAssumptions, ...context, [key]: branch.value },
    })));
    return {
      label: branch.label,
      outcomes: analysis.scenarios.map(({ input, result }) => ({
        id: input.id, cash: result.cash.totalCents, difference: result.economicDifferenceCents,
      })),
      unresolved: [...new Set(analysis.scenarios.flatMap(item => item.result.unresolved))],
    };
  };
  const measure = (outcomes, context = null) => {
    let impact = null;
    let changesConclusion = false;
    if (outcomes.length >= 2) {
      for (const id of Object.keys(SCENARIOS)) {
        const values = outcomes.map(branch => branch.outcomes.find(item => item.id === id).difference);
        if (values.some(value => value === null)) continue;
        impact = Math.max(impact ?? 0, Math.max(...values) - Math.min(...values));
        changesConclusion ||= new Set(values.map(Math.sign)).size > 1;
      }
    }
    return { branches: outcomes.map(({ label, outcomes: values }) => ({ label, outcomes: values })),
      impact, changesConclusion, context };
  };
  const baseline = branches.map(branch => evaluate(branch));
  let best = measure(baseline);
  if (branches.length < 2 || best.changesConclusion) return best;
  const blockers = [...new Set(baseline.flatMap(branch => branch.unresolved))]
    .filter(other => other !== key && plan.rules[other] === null && !Object.hasOwn(ruleAssumptions, other));
  for (const other of blockers) {
    for (const context of alternatives(other, scenarios, review).slice(0, 2)) {
      if (jointBudget.remaining < branches.length) return best;
      jointBudget.remaining -= branches.length;
      const candidate = measure(branches.map(branch => evaluate(branch, { [other]: context.value })), {
        key: other, title: prompts[other][0], option: context.label,
      });
      if (candidate.impact !== null && (candidate.changesConclusion && !best.changesConclusion ||
          candidate.changesConclusion === best.changesConclusion && candidate.impact > (best.impact ?? -1))) {
        best = candidate;
      }
    }
  }
  return best;
}

function buildCostCurve(plan, review, input, scenarios, range) {
  const base = scenarios.find(scenario => scenario.id === 'base');
  const maximum = Math.max(...scenarios.map(scenario => scenario.uses.length));
  const sample = scenarios.find(scenario => scenario.uses.length)?.uses[0];
  const interval = Number(input.scenarios.base.everyDays);
  const uses = [...base.uses];
  for (let index = uses.length; index < maximum; index++) {
    const days = 1 + index * interval;
    const time = Date.parse(input.startDate + 'T00:00:00Z') + (days - 1) * 86400000;
    if (time > Date.UTC(9999, 11, 31)) break;
    uses.push({ ...sample, date: lastDate(input.startDate, days) });
  }

  function points(activePlan, assumptions) {
    return Array.from({ length: uses.length + 1 }, (_, count) => {
      const { result } = analyzeDecision(activePlan, [{
        ...base, uses: uses.slice(0, count), ruleAssumptions: assumptions,
      }]).scenarios[0];
      return {
        count, prepaid: result.cash.totalCents, payAsYouGo: result.payAsYouGoCents,
        difference: result.economicDifferenceCents,
      };
    });
  }

  const variants = [];
  if (range?.key === 'restrictions') {
    variants.push({ label: range.branches[0].label, points: points(review.plan, base.ruleAssumptions) });
  } else if (range) {
    const assumptions = { ...base.ruleAssumptions };
    if (range.context) {
      const context = alternatives(range.context.key, scenarios, review).find(option => option.label === range.context.option);
      if (!context) return { normalCount: base.uses.length, points: points(plan, assumptions), variants };
      assumptions[range.context.key] = context.value;
    }
    for (const branch of range.branches) {
      const option = alternatives(range.key, scenarios, review).find(item => item.label === branch.label);
      if (option) variants.push({ label: branch.label, points: points(plan, { ...assumptions, [range.key]: option.value }) });
    }
  }
  return { normalCount: base.uses.length, points: points(plan, base.ruleAssumptions), variants };
}

function analyzeWorkbench(review, input) {
  const skipped = new Set(Array.isArray(input.skipped) ? input.skipped : []);
  if (!review.plan) {
    const questions = skipped.has('planType') ? [] : [makeQuestion('planType')];
    return { review, questions, merchantQuestions: [prompts.planType[1], prompts.refund[1]],
      steps: [{ tool: 'review_terms', result: '套餐类型仍待确认' }], ranges: [], analysis: null };
  }
  const initial = scenariosFrom(input, review);
  const answers = input.answers ?? {};
  const ruleAssumptions = { ...review.assumptions };
  const answered = new Set();
  const answerNotes = [];
  for (const [key, choice] of Object.entries(answers)) {
    if (key === 'restrictions' && choice === restrictionsOption && review.restrictions.length) {
      answered.add(key);
      continue;
    }
    const branch = alternatives(key, initial, review).find(option => option.label === choice);
    if (!branch || review.plan.rules[key] !== null || Object.hasOwn(ruleAssumptions, key)) {
      throw new Error('追问选项已失效，请清空选择后重新计算。');
    }
    ruleAssumptions[key] = branch.value;
    answerNotes.push(prompts[key][0] + ' 试算条件为「' + branch.label + '」。');
    answered.add(key);
  }
  const assumptions = [
    ...answerNotes,
    ...Object.values(review.fields).filter(field => field.verification === '试算假设' && field.value)
      .map(field => field.label + '按工作台标注作试算：' + field.value),
  ];
  if (review.restrictions.length && answered.has('restrictions')) {
    assumptions.push('情景以计划符合已列原文限制为前提，预约、时段和限制条件未逐项核验。');
  }
  if (!review.agent && input.extraFees !== '' && input.extraFees != null) assumptions.push('额外费用按本页填写的情景金额计算。');
  else if (review.feeIsAssumed) assumptions.push('额外费用采用证据工作台标注的试算假设。');

  const plan = { ...review.plan, unsupportedRules: [...review.plan.unsupportedRules] };
  const gated = review.restrictions.length > 0 && !answered.has('restrictions');
  if (gated) plan.unsupportedRules.push('预约、时段或其他使用限制尚未与本次计划核对。');
  const scenarios = initial.map(scenario => ({ ...scenario, ruleAssumptions }));
  const analysis = analyzeDecision(plan, scenarios);
  for (const item of analysis.scenarios) {
    if (item.result.status === 'calculated' && assumptions.length) item.result.status = 'conditional';
    item.breakEven = holdPoint(plan, item.input, item.result);
    item.result.rules = traceRules(plan, item.input, item.result);
  }

  const steps = [
    { tool: 'review_terms', result: review.demo ? '读取合成示例规则' : '读取已核对字段、候选原文及限制' },
    { tool: 'simulate_cost', result: '按三种计划调用对应卡型的确定性策略' },
  ];
  const unresolved = [...new Set(analysis.scenarios.flatMap(item => item.result.unresolved))];
  if (unresolved.includes('validity') && (plan.rules.validity?.kind === 'from_activation' || (plan.rules.validity?.kind === 'fixed' && !plan.rules.validity.startDate)) && !input.activationDate) {
    unresolved[unresolved.indexOf('validity')] = 'activationDate';
  }
  if (unresolved.includes('bonusValidity') && (plan.rules.bonusValidity?.kind === 'from_activation' || (plan.rules.bonusValidity?.kind === 'fixed' && !plan.rules.bonusValidity.startDate)) && !input.activationDate) {
    unresolved[unresolved.indexOf('bonusValidity')] = 'activationDate';
  }
  const questions = [];
  let restrictionRange = null;
  if (gated) {
    const question = makeQuestion('restrictions', [options(restrictionsOption, true)]);
    questions.push(question);
    const run = analyzeDecision(review.plan, scenarios);
    const outcomes = run.scenarios.map(({ input: scenario, result }) => ({
      id: scenario.id, cash: result.cash.totalCents, difference: result.economicDifferenceCents,
    }));
    if (outcomes.some(item => item.cash !== null)) {
      restrictionRange = { ...question, branches: [{ label: '若计划符合所列原文限制', outcomes }] };
    }
  }
  const jointBudget = { remaining: 24 };
  for (const key of new Set(unresolved)) {
    if (!Object.hasOwn(prompts, key)) continue;
    const branches = alternatives(key, scenarios, review).filter(() => plan.rules[key] === null && !Object.hasOwn(ruleAssumptions, key));
    const compared = compareSensitivity(plan, scenarios, key, branches, review, ruleAssumptions, jointBudget);
    questions.push({ ...makeQuestion(key), ...compared });
    if (branches.length) steps.push({
      tool: 'compare_rule_options', key,
      result: compared.impact === null ? '其他条件仍待确认，暂无法量化影响' :
        compared.context ? '已固定另一待核对条件，重算本条件影响' : '已重新计算各备选条件',
    });
  }
  questions.sort((a, b) => (b.key === 'restrictions') - (a.key === 'restrictions') ||
    Number(b.changesConclusion) - Number(a.changesConclusion) || (b.impact ?? -1) - (a.impact ?? -1));
  const shown = questions.filter(question => !skipped.has(question.key)).slice(0, 2);
  const ranges = restrictionRange ? [restrictionRange] : questions.filter(question => question.impact !== null).slice(0, 1);
  const merchantQuestions = [...new Set([
    ...questions.map(question => question.merchant),
    ...(review.restrictions.length ? [prompts.restrictions[1]] : []),
    prompts.refund[1], '请问权益未用完时可以延期或转让吗？具体需要满足什么条件？',
  ])].slice(0, 3);
  steps.push({ tool: shown.length ? 'ask_user' : ranges.length ? 'show_conditional' : 'show_result',
    result: shown.length ? '先核对最可能影响计算的问题' : '展示可计算结果与尚未确认的条件' });
  return {
    review, analysis, questions: shown, ranges, merchantQuestions, steps, assumptions,
    ...(input.includeCostCurve === true ? { costCurve: buildCostCurve(plan, review, input, scenarios, ranges[0]) } : {}),
  };
}

module.exports = { analyzeWorkbench, demoReview };
