import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExperimentStore } from './distillation/store.ts';
import {
  REVIEW_CATEGORIES, CATEGORY_LABELS, listReviewIssues, showPaper, applyReview, pendingRepairs,
} from './distillation/review.ts';
import { table, printJson, truncate, parseFlags } from './cli-format.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const workDatabase = resolve(root, 'data/distillation/spina.sqlite');

const usage = `SpinA 人工核对工作台（只读展示 + 受控修订）

  npm run review -- list [--category matching|value_unit|step_attribution|source]
                         [--paper SPINA-0011] [--limit 20] [--offset 0] [--all] [--json]
  npm run review -- show --paper SPINA-0011 [--version uncertain|verified] [--json]
  npm run review -- apply --file review.json [--bind-current] [--dry-run] [--json]
  npm run review -- history --paper SPINA-0011 [--json]
  npm run review -- pending-repair [--paper SPINA-0011] [--json]

决定文件（apply）：
{
  "paper_id": "SPINA-0011",
  "version": "uncertain",
  "record_ref": { "paper_id": "SPINA-0011", "version": "uncertain", "revision": 1, "verified_at": "..." },
  "reviewer": "张三",
  "reason": "对照原文 SI 第 3 页核对",
  "decisions": [
    { "action": "confirm", "field_path": "samples.S1.materials.M1.amount", "reason": "与原文表 1 一致" },
    { "action": "correct", "field_path": "samples.S1.steps.ST2.conditions.temperature",
      "value": "850", "unit": "°C", "reason": "原文为 850 °C，原记录 850 K",
      "evidence": [{ "source_id": "src_1", "page": 7, "quote": "annealed at 850 °C for 4 h" }] },
    { "action": "keep_conflict", "issue_index": 2, "reason": "正文与 SI 数值冲突，保留原文说明" },
    { "action": "request_repair", "issue_index": 3, "reason": "需要模型按 SI 表 2 重新抽取" }
  ]
}

规则：confirm/correct 只作用于实际定位到的字段；correct 改为 reported 必须带证据；
keep_conflict 不能把已确认的抽取错误改标为原文限制；整篇确认（--confirm）要求没有剩余抽取问题。`;

async function readStore(database, readOnly) {
  if (readOnly) return ExperimentStore.openReadOnly(database);
  const existing = await ExperimentStore.openExisting(root);
  existing?.close();
  if (!existing) throw new Error('工作库不存在：请先蒸馏或复制演示库（npm run demo 可只读浏览演示库）');
  return ExperimentStore.open(root);
}

function printList(result, includeResolved) {
  const counts = Object.fromEntries(REVIEW_CATEGORIES.map(category => [category, result.rows.filter(row => row.category === category).length]));
  console.log(`待核对问题：${result.total} 条${includeResolved ? '（含已解决）' : '（未含已解决）'}；本页 ${result.rows.length} 条`);
  console.log(`本页分类：${REVIEW_CATEGORIES.map(category => `${CATEGORY_LABELS[category]} ${counts[category]}`).join(' · ')}`);
  console.log(table(['论文', '分类', '问题类型', '状态', '影响匹配', '字段', '当前值'], result.rows.map(row => [
    row.paper_id, row.category_label, row.issue_type, row.resolution_status, row.affects_matching ? '是' : '',
    row.field_path, truncate(row.current_value, 42),
  ])));
  if (result.has_more) console.log(`\n还有 ${result.total - result.offset - result.rows.length} 条：加 --offset ${result.next_offset}，或缩小 --category / --paper 范围。`);
  console.log('\n下一步：npm run review -- show --paper <ID> 查看字段、引文与页码。');
}

