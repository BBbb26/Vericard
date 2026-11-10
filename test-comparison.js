'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('./comparison');

function image(lines) {
  return { id:'fixture', ocr:{ width:800, height:800, lines:lines.map((text,index)=>({ text, box:{ x:10,y:30*index,width:500,height:20 } })) } };
}
const base = { validity:'unlimited', limit:'0', window:'all', visitMax:'0' };
const offer = (name,type,price,other={}) => C.makeOffer({ ...base,name,type,price,...other });
const coffee = (count, extra={}) => C.makeProfile({ count, sameProduct:true, mix:true, ...extra },'coffee');
const study = (minutes,extra={}) => C.makeProfile({ minutes, weeks:4, frequency:3, sameProduct:true, ...extra },'study');
const single = offer('单杯券','single','29');
const pack = offer('十次卡','visits','240',{ units:'10' });
const hourly = offer('小时卡','hours','200',{ units:'3000',billing:'1',minimum:'0' });
const visits = offer('30 次卡','visits','300',{ units:'30',redemption:'visit' });
const monthly = offer('月卡','period','260',{ validity:'relative',days:'30',limit:'1' });

test('识别折扣粘连的单次券，保留原图坐标', () => {
  const result=C.draft([image(['饮 品 8 选 1','¥ 29 · 5 7 ． 2 折 〉'])]);
  assert.equal(result.values.type,'single');
  assert.equal(result.values.price,'29.5');
  assert.deepEqual(result.candidates.price[0].box,{x:10,y:30,width:500,height:20});
});
test('用每次报价交叉核对丢失小数点的十次卡', () => {
  const result=C.draft([image(['¥2669/共10次单次26．69元〉','饮品8选1'])]);
  assert.deepEqual([result.values.type,result.values.price,result.values.units],['visits','266.9','10']);
});
test('冲突报价保留候选，不自动选取', () => {
  const result=C.draft([image(['饮品8选1','套餐价 ¥29','券价 ¥39'])]);
  assert.equal(result.values.price,'');
  assert.deepEqual(result.candidates.price.map(item=>item.value),['29','39']);
});
test('按卡型提取自习时长、有效期和时段', () => {
  const result=C.draft([image(['50小时卡','套餐总时长为3000分钟，兑换后45天有效','工作日 18:00–22:00'.replace('–','—'),'套餐价206元'])]);
  assert.deepEqual([result.values.type,result.values.units,result.values.days,result.values.weekdays],['hours','3000','45','workdays']);
});
test('区分购后期限和核销后期限，识别真实 OCR 中的每日可用时段', () => {
  const headline = image(['30 次卡【自习座位】','须 知 免 预 约 · 周 一 至 周 日 06 ： 00 ． 23 ： 59 可 用 · 购 买 后 90 天 ． ．']);
  const detail = { ...image(['有效期','购 买 后 90 天 内 有 效','使用时间','06 ： 00 · 23 ： 59']), id:'detail' };
  const { values, candidates } = C.draft([headline, detail]);
  assert.deepEqual([values.purchaseDays, values.validity, values.days], ['90','','']);
  assert.deepEqual([values.window, values.weekdays, values.opens, values.closes], ['restricted','all','06:00','23:59']);
  assert.equal(candidates.purchaseDays[0].imageId,'detail');
  assert.equal(candidates.opens[0].quote, headline.ocr.lines[1].text);
  const after = C.draft([headline, detail, image(['使用期限：自首次核销之日起30天内有效'])]).values;
  assert.deepEqual([after.purchaseDays, after.validity, after.days], ['90','relative','30']);
  const option = offer('30 次卡','visits','599',{ ...values, name:'30 次卡', price:'599' });
  const result = C.compare([option],coffee(2,{time:'05:59'}));
  assert.equal(result.rows[0].covered,0);
  assert(result.rows[0].notes.some(note => note.includes('实际购买日')));
});
test('月卡区分连续使用、购后冲突和工作日与周末窗口', () => {
  const quote = '周一至周五18:00–23:59，周六周日06:00·23:59';
  const {values,candidates} = C.draft([image(['晚自习月卡','限制详情连续30天使用','使用时长至多18小时/天',
    '购买后15天内有效','购买后90天内有效',quote,'客服营业时间：每天09:00–22:00'])]);
  assert.deepEqual([values.validity,values.days,values.purchaseDays,values.window,values.visitMax], ['relative','30','','split','1080']);
  assert.deepEqual(candidates.purchaseDays.map(item => item.value), ['15','90']);
  assert.equal(candidates.workdayOpens[0].quote, quote);
  const period = C.makeOffer({...values,price:'359',purchaseDaysConflict:true});
  const arrivals = C.parseArrivalQuestion('工作日晚上7点，周末下午2点');
  assert.deepEqual(arrivals,{workdays:'19:00',weekends:'14:00'});
  assert.deepEqual(C.parseArrivalQuestion('周末改成下午3点',arrivals),{workdays:'19:00',weekends:'15:00'});
  assert.deepEqual(C.parseArrivalQuestion('工作日和周末都晚上七点'),{time:'19:00'});
  assert.equal(C.parseArrivalQuestion('有时晚上七点，有时晚上九点'),null);
  const profile = study(540,{frequency:7,arrivals});
  const result = C.compare([period],profile);
  assert.equal(result.rows[0].covered,8);
  assert.equal(result.rows[0].missing,20);
  assert(result.rows[0].notes.some(note => note.includes('多个候选')));
  const unspecified = C.compare([period],study(540,{arrivals}));
  assert.equal(unspecified.rows[0].covered,0);
  assert(unspecified.rows[0].notes.some(note => note.includes('到访星期')));
});
test('模糊到访时段保留多个情景，后续都下午可直接覆盖', () => {
  assert.deepEqual(C.arrivalExamples('有可能早上有可能晚上'),[
    {label:'早上',plan:{time:'09:00'}},{label:'晚上',plan:{time:'19:00'}},
  ]);
  assert.deepEqual(C.arrivalExamples('都下午',{workdays:'19:00',weekends:'09:00'}),[{label:'下午',plan:{time:'14:00'}}]);
  assert.deepEqual(C.arrivalExamples('工作日晚上七点，周末下午'),[
    {label:'周末下午',plan:{workdays:'19:00',weekends:'14:00'}},
  ]);
  assert.deepEqual(C.arrivalExamples('工作日晚上七点，周末下午两点'),[]);
});
test('同一工作日范围有不同报价时段时，保留冲突证据', () => {
  const {values,candidates} = C.draft([image(['工作日18:00–23:59，周末06:00–23:59','工作日17:00–23:59'])]);
  assert.equal(values.window,'');
  assert.equal(candidates.unmodeled.length,2);
});
test('试算三张十次卡保持购买上限约束并应用同一使用时段', () => {
  const terms = { type:'visits',name:'十次卡',price:'229',units:'10',window:'restricted',
    opens:'06:00',closes:'23:59',weekdays:'all',visitMax:'1080',validity:'unlimited',redemption:'visit' };
  const profile = study(540,{frequency:7,time:'14:00'});
  const draft = C.makeOffer(terms);
  assert.equal(C.compare([draft],profile).rows[0].covered,10);
  const chosen = C.makeOffer({...terms,trialQuantity:3});
  const result = C.compare([chosen],profile);
  assert.deepEqual([result.rows[0].covered,result.rows[0].cost,result.rows[0].left], [28,68700,2]);
  assert(result.conditional);
  const late = C.compare([chosen],study(540,{frequency:7,time:'16:38'}));
  assert.deepEqual([late.rows[0].covered,late.rows[0].cost], [0,68700]);
  assert.throws(() => C.makeOffer({...terms,limit:'2',trialQuantity:3}),/购买限制/);
  assert.throws(() => C.makeOffer({...terms,stackingBlocked:true,trialQuantity:3}),/购买限制/);
});
test('不同起算方式不会覆盖有效期候选', () => {
  const result = C.draft([image(['有效期：2026年11月10日至2026年12月10日','核销后20天有效'])]);
  assert.equal(result.values.validity,'');
  assert.equal(result.candidates.until[0].value,'2026-12-10');
  assert.equal(result.candidates.days[0].value,'20');
});
test('咖啡从 8 杯单买切换到 9 杯次卡，12 杯混合买', () => {
  assert.equal(C.compare([single,pack],coffee(8)).best.cost,23200);
  assert.equal(C.compare([single,pack],coffee(9)).best.cost,24000);
  const result=C.compare([single,pack],coffee(12));
  assert.equal(result.best.cost,29800);
  assert.equal(result.best.detail,'1 × 十次卡 ＋ 2 × 单杯券');
  assert.equal(result.conditional,false);
});
test('未知限购、商品不一致或未确认组合不能变成确定的最优组合', () => {
  const unknown=offer('单杯券','single','29',{limit:''});
  assert.equal(C.compare([unknown,pack],coffee(8)).conditional,true);
  const result=C.compare([single,pack],coffee(12,{sameProduct:false}));
  assert.equal(result.rows.length,2);
  assert.equal(result.conditional,true);
  assert.equal(C.compare([single,pack],coffee(12,{mix:false})).rows.length,2);
});
test('限购和过期影响覆盖，组合优先使用即将失效的机会', () => {
  const onlyOne=offer('单杯券','single','29',{limit:'1',validity:'fixed',until:'2026-11-12'});
  const dated=offer('十次卡','visits','240',{units:'10',limit:'1',validity:'fixed',from:'2026-11-11',until:'2026-11-20'});
  const noWinner=C.compare([onlyOne,dated],coffee(12,{start:'2026-11-09',gap:'1'}));
  assert.equal(noWinner.best,null);
  assert.equal(noWinner.rows[2].covered,11);
  assert.equal(C.compare([onlyOne,dated],coffee(8)).conditional,true);
});
test('纯次卡也能按日历试算，选择的日期与总次数共同决定覆盖', () => {
  const option = offer('次卡','visits','229',{ units:'30', validity:'fixed', until:'2026-11-12' });
  const base = coffee(14,{start:'2026-11-10',gap:3});
  assert.deepEqual(C.calendarOffsets(base).slice(0,3),[0,3,6]);
  assert.equal(C.calendarDays(base,28,28).filter(day => day.planned).length,4);
  const custom = coffee(14,{start:'2026-11-10',gap:3,visitOffsets:[0,2,5,5,-1]});
  const result = C.compare([option],custom);
  assert.equal(result.count,3);
  assert.equal(result.rows[0].covered,2);
  assert.equal(C.compare([option],base).count,14);
});
test('日历按实际起始日期和自定义到访日计算覆盖', () => {
  const weekdays = offer('仅工作日', 'period', '100', { window:'restricted', opens:'08:00', closes:'22:00', weekdays:'workdays' });
  const plan = study(120, { weeks:2, start:'2026-11-10', time:'12:00', visitOffsets:[4,0,4,8,14,-1] });
  assert.deepEqual(C.calendarDays(plan).filter(slot => slot.planned).map(slot => [slot.offset,slot.weekday]), [[0,2],[4,6],[8,3]]);
  const result = C.compare([weekdays], plan);
  assert.equal(result.count,3);
  assert.equal(result.minutes,360);
  assert.equal(result.rows[0].covered,2);
});
test('未填开始日时日历保持相对周次，并且用回每周计划后恢复频率', () => {
  const weekly = study(120, { weeks:2, frequency:2 });
  const dates = C.calendarDays(weekly);
  assert.deepEqual(dates.slice(0,3).map(slot => [slot.date,slot.weekday,slot.planned]),
    [[null,1,true],[null,2,true],[null,3,false]]);
  const custom = study(120, { weeks:2, frequency:2, visitOffsets:[5] });
  assert.equal(C.compare([visits],custom).count,1);
  assert.equal(C.compare([visits],weekly).count,4);
});
test('切换停留时间会改变最省钱选项，时长上限和时段可排除月卡', () => {
  assert.equal(C.compare([hourly,visits,monthly],study(120)).best.name,'小时卡');
  const after=C.compare([hourly,visits,monthly],study(300));
  assert.equal(after.best.name,'月卡');
  assert.equal(after.rows[0].cost,40000);
  const evening=offer('晚间月卡','period','260',{limit:'1',window:'restricted',opens:'18:00',closes:'24:00',weekdays:'all'});
  const short=offer('限时次卡','visits','100',{units:'30',visitMax:'180',redemption:'visit'});
  const result=C.compare([hourly,visits,evening,short],study(300,{time:'13:00'}));
  assert.equal(result.best.name,'30 次卡');
  assert.equal(result.rows[2].missingMinutes,3600);
  assert.equal(result.rows[3].covered,0);
});
test('小时卡使用整数分钟，向上取整和最低扣减均影响覆盖', () => {
  const rounded=offer('小时卡','hours','100',{units:'180',limit:'1',billing:'30',minimum:'90'});
  const result=C.compare([rounded,monthly],C.makeProfile({minutes:'61',weeks:'1',frequency:'3',sameProduct:true},'study'));
  assert.equal(result.rows[0].coveredMinutes,122);
  assert.equal(result.rows[0].missingMinutes,61);
  assert.equal(result.rows[0].left,0);
});
test('工作日限制和有效期使用同一组真实到访日期', () => {
  const restricted=offer('周末卡','period','99',{limit:'1',validity:'fixed',until:'2026-11-15',window:'restricted',opens:'10:00',closes:'18:00',weekdays:'weekends'});
  const result=C.compare([restricted,monthly],study(120,{start:'2026-11-09',weekdays:[1,6],time:'12:00'}));
  assert.equal(result.count,8);
  assert.equal(result.rows[0].covered,1);
  assert.equal(result.best.name,'月卡');
});
test('拒绝不存在的日期、错误区间或非整数权益', () => {
  assert.throws(()=>coffee(4,{start:'2026-02-30'}),/日期/);
  assert.throws(()=>offer('小时卡','hours','1',{units:'0.5'}),/分钟/);
  assert.throws(()=>offer('晚间卡','period','200',{window:'restricted',opens:'22:00',closes:'02:00'}),/起止/);
});


