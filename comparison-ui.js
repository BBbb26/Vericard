if (typeof crypto !== 'undefined' && !crypto.randomUUID) { crypto.randomUUID = function(){return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0,v=c==='x'?r:(r&3|8);return v.toString(16)})}; }
'use strict';

(() => {
  const C = window.KDZCompare, W = window.KDZWallet;
  const $ = id => document.getElementById(id);
  const weekLabels = ['日','一','二','三','四','五','六'];
  const draftKey = 'kdz-comparison-1';
  const descriptions = {
    name:'方案名称', type:'购买方式', price:'套餐报价（元）', units:'权益次数', from:'生效日（可选）', until:'截止日',
    days:'核销或激活后有效天数', purchaseDays:'购买后有效天数（选填）', validity:'有效期', limit:'最多购买几份（0 表示不限）', window:'可用时段',
    opens:'开始时间（如 08:00）', closes:'结束时间（可填 24:00）', weekdays:'可用日期',
    workdayOpens:'工作日开始', workdayCloses:'工作日结束', weekendOpens:'周末开始', weekendCloses:'周末结束',
    visitMax:'单次最长分钟数（0 表示不限）', redemption:'核销方式',
    billing:'计费步长（分钟）', minimum:'最低扣减分钟数（0 表示无最低）',
    restrictionsChecked:'其他限制',
  };
  const menus = {
    type:C.labels, validity:{ fixed:'固定日期', relative:'从激活日起计', unlimited:'无固定期限' },
    window:{ all:'不限时段', restricted:'指定日期与时段', split:'工作日与周末分开' }, weekdays:{ all:'每天', workdays:'工作日', weekends:'周末' },
    redemption:{ visit:'按到访扣一次', day:'同日只扣一次' },
  };
  const params = new URLSearchParams(location.search);
  const analysisId = params.get('analysisId');
  const profileIds = ['cupCount','studyFrequency','studyHours','studyWeeks','profileStart','profileTime','coffeeGap','sameProduct','allowMix'];
  const imagesById = new Map();
  let offers = [], confirmed = false, mode = 'coffee', hasResult = false, busy = false, lastUploadId = null;
  let previewOptions = null, reviewingOffer = null, quickFrame = 0;
  let arrivalPlan = null, visitOffsets = null, countVisitOffsets = null, resultView = 'curve', visualization = null;
  let calendarPage = 0, verificationQuestions = [], merchantDraft = null;
  const arrivalHistory = [];
  const compareColors = ['var(--color-primary)','var(--color-info)','var(--color-chart-teal)','var(--color-chart-gold)','var(--color-chart-rose)','var(--color-text-secondary)'];

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function button(label, action, className = 'secondary') {
    const node = el('button', label, className);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  }

  function announce(text, tone = 'neutral') {
    $('compareStatus').textContent = text;
    $('compareStatus').dataset.state = tone;
  }

  function warning(id, text = '') {
    $(id).textContent = text;
    $(id).hidden = !text;
  }

  function daysSelected() {
    return [...$('weekdays').querySelectorAll('input:checked')].map(input => Number(input.value));
  }

  function save() {
    const form = Object.fromEntries(profileIds.map(id => [id, $(id).type === 'checkbox' ? $(id).checked : $(id).value]));
    try {
      sessionStorage.setItem(draftKey, JSON.stringify({ offers, images:[...imagesById.values()], confirmed, hasResult, mode, lastUploadId, form, arrivalPlan, visitOffsets, countVisitOffsets, resultView, weekdays:daysSelected() }));
    } catch {
      announce('当前内容可继续比较，浏览器空间不足，刷新后可能无法恢复。', 'warning');
    }
  }

  function restore() {
    try {
      const draft = JSON.parse(sessionStorage.getItem(draftKey));
      if (!draft) return;
      offers = draft.offers;
      for (const image of draft.images) imagesById.set(image.id, image);
      ({ confirmed, hasResult, mode } = draft);
      arrivalPlan = C.arrivalCandidate(draft.arrivalPlan);
      visitOffsets = Array.isArray(draft.visitOffsets) ? draft.visitOffsets : null;
      countVisitOffsets = Array.isArray(draft.countVisitOffsets) ? draft.countVisitOffsets : null;
      resultView = ['curve','prices','calendar'].includes(draft.resultView) ? draft.resultView : 'curve';
      lastUploadId = Object.hasOwn(draft, 'lastUploadId') ? draft.lastUploadId : offers.at(-1)?.imageIds.at(-1) ?? null;
      for (const id of profileIds) $(id)[$(id).type === 'checkbox' ? 'checked' : 'value'] = draft.form[id];
      $('weekdays').querySelectorAll('input').forEach(input => { input.checked = draft.weekdays.includes(Number(input.value)); });
    } catch {
      offers = [];
      imagesById.clear();
      lastUploadId = null;
      visitOffsets = countVisitOffsets = null;
      confirmed = hasResult = false;
    }
  }

  function createOffer(images = []) {
    return { id:crypto.randomUUID(), imageIds:images, edits:{}, history:[] };
  }

  function material(offer) {
    const images = offer.imageIds.map(id => imagesById.get(id)).filter(Boolean);
    const data = C.draft(images, offer.edits.type);
    const values = { ...data.values, ...offer.edits };
    const legacyEmptyWindow = values.window === 'restricted' && !values.opens && !values.closes && !values.weekdays;
    if (legacyEmptyWindow && data.values.window === 'split') values.window = 'split';
    let purchaseNote = '';
    if (!Object.hasOwn(offer.edits, 'limit') && ['visits','hours','single'].includes(values.type)) {
      const requested = conversationLimit(offer);
      const recorded = values.limit === '' ? null : Number(values.limit);
      const limit = C.effectivePurchaseLimit(recorded, requested);
      if (requested !== null && recorded > 0 && requested > recorded) {
        purchaseNote = '对话提供 ' + requested + ' 份，截图限购 ' + recorded + ' 份，按截图试算。';
      } else if (requested !== null) {
        values.limit = String(limit);
        values.purchaseAssumed = limit !== recorded;
        if (values.purchaseAssumed) purchaseNote = '按对话提供的条件试算最多购买 ' + limit + ' 份。';
      }
    }
    return { images, candidates:data.candidates, values, purchaseNote };
  }

  function conversationLimit(offer) {
    const id = offer.agentAnalysisId ?? analysisId;
    if (!id) return null;
    try {
      const saved = JSON.parse(sessionStorage.getItem('kdz-agent-questions'));
      if (saved?.id !== id) return null;
      const limits = offer.imageIds.map(imageId => saved.purchaseLimits?.[imageId])
        .filter(value => Number.isInteger(value) && value > 0 && value <= 1000);
      return limits.length === 1 ? limits[0] : null;
    } catch {
      return null;
    }
  }

  function invalidate() {
    previewOptions = reviewingOffer = null;
    confirmed = hasResult = false;
    $('sameProduct').checked = $('allowMix').checked = false;
    $('profileSection').hidden = $('resultSection').hidden = true;
    warning('offerError');
  }

  function edit(offer, field, value, before, source) {
    if (value === before) return;
    offer.edits[field] = value;
    offer.history.push({ at:new Date().toISOString(), field, before, value, source });
    if (offer.history.length > 120) offer.history.shift();
    if (reviewingOffer === offer && !['name','type','price','units'].includes(field)) {
      previewOptions = null;
      hasResult = false;
      $('resultSection').hidden = true;
    } else invalidate();
    save();
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(Error('无法读取截图。'));
      reader.readAsDataURL(file);
    });
  }

  async function recognize(image) {
    try {
      image.ocr ||= await W.request('/api/ocr', { id:image.id });
      if (!image.ocr?.lines?.length) throw Error('没有读到文字，可换一张更清晰的截图。');
      delete image.error;
    } catch (error) {
      if (!image.ocr?.lines?.length) image.ocr = null;
      image.error = error.message;
    }
  }

  function setBusy(value) {
    busy = value;
    $('offerList').inert = value;
    $('compareFiles').disabled = $('addOffer').disabled = $('confirmOffers').disabled =
      $('regroupOffers').disabled = $('importAgentOffer').disabled = value;
  }

  async function importAgentOffer(analysisId) {
    if (busy) return;
    if (offers.length >= 5) {
      announce('比较面板已有 5 个方案。移除一个后可以再带入。', 'warning');
      return;
    }
    setBusy(true);
    try {
      const endpoint = '/api/agent/sessions/' + encodeURIComponent(analysisId);
      const [{ name, images }, session] = await Promise.all([W.request(endpoint + '/comparison'), W.request(endpoint)]);
      if (!images.length) throw Error('这份分析没有可带入的截图。');
      const byId = new Map(images.map(image => [image.id, image]));
      const ordered = session.images.map(image => byId.get(image.id)).filter(Boolean);
      const { groups, unmatched } = C.groupPackages(ordered);
      const existing = new Set(offers.flatMap(offer => offer.imageIds));
      const fresh = groups.filter(group => !group.some(image => existing.has(image.id)));
      if (!fresh.length) {
        announce('比较面板已有这份分析中的截图。可在现有方案里继续核对。', 'warning');
        return;
      }
      if (offers.length + fresh.length > 5) {
        announce('带入这些套餐会超过 5 个方案。移除现有方案后再试。', 'warning');
        return;
      }
      for (const group of fresh) {
        for (const image of group) imagesById.set(image.id, image);
        const offer = createOffer(group.map(image => image.id));
        offer.agentAnalysisId = analysisId;
        const title = groups.length === 1 ? name : C.draft(group).values.name;
        if (title) offer.edits.name = title;
        offers.push(offer);
      }
      lastUploadId = null;
      invalidate();
      render();
      const tail = unmatched.length ? ' ' + unmatched.length + ' 张未分组截图需要手动补入。' : '';
      announce('已带入 ' + fresh.length + ' 个套餐。核对价格和条款后即可继续。' + tail,
        unmatched.length ? 'warning' : 'success');
      save();
    } catch (error) {
      announce(error.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function addScreenshot(offer, id) {
    offer.imageIds.push(id);
    if (offer.edits.restrictionsChecked) offer.edits.restrictionsChecked = '';
  }

  function matchingPrevious(offer, image) {
    return offer && offer.imageIds.length < 8 &&
      C.matchesPrevious(offer.imageIds.map(id => imagesById.get(id)).filter(Boolean), image);
  }

  function regroup() {
    let joined = 0;
    const arranged = [];
    for (const offer of offers) {
      const previous = arranged.at(-1);
      const image = imagesById.get(offer.imageIds[0]);
      if (offer.imageIds.length === 1 && !Object.keys(offer.edits).length && !offer.history.length &&
          !offer.separate && image && matchingPrevious(previous, image)) {
        addScreenshot(previous, image.id);
        joined++;
      } else arranged.push(offer);
    }
    if (!joined) {
      announce('没有发现可合并的相邻同价截图。可在卡片里手动调整归组。');
      return;
    }
    offers = arranged;
    invalidate();
    render();
    save();
    announce('按底部价格合并了 ' + joined + ' 张图，共 ' + offers.length + ' 个方案。', 'success');
  }

  async function upload(files, target) {
    if (busy || !files.length) return;
    setBusy(true);
    const notes = [];
    let joined = 0;
    try {
      for (const file of files) {
        if (target && target.imageIds.length >= 8) {
          notes.push('一个方案最多添加 8 张图。');
          break;
        }
        if (file.size > 12 * 1024 * 1024) {
          notes.push(file.name + '超过 12 MB。');
          lastUploadId = null;
          continue;
        }
        announce('正在识别 ' + file.name, 'loading');
        try {
          const image = await W.request('/api/upload', { name:file.name, base64:await readFile(file) });
          if (offers.some(offer => offer.imageIds.includes(image.id))) {
            if (!target) lastUploadId = image.id;
            notes.push(file.name + ' 已在比较中。');
            continue;
          }
          await recognize(image);
          const previous = offers.find(offer => offer.imageIds.includes(lastUploadId));
          const attach = target || (matchingPrevious(previous, image) ? previous : null);
          if (!attach && offers.length >= 5) {
            notes.push(file.name + ' 无法归入上一个方案，已达到 5 个方案上限。');
            lastUploadId = null;
            continue;
          }
          imagesById.set(image.id, image);
          if (attach) {
            addScreenshot(attach, image.id);
            if (!target) joined++;
          } else offers.push(createOffer([image.id]));
          lastUploadId = image.id;
          if (image.error) notes.push(file.name + ' 未识别，可单独重试。');
          invalidate();
          render();
          save();
        } catch (error) {
          notes.push(file.name + ' · ' + error.message);
          lastUploadId = null;
        }
      }
      const summary = joined ? '识别完成，按底部价格合并了 ' + joined + ' 张截图。' : '识别完成。核对方案后即可填写用法。';
      announce(notes.length ? summary + ' ' + notes.join(' ') : summary, notes.length ? 'warning' : 'success');
      save();
    } finally {
      setBusy(false);
    }
  }


  function openSource(image, quote, box, reviewAction) {
    const picture = $('sourceImage'), frame = $('sourceBox');
    picture.src = $('sourceFull').href = image.url;
    $('sourceQuote').textContent = quote || image.name;
    frame.hidden = !box || !image.ocr?.width || !image.ocr?.height;
    if (!frame.hidden) Object.assign(frame.style, {
      left:box.x / image.ocr.width * 100 + '%', top:box.y / image.ocr.height * 100 + '%',
      width:box.width / image.ocr.width * 100 + '%', height:box.height / image.ocr.height * 100 + '%',
    });
    const review = $('sourceReview');
    review.hidden = !reviewAction;
    review.onclick = reviewAction ? () => {
      $('sourceDialog').close();
      reviewAction();
    } : null;
    $('sourceDialog').showModal();
    $('sourceScroll').scrollTop = 0;
    if (!frame.hidden) picture.decode().then(() => {
      if (picture.getAttribute('src') === image.url) $('sourceScroll').scrollTop = Math.max(0, frame.offsetTop - 45);
    }).catch(() => {});
  }

  function field(offer, key, values, label = descriptions[key]) {
    const caption = el('label', label, key === 'name' ? 'wide' : '');
    const control = el(menus[key] ? 'select' : 'input');
    control.dataset.field = key;
    if (menus[key]) {
      const blank = el('option', key === 'type' ? '请选择' : '暂不清楚');
      blank.value = '';
      control.append(blank);
      for (const [value, text] of Object.entries(menus[key])) {
        const option = el('option', text);
        option.value = value;
        control.append(option);
      }
    } else if (['from','until'].includes(key)) control.type = 'date';
    else if (['price','units','days','purchaseDays','limit','visitMax','billing','minimum'].includes(key)) {
      control.inputMode = key === 'price' ? 'decimal' : 'numeric';
      control.placeholder = key === 'price' ? '例如 29.50' : '';
    }
    control.value = values[key] || '';
    control.addEventListener('input', () => {
      const before = Object.hasOwn(offer.edits, key) ? offer.edits[key] : values[key];
      edit(offer, key, control.value, before, '用户填写');
      const article = control.closest('article');
      const summary = article.querySelector('[data-summary="' + key + '"]');
      const terms = article.querySelector('[data-role="terms"] > summary');
      if (terms) terms.textContent = termSummary({ ...values, ...offer.edits }, terms.parentElement.dataset.schedulePending === 'true');
      if (summary) {
        if (key === 'units') {
          summary.textContent = unitSummary(values.type,control.value);
          summary.hidden = !summary.textContent;
        } else summary.textContent = key === 'price' ? W.money(C.cents(control.value)) : control.value.trim() || '待核对标题';
      }
    });
    if (['type','validity','window'].includes(key)) control.addEventListener('change', () => {
      const wasOpen = control.closest('details')?.open;
      render();
      const next = $('offer-' + offer.id).querySelector('[data-field="' + key + '"]');
      if (wasOpen) next.closest('details').open = true;
      next?.focus();
    });
    caption.append(control);
    return caption;
  }

  function details(title, content) {
    const node = el('details');
    node.append(el('summary', title), content);
    return node;
  }

  function evidence(offer, images, candidates, values) {
    const area = el('div', undefined, 'compare-sources');
    if (!images.length) area.append(el('p', '手动录入。可添加截图补充依据。', 'muted'));
    for (const image of images) {
      const row = el('div', undefined, 'compare-candidate');
      row.append(el('small', image.name), button('看原图', () => openSource(image)));
      if (image.error || !image.ocr) row.append(el('small', image.error || '识别未完成'),
        button('重试识别', async () => {
          if (busy) return;
          setBusy(true);
          announce('正在重新识别 ' + image.name, 'loading');
          try {
            await recognize(image);
            if (offer.edits.restrictionsChecked) offer.edits.restrictionsChecked = '';
            invalidate();
            render();
            announce(image.error || '识别完成。手动填写的内容已保留。', image.error ? 'warning' : 'success');
            save();
          } finally { setBusy(false); }
        }));
      if (image.ocr?.lines?.length) row.append(details('OCR 原文',
        el('pre', image.ocr.lines.map(line => line.text).join('\n'), 'raw-text')));
      if (images.length > 1 && offers.length < 5) row.append(button('拆为独立方案', () => {
        offer.imageIds = offer.imageIds.filter(id => id !== image.id);
        offers.push({ ...createOffer([image.id]), separate:true });
        invalidate(); render(); save();
      }, 'ghost'));
      area.append(row);
    }
    for (const item of (candidates.footer ?? []).slice(0, 8)) {
      const image = imagesById.get(item.imageId);
      if (!image) continue;
      const row = el('div', undefined, 'compare-candidate');
      row.append(el('small', '底部报价 · ' + item.quote), button('定位底部报价', () => openSource(image, item.quote, item.box)));
      area.append(row);
    }
    for (const item of (candidates.unmodeled ?? []).slice(0, 8)) {
      const image = imagesById.get(item.imageId);
      if (!image) continue;
      const row = el('div', undefined, 'compare-candidate');
      row.append(el('small', item.quote), button('定位原文', () => openSource(image, item.quote, item.box)));
      area.append(row);
    }
    for (const key of C.fields) {
      const choices = candidates[key] ?? [];
      const different = new Set(choices.map(item => item.value)).size > 1;
      for (const item of choices.slice(0, different ? 4 : 1)) {
        const image = imagesById.get(item.imageId);
        if (!image) continue;
        const value = menus[key]?.[item.value] ?? item.value;
        const row = el('div', undefined, 'compare-candidate');
        row.append(el('small', descriptions[key] + ' · ' + value + ' · ' + item.quote), button('定位原文', () => openSource(image, item.quote, item.box)));
        if (different && item.value !== values[key]) row.append(button('采用此候选', () => {
          edit(offer, key, item.value, values[key], '采用 OCR 候选 · ' + item.quote);
          render();
        }, 'ghost'));
        area.append(row);
      }
    }
    if (offer.history.length) area.append(details('修改历史', el('pre', offer.history.map(item =>
      new Date(item.at).toLocaleString('zh-CN') + ' · ' + descriptions[item.field] + ' · ' +
      (item.before || '空') + ' → ' + (item.value || '空') + ' · ' + item.source).join('\n'), 'raw-text')));
    return details('查看依据与修改历史', area);
  }

  function unitSummary(type, value) {
    if (type === 'single') return '单次使用';
    if (value && type === 'visits') return value + ' 次权益';
    if (value && type === 'hours') return value + ' 分钟权益';
    return '';
  }

  function termSummary(values, schedulePending) {
    const expiry = values.validity === 'fixed' && values.until ? '有效至 ' + values.until :
      values.validity === 'relative' && values.days ? (values.type === 'period'
        ? '连续使用 ' + values.days + ' 天' : '核销或激活后 ' + values.days + ' 天有效') :
      values.validity === 'unlimited' ? '无固定期限' : '';
    const purchase = values.purchaseDays ? '购买后 ' + values.purchaseDays + ' 天内有效' : '';
    const split = ['workdayOpens','workdayCloses','weekendOpens','weekendCloses'].every(key => values[key]);
    const window = values.window === 'split' && split ? '工作日 ' + values.workdayOpens + '–' + values.workdayCloses +
      '，周末 ' + values.weekendOpens + '–' + values.weekendCloses :
      values.window === 'restricted' && values.opens && values.closes
      ? [menus.weekdays[values.weekdays], values.opens + '–' + values.closes].filter(Boolean).join(' ')
      : values.window === 'all' ? '不限时段' : schedulePending ? '时段待核对' : '';
    const limit = values.limit ? (values.limit === '0' ? '不限购' : '限购 ' + values.limit + ' 份') : '';
    return [purchase, expiry || (purchase ? '核销后期限待核对' : '有效期待确认'), window, limit, '编辑限制'].filter(Boolean).join(' · ');
  }

  function renderOffer(offer, index) {
    const { images, candidates, values, purchaseNote } = material(offer);
    const node = el('article', undefined, 'panel compare-card');
    node.id = 'offer-' + offer.id;
    node.dataset.offerType = values.type || 'unknown';
    const title = el('h3', values.name || '待核对标题');
    title.dataset.summary = 'name';
    const price = el('strong', W.money(C.cents(values.price)), 'compare-card-price');
    price.dataset.summary = 'price';
    const heading = el('div', undefined, 'compare-card-summary');
    heading.append(title, price);
    const status = !images.length ? '手动添加' : images.some(image => image.error || !image.ocr) ? '识别需检查' : images.length + ' 张截图';
    const type = C.labels[values.type];
    const metadata = ['方案 ' + (index + 1), type, status].filter(Boolean).join(' · ');
    node.append(heading, el('span', metadata, 'badge'));
    const units = el('p',unitSummary(values.type,values.units),'compare-offer-units');
    units.dataset.summary = 'units';
    units.hidden = !units.textContent;
    node.append(units);
    if (purchaseNote) node.append(el('p', purchaseNote, 'muted'));
    if (images.length) {
      const previews = el('div', undefined, 'compare-previews');
      for (const [number, image] of images.slice(0, 3).entries()) {
        const preview = button('查看第 ' + (number + 1) + ' 张截图', () => openSource(image), 'ghost');
        preview.setAttribute('aria-label', preview.textContent);
        const photo = el('img');
        photo.src = image.url;
        photo.alt = '';
        photo.loading = 'lazy';
        preview.replaceChildren(photo);
        previews.append(preview);
      }
      if (images.length > 3) previews.append(el('span', '+' + (images.length - 3), 'muted'));
      node.append(previews);
    }
    const fields = el('div', undefined, 'compare-fields');
    for (const key of ['name','type','price']) fields.append(field(offer, key, values));
    if (values.type === 'visits' || values.type === 'hours') fields.append(field(offer, 'units', values, values.type === 'hours' ? '总可用分钟' : '权益次数'));
    const editor = details('编辑识别结果', fields);
    editor.open = !values.name || !type || C.cents(values.price) === null ||
      ((values.type === 'hours' || values.type === 'visits') && !values.units);
    node.append(editor);

    const purchaseCandidates = [...new Set((candidates.purchaseDays ?? []).map(item => item.value))];
    if (!values.purchaseDays && purchaseCandidates.length > 1) {
      node.append(el('p', '购买后期限有 ' + purchaseCandidates.map(days => days + ' 天').join('、') + ' 等写法，请核对原图。', 'state-line'));
    }
    const conflicting = ['name','type','price','units','until','days','limit'].filter(key =>
      !values[key] && new Set((candidates[key] ?? []).map(item => key === 'price' ? C.cents(item.value) : item.value)).size > 1);
    if (!values.validity && [candidates.validity, candidates.days, candidates.until].filter(items => items?.length).length > 1) {
      conflicting.push('有效期起算方式');
    }
    if (conflicting.length) node.append(el('p', conflicting.map(key => descriptions[key]).join('、') + '有多个候选，请核对依据。', 'state-line'));
    const terms = el('div', undefined, 'compare-fields');
    const termKeys = ['purchaseDays','validity','limit','window'];
    if (values.validity === 'fixed') termKeys.push('from','until');
    if (values.validity === 'relative') termKeys.push('days');
    if (values.window === 'restricted') termKeys.push('weekdays','opens','closes');
    if (values.window === 'split') termKeys.push('workdayOpens','workdayCloses','weekendOpens','weekendCloses');
    if (values.type === 'visits' || values.type === 'period') termKeys.push('visitMax');
    if (values.type === 'visits') termKeys.push('redemption');
    if (values.type === 'hours') termKeys.push('billing','minimum');
    for (const key of termKeys) terms.append(field(offer, key, values));
    const schedulePending = candidates.unmodeled?.some(item => item.value === '时段需核对') ?? false;
    const termDetails = details(termSummary(values, schedulePending), terms);
    termDetails.dataset.role = 'terms';
    termDetails.dataset.schedulePending = String(schedulePending);
    termDetails.open = reviewingOffer === offer;
    node.append(termDetails);
    if (candidates.unmodeled?.length) {
      const caption = el('label', undefined, 'page-check');
      const check = el('input');
      check.type = 'checkbox';
      check.dataset.field = 'restrictionsChecked';
      check.checked = values.restrictionsChecked === 'yes';
      check.addEventListener('change', () => edit(offer, 'restrictionsChecked', check.checked ? 'yes' : '', offer.edits.restrictionsChecked ?? '', '用户核对'));
      caption.append(check, document.createTextNode('我已查看原文，本次计划符合其余限制'));
      terms.append(caption);
    }
    if (reviewingOffer === offer) {
      const footer = el('div', undefined, 'compare-review-return');
      const error = el('p', undefined, 'state-line');
      error.dataset.state = 'error';
      error.setAttribute('role', 'status');
      error.hidden = true;
      footer.append(button('保存核对并返回结果', () => {
        try {
          previewOptions = getOffers();
          reviewingOffer = null;
          calculate(true);
          footer.remove();
        } catch (reason) {
          error.textContent = reason.message;
          error.hidden = false;
        }
      }), error);
      termDetails.append(footer);
    }
    node.append(evidence(offer, images, candidates, values));
    const actions = el('div', undefined, 'actions');
    const add = el('label', '补充截图', 'button secondary compare-file');
    const file = el('input');
    file.type = 'file'; file.accept = 'image/png,image/jpeg'; file.multiple = true;
    file.addEventListener('change', () => upload([...file.files], offer));
    add.append(file);
    actions.append(add, button('移除方案', () => {
      offers = offers.filter(item => item !== offer);
      discardUnused();
      invalidate(); render(); save();
    }, 'ghost'));
    node.append(actions);
    if (images.length && offers.length > 1) {
      const merge = el('select');
      const prompt = el('option', '将这些图片合并到另一方案');
      prompt.value = '';
      merge.append(prompt);
      for (const [number, target] of offers.entries()) {
        if (target === offer) continue;
        const item = el('option', '方案 ' + (number + 1) + ' · ' + (material(target).values.name || '未命名'));
        item.value = target.id;
        merge.append(item);
      }
      merge.addEventListener('change', () => {
        const target = offers.find(item => item.id === merge.value);
        if (!target) return;
        if (target.imageIds.length + offer.imageIds.length > 8) {
          warning('offerError', '合并后一个方案最多保留 8 张图。');
          merge.value = '';
          return;
        }
        if (Object.keys(offer.edits).length && !window.confirm('将图片合并到目标方案。当前方案的手填值不会覆盖目标方案，是否继续？')) {
          merge.value = '';
          return;
        }
        target.imageIds.push(...offer.imageIds);
        target.history = [...target.history, ...offer.history].sort((a, b) => a.at.localeCompare(b.at)).slice(-120);
        if (target.edits.restrictionsChecked) target.edits.restrictionsChecked = '';
        offers = offers.filter(item => item !== offer);
        invalidate(); render(); save();
      });
      const caption = el('label', undefined, 'muted');
      merge.setAttribute('aria-label', '将本方案的图片合并到另一方案');
      caption.append(merge);
      node.append(details('调整图片归组', caption));
    }
    return node;
  }

  function discardUnused() {
    const ids = new Set(offers.flatMap(offer => offer.imageIds));
    if (!ids.has(lastUploadId)) lastUploadId = null;
    for (const id of imagesById.keys()) if (!ids.has(id)) imagesById.delete(id);
  }

  function render() {
    $('optionsSection').hidden = !offers.length;
    $('offerCount').textContent = offers.length + ' 个方案';
    $('regroupOffers').hidden = offers.length < 2;
    $('offerList').replaceChildren(...offers.map(renderOffer));
    $('profileSection').hidden = !confirmed;
    updateMode();
    syncWeekdayFields();
  }

  function updateMode() {
    const study = mode === 'study';
    $('coffeeFields').hidden = $('coffeeGapLabel').hidden = study;
    $('studyFields').hidden = $('weekdays').hidden = $('profileArrivalAsk').hidden = !study;
    const types = offers.map(offer => material(offer).values.type);
    $('mixLabel').hidden = study || types.length !== 2 || !types.includes('single') || !types.includes('visits');
  }

  function getOffers() {
    if (offers.length < 2) throw Error('至少添加两个购买方案。');
    return offers.map((offer, index) => {
      const { values:raw, candidates } = material(offer);
      raw.restrictionsPending = Boolean(candidates.unmodeled?.length && raw.restrictionsChecked !== 'yes');
      raw.purchaseDaysConflict = !raw.purchaseDays && new Set((candidates.purchaseDays ?? []).map(item => item.value)).size > 1;
      const max = raw.stackingBlocked ? 1 : Number(raw.limit) || 1000;
      if (raw.type === 'visits' && offer.trialQuantity <= max) raw.trialQuantity = offer.trialQuantity;
      if (!raw.name) raw.name = (C.labels[raw.type] || '方案') + ' ' + (index + 1);
      return C.makeOffer(raw, index);
    });
  }

  function profile(arrivals = arrivalPlan) {
    const hours = Number($('studyHours').value);
    const minutes = hours * 60;
    const weekdays = daysSelected();
    const time = arrivals ? arrivals.time || '' : $('profileTime').value;
    if (mode === 'study' && Math.abs(minutes - Math.round(minutes)) > 0.00001) throw Error('请填写可换算为整分钟的时长，例如 2.5 小时。');
    return C.makeProfile({
      count:$('cupCount').value, frequency:$('studyFrequency').value, minutes:Math.round(minutes), weeks:$('studyWeeks').value,
      start:$('profileStart').value, time, arrivals, gap:$('coffeeGap').value, weekdays,
      visitOffsets:mode === 'study' ? visitOffsets : countVisitOffsets,
      sameProduct:$('sameProduct').checked, mix:$('allowMix').checked,
    }, mode);
  }

  function arrivalLabel(plan) {
    return plan.time ? '每天 ' + plan.time : [
      plan.workdays && '工作日 ' + plan.workdays,
      plan.weekends && '周末 ' + plan.weekends,
    ].filter(Boolean).join(' · ');
  }

  function arrivalMessage(text, user = false) {
    const bubble = el('div', text, user ? 'compare-arrival-user' : 'compare-arrival-reply');
    const messages = $('arrivalMessages');
    messages.append(bubble);
    messages.scrollTop = messages.scrollHeight;
    return bubble;
  }

  async function openArrival() {
    $('arrivalDialog').showModal();
    $('arrivalQuestion').focus();
    try {
      const { deepseek } = await W.request('/api/agent/capabilities');
      $('arrivalAiLabel').hidden = !deepseek;
      $('arrivalAi').checked = Boolean(deepseek && localStorage.getItem('kdz-agent-use-deepseek') === 'true');
    } catch {}
  }

  function arrivalReply(candidate, provider, examples) {
    if (examples.length) {
      arrivalMessage(examples.length > 1 ? '我把你提到的时段分开试算。下面的时刻是示例，可以继续改成你方便的时间。' :
        '我先用你提到的时段举例试算。你可以继续改成具体时间。');
      for (const { label, plan } of examples) renderArrivalScenario(plan, provider, label);
    } else if (candidate) renderArrivalScenario(candidate, provider);
    else arrivalMessage('你大概早上、下午还是晚上到？如果工作日和周末不同，可以分开说。');
  }

  function renderArrivalScenario(candidate, provider, example = '') {
    const reply = arrivalMessage(example ? example + '示例 · ' + arrivalLabel(candidate) + '。' : '按 ' + arrivalLabel(candidate) + ' 试算。');
    reply.prepend(el('span', example ? '示例时刻 · 本地试算' : provider === 'deepseek' ? 'DeepSeek 理解 · 本地试算' :
      provider === 'fallback' ? '已回退 · 本地试算' : '本地试算', 'badge'));
    try {
      const options = previewOptions ?? getOffers(), usage = profile(candidate);
      const result = C.compare(options, usage);
      const rows = el('ul');
      result.rows.forEach(row => rows.append(el('li', row.name + ' · 覆盖 ' + row.covered + '/' + result.count + ' 次 · ' + W.money(row.cost))));
      reply.append(rows);
      if (result.best && result.tied.length === 1) {
        reply.append(el('p', '按这组到访时间，' + result.best.name + '在能覆盖全部到访的方案中支出最低。'));
      } else if (!result.best) {
        const split = options.find(option => option.windows);
        if (split) {
          const format = minutes => String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
          const advice = split.windows.map(([open, close], index) => {
            const day = index === 0 ? '工作日' : '周末';
            return close - open < usage.minutes ? day + '的可用时段放不下 ' + studyHours(usage.minutes) :
              day + '可在 ' + format(open) + '–' + format(close - usage.minutes) + ' 之间到访';
          });
          reply.append(el('p', split.name + '按本次停留时长核对，' + advice.join('，') + '。'));
        } else reply.append(el('p', '这组时间下仍有缺口，可以换一组到访时间继续试算。'));
      }
      if (result.issues.some(note => note.includes('到访星期'))) reply.append(el('p', '星期未定时，先计算工作日和周末都能满足的安排。选定星期后可以分别核对。'));
      else if (result.conditional) reply.append(el('p', '仍有条款或日期待核对，结果按条件试算。'));
    } catch {
      reply.append(el('p', '填写每周频率、停留时长和使用周期后，即可看到覆盖情况。'));
    }
    reply.append(button('采用这组时间试算', () => {
      arrivalPlan = candidate;
      $('profileTime').value = candidate.time || '';
      $('quickTime').value = $('profileTime').value;
      $('arrivalDialog').close();
      calculate(false);
    }));
    const messages = $('arrivalMessages');
    messages.scrollTop = messages.scrollHeight;
  }

  async function askArrival(event) {
    event.preventDefault();
    const input = $('arrivalQuestion'), send = $('arrivalSend');
    const question = input.value.trim();
    if (!question || send.disabled) return;
    send.disabled = true;
    input.value = '';
    arrivalMessage(question, true);
    const pending = arrivalMessage('正在核对时段…');
    const history = arrivalHistory.slice(-3);
    const previous = history.reduce((plan, text) => C.parseArrivalQuestion(text, plan) ?? plan, {});
    const examples = C.arrivalExamples(question, previous);
    let response = { provider:'local', candidate:C.parseArrivalQuestion(question, previous) };
    if ($('arrivalAi').checked) {
      try {
        response = await W.request('/api/comparison/arrival', { question, history, useDeepSeek:true });
      } catch {
        response.provider = 'fallback';
      }
    }
    arrivalHistory.push(question);
    if (arrivalHistory.length > 4) arrivalHistory.shift();
    pending.remove();
    send.disabled = false;
    arrivalReply(C.arrivalCandidate(response.candidate), response.provider, examples);
  }

  function studyHours(minutes) {
    const hours = Math.floor(minutes / 60), rest = minutes % 60;
    return (hours ? hours + ' 小时' : '') + (rest ? (hours ? ' ' : '') + rest + ' 分钟' : hours ? '' : '0 分钟');
  }

  function syncWeekdayFields() {
    const selected = daysSelected();
    const exact = selected.length > 0;
    $('studyFrequency').hidden = $('studyFrequency').disabled = exact;
    $('studyFrequencyDerived').hidden = !exact;
    $('studyFrequencyDerived').textContent = '按已选星期 · ' + selected.length + ' 天／周';
    $('quickFrequency').disabled = exact;
    $('quickScheduleTitle').textContent = exact ? '调整已选星期' : '选择具体星期（可选）';
    for (const box of $('quickWeekdays').querySelectorAll('input')) box.checked = selected.includes(Number(box.value));
  }

  function planFocus(id) {
    const field = $(id);
    if (field.closest('details')) field.closest('details').open = true;
    field.scrollIntoView({ block:'center' });
    field.focus({ preventScroll:true });
  }

  function syncQuickPlan(result, usage) {
    const study = usage.mode === 'study';
    $('quickStudy').hidden = !study;
    $('quickCoffee').hidden = study;
    if (!study) {
      $('cupSlider').max = Math.max(30, usage.count, Number($('cupSlider').max));
      $('cupSlider').value = usage.count;
      $('quickCupValue').textContent = usage.count + ' 次';
      $('cupSlider').setAttribute('aria-valuetext', usage.count + ' 次');
      $('quickPlanSummary').textContent = usage.visitOffsets.length
        ? '按使用日历试算 ' + result.count + ' 次 · 调整次数可恢复按次数试算'
        : '本次比较 ' + result.count + ' 次';
      return;
    }
    syncWeekdayFields();
    const days = usage.selected.length || usage.frequency || 1;
    const custom = Boolean(usage.visitOffsets?.length);
    $('quickFrequency').disabled = custom || Boolean(usage.selected.length);
    $('quickFrequency').value = days;
    $('quickFrequencyValue').textContent = custom ? '按日历' : usage.selected.length ? '已选 ' + days + ' 天' : days + ' 天';
    $('quickFrequency').setAttribute('aria-valuetext', days + ' 天');
    const exactMinutes = usage.minutes % 30 !== 0;
    $('quickDuration').min = exactMinutes ? 1 : 30;
    $('quickDuration').step = exactMinutes ? 1 : 30;
    $('quickDuration').max = Math.max(720, usage.minutes, Number($('quickDuration').max));
    $('quickDuration').value = usage.minutes;
    $('quickDurationValue').textContent = studyHours(usage.minutes);
    $('quickDuration').setAttribute('aria-valuetext', studyHours(usage.minutes));
    $('quickTime').value = $('profileTime').value;
    $('clearArrival').hidden = !arrivalPlan;
    $('quickWeeks').value = usage.weeks;
    for (const preset of $('weekPresets').children) preset.setAttribute('aria-pressed', String(Number(preset.dataset.weeks) === usage.weeks));
    const basis = custom ? '按自定义日历' : usage.selected.length ?
      (usage.start === null ? '按已选星期估算' : '按已选星期计算') + '（' + usage.selected.map(day => '周' + weekLabels[day]).join('、') + '）' :
      '按每周 ' + days + ' 天估算';
    $('quickPlanSummary').textContent = basis + ' · ' + usage.weeks + ' 周共 ' + result.count + ' 次 · ' + studyHours(result.minutes) +
      (arrivalPlan ? ' · ' + arrivalLabel(arrivalPlan) : '');
  }

  function startTermEdit(offer, key) {
    reviewingOffer = offer;
    render();
    const terms = $('offer-' + offer.id).querySelector('[data-role="terms"]');
    const control = terms.querySelector('[data-field="' + key + '"]') || terms.querySelector('summary');
    control.scrollIntoView({ block:'center' });
    control.focus({ preventScroll:true });
  }

  function termAction(offer, note, rule) {
    return button('核对条款 · ' + note, () => {
      const { images, candidates } = material(offer);
      const review = () => startTermEdit(offer, rule.key);
      const evidence = rule.fields.flatMap(field => candidates[field] ?? []).find(item => imagesById.has(item.imageId));
      if (evidence) {
        openSource(imagesById.get(evidence.imageId), evidence.quote, evidence.box, review);
        return;
      }
      const matches = images.flatMap(image => (image.ocr?.lines ?? []).map(line => ({
        image, line, text:window.KDZExtract.clean(line.text),
      })));
      const source = matches.find(item => rule.specific?.test(item.text)) || matches.find(item => rule.pattern.test(item.text));
      if (source) openSource(source.image, source.line.text, source.line.box, review);
      else review();
    }, 'ghost');
  }


  const termRules = {
    restrictionsChecked:{ key:'restrictionsChecked', fields:['unmodeled'], pattern:/预约|节假日|限用|限购|收费|时段/ },
    limit:{ key:'limit', fields:['limit'], pattern:/限购|最多购买|限领/ },
    validity:{ key:'validity', fields:['validity','until','days','from'], pattern:/有效期|有效|到期/ },
    purchaseDays:{ key:'purchaseDays', fields:['purchaseDays'], pattern:/购买(?:之)?后.*有效/ },
    window:{ key:'window', fields:['window','opens','closes','weekdays','workdayOpens','workdayCloses','weekendOpens','weekendCloses'],
      pattern:/可用时段|使用时段|适用时段|使用时间|入场时间|营业时间|部分时段可用/,
      specific:/\d{1,2}:\d{2}(?:至|到|[-—–~～·.一])\d{1,2}:\d{2}/ },
    visitMax:{ key:'visitMax', fields:['visitMax'], pattern:/每次.{0,12}(?:小时|分钟)|单次.{0,12}(?:小时|分钟)/ },
    redemption:{ key:'redemption', fields:['redemption'], pattern:/核销|每次到访|同日|每日/ },
    billing:{ key:'billing', fields:['billing','minimum'], pattern:/计费|计时|扣费|扣减/ },
  };

  function planCondition(note) {
    return /^需要|是否适用于同一消费需求/.test(note);
  }

  function termKey(note) {
    if (/购买后.*有效/.test(note)) return 'purchaseDays';
    if (/购买|多张|叠加/.test(note)) return 'limit';
    if (/使用限制/.test(note)) return 'restrictionsChecked';
    if (/有效期/.test(note)) return 'validity';
    if (/时段/.test(note)) return 'window';
    if (/时长/.test(note) && !/计费|扣减/.test(note)) return 'visitMax';
    if (/核销/.test(note)) return 'redemption';
    if (/计费|扣减/.test(note)) return 'billing';
    return null;
  }

  function issueControl(note, index, result) {
    if (/^需要/.test(note)) {
      if (note.includes('到访星期') && mode === 'study') return button(note + ' →', () => planFocus('quickScheduleTitle'), 'ghost');
      const target = note.includes('时段') && !$('profileTime').value
        ? (mode === 'study' ? 'quickTime' : 'profileTime') : 'profileStart';
      return button(note + ' →', () => planFocus(target), 'ghost');
    }
    if (/是否适用于同一消费需求/.test(note)) return button(note + ' →', () => planFocus('sameProduct'), 'ghost');
    const key = termKey(note);
    const ownOffer = offers[index];
    const match = result.rows.findIndex((row, i) => i < offers.length && row.notes.includes(note));
    const offer = ownOffer || offers[match];
    if (!key || !offer) return el('p', note, 'muted');
    const action = termAction(offer, note, termRules[key]);
    if (!ownOffer) action.textContent = '方案 ' + (match + 1) + ' · ' + action.textContent;
    return action;
  }

  function issueList(notes, index, result) {
    const list = el('ul', undefined, 'compare-issue-list');
    for (const note of notes) {
      const entry = el('li');
      entry.append(issueControl(note, index, result));
      list.append(entry);
    }
    return list;
  }

  const verificationTerms = {
    purchaseDays:{ group:'validity', question:'当前购买适用的购后有效期限是多少天？它是首次核销截止，还是全部权益使用截止？' },
    validity:{ group:'validity', question:'套餐从什么时候开始计算使用期，能使用多久？' },
    window:{ group:'usage', question:'工作日、周末和节假日分别有哪些可用时段？' },
    visitMax:{ group:'usage', question:'每次最多可以使用多久？达到上限后如何处理？' },
    redemption:{ group:'usage', question:'权益按天还是按次扣减？同一天多次到访如何核销？' },
    billing:{ group:'usage', question:'时长如何计费和取整？单次使用有最低扣减吗？' },
    limit:{ group:'purchase', question:'同一人或账号最多能买几份？多份权益能否用于同一使用计划？' },
    restrictionsChecked:{ group:'restrictions', question:'请说明这款套餐的预约、节假日限制及可能产生的附加费用。' },
  };
  const verificationGroups = {
    validity:{ title:'实际可用期限', priority:4 },
    usage:{ title:'可用时段与权益扣减', priority:3 },
    purchase:{ title:'限购与多份使用', priority:2 },
    restrictions:{ title:'预约与其他使用限制', priority:1 },
  };

  function verificationItem(group, result) {
    const item = el('li', undefined, 'compare-verification-item');
    const sign = el('span', '!', 'compare-verification-icon');
    sign.setAttribute('aria-hidden', 'true');
    const body = el('div', undefined, 'compare-verification-body');
    body.append(el('h3', group.title), el('p', group.name, 'compare-verification-offer'),
      el('p', group.notes.join('。') + '。', 'muted'),
      details('查看依据与核对入口', issueList(group.notes, group.index, result)));
    item.append(sign,body);
    return item;
  }

  function renderVerification(result) {
    const groups = new Map();
    for (const [index, row] of result.rows.slice(0, offers.length).entries()) {
      for (const note of row.notes) {
        if (planCondition(note) || note === '截图写明同款不可叠加使用') continue;
        const term = verificationTerms[termKey(note)];
        if (!term) continue;
        const key = index + '-' + term.group;
        if (!groups.has(key)) {
          const { title, priority } = verificationGroups[term.group];
          const relevant = !result.best || row.cost <= result.best.cost;
          const rank = result.tied.includes(row) ? 2 : relevant ? 1 : 0;
          groups.set(key, { index, name:row.name, title, rank, priority, cost:row.cost, missing:row.missing,
            notes:[], questions:new Set() });
        }
        const group = groups.get(key);
        if (!group.notes.includes(note)) group.notes.push(note);
        group.questions.add(term.question);
      }
    }
    const items = [...groups.values()].sort((a,b) =>
      b.rank - a.rank || a.missing - b.missing || a.cost - b.cost || b.priority - a.priority || a.index - b.index);
    verificationQuestions = items.flatMap(group => [...group.questions].map(question => ({
      packageId:offers[group.index].id, offerName:group.name.replace(/\s+/g,' '), question,
    })));
    $('verificationCount').textContent = items.length + ' 项';
    $('verificationEmpty').hidden = Boolean(items.length);
    $('openVerification').hidden = !items.length;
    $('copyVerification').hidden = !verificationQuestions.length;
    $('verificationMain').replaceChildren(...items.slice(0,2).map(group => verificationItem(group,result)));
    $('verificationMore').hidden = items.length <= 2;
    $('verificationMoreLabel').textContent = '查看其余条款（' + Math.max(0,items.length - 2) + ' 项）';
    $('verificationOther').replaceChildren(...items.slice(2).map(group => verificationItem(group,result)));
  }

  function merchantStatus(message, tone = 'success') {
    const status = $('verificationStatus');
    status.textContent = message;
    status.dataset.state = tone;
    status.hidden = !message;
  }

  function merchantPreview() {
    const { selected, polished } = merchantDraft;
    const records = $('merchantPolished').checked && polished ? polished : selected;
    $('verificationText').value = window.VericardIssues.merchantMessage(records);
    $('copyMerchant').disabled = !records.length;
  }

  function selectMerchantQuestions() {
    merchantDraft.selected = [...$('merchantQuestions').querySelectorAll('input:checked')]
      .map(control => merchantDraft.questions[Number(control.value)]);
    merchantDraft.polished = null;
    merchantDraft.revision++;
    $('merchantOriginal').checked = true;
    $('merchantVariants').hidden = true;
    $('polishMerchant').disabled = !merchantDraft.selected.length;
    merchantStatus('');
    merchantPreview();
  }

  function openMerchant() {
    if (!verificationQuestions.length) return;
    merchantDraft = { questions:verificationQuestions, selected:[], polished:null, revision:0 };
    const packages = new Map();
    verificationQuestions.forEach((entry,index) => {
      if (!packages.has(entry.packageId)) {
        const group = el('fieldset');
        group.append(el('legend',entry.offerName));
        packages.set(entry.packageId,group);
      }
      const label = el('label',undefined,'page-check');
      const control = el('input');
      control.type = 'checkbox';
      control.value = index;
      control.checked = true;
      label.append(control,el('span',entry.question));
      packages.get(entry.packageId).append(label);
    });
    $('merchantQuestions').replaceChildren(...packages.values());
    selectMerchantQuestions();
    $('merchantDialog').showModal();
    $('merchantHeading').focus();
  }

  async function polishMerchant() {
    const draft = merchantDraft, revision = draft.revision;
    if (!draft.selected.length) return;
    $('polishMerchant').disabled = true;
    merchantStatus('正在润色所选问题…', 'loading');
    const current = () => merchantDraft === draft && draft.revision === revision;
    try {
      const { provider, questions } = await W.request('/api/comparison/merchant-polish',
        { questions:draft.selected.map(entry => entry.question) });
      if (!current()) return;
      if (provider !== 'deepseek' || !Array.isArray(questions) || questions.length !== draft.selected.length) {
        throw Error('润色暂不可用');
      }
      draft.polished = draft.selected.map((entry,index) => ({ ...entry, question:questions[index] }));
      $('merchantVariants').hidden = false;
      $('merchantPolished').checked = true;
      merchantPreview();
      merchantStatus('DeepSeek 润色完成。可切换版本核对后复制。');
    } catch {
      if (current()) merchantStatus('AI 润色暂不可用，原话术仍可复制。', 'warning');
    } finally {
      if (current()) $('polishMerchant').disabled = false;
    }
  }

  async function copyMerchant() {
    const draft = merchantDraft;
    const text = $('verificationText');
    const message = text.value;
    if (!message) return;
    try {
      await navigator.clipboard.writeText(message);
      if (merchantDraft === draft && text.value === message) merchantStatus('已复制所选话术。');
    } catch {
      if (merchantDraft !== draft || text.value !== message) return;
      text.focus();
      text.select();
      merchantStatus('请手动复制已选中的话术。', 'warning');
    }
  }

  function measure(title, value, total, summary, best, gap = false) {
    const block = el('div', undefined, 'compare-measure');
    block.append(el('strong', title));
    if (total > 0) {
      const bar = el('div', undefined, 'compare-meter');
      bar.setAttribute('role', 'img');
      bar.setAttribute('aria-label', title + ' · ' + summary);
      bar.dataset.best = String(best);
      bar.dataset.gap = String(gap);
      const fill = el('span');
      fill.style.width = Math.min(100, Math.max(0, value / total * 100)) + '%';
      bar.append(fill);
      block.append(bar);
    }
    block.append(el('small', summary));
    return block;
  }

  function purchasePicker(offer, option, row, count) {
    const max = option.stackingBlocked ? 1 : option.limit || 1000;
    if (option.type !== 'visits' || max < 2) return null;
    const picker = el('form', undefined, 'compare-quantity');
    const title = el('label', '试算购买张数');
    const input = el('input');
    input.type = 'number'; input.min = '1'; input.max = max; input.step = '1';
    input.required = true;
    input.value = row.quantity;
    title.append(input);
    const update = quantity => {
      offer.trialQuantity = quantity;
      previewOptions = null;
      commitQuick();
      document.querySelector('.compare-quantity[data-for="' + offer.id + '"] input')?.focus({preventScroll:true});
    };
    picker.dataset.for = offer.id;
    picker.addEventListener('submit', event => { event.preventDefault(); update(Number(input.value)); });
    const submit = el('button', '应用', 'secondary'); submit.type = 'submit';
    picker.append(title, submit);
    const needed = Math.ceil(count / option.units);
    if (needed > 1 && needed <= max && option.trialQuantity !== needed) {
      picker.append(button('试算 ' + needed + ' 张', () => update(needed)));
    }
    if (option.trialQuantity) picker.append(button('恢复自动', () => update(null), 'ghost'));
    if (option.limit === null || option.purchaseAssumed) picker.append(el('small', '多张使用按假设试算', 'muted'));
    return picker;
  }

  function makeResultCard(row, index, result, study, option) {
    const item = el('article', undefined, 'panel compare-result');
    const best = result.tied.includes(row);
    item.dataset.best = String(best);
    const header = el('div', undefined, 'compare-result-head');
    const title = el('div');
    title.append(el('h3', row.name));
    const badge = el('span', row.missing ? '覆盖不全' : best ? (result.conditional ? '条件推荐' : '当前推荐') : row.notes.length ? '条件试算' : '覆盖完整', 'badge');
    badge.dataset.tone = row.missing ? 'warning' : best && !result.conditional ? 'success' : 'neutral';
    title.append(badge);
    const cost = el('div', undefined, 'compare-result-cost');
    cost.append(el('strong', W.money(row.cost), 'compare-price'),
      el('small', row.missing ? '当前支出' : '完整覆盖支出', 'muted'));
    header.append(title, cost);
    const detail = row.quantity ? '试算购买 ' + row.quantity + (row.type === 'visits' ? ' 张' : ' 份') : row.detail;
    item.append(header, el('p', detail, 'muted compare-result-detail'));
    const marks = el('div', undefined, 'compare-result-marks');
    const countLabel = ' 次';
    let coverage = row.covered + ' / ' + result.count + countLabel;
    if (study) coverage += ' · ' + studyHours(row.coveredMinutes) + ' / ' + studyHours(result.minutes);
    if (row.missing) coverage += ' · 缺 ' + (study ? row.missing + ' 次（' + studyHours(row.missingMinutes) + '）' : row.missing + ' 次');
    marks.append(measure('计划覆盖', row.covered, result.count, coverage, best, row.missing > 0));
    item.append(marks);
    if (row.left > 0 && row.type === 'hours') item.append(el('p', '账面剩余 ' + studyHours(row.left) + ' · 以扣费规则为准', 'muted'));
    else if (row.left > 0 && row.type === 'visits') item.append(el('p', '未扣减权益 ' + row.left + ' 次', 'muted'));
    if (row.notes.length) item.append(details('试算条件与依据', issueList(row.notes, index, result)));
    const source = offers[index];
    if (source) {
      const picker = purchasePicker(source, option, row, result.count);
      if (picker) item.append(picker);
      item.append(button('我已购买，加入卡包', () => {
        const { images, values } = material(source);
        window.KDZWalletEnroll.open({ offer:{ ...values,name:row.name },images,offerId:source.id });
      }, 'ghost'));
    } else item.append(el('p', '组合中的实际购入卡券可从各方案分别登记。', 'muted'));
    return item;
  }

  function renderResult(result, usage, options) {
    syncQuickPlan(result, usage);
    const study = mode === 'study';
    const best = result.best;
    const label = !best ? '暂无方案能覆盖全部需求' : result.tied.length > 1 ? '多个方案费用相同' : best.name + ' · ' + W.money(best.cost);
    $('resultTitle').textContent = label;
    $('resultBadge').textContent = result.conditional ? '条件试算' : best ? '已按当前条件比较' : '当前方案覆盖不足';
    $('resultBadge').dataset.tone = result.conditional || !best ? 'warning' : 'success';
    $('resultDetail').textContent = !best ? '下方标出各方案的缺口。' :
      (result.conditional ? '按当前试算条件，在能完整覆盖计划的方案中比较费用。' : '在能完整覆盖计划的方案中比较费用。');
    const next = best && result.rows.filter(row => !row.missing && row.cost > best.cost).sort((a,b) => a.cost - b.cost)[0];
    if (next && result.tied.length === 1) $('resultDetail').textContent += ' 比下一种能完整覆盖的买法少 ' + W.money(next.cost - best.cost) + '。';
    $('coverageGoal').textContent = study ? result.count + ' 次 · ' + studyHours(result.minutes) : result.count + ' 次';
    $('resultRows').replaceChildren(...result.rows.map((row, index) => makeResultCard(row, index, result, study, options[index])));
    const issues = result.issues.filter(planCondition);
    $('resultQuestions').replaceChildren(...issues.slice(0, 2).map(issue => issueControl(issue, -1, result)));
    $('issueDetails').hidden = issues.length <= 2;
    $('resultIssues').replaceChildren(...issueList(issues.slice(2), -1, result).children);
    renderVerification(result);
    $('resultSection').hidden = false;
  }


  const tabs = [...$('compareViews').querySelectorAll('[role=tab]')];

  function chartReadout(result, title) {
    const rows = el('ul');
    for (const choice of result.rows) {
      const fact = el('li');
      const cost = el('strong', W.money(choice.cost));
      cost.dataset.gap = String(choice.missing > 0);
      const coverage = choice.missing ? '覆盖 ' + choice.covered + '/' + result.count + ' 次 · 当前支出' :
        '完整覆盖 ' + result.count + ' 次' + (choice.notes.length || result.conditional ? ' · 条件试算' : '');
      fact.append(el('span',choice.name),cost,el('small',coverage,'muted'));
      rows.append(fact);
    }
    $('chartReadout').replaceChildren(el('strong',title),rows);
  }

  function axisCeiling(cap) {
    const quarter = Math.max(100, cap) / 4;
    const magnitude = 10 ** Math.floor(Math.log10(quarter));
    return [1,2,2.5,5,10].find(value => value * magnitude >= quarter) * magnitude * 4;
  }

  function drawPriceMap(result) {
    const ceiling = axisCeiling(Math.max(...result.rows.map(row => row.cost)));
    const axis = el('div', undefined, 'compare-price-axis');
    for (const fraction of [0, .5, 1]) axis.append(el('span', W.money(ceiling * fraction)));
    const list = el('ul', undefined, 'compare-price-map');
    const ranked = result.rows.map((row, index) => ({ row, index }))
      .sort((a,b) => Number(Boolean(a.row.missing)) - Number(Boolean(b.row.missing)) || a.row.cost - b.row.cost);
    for (const { row, index } of ranked) {
      const item = el('li', undefined, 'compare-price-point');
      const heading = el('div', undefined, 'compare-price-label');
      heading.append(el('strong',row.name),el('strong',W.money(row.cost)));
      const track = el('div', undefined, 'compare-price-track');
      track.setAttribute('aria-hidden','true');
      const marker = el('i');
      marker.style.left = (row.cost / ceiling * 100) + '%';
      marker.style.color = compareColors[index];
      marker.dataset.gap = String(Boolean(row.missing));
      track.append(marker);
      const status = row.missing ? '当前支出 · 覆盖 ' + row.covered + '/' + result.count + ' 次' :
        result.tied.includes(row) ? (result.conditional ? '条件试算中支出最低' : '完整覆盖方案中支出最低') :
        row.notes.length ? '完整覆盖 · 条件试算' : '完整覆盖';
      item.append(heading,track,el('small',status,'muted'));
      list.append(item);
    }
    $('priceMap').replaceChildren(axis,list);
  }

  function drawCalendar(usage, result) {
    const countBased = usage.mode === 'coffee';
    const planned = C.calendarOffsets(usage);
    const custom = Boolean(usage.visitOffsets.length);
    const inferred = !custom && (countBased ? usage.start === null || usage.gap === null :
      !usage.selected.length && usage.frequency < 7);
    const lastPage = Math.min(Math.floor((365 * 60 - 1) / 28), Math.floor((planned.at(-1) ?? 0) / 28) + 1);
    if (countBased) {
      calendarPage = Math.min(calendarPage,lastPage);
      $('calendarPage').max = lastPage + 1;
      $('calendarPage').value = calendarPage + 1;
      $('calendarPageLabel').textContent = '第 ' + (calendarPage * 4 + 1) + '–' + (calendarPage * 4 + 4) + ' 周';
      $('calendarBack').disabled = calendarPage === 0;
      $('calendarForward').disabled = calendarPage === lastPage;
    }
    $('calendarPager').hidden = !countBased;
    const slots = countBased ? C.calendarDays(usage, calendarPage * 28, 28) : C.calendarDays(usage);
    const calendar = $('visitCalendar');
    calendar.dataset.preview = String(inferred);
    const cells = [el('span',undefined,'compare-calendar-corner')];
    for (const slot of slots.slice(0,7)) cells.push(el('span','周' + weekLabels[slot.weekday],'compare-calendar-head'));
    for (const slot of slots) {
      const week = Math.floor(slot.offset / 7) + 1;
      if (slot.offset % 7 === 0) cells.push(el('span','第 ' + week + ' 周','compare-calendar-week'));
      const iso = slot.date === null ? '' : new Date(slot.date * 86400000).toISOString().slice(0,10);
      const control = button(iso ? iso.slice(5).replace('-','/') : slot.planned ? '✓' : '·', () => {
        const next = new Set(planned);
        if (slot.planned) next.delete(slot.offset);
        else next.add(slot.offset);
        if (!next.size) {
          $('calendarHint').textContent = '请至少保留一次到访。';
          return;
        }
        if (countBased && next.size > 60) {
          $('calendarHint').textContent = '一次最多比较 60 个使用日。';
          return;
        }
        if (countBased) countVisitOffsets = [...next];
        else visitOffsets = [...next];
        commitQuick();
        calendar.querySelector('[data-offset="' + slot.offset + '"]')?.focus({preventScroll:true});
      });
      control.dataset.offset = slot.offset;
      control.disabled = countBased && slot.offset >= 365 * 60;
      control.setAttribute('aria-pressed',String(slot.planned));
      control.setAttribute('aria-label',(iso || '第 ' + week + ' 周') + ' 周' + weekLabels[slot.weekday] + (slot.planned ? '，计划到访' : '，未安排到访'));
      cells.push(control);
    }
    calendar.replaceChildren(...cells);
    $('resetCalendar').hidden = !custom;
    $('resetCalendar').textContent = countBased ? '恢复按次数' : '恢复每周计划';
    const note = inferred ? (countBased ? '按次数预排，点选后每个使用日按一次试算。' :
      '按每周频率预排，点选后才按具体星期试算。') :
      custom ? '已按日历安排试算。' : '点选可增删使用日。';
    $('calendarHint').textContent = note + ' 当前 ' + result.count + ' 次' +
      (countBased ? '。' : '，共 ' + studyHours(result.minutes) + '。');
  }

  function renderVisualization(options, usage, result) {
    for (const tab of tabs) {
      const active = resultView === tab.dataset.view;
      tab.setAttribute('aria-selected',String(active));
      tab.tabIndex = active ? 0 : -1;
      $(tab.getAttribute('aria-controls')).hidden = !active;
    }
    if (resultView === 'curve') {
      if (usage.mode === 'coffee' && usage.visitOffsets.length) showCalendarCost(result);
      else drawChart(options, usage);
    }
    else {
      $('chartCount').textContent = result.count + ' 次';
      if (resultView === 'prices') drawPriceMap(result);
      else drawCalendar(usage, result);
    }
  }

  function showCalendarCost(result) {
    $('chartMetricLabel').hidden = $('chartLegend').hidden = $('chartScrub').closest('label').hidden = true;
    $('chartCount').textContent = result.count + ' 次';
    $('chartHint').textContent = '已按所选使用日试算。';
    const insight = el('div', undefined, 'compare-chart-insight');
    insight.append(el('strong','使用日会影响套餐覆盖'), el('p','可回到使用日历增删日期，或恢复按次数查看费用曲线。','muted'));
    $('chartArea').replaceChildren(insight);
    $('switchPoints').replaceChildren();
    chartReadout(result,'已选使用日的各方案');
  }

  function svg(tag, attrs) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    return node;
  }

  function chartSpec(usage) {
    const study = usage.mode === 'study';
    const metric = $('chartMetric');
    $('chartMetricLabel').hidden = !study;
    metric.options[0].disabled = study && Boolean(usage.selected.length || usage.visitOffsets?.length);
    if (metric.value === 'frequency' && metric.options[0].disabled) metric.value = 'duration';
    if (!study) return { values:Array.from({length:Number($('cupSlider').max)}, (_, i) => i + 1), selected:usage.count,
      label:value => value + ' 次', dimension:'使用次数', compare:(options,value) => C.compare(options, usage, value), set:value => { $('cupCount').value = value; } };
    if (metric.value === 'frequency') return { values:[1,2,3,4,5,6,7], selected:usage.frequency,
      label:value => value + ' 天／周', dimension:'每周到访天数', compare:(options,value) => C.compare(options, { ...usage, frequency:value }),
      set:value => { $('studyFrequency').value = value; } };
    const end = Math.max(480, Math.ceil(usage.minutes / 30) * 30);
    const values = new Set(Array.from({length:end / 30}, (_, i) => (i + 1) * 30));
    values.add(usage.minutes);
    return { values:[...values].sort((a,b) => a - b), selected:usage.minutes,
      label:studyHours, dimension:'单次停留时长', compare:(options,value) => C.compare(options, { ...usage, minutes:value }),
      set:value => { $('studyHours').value = value / 60; } };
  }

  function drawChart(options, usage) {
    $('chartScrub').closest('label').hidden = false;
    const spec = chartSpec(usage);
    const series = spec.values.map(value => spec.compare(options, value));
    const width = Math.max(268, $('chartArea').clientWidth || 560);
    const height = 172, left = 54, right = 35, top = 16, bottom = 29;
    const ceiling = axisCeiling(Math.max(0, ...series.flatMap(item => item.rows.filter(row => !row.missing).map(row => row.cost))));
    const min = spec.values[0], max = spec.values.at(-1);
    const x = value => left + (value - min) / (max - min) * (width - left - right);
    const y = cost => height - bottom - cost / ceiling * (height - bottom - top);
    const picture = svg('svg', { viewBox:'0 0 ' + width + ' ' + height, role:'img', 'aria-label':'完整覆盖的方案支出随' + spec.dimension + '变化，虚线表示条件试算' });
    for (let tick = 0; tick <= 4; tick++) {
      const cost = ceiling * tick / 4;
      const baseline = y(cost);
      picture.append(svg('line', { x1:left, x2:width-right, y1:baseline, y2:baseline, stroke:'var(--color-border)' }));
      const text = svg('text', { x:left-7, y:baseline+4, 'text-anchor':'end' });
      text.textContent = '¥' + (cost / 100).toLocaleString('zh-CN', { notation:cost >= 1000000 ? 'compact' : 'standard', maximumFractionDigits:1 });
      picture.append(text);
    }
    const lastIndex = spec.values.length - 1;
    for (const index of new Set([0, Math.round(lastIndex / 2), lastIndex])) {
      const value = spec.values[index];
      const text = svg('text', { x:x(value), y:height-6, 'text-anchor':'middle' });
      text.textContent = spec.label(value);
      picture.append(text);
    }
    picture.append(svg('line', { x1:x(spec.selected), x2:x(spec.selected), y1:top, y2:height-bottom, stroke:'var(--color-primary-dark)', 'stroke-dasharray':'4 4' }));
    const combos = series.some(item => item.rows.length > options.length);
    const active = new Set();
    const legend = [];
    const selectedIndex = spec.values.indexOf(spec.selected);
    for (let index = 0; index < options.length + Number(combos); index++) {
      const color = compareColors[index];
      const tag = el('span');
      const swatch = el('i');
      swatch.style.backgroundColor = color;
      tag.append(swatch, document.createTextNode(options[index]?.name || '组合购买'));
      if (series.some(item => item.rows[index] && !item.rows[index].missing)) {
        active.add(index);
        legend.push(tag);
      }
      let previous = null;
      series.forEach((item, point) => {
        const row = item.rows[index], value = spec.values[point];
        if (!row || row.missing) { previous = null; return; }
        const current = { x:x(value), y:y(row.cost), conditional:row.notes.length || item.conditional };
        if (previous) {
          const stroke = { x1:previous.x, y1:previous.y, x2:current.x, y2:current.y, stroke:color, 'stroke-width':2.5 };
          if (previous.conditional || current.conditional) stroke['stroke-dasharray'] = '5 3';
          picture.append(svg('line', stroke));
        }
        if (value === spec.selected || !previous) picture.append(svg('circle', { cx:current.x, cy:current.y, r:value===spec.selected?5:2, fill:color,
          stroke:'var(--color-surface)','stroke-width':value===spec.selected?1.5:0 }));
        previous = current;
      });
    }
    const signature = item => item.tied.map(row => item.rows.indexOf(row)).join(',');
    const changes = [];
    for (let index = 1; index < series.length; index++) {
      const point = series[index];
      if (signature(point) !== signature(series[index - 1])) {
        changes.push({value:spec.values[index],name:point.tied.length > 1 ? '多方案并列' : point.best?.name || '无完整覆盖方案'});
      }
    }
    const cursor = svg('line', { y1:top, y2:height-bottom, stroke:'var(--color-text-muted)', visibility:'hidden' });
    picture.append(cursor);
    const scrub = $('chartScrub');
    let previewIndex = selectedIndex;
    const show = index => {
      previewIndex = index;
      const value = spec.values[index];
      if (index === selectedIndex) cursor.setAttribute('visibility','hidden');
      else {
        cursor.setAttribute('x1',x(value));
        cursor.setAttribute('x2',x(value));
        cursor.setAttribute('visibility','visible');
      }
      chartReadout(series[index], index === selectedIndex ? '当前用量下的各方案' : '预览 · ' + spec.label(value));
    };
    function pointIndex(event) {
      const matrix = picture.getScreenCTM();
      if (!matrix) return null;
      const pointer = picture.createSVGPoint();
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      const position = pointer.matrixTransform(matrix.inverse());
      if (position.y < top || position.y > height-bottom || position.x < left-3 || position.x > width-right+3) return null;
      return spec.values.reduce((best, value, index) => Math.abs(x(value)-position.x) < Math.abs(x(spec.values[best])-position.x) ? index : best,0);
    }
    picture.addEventListener('pointermove', event => {
      const index = pointIndex(event) ?? selectedIndex;
      if (index !== previewIndex) show(index);
    });
    picture.addEventListener('pointerleave', () => { if (previewIndex !== selectedIndex) show(selectedIndex); });
    picture.addEventListener('click', event => {
      const index = pointIndex(event);
      if (index === null) return;
      spec.set(spec.values[index]);
      commitQuick();
    });
    const plotValues = series.flatMap(item => item.rows.filter(row => !row.missing).map(row => row.cost));
    const showPlot = active.size > 1 || new Set(plotValues).size > 1;
    if (showPlot) $('chartArea').replaceChildren(picture);
    else {
      const insight = el('div', undefined, 'compare-chart-insight');
      const only = active.size === 1 ? options[[...active][0]]?.name || '组合购买' : '';
      insight.append(el('strong', only ? '这个范围内只有一个方案可完整覆盖' : '当前范围没有方案能完整覆盖'),
        el('p', only ? only + ' 的完整覆盖支出保持在 ' + W.money(plotValues[0]) + '。' :
          '调整用量后，可在旁边查看各方案的覆盖缺口。', 'muted'));
      $('chartArea').replaceChildren(insight);
    }
    $('chartLegend').hidden = !showPlot;
    $('chartLegend').replaceChildren(...legend);
    scrub.max = lastIndex;
    scrub.value = selectedIndex;
    scrub.setAttribute('aria-valuetext', spec.label(spec.selected));
    scrub.oninput = () => {
      const index = Number(scrub.value);
      scrub.setAttribute('aria-valuetext', spec.label(spec.values[index]));
      show(index);
    };
    $('chartCount').textContent = spec.label(spec.selected);
    show(selectedIndex);
    const basis = usage.mode === 'study' && (usage.selected.length || usage.visitOffsets?.length) ? '，保持已选到访日' : '';
    $('chartHint').textContent = '只调整' + spec.dimension + basis + (showPlot ? '。悬停预览，点选应用。虚线为条件试算。' : '。');
    const switches = $('switchPoints');
    if (changes.length) switches.replaceChildren(el('strong','推荐切换点'),...changes.slice(0,5).map(point=> {
      const chip = button(spec.label(point.value)+' · '+point.name,()=> {
        spec.set(point.value);
        commitQuick();
        switches.querySelector('[data-value="'+point.value+'"]')?.focus({preventScroll:true});
      },'secondary');
      chip.dataset.value = point.value;
      chip.setAttribute('aria-pressed',String(point.value === spec.selected));
      return chip;
    }));
    else switches.replaceChildren(el('p',series.some(item=>item.best) ? '当前范围内没有新的推荐切换点。' : '当前范围没有方案能完整覆盖计划。','muted'));
  }

  function calculate(focus = false, persist = true) {
    if (!confirmed) return;
    try {
      const options = previewOptions ??= getOffers(), usage = profile();
      if (mode === 'study') visitOffsets = usage.visitOffsets.length ? usage.visitOffsets : null;
      else countVisitOffsets = usage.visitOffsets.length ? usage.visitOffsets : null;
      if (mode === 'study' && options.some(item => item.type === 'single')) throw Error('单次券可按一次到访计为 1 次的次卡，再核对单次时长。');
      const result = C.compare(options, usage);
      warning('profileError');
      renderResult(result, usage, options);
      $('comparisonChart').hidden = false;
      visualization = { options, usage, result };
      renderVisualization(options, usage, result);
      hasResult = true;
      if (focus) $('resultHeading').focus();
    } catch (error) {
      warning('profileError', error.message);
      $('resultSection').hidden = true;
      hasResult = false;
    }
    if (persist) save();
  }

  function scheduleQuick() {
    if (quickFrame) return;
    quickFrame = requestAnimationFrame(() => {
      quickFrame = 0;
      calculate(false, false);
    });
  }

  function commitQuick() {
    if (quickFrame) cancelAnimationFrame(quickFrame);
    quickFrame = 0;
    calculate();
  }

  const stepButtons = [...document.querySelectorAll('.compare-steps [data-step]')];
  function syncSteps() {
    const active = $('resultSection').hidden ? ($('profileSection').hidden ? 0 : 1) : 2;
    stepButtons.forEach((control,index) => {
      control.disabled = index > active;
      if (index === active) control.setAttribute('aria-current','step');
      else control.removeAttribute('aria-current');
    });
  }
  const stepObserver = new MutationObserver(syncSteps);
  for (const id of ['profileSection','resultSection']) stepObserver.observe($(id),{attributes:true,attributeFilter:['hidden']});
  for (const control of stepButtons) control.addEventListener('click',() => $(control.dataset.step).focus());
  syncSteps();

  for (const id of ['weekdays','quickWeekdays']) weekLabels.forEach((label, index) => {
    const box = el('input');
    box.type = 'checkbox'; box.value = index;
    const caption = el('label');
    caption.append(box, document.createTextNode('周' + label));
    $(id).append(caption);
  });

  $('compareFiles').addEventListener('change', event => {
    const files = [...event.target.files];
    event.target.value = '';
    upload(files);
  });
  $('regroupOffers').addEventListener('click', regroup);
  $('addOffer').addEventListener('click', () => {
    if (offers.length >= 5) { announce('最多比较 5 个方案。', 'warning'); return; }
    const offer = createOffer();
    offers.push(offer);
    invalidate(); render(); save();
    $('offer-' + offer.id).querySelector('input').focus();
  });
  $('confirmOffers').addEventListener('click', () => {
    if (busy) return;
    try {
      const options = getOffers();
      const timed = options.some(item => ['hours','period'].includes(item.type)) ||
        (options.every(item => item.type === 'visits') && options.some(item => item.visitMax > 0));
      mode = timed ? 'study' : 'coffee';
      confirmed = true;
      warning('offerError');
      $('profileSection').hidden = false;
      updateMode(); save();
      $('profileHeading').focus();
    } catch (error) { warning('offerError', error.message); }
  });
  $('profileForm').addEventListener('submit', event => {
    event.preventDefault();
    calculate(true);
  });
  $('profileForm').addEventListener('change', event => {
    if (event.target.id === 'profileTime') arrivalPlan = null;
    if (event.target.id === 'studyFrequency' || event.target.closest('#weekdays')) visitOffsets = null;
    if (['cupCount','coffeeGap'].includes(event.target.id)) countVisitOffsets = null;
    syncWeekdayFields();
    if (hasResult) commitQuick();
    else save();
  });
  for (const [id, update] of [
    ['cupSlider', value => { countVisitOffsets = null; $('cupCount').value = value; }],
    ['quickFrequency', value => { if (!daysSelected().length) $('studyFrequency').value = value; }],
    ['quickDuration', value => { $('studyHours').value = Number(value) / 60; }],
  ]) {
    $(id).addEventListener('input', event => { update(event.target.value); scheduleQuick(); });
    $(id).addEventListener('change', commitQuick);
  }
  $('quickTime').addEventListener('change', event => {
    arrivalPlan = null;
    $('profileTime').value = event.target.value;
    commitQuick();
  });
  function setQuickWeeks(value) {
    $('studyWeeks').value = value;
    commitQuick();
  }
  $('quickWeeks').addEventListener('change', event => {
    if (event.target.checkValidity() && event.target.value) setQuickWeeks(event.target.value);
    else event.target.value = $('studyWeeks').value;
  });
  $('weekPresets').addEventListener('click', event => {
    const preset = event.target.closest('button[data-weeks]');
    if (preset) setQuickWeeks(preset.dataset.weeks);
  });
  for (const tab of tabs) tab.addEventListener('click', () => {
    if (!visualization) return;
    resultView = tab.dataset.view;
    renderVisualization(visualization.options, visualization.usage, visualization.result);
    save();
  });
  $('compareViews').addEventListener('keydown', event => {
    const keys = ['ArrowLeft','ArrowRight','Home','End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const available = tabs.filter(tab => !tab.hidden);
    const current = available.indexOf(event.target);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 :
      (current + (event.key === 'ArrowLeft' ? -1 : 1) + available.length) % available.length;
    available[index].focus();
    available[index].click();
  });
  function moveCalendarPage(value) {
    if (!visualization || !Number.isInteger(value)) return;
    calendarPage = Math.max(0, value);
    drawCalendar(visualization.usage, visualization.result);
  }
  $('calendarBack').addEventListener('click', () => moveCalendarPage(calendarPage - 1));
  $('calendarForward').addEventListener('click', () => moveCalendarPage(calendarPage + 1));
  $('calendarPage').addEventListener('change', event => moveCalendarPage(Number(event.target.value) - 1));
  $('openVerification').addEventListener('click', () => planFocus('verificationHeading'));
  $('copyVerification').addEventListener('click', openMerchant);
  $('closeMerchant').addEventListener('click', () => $('merchantDialog').close());
  $('merchantDialog').addEventListener('close', () => { merchantDraft = null; });
  $('merchantQuestions').addEventListener('change', selectMerchantQuestions);
  $('merchantVariants').addEventListener('change', merchantPreview);
  $('polishMerchant').addEventListener('click', polishMerchant);
  $('copyMerchant').addEventListener('click', copyMerchant);
  $('openResultCalendar').addEventListener('click', () => {
    $('calendarTab').click();
    $('comparisonChart').scrollIntoView({block:'start'});
    $('calendarTab').focus({preventScroll:true});
  });
  $('resetCalendar').addEventListener('click', () => {
    if (mode === 'coffee') countVisitOffsets = null;
    else visitOffsets = null;
    calendarPage = 0;
    commitQuick();
    $('calendarTab').focus();
  });
  $('quickWeekdays').addEventListener('change', event => {
    visitOffsets = null;
    const box = $('weekdays').querySelector('input[value="' + event.target.value + '"]');
    box.checked = event.target.checked;
    if (!daysSelected().length && !$('studyFrequency').value) $('studyFrequency').value = '1';
    syncWeekdayFields();
    commitQuick();
  });
  $('fullPlan').addEventListener('click', () => planFocus(mode === 'study' && !daysSelected().length ? 'studyFrequency' : mode === 'study' ? 'studyHours' : 'cupCount'));
  $('chartMetric').addEventListener('change', () => calculate(false, false));
  $('chartScrub').addEventListener('change', event => {
    const spec = chartSpec(profile());
    spec.set(spec.values[Number(event.target.value)]);
    commitQuick();
  });
  for (const id of ['quickArrivalAsk','profileArrivalAsk']) $(id).addEventListener('click', openArrival);
  $('clearArrival').addEventListener('click', () => {
    arrivalPlan = null;
    $('profileTime').value = $('quickTime').value = '';
    commitQuick();
    $('quickArrivalAsk').focus();
  });
  $('arrivalClose').addEventListener('click', () => $('arrivalDialog').close());
  $('arrivalForm').addEventListener('submit', askArrival);
  $('arrivalAi').addEventListener('change', () => {
    try { localStorage.setItem('kdz-agent-use-deepseek', String($('arrivalAi').checked)); } catch {}
  });
  window.addEventListener('resize', () => { if (hasResult) scheduleQuick(); });

  restore();
  if (analysisId) {
    const conversation = $('compareAgentLink');
    conversation.href = '/?analysisId=' + encodeURIComponent(analysisId);
    conversation.hidden = false;
    const importer = $('importAgentOffer');
    importer.hidden = false;
    importer.addEventListener('click', () => importAgentOffer(analysisId));
  }
  render();
  if (confirmed && hasResult) calculate();
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    previewOptions = null;
    render();
    if (confirmed && hasResult) calculate();
  });
})();

