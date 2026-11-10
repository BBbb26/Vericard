'use strict';

(() => {
  const C = window.KDZCompare, W = window.KDZWallet;
  const $ = id => document.getElementById(id);
  const weekLabels = ['日','一','二','三','四','五','六'];
  const draftKey = 'kdz-comparison-1';
  const descriptions = {
    name:'方案名称', type:'购买方式', price:'套餐报价（元）', units:'权益次数', from:'生效日（可选）', until:'截止日',
    days:'激活后有效天数', validity:'有效期', limit:'最多购买几份（0 表示不限）', window:'可用时段',
    opens:'开始时间（如 08:00）', closes:'结束时间（可填 24:00）', weekdays:'可用日期',
    visitMax:'单次最长分钟数（0 表示不限）', redemption:'核销方式',
    billing:'计费步长（分钟）', minimum:'最低扣减分钟数（0 表示无最低）',
    restrictionsChecked:'其他限制',
  };
  const menus = {
    type:C.labels, validity:{ fixed:'固定日期', relative:'从激活日起计', unlimited:'无固定期限' },
    window:{ all:'不限时段', restricted:'指定日期与时段' }, weekdays:{ all:'每天', workdays:'工作日', weekends:'周末' },
    redemption:{ visit:'按到访扣一次', day:'同日只扣一次' },
  };
  const profileIds = ['compareMode','cupCount','studyFrequency','studyHours','studyWeeks','profileStart','profileTime','coffeeGap','sameProduct','allowMix'];
  const imagesById = new Map();
  let offers = [], confirmed = false, mode = 'coffee', hasResult = false, busy = false, lastUploadId = null;
  let previewOptions = null, reviewingOffer = null, quickFrame = 0;

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
      sessionStorage.setItem(draftKey, JSON.stringify({ offers, images:[...imagesById.values()], confirmed, hasResult, mode, lastUploadId, form, weekdays:daysSelected() }));
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
      lastUploadId = Object.hasOwn(draft, 'lastUploadId') ? draft.lastUploadId : offers.at(-1)?.imageIds.at(-1) ?? null;
      for (const id of profileIds) $(id)[$(id).type === 'checkbox' ? 'checked' : 'value'] = draft.form[id];
      $('weekdays').querySelectorAll('input').forEach(input => { input.checked = draft.weekdays.includes(Number(input.value)); });
    } catch {
      offers = [];
      imagesById.clear();
      lastUploadId = null;
      confirmed = hasResult = false;
    }
  }

  function createOffer(images = []) {
    return { id:crypto.randomUUID(), imageIds:images, edits:{}, history:[] };
  }

  function material(offer) {
    const images = offer.imageIds.map(id => imagesById.get(id)).filter(Boolean);
    const data = C.draft(images, offer.edits.type);
    return { images, candidates:data.candidates, values:{ ...data.values, ...offer.edits } };
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
    else if (['price','units','days','limit','visitMax','billing','minimum'].includes(key)) {
      control.inputMode = key === 'price' ? 'decimal' : 'numeric';
      control.placeholder = key === 'price' ? '例如 29.50' : '';
    }
    control.value = values[key] || '';
    control.addEventListener('input', () => {
      const before = Object.hasOwn(offer.edits, key) ? offer.edits[key] : values[key];
      edit(offer, key, control.value, before, '用户填写');
      const summary = control.closest('article').querySelector('[data-summary="' + key + '"]');
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

  function renderOffer(offer, index) {
    const { images, candidates, values } = material(offer);
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

    const conflicting = ['name','type','price','units','until','days','limit'].filter(key =>
      !values[key] && new Set((candidates[key] ?? []).map(item => key === 'price' ? C.cents(item.value) : item.value)).size > 1);
    if (conflicting.length) node.append(el('p', conflicting.map(key => descriptions[key]).join('、') + '有多个候选，请核对依据。', 'state-line'));
    const terms = el('div', undefined, 'compare-fields');
    const termKeys = ['validity','limit','window'];
    if (values.validity === 'fixed') termKeys.push('from','until');
    if (values.validity === 'relative') termKeys.push('days');
    if (values.window === 'restricted') termKeys.push('weekdays','opens','closes');
    if (values.type === 'visits' || values.type === 'period') termKeys.push('visitMax');
    if (values.type === 'visits') termKeys.push('redemption');
    if (values.type === 'hours') termKeys.push('billing','minimum');
    for (const key of termKeys) terms.append(field(offer, key, values));
    const termsTitle = values.validity === 'fixed' && values.until ? '有效至 ' + values.until :
      values.validity === 'relative' && values.days ? '激活后 ' + values.days + ' 天有效' :
      values.validity === 'unlimited' ? '无固定期限' : '有效期待确认';
    const termDetails = details(termsTitle + (values.limit ? (values.limit === '0' ? ' · 不限购' : ' · 限购 ' + values.limit + ' 份') : '') + ' · 编辑限制', terms);
    termDetails.dataset.role = 'terms';
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
    $('compareMode').value = mode;
    $('coffeeFields').hidden = $('coffeeGapLabel').hidden = $('mixLabel').hidden = study;
    $('studyFields').hidden = $('weekdays').hidden = !study;
    $('sameLabel').textContent = study ? '这些方案都满足我需要的门店与座位条件' : '这些券适用于我想买的同款商品';
  }

  function getOffers() {
    if (offers.length < 2) throw Error('至少添加两个购买方案。');
    return offers.map((offer, index) => {
      const { values:raw, candidates } = material(offer);
      raw.restrictionsPending = Boolean(candidates.unmodeled?.length && raw.restrictionsChecked !== 'yes');
      if (!raw.name) raw.name = (C.labels[raw.type] || '方案') + ' ' + (index + 1);
      return C.makeOffer(raw, index);
    });
  }

  function profile() {
    const hours = Number($('studyHours').value);
    const minutes = hours * 60;
    const weekdays = daysSelected();
    const time = $('profileTime').value;
    if (mode === 'study' && Math.abs(minutes - Math.round(minutes)) > 0.00001) throw Error('请填写可换算为整分钟的时长，例如 2.5 小时。');
    return C.makeProfile({
      count:$('cupCount').value, frequency:$('studyFrequency').value, minutes:Math.round(minutes), weeks:$('studyWeeks').value,
      start:$('profileStart').value, time, gap:$('coffeeGap').value, weekdays,
      sameProduct:$('sameProduct').checked, mix:$('allowMix').checked,
    }, mode);
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
      $('quickCupValue').textContent = usage.count + ' 杯';
      $('cupSlider').setAttribute('aria-valuetext', usage.count + ' 杯');
      $('quickPlanSummary').textContent = '本次比较 ' + result.count + ' 杯';
      return;
    }
    syncWeekdayFields();
    const days = usage.selected.length || usage.frequency;
    $('quickFrequency').value = days;
    $('quickFrequencyValue').textContent = usage.selected.length ? '已选 ' + days + ' 天' : days + ' 天';
    $('quickFrequency').setAttribute('aria-valuetext', days + ' 天');
    const exactMinutes = usage.minutes % 30 !== 0;
    $('quickDuration').min = exactMinutes ? 1 : 30;
    $('quickDuration').step = exactMinutes ? 1 : 30;
    $('quickDuration').max = Math.max(720, usage.minutes, Number($('quickDuration').max));
    $('quickDuration').value = usage.minutes;
    $('quickDurationValue').textContent = studyHours(usage.minutes);
    $('quickDuration').setAttribute('aria-valuetext', studyHours(usage.minutes));
    $('quickTime').value = $('profileTime').value;
    $('quickWeeks').value = usage.weeks;
    const basis = usage.selected.length ?
      (usage.start === null ? '按已选星期估算' : '按已选星期计算') + '（' + usage.selected.map(day => '周' + weekLabels[day]).join('、') + '）' :
      '按每周 ' + days + ' 天估算';
    $('quickPlanSummary').textContent = basis + ' · ' + usage.weeks + ' 周共 ' + result.count + ' 次 · ' + studyHours(result.minutes);
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
    window:{ key:'window', fields:['window','opens','closes','weekdays'],
      pattern:/可用时段|使用时段|适用时段|使用时间|入场时间|营业时间|部分时段可用/,
      specific:/\d{1,2}:\d{2}(?:至|到|[-—–~～·.一])\d{1,2}:\d{2}/ },
    visitMax:{ key:'visitMax', fields:['visitMax'], pattern:/每次.{0,12}(?:小时|分钟)|单次.{0,12}(?:小时|分钟)/ },
    redemption:{ key:'redemption', fields:['redemption'], pattern:/核销|每次到访|同日|每日/ },
    billing:{ key:'billing', fields:['billing','minimum'], pattern:/计费|计时|扣费|扣减/ },
  };

  function issueControl(note, index, result) {
    if (/^需要/.test(note)) {
      const target = note.includes('时段') && !$('profileTime').value && mode === 'study' ? 'quickTime' : 'profileStart';
      return button(note + ' →', () => planFocus(target), 'ghost');
    }
    if (/是否满足同一门店|是否适用于同款/.test(note)) return button(note + ' →', () => planFocus('sameProduct'), 'ghost');
    const key = /使用限制/.test(note) ? 'restrictionsChecked' : /购买/.test(note) ? 'limit' :
      /有效期/.test(note) ? 'validity' : /时段/.test(note) ? 'window' : /时长/.test(note) ? 'visitMax' :
      /核销/.test(note) ? 'redemption' : /计费|扣减/.test(note) ? 'billing' : null;
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

  function makeResultCard(row, index, result, costScale, study) {
    const item = el('article', undefined, 'compare-result');
    const best = result.tied.includes(row);
    item.dataset.best = String(best);
    const header = el('div', undefined, 'section-heading');
    const title = el('h3', row.name);
    const badge = el('span', row.missing ? '覆盖不全' : best ? (result.conditional ? '条件推荐' : '当前推荐') : row.notes.length ? '条件试算' : '覆盖完整', 'badge');
    badge.dataset.tone = row.missing ? 'warning' : best && !result.conditional ? 'success' : 'neutral';
    title.append(badge);
    header.append(title, el('p', W.money(row.cost), 'compare-price'));
    item.append(header, el('p', row.detail, 'muted compare-result-detail'));
    const marks = el('div', undefined, 'compare-result-marks');
    const countLabel = study ? ' 次' : ' 杯';
    let coverage = row.covered + ' / ' + result.count + countLabel;
    if (study) coverage += ' · ' + studyHours(row.coveredMinutes) + ' / ' + studyHours(result.minutes);
    if (row.missing) coverage += ' · 缺 ' + (study ? row.missing + ' 次（' + studyHours(row.missingMinutes) + '）' : row.missing + ' 杯');
    marks.append(measure('计划覆盖', row.covered, result.count, coverage, best, row.missing > 0));
    marks.append(measure(row.missing ? '当前方案支出' : '完整覆盖支出', row.cost, row.missing ? 0 : costScale,
      row.missing ? W.money(row.cost) + ' · 缺口补买费用待确认' : W.money(row.cost), best));
    item.append(marks);
    if (row.left > 0 && row.type === 'hours') item.append(el('p', '账面剩余 ' + studyHours(row.left) + ' · 以扣费规则为准', 'muted'));
    else if (row.left > 0 && row.type === 'visits') item.append(el('p', '未扣减权益 ' + row.left + ' 次', 'muted'));
    if (row.notes.length) item.append(details('试算条件与依据', issueList(row.notes, index, result)));
    const source = offers[index];
    if (source) {
      item.append(button('我已购买，加入卡包', () => {
        const { images, values } = material(source);
        window.KDZWalletEnroll.open({ offer:{ ...values,name:row.name },images,offerId:source.id });
      }, 'ghost'));
    } else item.append(el('p', '组合中的实际购入卡券可从各方案分别登记。', 'muted'));
    return item;
  }

  function renderResult(result, usage) {
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
    $('coverageGoal').textContent = study ? result.count + ' 次 · ' + studyHours(result.minutes) : result.count + ' 杯';
    const costScale = Math.max(1, ...result.rows.filter(row => !row.missing).map(row => row.cost));
    $('resultRows').replaceChildren(...result.rows.map((row, index) => makeResultCard(row, index, result, costScale, study)));
    const issues = [...result.issues].sort((a,b) => Number(/^需要/.test(b)) - Number(/^需要/.test(a)));
    $('resultQuestions').replaceChildren(...issues.slice(0, 2).map(issue => issueControl(issue, -1, result)));
    $('issueDetails').hidden = issues.length <= 2;
    $('resultIssues').replaceChildren(...issueList(issues.slice(2), -1, result).children);
    $('resultSection').hidden = false;
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
    metric.options[0].disabled = study && usage.selected.length > 0;
    if (metric.value === 'frequency' && metric.options[0].disabled) metric.value = 'duration';
    if (!study) return { values:Array.from({length:Number($('cupSlider').max)}, (_, i) => i + 1), selected:usage.count,
      label:value => value + ' 杯', dimension:'杯数', compare:(options,value) => C.compare(options, usage, value), set:value => { $('cupCount').value = value; } };
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
    const spec = chartSpec(usage);
    const series = spec.values.map(value => spec.compare(options, value));
    const width = Math.max(280, Math.min(640, $('chartArea').clientWidth || 560));
    const height = 226, left = width < 430 ? 65 : 81, right = 44, top = 14, bottom = 31;
    const cap = Math.max(100, ...series.flatMap(item => item.rows.filter(row => !row.missing).map(row => row.cost)));
    const quarter = cap / 4;
    const magnitude = 10 ** Math.floor(Math.log10(quarter));
    const step = [1,2,2.5,5,10].find(value=>value*magnitude>=quarter) * magnitude;
    const ceiling = step * 4;
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
    const palette = ['var(--color-primary)','var(--color-info)','var(--color-chart-teal)','var(--color-chart-gold)','var(--color-chart-rose)','var(--color-text-secondary)'];
    const combos = series.some(item => item.rows.length > options.length);
    const legend = [];
    const selected = series[spec.values.indexOf(spec.selected)];
    const selectedRows = [];
    for (let index = 0; index < options.length + Number(combos); index++) {
      const color = palette[index];
      const tag = el('span');
      const swatch = el('i');
      swatch.style.backgroundColor = color;
      tag.append(swatch, document.createTextNode(options[index]?.name || '组合购买'));
      legend.push(tag);
      const choice = selected?.rows[index];
      if (choice && !choice.missing) {
        const fact = el('li');
        fact.append(el('span',choice.name),el('strong',W.money(choice.cost)),
          ...(choice.notes.length || selected.conditional ? [el('small','条件试算','muted')] : []));
        selectedRows.push(fact);
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
    picture.addEventListener('click', event => {
      const matrix = picture.getScreenCTM();
      if (!matrix) return;
      const pointer = picture.createSVGPoint();
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      const position = pointer.matrixTransform(matrix.inverse());
      if (position.y < top || position.y > height - bottom || position.x < left - 3 || position.x > width - right + 3) return;
      const value = spec.values.reduce((best, current) => Math.abs(x(current) - position.x) < Math.abs(x(best) - position.x) ? current : best);
      spec.set(value);
      commitQuick();
    });
    $('chartArea').replaceChildren(picture);
    $('chartLegend').replaceChildren(...legend);
    $('chartCount').textContent = '当前 · ' + spec.label(spec.selected);
    const readout = el('ul');
    readout.append(...selectedRows);
    $('chartReadout').replaceChildren(el('strong','当前用量 · '+spec.label(spec.selected)),
      selectedRows.length ? readout : el('p','当前用量没有完整覆盖的方案。','muted'));
    const basis = usage.mode === 'study' && usage.selected.length ? ' · 已选星期保持不变' : '';
    $('chartHint').textContent = '仅改变' + spec.dimension + basis + '。折线展示能完整覆盖的方案，虚线为条件试算。点击图上位置可应用该用量。';
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
      if (mode === 'coffee' && options.some(item => !['single','visits'].includes(item.type))) throw Error('小时卡和期限卡请用按时使用场景比较。');
      if (mode === 'study' && options.some(item => item.type === 'single')) throw Error('单次券可按一次到访计为 1 次的次卡，再核对单次时长。');
      const result = C.compare(options, usage);
      warning('profileError');
      renderResult(result, usage);
      $('comparisonChart').hidden = false;
      drawChart(options, usage);
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
      mode = options.some(item => ['hours','period'].includes(item.type)) ? 'study' : $('compareMode').value;
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
    if (event.target.id === 'compareMode') {
      mode = event.target.value;
      $('sameProduct').checked = false;
      updateMode();
    }
    syncWeekdayFields();
    if (hasResult) commitQuick();
    else save();
  });
  for (const [id, update] of [
    ['cupSlider', value => { $('cupCount').value = value; }],
    ['quickFrequency', value => { if (!daysSelected().length) $('studyFrequency').value = value; }],
    ['quickDuration', value => { $('studyHours').value = Number(value) / 60; }],
  ]) {
    $(id).addEventListener('input', event => { update(event.target.value); scheduleQuick(); });
    $(id).addEventListener('change', commitQuick);
  }
  $('quickTime').addEventListener('change', event => {
    $('profileTime').value = event.target.value;
    commitQuick();
  });
  $('quickWeeks').addEventListener('change', event => {
    if (event.target.checkValidity() && event.target.value) $('studyWeeks').value = event.target.value;
    else event.target.value = $('studyWeeks').value;
    commitQuick();
  });
  $('quickWeekdays').addEventListener('change', event => {
    const box = $('weekdays').querySelector('input[value="' + event.target.value + '"]');
    box.checked = event.target.checked;
    if (!daysSelected().length && !$('studyFrequency').value) $('studyFrequency').value = '1';
    syncWeekdayFields();
    commitQuick();
  });
  $('fullPlan').addEventListener('click', () => planFocus(mode === 'study' && !daysSelected().length ? 'studyFrequency' : mode === 'study' ? 'studyHours' : 'cupCount'));
  $('chartMetric').addEventListener('change', () => calculate(false, false));
  window.addEventListener('resize', () => { if (hasResult) scheduleQuick(); });

  let hadDraft = false;
  try { hadDraft = Boolean(sessionStorage.getItem(draftKey)); } catch {}
  restore();
  const params = new URLSearchParams(location.search);
  const requestedMode = params.get('mode');
  const analysisId = params.get('analysisId');
  if (analysisId) {
    const conversation = $('compareAgentLink');
    conversation.href = '/?analysisId=' + encodeURIComponent(analysisId);
    conversation.hidden = false;
    const importer = $('importAgentOffer');
    importer.hidden = false;
    importer.addEventListener('click', () => importAgentOffer(analysisId));
  }
  if (!hadDraft && ['coffee', 'study'].includes(requestedMode)) mode = requestedMode;
  render();
  if (confirmed && hasResult) calculate();
})();