test('小时卡各份独立，完整到访不会自动拼接两份的零碎余额', () => {
  const independent=offer('小时卡','hours','100',{units:'180',limit:'0',billing:'1',minimum:'0'});
  const plan=C.makeProfile({minutes:'100',weeks:'1',frequency:'3',sameProduct:true},'study');
  const row=C.compare([independent,monthly],plan).rows[0];
  assert.equal(row.cost,30000);
  assert.equal(row.coveredMinutes,300);
  assert.equal(row.left,240);
});

function positioned(id, rows) {
  return { id, ocr:{ width:800, height:1000, lines:rows.map(([text,y])=>({ text, box:{ x:20,y,width:500,height:25 } })) } };
}
test('从主标题及其报价提取方案，优先于不同的底部价与划线价', () => {
  const cover=positioned('cover', [['¥29.57.2折〉',480],['¥41',502],['〖入冬第一杯〗星巴克太妃榛果拿铁单大',540],
    ['杯/低因无糖高蛋白可选',568],['饮品8选1',710],['折后¥28.9',976]]);
  const {values,candidates}=C.draft([cover]);
  assert.equal(values.name,'〖入冬第一杯〗星巴克太妃榛果拿铁单大杯/低因无糖高蛋白可选');
  assert.equal(values.price,'29.5');
  assert.equal(candidates.footer[0].value,'cents:2890');
});
test('连续相同底价页面保留同一标题和报价，底价错字只用于匹配', () => {
  const cover=positioned('cover', [['¥2669/共10次单次26.69元〉',430],['〖一年一度〕星巴克太妃榛果拿铁大杯十',477],
    ['次卡/低因无糖高蛋白可选',507],['折后¥266.叨0次',978]]);
  const terms=positioned('terms', [['退款规则',170],['折后¥266.叨0次',978]]);
  assert.equal(C.matchesPrevious([cover],terms),true);
  const {values}=C.draft([cover,terms]);
  assert.equal(values.price,'266.9');
  assert.equal(values.name,'〖一年一度〕星巴克太妃榛果拿铁大杯十次卡/低因无糖高蛋白可选');
  assert.equal(C.draft([terms]).values.price,'');
});
test('底部的整数与小数报价按金额匹配，非底部金额不触发归组', () => {
  const cover=positioned('cover', [['商品名称：上午单次券',300],['团购价 ¥29元',420],['折后¥29.00',978]]);
  const terms=positioned('terms', [['使用规则',270],['¥29',975]]);
  assert.equal(C.matchesPrevious([cover],terms),true);
  assert.equal(C.matchesPrevious([cover],positioned('body',[['团购价¥29',450]])),false);
  assert.equal(C.matchesPrevious([cover],positioned('other-price',[['折后¥28.90',975]])),false);
});
test('同价但明确标题、商家或权益不同的方案不自动合并', () => {
  const cover=positioned('cover', [['商品名称：星巴克拿铁单杯券',300],['折后¥29',978]]);
  const other=positioned('other', [['商品名称：星巴克摩卡单杯券',300],['折后¥29',978]]);
  const pack=positioned('pack', [['套餐名称：星巴克拿铁10次卡',300],['10次卡',400],['折后¥29',978]]);
  assert.equal(C.matchesPrevious([cover],other),false);
  assert.equal(C.matchesPrevious([cover],pack),false);
});
test('底部冲突金额不建立归组证据，正文商品价仍可使用', () => {
  const cover=positioned('cover', [['套餐名称：咖啡单杯券',300],['套餐价¥29',440],['折后¥29',970],['折后¥39',978]]);
  const detail=positioned('detail', [['折后¥29',970]]);
  assert.equal(C.draft([cover]).values.price,'29');
  assert.equal(C.matchesPrevious([cover],detail),false);
});


