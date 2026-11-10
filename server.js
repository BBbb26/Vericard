'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const { reviewGroup } = require('./plan-review');
const { analyzeWorkbench, demoReview } = require('./decision-workbench');
const { createWallet, fingerprint, WalletError } = require('./wallet');
const { saveWalletProof } = require('./wallet-proof');
const { extractPackage } = require('./ai-extract');
const { createAgent } = require('./agent/agent');
const { selectTopics, interpretArrival, polishMerchantQuestions } = require('./agent/questions');
const { AgentError } = require('./agent/session');
const { createIssueHistory } = require('./agent/issue-history');
const { RULES } = require('./rules/general');
const Compare = require('./comparison');
const Issues = require('./agent-issues');
const { ocrTesseract } = require('./ocr-tesseract');
const ROOT=__dirname,DATA=path.join(ROOT,'data'),IMAGES=path.join(DATA,'images'),OCR=path.join(DATA,'ocr');
for(const d of [DATA,IMAGES,OCR])fs.mkdirSync(d,{recursive:true});
const readJson=(p,fallback)=>{try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return fallback}};
function save(p,data){fs.writeFileSync(p+'.tmp',JSON.stringify(data,null,2));fs.renameSync(p+'.tmp',p)}
let registry=readJson(path.join(DATA,'images.json'),[]);let queue=Promise.resolve();
function ocr(id){const im=registry.find(i=>i.id===id);if(!im)throw Error('图片不存在');const cached=readJson(path.join(OCR,id+'.json'),null);if(cached)return Promise.resolve(cached);
 const imagePath=path.join(IMAGES,im.file);
 if(process.platform!=='win32'){return ocrTesseract(imagePath).then(data=>{save(path.join(OCR,id+'.json'),data);return data}).catch(e=>{throw Error('OCR失败（tesseract.js）：'+(e?.message||e))});}
 return new Promise((resolve,reject)=>{const proc=spawn('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(ROOT,'ocr.ps1'),'-ImagePath',imagePath],{windowsHide:true});let stdout='',stderr='';const timeout=setTimeout(()=>proc.kill(),60000);proc.stdout.on('data',d=>stdout+=d);proc.stderr.on('data',d=>stderr+=d);proc.on('error',e=>{clearTimeout(timeout);reject(e)});proc.on('close',code=>{clearTimeout(timeout);if(code!==0)return reject(Error('OCR失败；请确认Windows中文OCR及脚本运行权限。'+stderr.slice(0,200)));try{const data=JSON.parse(stdout.replace(/^\uFEFF/,''));save(path.join(OCR,id+'.json'),data);resolve(data)}catch{reject(Error('OCR返回无效数据'))}})});
}
function getImages(ids=null){return registry.filter(im=>!ids||ids.has(im.id)).map(im=>({...im,url:'/images/'+im.file,ocr:readJson(path.join(OCR,im.id+'.json'),null)}))}
function body(req){return new Promise((resolve,reject)=>{let parts=[],n=0;req.on('data',d=>{n+=d.length;if(n>18*1024*1024){reject(Error('单次请求超过18MB'));req.destroy()}else parts.push(d)});req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(parts).toString('utf8')))}catch{reject(Error('无效JSON'))}})})}
function upload(name,encoded){const buffer=Buffer.from(encoded||'','base64');if(buffer.length>12*1024*1024||buffer.length<16)throw Error('每张图片须小于12MB');const png=buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpg=buffer[0]===255&&buffer[1]===216;if(!png&&!jpg)throw Error('仅支持PNG/JPEG');const id=crypto.createHash('sha256').update(buffer).digest('hex');let im=registry.find(i=>i.id===id);if(!im){im={id,name:String(name||'image').slice(0,200),file:id+(png?'.png':'.jpg')};fs.writeFileSync(path.join(IMAGES,im.file),buffer);registry.push(im);save(path.join(DATA,'images.json'),registry)}return {...im,url:'/images/'+im.file,ocr:readJson(path.join(OCR,id+'.json'),null)}}
const allowed=['index.html','core.js','extract.html','extract.js','extract-ui.js','offer-terms.js','decision.html','decision-ui.js','decision.css','wallet.html','wallet-ui.js','wallet-client.js','purchase-ui.js','wallet-p1-ui.js','design-system.css','app-shell.js','decision-dashboard.css','decision-chart.js','app-pages.css','home.html','home-ui.js','recent-analysis.js','comparison.html','comparison.css','comparison.js','comparison-ui.js','wallet-dashboard.js','wallet-charts.js','wallet-enroll-ui.js','wallet-dashboard.css','agent.html','agent-ui.js','agent.css','agent-issues.js','agent-issue-ui.js','assets/home-threads.js','assets/home-threads.css','analyze.html','analyze.js','analyze.css'];
const wallet = createWallet(path.join(DATA, 'wallet.json'));
const issueHistory = createIssueHistory(path.join(DATA, 'agent-issues.json'), save);
const proofDirectory = path.join(DATA, 'wallet-proof');

