import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExperimentStore } from './distillation/store.ts';
import { searchPreparationConditionsWith } from './distillation/conditions.ts';
import { searchRouteConstraintsWith } from './distillation/route.ts';
import { samplePreparation } from './distillation/preparation.ts';
import { preparationEvidence } from './distillation/evidence.ts';
import { table, printJson, truncate, parseFlags } from './cli-format.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const defaultDatabase = resolve(root, 'data/demo/spina.sqlite');

const usage = `SpinA 只读演示（不调用模型、不读取 PDF、不写数据库）

  npm run demo                                           概览与示例
  npm run demo -- search --metals Ni,Co [--superset] [--limit 10] [--exclude-uncertain] [--json]
  npm run demo -- conditions --temp-max 400 --dur-min 24 [--metals Ni,Co] [--material 尿素]
                               [--step annealing] [--exclude-uncertain] [--json]
  npm run demo -- route --max-temp 400 --max-hours 24 [--metals Ni,Co]
                          [--require annealing] [--forbid ball-milling] [--json]
  npm run demo -- sample --paper SPINA-0002 --sample S1 [--json]
  npm run demo -- evidence --paper SPINA-0002 --sample S1 --field samples.S1.steps.ST1.conditions.temperature [--json]

  --database <path>   指定其他数据库（只读打开，默认 data/demo/spina.sqlite）

温度单位 °C；时长单位 --dur-unit s|min|h|d（默认 h）；范围默认包含端点，
用 --temp-min-exclusive / --temp-max-exclusive 排除端点。

route 是整条路线约束：把样品及共用祖先的全部步骤聚合后判断最高温度、总时长、
必需/排除操作，结果分满足/不满足/无法判断。缺少时长的步骤只给下界，不使用估计值。`;

const refOf = (record, version) => ({
  paper_id: record.paper.paper_id, version, revision: record.revision, verified_at: record.verified_at,
});

function boundsFrom(values, prefix, unit) {
  const min = values[`${prefix}Min`], max = values[`${prefix}Max`];
  if (min === undefined && max === undefined) return undefined;
  return {
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(values[`${prefix}MinExclusive`] ? { min_inclusive: false } : {}),
    ...(values[`${prefix}MaxExclusive`] ? { max_inclusive: false } : {}),
    ...(unit ? { unit } : {}),
  };
}

