'use strict';

const { createHash } = require('node:crypto');
const { createPlan } = require('./model');
const { WalletError } = require('./wallet-ledger');
const { makeOffer } = require('./comparison');
const extract = require('./extract');

const kinds = { stored_value:'stored_value', visits:'visit_pack', period:'time_pass', hours:'time_pack', single:'visit_pack' };

function reviewWalletSource(source, loadImages) {
  if (!['manual','comparison'].includes(source?.kind)) throw new WalletError('请选择卡片来源。');
  if (!Object.hasOwn(kinds, source.type) || (source.kind === 'comparison' && source.type === 'stored_value')) {
    throw new WalletError('该卡型暂未开放登记。');
  }
  const name = typeof source.name === 'string' ? source.name.trim() : '';
  if (!name || name.length > 120) throw new WalletError('请填写卡片名称，最多 120 个字符。');
  const imageIds = source.imageIds ?? [];
  if (!Array.isArray(imageIds) || imageIds.length > 8 ||
      imageIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) ||
      new Set(imageIds).size !== imageIds.length) throw new WalletError('卡片截图来源无效。');
  const images = imageIds.length ? loadImages(new Set(imageIds)) : [];
  if (images.length !== imageIds.length) throw new WalletError('找不到卡片来源截图。');
  const offer = source.kind === 'comparison' ? makeOffer({ ...source.offer, type:source.type }) : null;
  const evidence = {};
  const facts = extract.candidates({ imageIds }, images);
  const restrictions = [];
  for (const fact of facts) {
    if (['schedule','reservation','restrictions','stacking'].includes(fact.field) &&
        restrictions.length < 10 && !restrictions.some(rule => rule.text === fact.quote)) {
      restrictions.push({ key:fact.field, text:fact.quote, imageId:fact.imageId, box:fact.box });
    }
    const field = evidence[fact.field] ??= { label:extract.labels[fact.field], verification:'待核对', evidence:[] };
    if (field.evidence.length < 4) field.evidence.push(fact);
  }
  if (offer?.window === 'restricted') restrictions.push({ key:'comparisonWindow', text:'购前试算设有使用时段，具体履约以已核对条款为准。' });
  const snapshot = { kind:source.kind, offerType:source.type, imageIds, ...(offer ? { comparison:offer } : {}) };
  const version = parseInt(createHash('sha256').update(JSON.stringify({ name, ...snapshot, evidence })).digest('hex').slice(0, 12), 16) + 1;
  return {
    plan:createPlan({ id:source.kind + '-' + version, version, name, type:kinds[source.type],
      offerPriceCents:offer?.price, evidence }),
    restrictions,
    walletSource:snapshot,
  };
}

module.exports = { reviewWalletSource };

