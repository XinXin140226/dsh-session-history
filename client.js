// dsh-session-history Client 半边。
// 设置页：导入、导出、设置三段。侧栏：任务进度条。
// 颜色只用 DSH 主题 token，浅色与深色跟随系统。
window.__ModuleLoader__.load({
  id: 'dsh-session-history',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useMemo } = React;

    // 相对路径与官方导出路由一致
    const API = {
      scan: 'api/session-history.scan',
      catalog: 'api/session-history.catalog',
      import: 'api/session-history.import',
      status: 'api/session-history.status',
      cancel: 'api/session-history.cancel',
      sessions: 'api/session-history.sessions',
      export: 'api/session-history.export',
      download: 'api/session-history.download',
      markdown: 'api/session-history.markdown',
      cache: 'api/session-history.cache',
      originals: 'api/session-history.originals',
      originalsClear: 'api/session-history.originals.clear',
      upload: 'api/session-history.upload',
      cacheClear: 'api/session-history.cache.clear',
      settings: 'api/session-history.settings',
      settingsSave: 'api/session-history.settings.save',
    };

    const C = {
      label1: 'var(--dsw-alias-label-primary)',
      label2: 'var(--dsw-alias-label-secondary)',
      bg1: 'var(--dsw-alias-bg-layer-1)',
      bg2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      brand: 'var(--dsw-alias-brand-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
    };

    // 中英二选一：浏览器语言决定，环境里没有 navigator 时按中文
    const isZh = (() => {
      try {
        return String(globalThis.navigator?.language ?? 'zh').toLowerCase().startsWith('zh');
      } catch { return true; }
    })();
    const L = (zh, en) => (isZh ? zh : en);
    const TITLE = L('聊天记录迁移', 'Chat history migration');

    async function getJson(path) {
      const res = await fetch(path, { headers: { accept: 'application/json' } });
      const data = await res.json().catch(() => ({ ok: false, error: `响应不是 JSON（${res.status}）` }));
      if (!data.ok) throw new Error(data.error ?? `请求失败（${res.status}）`);
      return data;
    }

    async function postJson(path, body) {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const data = await res.json().catch(() => ({ ok: false, error: `响应不是 JSON（${res.status}）` }));
      if (!data.ok) throw new Error(data.error ?? `请求失败（${res.status}）`);
      return data;
    }

    const s = {
      page: { display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 2px' },
      tabs: { display: 'flex', gap: 4, borderBottom: `1px solid ${C.border}`, paddingBottom: 8 },
      tab: (active) => ({
        appearance: 'none', border: 'none', cursor: 'pointer', padding: '6px 12px',
        borderRadius: 8, fontSize: 13, fontWeight: active ? 600 : 400,
        color: active ? C.label1 : C.label2,
        background: active ? C.bg2 : 'transparent',
      }),
      card: { border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, background: C.bg1, display: 'flex', flexDirection: 'column', gap: 10 },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      label: { fontSize: 12, color: C.label2 },
      input: { flex: 1, minWidth: 200, fontSize: 13, padding: '7px 10px', borderRadius: 8, border: `1px solid ${C.border}`, background: C.bg2, color: C.label1, outline: 'none' },
      btn: (kind) => ({
        appearance: 'none', cursor: 'pointer', fontSize: 13, padding: '7px 14px', borderRadius: 8,
        border: kind === 'primary' ? 'none' : `1px solid ${C.border}`,
        background: kind === 'primary' ? C.brand : 'transparent',
        color: kind === 'primary' ? '#fff' : C.label1,
        fontWeight: kind === 'primary' ? 600 : 400,
      }),
      list: { border: `1px solid ${C.border}`, borderRadius: 10, maxHeight: 320, overflowY: 'auto', background: C.bg1 },
      item: { display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 12px', borderBottom: `1px solid ${C.border}`, cursor: 'pointer' },
      title: { fontSize: 13, color: C.label1, lineHeight: 1.45 },
      meta: { fontSize: 11, color: C.label2, marginTop: 2 },
      tag: (color) => ({ fontSize: 11, padding: '1px 7px', borderRadius: 999, border: `1px solid ${color}`, color, whiteSpace: 'nowrap' }),
      bar: { height: 6, borderRadius: 999, background: C.bg2, overflow: 'hidden' },
      fill: (pct) => ({ height: '100%', width: `${Math.min(100, Math.max(0, pct))}%`, background: C.brand, transition: 'width 200ms ease' }),
      err: { fontSize: 12, color: C.err },
      hint: { fontSize: 12, color: C.label2, lineHeight: 1.6 },
      switchRow: { display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', padding: '8px 0' },
    };

    function fmtSize(n) {
      if (!Number.isFinite(n)) return '';
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
      return `${(n / 1024 / 1024).toFixed(1)} MB`;
    }

    function fmtTime(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '';
      const d = new Date(ms);
      const p = (x) => String(x).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    function ProgressBar({ status }) {
      if (!status?.running) return null;
      const pct = status.total > 0 ? (status.done / status.total) * 100 : 0;
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('div', { style: s.row },
          h('span', { style: s.label }, `${status.done} / ${status.total}`),
          status.skipped ? h('span', { style: s.label }, `跳过 ${status.skipped}`) : null,
          status.failed ? h('span', { style: { ...s.label, color: C.err } }, `失败 ${status.failed}`) : null,
        ),
        h('div', { style: s.bar }, h('div', { style: s.fill(pct) })),
        status.currentTitle ? h('div', { style: s.hint }, status.currentTitle) : null,
      );
    }

    // 导入段
    function ImportPanel() {
      const [zips, setZips] = useState([]);
      const [zipPath, setZipPath] = useState('');
      const [rows, setRows] = useState([]);
      const [picked, setPicked] = useState(() => new Set());
      const [query, setQuery] = useState('');
      const [page, setPage] = useState(0);
      const [status, setStatus] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [result, setResult] = useState(null);
      const [withImages, setWithImages] = useState(false);
      const PAGE = 60;

      useEffect(() => {
        getJson(API.scan).then((d) => {
          setZips(d.zips ?? []);
          if ((d.zips ?? []).length > 0) setZipPath(d.zips[0].path);
        }).catch(() => {});
      }, []);

      const loadCatalog = useCallback(async (p) => {
        setBusy(true); setError(''); setResult(null);
        try {
          const d = await postJson(API.catalog, { zipPath: p });
          setRows(d.rows ?? []);
          setPicked(new Set());
          setPage(0);
        } catch (e) { setError(e.message); }
        finally { setBusy(false); }
      }, []);

      // 任务状态轮询
      useEffect(() => {
        let alive = true;
        const tick = async () => {
          try {
            const d = await getJson(API.status);
            if (!alive) return;
            setStatus(d.status);
            if (d.status && !d.status.running && d.status.finishedAt) {
              setResult({
                done: d.status.done, failed: d.status.failed, skipped: d.status.skipped,
                errors: d.status.errors ?? [], warnings: d.status.warnings ?? [],
                images: d.status.images ?? 0, imageFailures: d.status.imageFailures ?? 0,
                savedBytes: d.status.savedBytes ?? 0,
              });
            }
          } catch { /* 忽略单次失败 */ }
        };
        tick();
        const timer = setInterval(tick, 900);
        return () => { alive = false; clearInterval(timer); };
      }, []);

      const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (q === '') return rows;
        return rows.filter(r => (r.title ?? '').toLowerCase().includes(q));
      }, [rows, query]);

      const pageRows = filtered.slice(page * PAGE, page * PAGE + PAGE);
      const pages = Math.max(1, Math.ceil(filtered.length / PAGE));

      const toggle = (id) => {
        setPicked((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id); else next.add(id);
          return next;
        });
      };

      const start = async () => {
        setError(''); setResult(null);
        try {
          await postJson(API.import, { zipPath, ids: [...picked], withImages });
        } catch (e) { setError(e.message); }
      };

      const running = status?.running === true;

      const [dragging, setDragging] = useState(false);
      const [uploading, setUploading] = useState(false);

      const handleFile = async (file) => {
        if (!file) return;
        if (!/\.zip$/i.test(file.name)) { setError(L('请选择 zip 文件', 'Pick a .zip file')); return; }
        setError(''); setUploading(true); setResult(null);
        try {
          const res = await fetch(`${API.upload}?name=${encodeURIComponent(file.name)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/zip' },
            body: file,
          });
          const data = await res.json().catch(() => ({ ok: false, error: `上传失败（${res.status}）` }));
          if (!data.ok) throw new Error(data.error ?? '上传失败');
          setZipPath(data.path);
          await loadCatalog(data.path);
        } catch (e) { setError(e.message); }
        finally { setUploading(false); }
      };

      return h('div', { style: s.page },
        h('div', {
          style: {
            ...s.card,
            borderStyle: dragging ? 'solid' : 'dashed',
            borderColor: dragging ? C.brand : C.border,
            alignItems: 'center', textAlign: 'center', padding: '22px 14px', gap: 8,
          },
          onDragOver: (e) => { e.preventDefault(); setDragging(true); },
          onDragLeave: () => setDragging(false),
          onDrop: (e) => {
            e.preventDefault(); setDragging(false);
            const file = e.dataTransfer?.files?.[0];
            handleFile(file);
          },
        },
          h('div', { style: { fontSize: 14, color: C.label1 } },
            uploading ? L('正在上传，别关页面', 'Uploading, keep this page open') : L('把聊天记录压缩包拖到这里', 'Drop the chat export here')),
          h('div', { style: s.hint }, L('也可以点下面的按钮选文件。', 'Or pick a file below.')),
          h('label', {
            style: { ...s.btn('primary'), display: 'inline-block', padding: '8px 18px', opacity: uploading || busy ? 0.6 : 1 },
          },
            L('选择文件', 'Choose file'),
            h('input', {
              type: 'file', accept: '.zip,application/zip', style: { display: 'none' },
              disabled: uploading || busy,
              onChange: (e) => handleFile(e.target.files?.[0]),
            }),
          ),
          uploading ? h('div', { style: s.bar }, h('div', { style: s.fill(60) })) : null,
        ),

        rows.length === 0 && !uploading ? h('div', { style: s.card },
          h('div', { style: s.hint }, L('选好压缩包后，这里会列出里面有哪些对话。', 'After you pick a file, its conversations appear here.')),
        ) : null,

        zips.length > 0 && rows.length === 0 ? h('div', { style: s.card },
          h('div', { style: s.label }, L('本机找到的包', 'Found on this device')),
          ...zips.slice(0, 4).map(z => h('button', {
            key: z.path,
            style: { ...s.btn(), fontSize: 12, padding: '6px 10px', marginTop: 6 },
            disabled: busy,
            onClick: () => { setZipPath(z.path); loadCatalog(z.path); },
          }, `${z.name}（${fmtSize(z.size)}）`)),
        ) : null,

        h('details', { style: { ...s.card, padding: '10px 14px' } },
          h('summary', { style: { fontSize: 12, color: C.label2, cursor: 'pointer' } }, L('文件已经在设备上，直接填路径', 'The file is already here, enter its path')),
          h('div', { style: { ...s.row, marginTop: 8 } },
            h('input', {
              style: s.input, value: zipPath, placeholder: 'zip 文件的完整路径',
              onChange: (e) => setZipPath(e.target.value),
            }),
            h('button', { style: s.btn(), disabled: busy || zipPath === '', onClick: () => { setZipPath(zipPath); loadCatalog(zipPath); } },
              busy ? '读取中' : '读取'),
          ),
        ),

        error ? h('div', { style: s.err }, error) : null,

        rows.length > 0 ? h('div', { style: s.card },
          h('div', { style: s.row },
            h('input', {
              style: s.input, value: query, placeholder: '按标题搜索',
              onChange: (e) => { setQuery(e.target.value); setPage(0); },
            }),
            h('span', { style: s.label }, `共 ${filtered.length} 个`),
          ),
          h('div', { style: s.row },
            h('button', { style: s.btn(), onClick: () => setPicked(new Set(filtered.map(r => r.originId))) }, L('全选', 'Select all')),
            h('button', { style: s.btn(), onClick: () => setPicked(new Set()) }, '清空'),
            h('button', { style: s.btn(), onClick: () => setPicked(new Set(rows.filter(r => r.updatedAtMs > Date.now() - 30 * 864e5).map(r => r.originId))) }, '最近三十天'),
          ),
          h('div', { style: s.list },
            ...pageRows.map(r => {
              const on = picked.has(r.originId);
              return h('label', { key: r.originId, style: s.item },
                h('input', { type: 'checkbox', checked: on, onChange: () => toggle(r.originId), style: { marginTop: 3 } }),
                h('div', { style: { flex: 1, minWidth: 0 } },
                  h('div', { style: s.title }, r.title || `${L('未命名会话', 'Untitled session')} · ${String(r.originId).slice(-8)}`),
                  h('div', { style: s.meta }, `${r.messageCount} 条消息${r.updatedAtMs ? ` · ${fmtTime(r.updatedAtMs)}` : ''}`),
                ),
                r.pinned ? h('span', { style: s.tag(C.warn) }, '置顶') : null,
              );
            }),
          ),
          pages > 1 ? h('div', { style: s.row },
            h('button', { style: s.btn(), disabled: page === 0, onClick: () => setPage(p => Math.max(0, p - 1)) }, '上一页'),
            h('span', { style: s.label }, `第 ${page + 1} / ${pages} 页`),
            h('button', { style: s.btn(), disabled: page + 1 >= pages, onClick: () => setPage(p => Math.min(pages - 1, p + 1)) }, '下一页'),
          ) : null,
          h('div', { style: s.row },
            h('button', {
              style: { ...s.btn('primary'), opacity: picked.size === 0 || running ? 0.5 : 1 },
              disabled: picked.size === 0 || running,
              onClick: start,
            }, running ? L('导入中', 'Importing') : `${L('导入', 'Import')} ${picked.size} ${L('个会话', 'conversations')}`),
            running ? h('button', { style: s.btn(), onClick: () => postJson(API.cancel).catch(() => {}) }, '取消') : null,
          ),
          running ? h(ProgressBar, { status }) : null,
          result ? h('div', { style: s.hint },
            `完成 ${result.done} 个` + (result.skipped ? `，跳过 ${result.skipped} 个` : '') + (result.failed ? `，失败 ${result.failed} 个` : ''),
            result.images ? `，导入图片 ${result.images} 张${result.savedBytes ? `（压缩省下 ${fmtSize(result.savedBytes)}）` : ''}` : '',
            result.imageFailures ? `，图片失败 ${result.imageFailures} 张` : '',
            result.warnings?.length ? h('div', { style: { ...s.hint, marginTop: 4 } },
              ...result.warnings.slice(0, 3).map((w, i) => h('div', { key: i }, w)),
            ) : null,
            result.errors?.length ? h('div', { style: { ...s.err, marginTop: 6 } },
              ...result.errors.slice(0, 5).map((e, i) => h('div', { key: i }, `${e.title}：${e.reason}`)),
            ) : null,
          ) : null,
        ) : null,
      );
    }

    // 导出段
    function ExportPanel() {
      const [rows, setRows] = useState([]);
      const [picked, setPicked] = useState(() => new Set());
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [done, setDone] = useState(null);
      const [query, setQuery] = useState('');
      const [onlyImported, setOnlyImported] = useState(false);

      const load = useCallback(async (importedOnly) => {
        setBusy(true); setError('');
        try {
          const d = await getJson(`${API.sessions}${importedOnly ? '?onlyImported=1' : ''}`);
          setRows(d.rows ?? []);
          setPicked(new Set());
        } catch (e) { setError(e.message); }
        finally { setBusy(false); }
      }, []);

      useEffect(() => { load(false); }, [load]);

      const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (q === '') return rows;
        return rows.filter(r => (r.title ?? '').toLowerCase().includes(q));
      }, [rows, query]);

      const run = async () => {
        setBusy(true); setError(''); setDone(null);
        try {
          const d = await postJson(API.export, { ids: [...picked] });
          setDone(d);
        } catch (e) { setError(e.message); }
        finally { setBusy(false); }
      };

      return h('div', { style: s.page },
        h('div', { style: s.card },
          h('div', { style: s.row },
            h('input', { style: s.input, value: query, placeholder: '按标题搜索', onChange: (e) => setQuery(e.target.value) }),
            h('label', { style: { ...s.label, display: 'flex', gap: 6, alignItems: 'center' } },
              h('input', { type: 'checkbox', checked: onlyImported, onChange: (e) => { setOnlyImported(e.target.checked); load(e.target.checked); } }),
              '只看导入的'),
          ),
          h('div', { style: s.row },
            h('button', { style: s.btn(), onClick: () => setPicked(new Set(filtered.map(r => r.id))) }, L('全选', 'Select all')),
            h('button', { style: s.btn(), onClick: () => setPicked(new Set()) }, '清空'),
            h('span', { style: s.label }, `共 ${filtered.length} 个，已选 ${picked.size}`),
          ),
          h('div', { style: s.list },
            ...filtered.slice(0, 300).map(r => h('label', { key: r.id, style: s.item },
              h('input', {
                type: 'checkbox', checked: picked.has(r.id), style: { marginTop: 3 },
                onChange: () => setPicked((prev) => {
                  const next = new Set(prev);
                  if (next.has(r.id)) next.delete(r.id); else next.add(r.id);
                  return next;
                }),
              }),
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { style: s.title }, r.title || `${L('未命名会话', 'Untitled session')} · ${String(r.id).slice(-8)}`),
                h('div', { style: s.meta }, fmtTime(r.updatedAt)),
              ),
              r.imported ? h('span', { style: s.tag(C.ok) }, '导入') : null,
            )),
          ),
          h('div', { style: s.row },
            h('button', {
              style: { ...s.btn('primary'), opacity: picked.size === 0 || busy ? 0.5 : 1 },
              disabled: picked.size === 0 || busy, onClick: run,
            }, busy ? '导出中' : `导出已选 ${picked.size} 个`),
            picked.size === 1 ? h('a', {
              style: { ...s.btn(), textDecoration: 'none' },
              href: `${API.markdown}?sessionId=${encodeURIComponent([...picked][0])}`,
            }, L('下载这一个的 Markdown', 'Download this one as Markdown')) : null,
            done ? h('a', {
              style: { ...s.btn(), textDecoration: 'none' },
              href: `${API.download}?name=${encodeURIComponent(done.name)}`,
            }, `下载 ${done.name}`) : null,
          ),
          done ? h('div', { style: s.hint }, `已导出 ${done.exported} 个，${fmtSize(done.bytes)}${done.failed ? `，失败 ${done.failed} 个` : ''}`) : null,
          error ? h('div', { style: s.err }, error) : null,
        ),
      );
    }

    // 设置段：读写插件配置。改动写回 profile 补丁，插件会重启一次。
    function SettingsPanel() {
      const [config, setConfig] = useState(null);
      const [draft, setDraft] = useState({});
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState('');
      const [error, setError] = useState('');
      const [cacheInfo, setCacheInfo] = useState(null);
      const [cacheBusy, setCacheBusy] = useState(false);
      const [cacheMsg, setCacheMsg] = useState('');
      const [originalInfo, setOriginalInfo] = useState(null);

      const loadCache = useCallback(async () => {
        setCacheBusy(true);
        try {
          const d = await getJson(API.originals);
          setCacheInfo({ bytes: d.cache?.bytes ?? 0, files: d.cache?.files ?? 0 });
          setOriginalInfo({ bytes: d.originals?.bytes ?? 0, files: d.originals?.files ?? 0 });
        } catch { /* 读不到就不显示数字 */ }
        finally { setCacheBusy(false); }
      }, []);

      const clearOriginals = async () => {
        setCacheBusy(true); setCacheMsg('');
        try {
          const d = await postJson(API.originalsClear, {});
          setCacheMsg(`${L('原图已清', 'Originals cleared')} ${d.files ?? 0} ${L('张，释放', 'images, freed')} ${fmtSize(d.bytes ?? 0)}`);
          await loadCache();
        } catch (e) { setCacheMsg(e.message); }
        finally { setCacheBusy(false); }
      };

      const clearCache = async () => {
        setCacheBusy(true); setCacheMsg('');
        try {
          const d = await postJson(API.cacheClear, {});
          setCacheMsg(`${L('已清理', 'Cleared')} ${d.files ?? 0} ${L('个文件，释放', 'files, freed')} ${fmtSize(d.bytes ?? 0)}`);
          await loadCache();
        } catch (e) { setCacheMsg(e.message); }
        finally { setCacheBusy(false); }
      };

      useEffect(() => {
        getJson(API.settings).then((d) => { setConfig(d.config ?? {}); setDraft(d.config ?? {}); }).catch((e) => setError(e.message));
        loadCache();
      }, [loadCache]);

      const set = (k, v) => setDraft((prev) => ({ ...prev, [k]: v }));
      const dirty = config !== null && Object.keys(draft).some(k => draft[k] !== config[k]);

      const save = async () => {
        setBusy(true); setError(''); setMsg('');
        try {
          const patch = {};
          for (const k of Object.keys(draft)) if (draft[k] !== config[k]) patch[k] = draft[k];
          await postJson(API.settingsSave, { patch });
          setMsg('已保存，插件会重启一次使配置生效');
          setConfig(draft);
        } catch (e) { setError(e.message); }
        finally { setBusy(false); }
      };

      const toggle = (k, label, hint) => h('div', { style: s.switchRow },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
          h('span', { style: { fontSize: 13, color: C.label1 } }, label),
          hint ? h('span', { style: s.hint }, hint) : null,
        ),
        h('input', {
          type: 'checkbox',
          checked: Boolean(draft[k]),
          disabled: config === null,
          onChange: (e) => set(k, e.target.checked),
        }),
      );

      const choose = (k, label, options, hint) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 0' } },
        h('span', { style: { fontSize: 13, color: C.label1 } }, label),
        hint ? h('span', { style: s.hint }, hint) : null,
        h('div', { style: s.row },
          ...options.map(([value, text]) => h('button', {
            key: value,
            style: {
              ...s.btn(draft[k] === value ? 'primary' : undefined),
              fontSize: 12, padding: '5px 11px',
            },
            disabled: config === null,
            onClick: () => set(k, value),
          }, text)),
        ),
      );

      if (config === null) return h('div', { style: s.card }, h('div', { style: s.hint }, error || '正在读取配置'));

      return h('div', { style: s.page },
        h('div', { style: s.card },
          toggle('searchPreset', '导入的会话带联网搜索', '关掉后导入会话用官方精简工具集，恢复对话时不带搜索'),
          toggle('provenance', '写入来源说明', '在每轮对话开头加一行说明，讲清这段记录的来历'),
          toggle('images', '导入图片（实验性）', '按需开启。图片按长边 2048 与质量八成五适度压缩，失败的单张只留文件名'),
          choose('timeStrategy', '时间处理', [['original', '保留原始时间'], ['import-time', '改写为导入时间']], '保留原始时间会还原真实顺序，老会话排在侧栏靠下'),
          choose('toolSummary', '检索过程怎么显示', [['line', '一行摘要'], ['queries', '带检索词'], ['off', '不显示']], '联网检索的过程只影响展示，不影响导入内容'),
          choose('tier', '性能档位', [['auto', '自动'], ['low', '低'], ['mid', '标准'], ['high', '高']], '自动会按设备核数与可用内存选档，并在导入时按实测速度下调'),
          h('div', { style: { ...s.card, marginTop: 6, background: C.bg2 } },
            h('div', { style: { fontSize: 13, color: C.label1 } }, L('附件缓存', 'Attachment cache')),
            h('div', { style: s.hint },
              L('看图时生成的临时文件。超过七天没用会自动清一次，也可以现在清。', 'Temporary files made while viewing images. Cleared automatically after seven days, or now.'),
            ),
            h('div', { style: s.row },
              h('span', { style: s.label }, cacheBusy ? L('读取中', 'Reading') : `${L('看图缓存', 'View cache')} ${fmtSize(cacheInfo?.bytes ?? 0)}`),
              h('button', {
                style: { ...s.btn(), fontSize: 12, padding: '5px 11px' },
                disabled: cacheBusy || (cacheInfo?.files ?? 0) === 0,
                onClick: clearCache,
              }, L('清理', 'Clear')),
            ),
            h('div', { style: s.row },
              h('span', { style: s.label }, `${L('原图存档', 'Originals')} ${fmtSize(originalInfo?.bytes ?? 0)}（${originalInfo?.files ?? 0} ${L('张', 'images')}）`),
              h('a', {
                href: API.originalsInfo, target: '_blank', rel: 'noreferrer',
                style: { ...s.btn(), fontSize: 12, padding: '5px 11px', textDecoration: 'none' },
              }, L('明细', 'Details')),
              h('button', {
                style: { ...s.btn(), fontSize: 12, padding: '5px 11px' },
                disabled: cacheBusy || (originalInfo?.files ?? 0) === 0,
                onClick: clearOriginals,
              }, L('清理', 'Clear')),
            ),
            cacheMsg ? h('div', { style: { ...s.hint, color: C.ok } }, cacheMsg) : null,
          ),
          h('div', { style: s.row, marginTop: 4 },
            h('button', {
              style: { ...s.btn('primary'), opacity: !dirty || busy ? 0.5 : 1 },
              disabled: !dirty || busy,
              onClick: save,
            }, busy ? '保存中' : '保存'),
            dirty ? h('span', { style: s.hint }, '有未保存的改动') : null,
          ),
          msg ? h('div', { style: { ...s.hint, color: C.ok } }, msg) : null,
          error ? h('div', { style: s.err }, error) : null,
        ),
      );
    }

    function Page() {
      const [tab, setTab] = useState('import');
      return h('div', { style: s.page },
        h('div', { style: { fontSize: 16, fontWeight: 600, color: C.label1 } }, TITLE),
        h('div', { style: s.hint }, L('选压缩包，勾会话，点导入。', 'Pick the archive, tick conversations, press Import.')),
        h('div', { style: s.tabs },
          h('button', { style: s.tab(tab === 'import'), onClick: () => setTab('import') }, L('导入', 'Import')),
          h('button', { style: s.tab(tab === 'export'), onClick: () => setTab('export') }, L('导出', 'Export')),
          h('button', { style: s.tab(tab === 'settings'), onClick: () => setTab('settings') }, L('设置', 'Settings')),
        ),
        tab === 'import' ? h(ImportPanel) : tab === 'export' ? h(ExportPanel) : h(SettingsPanel),
      );
    }

    // 侧栏进度：任务跑起来时在底部动作位显示一条紧凑进度
    function SidebarProgress() {
      const [status, setStatus] = useState(null);
      useEffect(() => {
        let alive = true;
        const tick = async () => {
          try {
            const d = await getJson(API.status);
            if (alive) setStatus(d.status ?? null);
          } catch { /* 忽略单次失败 */ }
        };
        tick();
        const timer = setInterval(tick, 1500);
        return () => { alive = false; clearInterval(timer); };
      }, []);

      if (!status?.running) return null;
      const pct = status.total > 0 ? Math.round((status.done / status.total) * 100) : 0;
      return h('div', {
        title: `${status.done} / ${status.total}${status.failed ? `，失败 ${status.failed}` : ''}`,
        style: { display: 'flex', flexDirection: 'column', gap: 4, padding: '4px 8px', minWidth: 96 },
      },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 10, color: C.label2 } },
          h('span', null, status.kind === 'export' ? L('导出', 'Export') : L('导入', 'Import')),
          h('span', null, `${pct}%`),
        ),
        h('div', { style: { ...s.bar, height: 4 } }, h('div', { style: s.fill(pct) })),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const disposers = [];
          const slots = ctx.slots;
          if (!slots?.inject || !slots?.register) return undefined;

          // 设置页：主座位不存在就退到插件设置标签页。label 是导航条目上的文字，必须给。
          const registerPageIn = (slotName) => {
            try {
              const dispose = slots.inject(slotName, () => slots.register(
                { name: slotName, id: 'dsh-session-history', order: 80, label: TITLE },
                Page,
              ));
              disposers.push(dispose);
              return true;
            } catch { return false; }
          };
          if (!registerPageIn('settings.section')) registerPageIn('settings.plugins.tab');

          // 侧栏底部动作位的紧凑进度，任务跑起来才显示
          try {
            const dispose = slots.inject('sidebar.footer.action', () => slots.register(
              { name: 'sidebar.footer.action', id: 'dsh-session-history-progress', order: 90, label: TITLE },
              SidebarProgress,
            ));
            disposers.push(dispose);
          } catch { /* 座位不存在就只在设置页里看进度 */ }

          return () => {
            for (const d of disposers) { try { d?.(); } catch { /* 已卸载 */ } }
          };
        }, 'session-history ui');
      },
    };
  },
});
