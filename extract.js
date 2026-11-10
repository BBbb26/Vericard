(function(root){'use strict';
const T=typeof module!=='undefined'?require('./offer-terms'):root.KDZTerms;
const labels={...T.labels,merchant:'商家',title:'套餐名称',price:'页面展示价（元）',total:'次数/小时/连续天数',unit:'权益类型',purchaseDays:'首次核销前有效天数',expiryDays:'核销后有效天数',fixedEnd:'固定截止日期',schedule:'使用时段原文',refund:'退款条款原文',reservation:'预约条款原文'};
const clean=s=>String(s).normalize('NFKC').replace(/\s+/g,'').replace(/￥/g,'¥');
function extract(image){const out=[];const lines=image.ocr?.lines||[];function add(field,value,line){if(value!==''&&value!=null)out.push({field,value:String(value),imageId:image.id,lineId:line.id,quote:line.text,box:line.box,status:'待核对',sourceType:'ocr',method:'本地OCR＋规则提取'});}
 let inRefund=false;
 for(const line of lines){const t=clean(line.text),footer=(line.box?.y||0)>image.ocr.height*.84;T.scan(t,(field,value)=>add(field,value,line));const isMainTerm=!/^(?:赠送金|赠金|赠送余额)/.test(t);
  if(/^退款规则[:：]?$/.test(t)){inRefund=true;continue;}
  if(/^(适用人数|规则提醒|使用规则|温馨提示|其他规则|预约信息|立即抢购|立即购买)/.test(t)||footer)inRefund=false;
  if(footer){const p=t.match(/折后¥?([0-9]+(?:\.[0-9]{1,2})?)(?=\/|元|$)/)||t.match(/^¥([0-9]+(?:\.[0-9]{1,2})?)[|丨]/);if(p)add('price',p[1],line);}
  for(const name of ['乐橙','三条锦鲤','王知之','星巴克','EONE'])if(t.toUpperCase().includes(name.toUpperCase())){add('merchant',name,line);break;}
  if(!/购买须知|使用须知|退款|预约|如|每人|剩余|累计|购买后|核销后|单次价格|使用时间|时长|其他类型|仅限|验券后/.test(t)&&/(\d+次卡|\d+[hH]卡|\d+小时卡|月卡|季卡|周卡|双月卡)/.test(t)&&t.length<90){add('title',t,line);}
  let m=t.match(/(\d+)次卡[【\[（(]?(?:赠|送)(\d+)次/);if(m){add('total',+m[1]+ +m[2],line);add('unit','次',line);}
  else if((m=t.match(/验券后可间断使用(\d+)次/))){add('total',m[1],line);add('unit','次',line);}
  else if(!/退款|例如|如月卡|如\d|累计|每天最多|核销后/.test(t)&&(m=t.match(/(?:共|总计)(\d+)(?:份|次)|^(\d+)次卡/))){add('total',m[1]||m[2],line);add('unit','次',line);}
  if(!/如|退款/.test(t)&&(m=t.match(/^(\d+)(?:小时|[hH])(?:卡|1个座位)/))){add('total',m[1],line);add('unit','小时',line);}
  if(isMainTerm&&(m=t.match(/购买(?:之)?后(\d+)天(?:内)?有效/)))add('purchaseDays',m[1],line);
  if(isMainTerm&&(m=t.match(/(?:核销|兑换|验券)(?:之)?后(\d+)天(?:内)?(?:有效|可使用)/)))add('expiryDays',m[1],line);
  if(isMainTerm&&!/例如|如月卡/.test(t)&&(m=t.match(/连续(?:使用)?(\d+)天/))){add('expiryDays',m[1],line);add('unit','连续天',line);add('total',m[1],line);}
  if(isMainTerm&&(m=t.match(/(?:至|到|—|~)(20\d{2})[年.\/-](\d{1,2})[月.\/-](\d{1,2})/)))add('fixedEnd',`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`,line);
  if(/\d{1,2}:\d{2}|周[一二三四五六日末].*(?:点|全天)/.test(t)&&!footer&&(line.box?.y||0)>image.ocr.height*.1)add('schedule',t,line);
  if(inRefund||(/手续费|退还|退款|未使用可退|验券后不可退|未消费金额/.test(t)&&t.length>5))add('refund',t,line);
  if(/无需预约|提前.{0,6}预约|不进行提前预约|每日预约|自助订座/.test(t))add('reservation',t,line);
 }
 return out;
}
function timestamp(name){const m=name.match(/(20\d{2})[-_](\d{2})[-_](\d{2})[ _](\d{2})(\d{2})(\d{2})/);return m?Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6]):null;}
function suggestGroups(images){const sorted=[...images].sort((a,b)=>(timestamp(a.name)??Infinity)-(timestamp(b.name)??Infinity)||a.name.localeCompare(b.name));const groups=[];let prev=null;
 for(const im of sorted){const facts=extract(im),value=k=>facts.find(f=>f.field===k)?.value;const now=timestamp(im.name),price=value('price'),merchant=value('merchant'),title=value('title');let join=false,reason='新组：请核对商品首页与后续详情';
  if(prev){const adjacent=now!==null&&prev.time!==null&&now-prev.time>=0&&now-prev.time<=120000;const compatible=(!merchant||!prev.merchant||merchant===prev.merchant)&&(!title||!prev.title||title===prev.title||title.includes(prev.title)||prev.title.includes(title));
   if(adjacent&&price&&price===prev.price&&compatible){join=true;reason='建议合并：时间相邻、底部展示价相同，未发现标题/商家冲突；仍需人工核对';}}
  if(!join)groups.push({id:'g-'+im.id.slice(0,12),name:title||merchant||im.name,imageIds:[],fields:{},history:[],confirmed:false});
  const g=groups.at(-1);g.imageIds.push(im.id);im.groupReason=reason;prev={time:now,price,merchant:merchant||(join?prev?.merchant:null),title:title||(join?prev?.title:null)};
 }
 return groups;
}
function candidates(group,images){const ids=new Set(group.imageIds);return images.filter(i=>ids.has(i.id)).flatMap(extract);}
function conflicts(facts){const result={};for(const k of Object.keys(labels)){const values=[...new Set(facts.filter(f=>f.field===k).map(f=>f.value))];if(values.length>1)result[k]=values;}return result;}
function validateTransfer(fields){const val=k=>fields[k]?.value?.trim()||'';const price=Number(val('price')),total=Number(val('total'));if(!val('price')||!Number.isFinite(price)||price<0)throw Error('请核对展示价');if(!val('total')||!Number.isInteger(total)||total<=0)throw Error('请核对权益数量');if(val('unit')==='小时')throw Error('P0暂不支持小时卡计算，请保留在提取表单中');if(!['次','使用日','连续天'].includes(val('unit')))throw Error('请选择权益类型：次、使用日或连续天');for(const k of ['price','total','unit'])if(fields[k]?.status!=='用户核对')throw Error('价格、数量、权益类型须分别标记为用户核对');return {price,total,type:val('unit')==='连续天'?'period':val('unit')==='使用日'?'days':'count'};}
const api={labels,clean,extract,timestamp,suggestGroups,candidates,conflicts,validateTransfer};if(typeof module!=='undefined')module.exports=api;else root.KDZExtract=api;
})(typeof globalThis!=='undefined'?globalThis:this);
