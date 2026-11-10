'use strict';

window.KDZWalletCharts = (() => {
  const W = window.KDZWallet;
  const shapes = { opening:'开卡', consume:'消费入账', consume_confirmation:'补录实扣', recharge:'追加权益',
    refund:'退款', adjustment:'余额校正', reversal:'撤销记录', reconciliation:'商家余额对账',profile_update:'补充卡片信息' };

  function node(tag, value, className) {
    const item = document.createElement(tag);
    if (value !== undefined) item.textContent = value;
    if (className) item.className = className;
    return item;
  }

  function svg(tag, attrs) {
    const item = document.createElementNS('http://www.w3.org/2000/svg',tag);
    for (const [key,value] of Object.entries(attrs)) item.setAttribute(key,value);
    return item;
  }

  function text(x,y,value,anchor = 'middle') {
    const item = svg('text',{x,y,'text-anchor':anchor});
    item.textContent = value;
    return item;
  }

  function legend(items) {
    const row = node('div',undefined,'wallet-chart-legend');
    for (const [style,title] of items) {
      const item = node('span');
      const swatch = node('i',undefined,style);
      swatch.setAttribute('aria-hidden','true');
      item.append(swatch,document.createTextNode(title));
      row.append(item);
    }
    return row;
  }

  function moneyScale(max) {
    const interval = Math.max(20,max / 5);
    const magnitude = 10 ** Math.floor(Math.log10(interval));
    const step = ([1,2,2.5,5,10].find(n => n * magnitude >= interval) ?? 10) * magnitude;
    return [0,step,step*2,step*3,step*4,step*5];
  }

  function trend(card) {
    const wrap = node('div',undefined,'wallet-trend');
    const points = card.balanceHistory ?? [];
    const current = card.remaining;
    if (points.length < 2) {
      wrap.append(node('p','暂无余额变化流水。记录消费或对账后，可在这里查看变化。','muted'));
      return wrap;
    }
    const width = 420, height = 165, left = 63, right = 22, top = 16, bottom = 140;
    const ticks = moneyScale(Math.max(...points.flatMap(p => [p.amountCents,p.merchantCents ?? 0])));
    const x = index => left + index / (points.length - 1) * (width - left - right);
    const y = amount => bottom - amount / ticks.at(-1) * (bottom - top);
    const chart = svg('svg',{viewBox:'0 0 '+width+' '+height,class:'wallet-usage-svg wallet-trend-svg',
      role:'img','aria-label':'按入账顺序的账面余额，当前 '+W.money(current.totalCents)});
    for (const amount of ticks) {
      const at = y(amount);
      chart.append(svg('line',{x1:left,x2:width-right,y1:at,y2:at,class:'wallet-chart-grid'}));
      chart.append(text(left-7,at+4,'¥'+(amount/100).toLocaleString('zh-CN',
        {notation:amount >= 1000000 ? 'compact' : 'standard',maximumFractionDigits:2}),'end'));
    }
    const coords = points.map((point,index)=>x(index)+','+y(point.amountCents));
    chart.append(svg('polygon',{points:[x(0)+','+bottom,...coords,x(points.length-1)+','+bottom].join(' '),class:'wallet-trend-fill'}));
    chart.append(text(left,bottom+20,points[0].label.slice(5)),text(width-right,bottom+20,points.at(-1).label.slice(5)));
    const cursor = svg('line',{y1:top,y2:bottom,class:'wallet-chart-cursor'});
    chart.append(cursor);
    const dots = [];
    points.forEach((point,i) => {
      if (i) {
        const previous = points[i-1];
        chart.append(svg('line',{x1:x(i-1),x2:x(i),y1:y(previous.amountCents),y2:y(point.amountCents),
          class:'wallet-trend-line'+(point.estimated || previous.estimated ? ' estimated' : '')}));
      }
      if (point.merchantCents != null) chart.append(svg('rect',{x:x(i)-5,y:y(point.merchantCents)-5,width:10,height:10,
        class:'wallet-merchant-point',transform:'rotate(45 '+x(i)+' '+y(point.merchantCents)+')'}));
    });
    points.forEach((point,i) => dots.push(svg('circle',{cx:x(i),cy:y(point.amountCents),r:3,class:'wallet-trend-dot'})));
    chart.append(...dots);
    const scrub = node('input');
    Object.assign(scrub,{type:'range',min:'0',max:String(points.length-1),step:'1'});
    scrub.setAttribute('aria-label','查看余额入账节点');
    const controls = node('label',undefined,'wallet-chart-scrub');
    const readout = node('output',undefined,'wallet-trend-readout');
    const detail = node('span',undefined,'wallet-trend-detail');
    controls.append(node('span','查看记录'),scrub);
    function select(index) {
      const point = points[index], at = x(index);
      scrub.value = index;
      cursor.setAttribute('x1',at);
      cursor.setAttribute('x2',at);
      dots.forEach((dot,i)=>dot.setAttribute('r',i===index?'5':'3'));
      const date = point.eventDate && point.eventDate !== point.label ? point.label+' 入账 · 消费日 '+point.eventDate : point.label;
      const label = date+' · '+(point.serviceId ?? shapes[point.kind] ?? '余额记录');
      const summary = [point.estimated ? '账面含估算' : '账面余额',W.money(point.amountCents)];
      if (point.debitCents != null) summary.push('扣减 '+W.money(point.debitCents));
      if (card.initial.bonusCents > 0 || current.bonusRange?.[1] > 0) {
        if (point.principalCents != null && point.bonusCents != null) summary.push('本金 '+W.money(point.principalCents),'赠送金 '+W.money(point.bonusCents));
        else summary.push('本金与赠送金分账待核对');
      }
      if (point.merchantCents != null) summary.push('当时商家显示 '+W.money(point.merchantCents));
      readout.replaceChildren(node('span',label),node('strong',summary.slice(0,2).join(' ')));
      detail.textContent = summary.slice(2).join(' · ');
      detail.hidden = !detail.textContent;
      scrub.setAttribute('aria-valuetext',label+' · '+summary.join(' · '));
    }
    scrub.addEventListener('input',()=>select(Number(scrub.value)));
    chart.addEventListener('click',event=>{
      const matrix=chart.getScreenCTM();
      if (!matrix) return;
      const at=new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse());
      const index=Math.round((at.x-left)/(width-left-right)*(points.length-1));
      select(Math.max(0,Math.min(points.length-1,index)));
    });
    const latestMerchant = points.findLast(point=>point.merchantCents != null);
    wrap.append(node('p','当前账面余额 '+W.money(current.totalCents),'wallet-chart-lead'));
    if (latestMerchant) wrap.append(node('p','最近商家显示 '+W.money(latestMerchant.merchantCents)+' · '+latestMerchant.label,'muted'));
    wrap.append(chart,node('p','按入账顺序','muted wallet-chart-order'),legend([['actual','账面余额'],...(points.some(p=>p.estimated)?[['estimate','含规则估算']]:[]),
      ...(latestMerchant?[['merchant','商家显示记录']]:[])]),readout,detail,controls);
    select(points.length-1);
    return wrap;
  }

  function quantity(card, view) {
    const duration = card.type === 'time_pack';
    const single = card.offerType === 'single';
    const format = duration ? W.duration : value => value.toLocaleString('zh-CN') + (single ? ' 张' : ' 次');
    const initial = duration ? card.initial.minutes : card.initial.visits;
    const credited = duration ? initial : card.creditedVisits;
    const used = duration ? card.consumedMinutes : card.consumedVisits;
    const left = duration ? card.remaining.minutes : card.remaining.visits;
    const wrap = node('div',undefined,'wallet-quota');
    const ring = node('div',undefined,'wallet-quota-ring');
    ring.style.setProperty('--wallet-quota-share',Math.round(left/Math.max(credited,left)*100)+'%');
    const values = node('div',undefined,'wallet-quota-values');
    values.append(node('small','账面剩余','muted'),node('strong',format(left)));
    ring.append(values);
    const facts = node('div',undefined,'wallet-quota-facts');
    facts.append(node('span','开卡 '+format(initial)),node('span','已核销 '+format(used)));
    if (credited !== initial) facts.append(node('span','累计取得 '+format(credited)));
    if (single) facts.append(node('span',card.deadline?.endDate ? '有效至 '+card.deadline.endDate : card.deadline?.knownUnlimited ? '无固定截止' : '有效期待核对'));
    if (duration) facts.append(node('span',card.initial.billingMinutes ? '每 '+format(card.initial.billingMinutes)+' 为一核销单位' : '核销单位待核对'));
    wrap.append(ring,facts);
    if (card.events.some(event=>!event.reversed && event.status === 'estimated')) wrap.append(node('p','账面核销含规则估算。','muted wallet-chart-full'));
    return wrap;
  }

  function membership(card, view) {
    const wrap = node('div',undefined,'wallet-period-chart');
    wrap.append(node('p',view.value,'wallet-chart-lead'));
    if (view.ratio != null) {
      const bar = node('div',undefined,'wallet-period-track');
      const progress = node('span');
      progress.style.width=Math.round(view.ratio*100)+'%';
      bar.append(progress);
      bar.setAttribute('aria-hidden','true');
      const dates = node('div',undefined,'wallet-period-dates');
      dates.append(node('span',card.deadline.startDate || card.activationDate),node('span',card.deadline.endDate));
      wrap.append(bar,dates);
    } else if (card.deadline.endDate) wrap.append(node('p','有效至 '+card.deadline.endDate,'muted'));
    wrap.append(node('p',view.caption,'muted'));
    return wrap;
  }

  function monthly(card) {
    if (card.offerType === 'single' || !['visit_pack','time_pass'].includes(card.type)) return [];
    const counts = new Map();
    for (const event of card.events) {
      if (event.reversed || event.status !== 'confirmed' || !['consume','consume_confirmation'].includes(event.type)) continue;
      const count = card.type === 'visit_pack' ? event.debit.visits : Number(event.debit.covered);
      if (!count) continue;
      const key = event.date.slice(0,7);
      counts.set(key,(counts.get(key) ?? 0)+count);
    }
    return [...counts].sort(([a],[b])=>a.localeCompare(b)).slice(-6);
  }

  function bars(entries) {
    const max = Math.max(...entries.map(([,value])=>value));
    const chart = node('ul',undefined,'wallet-month-bars');
    for (const [month,count] of entries) {
      const item = node('li');
      const track = node('div',undefined,'wallet-month-track');
      const fill = node('i');
      fill.style.height=(count / max * 100)+'%';
      track.append(fill);
      track.setAttribute('aria-hidden','true');
      item.append(node('strong',count+' 次'),track,node('span',month));
      chart.append(item);
    }
    return chart;
  }

  function render(card,area,badge,view) {
    badge.textContent=card.type === 'stored_value' ? '账面余额' : W.cardLabel(card);
    if (card.type === 'stored_value') {
      area.replaceChildren(trend(card));
      return;
    }
    const base = card.type === 'time_pass' ? membership(card,view) : quantity(card,view);
    const periods = monthly(card);
    if (periods.length < 2) {
      area.replaceChildren(base);
      return;
    }
    const content = node('div');
    content.append(base);
    const modes = node('div',undefined,'wallet-chart-modes');
    for (const [index,label] of ['权益进度',card.type === 'time_pass' ? '月度到访' : '月度核销'].entries()) {
      const button = node('button',label,'secondary');
      button.type='button';
      button.setAttribute('aria-pressed',String(index===0));
      button.addEventListener('click',()=>{
        for (const peer of modes.children) peer.setAttribute('aria-pressed',String(peer===button));
        if (index) content.replaceChildren(bars(periods),node('p','近六个有实录的月份 · 仅统计确认记录','muted'));
        else content.replaceChildren(base);
      });
      modes.append(button);
    }
    area.replaceChildren(modes,content);
  }

  return {render};
})();
