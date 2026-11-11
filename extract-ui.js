if (typeof crypto !== 'undefined' && !crypto.randomUUID) { crypto.randomUUID = function(){return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0,v=c==='x'?r:(r&3|8);return v.toString(16)})}; }

'use strict';
const E=KDZExtract,T=KDZTerms,$=id=>document.getElementById(id);let images=[],groups=[],active=null,dirty=false,busy=false;
const params = new URLSearchParams(location.search);
const modelPreferenceKey='kdz-agent-use-deepseek';
const useDeepSeek=()=>{const box=$('aiDeepSeek');return Boolean(box&&!box.disabled&&box.checked)};
const typeGuides={stored_value:'储值卡请上传实付、本金、赠送金、扣减顺序与适用范围。',visit_pack:'次数卡请上传实付、次数、核销方式和有效期限。',time_pass:'期限会员请上传实付、生效规则、截止日期和服务范围。'};
if(Object.hasOwn(typeGuides,params.get('type')))$('typeGuide').textContent=typeGuides[params.get('type')];
const priorityFields = ['merchant', 'title', 'planType', 'price', 'actualPrice', 'unit', 'total', 'principal', 'bonus', 'deduction', 'coverage', 'bonusCoverage'];
const fieldSections = [
  ['套餐与价格', ['merchant','title','planType','price','actualPrice']],
  ['权益与期限', ['unit','total','principal','bonus','purchaseDays','expiryDays','fixedStart','fixedEnd','validityMode','bonusEnd','bonusDays','bonusValidity']],
  ['适用范围与扣减', ['deduction','coverage','bonusCoverage','fixedDebit','fee','restrictions','stacking']],
];
const fieldTone = { explicit: 'success', missing: 'neutral', ambiguous: 'warning', conflicting: 'danger', potential_risk: 'warning' };
let renderedFacts = [], activeFieldGroup, evidenceImageId;
function jumpField(key, focus = false) {
  const row = $('term-' + key);
  if (!row) return;
  $('advancedReview').open = true;
  row.closest('details').open = true;
  row.scrollIntoView({block:'start'});
  if (focus) row.querySelector('input,textarea')?.focus({preventScroll:true});
}
function summaryValue(value){return String(value??'').replace(/\s+/g,' ').trim();}
function truncate(value,length){const text=summaryValue(value);return text.length>length?text.slice(0,length)+'…':text;}
function fieldBadge(field,state){
  const value=summaryValue(field?.value);
  if(state==='conflicting')return ['存在冲突','danger'];
  if(state==='potential_risk')return ['需核查','warning'];
  if(value&&field?.status==='用户核对')return ['已确认','success'];
  if(value&&field?.status==='试算假设')return ['试算假设','warning'];
  if(value)return ['待确认','info'];
  return ['未提及','neutral'];
}
function usableField(key,group=current()){
  const field=group?.fields?.[key];
  return Boolean(field?.status==='用户核对'&&summaryValue(field.value));
}
function validityKeys(group=current()){
  return ['expiryDays','fixedEnd','validityMode'];
}
function coreFieldKeys(group=current()){
  const type=group?.fields?.planType?.value;
  const keys=['planType','price'];
  if(type==='次数')keys.push('total','unit');
  if(type==='储值')keys.push('principal');
  if(type==='期限'&&!validityKeys(group).some(key=>usableField(key,group))){
    keys.push(validityKeys(group).find(key=>summaryValue(group.fields?.[key]?.value))||'expiryDays');
  }
  return [...new Set(keys)];
}
function blockingKeys(group=current()){
  const keys=[];
  if(!group.confirmed)keys.push('__group');
  if(!usableField('planType',group))keys.push('planType');
  if(!usableField('price',group)&&group.fields?.price?.status!=='试算假设')keys.push('price');
  for(const key of coreFieldKeys(group)){
    if(key!=='planType'&&key!=='price'&&!usableField(key,group))keys.push(key);
  }
  return [...new Set(keys)];
}
function confirmField(key,group=current()){
  const field=group?.fields?.[key];
  if(!field?.value?.trim()||field.status==='用户核对')return false;
  const state=T.describeField(key,field,renderedFacts.filter(item=>item.field===key));
  if(state==='conflicting'||state==='missing')return false;
  const before={value:field.value,status:field.status};
  field.status='用户核对';
  group.history.push({at:new Date().toISOString(),field:key,before,after:{value:field.value,status:'用户核对'},action:'按截图原文确认'});
  return true;
}
function renderReviewHints(group, facts) {
  const keys=[...new Set([...coreFieldKeys(group),'coverage'])];
  const review=keys.flatMap(key=>{
    const field=group.fields?.[key];
    if(!field||field.status==='用户核对')return [];
    const state=T.describeField(key,field,facts.filter(item=>item.field===key));
    if(state==='explicit')return [];
    return [{key,state,field}];
  }).sort((a,b)=>Number(b.state==='conflicting')-Number(a.state==='conflicting')).slice(0,2);
  $('hintItems').replaceChildren(...review.map(({key,state,field})=>{
    const card=el('div');card.className='review-hint-card';
    const head=el('div');head.className='review-hint-head';
    const badge=el('small');badge.className='badge';
    const [label,tone]=fieldBadge(field,state);badge.textContent=label;badge.dataset.tone=tone;
    head.append(el('strong',E.labels[key]),badge);card.append(head);
    card.append(el('p',state==='conflicting'?'截图里出现了不同写法，请对照原图确认。'+
      (field.value?.trim()?'当前填写：'+truncate(field.value,70):''):
      field.value?.trim()?'截图提取：'+truncate(field.value,70):'截图中未找到，请查看原图或以其他方式补充。','muted'));
    const actions=el('div');actions.className='review-hint-actions';
    if(field.value?.trim()&&state!=='conflicting'){
      const ok=el('button','确认无误');ok.type='button';ok.className='secondary';
      ok.onclick=()=>{if(confirmField(key)){mark();render();status('已确认「'+E.labels[key]+'」，可继续核对其他项。')}};
      actions.append(ok);
    }
    const check=el('button','核对原文');check.type='button';check.className='ghost';check.onclick=()=>jumpField(key,true);
    actions.append(check);card.append(actions);
    return card;
  }));
  $('reviewHints').hidden=!review.length;
  $('groupState').textContent=group.confirmed?'归组已确认':'待确认归组';
  $('groupState').dataset.tone=group.confirmed?'success':'warning';
}
const el=(tag,text,className)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(className)n.className=className;return n};
async function api(url,data){const r=await fetch(url,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-KDZ-Local':'1'},body:JSON.stringify(data)});const json=await r.json();if(!r.ok)throw Error(json.error||'请求失败');return json;}
function status(text){const node=$('status');node.textContent=text;const partial=/^上传完成/.test(text)&&/[1-9]\d*张识别失败/.test(text);node.dataset.state=/^操作失败|^请通过|^无法|^上传失败/.test(text)?'error':partial?'warning':/^正在|^保存原图/.test(text)?'loading':dirty?'unsaved':'success';}
function mark(){dirty=true;status('有未保存修改，请保存项目。');if(current()?.fields){renderSummary(current());renderReviewHints(current(),renderedFacts);}}
function current(){return groups.find(g=>g.id===active)}
function fieldOptions(select,values,selected){values.forEach(v=>{const o=el('option',v);o.value=v;select.append(o)});select.value=selected;}
function initFields(g){const facts=E.candidates(g,images);g.fields||={};g.history||=[];for(const k of Object.keys(E.labels)){if(g.fields[k])continue;const options=facts.filter(f=>f.field===k),unique=[...new Set(options.map(f=>f.value))];g.fields[k]={value:T.rawFields.includes(k)?unique.join('\n'):(unique.length===1?unique[0]:''),status:'待核对',evidence:T.rawFields.includes(k)?options:(unique.length===1?options.filter(f=>f.value===unique[0]):[]),originalCandidates:options};}return facts;}
function clearEvidence() {
  evidenceImageId=null;
  for(const id of ['original','box','fullImage'])$(id).hidden=true;
  $('imageName').textContent='本组暂无原图';
  $('quote').textContent=$('ocrText').textContent='';
}
function showEvidence(id,line,scroll=true){const im=images.find(i=>i.id===id);if(!im)return;evidenceImageId=id;$('imageName').textContent=im.name;$('original').hidden=false;$('original').src=im.url;$('fullImage').hidden=false;$('fullImage').href=im.url;$('box').hidden=!line?.box;if(line?.box){const b=line.box;$('box').style.cssText=`left:${b.x/im.ocr.width*100}%;top:${b.y/im.ocr.height*100}%;width:${b.width/im.ocr.width*100}%;height:${b.height/im.ocr.height*100}%;`}$('quote').textContent=line?'证据原文：'+(line.quote||line.text):'未选择具体字段；展示整张原图。';$('ocrText').textContent=(im.ocr?.lines||[]).map(l=>l.text).join('\n')||'尚未识别';const original=$('original'),view=$('imageScroll');view.scrollTop=0;if(line?.box)original.decode().then(()=>{if(original.getAttribute('src')===im.url&&!$('box').hidden)view.scrollTop=Math.max(0,$('box').offsetTop-view.clientHeight*.35)}).catch(()=>{});if(scroll&&window.innerWidth<=880)$('imageName').scrollIntoView({block:'start'});}
function log(g,key,before,after,action){g.history.push({at:new Date().toISOString(),field:key,before,after,action});$('history').textContent=JSON.stringify(g.history,null,2);mark();}
function entitlementText(g){
  const type=g.fields?.planType?.value;
  const v=key=>summaryValue(g.fields?.[key]?.value);
  if(type==='储值'){
    const parts=[v('principal')?'本金 '+v('principal')+' 元':'',v('bonus')?'赠送 '+v('bonus')+' 元':''].filter(Boolean);
    return parts.join(' · ');
  }
  const total=v('total'),unit=v('unit');
  if(!total&&!unit)return '';
  if(unit==='连续天')return '连续 '+total+' 天';
  if(unit==='使用日')return total+' 次（按使用日）';
  if(unit==='次')return total+' 次';
  if(unit==='小时')return total+' 小时';
  return [total,unit].filter(Boolean).join(' ');
}
function validityText(g){
  const v=key=>summaryValue(g.fields?.[key]?.value);
  const parts=[];
  if(v('expiryDays'))parts.push('核销后 '+v('expiryDays'));
  if(v('fixedEnd'))parts.push('截至 '+v('fixedEnd'));
  if(v('validityMode'))parts.push(v('validityMode'));
  if(v('purchaseDays'))parts.push('首次核销 '+v('purchaseDays')+' 天内');
  return parts.join(' · ');
}
function summaryRow(g,key,label,value){
  const field=g.fields?.[key];
  const candidates=renderedFacts.filter(item=>item.field===key);
  const state=T.describeField(key,field,candidates);
  const [badgeText,tone]=fieldBadge(field,state);
  const row=el('button');row.type='button';row.className='review-row';row.onclick=()=>jumpField(key,true);
  const main=el('div');main.className='review-row-main';
  main.append(el('span',label,'review-row-label'),el('strong',summaryValue(value)||'—','review-row-value'));
  const badge=el('small',badgeText);badge.className='badge';badge.dataset.tone=tone;
  row.append(main,badge);
  return row;
}
function renderSummary(g){
  const type=g.fields?.planType?.value;
  const entitlementKey=type==='储值'?'principal':'total';
  const validityKey=validityKeys(g).find(key=>summaryValue(g.fields?.[key]?.value))||'purchaseDays';
  const limitKey=['restrictions','schedule','reservation'].find(key=>g.fields?.[key]?.value?.trim())||'restrictions';
  const rows=[
    summaryRow(g,'planType','类型',g.fields?.planType?.value),
    summaryRow(g,'price','价格',g.fields?.price?.value?'¥'+summaryValue(g.fields.price.value):''),
    summaryRow(g,entitlementKey,'权益',entitlementText(g)),
    summaryRow(g,validityKey,'有效期',validityText(g)),
    summaryRow(g,'coverage','适用范围',g.fields?.coverage?.value),
    summaryRow(g,limitKey,'关键限制',truncate(g.fields?.[limitKey]?.value,46)),
  ];
  $('knownChips').replaceChildren(...rows);
  const shown=new Set(['planType','price','total','principal','expiryDays','fixedEnd','validityMode','purchaseDays','coverage','restrictions','schedule','reservation']);
  const others=['merchant','title','actualPrice','refund','fee','stacking','bonusCoverage'].filter(key=>g.fields?.[key]?.value?.trim()&&!shown.has(key));
  const unknown=others.map(key=>{
    const field=g.fields[key];
    const candidates=renderedFacts.filter(item=>item.field===key);
    const [label,tone]=fieldBadge(field,T.describeField(key,field,candidates));
    const chip=el('button');chip.type='button';chip.className='review-chip';chip.onclick=()=>jumpField(key,true);
    const badge=el('small',label);badge.className='badge';badge.dataset.tone=tone;
    chip.append(el('span',E.labels[key]),el('strong',truncate(field.value,40)),badge);
    return chip;
  });
  $('reviewUnprovided').hidden=!unknown.length;
  $('unknownCount').textContent=unknown.length+' 项';
  $('unknownChips').replaceChildren(...unknown);
}
function render(){const list=$('groups');list.replaceChildren();groups.forEach(g=>{const b=el('button',g.name+' · '+g.imageIds.length+'张');b.className='secondary';b.setAttribute('aria-pressed',String(g.id===active));b.onclick=()=>{active=g.id;render();};list.append(b)});const g=current();$('empty').hidden=!!g;$('editor').hidden=!g;$('galleryPanel').hidden=!g?.imageIds.length;$('groupPickerTitle').textContent='切换套餐分组 · '+groups.length+' 组';if(!g){$('groupState').textContent='暂无套餐';clearEvidence();return;}
if(!g.imageIds.includes(evidenceImageId)){if(g.imageIds[0])showEvidence(g.imageIds[0],null,false);else clearEvidence();}
const facts=initFields(g);renderedFacts=facts;renderSummary(g);renderReviewHints(g,facts);$('groupName').value=g.name;$('groupConfirmed').checked=!!g.confirmed;$('groupNote').value=g.note||'';$('history').textContent=JSON.stringify(g.history,null,2);
 const gallery=$('gallery');gallery.replaceChildren();for(const id of g.imageIds){const im=images.find(i=>i.id===id);if(!im)continue;const row=el('div');row.className='imageRow';const img=el('img');img.className='thumb';img.src=im.url;img.alt=im.name;const b=el('button',im.name);b.className='secondary';b.onclick=()=>showEvidence(id);row.append(img,b,el('small',im.groupReason||'手动分组'));const move=el('select');const prompt=el('option','移动到其他组 / 拆分');prompt.value='';move.append(prompt);for(const dest of groups.filter(x=>x.id!==g.id)){const o=el('option',dest.name);o.value=dest.id;move.append(o)}const o=el('option','拆为新组');o.value='new';move.append(o);move.onchange=()=>{if(!move.value)return;let target=groups.find(x=>x.id===move.value);if(!target){target={id:'g-'+crypto.randomUUID(),name:im.name,imageIds:[],fields:{},history:[]};groups.push(target)}g.imageIds=g.imageIds.filter(x=>x!==id);target.imageIds.push(id);g.confirmed=target.confirmed=false;for(const obj of [g,target]){for(const f of Object.values(obj.fields||{})){f.evidence=(f.evidence||[]).filter(e=>obj.imageIds.includes(e.imageId));f.status='待核对';}obj.history.push({at:new Date().toISOString(),action:'移动图片，已有字段须重新核对',imageId:id})}mark();render()};row.append(move);gallery.append(row)}
 const fields=$('fields');const previousOpen=[...fields.querySelectorAll(':scope > details[open]')].map(section=>section.dataset.section);fields.replaceChildren();
 const fieldOrder = [...priorityFields, ...Object.keys(E.labels).filter(key => !priorityFields.includes(key))];
 const parents = new Map();
 const grouped = new Set(fieldSections.flatMap(([,keys])=>keys));
 const openSections = new Set(activeFieldGroup===g.id?previousOpen:[]);
 if (activeFieldGroup !== g.id) $('advancedReview').open = false;
 for(const [index,[title,keys]] of [...fieldSections,['条款原文与其他字段',fieldOrder.filter(key=>!grouped.has(key))]].entries()){
   const section=el('details');
   section.dataset.section=title;
   section.open=openSections.has(title);
   section.append(el('summary',title));
   fields.append(section);
   keys.forEach(key=>parents.set(key,section));
 }
 activeFieldGroup=g.id;
 for (const key of fieldOrder) {
   const label = E.labels[key], f = g.fields[key], options = facts.filter(candidate => candidate.field === key);
   const values = [...new Set(options.map(candidate => candidate.value))];
   const row = el('div'); row.className = 'field'; row.id = 'term-' + key;
   const termState = el('span');termState.className='badge';
   const source = el('small');
   const updateTermState = () => {
     const state=T.describeField(key,f,options);
     termState.textContent=T.statusLabels[state];
     termState.dataset.tone=fieldTone[state];
     source.textContent=(f.evidence||[]).some(item=>item.sourceType==='ocr'||item.method==='本地OCR＋规则提取')?'OCR 原图证据':
       f.evidence?.length?'有关联材料或历史审阅':f.value?'用户填写':'暂无已采用来源';
   };
   updateTermState();
   const head=el('div');head.className='field-head';head.append(el('b',label),termState);row.append(head);
   if (values.length > 1) row.append(el('p', T.rawFields.includes(key)
     ? '存在多段候选原文，请对照原图区分条件和适用范围。'
     : '发现 ' + values.length + ' 种候选，请核对各自来源。'));
   const input = T.rawFields.includes(key) ? el('textarea') : el('input');
   input.value = f.value;
   input.setAttribute('aria-label', label);
   input.oninput = () => {
     const before = { value: f.value, evidence: f.evidence || [] };
     f.value = input.value;
     f.evidence = [];
     f.status = '待核对';
     st.value = '待核对';
     linked.replaceChildren();
     updateTermState();
     log(g, key, before, f.value, '手动编辑，旧证据移入历史');
   };
   row.append(input);
 const st=el('select');fieldOptions(st,['待核对','用户核对','试算假设','待商家确认'],f.status);st.setAttribute('aria-label',label+'状态');st.onchange=()=>{const before=f.status;f.status=st.value;updateTermState();log(g,key,before,f.status,'修改确认状态')};const meta=el('div');meta.className='field-meta';meta.append(st,source);row.append(meta);
 const detail=el('details');detail.append(el('summary','候选原文与证据（'+options.length+'条）'));for(const c of options){const p=el('div');p.className='quote';p.append(el('span',c.value+' ｜ '+c.quote));const view=el('button','定位原图');view.className='secondary';view.onclick=()=>showEvidence(c.imageId,c);const use=el('button','采用此候选');use.className='ghost';use.onclick=()=>{const before={value:f.value,evidence:f.evidence||[]};f.value=c.value;f.evidence=options.filter(x=>x.value===c.value);f.status='待核对';log(g,key,before,f.value,'采用OCR候选');render();showEvidence(c.imageId,c)};p.append(view,use);detail.append(p)}row.append(detail);
 const linked=el('div');linked.className='linked-evidence';row.append(linked);
 for(const ev of f.evidence||[]){const b=el('button','已关联证据：'+(images.find(i=>i.id===ev.imageId)?.name||ev.imageId));b.className='secondary';b.onclick=()=>showEvidence(ev.imageId,ev);linked.append(b)}
 const attach=el('select');const ph=el('option','为手工字段关联本组原图（可选）');ph.value='';attach.append(ph);for(const id of g.imageIds){const o=el('option',images.find(i=>i.id===id)?.name||id);o.value=id;attach.append(o)}attach.onchange=()=>{if(!attach.value)return;const ev={imageId:attach.value,quote:'用户手动关联整张原图；未提供精确文字位置',sourceType:'manual',method:'手动关联'};f.evidence||=[];f.evidence.push(ev);log(g,key,null,ev,'补充原图来源');render()};row.append(attach);parents.get(key).append(row)}
}
const aiTypeNames={stored_value:'储值',visit_pack:'次数',time_pass:'期限',time_pack:'时长',unknown:'待核对'};
function aiPrice(value){if(value==null||value==='')return '待核对';const raw=String(value).replace(/[¥￥元,\s]/g,'');const number=Number(raw);return Number.isFinite(number)?'¥'+number.toFixed(2):'¥'+String(value);}
function aiValidity(value){if(!value||value.kind==='unknown')return '待核对';if(value.kind==='fixed')return (value.startDate?value.startDate+' 至 ':'截至 ')+value.endDate;if(value.kind==='from_activation')return '生效后 '+value.days+' 天';if(value.kind==='unlimited')return '无固定截止';return '待核对';}
function aiCoverage(value){if(!value||value.kind==='unknown')return '待核对';if(value.kind==='all')return '全部服务';if(value.kind==='none')return '不适用';if(value.kind==='services')return value.serviceIds.join('、');return '待核对';}
function aiTarget(key,fields){if(key==='units')return 'total';if(key==='redemption')return 'unit';if(key==='validity'){const kind=fields.validity?.value?.kind;return kind==='fixed'?'fixedEnd':kind==='from_activation'?'expiryDays':kind==='unlimited'?'validityMode':'expiryDays';}return key;}
function aiCandidateList(result,key){
  const candidates=result.candidates||[];
  if(key==='validity'){
    const kind=result.fields?.validity?.value?.kind;
    const order=kind==='fixed'?['fixedStart','fixedEnd']:kind==='from_activation'?['expiryDays']:kind==='unlimited'?['validityMode']:['fixedEnd','expiryDays','validityMode'];
    return order.flatMap(field=>candidates.filter(item=>item.field===field&&item.quote&&item.confidence>=0.6));
  }
  return candidates.filter(item=>item.field===key&&item.quote&&item.confidence>=0.6);
}
function aiAdopt(g,result,key){
  const candidates=aiCandidateList(result,key);
  if(!candidates.length)return 0;
  let changed=0;
  for(const candidate of candidates){
    const field=g.fields?.[candidate.field];
    if(!field||field.status!=='待核对'||String(field.value??'').trim())continue;
    const before={value:field.value,status:field.status,evidence:field.evidence||[]};
    field.value=candidate.value;
    field.status='待核对';
    field.evidence=[{...candidate,sourceType:'ai',method:'AI 草稿'}];
    log(g,candidate.field,before,field.value,'采用 AI 草稿');
    changed++;
  }
  if(changed){mark();render();jumpField(candidates[0].field,true)}
  return changed;
}
function aiConfirmable(g,result){
  const seen=new Set();
  for(const candidate of (result.candidates||[])){
    if(!candidate.quote||candidate.confidence<0.6||seen.has(candidate.field))continue;
    const field=g.fields?.[candidate.field];
    if(!field)continue;
    const state=T.describeField(candidate.field,field,renderedFacts.filter(item=>item.field===candidate.field));
    if(state==='conflicting')continue;
    const value=String(field.value??'').trim();
    if(value&&value!==String(candidate.value).trim())continue;
    seen.add(candidate.field);
  }
  for(const [key,field] of Object.entries(g.fields||{})){
    if(seen.has(key)||field?.status==='用户核对'||!String(field?.value??'').trim())continue;
    const state=T.describeField(key,field,renderedFacts.filter(item=>item.field===key));
    if(state==='conflicting'||state==='missing')continue;
    seen.add(key);
  }
  return seen.size;
}
function aiAdoptAll(g,result,confirm=true){
  const seen=new Set();const changed=[];
  const record=(key,field,action)=>{
    g.history.push({at:new Date().toISOString(),field:key,
      before:{value:field.value,status:field.status,evidence:field.evidence||[]},
      after:{value:field.value,status:field.status},action});
    changed.push(key);
  };
  for(const candidate of (result.candidates||[])){
    if(!candidate.quote||candidate.confidence<0.6||seen.has(candidate.field))continue;
    const field=g.fields?.[candidate.field];
    if(!field)continue;
    const state=T.describeField(candidate.field,field,renderedFacts.filter(item=>item.field===candidate.field));
    if(state==='conflicting')continue;
    const value=String(field.value??'').trim();
    if(value&&value!==String(candidate.value).trim())continue;
    if(field.status==='用户核对'&&value===String(candidate.value).trim()){seen.add(candidate.field);continue}
    field.value=candidate.value;
    field.status=confirm?'用户核对':'待核对';
    field.evidence=[{...candidate,sourceType:'ai',method:confirm?'AI 整理并由用户一次性确认':'AI 草稿'}];
    record(candidate.field,field,confirm?'采用 AI 整理并确认':'采用 AI 草稿');
    seen.add(candidate.field);
  }
  if(confirm){
    for(const [key,field] of Object.entries(g.fields||{})){
      if(seen.has(key)||field?.status==='用户核对'||!String(field?.value??'').trim())continue;
      const state=T.describeField(key,field,renderedFacts.filter(item=>item.field===key));
      if(state==='conflicting'||state==='missing')continue;
      const before=field.status;
      field.status='用户核对';
      g.history.push({at:new Date().toISOString(),field:key,
        before:{value:field.value,status:before},after:{value:field.value,status:'用户核对'},
        action:'采用 AI 整理并确认'});
      changed.push(key);
    }
  }
  if(changed.length){mark();render()}
  return changed.length;
}
function aiFillEmpty(g,result){
  const seen=new Set();let changed=0;
  for(const candidate of (result.candidates||[])){
    if(!candidate.quote||candidate.confidence<0.6||seen.has(candidate.field))continue;
    seen.add(candidate.field);
    const field=g.fields?.[candidate.field];
    if(!field||field.status!=='待核对'||String(field.value??'').trim())continue;
    const before={value:field.value,status:field.status,evidence:field.evidence||[]};
    field.value=candidate.value;
    field.status='待核对';
    field.evidence=[{...candidate,sourceType:'ai',method:'AI 草稿'}];
    log(g,candidate.field,before,field.value,'AI 回填未知项');
    changed++;
  }
  if(changed){mark();render()}
  return changed;
}
function renderAiSummary(result,g){
  const fields=result.fields||{};
  const rows=[];
  const add=(label,value,key)=>{if(value!=null&&value!=='')rows.push({label:label,value:String(value),key:key})};
  const type=fields.planType?.value;
  const units=fields.units?.value;
  add('套餐名称',fields.name?.value,'title');
  add('商家',fields.merchant?.value,'merchant');
  add('套餐类型',aiTypeNames[type]||'待核对','planType');
  add('页面价格',aiPrice(fields.priceYuan?.value),'price');
  add('权益数量',type==='time_pack'&&Number.isFinite(units)?(units%60===0?units/60+' 小时':units+' 分钟'):units!=null?units+' 次':'待核对','total');
  add('核销方式',{per_day:'同一自然日只扣一次',per_visit:'每次到访扣一次'}[fields.redemption?.value]||'待核对','unit');
  add('有效期',aiValidity(fields.validity?.value),'validity');
  add('适用范围',aiCoverage(fields.coverage?.value),'coverage');
  add('主要限制',fields.restrictions?.length?fields.restrictions.map(item=>item.text).join('；').slice(0,180):'未识别',null);
  $('aiFields').replaceChildren(...rows.map(row=>{
    const line=el('div');line.className='ai-field';
    line.append(el('strong',row.label),el('span',row.value));
    if(row.key){
      const candidates=aiCandidateList(result,row.key);
      const adoptable=candidates.some(item=>{const field=g.fields?.[item.field];return field&&field.status==='待核对'&&!String(field.value??'').trim()});
      if(adoptable){
        const button=el('button','采用');button.className='secondary';button.type='button';
        button.onclick=()=>{const changed=aiAdopt(g,result,row.key);if(changed){$('aiDialog').close();status('已采用 AI 草稿 '+changed+' 项，仍需核对。')}};
        line.append(button);
      }
    }
    return line;
  }));
  const fillable=new Map();
  for(const candidate of (result.candidates||[])){
    const field=g.fields?.[candidate.field];
    if(candidate.quote&&candidate.confidence>=0.6&&field&&field.status==='待核对'&&!String(field.value??'').trim())fillable.set(candidate.field,candidate);
  }
  const confirmable=aiConfirmable(g,result);
  const fillButtons=[];
  if(confirmable){
    const button=el('button','采用全部并确认（'+confirmable+'）');button.className='secondary';button.type='button';
    button.onclick=()=>{const changed=aiAdoptAll(g,result,true);if(changed){$('aiDialog').close();status('已采用并确认 '+changed+' 项，可检查关键信息后继续分析。')}};
    fillButtons.push(button);
  }
  if(fillable.size){
    const button=el('button','仅填入未知项（'+fillable.size+'）');button.className='ghost';button.type='button';
    button.onclick=()=>{const changed=aiFillEmpty(g,result);if(changed){$('aiDialog').close();status('已回填 '+changed+' 个未知项，仍需核对。')}};
    fillButtons.push(button);
  }
  $('aiFill').replaceChildren(...fillButtons);
  const meta=[];
  const deep=result.mode==='deepseek'&&!result.fallback;
  const mode=el('span',deep?'DeepSeek 文本整理':'本地规则整理');mode.className='badge';mode.dataset.tone=deep?'success':result.fallback?'warning':'neutral';meta.push(mode);
  if(result.redactions?.total){const redacted=el('span','已脱敏 '+result.redactions.total+' 处');redacted.className='badge';redacted.dataset.tone='info';meta.push(redacted);}
  if(result.fallback){const fallback=el('span','API 未成功，已回退');fallback.className='badge';fallback.dataset.tone='warning';meta.push(fallback);}
  const requested=useDeepSeek();
  if(requested&&!deep){
    const stale=el('span','服务端未加载 DeepSeek 路由，请重启服务');stale.className='badge';stale.dataset.tone='warning';meta.push(stale);
  }
  const source=el('small','基于本组 '+(result.source?.imageIds?.length||0)+' 张截图');source.className='muted';
  $('aiMeta').replaceChildren(...meta,source);
  $('aiStatus').dataset.state=result.fallback?'warning':'success';
  $('aiStatus').textContent=result.fallback?'DeepSeek 未成功，已用本地规则整理。':deep?'DeepSeek 已完成文本提取。':
    requested?'已勾选 DeepSeek，但服务端仍返回本地规则。请重启服务后再试。':'本地规则整理，未调用外部 API。';
  const questions=(result.questions||[]).slice(0,4);
  if(questions.length){
    $('aiQuestions').replaceChildren(...questions.map(question=>{
      const box=el('div');box.className='ai-question';
      box.append(el('strong',question.title),el('p',question.text));
      const button=el('button','去核对');button.className='secondary';button.type='button';
      button.onclick=()=>{$('aiDialog').close();jumpField(aiTarget(question.key,fields),true)};
      box.append(button);
      return box;
    }));
  }else $('aiQuestions').replaceChildren(el('p','没有发现必须确认的关键项。','muted'));
  const candidate=(result.candidates||[]).find(item=>item.imageId&&item.lineId!=null);
  const evidenceImage=candidate?images.find(image=>image.id===candidate.imageId):null;
  const line=candidate&&evidenceImage?evidenceImage.ocr.lines.find(item=>item.id===candidate.lineId):null;
  if(line){
    const button=el('button','查看原文位置');button.className='secondary';button.type='button';
    button.onclick=()=>{$('aiDialog').close();showEvidence(evidenceImage.id,{...line,quote:candidate.quote||line.text})};
    $('aiEvidence').replaceChildren(button);
  }else $('aiEvidence').replaceChildren();
}
async function save(){await api('/api/project',{version:1,groups});dirty=false;status('已保存到本机。原图与OCR结果同步保留。');}
async function recognizePending(){for(const im of images.filter(i=>!i.ocr)){status('正在识别：'+im.name);try{im.ocr=await api('/api/ocr',{id:im.id});delete im.error}catch(e){im.error=e.message;status(im.name+'：'+e.message)}}}
async function task(fn){if(busy)return;busy=true;$('editor').inert=$('groups').inert=true;for(const id of ['upload','retry','suggest','save','aiSummarize','toDecision','exportGroup'])$(id).disabled=true;try{await fn()}catch(e){status('操作失败：'+e.message)}finally{busy=false;$('editor').inert=$('groups').inert=false;for(const id of ['upload','retry','suggest','save','aiSummarize','toDecision','exportGroup'])$(id).disabled=false;}}
$('files').addEventListener('change',()=>{
  const count=$('files').files.length;
  $('uploadHint').hidden=!count;
  $('uploadHint').dataset.state=count?'success':'error';
  $('uploadHint').textContent=count?'已选择 '+count+' 张截图，点击「上传并识别」。':'请先选择截图。';
});
$('upload').onclick=()=>{
  const files=[...$('files').files];
  if(!files.length){
    $('uploadHint').hidden=false;
    $('uploadHint').dataset.state='error';
    $('uploadHint').textContent='请先选择截图，再点「上传并识别」。';
    $('files').click();
    return;
  }
  task(async()=>{
    $('uploadHint').hidden=false;
    $('uploadHint').dataset.state='loading';
    $('uploadHint').textContent='正在上传并识别 '+files.length+' 张截图…';
    try{
      const uploadedIds=[];
      for(const file of files){
        if(file.size>12*1024*1024)throw Error(file.name+'超过12MB');
        status('保存原图：'+file.name);
        const base64=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=reject;r.readAsDataURL(file)});
        const im=await api('/api/upload',{name:file.name,base64});
        if(!images.some(i=>i.id===im.id))images.push(im);
        if(!uploadedIds.includes(im.id))uploadedIds.push(im.id);
      }
      await recognizePending();
      const assigned=new Set(groups.flatMap(g=>g.imageIds));
      const fresh=images.filter(i=>!assigned.has(i.id));
      const added=E.suggestGroups(fresh);
      groups.push(...added);
      const existingGroup=groups.find(g=>uploadedIds.some(id=>g.imageIds.includes(id)));
      active=added[0]?.id||existingGroup?.id||active||groups[0]?.id;
      render();
      await save();
      const addedCount=added.reduce((sum,g)=>sum+g.imageIds.filter(id=>uploadedIds.includes(id)).length,0);
      const duplicateCount=Math.max(0,uploadedIds.length-addedCount);
      const failed=images.filter(i=>uploadedIds.includes(i.id)&&!i.ocr).length;
      const parts=[];
      if(addedCount)parts.push('新增 '+addedCount+' 张');
      if(duplicateCount)parts.push(duplicateCount+' 张已在项目中');
      if(!parts.length)parts.push('没有新增图片');
      $('uploadHint').dataset.state=failed?'warning':'success';
      $('uploadHint').textContent='上传完成：'+parts.join('，')+'。';
      status('上传完成：'+parts.join('，')+'。'+(added.length?'新建 '+added.length+' 组。':'已切换到对应分组。')+(failed?failed+'张识别失败，可重试。':'全部识别完成。')+'请核对归组与字段。');
      $('files').value='';
    }catch(error){
      $('uploadHint').hidden=false;
      $('uploadHint').dataset.state='error';
      $('uploadHint').textContent='上传失败：'+error.message;
      throw error;
    }
  });
};
$('retry').onclick=()=>task(async()=>{await recognizePending();render();await save();status('识别完成，失败'+images.filter(i=>!i.ocr).length+'张。新候选可在字段下查看，已有编辑不覆盖。')});
$('suggest').onclick=()=>task(async()=>{if(groups.length&&!confirm('重新归组将重建字段表单。原图与OCR仍保留，但手工字段修改将被替换。确定继续？'))return;groups=E.suggestGroups(images);active=groups[0]?.id;render();mark()});
$('save').onclick=()=>task(save);$('backEditor').onclick=()=>$('reviewSummary').scrollIntoView({block:'start'});
$('aiSummarize').onclick=()=>{
  if(busy)return;
  const g=current();
  const imageIds=g?g.imageIds.filter(id=>images.find(image=>image.id===id)?.ocr?.lines?.length):[];
  $('aiStatus').dataset.state='loading';
  $('aiStatus').textContent='正在整理本组截图…';
  for(const id of ['aiMeta','aiFields','aiQuestions','aiEvidence','aiFill'])$(id).replaceChildren();
  $('aiDialog').showModal();
  if(!g){$('aiStatus').dataset.state='error';$('aiStatus').textContent='请先选择套餐分组。';return}
  if(!imageIds.length){$('aiStatus').dataset.state='error';$('aiStatus').textContent='本组还没有可用的 OCR 文本。';return}
  task(async()=>{
    try{
      const result=await api('/api/ai/extract',{imageIds,useDeepSeek:useDeepSeek()});
      renderAiSummary(result,g);
    }catch(error){
      $('aiStatus').dataset.state='error';
      $('aiStatus').textContent='AI 整理失败：'+error.message;
    }
  });
};
for(const id of ['aiClose','aiCloseBottom'])$(id).onclick=()=>$('aiDialog').close();
(async()=>{try{const {deepseek}=await api('/api/agent/capabilities');if(!deepseek)return;const box=$('aiDeepSeek');box.disabled=false;$('aiModel').hidden=false;try{box.checked=localStorage.getItem(modelPreferenceKey)==='true'}catch{};box.addEventListener('change',()=>{try{localStorage.setItem(modelPreferenceKey,String(box.checked))}catch{}})}catch{}})();
$('newGroup').onclick=()=>{const g={id:'g-'+crypto.randomUUID(),name:'新商品组',imageIds:[],fields:{},history:[]};groups.push(g);active=g.id;mark();render()};
$('groupName').onchange=()=>{current().name=$('groupName').value;mark();render()};$('groupConfirmed').onchange=()=>{current().confirmed=$('groupConfirmed').checked;mark()};$('groupNote').onchange=()=>{current().note=$('groupNote').value;mark()};
$('confirmAll').onclick=()=>{
  const g=current();if(!g)return;
  const keys=[...new Set(['planType','price','unit','total','principal','bonus','coverage','expiryDays','fixedEnd','validityMode','purchaseDays','restrictions','schedule','reservation'])];
  let changed=0;
  for(const key of keys)if(confirmField(key,g))changed++;
  if(changed){mark();render();status('已按截图确认 '+changed+' 项；冲突项保留待核对。');}
  else status('当前没有可按截图确认的内容，请在下方逐项核对。');
};
$('toDecision').onclick=()=>task(async()=>{
  const g=current();
  $('reviewError').hidden=true;
  if(g.fields?.planType?.value==='时长'){
    $('reviewError').hidden=false;
    $('reviewError').textContent='单套餐分析暂不支持时长卡，请从工作台进入「比较几个买法」。';
    return;
  }
  const missing=blockingKeys(g);
  if(missing.length){
    const labels=missing.map(key=>key==='__group'?'勾选「以上截图属于同一套餐」':E.labels[key]);
    $('reviewError').hidden=false;
    $('reviewError').textContent='还差：'+labels.join('、')+'。请在上面确认，或在「全部字段」中修改。';
    const first=missing.find(key=>key!=='__group');
    if(first)jumpField(first,true);else $('groupConfirmed').focus();
    return;
  }
  await save();
  location.href='analyze.html?'+new URLSearchParams({group:g.id});
});
$('exportGroup').onclick=()=>task(async()=>{const g=current();const originals=[];for(const id of g.imageIds){const im=images.find(i=>i.id===id),blob=await(await fetch(im.url)).blob();const data=await new Promise(resolve=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.readAsDataURL(blob)});originals.push({...im,dataUrl:data})}const link=el('a');link.href=URL.createObjectURL(new Blob([JSON.stringify({version:1,group:g,images:originals},null,2)],{type:'application/json'}));link.download='Vericard-商品证据包.json';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);status('已导出本组字段、修改记录、OCR及原图。')});
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue=''}});
(async()=>{try{const data=await api('/api/state');images=data.images;groups=data.project?.groups||[];if(!groups.length&&images.length)groups=E.suggestGroups(images);active=groups.find(group=>group.id===params.get('group'))?.id||groups[0]?.id;render();
const key=params.get('field');
const field=key&&Object.hasOwn(E.labels,key)?current()?.fields?.[key]:null;
const evidence=(field?.evidence||[]).find(item=>current().imageIds.includes(item.imageId)) ||
  (field&&E.candidates(current(),images).find(item=>item.field===key));
if(evidence)showEvidence(evidence.imageId,evidence,false);
else if(current()?.imageIds[0])showEvidence(current().imageIds[0],null,false);
if(field)jumpField(key);const g=current();status(g?'当前：'+g.name+' · '+g.imageIds.length+' 张截图。':'尚未选择套餐。')}catch(e){status('请通过本地服务打开此页面：在项目目录运行node server.js，再访问http://127.0.0.1:8765/。'+e.message)}})();
