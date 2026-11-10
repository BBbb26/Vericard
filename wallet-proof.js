'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { WalletError } = require('./wallet-ledger');

function saveWalletProof(directory, input) {
  if (!input || typeof input.base64 !== 'string' || input.base64.length > 4 * 1024 * 1024 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64)) {
    throw new WalletError('凭证图片只支持 3 MB 以内的 PNG 或 JPEG。');
  }
  const buffer = Buffer.from(input.base64, 'base64');
  const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  if (buffer.length < 16 || !(png || jpg)) throw new WalletError('凭证图片只支持 PNG 或 JPEG。');
  const id = createHash('sha256').update(buffer).digest('hex');
  const filename = id + (png ? '.png' : '.jpg');
  const destination = path.join(directory, filename);
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(destination)) {
    const temporary = destination + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, buffer, { flag: 'wx' });
      fs.renameSync(temporary, destination);
    } finally {
      try { fs.unlinkSync(temporary); }
      catch (error) { if (error.code !== 'ENOENT') console.warn('Wallet proof temporary cleanup failed'); }
    }
  }
  return { id, name: String(input.name || '凭证图片').slice(0, 120), url: '/wallet-proof/' + filename };
}

module.exports = { saveWalletProof };
