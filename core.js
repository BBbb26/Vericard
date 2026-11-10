(function(root){
'use strict';
const cases=[
 {id:'lecheng10',name:'乐橙 · 10次卡',type:'days',price:229,total:10,purchaseDays:90,expiry:null,status:'截图明确',source:'141725–141736；同日进出计1次由用户确认',rules:'90天仅为首次核销截止期；核销后期限未知。',refund:'assumed',question:'已消费次数是否按实付金额÷总次数扣除，再收剩余金额30%的手续费？'},
 {id:'lecheng30',name:'乐橙 · 晚自习月卡',type:'period',price:359,total:30,purchaseDays:null,expiry:30,status:'用户确认',source:'141742–141751；核销日起连续30天由用户确认',rules:'工作日18:00–23:59，周末06:00–23:59；核销后连续计时。核销前15/90天、预约及退款条款存疑。',refund:'unknown',question:'核销前有效期是15天还是90天？核销后能否部分退款，如何扣费？'},
 {id:'koi36',name:'三条锦鲤 · 30次赠6次',type:'days',price:531,total:36,purchaseDays:90,expiry:null,status:'截图明确',source:'142004–142024',rules:'36次可间断使用，按自然日计；90天为首次核销截止期。部分退款手续费0%，赠送次数计价未知。',refund:'unknown',question:'使用部分次数后，已消费权益按什么单价扣除？赠送6次如何参与退款？'},
 {id:'eone3',name:'EONE · 3次洗吹',type:'count',price:156,total:3,purchaseDays:null,expiry:null,status:'截图明确',source:'142058–142149；总限购及可选预约由用户确认',rules:'页面写购买后150天内有效；未将其自动换算为核销后期限。36元券活动总限购2张，工作日11–15点；56元券总限购1张。',refund:'unknown',question:'次卡与单次券是否适用于同一门店和相同服务？请确认所有计划日期均在各券有效期内。'},
 {id:'coffee10',name:'星巴克 · 太妃榛果10次卡',type:'count',price:266.9,total:10,purchaseDays:null,expiry:null,fixed:'2026-12-30',start:'2026-11-03',status:'截图明确',source:'135647–135704',rules:'固定有效期2026-11-03至2026-12-30 23:59；07:00–22:00，每日不限使用次数。退款阶梯需按优惠分摊。',refund:'tier',question:'优惠按比例分摊后，各次退款金额如何取整到分？'}
];
const round=n=>Math.round((n+Number.EPSILON)*100)/100;
function day(s){if(!/^\d{4}-\d{2}-\d{2}$/.test(s||''))throw Error('日期格式须为YYYY-MM-DD');const n=Date.parse(s+'T00:00:00Z');if(!Number.isFinite(n)||new Date(n).toISOString().slice(0,10)!==s)throw Error('日期不存在');return n/86400000;}
function number(v,name){if(v===''||v===null||v===undefined||!Number.isFinite(Number(v))||Number(v)<0)throw Error(name+'必须是非负数');return Number(v);}
function calculate(c,input){
 const price=number(input.price,'支付金额'),extra=number(input.extra??0,'额外费用');
 const total=number(input.total??c.total,'权益数量');if(!Number.isInteger(total)||total<1)throw Error('权益数量须为正整数');
 let used=number(input.used??0,'使用次数');if(!Number.isInteger(used))throw Error('使用次数须为整数');
 const notes=[],excluded=[];let accepted=[],end=null,expiryStatus='期限未知',days=null;
 if(input.expiryDays!==''&&input.expiryDays!=null){days=number(input.expiryDays,'核销后有效天数');if(!Number.isInteger(days)||days<1)throw Error('有效天数须为正整数');}
 if(c.type==='period'&&days===null)days=c.total;
 if(c.fixed){end=day(c.fixed);expiryStatus=c.fixedEvidence==='assumption'?'假设固定截止日':'固定截止日';}
 else if(days!==null&&input.activation){end=day(input.activation)+days-1;expiryStatus=input.expiryEvidence==='assumption'?'假设期限':'用户确认期限';}
 else if(days!==null)notes.push('已填有效天数，但缺核销日期，暂不能定位到期日。');
 if(input.unlimited){if(days!==null||c.fixed||c.type==='period')throw Error('无固定期限不能与已填写期限同时启用');expiryStatus='用户确认无固定期限';}
 if(c.purchaseEvidence==='assumption')notes.push('首次核销前有效天数来自试算假设，尚未确认。');
 if(c.review)notes.push('截图导入仅计算基础成本与日期；使用时段、预约、退款等原文尚未转为执行规则。');
 if(input.activation)day(input.activation);
 if(input.purchase){day(input.purchase);if(input.activation&&day(input.activation)<day(input.purchase))throw Error('核销日不能早于购买日');if(c.purchaseDays&&input.activation&&day(input.activation)>day(input.purchase)+c.purchaseDays-1)notes.push('核销日期超出购买有效期估算窗口，请核实券状态。');}
 const lines=(input.plan||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
 if(lines.length){
  for(const line of lines){const m=/^(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})$/.exec(line);if(!m)throw Error('每条计划须为YYYY-MM-DD HH:mm');const d=day(m[1]),h=+m[2],min=+m[3];if(h>23||min>59)throw Error('时间不存在');const t=h*60+min;let reason='';
   if(input.activation&&d<day(input.activation))reason='早于核销日';
   if(c.start&&d<day(c.start))reason='早于活动开始';
   if(end!==null&&d>end)reason='超过有效期';
   const weekday=new Date(d*86400000).getUTCDay();
   if(c.id==='lecheng10'&&(t<360||t>1439))reason='不在06:00–23:59';
   if(c.id==='lecheng30'&&(t<((weekday===0||weekday===6)?360:1080)))reason='不在晚自习可用时段';
   if(c.id==='coffee10'&&(t<420||t>1320))reason='不在07:00–22:00';
   if(reason)excluded.push({line,reason});else accepted.push(m[1]+' '+m[2]+':'+m[3]);
  }
  used=c.type==='days'||c.type==='period'?new Set(accepted.map(x=>x.slice(0,10))).size:accepted.length;
 }
 if(used>total)throw Error('使用量超过套餐权益；请拆分套餐外消费');
 let refund=null,refundLabel='未选择退款情景';
 if(input.refundMode==='assumed'){
  if(c.id!=='lecheng10')throw Error('该套餐不支持此退款假设');refund=round(price/total*(total-used)*(used===0?1:0.7));refundLabel='假设估算，待商家确认';
 }else if(input.refundMode==='tier'){
  if(c.id!=='coffee10'||total!==10)throw Error('阶梯表仅适用于该10次卡');const refs=[275,243.1,211.2,179.3,147.4,115.5,87.6,59.7,31.8,11.9,0];refund=round(refs[used]*price/275);refundLabel='按比例分摊估算，取整方式待确认';
 }else if(input.refundMode==='manual'){
  refund=number(input.refundAmount,'退款金额');if(refund>price)throw Error('退款金额不能超过本次支付金额');refundLabel=input.refundEvidence==='confirmed'?'用户确认退款金额':'用户输入假设退款金额';
 }else if(input.refundMode==='unknown'){refundLabel='退款规则未明确，不计算确定净支出';}
 const net=refund===null?null:round(price+extra-refund),remaining=total-used;
 let comparison=null;
 if(c.id==='eone3'&&lines.length&&!excluded.length&&used>0&&input.sameService&&input.validCoupons){
  const cap36=number(input.cap36??2,'36元券剩余限购'),cap56=number(input.cap56??1,'56元券剩余限购');
  if(!Number.isInteger(cap36)||cap36>2||!Number.isInteger(cap56)||cap56>1)throw Error('限购额度须为整数，且不得超过活动总限购');
  const eligible=accepted.filter(x=>{const d=new Date(day(x.slice(0,10))*86400000).getUTCDay();const t=+x.slice(11,13)*60+ +x.slice(14,16);return d>=1&&d<=5&&t>=660&&t<=900;}).length;
  const n36=Math.min(cap36,eligible),n56=used-n36;
  comparison=n56<=cap56?{cost:round(n36*36+n56*56),saving:round(price+extra-n36*36-n56*56),n36,n56}: {unavailable:true};
 }
 if(c.id==='eone3'&&excluded.length)notes.push('部分需求未被次卡覆盖，暂不比较整个购买方案，避免将被排除的消费悄悄忽略。');
 if(end===null&&!input.unlimited)notes.push('核销后期限未定位：不判断到期前能否用完，不估算确定过期损失。');
 if(lines.length&&!input.activation&&!c.fixed)notes.push('缺核销日期：尚未检查计划是否早于核销。');
 notes.push('计划仅检查已录入的日期和入场时段，未验证座位、库存、停留时长和实际履约。');
 return {used,total,remaining,average:used?round((price+extra)/used):null,refund,refundLabel,net,end:end===null?null:new Date(end*86400000).toISOString().slice(0,10),expiryStatus,notes,accepted,excluded,comparison,question:c.question};
}
const api={cases,calculate,round};if(typeof module!=='undefined')module.exports=api;else root.KDZ=api;
})(typeof globalThis!=='undefined'?globalThis:this);
