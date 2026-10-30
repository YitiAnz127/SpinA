# SpinA

把尖晶石制备文献变成**可按金属集合检索的结构化实验记录**的 agent 工具。

给定一批论文 PDF，SpinA 逐页提取文字、表格与页图，蒸馏出目标相、样品分支、原料用量、制备步骤与条件，再由一个独立的核验模型对照原文复核，最后写入本地 SQLite。之后的检索只读数据库，不再调用模型或读取 PDF。

- 运行在 [Pi](https://github.com/badlogic/pi-mono) 1.1.0 原生 TUI 之上，11 个领域工具通过扩展注册。
- 蒸馏使用 DeepSeek 官方 API，核验固定使用 `openai-codex/gpt-6.1-sol`。
- 只做信息结构化，不判断论文结论是否正确，也不生成新配方。

## 它能做什么
- 按目标尖晶石相的金属集合匹配样品，展开每个样品的制备方法（原料、配比、步骤、温度/时间/气氛等）。
- 区分正文与 SI，扫描页本地 OCR，页图按来源与内容摘要隔离缓存。
- 记录缺项（原文未报告）、来源限制（原文含糊/自相矛盾）与抽取问题（记录偏离原文），三者分开表达。
- 支持确认入库与“带疑惑入库”两种版本，检索时保留 `certainty`、`possible` 与问题说明。
- 单篇处理与批量队列（并发 1–4）。


## 前置条件

| 依赖 | 是否必需 | 说明 |
| --- | --- | --- |
| Node.js ≥ 22.19 | 必需 | 使用内置 `node:sqlite`，运行时会打印 `ExperimentalWarning: SQLite is an experimental feature`，属预期。 |
| DeepSeek API Key | 必需 | 蒸馏与修正。可在 TUI 内 `/login` 保存，或在 `.env` 设置 `DEEPSEEK_API_KEY`。 |
| ChatGPT 账号（Plus/Pro）+ Pi OAuth | 必需 | 独立核验固定走 `openai-codex/gpt-6.1-sol`。未登录时工具会明确报错，不会静默换模型。 |
| Python 3.9+ | 可选 | 表格/版面提取（`pdfplumber`、`pypdf`、`pypdfium2`）。不配置时退回 PDF.js 纯文字层。 |
| Poppler (`pdftoppm`) | 可选 | 普通文本页的原页图。未配置时只提供 OCR 页的原图。 |
| Tesseract 语言包 | 可选 | 由 `npm run setup:pdf` 下载至 `.runtime/tessdata/`；OCR 由 `tesseract.js` 执行，无需安装系统 Tesseract。 |

## 快速开始

```powershell
git clone https://github.com/YitiAnz127/SpinA.git
cd SpinA
npm install

# 可选：配置 PDF 提取（创建 .runtime/pdf-python/、安装 requirements-pdf.txt、下载 OCR 语言包）
npm run setup:pdf

# 配置蒸馏密钥（也可以进 TUI 后 /login）
Copy-Item .env.example .env
# 编辑 .env，填写 DEEPSEEK_API_KEY=

# 准备论文目录
New-Item -ItemType Directory -Force data\paper | Out-Null

npm start
```

进入 TUI 后：

1. `/login` 配置 DeepSeek 与 ChatGPT（OpenAI Codex）认证；`/model` 选择对话模型。
2. 把 PDF 放进 `data/paper/`。
3. `/spina` 查看 harness 状态，`/distill <paper_id>` 开始单篇任务。

启动时不会加载其他全局／项目扩展、skill、prompt template、AGENTS.md 或 MCP；只加载本项目的 `src/spina.ts` 与 `src/skills/pdf-extraction/SKILL.md`。模型会话历史保存在项目的 `.runtime/sessions/`。

## 单篇蒸馏

已有题录（`data/literature/selected-500.jsonl` 中存在的 `paper_id`）可以只给 ID：

```text
/distill SPINA-0001
```

新论文不需要任何清单，直接提供 `paper_id`、真实 DOI、题名与文件列表：

```json
{
  "paper_id": "LOCAL-0001",
  "doi": "10.1234/example.2026.001",
  "title": "论文真实题名",
  "sources": [
    { "path": "data/paper/new-paper.pdf", "kind": "body" },
    { "path": "data/paper/new-paper-si.pdf", "kind": "si" }
  ]
}
```

在对话中把这段 JSON 交给 agent，或 `/distill` 后接 JSON。规则：

- `paper_id` 只能包含字母、数字、下划线和连字符，建议 `LOCAL-0001` 这类自有前缀。
- `doi` 必须形如 `10.xxxx/...`；`sources` 为 1–8 个文件，单个不超过 50 MiB，且必须在 `data/paper/` 内。
- 发布过一次后，再跑只需同一个 `paper_id`；补 SI 或换正文时，`sources` 要给本次使用的完整文件列表（包括保留的正文）。

执行流程：

1. **提取**：PDF 逐页提取文字、布局文本与表格，保留来源 ID 与原始页码；扫描页本地 OCR 并保留原页图。
2. **蒸馏**：目标相、必要样品分支、原料用量、制备操作与条件；省略空字段。
3. **核验**：另一个角色直接对照原文检查草稿与实际工具输出 `reader_view`，检查目标相归属、关键样品与制备事实、共用步骤的子样品约束，并反查缺样与遗漏。
4. **修正**：核验反馈交回 DeepSeek，最多 3 次。第三次要求删除无依据推算、把无法确认的字段标为未知。通过则确认入库；仍有疑惑则带标记入库。

两个角色分别发起独立请求，没有主对话历史或编码工具。正常任务 2 次调用；格式失败也计入修正上限；未形成可解析修正稿时不重复核验。按 Esc 取消，取消不入库。身份不符、没有相关实验或没有可核验样品时，结论与原始草稿保存在任务记录中，不发布成可检索实验。

## 批处理

批处理需要一个论文清单：`data/literature/selected-500.jsonl`，每行一个 JSON：

```json
{"paper_id":"SPINA-0001","doi":"10.1016/xxxx","title":"..."}
```

```powershell
# 处理编号大于 0005 的全部论文
npm run batch -- --after SPINA-0005

# 只处理指定论文
npm run batch -- --only SPINA-0006,SPINA-0007,SPINA-0008

# 只检查已有 DeepSeek 草稿，不修正、不入库
npm run batch -- --only SPINA-0006 --check-only

# 对已有草稿自动修正并入库
npm run batch -- --only SPINA-0006 --repair-existing
```

- 默认并发 2 篇，`SPINA_BATCH_CONCURRENCY` 可设 1–4。
- 批处理与交互工具均使用定点补丁修正，保留未改字段；最多修正 3 次，最后一次按保守收敛规则处理。新回复和缓存回复均先做结构校验。
- 来源缺失的论文单列，已有发布记录默认跳过。
- 任务失败时用 `error_kind` 区分超时、取消、配额、网络、结构及来源问题。网络与超时最多重试 2 次；用户取消、结构错误不会触发自动重试，配额耗尽沿用等待恢复机制。默认 20 分钟请求超时不变。
- 在 `data/distillation/batch/control.json` 写入 `{"stop": true}` 可在当前论文完成或等待期间停止；继续前清除该标记，再执行同一命令。
- 不要同时启动多个批处理进程。

## 数据与产物

仓库只带代码；`data/` 全部由使用者自备（见 `data/README.md`）。

| 路径 | 内容 |
| --- | --- |
| `data/paper/` | 原始正文与 SI。程序只读，不修改。 |
| `data/literature/selected-500.jsonl` | 可选，批处理清单。 |
| `data/distillation/spina.sqlite` | 已发布的结构化实验、修订号、任务状态。不复制全文、不保存向量。 |
| `data/distillation/runs/<run_id>/record.json` | 单次任务的精简交付：论文、来源、样品（目标相与可匹配金属、原料、步骤与条件、页码、问题说明）。草稿、核验与程序检查另存同目录。 |
| `data/distillation/pages/` | 页图缓存，按完整来源路径与 PDF 内容摘要隔离版本。 |
| `data/distillation/batch/` | 批处理队列、每次调用的缓存与日志。 |

### 演示知识库

仓库自带一份生成好的知识库快照 `data/demo/spina.sqlite`（约 14 MB）：140 篇确认入库、255 篇待核对、978 条任务状态。复制到运行时位置即可直接检索：

```powershell
New-Item -ItemType Directory -Force data\distillation | Out-Null
Copy-Item data\demo\spina.sqlite data\distillation\spina.sqlite
```

之后 `search_spinel_experiments` 与 `get_distillation_result` 立即可用，不调用模型、不读取 PDF。库内是结构化制备信息、DOI 题录、证据页码与用于核对的短引文，以及生成时的来源文件相对路径（仅路径，不含 PDF 内容）。想换成自己的语料时，删除该文件重新蒸馏即可。

## 领域工具

| 工具 | 用途 |
| --- | --- |
| `distill_paper` | 单篇蒸馏 + 核验 + 发布。 |
| `resume_distillation_run` | 复用已有 DeepSeek 输出继续核验与返工。 |
| `read_paper_pages` | 按原始页码读取文字、布局文本、表格与原页图；每次最多 20 页，不调用模型、不入库。 |
| `inspect_paper_sources` | 查看某论文实际解析到的来源（正文/SI、页数、提取方式）。 |
| `get_distillation_result` | 按 `paper_id` 读已入库记录，或按 `run_id` 读任务状态。 |
| `get_sample_preparation` | 读取指定版本的单个样品及其共用祖先流程，保留各层步骤、差异、短引文和限制，供主模型展开方法。 |
| `get_preparation_evidence` | 按样品及字段 ID 反查锁定版本的原始值、状态、限定和库存短引文，不依赖 PDF。 |
| `search_spinel_experiments` | 按金属集合检索样品。 |
| `search_preparation_conditions` | 跨论文按同一步骤的温度、时长及原料名称筛选字段候选，保留版本、字段证据和待复核情况。 |
| `repair_uncertain_paper` | 对指定疑惑记录做定点修正。 |
| `sync_verified_matching` | 同步已核验记录的金属匹配索引。 |

## 检索与记录语义

`search_spinel_experiments` 默认 `match=exact`，要求目标相金属集合恰好一致；`match=superset` 单独查询含额外金属的补充体系；`related` 只返回补充体系的条目计数。`include_uncertain=false` 排除疑惑版本与可能匹配项。

返回分页对象：`results` 是当前页，`total` 为符合条件的版本／样品／相条目数，`has_more` 与 `next_offset` 表示后续页。默认 `limit=20`、`offset=0`，每页最多 100 条。确认与疑惑并存的版本分别计数，不等于独立论文数或独立配方数。

每条结果携带 `record_ref={paper_id, version, revision, verified_at}`；展开具体样品时，将完整 `record_ref` 和 `sample_id` 传给 `get_sample_preparation`。只给论文 ID 时，先用 `get_distillation_result` 取得实际版本和样品 ID。版本被替换或移除时要求重新检索，不自动回退。发布时在同一事务内核对开始读取的确认版与疑惑版快照，任一被其他任务更新则拒绝覆盖并结束为失败。任务产物先写入文件；论文记录与任务的发布终态随后在同一个 SQLite 事务内提交，终态保存失败会回滚论文更新及旧疑惑版清除。

样品流程工具只读数据库，不额外调用模型或读取 PDF。`preparation.samples` 按共用祖先到所选样品排列，保留各层原始步骤顺序和对象 ID；主模型结合论文级 `notes`、样品差异和字段限定组织实际流程。数组顺序表示依赖关系，不能直接把所有步骤串联，也不能用父流程数值填补子样品明确的未知条件。循环引用、缺失祖先或不存在的样品会明确报错。

追问某个条件的依据时，用 `get_preparation_evidence` 传入同一 `record_ref`、目标 `sample_id` 及 `field_path`。路径使用原始样品 ID、步骤／原料／相 ID 和变量／条件名称，不使用数组下标；只能读取目标样品及其共用祖先。返回的 `fields` 列表逐项保存 `source_sample_id`、原始 `fact` 和步骤上下文。同名字段有多项时全部返回并标明 `ambiguous=true`，不任意选取或合并；`context` 保留继承限制。`evidence_scope=stored_record` 表示只读取库存证据，原件删除后仍可用，不代表本次重新核查原文。没有保存引文时不补造，`has_recorded_content=false` 的空默认字段也不等于作者未报告。

三种“问题”不混用：

- `missing_information`：原文未报告个别条件或外部方法未取得。主要制备信息完整时不阻止确认入库。
- `source_limitations`：原文自身含糊、数值冲突或产物未明确确认。不是抽取错误。
- `issues`：记录偏离原文的具体抽取问题（已确认错误或明确要求修正）。已确认错误不能靠 `source_limit` 标签变成论文限制。

已确认且影响匹配的错误按样品／目标相范围排除，不能继续进入 `possible` 候选；真实来源限制仍可保留为可能匹配。

疑惑版本（`published_uncertain` / `status=uncertain`）存入历史待核对表，不覆盖既有确认版本；它本身不等于存在抽取错误。确认入库也不等于科学正确性。

## 跨库条件筛选

可在对话中要求“筛选 Ni–Co 中退火温度低于 400℃、同一步保温 48 小时的记录”，或“找原料表列有尿素的样品”。`search_preparation_conditions` 至少需要温度、时长或原料条件之一；步骤关键词 `step_terms` 仅作附加过滤，不能单独使用，搭配原料条件时同样限制步骤。也可附金属集合条件。

- 温度查询使用 °C；时长可用 `s`、`min`、`h`、`d`，默认 `h`。范围默认包含端点，严格低于／高于可排除端点。库存单值的常见单位会换算，原始字段和短引文保留。
- 温度和时长须落在同一步，不能把干燥温度与另一煅烧步骤的时长拼成命中。共用祖先、未绑定步骤的样品变量、复杂范围和明确未知均需结合完整流程复核。
- 原料条件组之间取 AND，同组别名取 OR，按保存的名称或化学式字面匹配。`not_listed` 只表示库内未列出，不能证明实验实际没有使用。
- `include_uncertain` 默认 `true`，与金属检索一致，包含历史待核对版本及可能匹配项，结果分别保留版本与状态。设为 `false` 同时排除这两类，不改变详情读取时“确认版优先”的独立规则。
- `total` 按版本／样品计数；`field_matches` 是字段支持数，`needs_review` 为待复核候选，`unevaluable_samples` 表示缺少可比较字段。结果分页返回；展开时沿用 `record_ref` 和 `sample_id`，具体字段可继续反查。字段命中不等于整条路线最高温度或总时长满足。

该工具只读取 SQLite，不依赖 PDF、页图、向量索引或额外模型调用。主模型对要实际列为满足条件的样品，继续通过流程展开和证据反查判断适用范围。

## 知识库报告

`npm run report` 按当前数据库生成新的北京时间快照目录，包含报告、论文清单、样品清单、逐篇制备内容及完整结构化 JSON。它只读取 SQLite 和可选题录，不检查或要求保留 PDF，也不依赖特定批处理任务。数据库、题录和输出目录均须在项目内，目录链接也会核对实际目标；已有报告目录不会被覆盖。

默认运行使用当前库和项目题录。指定 `--database` 时默认只统计该数据库，可用 `--catalog` 显式加入对应 JSONL，快照会记录两者来源。坏 JSON、结构无效或身份不符的实验／任务逐行跳过，`records.json`、`summary.json` 及报告顶部会列出表名、论文或任务 ID 和原因，并注明统计不完整；损坏记录不混计为“未入库”。缺库、缺少实验表或输出路径错误会给出可读报错。

```powershell
npm run report
npm run report -- --output reports/my-snapshot
npm run report -- --database data/demo/spina.sqlite --output reports/demo-snapshot
npm run report -- --database data/demo/spina.sqlite --catalog data/literature/selected-500.jsonl --output reports/demo-with-catalog
```

## 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 空 | 蒸馏与修正的密钥；优先于 `/login` 保存的认证。 |
| `SPINA_DISTILL_MODEL` | `deepseek-flash` | 蒸馏模型。`deepseek-v4-pro` 不支持图像，带页图的任务会明确报错。 |
| `SPINA_DISTILL_EFFORT` | `high` | `low` / `high` / `max`；官方 `medium` 映射为 `high`。 |
| `SPINA_REPAIR_EFFORT` | `max` | 修正阶段独立使用的推理强度，取 `low` / `high` / `max`，不随蒸馏强度自动改变。 |
| `SPINA_BATCH_CONCURRENCY` | `2` | 批处理并发，1–4。 |
| `SPINA_PDF_PYTHON` | 自动探测 | 指定 Python 解释器；默认写入 `.runtime/pdf-tools.json`。 |
| `SPINA_OCR_LANGUAGES` | `eng+chi_sim` | Tesseract 语言组合。 |
| `SPINA_OCR_LANG_PATH` | `.runtime/tessdata` | 识别模型目录。 |
| `SPINA_PDFTOPPM_PATH` | 未设置 | Poppler `pdftoppm` 路径，用于普通文本页原页图。 |

请求固定发往 `https://api.deepseek.com/chat/completions`，JSON 模式只取最终答案，思维链不写入结果或日志。批处理缓存必须同时符合来源、提示词、提供商、模型与思考强度；强度不一致的旧结果不复用，失败时不静默切换模型或降低强度。

## 页面图像与 OCR

`npm run setup:pdf` 复用可用 Python，并核对三个提取库的实际安装版本与 `requirements-pdf.txt`。版本不一致会明确提示；缺少依赖时在 `.runtime/pdf-python/` 建环境并安装固定版本。`npm run setup:pdf -- --check` 只输出实际版本和核对结果，不安装、下载或改写配置；缺少依赖或版本不一致时返回非零状态。

提取用 `pdfplumber`，文字提取失败用 `pypdf`；未配置 Python 时仍可用 PDF.js 读普通文字层，并明确标注没有结构化表格提取／OCR。新导入时未配置 `pdftoppm`，没有页图的页面会在 `warnings` 中说明仅使用文字和表格；已有 OCR 原页图继续保留。OCR 语言模型目录须位于项目内，包括目录链接的实际目标。

原始页面图像供模型核读文字、化学式与表格，不从 XRD 图推断相。页图按完整来源路径与 PDF 内容摘要隔离缓存，同名文件或内容更新不会覆盖另一来源或旧版本的页图。OCR 结果中的公式、上下标与数值仍需对照原图核验。

## 已知限制

- **核验通道固定**：必须能通过 Pi 完成 ChatGPT OAuth 登录并使用 `openai-codex/gpt-6.1-sol`；没有该订阅时只能做提取与草稿，无法完成入库流程。
- **单目录工具**：论文必须位于 `data/paper/` 内，不能读取项目外部路径。
- **条件筛选范围**：支持库存步骤温度、时长和原料的字段候选筛选；复杂范围、未知和继承限制仍需展开复核，不自动推断整条路线的最高温度或总时长。RAG 尚未接入。
- **只在 Windows 实测**：脚本对 Windows/macOS/Linux 做了分支，但开发与验证环境是 Windows 11 + Node 24。
- **批处理单进程**：并发只在进程内，不支持多进程同时写同一数据库（有版本冲突保护，冲突会失败而非覆盖）。

## 开发

```powershell
npm run check   # .mjs 语法、TypeScript 与批处理 .mjs 严格类型检查
npm test        # node --test
```

测试使用合成 PDF 与确定性模型响应，不需要提供商认证。用例数量以 `npm test` 输出为准；未配置 Python 或 Poppler 时，相应 PDF 提取/OCR/页图用例自动 skip。真实论文的科学事实质量仍须在实际蒸馏中核查。

源码结构：

| 文件 | 职责 |
| --- | --- |
| `src/cli.mjs` | 固定项目工作目录，启动本地 Pi，配置加载范围与会话目录。 |
| `src/batch.mjs` | 批处理队列、并发、停止标记与来源校验。 |
| `src/batch-cache.ts` / `src/batch-retry.mjs` | 批处理缓存键与重试。 |
| `tsconfig.batch.json` | 批处理及其 I/O、重试脚本的严格 JavaScript 类型检查，纳入 `npm run check`。 |
| `src/report.mjs` | 从数据库和题录生成可独立使用的知识库快照报告。 |
| `src/setup-pdf.mjs` | 安装或只读核对 PDF 提取依赖及其固定版本。 |
| `src/model-policy.ts` | 核验模型与推理强度策略。 |
| `src/spina.ts` | 扩展入口，注册领域工具与 `/distill`、`/spina`。 |
| `src/system-prompt.md` | 对话定位与回答约定。 |
| `src/skills/pdf-extraction/` | PDF 技能说明与 Python/Node 提取脚本。 |
| `src/distillation/pdf-extraction.ts` | Python 提取与本地 Tesseract OCR 适配。 |
| `src/distillation/documents.ts` | 题录查找、PDF 解析与来源边界。 |
| `src/distillation/images.ts` | 页图渲染与缓存。 |
| `src/distillation/deepseek.ts` | DeepSeek 官方 API、JSON 与页图适配。 |
| `src/distillation/agents.ts` | 蒸馏与核验角色。 |
| `src/distillation/prompts/` | 蒸馏、修正、核验提示词。 |
| `src/distillation/schema.ts` | 数据合同、证据校验与元素集合派生。 |
| `src/distillation/pipeline.ts` | 一次蒸馏、核验、最多 3 轮修正与发布。 |
| `src/distillation/store.ts` | SQLite、版本、检索分页与逐轮产物。 |
| `src/distillation/missing-information.ts` / `source-version.ts` | 缺项归类与来源版本。 |
| `src/distillation/tools.ts` | Pi 模型适配与领域工具入口。 |
| `src/distillation/preparation.ts` | 锁定版本的样品与共用流程读取，保留步骤和条件原始归属。 |
| `src/distillation/evidence.ts` | 按对象 ID 定位制备字段，返回库存证据及适用范围上下文。 |
| `src/distillation/conditions.ts` | 跨库结构化条件筛选、保守单位换算及带版本的候选分页。 |

## 许可与合规

MIT License，见 `LICENSE`。

- 仓库不包含任何论文全文、出版商页面或抓取凭据；`data/` 被 `.gitignore` 整体排除（仅保留 `data/README.md`）。
- 使用者需自行确保所处理 PDF 的获取方式合法，并遵守出版商的文本与数据挖掘条款。
- 结构化结果可能包含论文摘录与原文表述，对外发布前请自行核对版权与引用规范。
