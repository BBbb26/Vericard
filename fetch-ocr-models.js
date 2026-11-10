'use strict';
// 一次性脚本：把 Tesseract 语言包落盘到 data/ocr-models/（部署前执行，产物随仓库入库）
// 用法：node fetch-ocr-models.js
// 策略：优先从本地 node_modules/@tesseract.js-data 解压（离线可用），失败再走 CDN 下载
const https = require('node:https');
const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');

const DIR = path.join(__dirname, 'data', 'ocr-models');
const LANGS = ['chi_sim', 'eng'];

function fromLocal(lang) {
  const gz = path.join(__dirname, 'node_modules', '@tesseract.js-data', lang,
    '4.0.0_best_int', `${lang}.traineddata.gz`);
  if (!fs.existsSync(gz)) return null;
  const raw = zlib.gunzipSync(fs.readFileSync(gz));
  fs.writeFileSync(path.join(DIR, `${lang}.traineddata`), raw);
  return { raw, source: 'node_modules' };
}

function download(lang) {
  const url = `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`;
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`${lang} HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const raw = zlib.gunzipSync(Buffer.concat(chunks));
          fs.writeFileSync(path.join(DIR, `${lang}.traineddata`), raw);
          resolve({ raw, source: 'cdn.jsdelivr.net' });
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  for (const lang of LANGS) {
    const result = fromLocal(lang) || (await download(lang));
    console.log(`${lang}.traineddata ${(result.raw.length / 1024 / 1024).toFixed(2)}MB  来自 ${result.source}`);
  }
})().catch((e) => { console.error('获取语言包失败：', e.message); process.exit(1); });