function printShow(view) {
  const ref = JSON.stringify(view.record_ref);
  console.log(`${view.paper.paper_id} · ${view.paper.title}`);
  console.log(`版本：${view.verification_status}  修订：${view.revision}  核验：${view.verified_by}  ${view.verified_at}`);
  console.log(`DOI：${view.paper.doi}`);
  console.log(`record_ref：${ref}`);
  console.log(`来源：${view.sources.length ? view.sources.map(source => {
    const absolute = resolve(root, source.path);
    const state = existsSync(absolute) ? `原件存在：${absolute}` : '原件未找到，只能按库存证据审核';
    return `${source.id}(${source.kind},${source.page_count}页) ${source.path}（${state}）`;
  }).join('；') : '无'}`);
  console.log('\n样品与已存字段：');
  for (const sample of view.samples) {
    console.log(`  ${sample.sample_id} ${sample.name}  形态=${sample.material_state}  共用父流程=${sample.shared_from ?? '无'}`);
    for (const phase of sample.phases) console.log(`    相 ${phase.phase_id} [${phase.role}] 化学式=${phase.formula} 身份=${phase.identity}`);
    for (const material of sample.materials) console.log(`    原料 ${material.material_id} ${material.identity}  用量=${material.amount}`);
    for (const step of sample.steps) {
      const conditions = step.conditions.map(condition => `${condition.name}=${condition.value}${condition.status === 'reported' ? '' : `(${condition.status})`}`).join('，');
      console.log(`    步骤 ${step.step_id} ${step.operation}${conditions ? `｜${conditions}` : ''}`);
    }
  }
  console.log(`\n问题（${view.issues.length} 条）：`);
  if (!view.issues.length) console.log('  无');
  for (const issue of view.issues) {
    console.log(`  [#${issue.issue_index}] ${issue.category_label} · ${issue.issue_type} · ${issue.resolution_status}${issue.affects_matching ? ' · 影响匹配' : ''}${issue.action ? ` · ${issue.action}` : ''}`);
    console.log(`      字段：${issue.field_path}${issue.resolved_field ? `（样品 ${issue.resolved_field.sample_local_id}，可直接 confirm/correct）` : '（无法定位到单一字段，只能 keep_conflict/request_repair）'}`);
    if (issue.resolved_field) console.log(`      库内值：${truncate(JSON.stringify(issue.resolved_field.fact.raw ?? issue.resolved_field.fact.value), 160)}  状态=${issue.resolved_field.fact.status}`);
    console.log(`      当前问题：${truncate(issue.current_value, 220)}`);
    if (issue.proposed_correction) console.log(`      建议修正：${truncate(issue.proposed_correction, 220)}`);
    for (const evidence of issue.evidence.slice(0, 3)) console.log(`      证据：${evidence.source_id} 第 ${evidence.page} 页「${truncate(evidence.quote, 120)}」`);
    if (!issue.evidence.length) console.log('      证据：无保存引文（只能按库存记录审核，不等于重新核对原文）');
  }
  console.log(`\n缺项 ${view.missing_information.length} 条；来源限制 ${view.source_limitations.length} 条（不阻止确认，但不能当作已知条件）。`);
  if (view.history.length) {
    console.log(`\n审核历史（${view.history.length} 条）：`);
    for (const action of view.history) console.log(`  ${action.reviewed_at} ${action.reviewer} ${action.action} ${action.field_path}：${truncate(action.reason, 100)}`);
  }
}

