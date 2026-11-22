// 导出：纯函数层。会话事件流到 Markdown，以及 zip 写入。
// 输入统一是归一化的会话视图，方便单会话与批量共用。
import { deflateRawSync } from 'node:zlib';

// 会话事件流提取成可导出的轮次结构
export function turnsFromEvents(events) {
  const turns = [];
  let current = null;
  let pendingUser = null;

  for (const e of events) {
    if (e.type === 'turn/start') {
      current = { index: e.data.turn, at: e.time, user: [], assistant: [], toolNotes: [] };
      turns.push(current);
      pendingUser = null;
    } else if (e.type === 'user/message') {
      const blocks = [];
      for (const block of e.data.content ?? []) {
        if (block.type === 'text') blocks.push({ kind: 'text', text: block.text });
        else if (block.type === 'image') blocks.push({ kind: 'image', name: block.attachment?.name });
      }
      if (current) current.user.push(...blocks);
      else { pendingUser = blocks; }
    } else if (e.type === 'assistant/message') {
      const target = current ?? (turns.push({ index: turns.length + 1, at: e.time, user: pendingUser ?? [], assistant: [], toolNotes: [] }), turns.at(-1));
      target.user = target.user.length ? target.user : (pendingUser ?? []);
      pendingUser = null;
      for (const block of e.data.message?.content ?? []) {
        if (block.type === 'reasoning') target.assistant.push({ kind: 'reasoning', text: block.text });
        else if (block.type === 'text') target.assistant.push({ kind: 'text', text: block.text });
        else if (block.type === 'image') target.assistant.push({ kind: 'image', name: block.attachment?.name });
      }
      if (e.time) target.assistantAt = e.time;
      target.model = e.data.message?.source?.model;
    } else if (e.type === 'session/title') {
      current = current; // 标题单独处理
    }
  }
  return turns;
}

export function titleFromEvents(events, fallback = '未命名会话') {
  let title = fallback;
  for (const e of events) {
    if (e.type === 'session/title' && typeof e.data?.title === 'string' && e.data.title !== '') title = e.data.title;
  }
  return title;
}

function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 单会话 Markdown。思考收进折叠块，正文保持原样。
export function renderMarkdown({ id, title, createdAt, events, imported }) {
  const turns = turnsFromEvents(events);
  const lines = [];
  lines.push(`# ${title}`, '');
  const meta = [`会话 ID: \`${id}\``];
  if (Number.isFinite(createdAt)) meta.push(`创建时间: ${fmtTime(createdAt)}`);
  if (imported) meta.push('来源: DeepSeek 导出包');
  lines.push(`> ${meta.join(' · ')}`, '');

  for (const turn of turns) {
    const at = fmtTime(turn.at);
    if (turn.user.length) {
      lines.push(`## 第 ${turn.index} 轮${at ? ` · ${at}` : ''}`, '');
      for (const b of turn.user) {
        if (b.kind === 'text') lines.push(...b.text.split('\n').map(l => `> ${l}`));
        else if (b.kind === 'image') lines.push(`> [图片: ${b.name ?? '未命名'}]`);
      }
      lines.push('');
    }
    const reasoning = turn.assistant.filter(b => b.kind === 'reasoning');
    const text = turn.assistant.filter(b => b.kind === 'text');
    const images = turn.assistant.filter(b => b.kind === 'image');

    if (reasoning.length) {
      lines.push('<details>', '<summary>思考过程</summary>', '');
      for (const b of reasoning) lines.push(b.text, '');
      lines.push('</details>', '');
    }
    for (const b of text) lines.push(b.text, '');
    for (const b of images) lines.push(`[图片: ${b.name ?? '未命名'}]`, '');
  }
  return lines.join('\n');
}

// 极简 zip 写入：deflateRaw 加中央目录。边写边返回 Buffer，不落内存副本。
export function buildZip(files) {
  // files: [{name, data: Buffer|string}]
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const deflated = deflateRawSync(raw, { level: 6 });
    const useDeflate = deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0x21, 12); // 1980-01-01
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(payload.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    locals.push(lfh, nameBuf, payload);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0x21, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(payload.length, 20);
    cdh.writeUInt32LE(raw.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(offset, 42);
    centrals.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

// CRC32 表
let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

// 文件名净化：去掉路径分隔符与非法字符
export function safeFileName(title, id, used = new Set()) {
  let base = String(title ?? '未命名').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  if (base === '') base = '未命名';
  if (base.length > 80) base = base.slice(0, 80);
  let name = `${base}.md`;
  if (used.has(name)) name = `${base}-${id.slice(-8)}.md`;
  let n = 2;
  while (used.has(name)) { name = `${base}-${id.slice(-8)}-${n}.md`; n += 1; }
  used.add(name);
  return name;
}
// 导出的结构化数据：只保留能再导回来的最低限度，事件原样存最好，但体积大。
// 折中做法：存归一化后的轮次，字段固定，导入端不需要认识 DSH 事件格式。
export function toExchangeSession({ id, title, createdAt, events, imported }) {
  const turns = turnsFromEvents(events);
  return {
    schema: 'dsh-session-history/exchange',
    version: 1,
    origin: { sessionId: id, imported: Boolean(imported) },
    title,
    createdAt: Number.isFinite(createdAt) ? createdAt : undefined,
    turns: turns.map((turn) => ({
      index: turn.index,
      at: turn.at,
      model: turn.model,
      user: turn.user.map(b => (b.kind === 'text' ? { kind: 'text', text: b.text } : { kind: 'image', name: b.name })),
      assistant: turn.assistant.map(b => (b.kind === 'text' ? { kind: 'text', text: b.text }
        : b.kind === 'reasoning' ? { kind: 'reasoning', text: b.text }
          : { kind: 'image', name: b.name })),
    })),
  };
}
