'use strict';

const { AgentError, createSessions } = require('./session');
const { createTools, reviewFrom } = require('./tools');
const { analyzeWorkbench, demoReview } = require('../decision-workbench');
const { fingerprint } = require('../wallet');
const { date } = require('../model');

const scalar = ['startDate', 'activationDate', 'serviceId', 'referencePrice', 'extraFees', 'assumedPrice'];
const limits = ['low', 'base', 'high'];
const demoInput = {
  visits: { serviceId: '私教', referencePrice: '90' },
  stored: { serviceId: '洗护', referencePrice: '200' },
  time: { serviceId: '健身', referencePrice: '80' },
};
const localDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const money = /^(?:\d{1,12})(?:\.\d{1,2})?$/;

function inputFor(patch = {}, previous = {}) {
  if (!object(patch)) throw new AgentError('计划格式不正确。');
  const input = { ...previous };
  input.startDate ??= localDay.format(new Date());
  for (const key of scalar) {
    if (!Object.hasOwn(patch, key)) continue;
    const value = patch[key];
    if (typeof value !== 'string' || value.length > 120) throw new AgentError('计划输入格式不正确。');
    input[key] = value.trim();
  }
  date(input.startDate, '计划开始日');
  if (input.activationDate) date(input.activationDate, '生效日');
  for (const key of ['referencePrice', 'extraFees', 'assumedPrice']) {
    if (input[key] && !money.test(input[key])) throw new AgentError('金额请输入非负数，最多两位小数。');
  }
  if (patch.scenarios !== undefined && !object(patch.scenarios)) throw new AgentError('情景格式不正确。');
  input.scenarios = Object.fromEntries(limits.map((key, index) => {
    const item = patch.scenarios?.[key] ?? previous.scenarios?.[key] ?? { count: 4 + 2 * index, everyDays: 7 };
    if (!object(item)) throw new AgentError('情景格式不正确。');
    const { count, everyDays } = item;
    if (!/^\d+$/.test(String(count)) || Number(count) > 52 ||
        !/^\d+$/.test(String(everyDays)) || Number(everyDays) < 1 || Number(everyDays) > 365) {
      throw new AgentError('请填写 0–52 次及 1–365 天的使用间隔。');
    }
    return [key, { count: String(count), everyDays: String(everyDays) }];
  }));
  return input;
}

