'use strict';

window.KDZWalletEnroll = (() => {
  const W = window.KDZWallet;
  const options = [['','请选择卡型'],['stored_value','储值卡'],['visits','次数卡'],['period','期限会员'],['hours','时长包'],['single','已购未核销的单次券']];
  const labels = Object.fromEntries(options);

  function open({ offer = null, images = [], offerId = '', prefill = null, onSaved } = {}) {
    const comparing = Boolean(offer);
    const kind = comparing ? 'comparison' : 'manual';
    const operation = 'enroll:' + kind + (offerId ? ':' + offerId : '');
    const dialog = document.createElement('dialog');
    dialog.className = 'shell-dialog wallet-enroll';
    dialog.setAttribute('aria-label', comparing ? '登记实际购买' : '添加已有卡片');
    dialog.innerHTML = '<div class="section-heading"><h2></h2><button type="button" class="ghost">关闭</button></div>' +
      '<p class="muted" data-role="source"></p><form class="wallet-dialog-form"><div class="input-grid"></div>' +
      '<div class="actions"><button type="submit">确认并加入卡包</button><button type="button" class="secondary" data-role="retry" hidden>重试上次提交</button></div>' +
      '<p class="state-line" role="status" aria-live="polite" hidden></p></form>';
    dialog.querySelector('h2').textContent = prefill ? '确认开卡并加入卡包' : comparing ? '登记实际购买' : '添加已有卡片';
    const form = dialog.querySelector('form');
    const grid = form.querySelector('.input-grid');
    const status = form.querySelector('[role=status]');
    const retry = form.querySelector('[data-role=retry]');
    const close = dialog.querySelector('.ghost');
    let busy = false;
    let evidence = images.slice(0, 8);

    function field(label, type, value = '', required = false) {
      const wrapper = document.createElement('label');
      wrapper.textContent = label;
      const input = document.createElement('input');
      Object.assign(input,{ type,value,required });
      if (type === 'number') { input.min = '0'; input.step = '.01'; }
      wrapper.append(input);
      grid.append(wrapper);
      return { wrapper,input };
    }

    function select(label, choices, selected) {
      const wrapper = document.createElement('label');
      wrapper.textContent = label;
      const input = document.createElement('select');
      for (const [value, caption] of choices) input.add(new Option(caption,value));
      input.value = selected;
      wrapper.append(input);
      grid.append(wrapper);
      return { wrapper,input };
    }

    function setVisible(control, show) {
      control.wrapper.hidden = !show;
      control.input.disabled = !show;
    }

    function checked(label) {
      const { wrapper,input } = field('', 'checkbox', '', true);
      wrapper.className = 'page-check wallet-form-wide';
      wrapper.append(document.createTextNode(label));
      return { wrapper,input };
    }

    const sourceLine = dialog.querySelector('[data-role=source]');
    sourceLine.textContent = prefill?.sourceLine || (comparing ?
      '截图报价 ' + W.money(window.KDZCompare.cents(offer.price)) + '。请核对订单实付与实际取得的权益。' :
      '登记已经实际购买的权益。已有消费可在详情中补录或核对商家余额。');
    const photo = field('上传截图辅助填写（可选）','file');
    photo.input.accept = 'image/png,image/jpeg';
    photo.wrapper.className = 'wallet-form-wide';
    setVisible(photo,!comparing && !prefill?.imageIds?.length);
    const name = field('卡片名称','text',offer?.name ?? '',true);
    name.input.maxLength = 120;
    const type = select('卡型',options,offer?.type ?? '');
    type.input.required = true;
    type.input.disabled = comparing;
    const paid = field('实际支付（元）','number','',true);
    const purchased = field('购买日','date',W.today(),true);
    purchased.input.max = W.today();
    const activation = field('生效日（未知可留空）','date');
    const validity = select('有效期',[['unknown','待核对'],['fixed','固定截止日'],['from_activation','生效后固定天数'],['unlimited','无固定截止']], 'unknown');
    const start = field('固定起始日（可选）','date');
    const end = field('固定截止日','date','',true);
    const days = field('生效后有效天数','number','',true);
    days.input.step = days.input.min = '1';
    const scopes = [['unknown','待核对'],['all','不限项目'],['services','指定服务']];
    const coverage = select('适用范围',scopes,'unknown');
    const scope = field('适用服务（用顿号分隔）','text','',true);
    const principal = field('实际开卡本金（元）','number','',true);
    const bonus = field('实际开卡赠送金（元）','number','0',true);
    const deduction = select('扣减顺序',[['unknown','待核对'],['principal_first','本金优先'],['bonus_first','赠送金优先'],['proportional','按初始比例']], 'unknown');
    const bonusCoverage = select('赠送金适用范围',scopes,'unknown');
    const bonusScope = field('赠送金适用服务（用顿号分隔）','text','',true);
    const bonusValidity = select('赠送金期限',[['unknown','待核对'],['same_as_plan','同主卡'],['fixed','固定截止日'],['from_activation','生效后固定天数'],['unlimited','无固定截止']], 'unknown');
    const bonusEnd = field('赠送金固定截止日','date','',true);
    const bonusDays = field('赠送金生效后有效天数','number','',true);
    bonusDays.input.step = bonusDays.input.min = '1';
    const visits = field('实际取得次数','number','',true);
    visits.input.step = visits.input.min = '1';
    const redemption = select('核销方式',[['unknown','待核对'],['per_visit','按次'],['per_day','同日扣一次']], 'unknown');
    const minutes = field('实际取得时长（分钟）','number','',true);
    minutes.input.step = minutes.input.min = '1';
    const billing = field('核销单位（分钟，未知可留空）','number');
    billing.input.step = billing.input.min = '1';
    billing.input.max = '1440';
    const unused = checked('该单次券尚未核销');
    const confirm = checked('我已实际购买，并核对上述支付与权益。');

    function prefillFromOffer(values) {
      if (!name.input.value) name.input.value = values.name || '';
      if (!type.input.value && labels[values.type]) type.input.value = values.type;
      if (type.input.value === 'hours') {
        if (!minutes.input.value) minutes.input.value = values.units ?? '';
        if (!billing.input.value) billing.input.value = values.billing ?? '';
      }
      if (!visits.input.value && ['visits','single'].includes(type.input.value)) visits.input.value = type.input.value === 'single' ? '1' : values.units ?? '';
      if (type.input.value === 'visits' && redemption.input.value === 'unknown') {
        redemption.input.value = ({day:'per_day',visit:'per_visit'})[values.redemption] ?? 'unknown';
      }
      if (validity.input.value === 'unknown') {
        const modes = { relative:'from_activation', fixed:'fixed', unlimited:'unlimited' };
        validity.input.value = modes[values.validity] ?? 'unknown';
        start.input.value = values.from ?? '';
        end.input.value = values.until ?? '';
        days.input.value = values.days ?? '';
      }
    }

    function setValidity(selectControl, startControl, endControl, daysControl, value = {}) {
      const kind = ['fixed', 'from_activation', 'unlimited'].includes(value.kind) ? value.kind : 'unknown';
      selectControl.input.value = kind;
      if (kind === 'fixed') {
        startControl.input.value = value.startDate || '';
        endControl.input.value = value.endDate || '';
      }
      if (kind === 'from_activation') daysControl.input.value = value.days ?? '';
    }

    function setScope(selectControl, scopeControl, value = {}) {
      const kind = ['all', 'services'].includes(value.kind) ? value.kind : 'unknown';
      selectControl.input.value = kind;
      if (kind === 'services') {
        scopeControl.input.value = Array.isArray(value.services) ? value.services.join('、') : String(value.services || '');
      }
    }

    function applyPrefill(values = {}) {
      if (values.name) name.input.value = values.name;
      if (values.type && labels[values.type]) type.input.value = values.type;
      if (values.paid != null && values.paid !== '') paid.input.value = values.paid;
      else if (values.price != null && values.price !== '') paid.input.value = values.price;
      purchased.input.value = values.purchasedOn || W.today();
      activation.input.value = values.activationDate || '';
      setValidity(validity, start, end, days, values.validity);
      setScope(coverage, scope, values.coverage);
      if (values.principal != null) principal.input.value = values.principal;
      if (values.bonus != null) bonus.input.value = values.bonus;
      if (values.deduction && ['principal_first', 'bonus_first', 'proportional'].includes(values.deduction)) {
        deduction.input.value = values.deduction;
      }
      if (values.bonusCoverage) setScope(bonusCoverage, bonusScope, values.bonusCoverage);
      if (values.bonusValidity?.kind === 'same_as_plan') bonusValidity.input.value = 'same_as_plan';
      else if (values.bonusValidity) setValidity(bonusValidity, bonusEnd, bonusEnd, bonusDays, values.bonusValidity);
      if (values.visits != null && values.visits !== '') visits.input.value = values.visits;
      if (values.redemption && ['per_visit', 'per_day'].includes(values.redemption)) {
        redemption.input.value = values.redemption;
      }
      if (values.minutes != null && values.minutes !== '') minutes.input.value = values.minutes;
      if (values.billingMinutes != null && values.billingMinutes !== '') billing.input.value = values.billingMinutes;
      if (values.unredeemed != null) unused.input.checked = Boolean(values.unredeemed);
      if (values.sourceLine) sourceLine.textContent = values.sourceLine;
    }

    function update() {
      const cardType = type.input.value;
      const stored = cardType === 'stored_value';
      for (const control of [principal,bonus,deduction]) setVisible(control,stored);
      const hasBonus = stored && Number(bonus.input.value) > 0;
      for (const control of [bonusCoverage,bonusValidity]) setVisible(control,hasBonus);
      setVisible(bonusScope,hasBonus && bonusCoverage.input.value === 'services');
      setVisible(bonusEnd,hasBonus && bonusValidity.input.value === 'fixed');
      setVisible(bonusDays,hasBonus && bonusValidity.input.value === 'from_activation');
      setVisible(scope,coverage.input.value === 'services');
      setVisible(visits,cardType === 'visits' || cardType === 'single');
      setVisible(redemption,cardType === 'visits');
      setVisible(minutes,cardType === 'hours');
      setVisible(billing,cardType === 'hours');
      setVisible(unused,cardType === 'single');
      if (cardType === 'single') {
        visits.wrapper.firstChild.textContent = '已购未核销券数';
        if (!visits.input.value) visits.input.value = '1';
      } else visits.wrapper.firstChild.textContent = '实际取得次数';
      const value = validity.input.value;
      setVisible(start,value === 'fixed');
      setVisible(end,value === 'fixed');
      setVisible(days,value === 'from_activation');
    }

    function report(message, state) {
      status.textContent = message;
      status.dataset.state = state;
      status.hidden = false;
    }

    function setBusy(value) {
      busy = value;
      grid.inert = value;
      close.disabled = form.querySelector('[type=submit]').disabled = retry.disabled = value;
    }

    function scopeInput(mode, control) {
      const kind = mode.input.value;
      return { kind, ...(kind === 'services' ? {services:control.input.value.trim()} : {}) };
    }

    function purchase() {
      const cardType = type.input.value;
      const validityKind = validity.input.value;
      return {
        paid:paid.input.value, purchasedOn:purchased.input.value, activationDate:activation.input.value,
        validity:{ kind:validityKind, ...(validityKind === 'fixed' ? {startDate:start.input.value,endDate:end.input.value} : {}),
          ...(validityKind === 'from_activation' ? {days:days.input.value} : {}) },
        coverage:scopeInput(coverage,scope),
        ...(cardType === 'stored_value' ? {principal:principal.input.value,bonus:bonus.input.value,deduction:deduction.input.value,
          bonusCoverage:scopeInput(bonusCoverage,bonusScope),
          bonusValidity:{kind:bonusValidity.input.value,
            ...(bonusValidity.input.value === 'fixed' ? {endDate:bonusEnd.input.value} : {}),
            ...(bonusValidity.input.value === 'from_activation' ? {days:bonusDays.input.value} : {})}} : {}),
        ...(cardType === 'visits' || cardType === 'single' ? { visits:visits.input.value, redemption:redemption.input.value } : {}),
        ...(cardType === 'hours' ? {minutes:minutes.input.value,billingMinutes:billing.input.value} : {}),
        ...(cardType === 'single' ? { unredeemed:unused.input.checked } : {}),
      };
    }

    async function save(replay) {
      if (busy || (!replay && !form.reportValidity())) return;
      setBusy(true);
      report('正在保存卡片…','loading');
      try {
        const data = replay ? undefined : { confirmedPurchase:confirm.input.checked,
          source:{ kind,name:name.input.value,type:type.input.value,imageIds:evidence.map(image => image.id), ...(comparing ? {offer} : {}) },
          purchase:purchase(),
        };
        const { cardId } = await W.write('/api/wallet/cards',operation,data);
        dialog.close();
        if (onSaved) onSaved(cardId);
        else location.href = 'wallet.html?card=' + encodeURIComponent(cardId);
      } catch (error) { report(error.message,'error'); }
      finally { setBusy(false); retry.hidden = !W.hasPending(operation); }
    }

    photo.input.addEventListener('change', async () => {
      const file = photo.input.files[0];
      if (!file || busy) return;
      setBusy(true);
      report('正在读取本机截图…','loading');
      try {
        const image = await W.request('/api/upload',{name:file.name,base64:await W.fileData(file,12)});
        evidence = [image];
        image.ocr ??= await W.request('/api/ocr',{id:image.id});
        const values = window.KDZCompare.draft(evidence).values;
        if (!values.type && window.KDZExtract.extract(image).some(item => item.field === 'planType' && item.value === '储值')) values.type = 'stored_value';
        prefillFromOffer(values);
        update();
        report('截图已关联，请核对识别信息并填写实际支付。','success');
      } catch (error) { report(error.message + (evidence.length ? ' 已关联的原图可保留。' : ''),'warning'); }
      finally { setBusy(false); }
    });
    close.addEventListener('click',() => dialog.close());
    dialog.addEventListener('cancel',event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close',() => dialog.remove(),{once:true});
    form.addEventListener('submit',event => { event.preventDefault(); save(false); });
    retry.addEventListener('click',() => save(true));
    retry.hidden = !W.hasPending(operation);
    type.input.addEventListener('change',update);
    validity.input.addEventListener('change',update);
    coverage.input.addEventListener('change',update);
    bonusCoverage.input.addEventListener('change',update);
    bonusValidity.input.addEventListener('change',update);
    bonus.input.addEventListener('input',update);
    if (offer) prefillFromOffer(offer);
    if (prefill) applyPrefill(prefill);
    update();
    document.body.append(dialog);
    dialog.showModal();
  }

  return { open };
})();

