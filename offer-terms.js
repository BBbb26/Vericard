(function (root) {
'use strict';

const labels = {
  planType: '套餐类型（储值 / 次数 / 期限）',
  actualPrice: '订单实付金额（元，购前可留空）',
  principal: '充值本金（元）',
  bonus: '赠送金额（元）',
  validityMode: '主卡有效期（无期限时填写无期限）',
  fixedStart: '固定生效日期（YYYY-MM-DD）',
  bonusEnd: '赠送金固定截止日期（YYYY-MM-DD）',
  bonusDays: '赠送金生效后有效天数',
  bonusValidity: '赠送金期限关系（同主卡 / 无期限）',
  coverage: '套餐适用服务（全部 / 不适用 / 仅限项目名）',
  bonusCoverage: '赠送金适用服务（全部 / 不适用 / 仅限项目名）',
  deduction: '扣减顺序（本金优先 / 赠送优先 / 初始比例）',
  fee: '本次消费计划的额外费用合计（元）',
  fixedDebit: '办卡前固定扣费原文（例如：洗护每次扣减80元）',
  transfer: '转让条件原文',
  extension: '延期条件原文',
  restrictions: '使用限制与附加收费原文',
  stacking: '折扣叠加或复杂扣减原文',
};
const rawFields = ['refund', 'schedule', 'reservation', 'transfer', 'extension', 'restrictions', 'stacking', 'fixedDebit'];
const statusLabels = {
  explicit: '已明确', missing: '当前资料未提及', ambiguous: '表述待核对',
  conflicting: '来源存在冲突', potential_risk: '需核查的权益条件',
};

const amount = String.raw`[¥￥]?(\d+(?:\.\d{1,2})?)(?![\d.])(?:元)?`;
const calendar = String.raw`(20\d{2})[年./-](\d{1,2})[月./-](\d{1,2})(?:日)?`;
const formatDate = match => [match[1], match[2].padStart(2, '0'), match[3].padStart(2, '0')].join('-');

function parseFixedDebit(quote) {
  const match = /^(.{1,80}?)每次(?:扣减|扣款|扣费|从卡内扣)[:：]?([¥￥]?)(\d+(?:\.\d{1,2})?)(元?)[。.]?$/
    .exec(String(quote ?? '').normalize('NFKC').replace(/\s+/g, ''));
  if (!match || (!match[2] && !match[4]) || /仅限|另收|除外|节假日|折扣|起|最低|最高|[：:；;，,。]/.test(match[1])) return null;
  return { serviceId: match[1], amount: match[3] };
}

function scan(line, add) {
  if (parseFixedDebit(line)) add('fixedDebit', line);
  let match;
  const findAmount = pattern => line.match(new RegExp(pattern + amount));
  if ((match = line.match(/^(?:商家(?:名称)?|门店(?:名称)?)[:：]([^:：]{2,40})$/))) add('merchant', match[1]);
  if ((match = line.match(/^(?:套餐|商品)名称[:：](.{2,60})$/))) add('title', match[1]);
  if ((match = findAmount('^(?:套餐价|套餐售价|会员价|售价)[:：]?'))) add('price', match[1]);
  if ((match = findAmount('^(?:订单实付|实际支付|已支付)[:：]?'))) add('actualPrice', match[1]);

  const recharge = line.match(new RegExp('^(?:储值卡[:：]?)?(?:充值|充)' + amount + '(?:赠送|赠|送)' + amount + '$'));
  if (recharge) {
    add('planType', '储值'); add('principal', recharge[1]); add('bonus', recharge[2]);
  }
  if ((match = findAmount('^(?:充值本金|本金金额|充值金额)[:：]?'))) {
    add('planType', '储值'); add('principal', match[1]);
  }
  if ((match = findAmount('^(?:赠送金额|赠送金|赠金)[:：]?'))) add('bonus', match[1]);
  if ((match = line.match(new RegExp('^' + amount + '(?:购买|购)(\\d+)次(.{0,35})$')))) {
    add('planType', '次数'); add('price', match[1]); add('total', match[2]); add('unit', '次');
  }
  if (/^(?:\d+次卡|验券后可间断使用\d+次)/.test(line)) add('planType', '次数');
  if ((match = line.match(new RegExp('^' + amount + '((?:半年|[一二三四五六七八九十\\d]+个月|一年).{0,25}(?:会员|会籍))$')))) {
    add('planType', '期限'); add('price', match[1]); add('title', match[2]);
  }
  if (/^(?:连续(?:使用)?\d+天|(?:期限|时间)会员)$/.test(line)) add('planType', '期限');
  if ((match = line.match(new RegExp('^(?:有效期|会员有效期|使用期限)[:：]' + calendar + '(?:至|到|—|~)')))) {
    add('fixedStart', formatDate(match));
  }
  if ((match = line.match(new RegExp('^(?:赠送金|赠金|赠送余额)(?:有效至|截止至|到期日[:：]?)' + calendar)))) {
    add('bonusEnd', formatDate(match));
  }
  if ((match = line.match(/^(?:赠送金|赠金)(?:自生效日起|自核销日起|生效后|核销后)(\d+)天(?:内)?有效$/))) add('bonusDays', match[1]);
  if (/^(?:有效期|主卡有效期|使用期限)[:：]?(?:无固定期限|长期有效)$/.test(line)) add('validityMode', '无期限');
  if (/^(?:赠送金|赠金)(?:有效期)?(?:与主卡相同|同主卡|随主卡到期)$/.test(line)) add('bonusValidity', '同主卡');
  if (/^(?:赠送金|赠金)(?:无固定期限|长期有效)$/.test(line)) add('bonusValidity', '无期限');
  if ((match = line.match(/^(?:适用服务|适用项目|使用范围)[:：.·](全部(?:项目|服务)?|仅限[^。；]+)$/))) add('coverage', match[1]);
  if ((match = line.match(/^(?:赠送金|赠金)(?:适用范围|适用服务|适用项目)?[:：]?(全部(?:项目|服务)?|仅限[^。；]+|不适用)$/))) add('bonusCoverage', match[1]);
  if (/^(?:扣减顺序[:：])?(?:本金优先|先扣本金)(?:，?再扣赠送金)?$/.test(line)) add('deduction', '本金优先');
  if (/^(?:扣减顺序[:：])?(?:赠送金优先|先扣赠送金)(?:，?再扣本金)?$/.test(line)) add('deduction', '赠送优先');
  if (/^(?:按初始本金与赠送金比例扣减|初始比例扣减)$/.test(line)) add('deduction', '初始比例');
  if (/转让|转赠|更名/.test(line)) add('transfer', line);
  if (/延期|延长有效期/.test(line)) add('extension', line);
  if (/节假日|不适用|除外|额外收费|另收|加收|另付|指定门店|最低消费|不可叠加|不能叠加|不与.*同享|仅限.*使用/.test(line)) {
    add('restrictions', line);
  }
  if (/折扣|按原价扣除|按原价扣款|(?<!不)(?:可|允许|同时)叠加优惠|固定比例扣减/.test(line)) add('stacking', line);
}

function conflictingRefund(clauses) {
  const signals = [];
  for (const fragment of clauses.flatMap(clause => clause.split(/[，,。；;\n]/))) {
    const denies = /不可退|不予退款|概不退款|不支持退款/.test(fragment);
    if (!denies && !/支持退款|可以退款|可申请退款|可退/.test(fragment)) continue;
    const scope = /(?:核销|验券|兑换)前/.test(fragment) ? 'before_activation' :
      /(?:核销|验券|兑换)后/.test(fragment) ? 'after_activation' :
      /未(?:使用|消费|核销)/.test(fragment) ? 'unused' :
      /部分|已(?:使用|消费)|使用后/.test(fragment) ? 'used' : 'unspecified';
    signals.push({ denies, scope, blanket: scope === 'unspecified' && /概不退款/.test(fragment) });
  }
  return signals.some(a => a.denies && signals.some(b => !b.denies && (a.blanket || a.scope === b.scope)));
}

function describeField(key, field, candidates = []) {
  const value = field?.value?.trim() || '';
  const accepted = field?.status === '用户核对' && Boolean(value);
  const values = [...new Set(candidates.map(item => item.value))];
  const clauses = [value, ...values].join(' ');
  const contradictoryRefund = key === 'refund' && conflictingRefund([value, ...values]);
  const risk = /概不退|不予退|不支持退款|不可退|不可转让|不得延期|最终解释权|节假日|加收|另收|额外收费|不可叠加/.test(clauses);
  if (!accepted && (contradictoryRefund || (!rawFields.includes(key) && values.length > 1))) return 'conflicting';
  if (risk) return 'potential_risk';
  if (accepted || (rawFields.includes(key) && values.length === 1 && (!value || value === values[0]))) return 'explicit';
  return value || values.length ? 'ambiguous' : 'missing';
}

const api = { labels, rawFields, statusLabels, scan, describeField, parseFixedDebit };
if (typeof module !== 'undefined') module.exports = api;
else root.KDZTerms = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