async function main() {
  const { values, positional } = parseFlags(process.argv.slice(2), {
    booleans: ['json', 'all', 'bindCurrent', 'dryRun', 'confirm', 'help'],
    numbers: ['limit', 'offset'],
  });
  if (values.help) { console.log(usage); return; }
  const command = positional[0] ?? 'list';
  const database = values.database ? resolve(root, values.database) : workDatabase;
  if (!['list', 'show', 'apply', 'history', 'pending-repair'].includes(command)) throw new Error(`未知子命令：${command}\n\n${usage}`);

  if (command === 'apply') {
    if (!values.file) throw new Error('apply 需要 --file review.json');
    if (values.database && database !== workDatabase) throw new Error('apply 只写入工作库 data/distillation/spina.sqlite；不会修改演示库或外部数据库');
    const input = JSON.parse((await readFile(resolve(root, values.file), 'utf8')).replace(/^\uFEFF/, ''));
    if (values.reviewer) input.reviewer = values.reviewer;
    if (values.confirm) input.confirm = true;
    const store = await readStore(database, false);
    try {
      const result = applyReview(store, input, { bindCurrent: values.bindCurrent, dryRun: values.dryRun });
      if (values.json) { printJson(result); return; }
      console.log(`${result.applied ? '已发布' : '演练（未写入）'}：${result.paper_id}`);
      console.log(`依据版本：${JSON.stringify(result.previous)}`);
      console.log(`新版本：${JSON.stringify(result.published)}  状态=${result.verification_status}`);
      console.log(`审核动作 ${result.actions.length} 条：`);
      console.log(table(['动作', '字段/问题', '理由'], result.actions.map(action => [action.action, action.field_path, truncate(action.reason, 60)])));
      if (result.match_entries_rebuilt) console.log('已按修正后的相字段重建金属匹配索引。');
      for (const warning of result.structural_warnings) console.log(`注意：${warning}`);
      if (!result.applied) console.log('\n确认无误后去掉 --dry-run 重新执行。');
      else console.log('\n旧版本已被新修订替换；审核记录已写入 review_actions，可用 review history 查看。');
    } finally { store.close(); }
    return;
  }

  const store = await readStore(database, true);
  try {
    if (command === 'list') {
      const category = values.category;
      if (category && !REVIEW_CATEGORIES.includes(category)) throw new Error(`--category 必须为 ${REVIEW_CATEGORIES.join('、')}`);
      const result = listReviewIssues(store, {
        category, paperId: values.paper, includeResolved: Boolean(values.all),
        limit: values.limit, offset: values.offset,
      });
      if (values.json) { printJson(result); return; }
      printList(result, Boolean(values.all));
      return;
    }
    if (command === 'show') {
      if (!values.paper) throw new Error('show 需要 --paper');
      if (values.version && !['uncertain', 'verified'].includes(values.version)) throw new Error('--version 必须为 uncertain 或 verified');
      const view = showPaper(store, values.paper, values.version);
      if (values.json) { printJson(view); return; }
      printShow(view);
      return;
    }
    if (command === 'history') {
      if (!values.paper) throw new Error('history 需要 --paper');
      const actions = store.listReviewActions(values.paper);
      if (values.json) { printJson(actions); return; }
      if (!actions.length) { console.log('该论文没有人工审核记录。'); return; }
      console.log(table(['时间', '审核人', '动作', '字段', '理由', '依据版本'], actions.map(action => [
        action.reviewed_at, action.reviewer, action.action, action.field_path, truncate(action.reason, 50),
        `${action.record_ref.version}@r${action.record_ref.revision}`,
      ])));
      return;
    }
    if (command === 'pending-repair') {
      const rows = pendingRepairs(store, values.paper);
      if (values.json) { printJson(rows); return; }
      if (!rows.length) { console.log('没有待模型修正的审核请求。'); return; }
      console.log(table(['论文', '问题序号', '字段', '审核人', '请求理由'], rows.map(row => [row.paper_id, row.issue_index, row.field_path, row.reviewer, truncate(row.reason, 60)])));
      console.log('\n把这些请求作为 repair_uncertain_paper 的 feedback 传入，模型只会得到这里列出的问题。');
    }
  } finally { store.close(); }
}

try { await main(); }
catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/结构校验未通过/.test(message)) {
    const detail = message.replace(/^发布前结构校验未通过：/, '');
    console.error(`审核未发布：${detail}`);
    console.error('记录保持原版本；请先修正结构问题，或改用 keep_conflict/request_repair 记录该情况。');
  } else console.error(`核对失败：${message}`);
  process.exitCode = 1;
}
