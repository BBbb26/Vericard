'use strict';

window.KDZDecisionChart = (() => {
  const $ = id => document.getElementById(id);
  const ns = 'http://www.w3.org/2000/svg';
  let current;
  let format;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svg(tag, attributes, text) {
    const node = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function projectedValues(payload, id, key) {
    const values = (payload.ranges?.[0]?.branches ?? []).map(branch =>
      branch.outcomes.find(outcome => outcome.id === id)?.[key]);
    return values.length && values.every(Number.isSafeInteger) ? values : [];
  }

  function chartAxis(highest) {
    const desired = Math.max(1, highest / 4);
    const unit = 10 ** Math.floor(Math.log10(desired));
    const factor = [1, 2, 2.5, 5, 10].find(value => value * unit >= desired);
    const step = Math.max(1, Math.ceil(unit * factor));
    const count = Math.max(1, Math.ceil(highest / step));
    return { maximum: count * step, ticks: Array.from({ length: count + 1 }, (_, index) => index * step) };
  }

  function concise(amount) {
    return format(amount).replace(/\.00$/, '');
  }

  function interval(values) {
    if (!values.length) return '待确认';
    const low = Math.min(...values), high = Math.max(...values);
    return low === high ? concise(low) : concise(low) + ' 至 ' + concise(high);
  }

  function previewChoices() {
    return current.variants.filter(variant => variant.points.some(point => point.prepaid !== null));
  }

  function valueOptions(index, key) {
    const values = current.variants.map(variant => variant.points[index]?.[key]);
    return values.length && values.every(Number.isSafeInteger) ? values : [];
  }

  function segments(points, key) {
    const groups = [];
    let group = [];
    for (const point of points) {
      if (point[key] === null) {
        if (group.length) groups.push(group);
        group = [];
      } else group.push(point);
    }
    if (group.length) groups.push(group);
    return groups;
  }

  function path(points, key, x, y) {
    return points.map((point, index) => (index ? 'L' : 'M') + x(point.count) + ',' + y(point[key])).join(' ');
  }

  function drawSeries(plot, points, key, className, x, y, dots) {
    for (const group of segments(points, key)) {
      plot.append(svg('path', { class: 'line-series ' + className, d: path(group, key, x, y) }));
      if (dots || group.length === 1) {
        group.forEach(point => plot.append(svg('circle', {
          class: 'line-dot ' + className, cx: x(point.count), cy: y(point[key]), r: 3,
        })));
      }
    }
  }

  function breakEven(points) {
    for (const point of points.slice(1)) {
      if (point.difference === null) return null;
      if (point.difference >= 0) return point;
    }
    return null;
  }

  function addLegend(text, kind) {
    const entry = element('span', 'chart-key');
    const swatch = element('span', 'chart-swatch ' + kind);
    swatch.setAttribute('aria-hidden', 'true');
    entry.append(swatch, document.createTextNode(text));
    $('chartLegend').append(entry);
  }

  function updatePoint(point, variant, milestone) {
    const prepaid = point.prepaid === null ? valueOptions(point.count, 'prepaid') : [point.prepaid];
    const differences = point.difference === null ? valueOptions(point.count, 'difference') : [point.difference];
    const display = (key, values) => interval(variant && point[key] === null ? [] : values);
    $('linePointCount').textContent = '第 ' + point.count + ' 次';
    $('linePrepaid').textContent = display('prepaid', prepaid);
    $('linePayg').textContent = point.payAsYouGo === null ? '待确认' : concise(point.payAsYouGo);
    $('lineDifference').textContent = point.difference === 0 ? '持平' : display('difference', differences);
    $('linePointContext').textContent = variant ? '条件预览 · ' + variant.label :
      point.prepaid === null && prepaid.length ? '备选条件区间' : '当前口径';
    $('lineCursor').setAttribute('aria-valuetext', point.count + ' 次，预付 ' + $('linePrepaid').textContent +
      '，按次 ' + $('linePayg').textContent);
    $('lineBreakEven').textContent = milestone ?
      (variant ? '预览条件下' : '当前口径') + ' · 第 ' + milestone.count + ' 次' +
        (milestone.difference === 0 ? '持平' : '首次更省') :
      '已知结果尚未确认持平点';
  }

  function plot() {
    if (!current) return;
    const index = $('chartCondition').value;
    const variant = index === '' ? null : previewChoices()[Number(index)];
    const points = variant?.points ?? current.points;
    const maxCount = points.at(-1).count;
    const cursor = Number($('lineCursor').value);
    const width = Math.max(220, Math.round($('costChart').clientWidth));
    const height = width < 420 ? 194 : 228;
    const bands = variant ? [] : points.map(point => {
      const options = valueOptions(point.count, 'prepaid');
      return { count: point.count, min: options.length ? Math.min(...options) : null,
        max: options.length ? Math.max(...options) : null };
    });
    const hasBand = bands.some(point => point.min !== point.max);
    const conditional = bands.some((point, i) => point.min !== null && points[i].prepaid === null);
    const amounts = [...points.flatMap(point => [point.prepaid, point.payAsYouGo]), ...bands.map(point => point.max)]
      .filter(Number.isSafeInteger);
    const { maximum, ticks } = chartAxis(Math.max(1, ...amounts));
    const left = Math.max(38, concise(maximum).length * 6.4 + 9);
    const right = width - 14;
    const top = 15;
    const bottom = height - 26;
    const x = count => left + count / Math.max(maxCount, 1) * (right - left);
    const y = amount => bottom - amount / maximum * (bottom - top);
    const graphic = svg('svg', { class: 'cost-line-svg', viewBox: '0 0 ' + width + ' ' + height, 'aria-hidden': 'true' });

    for (const tick of ticks) {
      graphic.append(svg('line', { class: tick === 0 ? 'line-axis' : 'line-grid', x1: left, x2: right, y1: y(tick), y2: y(tick) }));
      graphic.append(svg('text', { class: 'line-label', x: left - 8, y: y(tick) + 4, 'text-anchor': 'end' }, concise(tick)));
    }
    const step = Math.max(1, Math.ceil(maxCount / (width < 420 ? 7 : 11)));
    const counts = points.map(point => point.count).filter(count => count % step === 0);
    if (!counts.includes(maxCount)) {
      if (maxCount - counts.at(-1) < step / 2) counts.pop();
      counts.push(maxCount);
    }
    counts.forEach(count => graphic.append(svg('text',
      { class: 'line-label', x: x(count), y: bottom + 19, 'text-anchor': 'middle' }, count)));

    if (hasBand) {
      for (const group of segments(bands, 'min')) {
        if (!group.some(point => point.min !== point.max)) continue;
        const upper = path(group, 'max', x, y);
        const lower = path([...group].reverse(), 'min', x, y).replace(/^M/, 'L');
        graphic.append(svg('path', { class: 'line-band', d: upper + ' ' + lower + ' Z' }));
      }
    }
    if (conditional) {
      drawSeries(graphic, bands, 'min', 'conditional', x, y, false);
      if (hasBand) drawSeries(graphic, bands, 'max', 'conditional', x, y, false);
    }
    drawSeries(graphic, points, 'payAsYouGo', 'payg', x, y, maxCount <= 12);
    drawSeries(graphic, points, 'prepaid', variant ? 'preview' : 'prepaid', x, y, maxCount <= 12);

    const milestone = breakEven(points);
    if (milestone) {
      const pointX = x(milestone.count);
      graphic.append(svg('line', { class: 'line-milestone', x1: pointX, x2: pointX, y1: top, y2: bottom }),
        svg('circle', { class: 'line-milestone-dot', cx: pointX, cy: y(milestone.prepaid), r: 4.5 }));
    }
    if (milestone) {
      const labelX = Math.max(left + 39, Math.min(right - 39, x(milestone.count)));
      graphic.append(svg('text', {
        class: 'line-milestone-label', x: labelX, y: top + 13, 'text-anchor': 'middle',
      }, (milestone.difference === 0 ? '持平' : '首次更省') + ' · ' + milestone.count + ' 次'));
    }
    const selected = points[cursor];
    graphic.append(svg('line', { class: 'line-cursor', x1: x(cursor), x2: x(cursor), y1: top, y2: bottom }));
    for (const key of ['prepaid', 'payAsYouGo']) {
      if (selected[key] !== null) graphic.append(svg('circle', {
        class: 'line-selected ' + (key === 'prepaid' ? 'prepaid' : 'payg'),
        cx: x(cursor), cy: y(selected[key]), r: 5,
      }));
    }
    graphic.addEventListener('click', event => {
      if (!maxCount) return;
      const bounds = graphic.getBoundingClientRect();
      const position = (event.clientX - bounds.left) / bounds.width * width;
      $('lineCursor').value = Math.max(0, Math.min(maxCount, Math.round((position - left) / (right - left) * maxCount)));
      plot();
    });
    $('costChart').replaceChildren(graphic);
    $('chartLegend').replaceChildren();
    addLegend(variant ? '预付总支出 · 条件预览' : '预付总支出', variant ? 'conditional' : 'prepaid');
    addLegend('按次总支出', 'payg');
    if (hasBand || conditional) addLegend(hasBand ? '备选条件范围' : '备选条件试算', 'range');
    $('chartLegend').append(element('span', 'chart-unit', '总支出（元）'));
    updatePoint(selected, variant, milestone);
    const context = variant ? '当前只预览「' + variant.label + '」，没有提交该条件。' :
      conditional ? '浅紫区间来自已算出的备选条件。未知点留空。' : '';
    $('chartCaption').textContent = '横轴为使用次数，按正常情景的日期间隔累计试算。超过正常次数的部分沿用该间隔。' +
      context + (current.joint ? '联合试算前提见优先核对。' : '');
  }

  function render(payload, formatter) {
    const previous = $('chartCondition').selectedOptions[0]?.textContent;
    current = payload.costCurve ? { ...payload.costCurve, joint: Boolean(payload.ranges?.[0]?.context) } : null;
    format = formatter;
    $('lineControls').hidden = !current;
    if (!current) {
      $('costChart').replaceChildren(element('p', 'chart-empty', '累计试算暂不可用，请刷新看板。'));
      $('chartLegend').replaceChildren();
      $('chartConditionLabel').hidden = true;
      $('chartCaption').textContent = '';
      return;
    }
    const variants = previewChoices();
    $('chartCondition').replaceChildren(new Option('已知结果与条件范围', ''),
      ...variants.map((variant, index) => new Option(variant.label, String(index))));
    const matching = [...$('chartCondition').options].find(option => option.textContent === previous);
    if (matching) $('chartCondition').value = matching.value;
    $('chartConditionLabel').hidden = !variants.length;
    $('chartCondition').disabled = false;
    $('lineCursor').max = current.points.at(-1).count;
    $('lineCursor').value = current.normalCount;
    $('lineCursor').disabled = current.points.length < 2;
    plot();
  }

  $('chartCondition').addEventListener('change', plot);
  $('lineCursor').addEventListener('input', plot);
  let width = 0;
  new ResizeObserver(([entry]) => {
    const next = Math.round(entry.contentRect.width);
    if (next > 0 && next !== width) {
      width = next;
      plot();
    }
  }).observe($('costChart'));
  return {
    render, projectedValues,
    knownMilestone(payload) {
      const curve = payload.costCurve;
      return curve ? breakEven(curve.points.slice(0, curve.normalCount + 1)) : null;
    },
  };
})();
