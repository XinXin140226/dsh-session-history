# dsh-session-history

把 DeepSeek 官方 App 导出的聊天包导入为 DSH 原生会话，也支持把 DSH 会话导出为 Markdown 与 zip。

状态：0.1.0。数据层、任务层、界面、路由与图片通道已在本机实测；界面观感待人工确认。

制作说明：本插件的代码与文档由 AI 助手在 DSH 中编写，使用 deepseek-v4.1-flash 1017 模型。文档描述与实际行为可能存在偏差，上传到仓库的文件同样是这台机器上生成的产物，请以自己的实测为准。遇到与本说明不符的地方，优先相信代码和运行结果。

## 当前能力

- 零依赖 zip 随机读取（lib/zip），已在 1992 会话的真实导出包上验证
- 导出包解析与归一化（lib/deepseek）
- 归一化会话到 DSH 事件的映射（lib/map），只发七种白名单事件
- 设备分档（lib/caps），按平台、核数、可用内存定低中高三档
- 导入调度（lib/plan/importer）：批量、进度、取消、失败隔离、幂等续跑
- 幂等映射表与任务锁（lib/store）
- 导出（lib/plan/exporter）：会话事件流到 Markdown，批量打包 zip，含清单
- Host 服务：清单、后台导入、导出、状态、取消
- 专用 Agent 预设：精简工具集加联网搜索
- Client 界面：设置导航独立页，三段为导入、导出、设置；清单支持搜索、分页、全选与快捷选择
- 侧栏进度：任务运行时在侧栏底部显示紧凑进度
- 界面路由：扫描本机导出包、读清单、导入、进度、取消、会话列表、导出、下载、单会话 Markdown、配置读写
- 设置页可改配置：保存走官方配置编辑器，写回 profile 补丁
- 图片导入（实验性）：交给 DSH 附件存储，超限图片由存储层重编码，单张失败不影响会话

## 自测

需要能解析到 `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-session-persistence-jsonl` 的环境（DSH 安装目录内已带）：

```
node scripts/selftest.mjs 3 /path/to/deepseek_data.zip
node scripts/test-import.mjs
node scripts/test-export.mjs
node scripts/lint-copy.mjs
```

自测只写 /tmp/selftest-root，不碰真实会话存储。

## 设计文档

见 docs/方案.md，含数据映射表、兼容性策略、性能指标与验证计划。

## 许可

MIT
