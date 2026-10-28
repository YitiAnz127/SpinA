# data/（运行时数据，不随仓库分发）

本目录存放你自己的论文与运行产物。仓库只保留这份说明，`data/` 下的其他内容全部被 `.gitignore` 排除。

首次使用先创建目录：

```powershell
New-Item -ItemType Directory -Force data\paper, data\literature | Out-Null
```

```bash
mkdir -p data/paper data/literature
```

## 目录约定

| 路径 | 用途 |
| --- | --- |
| `data/paper/` | 你合法获取的论文正文与 SI（PDF，单个不超过 50 MiB）。程序只读，不修改原文件。 |
| `data/paper/.doi_index.json` | 可选。`{ "<doi>": { "file": "data/paper/<文件名>.pdf" } }`，用于按 DOI 自动定位论文；没有时按 DOI 命名规则在 `data/paper/` 内查找。 |
| `data/literature/selected-500.jsonl` | 可选，仅批处理需要。每行一个 JSON：`{"paper_id":"SPINA-0001","doi":"10.xxxx/xxxx","title":"..."}`。单篇 `/distill` 不需要此文件。 |
| `data/distillation/` | 程序自动创建：SQLite 数据库、逐任务运行目录、页图缓存、批处理队列。 |

## 提醒

- 不要把出版商版权 PDF、第三方全文或抓取凭据提交进仓库。`data/` 已在 `.gitignore` 中整体排除。
- 页图缓存位于 `data/distillation/pages/`，按来源路径与 PDF 内容摘要隔离，可从原 PDF 重新生成。
