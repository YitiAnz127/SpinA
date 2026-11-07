# SpinA

把尖晶石制备文献变成**可按金属集合检索的结构化实验记录**的 agent 工具。

给定一批论文 PDF，SpinA 逐页提取文字、表格与页图，蒸馏出目标相、样品分支、原料用量、制备步骤与条件，再由一个独立的核验模型对照原文复核，最后写入本地 SQLite。之后的检索只读数据库，不再调用模型或读取 PDF。

- 运行在 [Pi](https://github.com/badlogic/pi-mono) 1.1.0 原生 TUI 之上，11 个制备领域工具与 10 个研究分析工具通过扩展注册。
- 蒸馏使用 DeepSeek 官方 API，核验固定使用 `openai-codex/gpt-6.1-sol`。
- 只做信息结构化，不判断论文结论是否正确，也不生成新配方。

## 它能做什么
- 按目标尖晶石相的金属集合匹配样品，展开每个样品的制备方法（原料、配比、步骤、温度/时间/气氛等）。
- 区分正文与 SI，扫描页本地 OCR，页图按来源与内容摘要隔离缓存。
- 记录缺项（原文未报告）、来源限制（原文含糊/自相矛盾）与抽取问题（记录偏离原文），三者分开表达。
- 支持确认入库与“带疑惑入库”两种版本，检索时保留 `certainty`、`possible` 与问题说明。
- 单篇处理与批量队列（并发 1–4），批处理带单实例锁与崩溃恢复入口。
- 离线只读浏览演示库，人工核对字段并留下审核记录，导出带版本绑定的候选对照，备份与恢复演练。
- 研究分析层：材料身份分层关联、样品状态谱系、论文内系列设计、论断分歧解释、竞争假设区分、结构计算任务准备。

## 三种启动场景

| 场景 | 命令 | 需要什么 | 不需要什么 |
| --- | --- | --- | --- |
| 浏览知识库 | `npm run demo` | Node ≥ 22.19、仓库自带的演示库 | 任何模型认证、PDF、网络 |
| 自然语言问答 | `npm start` | 一个可用的对话模型认证（`/login`、`/model`） | DeepSeek 密钥（仅检索时） |
| 新论文蒸馏 | `npm start` + `/distill` | 对话模型、DeepSeek 密钥、ChatGPT OAuth 核验 | PDF 提取依赖可缺省（会退化为纯文字层） |

先用 `npm run doctor` 确认当前场景缺什么；它会给出该场景的必需项与可选项，不会在未加 `--online` 时联网。

## 前置条件

| 依赖 | 是否必需 | 说明 |
| --- | --- | --- |
| Node.js ≥ 22.19 | 必需 | 使用内置 `node:sqlite`，运行时会打印 `ExperimentalWarning: SQLite is an experimental feature`，属预期。只读浏览、人工核对、导出与备份也只依赖它。 |
| DeepSeek API Key | 蒸馏必需 | 蒸馏与修正。可在 TUI 内 `/login` 保存，或在 `.env` 设置 `DEEPSEEK_API_KEY`。只读浏览与已有记录的检索不需要。 |
| ChatGPT 账号（Plus/Pro）+ Pi OAuth | 蒸馏必需 | 独立核验固定走 `openai-codex/gpt-6.1-sol`。未登录时工具会明确报错，不会静默换模型。自然语言问答另需一个可用对话模型。 |
| Python 3.9+ | 可选 | 表格/版面提取（`pdfplumber`、`pypdf`、`pypdfium2`）。不配置时退回 PDF.js 纯文字层。 |
| Poppler (`pdftoppm`) | 可选 | 普通文本页的原页图。未配置时只提供 OCR 页的原图。 |
| Tesseract 语言包 | 可选 | 由 `npm run setup:pdf` 下载至 `.runtime/tessdata/`；OCR 由 `tesseract.js` 执行，无需安装系统 Tesseract。 |

## 快速开始

```powershell
git clone https://github.com/YitiAnz127/SpinA.git
cd SpinA
npm install

# 1. 先看当前环境缺什么（不联网）
npm run doctor

# 2. 不需要任何密钥就能浏览自带演示库
npm run demo
npm run demo -- search --metals Ni,Co --limit 5

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

## 环境诊断

```powershell
npm run doctor                        # 只读浏览场景（默认）
npm run doctor -- --scenario ask      # 加对话模型检查
npm run doctor -- --scenario distill  # 加核验模型与 DeepSeek 密钥检查
npm run doctor -- --json              # 机器可读
npm run doctor -- --online            # 额外发一次真实请求（默认不联网）
```

检查项包括 Node 版本、项目文件、依赖安装、演示库与工作库可读性、一次真实的检索自检、PDF/OCR 依赖、模型认证与蒸馏密钥。必需项未通过时退出码为 1；可选项（PDF 提取、pdftoppm、OCR 语言包）缺失只提示，不影响离线浏览。诊断输出不回显任何密钥。

## 只读演示与离线筛选

`npm run demo` 默认只读打开仓库自带的 `data/demo/spina.sqlite`，**不调用模型、不读取 PDF、不写入数据库**，也不会覆盖你的工作库：

```powershell
npm run demo                                                       # 概览、常见金属集合与示例
npm run demo -- search --metals Ni,Co --limit 5                    # 金属集合检索（exact）
npm run demo -- search --metals Fe,Mn --superset                   # 含额外金属的补充体系
npm run demo -- search --metals Ni,Co --exclude-uncertain          # 只保留确认版
npm run demo -- conditions --temp-max 400 --dur-min 24             # 同一步骤的温度/时长筛选
npm run demo -- conditions --material 尿素 --limit 10              # 原料字面匹配
npm run demo -- route --max-temp 400 --max-hours 24                # 整条路线约束（三态）
npm run demo -- route --require 退火 --forbid 球磨                 # 必需/排除操作（同义词）
npm run demo -- sample --paper SPINA-0093 --sample S3              # 展开样品与共用祖先
npm run demo -- evidence --paper SPINA-0093 --sample S3 --field samples.S3.steps.S3-T3.conditions.treatment_temperature
```

- 温度单位 °C；时长 `--dur-unit s|min|h|d`，默认 `h`；范围默认包含端点，用 `--temp-min-exclusive` 排除端点。
- `route` 是整条路线约束，不是单步筛选：聚合样品及共用祖先的全部步骤，结果分满足/不满足/无法判断；缺少时长的步骤只给下界。详见下文“整条路线约束”。
- `sample` / `evidence` 可用 `--version verified|uncertain` 指定版本；不指定时选择真正包含该样品的版本，并打印实际 `record_ref`。
- 所有子命令都支持 `--json`，输出与领域工具一致的结构，便于脚本处理。
- `--database <路径>` 可指向其他数据库，仍以只读方式打开。

演示库只用于浏览与试用；需要检索自己的语料时，把论文放进 `data/paper/` 后蒸馏，写入的是工作库 `data/distillation/spina.sqlite`。

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

### 单实例锁、状态与恢复

同一工作库只允许一个批处理写入进程。启动时会在 `data/distillation/batch/.batch.lock` 建立项目级锁（实例 ID、pid、主机名、心跳、模式），第二个进程会被明确拒绝而不是并发写库；不同 `--job` 目录也不能绕过该约束。锁只在有证据时才会被判定失效：同主机的 pid 已退出，或他机心跳超过 30 分钟；失效锁会归档为 `.batch.lock.stale` 并记录原因。

```powershell
npm run batch -- --status     # 锁状态、控制状态、队列计数、需要处理的任务（不调用模型）
npm run batch -- --recover    # 对照数据库终态重排队列（不调用模型）
```

恢复规则：数据库里已提交的发布记录优先于队列行，已发布论文会转为 `already_published`，不会重复扣费；中断的 `running/claimed` 回到 `pending` 并保留 `run_id`，已完成阶段的调用缓存仍可复用；等待窗口已过的 `waiting_for_*` 重新排队，未过期的保留。`--check-only` / `--repair-existing` 会重跑指定论文，不受“已发布即跳过”影响。

## 人工核对

`uncertain` 不等于抽取错误：问题可能来自原文歧义、历史状态或真实抽取错误。`npm run review` 提供不依赖模型的核对入口：

```powershell
npm run review -- list                                  # 按四类问题列出待核对项
npm run review -- list --category matching --limit 20   # 只看影响目标相匹配的问题
npm run review -- show --paper SPINA-0020               # 字段、短引文、页码、样品树、审核历史
npm run review -- apply --file review.json --dry-run    # 先演练
npm run review -- apply --file review.json              # 发布新修订并写入审核记录
npm run review -- history --paper SPINA-0020
npm run review -- pending-repair                        # 审核人要求模型重抽的问题
```

分类：影响目标相匹配（含 `affects_matching` 或相/样品归属错误）、数值或单位错误、步骤归属、来源缺失或冲突。四类决定：

| 动作 | 作用 | 约束 |
| --- | --- | --- |
| `confirm` | 确认某字段与原文一致 | 只作用于实际定位到的字段，不整篇盖章 |
| `correct` | 修正字段值/单位/证据 | 改为 `reported` 必须带 `source_id`、`page`、`quote`；改数值必须同时给原文表述 `raw` |
| `keep_conflict` | 保留原文自身冲突 | 只能用于来源限制；已确认的抽取错误不能改标为原文限制 |
| `request_repair` | 请求模型定点重抽 | 只登记问题，不自动调用模型；用 `pending-repair` 取出后作为 feedback |

发布前会重跑结构校验（数据合同、重复 ID、原料引用、共用流程成环、证据来源与页码）和版本冲突检查；任一失败则不写入。新修订号高于两个已存版本（确认版与待核对版），`verified_at` 更新，审核人、时间、理由、修改前后值、证据与所依据的 `record_ref` 写入 `review_actions` 表，同时记录在 `record.human_review`。审核动作与记录更新在同一个 SQLite 事务中提交。

## 候选对照导出

把筛选出的 2–5 个样品保存为可复查的对照表，而不是从聊天记录里手工整理：

```powershell
npm run export -- --paper SPINA-0093:S3 --paper SPINA-0092:s1 --format md
npm run export -- --select selection.json --format csv --output exports/组会对照.csv
```

每个单元格保留样品与字段归属（Markdown 用〔…〕标注，JSON 给出完整 `field_path`），并写入导出时的查询条件、时间与每个样品的 `record_ref`。不跨论文合并“最好条件”，也不把不同来源的数值拼成一格。文件默认写到 `exports/`，已存在时拒绝覆盖（`--force` 可覆盖）；库更新后旧文件保持原样。

## 研究分析层（F1–F6）

制备记录回答“有哪些配方、条件来自哪里”；研究分析层回答“这些记录说的是不是同一种材料、样品处于什么状态、论文系列实际改变了什么、解释是否冲突、怎样区分、计算要准备什么”。所有研究产物写入 `data/research/research.sqlite`，**不修改制备记录**。

```bash
npm run research -- capabilities
npm run research -- plan --type series_analysis --question "作者是否只改变了温度？" --paper SPINA-0093
npm run research -- identity --paper SPINA-0020 --sample S_CoFe_ZrO2_series --database data/demo/spina.sqlite
npm run research -- relate --entity SPINA-0020:S_CoFe_ZrO2_series --entity SPINA-0093:S3 --database data/demo/spina.sqlite
npm run research -- lineage --paper SPINA-0093 --sample S3 --database data/demo/spina.sqlite
npm run research -- series --paper SPINA-0093 --database data/demo/spina.sqlite
npm run research -- observe --paper SPINA-0093 --metric h2_evolution_rate --sample S3 --sample S4 --database data/demo/spina.sqlite
npm run research -- continuity --paper SPINA-0093 --database data/demo/spina.sqlite
npm run research -- ingest --file research-input.json
npm run research -- disagreement --topic activity_origin
npm run research -- hypotheses --file hypotheses.json
npm run research -- structure --file data/structures/NiCo2O4.cif --formula NiCo2O4
npm run research -- computation --file intent.json
```

| 功能 | 确定性部分（程序完成） | 需要模型或人工输入 |
| --- | --- | --- |
| F1 材料身份 | 元素集合、计量组成、变量式与定义域、结构表述分层 | 实测组成、真实晶体结构 |
| F4 样品状态 | 制备继承边、显式分装/负载/后处理/测试后关系、观察绑定 | 关系本身需登记并附依据 |
| F2 系列分析 | 变量差异、保持一致项、未报告/未对齐项、观察可比性 | 结果观察（可由表格抽取）、作者解释 |
| F3 论断分歧 | 主体/范围对齐、冲突分类、独立来源计数 | 论断登记（topic、kind、stance、范围） |
| F5 竞争假设 | 可反驳性检查、区分性观察 | 假设生成 |
| F6 计算准备 | CIF/POSCAR 解析、组成一致性、待定参数清单 | 结构来源、泛函/U/磁构型等科学选择 |

### 论文表格观测抽取

`observe` 从论文表格读取一个指标，配对到已入库样品，写入研究库并自动做系列对照：

```bash
npm run research -- observe --paper SPINA-0093 --metric h2_evolution_rate --sample S3 --sample S4
npm run research -- observe --paper SPINA-0081 --metric oer_overpotential --map '{"Our work":"nco_hnss"}' --no-save
```

- **指标**：`h2_evolution_rate`、`oer_overpotential`、`specific_capacitance`、`degradation_rate_constant`、`conversion`，也可直接传表头文字。
- **样品配对**：按 local_id/name/aliases 精确匹配；唯一包含匹配标为 `medium`；无匹配或多候选进入 `unmatched_labels`，不自动猜。
- **单位与数值**：支持 `1.2 × 10^2`、`180 ± 5`；`n.r.`、`–` 记为跳过；单位不做静默换算。
- **测量条件**：从表头、条件列与页面文字读取光源、牺牲剂、电解质、方法与助催化剂；缺失标 `unknown`，不补默认值。
- **可比性**：同指标、同单位、同方法、同条件、同修订版才输出差值；否则 `incomparable`、`delta=null` 并说明缺什么。
- **版本绑定**：观察保存 `record_ref` 与样品化学指纹；论文重新蒸馏后用 `continuity` 判断是“样品未变、只需复核数值”还是“样品已被改写”。
- **边界**：只读表格，不读曲线图；合并单元格/多级表头会报告未解决。需要 `data/paper/` 中的原件与 pdfplumber。

### 跨版本证据连续性

论文重新蒸馏后，`continuity` 逐条判断已登记的观察与样品关系是否仍对应当前修订的实验样品：

```bash
npm run research -- continuity --paper SPINA-0081
```

| 状态 | 含义 | 能否沿用 |
| --- | --- | --- |
| `current` | 绑定的就是当前修订 | 可直接复用 |
| `same_specimen` | 样品 ID 与目标相化学指纹均未变，修订已更新 | 需复核数值 |
| `relabelled` | 样品换名，化学指纹唯一匹配 | 需人工确认 |
| `redefined` | ID 未变但化学指纹变化 | 不能沿用 |
| `missing` / `unverifiable` | 无法定位样品，或旧行没有指纹 | 不能沿用 |

指纹只覆盖目标相化学式与金属元素集合：它证明**记录一致**，不证明是同一物理批次；晶型、阳离子占位与纯度的变化仍以 `material_identity` 为准。两个样品化学指纹相同且原 ID 消失时判 `missing` 并列出候选，不自动绑定。

### 路线结构

`route.structure` 明确说明步骤如何组合，而不是让读者以为顺序已验证：

```json
{ "ordering_basis": "record_order", "parallelism_known": false, "replacement_known": false,
  "inheritance": [{ "sample_id": "S2", "shared_from": "S1" }], "inherited_step_count": 2,
  "warnings": ["记录未标注并行或替换关系；路线按记录顺序聚合，不代表已验证的工序顺序"] }
```

每个步骤带 `origin: own | inherited`。记录没有并行/替换标记时，工具如实报告“未标注”，不推断分支。

关键边界（写进能力合同，不只是回答末尾的提醒）：

- **身份关联不等于物相确认**：`NiCo2O4` 与 `Ni2CoO4` 元素集合相同但计量不同；化学式相同也不推出晶型或阳离子占位。
- **样品继承不等于因果关系**：`shared_from` 只作为 `preparation_inherits` 边；分装、负载、后处理、测试后状态必须显式登记，不按样品名推断。
- **文献论断不等于实验观察**：观察与解释分开存储；引用（`cites`）不产生第二份独立支持。
- **系统假设不等于文献结论**：假设的 `origin_family` 以 `system:` 开头，产物 `provenance` 为 `model_hypothesis`。
- **计算准备不等于计算完成**：结构文件通过格式检查不证明结构合理或解释成立；未指定的泛函、赝势、U 值、磁构型与 k 点列入 `requires_decision`，不默认固定。
- **指纹一致不等于同一批次**：化学指纹只比较记录中的目标相与金属集合；`same_specimen` 表示可以复核后沿用，不表示两次实验是同一份样品。

研究输入（显式关系、观察、论断、假设）用 `research ingest` 登记：

```json
{
  "specimen_relations": [
    { "paper_id": "SPINA-0093", "from": "SPINA-0093::S3", "to": "SPINA-0093::S4",
      "relation": "processed_into", "note": "原文说明 S4 由 S3 压制后退火", "evidence": [] }
  ],
  "observations": [
    { "paper_id": "SPINA-0093", "sample_id": "S3", "metric": "H2 rate",
      "value": 120, "unit": "umol g-1 h-1", "context": { "light": "300 W Xe" } }
  ],
  "claims": [
    { "claim_id": "c1", "paper_id": "SPINA-0093", "topic": "activity_origin",
      "statement": "活性提升来自能带变化", "kind": "author_interpretation", "stance": "positive",
      "subject_refs": [{ "paper_id": "SPINA-0093", "sample_id": "S4", "material": "MnFe2O4" }],
      "scope": { "measurement": "300 W Xe" },
      "support_refs": [{ "kind": "observation", "paper_id": "SPINA-0093", "sample_id": "S4" }],
      "origin_family": "paper:SPINA-0093" }
  ],
  "hypotheses": [
    { "hypothesis_id": "h1", "statement": "差异来自可接触表面积",
      "explains": ["活性提高"],
      "predicts": [{ "observable": "normalized activity", "expected": "no difference" }],
      "falsifiers": [{ "observation": "normalized activity", "outcome": "still higher" }] }
  ]
}
```

`subject_refs[].material` 是跨论文对齐用的受控材料标签；没有它时只按论文/样品对齐。观察类论断必须有直接观察或证据支撑；假设必须有至少一个可反驳条件，否则拒绝登记。

## 备份与恢复

```powershell
npm run backup                                   # 轻量包：只含可查询知识
npm run backup -- --full                         # 完整工作包：任务产物、批处理队列、配置摘要
npm run backup -- --include-sources              # 另外复制记录引用的 PDF 原件
npm run backup -- --verify backups/<name>        # 校验摘要、计数与固定查询
npm run backup -- --restore backups/<name> --to restore-check
npm run backup -- --drill                        # 自动演练：备份 → 校验 → 恢复 → 再校验
```

数据库快照使用 SQLite `VACUUM INTO`，不复制正在写入的文件；`manifest.json` 记录计数、SHA-256、知识摘要、数据合同版本与来源。`--full` 还会纳入 `data/research/research.sqlite`（研究产物）与 `runs/` 任务产物，并在校验时比对研究产物计数；轻量包只含可查询的制备知识。备份先写临时目录，成功后改名，目标已存在时拒绝覆盖。`.env`、`.runtime/sessions`、`.runtime/model-store.json` 与 `node_modules` 不进入任何备份包。恢复要求目标目录为空（或显式 `--force`），恢复后立即比对摘要与计数。

## 真实任务评测

`evals/tasks/frozen-20261105.json` 冻结了 24 道试点任务，覆盖金属集合检索、条件筛选、样品比较、证据追溯与边界情况；每题带成功标准与“严重错误”定义。

```powershell
npm run eval:score -- --init results/run-1.json    # 生成逐题记录模板
npm run eval:score -- --results results/run-1.json # 输出汇总（Markdown 或 --json）
```

分别报告完整任务成功率、严重事实错误、来源支撑、耗时、成本与基础设施失败；基础设施失败不计入成功率但单独列出。评测协议见 `docs/real-task-evaluation-20261105.md`。

## 数据与产物

仓库跟踪的文件只有代码、文档、测试和**演示库** `data/demo/spina.sqlite`（约 13.75 MB）。其余 `data/` 内容由使用者自备，已在 `.gitignore` 中排除；`data/README.md` 与 `data/demo/README.md` 说明了目录约定与演示库来源。

| 路径 | 内容 |
| --- | --- |
| `data/demo/spina.sqlite` | 随仓库分发的只读演示快照，`npm run demo` 直接读取，不需要复制。 |
| `data/paper/` | 原始正文与 SI。程序只读，不修改。 |
| `data/literature/selected-500.jsonl` | 可选，批处理清单。 |
| `data/distillation/spina.sqlite` | 工作库：已发布的结构化实验、修订号、任务状态、人工审核记录。不复制全文、不保存向量。 |
| `data/distillation/runs/<run_id>/record.json` | 单次任务的精简交付：论文、来源、样品（目标相与可匹配金属、原料、步骤与条件、页码、问题说明）。草稿、核验与程序检查另存同目录。 |
| `data/distillation/pages/` | 页图缓存，按完整来源路径与 PDF 内容摘要隔离版本。 |
| `data/distillation/batch/` | 批处理队列、单实例锁、每次调用的缓存与日志。 |
| `backups/` | `npm run backup` 生成的备份包，默认不进版本库。 |
| `exports/` | `npm run export` 生成的候选对照，默认不进版本库。 |

### 演示知识库

`data/demo/spina.sqlite` 是一份生成好的知识库快照：140 篇确认入库、255 篇待核对、978 条任务状态。`npm run demo` 以只读方式打开它，不调用模型、不读取 PDF、不写入工作库；没有 DeepSeek 密钥或 ChatGPT 订阅时仍可使用。

想把它作为自己的工作库继续检索，可显式复制一次（会覆盖现有工作库，请先备份）：

```powershell
npm run backup
Copy-Item data\demo\spina.sqlite data\distillation\spina.sqlite
```

库内是结构化制备信息、DOI 题录、证据页码与用于核对的短引文，以及生成时的来源文件相对路径（仅路径，不含 PDF 内容）。想换成自己的语料时，删除工作库重新蒸馏即可。演示库的生成时间、计数来源与重建方式见 `data/demo/README.md`。

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
| `search_route_constraints` | 聚合整条路线的最高温度、总时长与必需/排除操作，返回满足/不满足/无法判断三态。 |
| `repair_uncertain_paper` | 对指定疑惑记录做定点修正。 |
| `sync_verified_matching` | 同步已核验记录的金属匹配索引。 |

研究分析工具（与制备工具分开注册）：

| 工具 | 用途 |
| --- | --- |
| `plan_research_task` | 把多步研究问题编译成有依赖的计划，列出未满足输入与需要的信息域。 |
| `resolve_material_identity` | 分层解析材料身份；变量式保留符号与定义域。 |
| `relate_material_entities` | 分层判断两个材料对象的关系，不给单一相似度分数。 |
| `build_specimen_lineage` | 样品状态谱系；`shared_from` 只作为制备继承边。 |
| `analyze_sample_series` | 论文内系列对照：改变了什么、哪些未报告、能否单独归因。 |
| `explain_claim_disagreement` | 论断分歧分类与独立来源计数。 |
| `record_research_objects` | 登记显式样品关系、观察、论断与假设，并做合同校验。 |
| `extract_paper_observations` | 从论文表格抽取一个指标，配对样品、绑定修订版，并自动做系列对照。 |
| `check_evidence_continuity` | 重新蒸馏后判断旧观察与样品关系是否仍对应当前修订的实验样品。 |
| `identify_discriminating_observations` | 找出能区分竞争假设的观察；不能区分时明确说明。 |
| `prepare_computation_spec` | 解析 CIF/POSCAR，输出带待定参数的计算任务规范。 |

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

## 整条路线约束

`search_preparation_conditions` 只判断同一步骤内的字段。要回答“整条路线最高温度是否低于 400 ℃”“一天内能否完成”“是否用到球磨”，用 `search_route_constraints`（或 `npm run demo -- route`）。

- **聚合范围**：所选样品及其显式 `shared_from` 祖先的全部步骤；按记录顺序视为顺序执行，不推断并行或替换关系。
- **数值类型**：单值、区间、上下界、近似值、分段温程。范围取上界判最高温度，总时长取上下界，**不使用区间中点**。
- **三态结果**：`satisfied` / `violated` / `undetermined`。缺少温度或时长的步骤使结果不确定，而不是判为满足或不符合。
- **总时长**：要求每一步都有可解析时长；缺少时只给已知下界与 `unknown_steps`，不给估计值。
- **操作**：必需操作缺失 → `undetermined`（库内未记录不等于未使用）；排除操作命中 → `violated`。
- **受控同义词**：annealing/退火、calcination/煅烧、ball milling/球磨、urea/尿素等；水合物、浓度规格和相近但不同的工艺（退火/煅烧）不合并。

```bash
npm run demo -- route --metals Ni,Co --max-temp 400 --max-hours 24 --json
npm run demo -- route --require 退火 --forbid 球磨
```

返回满足/无法判断/不满足的计数、每个样品的步骤聚合、`unknown_steps`、`reasons` 与 `assumptions`。`undetermined` 既不是符合也不是不符合，回答时必须说明缺少哪些步骤或时长。

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
- **条件筛选范围**：单步筛选支持温度、时长和原料；整条路线支持最高温度、总时长与必需/排除操作的三态判断，但并行/替换关系仍需人工确认，缺少时长的步骤只给下界。RAG 尚未接入。
- **只在 Windows 实测**：脚本对 Windows/macOS/Linux 做了分支，但开发与验证环境是 Windows 11 + Node 24。
- **批处理单进程**：并发只在进程内；同一工作库的第二个写入进程会被项目级锁拒绝，而不是靠文档提醒。跨主机共享同一份数据库文件仍不在支持范围。
- **人工核对的范围**：只能确认/修正已定位到具体字段的内容；`samples`、`reader_view.*` 这类指向整段或派生视图的问题只能保留冲突或请求模型重抽。审核不重新读取 PDF，引文来自库存证据。
- **演示库与工作库分离**：演示库只读，任何 `review apply`、蒸馏、批处理都写入工作库。
- **研究分析层的输入边界**：样品关系、结果观察、论断与假设需要显式登记，或通过 `observe` 从表格抽取；当前不会从曲线图读数值，也不自动抽取性能、表征或机理。没有登记观察时，系列分析只做设计判断，不判断效应。
- **表格抽取的边界**：只处理有行列结构的表格；合并单元格、多级表头、跨页表格会报告未解决。表格里的参考文献行不会被自动当作本文样品。
- **计算准备不执行计算**：只解析 CIF/POSCAR 并列出待定参数，不运行 DFT，也不判断结构是否物理合理。

## 开发

```powershell
npm run check   # .mjs 语法、TypeScript 与批处理 .mjs 严格类型检查
npm test        # node --test
npm run doctor  # 环境诊断
npm run demo    # 只读演示
```

测试使用合成 PDF 与确定性模型响应，不需要提供商认证。用例数量以 `npm test` 输出为准；未配置 Python 或 Poppler 时，相应 PDF 提取/OCR/页图用例自动 skip。`npm run doctor` 会明确报告这类可选项，避免“整体绿色但关键用例一直跳过”。真实论文的科学事实质量仍须在实际蒸馏中核查。

新增的离线命令（`demo`、`review`、`export`、`backup`）只依赖 Node 与 SQLite，测试通过子进程验证真实退出码与输出，不依赖模型。

源码结构：

| 文件 | 职责 |
| --- | --- |
| `src/cli.mjs` | 固定项目工作目录，启动本地 Pi，配置加载范围与会话目录。 |
| `src/doctor.mjs` | 分场景环境诊断：Node、数据库、查询自检、PDF/OCR、模型认证；联网需显式开启。 |
| `src/demo.mjs` | 只读打开演示库，提供金属检索、条件筛选、样品展开与证据反查。 |
| `src/review.mjs` | 人工核对工作台：问题列表、证据对照、字段修订、审核历史。 |
| `src/export.mjs` | 选中样品的对照表导出（Markdown/CSV/JSON），保留字段归属与 `record_ref`。 |
| `src/backup.mjs` | 一致性备份、校验、恢复到空目录与恢复演练。 |
| `src/cli-format.mjs` | 离线命令共用的表格与参数解析（CJK 宽度对齐）。 |
| `src/batch.mjs` | 批处理队列、并发、停止标记与来源校验。 |
| `src/batch-lock.mjs` | 项目级单实例锁：实例标识、pid 存活判断、心跳与失效锁归档。 |
| `src/batch-recover.mjs` | 崩溃后的队列对账：以数据库终态为准，重排未完成任务。 |
| `src/batch-cache.ts` / `src/batch-retry.mjs` | 批处理缓存键与重试。 |
| `tsconfig.batch.json` | 批处理及其 I/O、重试、锁脚本的严格 JavaScript 类型检查，纳入 `npm run check`。 |
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
| `src/distillation/store.ts` | SQLite、版本、检索分页、审核记录与逐轮产物。 |
| `src/distillation/review.ts` | 问题分类、字段定位、结构校验与审核发布事务。 |
| `src/distillation/missing-information.ts` / `source-version.ts` | 缺项归类与来源版本。 |
| `src/distillation/tools.ts` | Pi 模型适配与领域工具入口。 |
| `src/distillation/preparation.ts` | 锁定版本的样品与共用流程读取，保留步骤和条件原始归属。 |
| `src/distillation/evidence.ts` | 按对象 ID 定位制备字段，返回库存证据及适用范围上下文。 |
| `src/distillation/conditions.ts` | 跨库结构化条件筛选、保守单位换算及带版本的候选分页。 |
| `src/distillation/numeric.ts` | 单值/区间/上下界/近似值/分段温程的显式解析；不做中点替代。 |
| `src/distillation/route.ts` | 整条路线聚合：最高温度、总时长、必需/排除操作的三态判断。 |
| `src/distillation/synonyms.ts` | 受控步骤与试剂同义词；水合物与浓度规格不合并。 |
| `src/research.mjs` | 研究分析层命令行：身份、关联、谱系、系列、论断、假设、结构与计算准备。 |
| `src/research-tools.ts` | 研究能力的 Pi 工具适配；不实现科学规则。 |
| `src/research/contracts.ts` | 研究任务、产物、provenance 与能力合同（输入/输出/前置条件/不支持情形）。 |
| `src/research/store.ts` | 研究产物库 `data/research/research.sqlite`：产物、关系、观察、论断、假设。 |
| `src/research/materials.ts` | F1 化学式解析、变量定义域、结构表述分层与材料关联。 |
| `src/research/specimens.ts` | F4 样品谱系与观察主体绑定。 |
| `src/research/study-design.ts` | F2 系列对照、变量差异与观察可比性。 |
| `src/research/claims.ts` | F3 论断合同、分歧分类与独立来源计数。 |
| `src/research/hypotheses.ts` | F5 可反驳性检查与区分性观察。 |
| `src/research/computation.ts` | F6 CIF/POSCAR 解析与计算任务规范。 |
| `src/research/facets/observations.ts` | 论文表格观测抽取：指标列、单位、样品配对、条件与版本绑定。 |
| `src/research/adapters/preparation-reader.ts` | 复用现有版本绑定读取，不另写一套记录访问。 |
| `evals/tasks/` | 冻结的真实任务验收集。 |
| `evals/score-tasks.mjs` | 评测计分：成功率、严重错误、来源支撑、耗时、成本、基础设施失败。 |

## 许可与合规

MIT License，见 `LICENSE`。

- 仓库不包含任何论文全文、出版商页面或抓取凭据；`data/` 除 `data/README.md` 与只读演示库 `data/demo/spina.sqlite`（仅结构化记录、题录、页码与短引文）外均被 `.gitignore` 排除。
- 使用者需自行确保所处理 PDF 的获取方式合法，并遵守出版商的文本与数据挖掘条款。
- 结构化结果可能包含论文摘录与原文表述，对外发布前请自行核对版权与引用规范。
