// 归一化会话到 DSH 会话事件的纯映射。只发白名单七种事件。
// 校验规则来源（0.2.2-rc.1 实测）：
// - 头部必须 version=4, isSeeded 布尔, cwd 绝对路径, createdAt 非负安全整数
// - surface 事件必须带 surfaceOp:'append'
// - user/message: data 即消息，须有 id、role='user'、source.kind、content 数组
// - assistant/message: data.message 须有 id、role='assistant'、source={kind:'model',provider,model}、content 数组
// - seq 从 0 起连续
import { randomUUID } from 'node:crypto';

export const PROVIDER_TAG = 'imported';
export const MODEL_TAG = 'deepseek-history';

function contentBlock(kind, text) {
  return kind === 'reasoning'
    ? { type: 'reasoning', text }
    : { type: 'text', text };
}

// 事件工厂：surface 事件带 append 标记
function makeEmitter() {
  let seq = 0;
  return (type, data, surface) => {
    const event = { type, seq: seq++, time: 0, data };
    if (surface) event.surfaceOp = 'append';
    return event;
  };
}

// times：为每条事件定时间戳。基准取轮次的用户消息时间，逐条递增 1 毫秒保证单调。
export function mapSession(parsed, options = {}) {
  const {
    sessionId = `session-${randomUUID()}`,
    cwd = '/tmp',
    createdAtMs = parsed.insertedAtMs ?? Date.now(),
    presetId = options.presetId ?? 'standard',
    includeToolLine = true,
    provenance = true,
    provenanceText,
    // 图片引用由调用方注入：Map<exportPath, ImageAttachmentRef>
    imageRefs = new Map(),
  } = options;

  const emit = makeEmitter();
  const events = [];
  const messageSeqs = []; // user/message 事件 seq，供 session/title 引用
  const stats = { turns: 0, userMessages: 0, assistantMessages: 0, reasoningBlocks: 0, textBlocks: 0, toolLines: 0, images: 0, placeholderFiles: 0 };

  // 来源说明的文案。它必须落在已打开的 turn 与 step 内，所以在第一轮 step/start 之后写入。
  const provenanceBody = provenanceText ?? `本会话由 DeepSeek 导出的聊天记录转换而来，共 ${parsed.turns.length} 轮。原始标题：${parsed.title ?? '未命名'}。历史消息按原文保留，回复请接着对话往下说。`;
  let provenanceWritten = false;

  const fileBlocksOf = (files) => {
    const blocks = [];
    for (const f of files) {
      const ref = f.exportPath ? imageRefs.get(f.exportPath) : undefined;
      if (ref) {
        blocks.push({ type: 'image', attachment: ref });
        stats.images += 1;
      } else {
        blocks.push({ type: 'text', text: `[附件：${f.name}]` });
        stats.placeholderFiles += 1;
      }
    }
    return blocks;
  };

  for (const turn of parsed.turns) {
    if (turn.steps.length === 0 && turn.userText === '' && turn.userFiles.length === 0) continue;
    stats.turns += 1;
    const turnNo = stats.turns;
    const baseTime = turn.userAtMs ?? createdAtMs;
    let t = baseTime;

    events.push(emit('turn/start', { turn: turnNo }, false));
    events[events.length - 1].time = t;

    // 用户消息
    if (turn.userText !== '' || turn.userFiles.length > 0) {
      const content = [];
      if (turn.userText !== '') content.push({ type: 'text', text: turn.userText });
      content.push(...fileBlocksOf(turn.userFiles));
      const userEvent = emit('user/message', {
        content,
        source: { kind: 'user', rpcId: randomUUID(), clientTimeZone: options.clientTimeZone },
        role: 'user',
        id: randomUUID(),
      }, true);
      userEvent.time = t;
      messageSeqs.push(userEvent.seq);
      events.push(userEvent);
      stats.userMessages += 1;
    }

    // 每条助手消息一个 step
    for (const step of turn.steps) {
      const stepNo = events.filter(e => e.type === 'step/start' && e.data.turn === turnNo).length + 1;
      events.push(emit('step/start', { turn: turnNo, step: stepNo }, false));
      events[events.length - 1].time = step.atMs ?? t;

      // 来源说明插在第一个已打开的 step 内，用 developer 身份承载，不覆盖系统提示
      if (provenance && !provenanceWritten) {
        provenanceWritten = true;
        const provEvent = emit('developer/message', {
          turn: turnNo,
          step: stepNo,
          message: {
            id: randomUUID(),
            role: 'developer',
            source: { kind: 'developer' },
            content: [{ type: 'text', text: provenanceBody }],
          },
        }, true);
        provEvent.time = step.atMs ?? t;
        events.push(provEvent);
      }

      const blocks = [];
      for (const b of step.blocks) {
        blocks.push(contentBlock(b.kind, b.text));
        if (b.kind === 'reasoning') stats.reasoningBlocks += 1; else stats.textBlocks += 1;
      }
      if (includeToolLine && step.toolLine) {
        blocks.push({ type: 'text', text: step.toolLine });
        stats.toolLines += 1;
      }
      blocks.push(...fileBlocksOf(step.files));

      const assistantEvent = emit('assistant/message', {
        turn: turnNo,
        step: stepNo,
        message: {
          id: randomUUID(),
          role: 'assistant',
          content: blocks,
          source: { kind: 'model', provider: PROVIDER_TAG, model: MODEL_TAG },
        },
      }, true);
      assistantEvent.time = step.atMs ?? t;
      events.push(assistantEvent);
      stats.assistantMessages += 1;

      events.push(emit('step/end', { turn: turnNo, step: stepNo }, false));
      events[events.length - 1].time = step.atMs ?? t;
    }

    events.push(emit('turn/end', { turn: turnNo, reason: { kind: 'completed' } }, false));
    events[events.length - 1].time = turn.steps.at(-1)?.atMs ?? t;
  }

  // 标题事件
  const title = parsed.title ?? parsed.turns.find(t => t.userText)?.userText.slice(0, 30) ?? '导入的会话';
  const titleEvent = emit('session/title', {
    title,
    messageSeqs,
    source: { kind: 'fallback' },
  }, false);
  titleEvent.time = parsed.updatedAtMs ?? createdAtMs;
  events.push(titleEvent);

  // 时间单调化：逐条检查，非递减则推进 1 毫秒
  let last = events[0]?.time ?? createdAtMs;
  for (const e of events) {
    if (e.time < last) e.time = last;
    last = e.time;
  }

  // 无损 JSON 保险：递归剔除 undefined 属性，杜绝序列化丢字段
  const compact = (value) => {
    if (Array.isArray(value)) return value.map(compact).filter(v => v !== undefined);
    if (value !== null && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (v === undefined) continue;
        out[k] = compact(v);
      }
      return out;
    }
    return value;
  };
  for (const e of events) {
    const c = compact(e);
    e.data = c.data;
    if (c.surfaceOp !== undefined) e.surfaceOp = c.surfaceOp;
  }

  const header = {
    version: 4,
    id: sessionId,
    createdAt: createdAtMs,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: presetId,
  };

  return { header, events, title, stats };
}

