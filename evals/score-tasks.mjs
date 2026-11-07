import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const defaultTasks = resolve(root, 'evals/tasks/frozen-20261105.json');

const usage = `SpinA 真实任务评测计分

  node evals/score-tasks.mjs --init results/run-1.json
  node evals/score-tasks.mjs --results results/run-1.json [--tasks <冻结题集>] [--json] [--output <md>]

结果文件每题必填：success、severe_factual_errors、source_support(full|partial|none)、
seconds、cost_usd、infra_failure（null 或原因）。未作答的题保持 null，不计入成功率但计入覆盖率。

分别报告：完整任务成功率、严重事实错误、来源支撑、耗时、成本、基础设施失败。
不把抽取准确率与回答忠实度合并成一个分数。`;

const flags = new Set(process.argv.slice(2));
const valueOf = name => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const has = name => flags.has(`--${name}`);

async function loadJson(path, label) {
  try { return JSON.parse((await readFile(resolve(root, path), 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { throw new Error(`${label}读取失败：${path}（${error.message}）`); }
}

function initTemplate(tasks, resultsPath) {
  return {
    schema_version: 1,
    run: {
      label: 'pilot-1', started_at: new Date().toISOString(), arm: 'spina', model: '',
      budget_usd_per_task: null, notes: '每完成一题就填写，不要事后补记',
    },
    tasks: tasks.tasks.map(task => ({
      id: task.id, category: task.category, success: null, severe_factual_errors: null,
      source_support: null, seconds: null, cost_usd: null, infra_failure: null, reviewer: '', notes: '',
    })),
  };
}

const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const percentile = (values, ratio) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
};
const round = (value, digits = 3) => value === null || value === undefined ? null : Number(value.toFixed(digits));

function score(tasks, results) {
  const known = new Map(tasks.tasks.map(task => [task.id, task]));
  const seen = new Set();
  for (const row of results.tasks ?? []) {
    if (!known.has(row.id)) throw new Error(`结果中出现未知题目 ID：${row.id}`);
    if (seen.has(row.id)) throw new Error(`结果中题目重复：${row.id}`);
    seen.add(row.id);
    if (row.source_support !== null && row.source_support !== undefined && !['full', 'partial', 'none'].includes(row.source_support)) {
      throw new Error(`题目 ${row.id} 的 source_support 必须为 full、partial、none 或 null`);
    }
  }
  // An infrastructure failure still counts as attempted: it must be visible, not silently dropped.
  const attempted = (results.tasks ?? []).filter(row => Boolean(row.infra_failure) || (row.success !== null && row.success !== undefined));
  const infra = attempted.filter(row => row.infra_failure);
  const graded = attempted.filter(row => !row.infra_failure);
  const successes = graded.filter(row => row.success === true);
  const severe = graded.filter(row => Number(row.severe_factual_errors ?? 0) > 0);
  const support = { full: 0, partial: 0, none: 0, unknown: 0 };
  for (const row of graded) support[row.source_support ?? 'unknown'] = (support[row.source_support ?? 'unknown'] ?? 0) + 1;
  const durations = graded.map(row => Number(row.seconds)).filter(value => Number.isFinite(value) && value >= 0);
  const costs = graded.map(row => Number(row.cost_usd)).filter(value => Number.isFinite(value) && value >= 0);

  const categories = {};
  for (const task of tasks.tasks) {
    const category = (categories[task.category] ??= { planned: 0, graded: 0, success: 0, severe: 0 });
    category.planned++;
    const row = graded.find(item => item.id === task.id);
    if (row) category.graded++;
    if (row?.success === true) category.success++;
    if (Number(row?.severe_factual_errors ?? 0) > 0) category.severe++;
  }

  return {
    planned: tasks.tasks.length,
    attempted: attempted.length,
    graded: graded.length,
    coverage: tasks.tasks.length ? round(attempted.length / tasks.tasks.length) : null,
    success: { count: successes.length, rate: graded.length ? round(successes.length / graded.length) : null },
    severe_errors: { count: severe.length, rate: graded.length ? round(severe.length / graded.length) : null, tasks: severe.map(row => row.id) },
    source_support: { ...support, supported_rate: graded.length ? round((support.full + support.partial) / graded.length) : null },
    time_seconds: { median: round(median(durations), 1), p90: round(percentile(durations, 0.9), 1), mean: durations.length ? round(durations.reduce((sum, value) => sum + value, 0) / durations.length, 1) : null, samples: durations.length },
    cost_usd: { total: costs.length ? round(costs.reduce((sum, value) => sum + value, 0), 4) : null, mean: costs.length ? round(costs.reduce((sum, value) => sum + value, 0) / costs.length, 4) : null, samples: costs.length },
    infra_failures: { count: infra.length, tasks: infra.map(row => ({ id: row.id, reason: row.infra_failure })) },
    categories,
    failures: graded.filter(row => row.success !== true).map(row => ({ id: row.id, notes: row.notes ?? '' })),
  };
}

function toMarkdown(tasks, results, summary) {
  const run = results.run ?? {};
  const lines = [
    '# SpinA 真实任务评测结果', '',
    `运行标签：${run.label ?? '未命名'}；方案：${run.arm ?? '未记录'}；模型：${run.model ?? '未记录'}`,
    `开始时间：${run.started_at ?? '未记录'}；题集：${tasks.frozen_at ?? '未记录'}（${summary.planned} 题）`, '',
    '## 汇总', '',
    '| 指标 | 数值 |', '| --- | --- |',
    `| 完成 / 计划（覆盖率） | ${summary.attempted} / ${summary.planned}（${summary.coverage === null ? '—' : `${(summary.coverage * 100).toFixed(1)}%`}） |`,
    `| 完整任务成功率 | ${summary.success.rate === null ? '—' : `${(summary.success.rate * 100).toFixed(1)}%（${summary.success.count}/${summary.graded}）`} |`,
    `| 严重事实错误 | ${summary.severe_errors.count} 题${summary.severe_errors.tasks.length ? `（${summary.severe_errors.tasks.join('、')}）` : ''} |`,
    `| 来源支撑（full+partial） | ${summary.source_support.supported_rate === null ? '—' : `${(summary.source_support.supported_rate * 100).toFixed(1)}%`}（full ${summary.source_support.full} / partial ${summary.source_support.partial} / none ${summary.source_support.none}） |`,
    `| 耗时中位数 / P90 | ${summary.time_seconds.median ?? '—'} s / ${summary.time_seconds.p90 ?? '—'} s |`,
    `| 成本合计 / 均摊 | ${summary.cost_usd.total === null ? '—' : `$${summary.cost_usd.total}`} / ${summary.cost_usd.mean === null ? '—' : `$${summary.cost_usd.mean}`} |`,
    `| 基础设施失败 | ${summary.infra_failures.count} 题${summary.infra_failures.count ? `（${summary.infra_failures.tasks.map(item => `${item.id}:${item.reason}`).join('；')}）` : ''} |`,
    '', '## 分类', '',
    '| 分类 | 计划 | 已评分 | 成功 | 含严重错误 |', '| --- | --- | --- | --- | --- |',
    ...Object.entries(summary.categories).map(([category, value]) => `| ${category} | ${value.planned} | ${value.graded} | ${value.success} | ${value.severe} |`),
    '', '## 未通过题目', '',
    ...(summary.failures.length ? summary.failures.map(item => `- ${item.id}：${item.notes || '未填写原因'}`) : ['- 无']),
    '', '## 口径', '',
    '- 基础设施失败（超时、认证、进程崩溃）不计入成功率，但单独报告数量与原因。',
    '- 抽取准确率与回答忠实度分开评估：模型忠实复述错误库存，不代表科学事实正确。',
    '- 若宣传效率优势，必须同时证明正确性没有降低。',
    '- 题集在试点前冻结；看到结果后修改题目会使本轮数据失效。',
  ];
  return lines.join('\n');
}

async function main() {
  if (has('help')) { console.log(usage); return; }
  const tasksPath = valueOf('tasks') ?? 'evals/tasks/frozen-20261105.json';
  const tasks = await loadJson(tasksPath, '冻结题集');
  if (!Array.isArray(tasks.tasks) || !tasks.tasks.length) throw new Error('冻结题集缺少 tasks');
  if (has('init')) {
    const target = valueOf('init');
    if (!target) throw new Error('--init 需要输出路径');
    const path = resolve(root, target);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(initTemplate(tasks, target), null, 2)}\n`);
    console.log(`已生成结果模板：${target}（${tasks.tasks.length} 题，逐题填写后运行 --results）`);
    return;
  }
  const resultsPath = valueOf('results');
  if (!resultsPath) throw new Error('请提供 --results <结果文件>，或用 --init 生成模板');
  const results = await loadJson(resultsPath, '结果文件');
  const summary = score(tasks, results);
  if (has('json')) { process.stdout.write(`${JSON.stringify({ run: results.run, summary }, null, 2)}\n`); return; }
  const markdown = toMarkdown(tasks, results, summary);
  const output = valueOf('output');
  if (output) {
    const path = resolve(root, output);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${markdown}\n`);
    console.log(`已写入 ${output}`);
  } else console.log(markdown);
}

try { await main(); }
catch (error) { console.error(`计分失败：${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
