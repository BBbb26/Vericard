'use strict';

function parsePositiveInteger(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseQuotedCents(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const cents = Number(match[1] + fraction);
  return Number.isSafeInteger(cents) ? cents : null;
}

// Version 1 screenshot groups are evidence drafts. They cannot be executed as plans.
function readLegacyProject(project) {
  if (project?.version !== 1 || !Array.isArray(project.groups)) {
    throw new TypeError('Expected a version 1 screenshot project');
  }
  return project.groups.map(group => {
    const value = key => group.fields?.[key]?.value;
    const unit = value('unit');
    const total = parsePositiveInteger(value('total'));
    let typeHint = null;
    let redemption = null;
    if (unit === '连续天') typeHint = 'time_pass';
    if (unit === '使用日' || (unit === '次' && total > 1)) {
      typeHint = 'visit_pack';
      redemption = unit === '使用日' ? 'per_day' : 'per_visit';
    }
    return {
      status: 'needs_review',
      typeHint,
      candidates: {
        offerPriceCents: parseQuotedCents(value('price')),
        visits: typeHint === 'visit_pack' ? total : null,
        redemption,
        firstRedemptionWithinDays: parsePositiveInteger(value('purchaseDays')),
        daysFromActivation: parsePositiveInteger(value('expiryDays')),
        fixedEndDate: value('fixedEnd') || null,
      },
      source: structuredClone(group),
    };
  });
}

module.exports = { readLegacyProject };