async function overview(store) {
  const counts = store.counts();
  const { records } = store.readPublishedVersions(true);
  const sets = new Map();
  let samples = 0, possible = 0;
  for (const { record } of records) {
    samples += record.draft.samples.length;
    possible += record.candidate_match_entries?.length ?? 0;
    for (const entry of record.match_entries) {
      const key = entry.metal_elements.join('–');
      sets.set(key, (sets.get(key) ?? 0) + 1);
    }
  }
  console.log('SpinA 演示知识库（只读）');
  console.log(`数据库：${store.databasePath}`);
  console.log(`论文：${counts.papers} 篇确认版 + ${counts.uncertain_papers} 篇待核对版（两种版本可能对应同一论文，不能直接相加）`);
  console.log(`样品：${samples} 个；确定金属匹配项：${[...sets.values()].reduce((sum, value) => sum + value, 0)} 条；可能匹配项：${possible} 条；库内任务：${counts.runs} 条`);
  const top = [...sets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log(`\n常见目标相金属集合：${top.map(([key, value]) => `${key}(${value})`).join('  ')}`);
  console.log('\n示例（全部离线，不消耗额度）：');
  console.log('  npm run demo -- search --metals Ni,Co --limit 5');
  console.log('  npm run demo -- conditions --temp-max 400 --dur-min 24 --limit 5');
  console.log('  npm run demo -- sample --paper SPINA-0002 --sample S1');
  console.log('\n只读演示不调用模型、不读取 PDF、不写入数据库；没有模型认证也能用。');
  console.log('需要自然语言问答时再启动 npm start（需配置对话与核验模型）。');
}

function printSearch(result) {
  console.log(`金属集合 ${result.metal_elements.join('–')} · 匹配方式 ${result.match} · 共 ${result.total} 条（本页 ${result.results.length} 条）`);
  if (result.warnings?.length) for (const warning of result.warnings) console.log(`警告：${warning.paper_id} ${warning.message}`);
  console.log(table(['论文', '版本', '样品', '金属集合', '确定/可能', '方法摘要'], result.results.map(row => [
    row.paper.paper_id, row.record_ref.version, `${row.sample_id}${row.sample ? ` ${truncate(row.sample, 18)}` : ''}`,
    row.metal_elements.join('–'), row.possible ? '可能' : '确定', truncate(row.method_summary?.text ?? '（未报告方法）', 44),
  ])));
  if (result.results.length) {
    const first = result.results[0];
    console.log(`\n展开第一个样品：npm run demo -- sample --paper ${first.paper.paper_id} --sample ${first.sample_id}`);
  }
  if (result.has_more) console.log(`还有 ${result.total - result.offset - result.results.length} 条：--offset ${result.next_offset}`);
  if (result.related.total) console.log(`补充体系（含额外金属）：${result.related.total} 条，其中 ${result.related.uncertain} 条为待核对版本，${result.related.possible} 条为可能匹配；加 --superset 查看。`);
}

function printConditions(result) {
  console.log(`条件筛选 · 共 ${result.total} 个样品（本页 ${result.results.length}）· 字段命中 ${result.field_matches} · 待复核 ${result.needs_review} · 无可比较字段 ${result.unevaluable_samples}`);
  console.log('语义：同一步骤内的字段候选筛选；字段命中不代表整条配方满足，展开后核对适用范围。');
  if (result.warnings?.length) for (const warning of result.warnings) console.log(`警告：${warning.paper_id} ${warning.message}`);
  console.log(table(['论文', '版本', '样品', '判定', '命中步骤', '需复核原因'], result.results.map(row => [
    row.paper.paper_id, row.record_ref.version, `${row.sample_id} ${truncate(row.sample, 16)}`,
    row.match_status === 'field_match' ? '字段命中' : '待复核',
    row.step_matches.map(step => `${step.step_id ?? '样品变量'}(${step.state === 'field_match' ? '命中' : '复核'})`).join(',') || '—',
    truncate(row.reasons.join('；') || '—', 56),
  ])));
  if (result.results.length) {
    const first = result.results[0];
    console.log(`\n展开：npm run demo -- sample --paper ${first.paper.paper_id} --sample ${first.sample_id}`);
  }
  if (result.has_more) console.log(`还有 ${result.total - result.offset - result.results.length} 条：--offset ${result.next_offset}`);
}

function printSample(view) {
  console.log(`${view.paper.paper_id} · ${view.paper.title}`);
  console.log(`record_ref：${JSON.stringify(view.record_ref)}`);
  const preparation = view.preparation;
  console.log('\n按共用祖先到所选样品排列（不自动合并步骤或条件）：');
  for (const sample of preparation.samples) {
    console.log(`\n[${sample.local_id}] ${sample.name}  形态=${sample.material_state}  共用父流程=${sample.shared_from ?? '无'}`);
    for (const phase of sample.phases) console.log(`  相 ${phase.local_id} [${phase.role}] ${phase.formula?.value ?? '（未报告）'} / ${phase.identity?.value ?? '（未报告）'}`);
    for (const material of sample.materials) {
      const amount = material.amount?.value ?? material.amount?.status ?? '（未报告）';
      console.log(`  原料 ${material.local_id} ${material.identity?.raw ?? material.identity?.value ?? '（未报告）'}  用量=${amount}`);
    }
    for (const step of sample.steps) {
      const conditions = (step.conditions ?? []).map(condition => `${condition.name}=${condition.fact?.raw ?? condition.fact?.value}`).join('，');
      console.log(`  步骤 ${step.local_id} ${truncate(step.operation?.raw ?? step.operation?.value ?? '', 90)}${conditions ? `｜${conditions}` : ''}`);
    }
  }
  console.log(`\n缺项 ${view.missing_information.length} 条；来源限制 ${view.source_limitations.length} 条；抽取问题 ${view.issues.length} 条。`);
  for (const gap of view.missing_information.slice(0, 6)) console.log(`  缺项 ${gap.field_path}：${truncate(gap.message, 90)}`);
  for (const issue of view.issues.slice(0, 6)) console.log(`  问题 ${issue.field_path}：${truncate(issue.message, 90)}`);
  if (view.missing_information.length > 6 || view.issues.length > 6) console.log('  （其余见 npm run review -- show --paper ' + view.paper.paper_id + '）');
}

const fmtConstraint = (value, unit) => {
  if (!value) return '—';
  if (value.value === null && value.upper_bound === null) return value.status;
  const primary = value.value === null ? '' : `${value.value}${unit}`;
  const upper = value.upper_bound !== null && value.upper_bound !== value.value ? `–${value.upper_bound}${unit}` : '';
  return `${value.status} ${primary}${upper}`.trim();
};

function printRoute(result) {
  console.log(`整条路线约束 · 共 ${result.total} 个样品（满足 ${result.satisfied} / 无法判断 ${result.undetermined} / 不满足 ${result.violated}）`);
  console.log(result.semantics);
  console.log(table(['论文', '版本', '样品', '最高温度', '总时长', '操作', '判定'], result.results.map(item => [
    item.paper.paper_id, item.record_ref.version, `${item.sample_id} ${truncate(item.sample, 14)}`,
    item.max_temperature ? fmtConstraint(item.max_temperature, '°C') : '—',
    item.total_duration ? fmtConstraint({ ...item.total_duration, value: item.total_duration.value === null ? null : Number((item.total_duration.value / 3600).toFixed(2)), upper_bound: item.total_duration.upper_bound === null ? null : Number((item.total_duration.upper_bound / 3600).toFixed(2)) }, 'h') : '—',
    [...item.operations.required, ...item.operations.forbidden].map(operation => `${operation.term}:${operation.status}`).join(' ') || '—',
    item.overall,
  ])));
  const structure = result.results[0]?.route?.structure;
  if (structure) {
    console.log(`结构：按记录顺序聚合（并行 ${structure.parallelism_known ? '已标注' : '未标注'}，替换 ${structure.replacement_known ? '已标注' : '未标注'}）；继承步骤 ${structure.inherited_step_count} 个`);
    for (const warning of structure.warnings) console.log(`  · ${warning}`);
  }
  const attention = result.results.filter(item => item.overall !== 'satisfied').slice(0, 3);
  for (const item of attention) console.log(`\n${item.paper.paper_id}/${item.sample_id}：${item.reasons.join('；')}`);
  if (result.results.length) {
    const first = result.results[0];
    console.log(`\n展开：npm run demo -- sample --paper ${first.paper.paper_id} --sample ${first.sample_id} --version ${first.record_ref.version}`);
  }
  if (result.has_more) console.log(`还有 ${result.total - result.offset - result.results.length} 条：--offset ${result.next_offset}`);
}

async function main() {
  const { values, positional } = parseFlags(process.argv.slice(2), {
    booleans: ['json', 'help', 'superset', 'includeUncertain', 'excludeUncertain', 'tempMinExclusive', 'tempMaxExclusive', 'durMinExclusive', 'durMaxExclusive'],
    numbers: ['limit', 'offset', 'tempMin', 'tempMax', 'durMin', 'durMax', 'maxTemp', 'maxHours'],
    repeated: ['material', 'materialNot', 'step', 'require', 'forbid'],
  });
  if (values.help) { console.log(usage); return; }
  const command = positional[0] ?? 'overview';
  const database = values.database ? resolve(root, values.database) : defaultDatabase;
  const includeUncertain = values.excludeUncertain ? false : values.includeUncertain !== false;
  const store = await ExperimentStore.openReadOnly(database);
  try {
    if (command === 'overview') { await overview(store); return; }
    if (command === 'search') {
      const metals = String(values.metals ?? '').split(',').map(item => item.trim()).filter(Boolean);
      if (!metals.length) throw new Error('search 需要 --metals Ni,Co');
      const result = store.searchByElements(metals, {
        includeUncertain,
        match: values.superset ? 'superset' : 'exact',
        limit: values.limit, offset: values.offset,
      });
      if (values.json) { printJson(result); return; }
      printSearch(result);
      return;
    }
    if (command === 'conditions') {
      const metals = values.metals ? String(values.metals).split(',').map(item => item.trim()).filter(Boolean) : undefined;
      const temperature = boundsFrom(values, 'temp');
      const duration = boundsFrom(values, 'dur', values.durUnit ?? 'h');
      const materials = [
        ...(values.material ?? []).map(term => ({ terms: [term], mode: 'listed' })),
        ...(values.materialNot ?? []).map(term => ({ terms: [term], mode: 'not_listed' })),
      ];
      const query = {
        ...(metals ? { metal_elements: metals } : {}),
        ...(values.superset ? { match: 'superset' } : {}),
        include_uncertain: includeUncertain,
        ...(values.step ? { step_terms: values.step } : {}),
        ...(temperature ? { temperature } : {}),
        ...(duration ? { duration } : {}),
        ...(materials.length ? { materials } : {}),
        ...(values.limit === undefined ? {} : { limit: values.limit }),
        ...(values.offset === undefined ? {} : { offset: values.offset }),
      };
      if (!temperature && !duration && !materials.length) throw new Error('conditions 至少需要温度、时长或原料条件之一');
      const result = searchPreparationConditionsWith(store, query);
      if (values.json) { printJson(result); return; }
      printConditions(result);
      return;
    }
    if (command === 'route') {
      const metals = values.metals ? String(values.metals).split(',').map(item => item.trim()).filter(Boolean) : undefined;
      const query = {
        ...(metals ? { metal_elements: metals } : {}),
        ...(values.superset ? { match: 'superset' } : {}),
        include_uncertain: includeUncertain,
        ...(values.maxTemp === undefined ? {} : { max_temperature: values.maxTemp }),
        ...(values.maxHours === undefined ? {} : { max_total_duration_hours: values.maxHours }),
        ...(values.require ? { required_operations: values.require } : {}),
        ...(values.forbid ? { forbidden_operations: values.forbid } : {}),
        ...(values.limit === undefined ? {} : { limit: values.limit }),
        ...(values.offset === undefined ? {} : { offset: values.offset }),
      };
      const result = searchRouteConstraintsWith(store, query);
      if (values.json) { printJson(result); return; }
      printRoute(result);
      return;
    }
    if (command === 'sample' || command === 'evidence') {
      if (!values.paper) throw new Error(`${command} 需要 --paper`);
      if (!values.sample) throw new Error(`${command} 需要 --sample`);
      if (values.version && !['verified', 'uncertain'].includes(values.version)) throw new Error('--version 必须为 verified 或 uncertain');
      // Bind to the version that actually contains the sample; a paper can exist in both tables.
      const candidates = values.version ? [values.version] : ['verified', 'uncertain'];
      let picked = null;
      for (const candidate of candidates) {
        const record = store.getPaper(values.paper, candidate);
        if (record && record.draft.samples.some(sample => sample.local_id === values.sample)) { picked = { record, version: candidate }; break; }
      }
      if (!picked) {
        const available = [...new Set(candidates.flatMap(candidate => (store.getPaper(values.paper, candidate)?.draft.samples ?? []).map(sample => sample.local_id)))];
        if (!available.length) throw new Error(`库中没有该论文：${values.paper}`);
        throw new Error(`所选版本中不存在样品：${values.sample}；可用样品：${available.join('、')}（用 --version 指定 verified 或 uncertain）`);
      }
      const { record, version } = picked;
      const ref = refOf(record, version);
      if (command === 'sample') {
        const view = samplePreparation(store, ref, values.sample);
        if (values.json) { printJson(view); return; }
        printSample(view);
        return;
      }
      if (!values.field) throw new Error('evidence 需要 --field，例如 samples.S1.steps.ST1.conditions.temperature');
      const view = preparationEvidence(store, ref, values.sample, values.field);
      if (values.json) { printJson(view); return; }
      console.log(`${view.paper.paper_id} · ${view.field_path} · 证据范围=${view.evidence_scope}`);
      if (view.ambiguous) console.log('该字段在同名对象中有多项，全部列出，不能任取一项。');
      for (const field of view.fields) {
        console.log(`\n[${field.source_sample_id}] 状态=${field.fact.status} 原文=${field.fact.raw ?? '—'} 值=${JSON.stringify(field.fact.value)} 单位=${field.fact.unit ?? '—'}`);
        if (field.fact.note) console.log(`  限定：${field.fact.note}`);
        for (const evidence of field.fact.evidence) console.log(`  证据：${evidence.source_id} 第 ${evidence.page} 页「${truncate(evidence.quote, 140)}」`);
        if (!field.fact.evidence.length) console.log('  证据：无保存引文（只代表库存记录，不等于重新核对原文）');
      }
      for (const issue of view.issues) console.log(`\n相关问题：${issue.field_path} ${issue.resolution_status} ${truncate(issue.current_value, 120)}`);
      return;
    }
    throw new Error(`未知子命令：${command}\n\n${usage}`);
  } finally { store.close(); }
}

try { await main(); }
catch (error) { console.error(`演示读取失败：${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