test('按商品标题与页脚报价拆分套餐，保留每组自己的有效期和预约口径', () => {
  const page = (id, lines) => ({ ...image(lines), id });
  const items = [
    page('a1', ['10次卡【河景位】', '套餐价229元', '周一至周日06:00.23:59']),
    page('a2', ['购买后90天内有效', '无需预约', '套餐价229元']),
    page('b1', ['晚自习月卡【宽敞座位】', '套餐价359元', '购买后90天内有效', '无需预约']),
    page('b2', ['限制详情连续30天使用', '购买后15天内有效', '需至少提前2小时联系管家预约', '周一至周五18:00·23:59，周六周日06:00·23:59', '套餐价359元']),
    page('other', ['套餐价499元']),
  ];
  const { groups, unmatched } = C.groupPackages(items);
  assert.deepEqual(groups.map(group => group.map(item => item.id)), [['a1', 'a2'], ['b1', 'b2']]);
  assert.deepEqual(unmatched.map(item => item.id), ['other']);
  const [visits, month] = groups.map(C.packageSummary);
  assert.deepEqual(visits.evidence.purchase.map(item => item.value), ['90 天']);
  assert.deepEqual(month.evidence.purchase.map(item => item.value), ['90 天', '15 天']);
  assert.deepEqual(month.evidence.reserve.map(item => item.value), ['无需预约', '需要预约']);
  assert.equal(month.evidence.weekday[0].value, '18:00–23:59');
  assert.equal(month.evidence.weekend[0].value, '06:00–23:59');
  assert.deepEqual(C.packagePreview(visits, 12, 30), { paid: 22900, covered: 10, missing: 2, perVisit: 2290, quantity: 1, quota: 10, left: 0 });
  assert.deepEqual(C.packagePreview(month, 12, 30), { paid: 35900, covered: 12, missing: 0, perVisit: 2992, quantity: 1, quota: 30, left: 18 });
});