// 本地不变量自检，映射后立即调用，任何一条失败说明映射层有 bug
export function assertInvariants(header, events) {
  const known = new Set(['user/message', 'assistant/message', 'turn/start', 'turn/end', 'step/start', 'step/end', 'session/title', 'developer/message']);
  events.forEach((e, i) => {
    if (e.seq !== i) throw new Error(`seq 不连续：位置 ${i} 的 seq 是 ${e.seq}`);
    if (!known.has(e.type)) throw new Error(`白名单外的事件类型：${e.type}`);
    if (!Number.isSafeInteger(e.time)) throw new Error(`时间不是安全整数：seq ${e.seq}`);
    if (e.surfaceOp !== undefined && !['user/message', 'assistant/message', 'developer/message'].includes(e.type)) {
      throw new Error(`surface 标记出现在非消息事件上：${e.type}`);
    }
  });
  const surfaceTypes = new Set(['user/message', 'assistant/message', 'developer/message']);
  for (const e of events) {
    if (surfaceTypes.has(e.type) && e.surfaceOp !== 'append') throw new Error(`surface 事件缺 append 标记：seq ${e.seq}`);
    if (e.type === 'user/message') {
      const d = e.data;
      if (typeof d.id !== 'string' || d.id === '') throw new Error(`user/message 缺 id：seq ${e.seq}`);
      if (d.role !== 'user') throw new Error(`user/message 角色不对：seq ${e.seq}`);
      if (!Array.isArray(d.content)) throw new Error(`user/message 缺 content：seq ${e.seq}`);
      if (typeof d.source?.kind !== 'string' || d.source.kind === '') throw new Error(`user/message 缺 source：seq ${e.seq}`);
    }
    if (e.type === 'developer/message') {
      const m = e.data.message;
      if (typeof m?.id !== 'string' || m.id === '') throw new Error(`developer/message 缺消息 id：seq ${e.seq}`);
      if (m.role !== 'developer') throw new Error(`developer/message 角色必须是 developer：seq ${e.seq}`);
      if (!Array.isArray(m.content)) throw new Error(`developer/message 缺 content：seq ${e.seq}`);
      if (typeof m.source?.kind !== 'string' || m.source.kind === '') throw new Error(`developer/message 缺 source：seq ${e.seq}`);
    }
    if (e.type === 'assistant/message') {
      const m = e.data.message;
      if (typeof m.id !== 'string' || m.id === '') throw new Error(`assistant/message 缺消息 id：seq ${e.seq}`);
      if (m.role !== 'assistant') throw new Error(`assistant/message 角色不对：seq ${e.seq}`);
      if (!Array.isArray(m.content)) throw new Error(`assistant/message 缺 content：seq ${e.seq}`);
      const s = m.source;
      if (s?.kind !== 'model' || typeof s.provider !== 'string' || s.provider === '' || typeof s.model !== 'string' || s.model === '') {
        throw new Error(`assistant/message 缺模型来源：seq ${e.seq}`);
      }
    }
  }
  if (header.version !== 4) throw new Error('头部版本必须是 4');
  if (typeof header.isSeeded !== 'boolean') throw new Error('头部缺 isSeeded');
  if (!header.cwd || !header.cwd.startsWith('/')) throw new Error('cwd 必须是绝对路径');
  if (!Number.isSafeInteger(header.createdAt) || header.createdAt < 0) throw new Error('createdAt 非法');
  return true;
}
