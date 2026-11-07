# data/demo/（只读演示快照）

`spina.sqlite` 是随仓库分发的演示知识库，供 `npm run demo`、`npm run doctor` 与试点评测离线读取。程序以只读方式打开，不会写入或替换它。

## 快照信息

| 项 | 值 |
| --- | --- |
| 生成时间 | 2026-10-28 19:16（北京时间，文件时间戳） |
| 文件大小 | 13,746,176 字节（约 13.75 MB） |
| SHA-256 | `42c312f2aff5d8c49053673444284d82da96950cbfbe73ae1d973aa18452b983` |
| 数据合同 | `schema_version: 1`；表 `papers`、`uncertain_papers`、`runs` |
| 来源 | 本项目对 500 篇候选文献的批处理结果快照；只保留结构化记录、DOI 题录、页码与短引文，不含 PDF 全文 |

## 计数（2026-11-05 只读统计）

| 表 / 指标 | 数量 |
| --- | --- |
| `papers`（确认版本） | 140 |
| `uncertain_papers`（待核对版本） | 255 |
| `runs`（任务状态） | 978 |
| 样品（默认版本合计） | 1583 |
| 确定金属匹配项 | 1131 |
| 可能匹配项 | 200 |
| `review_actions` | 0（快照生成时尚无人工审核） |

确认版与待核对版可能对应同一论文，**不能直接相加**解释为独立论文数；`runs` 也不表示成功处理篇数。

## 计数从哪里来

不要手工维护这些数字。以下命令从数据库直接生成：

```powershell
npm run doctor -- --json                                  # 各表计数与查询自检
npm run report -- --database data/demo/spina.sqlite --output reports/demo-snapshot
```

`reports/demo-snapshot/summary.json` 是统计的权威来源；本文件的数字只是快照提交时的记录。计数变化时应由脚本重新生成，并更新本节的生成时间与 SHA-256。

## 重建方式

演示库由同一套批处理流程生成：论文放入 `data/paper/`，题录写入 `data/literature/selected-500.jsonl`，运行 `npm run batch -- --after SPINA-0000`，再用 `npm run backup -- --database data/distillation/spina.sqlite --output <临时目录>` 取一致性快照，最后复制为 `data/demo/spina.sqlite`。

重建后必须同时更新本文件的生成时间、大小、SHA-256 与计数，否则 `npm run doctor` 的演示库检查会与实际不符。

## 隐私与合规

快照只含结构化制备信息、题录、页码和用于核对的短引文（每条不超过 1600 字符），不含论文全文、页图或出版商页面。对外分发前仍应确认短引文的使用符合原出版商的文本与数据挖掘条款。
