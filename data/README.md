# data/（运行时数据）

本目录存放你自己的论文与运行产物。仓库只跟踪三类内容：这份说明、`data/demo/`（只读演示快照及其说明）和 `.gitignore` 的放行规则；其余内容全部被排除。

首次使用先创建目录：

```powershell
New-Item -ItemType Directory -Force data\paper, data\literature | Out-Null
```

```bash
mkdir -p data/paper data/literature
```

## 目录约定

| 路径 | 用途 | 是否随仓库分发 |
| --- | --- | --- |
| `data/demo/spina.sqlite` | 仓库自带的只读演示知识库快照（140 确认 / 255 待核对 / 978 条任务）。`npm run demo` 直接只读打开，不需要复制。 | 是（唯一被跟踪的数据文件） |
| `data/paper/` | 你合法获取的论文正文与 SI（PDF，单个不超过 50 MiB）。程序只读，不修改原文件。 | 否 |
| `data/paper/.doi_index.json` | 可选。`{ "<doi>": { "file": "data/paper/<文件名>.pdf" } }`，用于按 DOI 自动定位论文；没有时按 DOI 命名规则在 `data/paper/` 内查找。 | 否 |
| `data/literature/selected-500.jsonl` | 可选，仅批处理需要。每行一个 JSON：`{"paper_id":"SPINA-0001","doi":"10.xxxx/xxxx","title":"..."}`。单篇 `/distill` 不需要此文件。 | 否 |
| `data/distillation/` | 程序自动创建：工作库 SQLite、逐任务运行目录、页图缓存、批处理队列与单实例锁。 | 否 |
| `data/distillation/spina.sqlite` | 你的工作库。蒸馏、人工核对、批处理都写入这里，与演示库完全分离。 | 否 |
| `data/research/research.sqlite` | 研究分析层产物库：材料身份、样品谱系、系列对照、论断、假设与计算规范。与制备记录分开保存。 | 否 |
| `data/structures/` | 可选。CIF/POSCAR 等结构文件，供计算准备读取；程序只读。 | 否 |

## 演示库与工作库

- `data/demo/spina.sqlite` 只读。`npm run demo`、`npm run doctor` 都只读取它，不会覆盖工作库。
- 想把演示库当作工作库起点时，显式复制一次：先 `npm run backup`，再 `Copy-Item data\demo\spina.sqlite data\distillation\spina.sqlite`。
- 演示库的生成时间、计数来源与重建方式见 `data/demo/README.md`。

## 提醒

- 不要把出版商版权 PDF、第三方全文或抓取凭据提交进仓库。除 `data/demo/` 外，`data/` 已在 `.gitignore` 中排除。
- 页图缓存位于 `data/distillation/pages/`，按来源路径与 PDF 内容摘要隔离，可从原 PDF 重新生成。
- 备份包写到 `backups/`，导出写到 `exports/`，两者都不进版本库。