test('按聊天中的每周频次与周数计算用量，可续改周数', () => {
  const plan = C.parseVisitPlan('我想要一周三次晚上自习需要自习三周你建议我买哪个');
  assert.deepEqual(plan, { frequency: 3, weeks: 3, visits: 9, days: 21, conflicting: false });
  assert.equal(C.parseVisitPlan('改成连续四周呢', plan).visits, 12);
  assert.equal(C.parseVisitPlan('每周两次', plan).visits, 6);
  assert.equal(C.parseVisitPlan('预计到访8次', plan).visits, 8);
  assert.equal(C.parseVisitPlan('每周3次，一共4周，总共15次').conflicting, true);
  assert.equal(C.parseVisitPlan('每周三次去多久比较划算').visits, null);
  assert.equal(C.parseVisitPlan('这个10次卡和月卡怎么选'), null);
  assert.equal(C.parseVisitPlan('十次卡可以买两次，我计划去十八次').visits, 18);
  assert.equal(C.parseVisitPlan('我打算到访18次').visits, 18);
  assert.equal(C.parseVisitPlan('十八次').visits, 18);
  assert.equal(C.parseVisitPlan('十次卡可以买两次'), null);
});

test('聊天中的次卡张数按套餐匹配，数量与计划到访次数分开', () => {
  const visits = { type: 'visits', name: '河景10次卡', shortName: '河景10次卡', units: 10, price: 22900,
    limit: null, images: [{ id: 'visit' }] };
  const second = { ...visits, name: '夜间10次卡', shortName: '夜间10次卡', images: [{ id: 'night' }] };
  const month = { type: 'period', name: '晚自习月卡', duration: 30, price: 35900, images: [{ id: 'month' }] };
  const text = '十次卡可以买两张，我计划去十八次';
  const plan = C.parseVisitPlan(text);
  const purchase = C.parsePurchaseLimits(text, [visits, month]);
  assert.deepEqual(purchase, { limits: { visit: 2 }, ambiguous: false });
  assert.deepEqual(C.packagePreview(visits, plan.visits, 30, purchase.limits.visit), {
    paid: 45800, covered: 18, missing: 0, perVisit: 2544, quantity: 2, quota: 20, left: 2,
  });
  assert.equal(C.packagePreview(visits, 8, 30, 2).quantity, 1);
  assert.equal(C.packagePreview(visits, 21, 30, 2).missing, 1);
  assert.equal(C.packagePreview({ ...visits, limit: 1 }, 18, 30, 2).missing, 8);
  assert.equal(C.packagePreview(month, 31, 31, 2), null);
  assert.equal(C.packagePreview(month, 18, 30, 2).quantity, 1);
  assert.deepEqual(C.parsePurchaseLimits(text, [visits, second, month]), { limits: {}, ambiguous: true });
  assert.deepEqual(C.parsePurchaseLimits('河景十次卡最多购买两份', [visits, second]).limits, { visit: 2 });
  assert.deepEqual(C.parsePurchaseLimits('十次卡可以买两张？', [visits, month]).limits, {});
  assert.deepEqual(C.parsePurchaseLimits('十次卡不可以买两张', [visits, month]).limits, {});
  assert.deepEqual(C.parsePurchaseLimits('十次卡不能叠加使用', [visits, month]).limits, { visit: 1 });
  assert.equal(C.packageSummary([{ ...image(['10次卡', '套餐价229元', '每人限购两份']), id: 'visit' }]).limit, 2);
});

test('比较面板根据对话中的可购上限试算多张卡并标记条件', () => {
  const cap = C.effectivePurchaseLimit(null, 2);
  const visits = offer('10次卡','visits','229',{ units:'10', limit:String(cap), purchaseAssumed:true });
  const plan = C.makeProfile({ frequency:'6', weeks:'3', minutes:'60', sameProduct:true }, 'study');
  const row = C.compare([visits, monthly], plan).rows[0];
  assert.equal(row.covered, 18);
  assert.equal(row.cost, 45800);
  assert.equal(row.left, 2);
  assert(row.notes.some(note => note.includes('按对话')));
});
