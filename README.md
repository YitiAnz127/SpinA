# SpinA

基于 Pi 1.1.0 原生 TUI 的尖晶石制备 agent。只蒸馏按目标尖晶石相金属集合匹配样品、展开原文制备方法所需的信息，不制作完整论文卡片。

## 启动

需要 Node.js 22.19 或以上版本。在项目目录运行：

```powershell
npm install
npm start
```

在 TUI 中用 `/login` 配置提供商认证，或沿用已有 Pi 认证及模型配置。也可以使用提供商的环境变量。`/model` 选择模型，`/spina` 查看 harness 状态。

项目复用 Pi 的提供商配置与认证，启动时不加载其他全局／项目扩展、skill、prompt template、AGENTS.md 或 MCP。仅显式加载本项目的 `src/spina.ts` 和 `src/skills/pdf-extraction/SKILL.md`，PDF 技能正文直接加入主对话与蒸馏／核验提示，内置编码工具默认关闭。模型会话历史保存于项目的 `.runtime/sessions/`，不建立用户档案。

## 会话与运行参数

```powershell
# 恢复最近一次项目会话
npm start -- --continue

# 打开会话选择器
npm start -- --resume

# 指定模型（替换为已配置的 provider/model）
npm start -- --model provider/model

# 查看 Pi 参数
npm start -- --help
```

TUI 内可使用 `/new`、`/resume`、`/model` 和 `/login` 等 Pi 原生命令。问答启动默认固定为 `openai-codex/gpt-6.1-sol`、`low`，独立核验始终使用该模型与强度；蒸馏和修正沿用 DeepSeek Flash/high。按 Esc 取消当前回答，输入 `/quit` 退出。

## 蒸馏与核验

单篇任务先蒸馏和核验；核验反馈自动交给 DeepSeek 修正并重新核验，最多修正 3 次。通过时提前结束；最后一次保守收敛，剩余问题带疑惑标记入库并可检索。授权批处理默认同时处理两篇，可通过 `SPINA_BATCH_CONCURRENCY` 设为 1–4。

蒸馏复用 SpinA `/login` 保存的 DeepSeek API Key，无需重复填写。也可以在项目 `.env` 中配置 `DEEPSEEK_API_KEY` 来覆盖已有认证；`npm start` 和 `npm run batch` 自动加载 `.env`，系统环境变量优先。不要将密钥发到聊天中。`.env` 已被 Git 忽略，`.env.example` 只包含空密钥与默认设置：

```dotenv
DEEPSEEK_API_KEY=
SPINA_DISTILL_MODEL=deepseek-flash
SPINA_DISTILL_EFFORT=high
```

