'use strict';
// 跨平台 OCR 适配器：Tesseract.js（Linux 容器），输出契约与 ocr.ps1 对齐
// {width,height,engine,lines:[{id,text,box:{x,y,width,height}}]}
const fs = require('node:fs');
const path = require('node:path');

// tesseract.js v6 不再返回图片尺寸，这里直接读文件头（PNG/JPEG），避免引入额外依赖
function imageSize(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch (_) { /* 读不到尺寸时降级为 null，前端会退化布局 */ }
  return { width: null, height: null };
}

async function ocrTesseract(imagePath) {
  const { createWorker } = require('tesseract.js');
  const worker = await createWorker('chi_sim+eng', 1, {
    langPath: path.join(__dirname, 'data', 'ocr-models'),
    cacheMethod: 'none',
    gzip: false,
  });
  try {
    // v6：行级数据来自 blocks，必须在 output 里显式打开
    const { data } = await worker.recognize(imagePath, {}, { text: true, blocks: true });
    const lines = [];
    for (const block of data.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          const text = (line.text || '').trim();
          if (!text) continue;
          lines.push({
            id: lines.length,
            text,
            box: {
              x: Math.round(line.bbox.x0),
              y: Math.round(line.bbox.y0),
              width: Math.round(line.bbox.x1 - line.bbox.x0),
              height: Math.round(line.bbox.y1 - line.bbox.y0),
            },
          });
        }
      }
    }
    const size = imageSize(imagePath);
    return { width: size.width, height: size.height, engine: 'tesseract.js chi_sim+eng', lines };
  } finally {
    await worker.terminate();
  }
}

module.exports = { ocrTesseract, imageSize };