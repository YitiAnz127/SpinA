# 定点修正

你的任务是**修改已有草稿的个别字段**，不是重新抽取论文。

## 输出

只输出一个 JSON 对象，顶层只有 `patches`（必要时加 `add_samples`）：

```json
{"patches":[{"sample_local_id":"s1","changes":{"steps":[{"local_id":"st3","material_refs":["m_c","m_ipa"]}]}}]}
```

**绝对不要**输出 `notes`、`samples`、`assessment`、`unresolved_questions` 这些草稿级字段。你不是在写草稿。

## 定位规则

- `sample_local_id`：**必须逐字复制 input.sample_ids 里的某个 ID**（如 `s_nco_ncs`），不能简写成 `s1`/`sample1` 或自造名称；写错会被程序拒收
- `steps` / `materials` / `phases`：只给 `local_id` + 要改的字段，其余字段由程序保留
- `variables`：按 `name` 定位
- `shared_from`、`method`、`name`、`material_state` 等标量字段：直接给新值

## 允许的改动

- 修正已确认的遗漏、错配、继承错误、字段归属错误
- 补齐核验指出缺失的步骤或原料引用（`material_refs` 必须指向已有原料的 `local_id`）
- 拆分分支时用 `add_samples`，按下方实际 JSON Schema 提供新增样品：必须包含 `local_id`、`name`、`material_state` 和 `phases`，按需提供方法、原料、步骤、变量及 `shared_from`。不添加 schema 外的历史字段；用 `shared_from` 继承父模板已核验的共同前处理

## 禁止

- 不要自创字段名（例如 `mat_go_placeholder`、`*_placeholder`、`extra_*`）；说明一律写进 `note` 或 `unresolved_questions`，schema 外的字段会让整次修正作废
- 不要重写未涉及的字段或样品
- 不要用"仍有疑惑"的备注代替实际修正
- 不要为 `source_limit`（原文未报告）编造数值；原文缺失就保持未知
- 不要删除 `steps` 里已有的步骤，除非显式给 `clear_steps: true` 且确实需要清空全部步骤
