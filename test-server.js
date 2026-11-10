'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const base='http://127.0.0.1:8765';let passed=0;
async function test(name,fn){await fn();console.log('PASS '+name);passed++;}
(async()=>{
if (!fs.existsSync(path.join(__dirname,'data','project.json'))) {
  console.log('SKIP 本机接口测试需要隔离的原图、OCR 与项目数据。');
  return;
}
const state=await(await fetch(base+'/api/state')).json();
await test('115张原图均有OCR及可用图片',async()=>{assert.equal(state.images.length,115);for(const im of state.images){assert(im.ocr.lines.length>0);const r=await fetch(base+im.url);assert.equal(r.status,200);assert((await r.arrayBuffer()).byteLength>16);}});
await test('当前33组完整唯一覆盖原图',()=>{const ids=state.project.groups.flatMap(g=>g.imageIds);assert.equal(state.project.groups.length,33);assert.equal(ids.length,115);assert.equal(new Set(ids).size,115);});
await test('重复上传不增加原图',async()=>{const im=state.images[0],base64=fs.readFileSync(path.join(__dirname,'data/images',im.file)).toString('base64');const r=await fetch(base+'/api/upload',{method:'POST',headers:{'Content-Type':'application/json','X-KDZ-Local':'1'},body:JSON.stringify({name:im.name,base64})});assert.equal(r.status,200);assert.equal((await r.json()).id,im.id);assert.equal((await(await fetch(base+'/api/state')).json()).images.length,115);});
await test('OCR缓存保留行位置',async()=>{const r=await fetch(base+'/api/ocr',{method:'POST',headers:{'Content-Type':'application/json','X-KDZ-Local':'1'},body:JSON.stringify({id:state.images[0].id})});const data=await r.json();assert(data.lines[0].box.width>0);});
await test('拒绝未标记的写入',async()=>assert.equal((await fetch(base+'/api/project',{method:'POST',body:'{}'})).status,403));
await test('拒绝其他来源请求',async()=>assert.equal((await fetch(base+'/api/state',{headers:{Origin:'https://example.com'}})).status,403));
await test('不暴露项目文件目录',async()=>assert.equal((await fetch(base+'/data/project.json')).status,404));
await test('保存值历史与证据一致',async()=>{const latest=(await(await fetch(base+'/api/state')).json()).project;const r=await fetch(base+'/api/project',{method:'POST',headers:{'Content-Type':'application/json','X-KDZ-Local':'1'},body:JSON.stringify(latest)});assert.equal(r.status,200);assert.deepEqual((await(await fetch(base+'/api/state')).json()).project,latest);});
console.log(passed+' server tests passed.');
})().catch(e=>{console.error(e);process.exitCode=1});
