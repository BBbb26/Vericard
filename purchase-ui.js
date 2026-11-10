'use strict';

function createPurchasePanel() {
  const wallet = window.KDZWallet;
  const node = id => document.getElementById(id);
  const panel = node('purchasePanel');
  const form = node('purchaseForm');
  const retry = node('purchaseRetry');
  const controls = node('purchaseTerms');
  let current = null;
  let controlsTag = null;
  let readRules = null;
  let busy = false;

  function select(parent, label, id, choices, selected) {
    const wrapper = document.createElement('label');
    wrapper.textContent = label + ' ';
    const input = document.createElement('select');
    input.id = id;
    for (const [value, caption] of choices) input.add(new Option(caption, value));
    input.value = selected;
    wrapper.append(input);
    parent.append(wrapper);
    return input;
  }

  function field(parent, label, id, type, value = '', { required = false, step = 1, min = 0 } = {}) {
    const wrapper = document.createElement('label');
    wrapper.textContent = label + ' ';
    const input = document.createElement('input');
    Object.assign(input, { id, type, value, required });
    if (type === 'number') Object.assign(input, { step, min });
    wrapper.append(input);
    parent.append(wrapper);
    return { wrapper, input };
  }

  function active(field, shown) {
    field.wrapper.hidden = !shown;
    field.input.disabled = !shown;
  }

  function validity(parent, id, label, source, allowSame = false) {
    const choices = [
      ['unknown', '待核对'], ['fixed', '固定日期'], ['from_activation', '生效后固定天数'],
      ['unlimited', '已确认无固定期限'],
    ];
    if (allowSame) choices.push(['same_as_plan', '同主卡有效期']);
    const kind = select(parent, label, id, choices, source?.kind ?? 'unknown');
    const start = field(parent, '固定起始日（可选）', id + 'Start', 'date', source?.startDate ?? '');
    const end = field(parent, '固定截止日', id + 'End', 'date', source?.endDate ?? '', { required: true });
    const days = field(parent, '有效天数（含生效日）', id + 'Days', 'number', source?.days ?? '', { required: true, min: 1 });
    const update = () => {
      active(start, kind.value === 'fixed');
      active(end, kind.value === 'fixed');
      active(days, kind.value === 'from_activation');
    };
    kind.addEventListener('change', update);
    update();
    return () => ({
      kind: kind.value,
      ...(kind.value === 'fixed' ? { startDate: start.input.value, endDate: end.input.value } : {}),
      ...(kind.value === 'from_activation' ? { days: days.input.value } : {}),
    });
  }

  function coverage(parent, id, label, source) {
    const summary = source?.kind === 'services' ? source.serviceIds.join('、') :
      source?.kind === 'all' ? '全部服务' : '不适用';
    const choices = [['unknown', '待核对'], ['all', '全部服务'], ['none', '不适用'], ['services', '指定服务']];
    if (source) choices.unshift(['source', '沿用已核对规则（' + summary + '）']);
    const kind = select(parent, label, id, choices, source ? 'source' : 'unknown');
    const names = field(parent, '服务名称（用顿号分隔）', id + 'Names', 'text', source?.serviceIds?.join('、') ?? '', { required: true });
    const update = () => active(names, kind.value === 'services');
    kind.addEventListener('change', update);
    update();
    return () => ({ kind: kind.value, ...(kind.value === 'services' ? { services: names.input.value } : {}) });
  }

  function fill(review) {
    const { rules, type } = review.plan;
    controls.replaceChildren();
    node('purchasePaid').value = wallet.yuan(review.actualPriceCents);
    node('purchaseDate').value = wallet.today();
    node('purchaseDate').max = wallet.today();
    node('purchaseActivation').value = '';
    node('purchaseConfirmed').checked = false;
    const readValidity = validity(controls, 'purchaseValidity', '实际主卡有效期', rules.validity);
    const readCoverage = coverage(controls, 'purchaseCoverage', '实际适用服务', rules.coverage);
    if (type === 'stored_value') {
      const principal = field(controls, '实际充值本金（元）', 'purchasePrincipal', 'number', wallet.yuan(rules.principalCents), { required: true, step: '.01' });
      const bonus = field(controls, '实际赠送金（元，无赠送填 0）', 'purchaseBonus', 'number', wallet.yuan(rules.bonusCents), { required: true, step: '.01' });
      const deduction = select(controls, '实际扣减顺序', 'purchaseDeduction', [
        ['unknown', '待核对'], ['principal_first', '本金优先'], ['bonus_first', '赠送金优先'], ['proportional', '按初始比例'],
      ], rules.deduction ?? 'unknown');
      const group = document.createElement('fieldset');
      group.className = 'input-grid purchase-bonus';
      const legend = document.createElement('legend');
      legend.textContent = '赠送金规则';
      group.append(legend);
      controls.append(group);
      const readBonusValidity = validity(group, 'purchaseBonusValidity', '赠送金有效期', rules.bonusValidity, true);
      const readBonusCoverage = coverage(group, 'purchaseBonusCoverage', '赠送金适用服务', rules.bonusCoverage);
      const update = () => {
        const shown = bonus.input.value !== '' && Number(bonus.input.value) > 0;
        group.hidden = !shown;
        group.disabled = !shown;
      };
      bonus.input.addEventListener('input', update);
      update();
      return () => ({
        validity: readValidity(), coverage: readCoverage(), principal: principal.input.value, bonus: bonus.input.value,
        deduction: deduction.value, bonusValidity: readBonusValidity(), bonusCoverage: readBonusCoverage(),
      });
    }
    if (type === 'visit_pack') {
      const visits = field(controls, '实际取得次数', 'purchaseVisits', 'number', rules.visits ?? '', { required: true, min: 1 });
      const redemption = select(controls, '实际扣次方式', 'purchaseRedemption', [
        ['unknown', '待核对'], ['per_visit', '每次到访扣一次'], ['per_day', '同一自然日扣一次'],
      ], rules.redemption ?? 'unknown');
      return () => ({ validity: readValidity(), coverage: readCoverage(), visits: visits.input.value, redemption: redemption.value });
    }
    return () => ({ validity: readValidity(), coverage: readCoverage() });
  }

  function key() { return 'purchase:' + current.payload.review.id; }

  async function save(usePending) {
    if (busy || !current || (!usePending && !form.reportValidity())) return;
    const operationKey = key();
    busy = true;
    node('purchaseSubmit').disabled = retry.disabled = true;
    node('purchaseStatus').textContent = '正在保存卡片…';
    try {
      const data = usePending ? undefined : {
        ...(current.payload.analysisId
          ? { source: { kind: 'agent', analysisId: current.payload.analysisId, reviewTag: current.payload.reviewTag } }
          : { groupId: current.payload.review.id, reviewTag: current.payload.reviewTag, analysisInput: current.input }),
        confirmedPurchase: node('purchaseConfirmed').checked,
        purchase: {
          paid: node('purchasePaid').value, purchasedOn: node('purchaseDate').value,
          activationDate: node('purchaseActivation').value, ...readRules(),
        },
      };
      const result = await wallet.write('/api/wallet/cards', operationKey, data);
      location.href = 'wallet.html?card=' + encodeURIComponent(result.cardId);
    } catch (error) {
      node('purchaseStatus').textContent = error.message;
      retry.hidden = !wallet.hasPending(operationKey);
    } finally {
      busy = false;
      node('purchaseSubmit').disabled = retry.disabled = false;
    }
  }

  form.addEventListener('submit', event => { event.preventDefault(); save(false); });
  retry.addEventListener('click', () => save(true));
  return {
    show(payload, input) {
      if (!payload.reviewTag || !payload.analysis || payload.review.demo) {
        this.hide();
        return;
      }
      current = { payload, input };
      const formTag = payload.analysisId ? payload.analysisId + ':' + payload.review.plan.version : payload.reviewTag;
      if (controlsTag !== formTag) {
        readRules = fill(payload.review);
        controlsTag = formTag;
      }
      panel.hidden = false;
      retry.hidden = !wallet.hasPending(key());
    },
    hide() {
      panel.hidden = true;
      current = null;
    },
  };
}