function createAgent(dependencies, sessionOptions) {
  const sessions = createSessions(sessionOptions);
  const tools = createTools(dependencies);

  function snapshot(session) {
    const { schemaVersion, analysisId, source, state, revision, images, review, input, questions, answers,
      skipped, result, steps, cardId, error, createdAt, updatedAt } = session;
    return { schemaVersion, analysisId, source, state, revision, images: tools.imageRecords(images)
      .map(({ id, name, url }) => ({ id, name, url })),
      review, input, questions, answers, skipped, result, steps, cardId, error, createdAt, updatedAt };
  }

  function step(session, tool, result) {
    session.steps.push({ tool, result });
  }

  function calculate(session, changes = {}) {
    const input = inputFor(changes.input, session.input);
    const answers = { ...session.answers };
    let skipped = [...session.skipped];
    const confirmation = { ...session.confirmation };
    if (changes.reopen === true) {
      for (const key of Object.keys(answers)) delete answers[key];
      skipped = [];
    }
    if (changes.answer || changes.skip) {
      const key = changes.answer?.key ?? changes.skip;
      const question = session.questions.find(item => item.key === key);
      if (!question) throw new AgentError('这道问题已更新，请重新读取分析。', 409);
      if (changes.answer) {
        const label = changes.answer.label;
        if (!question.branches.some(branch => branch.label === label)) throw new AgentError('请选择有效的试算条件。');
        answers[key] = { label, intent: 'assumption' };
      } else {
        skipped.push(key);
      }
    }
    if (changes.confirm) {
      const { field, value } = changes.confirm;
      const candidate = session.review?.fields?.[field];
      if (!candidate || candidate.policy === '不适用' || !candidate.candidates.some(item => item.value === value) || field === 'actualPrice') {
        throw new AgentError('请选择有原文依据的字段。');
      }
      confirmation[field] = value;
      // A verified field supersedes any earlier scenario choice for that field.
      const related = {
        coverage: 'coverage', bonusCoverage: 'bonusCoverage', unit: 'redemption', total: 'visits',
        deduction: 'deduction', principal: 'principalCents', bonus: 'bonusCents',
        fixedEnd: 'validity', expiryDays: 'validity', validityMode: 'validity',
        bonusDays: 'bonusValidity', bonusEnd: 'bonusValidity', bonusValidity: 'bonusValidity',
      }[field];
      if (related) {
        delete answers[related];
        skipped = skipped.filter(key => key !== related);
      }
    }
    const review = session.source === 'demo' ? session.review : reviewFrom(session, confirmation);
    const payload = analyzeWorkbench(review, {
      ...input, answers: Object.fromEntries(Object.entries(answers).map(([key, answer]) => [key, answer.label])),
      skipped, includeCostCurve: true,
    });
    if (review.unsupportedType) payload.questions = [];
    const confirmed = payload.analysis?.scenarios.every(item => item.result.status === 'calculated');
    const state = payload.questions.length ? 'ask' : confirmed ? 'confirmed_result' : 'conditional_result';
    const reviewTag = session.source === 'agent' && payload.analysis ?
      fingerprint({ analysisId: session.analysisId, revision: session.revision + 1, input, review }) : null;
    const result = { ...payload, analysisId: session.analysisId, revision: session.revision + 1, reviewTag };
    sessions.save(session, { input, answers, skipped, confirmation, review, result,
      questions: result.questions, state, error: null });
  }

  async function identify(session, useDeepSeek) {
    if (session.processing) throw new AgentError('这份分析正在识别，请稍后刷新。', 409);
    session.processing = true;
    try {
      session.state = 'images';
      const images = await tools.read(session.images);
      if (!session.steps.some(item => item.tool === 'ocr')) step(session, 'ocr', '读取 ' + images.length + ' 张截图的本地 OCR');
      if (!session.candidates) {
        const { candidates, provider } = await tools.extractCandidates(images, useDeepSeek === true);
        session.candidates = candidates;
        const labels = { local: '本地提取', deepseek: 'DeepSeek 与本地提取', fallback: 'DeepSeek 调用失败，已用本地提取' };
        step(session, 'extract', labels[provider] + ' · ' + candidates.length + ' 条候选证据');
      }
      session.state = 'type_check';
      session.review = reviewFrom(session, session.confirmation);
      step(session, 'type_check', session.review.type ? '初步识别卡型' : '卡型待核对');
      session.state = 'policy_filter';
      step(session, 'policy_filter', '按卡型筛选字段并保留冲突');
      calculate(session);
    } catch (error) {
      sessions.save(session, { error: error.message });
    } finally {
      session.processing = false;
    }
    return snapshot(session);
  }

  return {
    async create({ imageIds, demoId, input, useDeepSeek } = {}) {
      if (demoId !== undefined) {
        if (imageIds !== undefined || !Object.hasOwn(demoInput, demoId)) throw new AgentError('请选择有效的演示套餐。');
        const defaults = { ...demoInput[demoId], extraFees: '0', startDate: localDay.format(new Date()) };
        const session = sessions.create('demo', [], inputFor(input, { ...defaults, activationDate: defaults.startDate }));
        session.review = demoReview(demoId);
        step(session, 'demo', '读取合成演示');
        calculate(session);
        return snapshot(session);
      }
      if (!Array.isArray(imageIds) || imageIds.length < 1 || imageIds.length > 8 ||
          new Set(imageIds).size !== imageIds.length || imageIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) {
        throw new AgentError('请选择 1–8 张不同的截图。');
      }
      tools.imageRecords(imageIds);
      return identify(sessions.create('agent', imageIds, inputFor(input)), useDeepSeek);
    },
    read(id) { return snapshot(sessions.get(id)); },
    async retry(id, { useDeepSeek } = {}) {
      const session = sessions.get(id);
      if (session.source !== 'agent' || !session.error) throw new AgentError('当前分析没有需要重试的识别步骤。', 409);
      return identify(session, useDeepSeek);
    },
    async ask(id, { question, history = [], useDeepSeek } = {}) {
      const session = sessions.get(id);
      if (!session.review) throw new AgentError('请先完成套餐识别。', 409);
      const validText = value => typeof value === 'string' && value.trim() && value.length <= 480;
      if (!validText(question) || !Array.isArray(history) || history.length > 3 || !history.every(validText)) {
        throw new AgentError('问题或上下文格式不正确。');
      }
      if (useDeepSeek !== true) return { provider: 'local', topics: null };
      try {
        const topics = await dependencies.selectTopics(question, history);
        return { provider: 'deepseek', topics };
      } catch {
        return { provider: 'fallback', topics: null };
      }
    },
    decision({ analysisId, revision, changes } = {}) {
      const session = sessions.get(analysisId);
      if (session.revision !== revision || session.processing || !session.review) {
        throw new AgentError('这份分析已有更新，请重新读取。', 409);
      }
      if (!object(changes) || Object.keys(changes).some(key => !['input', 'answer', 'skip', 'reopen', 'confirm'].includes(key))) {
        throw new AgentError('不支持的分析变更。');
      }
      calculate(session, changes);
      return snapshot(session);
    },
    purchase(id) {
      const session = sessions.get(id);
      if (session.source !== 'agent' || !session.result?.analysis || !session.review.plan) {
        throw new AgentError('请从已上传截图的套餐分析进入办卡。');
      }
      if (session.cardId) throw new AgentError('这份分析已经登记办卡。', 409);
      const { review, analysis, reviewTag } = session.result;
      const walletSource = { kind: 'agent', analysisId: id, imageIds: session.images,
        fields: review.fields, timeline: review.timeline };
      return { review: { ...review, walletSource }, analysis, reviewTag };
    },
    purchased(id, cardId) {
      // A successful wallet replay can outlive its in-memory draft.
      let session;
      try { session = sessions.get(id); } catch (error) {
        if (error.status !== 404) throw error;
        return;
      }
      session.cardId = cardId;
      session.state = 'wallet';
    },
  };
}

module.exports = { createAgent };