function queueOcr(id) {
  const work = queue.then(() => ocr(id));
  queue = work.catch(() => {});
  return work;
}

function registeredImage(id) {
  const image = getImages(new Set([id]))[0];
  if (!image) throw new AgentError('图片不存在。', 404);
  return image;
}

function extractImages(images, options) {
  let lineId = 0;
  const lines = images.flatMap(image => (image.ocr?.lines ?? []).map(line =>
    ({ id: lineId++, text: line.text, box: line.box, imageId: image.id })));
  const imageIds = images.map(image => image.id);
  return extractPackage({ lines, imageIds, imageId: imageIds[0] }, options);
}
function loadGroup(id) {
  const group = readJson(path.join(DATA, 'project.json'), null)?.groups?.find(item => item.id === id);
  if (!group) throw new WalletError('找不到该套餐分组，请返回截图工作台重新选择。', 404);
  return group;
}
function loadGroupReview(id) {
  const group = loadGroup(id);
  return reviewGroup(group, getImages(new Set(group.imageIds)));
}
function previewGroupReview(id, fields) {
  const group = loadGroup(id);
  const merged = { ...group, confirmed: true, fields: { ...group.fields } };
  for (const [key, value] of Object.entries(fields || {}).slice(0, 80)) {
    if (!['string', 'number'].includes(typeof value)) continue;
    merged.fields[key] = { ...(merged.fields[key] || {}), value: String(value).slice(0, 2000), status: '用户核对' };
  }
  return reviewGroup(merged, getImages(new Set(group.imageIds)));
}
function createServer(port=8765){
 const agent = createAgent({
   readImage: registeredImage,
   recognize: queueOcr,
   extract: (images, useDeepSeek) => extractImages(images, {
     mode: useDeepSeek ? 'deepseek' : 'mock',
     structured: useDeepSeek,
   }),
   selectTopics,
 });
 return http.createServer(async(req,res)=>{const send=(code,obj)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj))};try{
 const isPublic=process.env.KDZ_PUBLIC==='1';
 if(!isPublic){const host=`127.0.0.1:${port}`;if(req.headers.host!==host)return send(403,{error:'仅接受本机127.0.0.1访问'});const origin='http://'+host;
 if(req.headers.origin&&req.headers.origin!==origin)return send(403,{error:'拒绝跨站请求'});
 if(req.method==='POST'&&req.headers['x-kdz-local']!=='1')return send(403,{error:'缺少本地请求标记'})}
 const url=new URL(req.url,'http://'+(req.headers.host||`127.0.0.1:${port}`));
 if(req.method==='GET'&&url.pathname==='/api/state')return send(200,{images:getImages(),project:readJson(path.join(DATA,'project.json'),null)});
 if(req.method==='POST'&&url.pathname==='/api/upload'){const data=await body(req);return send(200,upload(data.name,data.base64))}
 if(req.method==='POST'&&url.pathname==='/api/ocr'){const data=await body(req);return send(200,await queueOcr(data.id))}
 if(req.method==='POST'&&url.pathname==='/api/ai/extract'){
   const input=await body(req);
   const options=input.useDeepSeek===true?{mode:'deepseek',structured:true}:undefined;
   const imageIds=Array.isArray(input.imageIds)?[...new Set(input.imageIds.filter(id=>typeof id==='string'))].slice(0,8):input.imageId?[input.imageId]:[];
   if(imageIds.length){
     const images=[];
     for(const id of imageIds) images.push({ id, ocr:await queueOcr(id) });
     return send(200,await extractImages(images,options));
   }
   if(typeof input.text!=='string')throw Error('请提供 imageId、imageIds 或 text');
   if(input.text.length>50000)throw Error('OCR 文本过长');
   return send(200,await extractPackage({text:input.text},options));
 }
 if(req.method==='GET'&&url.pathname==='/api/agent/capabilities')return send(200,{deepseek:Boolean(process.env.DEEPSEEK_API_KEY?.trim())});
 if(req.method==='POST'&&url.pathname==='/api/comparison/arrival'){
   const { question, history = [], useDeepSeek } = (await body(req)) ?? {};
   const valid = value => typeof value === 'string' && value.trim() && value.length <= 480;
   if(!valid(question) || !Array.isArray(history) || history.length > 3 || !history.every(valid)){
     return send(400,{error:'问题或上下文格式不正确。'});
   }
   const previous = history.reduce((plan, text) => Compare.parseArrivalQuestion(text, plan) ?? plan, {});
   const local = Compare.parseArrivalQuestion(question, previous);
   if(useDeepSeek !== true) return send(200,{provider:'local',candidate:local});
   try {
     const candidate = await interpretArrival(question, history);
     return send(200,{provider:candidate ? 'deepseek' : 'fallback',candidate:candidate ?? local});
   } catch {
     return send(200,{provider:'fallback',candidate:local});
   }
 }
 if(req.method==='POST'&&url.pathname==='/api/comparison/merchant-polish'){
   const { questions } = (await body(req)) ?? {};
   if(!Array.isArray(questions) || !questions.length || questions.length > 40 ||
      !questions.every(question => typeof question === 'string' && question.trim() && question.length <= 240)){
     return send(400,{error:'请选择要润色的商家问题。'});
   }
   try {
     return send(200,{provider:'deepseek',questions:await polishMerchantQuestions(questions)});
   } catch {
     return send(200,{provider:'fallback',questions:null});
   }
 }
 if(req.method==='POST'&&url.pathname==='/api/agent/sessions')return send(201,await agent.create(await body(req)));
 if(req.method==='POST'&&url.pathname==='/api/agent/decision')return send(200,agent.decision(await body(req)));
 const sessionRoute=/^\/api\/agent\/sessions\/([a-f0-9-]{36})(\/retry|\/ask|\/comparison|\/issues)?$/.exec(url.pathname);
 if(sessionRoute){
   const [,id,operation]=sessionRoute;
   if(req.method==='GET'&&!operation)return send(200,agent.read(id));
   if(req.method==='POST'&&operation==='/retry')return send(200,await agent.retry(id,await body(req)));
   if(req.method==='POST'&&operation==='/ask')return send(200,await agent.ask(id,await body(req)));
   if(req.method==='POST'&&operation==='/issues'){
     const session=agent.read(id);
     if(session.source!=='agent'||!session.review)throw new AgentError('请先识别实际套餐的截图。',409);
     const input=await body(req);
     const byId=new Map(getImages(new Set(session.images.map(image=>image.id))).map(image=>[image.id,image]));
     const images=session.images.map(image=>byId.get(image.id)).filter(Boolean);
     const offers=Compare.groupPackages(images).groups.map(Compare.packageSummary);
     const issues=Issues.catalog(offers);
     const packageIds=new Set(offers.map(offer=>offer.packageId));
     const history=issueHistory.update(id,issues,packageIds,input);
     const ruleIds=new Set(issues.flatMap(issue=>issue.ruleIds));
     const rules=RULES.filter(rule=>ruleIds.has(rule.id)).map(({id,title,summary,version})=>({id,title,summary,version}));
     return send(200,{issues,history,rules});
   }
   if(req.method==='GET'&&operation==='/comparison'){
     const session=agent.read(id);
     if(session.source!=='agent'||!session.review)throw new AgentError('请先识别实际套餐的截图。',409);
     const images=getImages(new Set(session.images.map(image=>image.id)));
     return send(200,{ name:session.review.name, images });
   }
 }
 if(req.method==='POST'&&url.pathname==='/api/project'){const p=await body(req);if(!Array.isArray(p.groups)||p.groups.length>1000)throw Error('项目格式不正确');const known=new Set(registry.map(i=>i.id));for(const g of p.groups)if(!Array.isArray(g.imageIds)||g.imageIds.some(id=>!known.has(id)))throw Error('分组包含未知图片');save(path.join(DATA,'project.json'),p);return send(200,{saved:true})}
 if(req.method==='POST'&&url.pathname==='/api/decision'){
   const input=await body(req);
   const review=input.groupId
     ? (input.previewFields && typeof input.previewFields==='object' ? previewGroupReview(input.groupId,input.previewFields) : loadGroupReview(input.groupId))
     : demoReview(input.demoId);
   return send(200,{...analyzeWorkbench(review,input),reviewTag:review.demo ? null : fingerprint(review)});
 }
 if(req.method==='GET'&&url.pathname==='/api/wallet') return send(200,wallet.list());
 if(req.method==='GET'&&url.pathname==='/api/wallet/activity'){
   if(!url.searchParams.has('offset')) return send(200,{events:wallet.activity()});
   const offset=Number(url.searchParams.get('offset'));
   if(!Number.isSafeInteger(offset)||offset<0) return send(400,{error:'流水分页无效。'});
   const size=20, events=wallet.activity(offset,size+1);
   return send(200,{events:events.slice(0,size),nextOffset:events.length>size?offset+size:null});
 }
 if(req.method==='POST'&&url.pathname==='/api/wallet/cards'){
   const input=await body(req);
   const result=wallet.create(input,(id,analysisInput)=>{
     const review=loadGroupReview(id);
     return {review,analysis:analyzeWorkbench(review,analysisInput).analysis};
   },getImages,id=>agent.purchase(id));
   if(input.source?.kind==='agent') agent.purchased(input.source.analysisId,result.cardId);
   return send(result.replayed ? 200 : 201,result);
 }
 const sourceRoute=/^\/api\/wallet\/cards\/([a-f0-9-]{36})\/source\/([a-f0-9]{64})$/i.exec(url.pathname);
 if(req.method==='GET' && sourceRoute){
   const [,id,imageId]=sourceRoute;
   const {card}=wallet.get(id);
   const image=card.source?.imageIds?.includes(imageId) && registry.find(item=>item.id===imageId);
   if(!image)return send(404,{error:'未找到这张卡的原图。'});
   const file=path.join(IMAGES,image.file);
   if(!fs.existsSync(file))return send(404,{error:'未找到这张卡的原图。'});
   res.writeHead(200,{'Content-Type':image.file.endsWith('.png')?'image/png':'image/jpeg','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
   return fs.createReadStream(file).pipe(res);
 }
 const cardRoute=/^\/api\/wallet\/cards\/([a-f0-9-]{36})(\/consume|\/events|\/profile)?$/i.exec(url.pathname);
 if(cardRoute){
   const [,id,operation]=cardRoute;
   if(req.method==='GET'&&!operation) return send(200,wallet.get(id));
   if(req.method==='POST'&&operation==='/consume'){
     const result=wallet.consume(id,await body(req),proof=>saveWalletProof(proofDirectory,proof));
     return send(result.replayed ? 200 : 201,result);
   }
   if(req.method==='POST'&&operation==='/profile'){
     return send(201,wallet.update(id,await body(req)));
   }
 }
 if(cardRoute && req.method==='POST' && cardRoute[2]==='/events'){
   const result=wallet.record(cardRoute[1],await body(req),proof=>saveWalletProof(proofDirectory,proof));
   return send(result.replayed ? 200 : 201,result);
 }
 if(req.method==='GET' && /^\/wallet-proof\/[a-f0-9]{64}\.(png|jpg)$/.test(url.pathname)){
   const file=path.join(proofDirectory,path.basename(url.pathname));
   if(fs.existsSync(file)){
     res.writeHead(200,{'Content-Type':file.endsWith('.png')?'image/png':'image/jpeg','X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Cross-Origin-Resource-Policy':'same-origin'});
     return fs.createReadStream(file).pipe(res);
   }
   return send(404,{error:'未找到本机凭证。'});
 }
 if(req.method==='GET'){let file,type;const name=url.pathname==='/'?'agent.html':url.pathname.slice(1);if(allowed.includes(name)){file=path.join(ROOT,name);type=name.endsWith('.html')?'text/html':name.endsWith('.css')?'text/css':'text/javascript'}else if(/^images\/[a-f0-9]{64}\.(png|jpg)$/.test(name)){file=path.join(DATA,name);type=name.endsWith('.png')?'image/png':'image/jpeg'}if(file&&fs.existsSync(file)){res.writeHead(200,{'Content-Type':type+'; charset=utf-8','X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'"});return fs.createReadStream(file).pipe(res)}}
 send(404,{error:'不存在'});
 }catch(e){send(e instanceof WalletError || e instanceof AgentError ? e.status : 400,{error:e.message})}})}
if(require.main===module){const port=Number(process.env.PORT)||8765;const isPublic=process.env.KDZ_PUBLIC==='1';const server=createServer(port);server.on('error',e=>{console.error('启动失败：'+e.message);process.exitCode=1});server.listen(port,isPublic?'0.0.0.0':'127.0.0.1',()=>console.log(`卡得值： http://${isPublic?'0.0.0.0':'127.0.0.1'}:${port}/ （Ctrl+C停止）${isPublic?' [公网模式]':''}`));}
module.exports={createServer,upload,ocr,getImages};