请求固定发送到 `https://api.deepseek.com/chat/completions`。按用户选择开启思考模式、使用 `high`，JSON 模式只取最终答案，不把思维链写入结果或日志。`SPINA_DISTILL_EFFORT` 可设 `low`、`high`、`max`；官方的 `medium` 会映射为 `high`。默认 Flash 支持原始 PDF 页图；可配置 `deepseek-v4-pro`，但带页图的任务会明确报错，因为该模型不支持图像，程序不会静默丢图。[官方模型说明](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) · [思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/) · [图像输入](https://api-docs.deepseek.com/zh-cn/guides/vision/)

在 TUI 中选择并配置模型后，可以输入：

```text
/distill SPINA-0100
```

也可以直接要求“蒸馏 SPINA-0100”。已有题录读取自 `data/literature/selected-500.jsonl`；来源按 `data/paper/.doi_index.json` 和 DOI 命名文件查找。程序会区分正文和 SI、去除文本完全相同的副本。实际来源可以通过 `inspect_paper_sources` 工具查看；需要精确指定版本时传入 `sources` 文件列表。

新增论文先放入 `data/paper/`，再提供独立的 `paper_id`、真实 DOI、题名及正文／SI 路径。可用 `/distill` 后接 JSON，或在对话中提供这些信息让主 agent 调用工具。JSON 参数结构如下，尖括号内容须替换为真实资料：

```json
{
  "paper_id": "LOCAL-0001",
  "doi": "<真实 DOI>",
  "title": "<真实题名>",
  "sources": [
    { "path": "data/paper/new-paper.pdf", "kind": "body" },
    { "path": "data/paper/new-paper-si.pdf", "kind": "si" }
  ]
}
```

新增论文发布后，可以只提供同一个 `paper_id` 再次执行，复用已保存的题录和来源。补入 SI 或替换正文时，`sources` 应提供本次要使用的完整文件列表，包括保留的正文。新增论文不必加入原始 500 条发现清单。

执行顺序：

1. PDF 逐页提取文本、布局文本和表格，保留来源 ID 和 PDF 页码。扫描页自动进行本地 OCR 并保留原页图；配置 Poppler 后同时提供全部原始页图，供抽取和核验读取上下标及表格。只有 SI 或 OCR 后仍无可读文本时停止，待补正文或清晰来源。
2. 蒸馏目标相、必要样品分支、原料用量、制备操作与条件。省略空字段，不抽取实测组成、相纯度指标、性能、表征、背景和机理。
3. 程序检查结构、证据、数值与引用；另一次模型请求只核验来源、目标相归属、关键样品与制备事实，不输出逐字段通过清单。
   核验 agent 直接对照原文检查完整草稿与实际回答工具输出 `reader_view`，不另设独立建立样品与事实基准的阶段或模型调用。按共用步骤展开后检查子样品未知约束是否生效，并在同次核验中反查缺样和遗漏。不能只看到草稿备注正确就通过，也不能因简化输出而丢失关键限定。
   程序只硬阻断不存在的证据页、断裂引用、确定的数值或公式冲突等。等价 LaTeX 公式按排版规范化，共用原料按明确引用归到样品；OCR、名称释义、读图引文差异作为 `review_notes` 交给核验 agent。自行推导的配比仍不能作为原文报告的制备条件发布。
4. 反馈自动交给 DS 修正，最多 3 次。第三次要求删除无依据推算、将无法确认的字段标为未知，不隐藏问题；按核验中的实质错误、覆盖和未解决问题选用更贴近要求的可用版本，避免后续退步。通过则确认入库；仍有疑惑则带标记入库。来源未确认、无法解析且没有可用版本时不入实验库。

两个角色分别发起独立请求，没有主对话历史或编码工具。正常任务只需 2 次调用；最多追加 3 次修正与各自核验。格式失败也计入修正上限，未变化的草稿不重复核验。按 Esc 使用 Pi 原生取消，取消不入库。

## 数据与状态

- `data/paper/`：原始正文和 SI，蒸馏程序不修改它们。
- `data/distillation/spina.sqlite`：当前已发布的结构化实验、修订号与任务状态。数据库不复制全文、不保存向量。
- `data/distillation/runs/<run_id>/record.json`：精简交付，只有论文、来源和样品；样品包含目标相与可匹配金属、原料、制备步骤与条件、页码及必要问题说明，空字段不输出。草稿、核验与程序检查另存于同一目录。
- `data/distillation/records.json`：本次整理的 8 篇确认入库记录精简快照；后续运行的最新结果以各任务 `record.json` 或结果工具为准。

`get_distillation_result` 可按 `paper_id` 读取已入库记录，或按 `run_id` 读取状态。`published` 表示确认入库；`published_uncertain` 表示带疑惑入库，结果 JSON 顶层为 `status=uncertain` 并包含问题。疑惑版本保存在 `uncertain_papers`，不覆盖既有确认版本；无确认版本时默认可读，`version=uncertain`可指定读取。确认通过后清除旧疑惑版本。

`search_spinel_experiments` 按金属集合检索，默认同时返回确认和疑惑版本。结果保留 `certainty`、`possible` 和问题；疑惑的潜在元素集合只作可能匹配，交付 JSON 放在 `possible_metals`，不冒充确定的 `metals`。

交付 JSON 保留原文单位和表达，已报告事实直接展示；不确定事实保留状态与必要说明。匹配金属由程序从目标相化学式或有依据的 `metal_elements` 派生，只有核验允许匹配时才输出 `phases.metals`。载体、添加物和前驱体不并入目标相集合；变量可能为零且未确定时不生成确定匹配项。数据库保留完整证据与修订信息，兼容旧记录。
`variables` 仅保留制备配比、系列组成参数和处理差异；用量和浓度的计量基准、关键缺失及共用步骤关系必须保留，确保可以展开具体样品的方法。晶格常数、实测缺氧量等表征变量不进入精简结果。
`not_reported` 等变量和条件也保留状态与必要说明，作为对父流程的限制；重复次数、还原时间等未知值不能被父步骤中的数字填补。步骤、方法和条件的关键note一并传给问答模型。

原始页面图像供模型核读文字、化学式及表格，不自行从 XRD 图谱推断作者未报告的相。页面图保存在 `data/distillation/pages/` 并缓存，原始 PDF 不修改。金属集合检索已接入；跨库条件查询和 RAG 尚未接入。

## 页面图像与授权批处理

先运行 `npm install`，再运行 `npm run setup:pdf` 配置 PDF 提取依赖。该命令复用可用 Python；缺少依赖时在项目 `.runtime/pdf-python/` 创建环境并按 `requirements-pdf.txt` 安装。英文和简体中文 Tesseract 识别模型下载至 `.runtime/tessdata/`，PDF 和识别过程均留在本机。OCR 使用 `tesseract.js` 的 Tesseract 引擎，无需单独安装 Windows Tesseract 程序。

Python 路径保存于 `.runtime/pdf-tools.json` 的 `python` 字段，也可用 `SPINA_PDF_PYTHON` 覆盖。`SPINA_OCR_LANGUAGES` 默认 `eng+chi_sim`，`SPINA_OCR_LANG_PATH` 可指定已有识别模型目录。提取使用 `pdfplumber`，文字提取失败时用 `pypdf`；未配置 Python 时仍可通过 PDF.js 读取普通文字层，并明确标注没有结构化表格提取／OCR。已配置的后端出错会如实报错。

在 SpinA 中可直接要求“提取 data/paper/某论文.pdf 第 1–3 页的文字和表格”，或“读取 SPINA-0100 第 2 页”。`read_paper_pages` 返回来源、页码、文字、布局文本、表格、提取方式及原页图，默认返回前 5 页，每次最多 20 页；可单独读取 SI，无需蒸馏或入库。扫描表格提供 OCR 文字与原页图，不能保证自动恢复其行列结构。OCR 结果中的公式、上下标及数值仍须对照原图核验。

通过环境变量 `SPINA_PDFTOPPM_PATH` 指定 Poppler 的 `pdftoppm`，或在项目的 `.runtime/pdf-tools.json` 中配置 `pdftoppm` 字段。未配置时只提供 OCR 页的原图，普通文本页不能声称使用了图像证据。图像位置、来源 ID 与页码会一起传给两个 agent，已发布来源清单保存图像位置。

用户明确授权处理其余论文后，可运行：

```powershell
npm run batch -- --after SPINA-0005
```

批处理使用 DeepSeek 官方 API 蒸馏（默认 Flash/high）；核验固定使用已有 ChatGPT OAuth、`openai-codex/gpt-6.1-sol`、`low`。来源缺失单列，已有发布记录默认跳过。缓存必须同时符合来源、提示词、提供商、模型和思考强度，强度不一致的旧核验结果不复用；失败时不静默切换模型或降低强度。

检查已有 DS 草稿而不修正：`npm run batch -- --only SPINA-0006,SPINA-0007,SPINA-0008 --check-only`。对这些草稿自动修正并入库：将标志改为 `--repair-existing`。两种模式都确认来源未变化并保留原始蒸馏回复；修正模式最多新增 3 次 DS 修正请求。

在 `data/distillation/batch/control.json` 写入 `{"stop":true}` 可在当前论文完成或等待期间停止；继续前清除该标记，再执行同一命令。不要同时启动多个批处理进程。

## 开发

```powershell
npm run check
npm test
```

- `src/cli.mjs`：固定项目工作目录，启动本地 Pi，配置加载范围及项目会话目录。
- `src/spina.ts`：项目 extension，注册领域工具和 `/distill`、`/spina` 命令。
- `src/system-prompt.md`：对话定位与回答约定。
- `src/skills/pdf-extraction/SKILL.md`：从 Codex PDF 技能适配的文字、表格、OCR 和原页核对工作流。
- `src/distillation/pdf-extraction.ts`：Python 提取与本地 Tesseract OCR 适配。
- `package-lock.json`：锁定依赖版本。npm 缓存保存在 `.npm-cache/`。
- `src/distillation/prompts/distill.md`、`verify.md`：只关注目标相匹配与制备方法；运行时附精简 JSON schema。
- `src/distillation/agents.ts`：蒸馏与核验角色。
- `src/distillation/deepseek.ts`：DeepSeek 官方 API、JSON 和页图适配，以及按阶段路由。
- `src/distillation/documents.ts`：题录查找、PDF 解析和来源边界。
- `src/distillation/schema.ts`：数据合同、证据校验和元素集合派生。
- `src/distillation/pipeline.ts`：一次蒸馏、一次核验和发布流程。
- `src/distillation/store.ts`：SQLite 与逐轮 JSON 产物。
- `src/distillation/tools.ts`：Pi 模型适配与领域工具入口。

测试使用合成 PDF 和确定性的模型响应覆盖流程与数据边界，不需要提供商认证。真实论文的科学事实质量仍须在实际蒸馏中核查。
