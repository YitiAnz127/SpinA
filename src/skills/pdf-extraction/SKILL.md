---
name: pdf-extraction
description: 提取 SpinA 论文 PDF 的逐页文字、保留布局的文本和表格；自动 OCR 扫描页，并对照原始页图核读公式、上下标和表格。
---

# PDF 提取

从 Codex 的通用 pdf 技能提取文字、表格、OCR 和原页核对流程，适配 SpinA 的受限工具。

- 用户要求查看或提取 PDF 文字／表格时，使用 `read_paper_pages`。已收录论文传 `paper_id`；单独文件传 `path`，无需编造 DOI 或题名。
- 来源不明确时先用 `inspect_paper_sources` 查看来源 ID、正文／SI 和页数；按 `source_id`、`first_page`、`last_page` 读取所需页，每次最多 20 页。
- `text` 是逐页原文或 OCR 结果；`layout_text` 保留文字位置关系；`tables` 保留表格行列与页面坐标。来源 ID 和 number 对应原始 PDF 页码，不能改用期刊印刷页码。
- 提取流程使用 pdfplumber，文字提取失败时用 pypdf；缺少文字且含图片的页面转为原页 PNG，再由本地 Tesseract OCR。`extraction_method=tesseract` 明确表示 OCR，不代表内容已核验。
- OCR 可能误认化学式、数字、上下标和表格对应关系。对照实际提供的原始页图判断；结构化表格是提取结果，不能补齐空单元格或把错列数值当成原文结论。扫描表格未恢复行列时，读取 OCR 文字并核对页图。
- 保留正文／SI 分类、原文数值单位和缺失说明。提取 SI 不等于已有正文；蒸馏仍须确认正文来源。
- 提取只读原始 PDF，不触发模型蒸馏、不发布实验记录。只有用户要求蒸馏或更新论文时才调用 `distill_paper`。
- 缺少依赖或识别模型时如实报告工具错误。不能宣称已识别扫描件、已提取表格或已核读没有提供的原图。

主对话和蒸馏／核验模型均直接收到这些规则，无需启用通用 shell 或文件编辑工具。
