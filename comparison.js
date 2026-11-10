(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' ? require('./extract') : root.KDZExtract;
  const labels = { single: '单次券', visits: '次卡', hours: '小时卡', period: '期限卡' };
  const fields = ['name','type','price','units','from','until','days','purchaseDays','validity','limit','window','opens','closes','weekdays','workdayOpens','workdayCloses','weekendOpens','weekendCloses','visitMax','redemption','billing','minimum','restrictionsChecked'];
  const dayMs = 86400000;
  const countPattern = '([0-9零〇一二两三四五六七八九十]{1,4})';
  const limitPattern = new RegExp('(?:限购|最多购买)' + countPattern + '(?:张|份)');

  function quoteCents(line) {
    const text = line.text;
    const bundle = /^¥(\d+(?:\.\d{1,2})?)\/(?:共)?(\d{1,3})次(?:单次(\d+(?:\.\d{1,2})?)元)?/.exec(text);
    if (bundle) {
      const [, printed, count, perUse] = bundle;
      const shown = cents(printed);
      if (!perUse) return shown;
      const implied = cents(perUse) * Number(count);
      if (!printed.includes('.') && [10, 100].some(scale => shown === implied * scale)) return implied;
      return Math.abs(shown - implied) <= Number(count) ? shown : null;
    }
    const labeled = /^(?:套餐价|团购价|券价|折后价?|售价)[:：]?¥?(\d+(?:\.\d{1,2})?)(?:元)?(?:$|[|丨〉])/.exec(text);
    const discount = /^¥(\d+\.\d{1,2}?)([1-9]\.\d)折(?:$|[〉>])/.exec(text);
    return cents((labeled || discount)?.[1]);
  }

  function footerPrice(lines, height) {
    if (!height) return null;
    const footer = lines.filter(line => line.box?.y / height >= .86);
    const offers = [];
    for (const line of footer) {
      const matched = /^(折后价?|券后价?|团购价|套餐价)?[:：]?¥(\d[^|丨〉>元]*)(?:[|丨〉>元]|$)/.exec(line.text);
      if (!matched) continue;
      const [, marker, raw] = matched;
      if (!marker && line.box.y / height < .93) continue;
      if (!marker && !/^\d+(?:\.\d{1,2})?$/.test(raw)) continue;
      const value = quoteCents(line) ?? cents(raw);
      offers.push({ line, value, key:value === null ? 'ocr:' + raw : 'cents:' + value, priority:marker ? 2 : 1 });
    }
    const priority = Math.max(0, ...offers.map(item => item.priority));
    const selected = offers.filter(item => item.priority === priority);
    return new Set(selected.map(item => item.key)).size === 1 ? selected[0] : null;
  }

  function headline(lines, height) {
    const labeled = lines.filter(line => /^(?:套餐名称|团购名称|商品名称)[:：].+/.test(line.text));
    if (labeled.length) return labeled.map(line => ({ value:line.text.replace(/^[^:：]+[:：]/, ''), line, rank:4 }));
    const goodTitle = value => value.length >= 3 && value.length <= 95 && /[\u4e00-\u9fff]/.test(value) &&
      !/^(?:使用时间|使用规则|使用说明|可用时段|权益说明|价格说明|购买须知|商品详情|团购详情|图文详情|价格|已售|会员价|购买|退款|优惠|规格|服务内容|适用|每人|单次价格|如|例如|共\d+次$)/.test(value) &&
      !/使用时间|使用须知|使用说明|退款规则|好评|销量|限购|不可用|有效期|适用门店|座位可用/.test(value);
    const prices = lines.filter(line => quoteCents(line) !== null && (!height || line.box?.y / height < .84));
    const nearby = (line, ratio) => Boolean(height && line.box && prices.some(price => price.box &&
      Math.abs(line.box.y - price.box.y) <= height * ratio));
    const branded = [];
    for (const line of lines) {
      const bracket = /^(?:[【〖「\[])([^】〗〕」\]]+)[】〗〕」\]](.+)$/.exec(line.text);
      if (!bracket || !goodTitle(bracket[2]) || !nearby(line, .19)) continue;
      const continuation = lines.find(other => other.box && line.box && other.box.y > line.box.y &&
        other.box.y - line.box.y <= Math.max(line.box.height * 1.8, 1) &&
        /^(?:杯|次卡|小时卡|卡|\/)(?:[\/（(、]|低因|可选|适用|$)/.test(other.text));
      branded.push({ value:line.text + (continuation?.text ?? ''), line, rank:3 });
    }
    if (branded.length) return branded;
    const cardTitle = /^(?:[\u4e00-\u9fffA-Za-z]{0,20}(?:\d{1,3}|十|二十|三十)次卡|[\u4e00-\u9fffA-Za-z]{0,14}\d{1,4}(?:小时|[hH])卡|[\u4e00-\u9fff]{0,12}(?:月卡|季卡|周卡|期限会员)|.{0,20}(?:单杯券|单次券|单杯团购|单大杯))(?:$|[【〖（(\/]|低因)/;
    const names = lines.filter(line => goodTitle(line.text) && cardTitle.test(line.text) &&
      (!height || line.box?.y / height < .86));
    const besidePrice = names.filter(line => nearby(line, .17));
    if (besidePrice.length) return besidePrice.map(line => ({ value:line.text, line, rank:3 }));
    if (names.length) return names.map(line => ({ value:line.text, line, rank:2 }));
    const generic = lines.filter(line => goodTitle(line.text) && line.text.length >= 5 && nearby(line, .09) &&
      !/折|原价|领券|减\d|￥|¥|限时优惠|选\d+|人购买|展示价/.test(line.text));
    return generic.length === 1 ? [{ value:generic[0].text, line:generic[0], rank:1 }] : [];
  }

  function normalizeHeadline(value) {
    return value.replace(/^[【〖「\[][^\]】〗〕」]+[\]】〗〕」]/, '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  }

  function preferred(entries = []) {
    const rank = Math.max(0, ...entries.map(item => item.rank || 0));
    return entries.filter(item => (item.rank || 0) === rank);
  }

  function uniqueValue(entries, key) {
    const values = [...new Set((entries ?? []).map(item => key === 'price' ? cents(item.value) : item.value))];
    return values.length === 1 && values[0] != null ? String(key === 'price' ? values[0] / 100 : values[0]) : '';
  }

  function matchesPrevious(images, incoming) {
    if (!images.length || !incoming.ocr?.lines?.length) return false;
    const previous = suggestions(images);
    const next = suggestions([incoming]);
    const priorFooters = previous.footer ?? [];
    const nextFooters = next.footer ?? [];
    const sameFooter = nextFooters.some(item => priorFooters.some(prior => prior.value === item.value));
    if (!sameFooter) return false;
    for (const key of ['price','type','merchant','unitsHours','unitsVisits']) {
      const a = uniqueValue(preferred(previous[key]), key), b = uniqueValue(preferred(next[key]), key);
      if (a && b && a !== b) return false;
    }
    const priorNames = preferred(previous.name).filter(item => item.rank >= 2).map(item => normalizeHeadline(item.value));
    const nextNames = preferred(next.name).filter(item => item.rank >= 2).map(item => normalizeHeadline(item.value));
    return !priorNames.length || !nextNames.length || priorNames.some(a => nextNames.some(b => {
      const [shorter, longer] = a.length <= b.length ? [a,b] : [b,a];
      return a === b || (shorter.length >= 8 && longer.startsWith(shorter));
    }));
  }

  function scheduleSpans(text, afterHeading = false) {
    const heading = /(?:使用|可用|适用)(?:时间|时段)/;
    if (/营业时间|营业时段|预约时间|客服|退款|示例|例如/.test(text)) return [];
    const spans = [];
    let end = 0;
    for (const span of text.matchAll(/(\d{1,2}:\d{2})[-–—~至到.·一]+(\d{1,2}:\d{2})/g)) {
      const prefix = text.slice(end, span.index);
      end = span.index + span[0].length;
      const suffix = text.slice(end).split(/[,，;；。·]/, 1)[0];
      if (/不可用|不适用|不开放|除外/.test(suffix)) continue;
      const scope = /每天|每日|(?:周|星期)一(?:至|到|[-–—~])(?:周|星期)?[日天]/.test(prefix) ? 'all' :
        /工作日|(?:周|星期)一(?:至|到|[-–—~])(?:周|星期)?五/.test(prefix) ? 'workdays' :
        /周末|(?:周|星期)六.{0,4}(?:周|星期)?[日天]/.test(prefix) ? 'weekends' : '';
      if (!scope && !afterHeading && !heading.test(prefix)) continue;
      const opens = span[1].padStart(5, '0'), closes = span[2].padStart(5, '0');
      if (time(opens) === null || time(closes) === null || time(opens) >= time(closes)) continue;
      spans.push({ scope, opens, closes, clause:prefix + span[0] });
    }
    return spans;
  }

  function suggestions(images) {
    const result = {};
    const schedules = [];
    function add(key, value, image, line, rank = 0) {
      if (value == null || value === '') return;
      const entries = result[key] ??= [];
      if (!entries.some(entry => entry.value === String(value) && entry.imageId === image.id && entry.quote === line.quote)) {
        entries.push({ value: String(value), imageId: image.id, quote: line.quote, box: line.box, rank });
      }
    }
    for (const image of images) {
      const base = E.extract(image);
      for (const fact of base) {
        if (fact.field === 'fixedEnd' && !/如|示例|赠送|购买后|核销前/.test(fact.quote)) add('until', fact.value, image, fact);
        if (fact.field === 'merchant') add('merchant', fact.value, image, fact);
        if (fact.field === 'purchaseDays' && !/退款|退还|示例|例如|^如|赠送/.test(E.clean(fact.quote)) &&
            integer(fact.value, 1, 3660) !== null) add('purchaseDays', fact.value, image, fact);
      }
      const lines = (image.ocr?.lines ?? []).map(line => ({ quote: line.text, box: line.box, text: E.clean(line.text).replace(/[·．]/g, '.') }));
      const footer = footerPrice(lines, image.ocr?.height);
      if (footer) {
        add('footer', footer.key, image, footer.line);
        if (footer.value !== null) add('price', String(footer.value / 100), image, footer.line, 2);
      }
      for (const title of headline(lines, image.ocr?.height)) add('name', title.value, image, title.line, title.rank);
      const imageTypes = new Set();
      const singleHints = [];
      let afterScheduleHeading = false;
      for (const line of lines) {
        const t = line.text;
        for (const span of scheduleSpans(t, afterScheduleHeading)) schedules.push({ ...span, image, line });
        afterScheduleHeading = /^(?:使用|可用|适用)(?:时间|时段):?$/.test(t);
        if (/^(?:适用商品|同款商品|服务项目|适用项目)[:：]/.test(t)) add('product', t.split(/[:：]/).slice(1).join('：'), image, line);
        if (/退款|例如|示例|^如|卡如|^赠送/.test(t)) continue;

        const title = t.replace(/^(?:套餐名称|团购名称|商品名称)[:：]/, '');
        const single = /^(?:.{0,18}(?:单杯券|单次券|单杯团购)|单次购买券)/.test(title);
        const hours = /(?:^|[:：])(\d{1,4})(?:小时|[hH])(?:卡|1个座位)/.exec(title);
        const mins = /^(?:套餐总时长为|总计)(\d{1,6})分钟/.exec(t);
        const bundle = /^¥(\d+(?:\.\d{1,2})?)\/(?:共)?(\d{1,3})次(?:单次(\d+(?:\.\d{1,2})?)元)?/.exec(t);
        const visits = /^(?:(?:套餐包含|共|总计)?(\d{1,3})次卡|(?:共|总计|套餐包含)(\d{1,3})次|验券后可间断使用(\d{1,3})次)/.exec(title);
        const period = /^(?:[\u4e00-\u9fff]{0,12}(?:月卡|周卡|季卡|期限会员)|连续\d+天)/.test(title) && !/使用时间|使用说明|有效期|限制|规则/.test(title);
        if (/^饮品\d+选1/.test(title)) singleHints.push(line);
        const type = single ? 'single' : hours || mins ? 'hours' : visits || bundle ? 'visits' : period ? 'period' : '';
        if (type) {
          imageTypes.add(type);
          add('type', type, image, line);
        }
        if (hours) add('unitsHours', Number(hours[1]) * 60, image, line);
        if (mins) add('unitsHours', mins[1], image, line);
        if (visits) {
          const bonus = /^[（(]?(?:赠|送)(\d+)次/.exec(title.slice(visits[0].length));
          add('unitsVisits', Number(visits[1] || visits[2] || visits[3]) + Number(bonus?.[1] ?? 0), image, line);
        }
        if (bundle) add('unitsVisits', bundle[2], image, line);
        const price = quoteCents(line);
        if (price !== null && (!image.ocr?.height || !(line.box?.y / image.ocr.height >= .86))) {
          add('price', String(price / 100), image, line, 3);
        }
        const limits = limitPattern.exec(t);
        const limit = limits ? countValue(limits[1]) : null;
        if (limit > 0 && limit <= 1000) add('limit', limit, image, line);
        if (/^(?:不限购|每人不限购)(?:$|[。；，])/.test(t)) add('limit', '0', image, line);
        if (/^(?:同款|同一套餐|本套餐)(?:多份|多张)?(?:不可|不能|不支持|不得)(?:叠加|合并)使用[。.]?$/.test(t)) {
          add('stack', '同款不可叠加使用', image, line);
        }
        if (/^(?:永久有效|无固定有效期|不限有效期)$/.test(t)) add('validity', 'unlimited', image, line);
        if (/^(?:全天可用|不限使用时段)$/.test(t)) add('window', 'all', image, line);
        if (/^(?:每次到访扣一次|按次核销)$/.test(t)) add('redemption', 'visit', image, line);
        if (/^(?:每日只扣一次|按天核销)$/.test(t)) add('redemption', 'day', image, line);
        const days = /(?:^|[,:;。])(?:(?:主卡)?有效期:?|使用期限:?)?(?:自|从)?(?:激活|开卡|生效|(?:首次)?核销|兑换|验券)(?:成功)?(?:之?后|之?日起)(\d+)天(?:内)?(?:有效|可使用|可用)|^(?:月卡时长为|有效期:?|限制详情:?)?连续(?:使用)?(\d+)天/.exec(t);
        const duration = integer(days?.[1] || days?.[2], 1, 3660);
        if (duration !== null) add('days', duration, image, line);
        const dates = /^(?:有效期[:：]?)?(20\d{2})[年./-](\d{1,2})[月./-](\d{1,2})日?(?:至|到|—|~|-)(20\d{2})[年./-](\d{1,2})[月./-](\d{1,2})日?$/.exec(t);
        if (dates) {
          add('from', isoParts(dates.slice(1, 4)), image, line);
          add('until', isoParts(dates.slice(4, 7)), image, line);
        }
        const cap = /^(?:每次(?:最多|限用)|使用时长(?:至多|最多))(\d+)(小时|分钟)(?:\/天)?[。.]?$/.exec(t);
        if (cap) add('visitMax', Number(cap[1]) * (cap[2] === '小时' ? 60 : 1), image, line);
        if (/^(?:每次不限时长|单次不限时长)$/.test(t)) add('visitMax', '0', image, line);
        const billing = /^按(\d+)分钟计费(?:，不足按(?:一个单位|该单位)计)?$/.exec(t);
        if (billing) add('billing', billing[1], image, line);
        if (t === '按分钟扣费') add('billing', '1', image, line);
        if (/仅限|每日限|每天限|每日最多|每天最多|节假日|部分时段|需预约|额外收费|附加费|不可叠加|周[末六日天].{0,10}(?:不可用|不适用)/.test(t) && !/无需预约/.test(t)) add('unmodeled', '有待核实的使用限制', image, line);
        const minimum = /^最低(?:扣费|计费)(\d+)分钟$/.exec(t);
        if (minimum) add('minimum', minimum[1], image, line);
        if (t === '无最低计费时长') add('minimum', '0', image, line);
      }
      if (!imageTypes.size && singleHints.length) {
        imageTypes.add('single');
        for (const line of singleHints) add('type', 'single', image, line);
      }
      const standalone = lines.filter(line => /^¥\d+(?:\.\d{1,2})?$/.test(line.text));
      if (imageTypes.size === 1 && standalone.length === 1 && !result.price?.some(item => item.imageId === image.id)) {
        add('price', standalone[0].text.slice(1), image, standalone[0], 1);
      }
    }
    if (schedules.length) {
      const scopes = new Set(schedules.map(item => item.scope).filter(Boolean));
      const ranges = new Set(schedules.map(item => item.opens + '–' + item.closes));
      const scoped = key => schedules.filter(item => item.scope === key);
      const workdays = scoped('workdays'), weekends = scoped('weekends');
      const byRange = items => new Set(items.map(item => item.opens + '–' + item.closes));
      const split = scopes.size === 2 && !scopes.has('all') && ranges.size === 2 &&
        byRange(workdays).size === 1 && byRange(weekends).size === 1;
      if (split && !result.window?.length) {
        for (const [key, items] of [['workday', workdays], ['weekend', weekends]]) {
          for (const item of items) {
            add('window', 'split', item.image, item.line);
            add(key + 'Opens', item.opens, item.image, item.line);
            add(key + 'Closes', item.closes, item.image, item.line);
          }
        }
      } else if (ranges.size === 1 && scopes.size && !result.window?.some(item => item.value === 'all')) {
        const scope = scopes.has('all') || scopes.size === 2 ? 'all' : [...scopes][0];
        for (const item of schedules.filter(item => item.scope)) {
          add('window', 'restricted', item.image, item.line);
          add('weekdays', scope, item.image, item.line);
          add('opens', item.opens, item.image, item.line);
          add('closes', item.closes, item.image, item.line);
        }
      } else {
        for (const item of result.window ?? []) add('unmodeled', '时段需核对', { id:item.imageId }, item);
        delete result.window;
        for (const item of schedules) add('unmodeled', '时段需核对', item.image, item.line);
      }
    }
    return result;
  }

  function draft(images, selectedType) {
    const candidates = suggestions(images);
    for (const key of ['name','price']) {
      if (candidates[key]) candidates[key] = preferred(candidates[key]);
    }
    const only = key => uniqueValue(candidates[key], key);
    const values = Object.fromEntries(fields.map(key => [key, only(key)]));
    values.stackingBlocked = Boolean(candidates.stack?.length);
    const units = (selectedType || values.type) === 'hours' ? 'unitsHours' : 'unitsVisits';
    values.units = only(units);
    candidates.units = candidates[units] ?? [];
    const validityModes = [candidates.until?.length && 'fixed', candidates.days?.length && 'relative', values.validity].filter(Boolean);
    values.validity = validityModes.length === 1 ? validityModes[0] : '';
    if ((values.validity === 'fixed' && !values.until) || (values.validity === 'relative' && !values.days)) values.validity = '';
    return { values, candidates };
  }


  function termsIdentity(image) {
    const lines = (image.ocr?.lines ?? []).map(line => E.clean(line.text));
    const code = lines.map(line => /(?:套餐|商品|团购)(?:编号|id)[:：]([a-z0-9_-]{2,48})/i.exec(line)?.[1]).find(Boolean) ?? null;
    const version = lines.map(line => /(?:条款版本|规则版本|套餐版本|适用版本|版本号)[:：]([a-z0-9_.-]{1,32})/i.exec(line)?.[1]).find(Boolean) ?? null;
    return { code: code?.toLowerCase() ?? null, version: version?.toLowerCase() ?? null };
  }

  function compatibleTerms(left, right) {
    return (!left.code || !right.code || left.code === right.code) &&
      (!left.version || !right.version || left.version === right.version);
  }

  function groupPackages(images) {
    const pages = images.map(image => {
      const { values, candidates } = draft([image]);
      const title = candidates.name?.find(item => item.rank >= 2)?.value;
      return { image, ...termsIdentity(image), name: title ? normalizeHeadline(title) : '', type: values.type, price: values.price };
    });
    const groups = [];
    const byPage = new Map();
    for (const page of pages) {
      // A priced product heading starts a group. A footer price on a rules page only matches a group.
      if (!page.name || !page.price) continue;
      const group = groups.find(item => {
        const sameName = item.name === page.name ||
          (item.price === page.price && item.type === page.type &&
            (item.name.startsWith(page.name) || page.name.startsWith(item.name)));
        return sameName && compatibleTerms(item, page) && (!item.type || !page.type || item.type === page.type);
      });
      if (group) {
        group.prices.add(page.price);
        group.code ??= page.code;
        group.version ??= page.version;
        byPage.set(page, group);
      } else {
        const anchor = { name: page.name, type: page.type, code: page.code, version: page.version, prices: new Set([page.price]), images: [] };
        groups.push(anchor);
        byPage.set(page, anchor);
      }
    }
    if (!groups.length) return { groups: images.length ? [images] : [], unmatched: [], inferred: 0 };
    if (groups.length === 1) {
      const [anchor] = groups;
      return { groups: [pages.filter(page => compatibleTerms(anchor, page)).map(page => page.image)],
        unmatched: pages.filter(page => !compatibleTerms(anchor, page)).map(page => page.image), inferred: 0 };
    }
    let last;
    let inferred = 0;
    const unmatched = [];
    for (const page of pages) {
      if (byPage.has(page)) last = byPage.get(page);
      const matches = page.price ? groups.filter(group => group.prices.has(page.price) && compatibleTerms(group, page) &&
        (!group.type || !page.type || group.type === page.type)) : [];
      let group = byPage.get(page) ?? (matches.length === 1 ? matches[0] : null);
      const sameTitle = groups.filter(item => item.name === last?.name && compatibleTerms(item, page));
      const ambiguousVersion = sameTitle.some(item => !compatibleTerms(item, last));
      if (!group && last && !ambiguousVersion && compatibleTerms(last, page) && (!page.price || matches.includes(last)) && (!page.type || !last.type || page.type === last.type)) {
        group = last;
        inferred++;
      }
      if (group) group.images.push(page.image);
      else unmatched.push(page.image);
    }
    return { groups: groups.map(group => group.images), unmatched, inferred };
  }

  function packageSummary(images) {
    const { values, candidates } = draft(images);
    const evidence = {};
    const claims = [];
    const identities = new Map(images.map(image => [image.id, termsIdentity(image)]));
    const uniqueIdentity = key => {
      const values = [...new Set([...identities.values()].map(item => item[key]).filter(Boolean))];
      return values.length === 1 ? values[0] : null;
    };
    const code = uniqueIdentity('code');
    const version = uniqueIdentity('version');
    const anchor = images.find(image => {
      const result = draft([image]);
      return result.values.price && result.candidates.name?.some(candidate => candidate.rank >= 2);
    }) ?? images[0];
    const packageId = code && values.name ? 'code:' + code + ':' + normalizeHeadline(values.name).slice(0, 80) : 'image:' + anchor?.id;

    function add(key, value, image, quote, conditionText = quote) {
      if (!value) return;
      const record = { value, imageId: image.id, quote };
      const identity = identities.get(image.id);
      claims.push({ key, ...record, conditionText, version: identity?.version ?? null, code: identity?.code ?? null });
      const entries = evidence[key] ??= [];
      if (!entries.some(item => item.value === value)) entries.push(record);
    }
    for (const image of images) {
      for (const line of image.ocr?.lines ?? []) {
        const t = E.clean(line.text);
        const purchase = /购买后(\d+)天(?:内)?有效/.exec(t);
        const continuous = /(?:连续(?:使用)?|(?:激活|核销|兑换|验券)后)(\d+)天(?:内)?(?:使用|有效|可用)?/.exec(t);
        if (purchase) add('purchase', purchase[1] + ' 天', image, line.text);
        if (continuous && !/例如|如月卡|退还|退款/.test(t)) add('duration', continuous[1] + ' 天', image, line.text);
        const daily = /(?:使用时长至多|每日最多|每天最多|每日限用|每天限用)(\d+)(小时|分钟)(?:\/天)?/.exec(t);
        if (daily) add('daily', daily[1] + daily[2], image, line.text);
        for (const clause of t.split(/[，,；;。]/)) {
          const free = /无需预约|免预约|不需要预约/.test(clause);
          const requires = /(?:需(?:要)?(?:至少)?提前|请务必|必须|每次需|每日需|需要).{0,22}预约/.test(
            clause.replace(/无需预约|免预约|不需要预约/g, '')) && !/如需预约|对于需要预约/.test(clause);
          if (free) add('reserve', '无需预约', image, line.text, clause);
          if (requires) add('reserve', '需要预约', image, line.text, clause);
          if (/(?:验券|核销|激活|开卡)后(?:不(?:可|能)退|不支持退)/.test(clause)) {
            add('refund', '核销后不可退', image, line.text, clause);
          }
          if (/部分未使用可退|部分未使用.{0,10}退还|剩余(?:天数|次数|金额).{0,10}可退/.test(clause)) {
            add('refund', '部分未使用可退', image, line.text, clause);
          }
          const fee = /未消费(?:余额|金额)(\d+)%的?手续费/.exec(clause);
          if (fee) add('fee', fee[1] + '% 手续费', image, line.text, clause);
        }
        for (const span of scheduleSpans(t)) {
          const interval = span.opens + '–' + span.closes;
          if (span.scope === 'all' || span.scope === 'workdays') add('weekday', interval, image, line.text, span.clause);
          if (span.scope === 'all' || span.scope === 'weekends') add('weekend', interval, image, line.text, span.clause);
        }
      }
    }
    if (values.days && !evidence.duration) {
      const candidate = candidates.days?.[0];
      if (candidate) add('duration', values.days + ' 天', { id: candidate.imageId }, candidate.quote);
    }
    for (const key of ['limit', 'stack']) {
      for (const candidate of candidates[key] ?? []) {
        add(key, candidate.value, { id: candidate.imageId }, candidate.quote);
      }
    }
    const durations = evidence.duration ?? [];
    const duration = durations.length === 1 ? Number.parseInt(durations[0].value, 10) : null;
    const [shortName, detail = ''] = values.name.split(/[〖【[(]/, 2);
    return {
      images, type: values.type, name: values.name, shortName, detail: detail.replace(/[〗】)\]]$/, ''),
      price: cents(values.price), units: integer(values.units, 1, 1000),
      limit: integer(values.limit, 0, 1000), stackingBlocked: values.stackingBlocked, duration, evidence, claims, packageId, code, version,
    };
  }

  function purchaseCount(needed, limit, fallback = 1) {
    return limit === 0 ? needed : Math.min(needed, limit ?? fallback);
  }

  function effectivePurchaseLimit(offerLimit, plannedLimit) {
    if (!Number.isInteger(plannedLimit) || plannedLimit < 1 || plannedLimit > 1000) return offerLimit;
    return offerLimit > 0 ? Math.min(offerLimit, plannedLimit) : plannedLimit;
  }

  function packagePreview(offer, visits, horizon, plannedLimit) {
    if (offer.price === null || visits < 1) return null;
    const quota = offer.type === 'single' ? 1 : offer.type === 'visits' ? offer.units :
      offer.type === 'period' && horizon && offer.duration >= horizon ? horizon : null;
    if (!quota) return null;
    const limit = offer.type === 'period' || offer.stackingBlocked ? 1 : effectivePurchaseLimit(offer.limit, plannedLimit);
    const quantity = purchaseCount(Math.ceil(visits / quota), limit);
    const paid = offer.price * quantity;
    const covered = Math.min(quota * quantity, visits);
    return { paid, covered, missing: visits - covered, perVisit: Math.round(paid / covered),
      quantity, quota: quota * quantity, left: quota * quantity - covered };
  }

  function purchaseAlternative(offer, visits, horizon, plannedLimit) {
    if (offer.stackingBlocked || offer.limit != null || Number.isInteger(plannedLimit) ||
        !['visits', 'single'].includes(offer.type)) return null;
    const base = packagePreview(offer, visits, horizon);
    if (!base?.missing) return null;
    const quantity = Math.ceil(visits / base.quota);
    return quantity <= 1000 ? packagePreview(offer, visits, horizon, quantity) : null;
  }

  function countValue(token) {
    if (/^\d+$/.test(token)) return Number(token);
    const digits = '零一二三四五六七八九';
    const single = value => digits.indexOf(value.replace('两', '二').replace('〇', '零'));
    if (token.length === 1 && token !== '十') return single(token);
    const tens = /^([二两三四五六七八九]?)十([一二三四五六七八九]?)$/.exec(token);
    return tens ? (tens[1] ? single(tens[1]) : 1) * 10 + (tens[2] ? single(tens[2]) : 0) : NaN;
  }

  function parsePurchaseLimits(question, offers) {
    const name = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, '')
      .replace(new RegExp(countPattern + '(?=次卡)', 'g'), (match, count) => {
        const value = countValue(count);
        return value > 0 ? String(value) : match;
      });
    const statement = new RegExp('(?:可以买|可以购买|可购买|可买|能买|能购买|允许购买|最多购买|最多买|限购|只能买|只能购买)' +
      countPattern + '(?:张|份|次)(?!卡)');
    const limits = {};
    let ambiguous = false;
    for (const [, part, punctuation] of name(question).matchAll(/([^，,。；;！!？?]+)([，,。；;！!？?]|$)/g)) {
      if (/[？?]/.test(punctuation) || /是否|是不是|能不能|可不可以|不确定|[吗么]$/.test(part)) continue;
      const match = statement.exec(part);
      const blocked = /(?:不可|不能|不允许|不支持)叠加使用/.test(part);
      if (!blocked && (!match || /[不未]$/.test(part.slice(0, match.index)))) continue;
      const limit = blocked ? 1 : countValue(match[1]);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) continue;
      const named = offers.map(offer => {
        const aliases = [offer.name, offer.shortName, offer.type === 'visits' && offer.units ? offer.units + '次卡' : ''];
        const score = Math.max(0, ...aliases.map(name).filter(alias => {
          if (!alias) return false;
          if (!/^\d/.test(alias)) return part.includes(alias);
          const offset = part.indexOf(alias);
          return offset >= 0 && (offset === 0 || !/\d/.test(part[offset - 1]));
        }).map(alias => alias.length));
        return { offer, score };
      });
      const best = Math.max(0, ...named.map(item => item.score));
      const matches = best ? named.filter(item => item.score === best) :
        offers.length === 1 && /这张|这款|这份|这卡|这个套餐/.test(part) ? named : [];
      if (matches.length !== 1) {
        ambiguous = true;
        continue;
      }
      const offer = matches[0].offer;
      if (!['visits', 'hours', 'single'].includes(offer.type)) continue;
      limits[offer.images[0].id] = limit;
    }
    return { limits, ambiguous };
  }

  function parseVisitPlan(question, previous = {}) {
    const text = String(question).normalize('NFKC').replace(/\s+/g, '');
    const number = countPattern;
    const weekly = [...text.matchAll(new RegExp(
      '(?:每(?:个)?|一|1)(?:周|星期)[^0-9零〇一二两三四五六七八九十，。！？、周星期]{0,10}' + number + '(?:次|天)(?!卡)', 'g'))];
    const weeks = [...text.matchAll(new RegExp(
      '(?<![0-9零〇一二两三四五六七八九十.至到~–—-])' + number + '(?:个)?(?:周|星期)', 'g'))]
      .filter(match => !weekly.some(item => match.index >= item.index && match.index < item.index + item[0].length));
    const totals = [...text.matchAll(new RegExp(
      '(?:总共|一共|共计|合计|(?:计划|预计|打算)(?:总共)?(?:到访|去|使用|用|消费)|(?:准备|想|要)去|到访|总计)' + number + '(?:次|天)(?!卡)', 'g'))];
    const shortTotal = new RegExp('^(?:去)?' + number + '(?:次|天)[。！!]?$').exec(text);
    if (shortTotal) totals.push(shortTotal);
    const unique = matches => {
      const values = [...new Set(matches.map(item => countValue(item[1])))];
      return values.length === 1 && values[0] > 0 ? values[0] : null;
    };
    if (!weekly.length && !weeks.length && !totals.length) return null;

    const frequency = weekly.length ? unique(weekly) : previous.frequency ?? null;
    const duration = weeks.length ? unique(weeks) : previous.weeks ?? null;
    const total = unique(totals);
    const invalid = (weekly.length && (!frequency || frequency > 7)) ||
      (weeks.length && !duration) || (totals.length && !total);
    const calculated = frequency && duration ? frequency * duration : null;
    const conflicting = Boolean(invalid || (total && calculated && total !== calculated && (weekly.length || weeks.length)));
    if (conflicting) return { frequency: null, weeks: null, visits: null, days: null, conflicting: true };
    // An explicitly stated total can stand on its own. Older weekly inputs cannot override it.
    if (total && !weekly.length && !weeks.length) {
      return { frequency: null, weeks: null, visits: total, days: null, conflicting: false };
    }
    return {
      frequency, weeks: duration, visits: total ?? calculated,
      days: duration ? duration * 7 : null, conflicting: false,
    };
  }

  function isoParts(parts) {
    return [parts[0], ...parts.slice(1).map(part => part.padStart(2, '0'))].join('-');
  }

  function day(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return null;
    const time = Date.parse(value + 'T00:00:00Z');
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time / dayMs : null;
  }

  function cents(value) {
    if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(String(value ?? ''))) return null;
    const [whole, fraction = ''] = String(value).split('.');
    return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  }

  function integer(value, min, max) {
    if (!/^\d+$/.test(String(value ?? ''))) return null;
    const number = Number(value);
    return number >= min && number <= max ? number : null;
  }

  function time(value) {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value ?? '');
    return value === '24:00' ? 1440 : match ? Number(match[1]) * 60 + Number(match[2]) : null;
  }

  function makeOffer(raw, index = 0) {
    const name = raw.name?.trim() || '方案 ' + (index + 1);
    const fail = message => { throw Error(name + ' · ' + message); };
    const type = raw.type;
    if (!Object.hasOwn(labels, type)) fail('请选择购买方式。');
    const price = cents(raw.price);
    if (price === null) fail('请填写正确的套餐报价，最多两位小数。');
    const units = type === 'single' ? 1 : type === 'period' ? null : integer(raw.units, 1, type === 'hours' ? 100000 : 1000);
    if (units === null && type !== 'period') fail(type === 'hours' ? '请填写总可用分钟数。' : '请填写权益次数。');
    const limit = integer(raw.limit, 0, 1000);
    if (raw.limit && limit === null) fail('限购应为 0–1000 的整数。');
    const from = day(raw.from), until = day(raw.until), days = integer(raw.days, 1, 3660);
    const purchaseDays = integer(raw.purchaseDays, 1, 3660);
    if (raw.purchaseDays && purchaseDays === null) fail('购买后有效天数应为 1–3660 的整数。');
    if (raw.validity === 'fixed' && (until === null || (raw.from && from === null) || (from !== null && from > until))) fail('请核对有效期起止日期。');
    if (raw.validity === 'relative' && days === null) fail('请填写激活后的有效天数。');
    const opens = time(raw.opens), closes = time(raw.closes);
    if (raw.window === 'restricted' && (opens === null || closes === null || closes <= opens)) fail('请填写同一天内正确的起止时段。');
    const windows = raw.window === 'split'
      ? [[time(raw.workdayOpens), time(raw.workdayCloses)], [time(raw.weekendOpens), time(raw.weekendCloses)]]
      : null;
    if (windows?.some(([open, close]) => open === null || close === null || close <= open)) fail('请核对工作日与周末的起止时段。');
    const trialQuantity = integer(raw.trialQuantity, 1, 1000);
    if (raw.trialQuantity && (trialQuantity === null || (limit > 0 && trialQuantity > limit) || (raw.stackingBlocked && trialQuantity > 1))) {
      fail('试算张数超出已知购买限制。');
    }
    const visitMax = integer(raw.visitMax, 0, 1440);
    const billing = integer(raw.billing, 1, 1440), minimum = integer(raw.minimum, 0, 1440);
    if ((raw.visitMax && visitMax === null) || (raw.billing && billing === null) || (raw.minimum && minimum === null)) fail('时长规则须填写有效的整数分钟。');
    return { name, type, price, units, limit, validity: raw.validity, from, until, days, purchaseDays,
      window: raw.window, opens, closes, windows, weekdays: raw.weekdays || 'all', trialQuantity,
      purchaseDaysConflict:raw.purchaseDaysConflict === true,
      visitMax, billing, minimum, redemption: raw.redemption, restrictionsPending:raw.restrictionsPending === true,
      purchaseAssumed:raw.purchaseAssumed === true, stackingBlocked:raw.stackingBlocked === true };
  }

  function arrivalCandidate(raw) {
    const candidate = {};
    for (const key of ['time','workdays','weekends']) {
      if (typeof raw?.[key] === 'string' && time(raw[key]) !== null && raw[key] !== '24:00') candidate[key] = raw[key];
    }
    if (candidate.workdays || candidate.weekends) delete candidate.time;
    return Object.keys(candidate).length ? candidate : null;
  }

  const arrivalClock = /(?:(凌晨|早上|上午|中午|下午|傍晚|晚上|夜里)\s*)?([0-9零〇一二两三四五六七八九十]{1,3})(?::(\d{2})|点(半|\d{1,2}分?)?)/g;

  function arrivalClauses(question) {
    return String(question ?? '').normalize('NFKC').split(/[，,、；;。！？!?和\n]|(?=周末|工作日|平日)/);
  }

  function arrivalScope(clause) {
    return /都|每天|每日/.test(clause) ? 'time' :
      /工作日|平日|周中|周[一二三四五]/.test(clause) ? 'workdays' :
      /周末|周[六日天]|星期[六日天]/.test(clause) ? 'weekends' : 'time';
  }

  function parseArrivalQuestion(question, previous = {}) {
    const candidate = {};
    for (const clause of arrivalClauses(question)) {
      const clocks = [...clause.matchAll(arrivalClock)];
      if (clocks.length > 1) return null;
      const clock = clocks[0];
      if (!clock) continue;
      let hour = countValue(clock[2]);
      if (/下午|傍晚|晚上|夜里/.test(clock[1] ?? '') && hour > 0 && hour < 12) hour += 12;
      if (clock[1] === '凌晨' && hour === 12) hour = 0;
      const minute = clock[3] ?? (clock[4] === '半' ? '30' : String(parseInt(clock[4],10) || 0));
      const value = String(hour).padStart(2,'0') + ':' + minute.padStart(2,'0');
      if (time(value) === null || value === '24:00') continue;
      const key = arrivalScope(clause);
      if (candidate[key] && candidate[key] !== value) return null;
      candidate[key] = value;
    }
    return arrivalCandidate(candidate.workdays || candidate.weekends ? { ...previous, ...candidate } : candidate);
  }

  function arrivalExamples(question, previous = {}) {
    const parts = { time:new Map(), workdays:new Map(), weekends:new Map() };
    for (const clause of arrivalClauses(question)) {
      const text = clause.replace(arrivalClock, '');
      for (const match of text.matchAll(/清晨|早上|上午|早晨|中午|午间|下午|午后|傍晚|晚上|晚间|夜间|下班后|下学后|放学后/g)) {
        const before = text.slice(0,match.index);
        const after = text.slice(match.index + match[0].length);
        if (/(?:不(?:是|考虑|选|会在|想在)?|排除)$/.test(before) || /^(?:不行|没空|不方便)/.test(after)) continue;
        const [label, clock] = /清晨|早上|上午|早晨/.test(match[0]) ? ['早上','09:00'] :
          /中午|午间/.test(match[0]) ? ['中午','12:00'] :
          /下午|午后/.test(match[0]) ? ['下午','14:00'] : ['晚上','19:00'];
        parts[arrivalScope(clause)].set(label,clock);
      }
    }
    if (parts.time.size) return [...parts.time].slice(0,4).map(([label,time]) => ({ label, plan:{ time } }));
    if (!parts.workdays.size && !parts.weekends.size) return [];
    const exact = parseArrivalQuestion(question,previous) || previous;
    const options = key => parts[key].size ? [...parts[key]] : [['',exact[key] || exact.time]];
    const examples = [];
    for (const [workLabel,workdays] of options('workdays')) for (const [weekendLabel,weekends] of options('weekends')) {
      const label = [workLabel && '工作日' + workLabel, weekendLabel && '周末' + weekendLabel].filter(Boolean).join('、');
      examples.push({ label, plan:arrivalCandidate({ workdays,weekends }) });
    }
    return examples.slice(0,4);
  }

  function validVisitOffsets(offsets, limit, maxCount = limit) {
    if (!Array.isArray(offsets)) return [];
    return [...new Set(offsets.filter(offset => Number.isInteger(offset) && offset >= 0 && offset < limit))]
      .sort((a,b) => a-b).slice(0,maxCount);
  }

  function makeProfile(raw, mode) {
    const start = day(raw.start);
    if (raw.start && start === null) throw Error('请核对预计开始日期。');
    const startMinute = time(raw.time);
    if (mode === 'coffee') {
      const baseCount = integer(raw.count, 1, 60), gap = integer(raw.gap, 1, 365);
      if (baseCount === null) throw Error('请输入 1–60 次。');
      const visitOffsets = validVisitOffsets(raw.visitOffsets, 365 * 60, 60);
      const count = visitOffsets.length || baseCount;
      return { mode, start, startMinute, gap, count, visitOffsets, sameProduct: raw.sameProduct === true, mix: raw.mix === true };
    }
    const weeks = integer(raw.weeks, 1, 12);
    const selected = Array.from(new Set(raw.weekdays ?? [])).filter(value => Number.isInteger(value) && value >= 0 && value <= 6);
    const frequency = integer(raw.frequency, 1, 7);
    const minutes = integer(raw.minutes, 1, 1440);
    if (weeks === null || minutes === null || (selected.length === 0 && frequency === null)) throw Error('请填写每周到访天数、每次停留分钟和计划周数。');
    const arrivals = arrivalCandidate(raw.arrivals);
    const visitOffsets = validVisitOffsets(raw.visitOffsets, weeks * 7);
    return { mode, start, startMinute, weeks, selected, frequency, minutes, visitOffsets,
      arrivalByDay:arrivals && [time(arrivals.workdays), time(arrivals.weekends)], sameProduct: raw.sameProduct === true };
  }

  function calendarDay(profile, offset) {
    const date = profile.start === null ? null : profile.start + offset;
    const weekday = date === null ? (1 + offset) % 7 : new Date(date * dayMs).getUTCDay();
    return { offset, weekday, date };
  }

  function calendarOffsets(profile) {
    if (profile.visitOffsets?.length) return profile.visitOffsets;
    if (profile.mode === 'coffee') return Array.from({length:profile.count}, (_, index) => index * (profile.gap ?? 1));
    return Array.from({length:profile.weeks * 7}, (_, offset) => offset).filter(offset =>
      profile.selected.length ? profile.selected.includes(calendarDay(profile,offset).weekday) : offset % 7 < profile.frequency);
  }

  function calendarDays(profile, first = 0, length = (profile.weeks ?? 4) * 7) {
    const planned = new Set(calendarOffsets(profile));
    return Array.from({length}, (_, index) => {
      const slot = calendarDay(profile, first + index);
      return { ...slot, planned:planned.has(slot.offset) };
    });
  }

  function uses(profile, count = profile.count) {
    const custom = profile.visitOffsets;
    if (profile.mode === 'coffee') return Array.from({ length: custom?.length || count }, (_, index) => {
      if (custom?.length) {
        const { date, weekday } = calendarDay(profile,custom[index]);
        return { date, weekday, start:profile.startMinute, minutes:0, index };
      }
      const date = profile.start !== null && (index === 0 || profile.gap !== null) ? profile.start + index * (profile.gap ?? 0) : null;
      return { date, start:profile.startMinute, minutes:0, index };
    });
    const result = [];
    const selected = profile.selected.length ? profile.selected : profile.frequency === 7 ? [0,1,2,3,4,5,6] : [];
    const add = (date, weekday = null) => {
      const start = weekday === null ? profile.startMinute : (profile.arrivalByDay?.[dayKind(weekday)] ?? profile.startMinute);
      result.push({ date, weekday, start, minutes: profile.minutes, index: result.length });
    };
    if (profile.visitOffsets?.length) {
      for (const offset of profile.visitOffsets) {
        const { date, weekday } = calendarDay(profile,offset);
        add(date,weekday);
      }
      return result;
    }
    for (let offset = 0; offset < profile.weeks * 7; offset++) {
      const date = profile.start === null ? null : profile.start + offset;
      if (!selected.length) {
        if (offset % 7 < profile.frequency) add(null);
        continue;
      }
      const weekday = date === null ? offset % 7 : new Date(date * dayMs).getUTCDay();
      if (selected.includes(weekday)) add(date, weekday);
    }
    return result;
  }

  function dayKind(weekday) {
    return Number(weekday === 0 || weekday === 6);
  }

  function fitsTime([open, close], start, minutes) {
    return start === null ? minutes <= close - open : start >= open && start < close && start + minutes <= close;
  }

  function eligible(offer, use, profile) {
    if (use.date !== null) {
      if (offer.validity === 'fixed' && ((offer.from !== null && use.date < offer.from) || use.date > offer.until)) return false;
      if (offer.validity === 'relative' && profile.start !== null && use.date >= profile.start + offer.days) return false;
    }
    const weekday = use.weekday ?? (use.date === null ? null : new Date(use.date * dayMs).getUTCDay());
    const kind = weekday === null ? null : dayKind(weekday);
    if (offer.window === 'restricted') {
      if (kind !== null && offer.weekdays !== 'all' && (offer.weekdays === 'weekends') !== Boolean(kind)) return false;
      const span = [offer.opens, offer.closes];
      if (kind === null && profile.arrivalByDay) {
        if (!profile.arrivalByDay.some((start, index) =>
          (offer.weekdays === 'all' || (offer.weekdays === 'weekends') === Boolean(index)) && fitsTime(span, start, use.minutes))) return false;
      } else if (!fitsTime(span, use.start, use.minutes)) return false;
    }
    if (offer.windows) {
      const possible = kind === null
        ? offer.windows.every((span, index) => fitsTime(span, profile.arrivalByDay?.[index] ?? use.start, use.minutes))
        : fitsTime(offer.windows[kind], use.start, use.minutes);
      if (!possible) return false;
    }
    return !offer.visitMax || use.minutes <= offer.visitMax;
  }

  function uncertainties(offer, profile, list, purchases) {
    const notes = [];
    if (offer.restrictionsPending) notes.push('截图还有未核实的使用限制');
    if (offer.limit === null && purchases > 1) notes.push('购买数量上限待确认');
    if (offer.purchaseAssumed && purchases > 1 && !offer.trialQuantity) notes.push('购买数量按对话提供的条件试算，使用限制仍需核对');
    if (offer.trialQuantity > 1 && (offer.limit === null || offer.purchaseAssumed)) notes.push('多张购买按假设试算，能否叠加仍需确认');
    if (offer.purchaseDaysConflict) notes.push('购买后有效天数有多个候选，需核对原文');
    if (offer.purchaseDays) notes.push('购买后 ' + offer.purchaseDays + ' 天的有效期限需按实际购买日核对');
    if (!offer.validity) notes.push(offer.purchaseDays ? '核销后有效期待确认' : '有效期待确认，试算暂按可覆盖计划');
    if (offer.validity === 'fixed' && list.some(use => use.date === null) &&
        !(profile.mode === 'study' && profile.start !== null && (offer.from === null || profile.start >= offer.from) && profile.start + profile.weeks * 7 - 1 <= offer.until)) notes.push('需要消费日期才能检查到期');
    if (offer.validity === 'relative' && (profile.start === null || list.some(use => use.date === null)) &&
        !(profile.mode === 'study' && offer.days >= profile.weeks * 7)) notes.push('需要开始日期与到访安排才能检查有效期');
    if (!offer.window && profile.mode === 'study') notes.push('可用时段待确认，试算暂按可用');
    if (offer.windows || offer.window === 'restricted') {
      if (list.some(use => use.start === null)) notes.push('需要到访时间才能检查时段');
      if ((offer.windows || offer.weekdays !== 'all' || profile.arrivalByDay) && list.some(use => use.date === null && use.weekday == null)) {
        notes.push('需要选择到访星期才能核对时段');
      }
    }
    if (profile.mode === 'study' && (offer.type === 'visits' || offer.type === 'period') && offer.visitMax === null) notes.push('单次可用时长上限待确认');
    if (offer.type === 'visits' && profile.mode === 'study' && !offer.redemption) notes.push('按次或按天核销待确认');
    if (offer.type === 'hours' && (offer.billing === null || offer.minimum === null)) notes.push('计费取整或最低扣减待确认');
    return notes;
  }

  function hourlyDebit(offer, use) {
    const step = offer.billing ?? 1;
    return Math.ceil(Math.max(use.minutes, offer.minimum ?? 0) / step) * step;
  }

  function simulate(offer, list, profile, count) {
    let left = offer.units === null ? Infinity : offer.units * count;
    let currentHours = offer.units, hourPacksLeft = count - 1;
    const paidDays = new Set(), covered = [];
    for (const use of list) {
      if (!eligible(offer, use, profile)) continue;
      const dayKey = use.date ?? ('visit-' + use.index);
      const alreadyPaid = profile.mode === 'study' && offer.redemption === 'day' && paidDays.has(dayKey);
      const debit = offer.type === 'hours' ? hourlyDebit(offer, use) : alreadyPaid ? 0 : 1;
      if (offer.type === 'hours') {
        if (debit > offer.units) continue;
        if (debit > currentHours) {
          if (!hourPacksLeft) continue;
          hourPacksLeft--;
          currentHours = offer.units;
        }
        currentHours -= debit;
      }
      if (debit > left) continue;
      left -= debit;
      paidDays.add(dayKey);
      covered.push(use);
    }
    return { covered, left: Number.isFinite(left) ? left : null };
  }

  function compare(offers, profile, count = profile.count) {
    const list = uses(profile, count);
    const rows = offers.map(offer => {
      const capacity = offer.type === 'hours'
        ? Math.floor(offer.units / hourlyDebit(offer, list[0]))
        : offer.units ?? Infinity;
      const needed = capacity ? Math.max(1, Math.ceil(list.length / capacity)) : 1;
      const maximum = offer.stackingBlocked ? 1 : purchaseCount(needed, offer.limit, offer.type === 'single' ? needed : 1);
      let best;
      const first = offer.trialQuantity || 1;
      for (let quantity = first; quantity <= (offer.trialQuantity || maximum); quantity++) {
        const result = simulate(offer, list, profile, quantity);
        if (!best || result.covered.length > best.covered.length) best = { ...result, quantity };
        if (best.covered.length === list.length) break;
      }
      const notes = uncertainties(offer, profile, list, best.quantity);
      if (offer.stackingBlocked && needed > 1) notes.push('截图写明同款不可叠加使用');
      else if (!offer.trialQuantity && offer.limit === null && offer.type !== 'single' && needed > 1) notes.push('按一份试算，能否重复购买待确认');
      const row = summarize(offer.name, best.quantity * offer.price, best.covered, list, notes, best.quantity + ' × ' + offer.name, best.left, offer.type);
      return { ...row, quantity:best.quantity };
    });
    if (profile.mode === 'coffee' && profile.sameProduct && profile.mix && offers.length === 2 && !offers.some(offer => offer.trialQuantity)) {
      const single = offers.find(offer => offer.type === 'single'), pack = offers.find(offer => offer.type === 'visits');
      if (single && pack) {
        const packEligible = list.filter(use => eligible(pack, use, profile));
        const prioritize = packEligible.sort((a, b) => Number(eligible(single, a, profile)) - Number(eligible(single, b, profile)));
        const packUses = prioritize.slice(0, pack.units), chosen = new Set(packUses);
        const singles = list.filter(use => !chosen.has(use) && eligible(single, use, profile));
        const singleUses = singles.slice(0, single.limit || singles.length);
        if (packUses.length && singleUses.length) {
          const notes = [...uncertainties(pack, profile, list, 1), ...uncertainties(single, profile, list, singleUses.length)];
          rows.push(summarize('组合购买', pack.price + singleUses.length * single.price, [...packUses, ...singleUses], list, notes,
            '1 × ' + pack.name + ' ＋ ' + singleUses.length + ' × ' + single.name, pack.units - packUses.length, 'visits'));
        }
      }
    }
    const scope = profile.sameProduct ? [] : ['各方案是否适用于同一消费需求待确认'];
    const complete = rows.filter(row => row.missing === 0).sort((a, b) => a.cost - b.cost);
    const relevant = complete[0] ? rows.filter(row => row.cost <= complete[0].cost) : rows;
    const issues = [...new Set([...scope, ...relevant.flatMap(row => row.notes)])];
    const dated = offers.some(offer => ['fixed', 'relative'].includes(offer.validity));
    const timed = offers.some(offer => offer.window === 'restricted' || offer.windows);
    return { rows, best: complete[0] ?? null, tied: complete.filter(row => row.cost === complete[0]?.cost),
      conditional: issues.length > 0, issues, dated, timed, count: list.length,
      minutes: list.reduce((sum, use) => sum + use.minutes, 0) };
  }

  function summarize(name, cost, covered, list, notes, detail, left, type) {
    const coveredMinutes = covered.reduce((sum, use) => sum + use.minutes, 0);
    return { name, cost, covered: covered.length, missing: list.length - covered.length, coveredMinutes,
      missingMinutes: list.reduce((sum, use) => sum + use.minutes, 0) - coveredMinutes, notes, detail, left, type };
  }

  const api = { labels, fields, draft, matchesPrevious, groupPackages, packageSummary, packagePreview, purchaseAlternative, effectivePurchaseLimit, parsePurchaseLimits, parseVisitPlan, parseArrivalQuestion, arrivalExamples, arrivalCandidate, cents, makeOffer, makeProfile, calendarOffsets, calendarDays, compare };
  if (typeof module !== 'undefined') module.exports = api;
  else root.KDZCompare = api;
})(globalThis);

