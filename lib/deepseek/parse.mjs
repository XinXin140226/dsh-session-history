// DeepSeek 导出包解析：会话 JSON 到归一化中间模型。纯函数，不认识 DSH。
// 归一化模型：
// {
//   originId, title, pinned, insertedAtMs, updatedAtMs,
//   turns: [{
//     userText, userAtMs,
//     userFiles: [{name, isImage}],
//     steps: [{ blocks: [{kind, text}], toolLine, atMs, files: [{name,isImage,exportPath,width,height}] }],
//   }]
// }

const TOOL_TYPES = new Set(['TOOL_OPEN', 'TOOL_SEARCH', 'TOOL_FIND', 'TOOL_IMAGE_SEARCH', 'READ_LINK', 'PARTIAL_FILE_READ']);
const DROP_TYPES = new Set(['CONTENT_RISK', 'TIP', 'TEMPLATE_RESPONSE']);
const TEXT_TYPES = new Set(['REQUEST', 'RESPONSE', 'THINK']);

function toMs(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

// 检索摘要。mode: line 一行摘要，queries 带检索词，off 不产出
function toolLineOf(fragments, mode = 'line') {
  if (mode === 'off') return undefined;
  let searches = 0, opens = 0;
  const hosts = new Set();
  for (const f of fragments) {
    if (f.type === 'TOOL_SEARCH') searches += 1;
    else if (f.type === 'TOOL_OPEN') {
      opens += 1;
      try {
        const u = new URL(f.url);
        hosts.add(u.host);
      } catch { /* 忽略坏链接 */ }
    }
  }
  if (searches === 0 && opens === 0) return undefined;

  // queries 档：把检索词一并列出来，仍压成一行
  if (mode === 'queries') {
    const queries = [];
    for (const f of fragments) {
      if (f.type === 'TOOL_SEARCH' && Array.isArray(f.queries)) {
        for (const q of f.queries) if (typeof q === 'string' && q !== '') queries.push(q);
      }
    }
    const parts = [];
    if (searches > 0) parts.push(`检索 ${searches} 次`);
    if (opens > 0) parts.push(`打开 ${opens} 页`);
    const head = parts.join(' · ');
    const q = queries.slice(0, 3).join('、');
    return q === '' ? `（${head}）` : `（${head}：${q}${queries.length > 3 ? ' 等' : ''}）`;
  }

  const parts = [];
  if (searches > 0) parts.push(`检索 ${searches} 次`);
  if (opens > 0) parts.push(`打开 ${opens} 页`);
  const hostList = [...hosts].slice(0, 3).join('、');
  const tail = hostList ? `：${hostList}${hosts.size > 3 ? ' 等' : ''}` : '';
  return `（${parts.join(' · ')}${tail}）`;
}

function fileEntriesOf(fragments) {
  const out = [];
  for (const f of fragments) {
    if (f.type !== 'FILE' || !Array.isArray(f.files)) continue;
    for (const file of f.files) {
      out.push({
        name: file.file_name ?? '未命名',
        isImage: file.is_image === true,
        exportPath: file.export_path,
        width: file.width,
        height: file.height,
        size: file.file_size,
      });
    }
  }
  return out;
}

// 单条消息的片段序列转成块序列，保持原始顺序
function blocksOf(fragments) {
  const blocks = [];
  for (const f of fragments) {
    if (!TEXT_TYPES.has(f.type)) continue;
    const text = f.content;
    if (typeof text !== 'string' || text.length === 0) continue;
    const kind = f.type === 'THINK' ? 'reasoning' : 'text';
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind) {
      // 同类相邻片段按原始分隔合并
      last.text += '\n\n' + text;
    } else {
      blocks.push({ kind, text });
    }
  }
  return blocks;
}

export function parseSession(raw, options = {}) {
  const { toolSummary = 'line' } = options;
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.messages)) {
    throw new Error('会话结构不对：缺 messages 数组');
  }
  const turns = [];
  let currentTurn = null;

  const pushTurn = () => { if (currentTurn) turns.push(currentTurn); };

  for (const msg of raw.messages) {
    const fragments = Array.isArray(msg.fragments) ? msg.fragments : [];
    const atMs = toMs(msg.inserted_at);

    if (msg.role === 'USER') {
      pushTurn();
      const userText = fragments
        .filter(f => f.type === 'REQUEST' && typeof f.content === 'string' && f.content.length > 0)
        .map(f => f.content)
        .join('\n\n');
      currentTurn = {
        userText,
        userAtMs: atMs,
        userFiles: fileEntriesOf(fragments),
        steps: [],
      };
      continue;
    }

    if (msg.role === 'ASSISTANT') {
      if (!currentTurn) {
        // 开头就是助手消息的坏数据，收进一个无提问轮，避免丢内容
        currentTurn = { userText: '', userAtMs: atMs, userFiles: [], steps: [] };
      }
      currentTurn.steps.push({
        blocks: blocksOf(fragments),
        toolLine: toolLineOf(fragments, toolSummary),
        atMs,
        files: fileEntriesOf(fragments),
      });
    }
    // 其它角色直接丢弃
  }
  pushTurn();

  return {
    originId: raw.id,
    title: typeof raw.title === 'string' && raw.title.length > 0 ? raw.title : undefined,
    pinned: raw.pinned === true,
    insertedAtMs: toMs(raw.inserted_at),
    updatedAtMs: toMs(raw.updated_at),
    turns,
  };
}

// 空会话判定：没有任何助手回复
export function isEmptySession(parsed) {
  return parsed.turns.every(t => t.steps.length === 0);
}

// 导出包索引行归一化（chat_session_index.json 的元素）
export function parseIndexEntry(entry) {
  return {
    originId: entry.id,
    title: entry.title,
    pinned: entry.pinned === true,
    messageCount: entry.message_count,
    updatedAtMs: toMs(entry.updated_at),
    insertedAtMs: toMs(entry.inserted_at),
  };
}
