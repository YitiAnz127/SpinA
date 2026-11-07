import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExperimentStore } from './distillation/store.ts';
import { preparationChain } from './distillation/preparation.ts';
import { missingInformation, sourceLimitations } from './distillation/missing-information.ts';
import { parseFlags, printJson, truncate } from './cli-format.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const workDatabase = resolve(root, 'data/distillation/spina.sqlite');

const usage = `SpinA 候选对照导出

  npm run export -- --paper SPINA-0001:S1 --paper SPINA-0002:S2 --format md
  npm run export -- --select selection.json --format csv --output exports/组会对照.csv
  npm run export -- --paper SPINA-0001:S1 --stdout

选项：
  --paper <论文ID>:<样品ID>   可重复，2–5 个样品为宜（也支持 :样品ID:版本）
  --select <json>             { "conditions": "...", "samples": [{ "paper_id": "...", "sample_id": "..." }] }
  --format md|csv|json        默认 md
  --output <路径>             默认 exports/spina-comparison-<时间>.md；已存在时拒绝覆盖
  --database <路径>           默认工作库，只读打开
  --stdout                    同时打印到终端

每个单元格保留样品与字段归属；不跨论文合并"最好条件"。导出记录当时的
record_ref、查询条件与生成时间，后续更新不会悄悄改写旧文件。`;

const stamp = () => new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const factText = fact => {
  if (!fact) return '';
  if (fact.status === 'not_reported') return '未报告';
  if (fact.status === 'source_missing') return '来源未取得';
  const value = Array.isArray(fact.value) ? fact.value.join('、') : fact.value;
  const base = fact.raw ?? (value === null ? '' : String(value));
  const withUnit = fact.unit && typeof base === 'string' && !base.includes(fact.unit) ? `${base} ${fact.unit}` : base;
  return fact.status === 'reported' ? String(withUnit) : `${withUnit}（${fact.status}）`;
};
const cell = (text, fields = []) => ({ text: String(text ?? '').trim(), fields });
const joinCells = (cells, separator) => cells.filter(item => item.text).map(item => item.text).join(separator);

function collect(record, sampleId, version) {
  const chain = preparationChain(record.draft, sampleId);
  const target = chain[chain.length - 1];
  const scope = new Set(chain.map(sample => sample.local_id));
  const field = (sampleIdValue, path, fact) => ({ sample_id: sampleIdValue, field_path: `samples.${sampleIdValue}.${path}`, status: fact?.status ?? 'unknown' });

  const phases = target.phases.filter(phase => phase.role === 'target_spinel');
  const metalSets = record.match_entries.filter(entry => entry.sample_local_id === sampleId).map(entry => entry.metal_elements.join('–'));
  const phaseCell = cell(phases.map(phase => `${factText(phase.formula)}｜${factText(phase.identity)}${metalSets.length ? `｜${metalSets.join('/')}` : ''}`).join('；'),
    phases.flatMap(phase => [field(sampleId, `phases.${phase.local_id}.formula`, phase.formula), field(sampleId, `phases.${phase.local_id}.identity`, phase.identity)]));

  const materials = chain.flatMap(sample => sample.materials.map(material => ({
    sample: sample.local_id, text: `${factText(material.identity)}${material.amount.status === 'not_reported' ? '（用量未报告）' : ` ${factText(material.amount)}`}`,
    fields: [field(sample.local_id, `materials.${material.local_id}.identity`, material.identity), field(sample.local_id, `materials.${material.local_id}.amount`, material.amount)],
  })));
  const materialCell = cell(materials.map(item => `${item.text}〔${item.sample}〕`).join('；'), materials.flatMap(item => item.fields));

  const steps = chain.flatMap(sample => sample.steps.map(step => ({
    sample: sample.local_id,
    text: `${step.local_id} ${truncate(factText(step.operation), 70)}${step.conditions.length ? `（${step.conditions.map(condition => `${condition.name}=${factText(condition.fact)}`).join('，')}）` : ''}`,
    fields: [field(sample.local_id, `steps.${step.local_id}.operation`, step.operation), ...step.conditions.map(condition => field(sample.local_id, `steps.${step.local_id}.conditions.${condition.name}`, condition.fact))],
  })));
  const stepCell = cell(steps.map(item => `${item.text}〔${item.sample}〕`).join('；'), steps.flatMap(item => item.fields));

  const conditionsOf = pattern => chain.flatMap(sample => sample.steps.flatMap(step => step.conditions
    .filter(condition => pattern.test(condition.name))
    .map(condition => ({ sample: sample.local_id, text: `${condition.name}=${factText(condition.fact)}`, fact: condition.fact, path: `steps.${step.local_id}.conditions.${condition.name}` }))));
  const temp = conditionsOf(/temp|温度/i), duration = conditionsOf(/duration|time|时长|时间/i), atmosphere = conditionsOf(/atmosphere|atmos|gas|气氛|ambient/i);
  const keyConditions = cell([...temp, ...duration, ...atmosphere].map(item => `${item.text}〔${item.sample}〕`).join('；'),
    [...temp, ...duration, ...atmosphere].map(item => field(item.sample, item.path, item.fact)));

  const gaps = missingInformation(record, scope);
  const limits = sourceLimitations(record, scope);
  const gapCell = cell([...gaps.map(gap => `${gap.field_path}：${gap.message}`), ...limits.map(limit => `${limit.field_path}：${limit.message}`)]
    .slice(0, 12).join('；') + (gaps.length + limits.length > 12 ? `；…共 ${gaps.length + limits.length} 条` : ''),
    [...gaps, ...limits].map(gap => ({ sample_id: gap.sample_id, field_path: gap.field_path, status: gap.status })));

  const pages = new Map();
  const collectEvidence = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(collectEvidence); return; }
    if ('raw' in value && 'evidence' in value) { for (const ref of value.evidence ?? []) pages.set(`${ref.source_id}:${ref.page}`, ref); return; }
    Object.values(value).forEach(collectEvidence);
  };
  collectEvidence(chain.map(sample => ({ phases: sample.phases, materials: sample.materials, steps: sample.steps, method: sample.method })));
  const sourceCell = cell(record.sources.map(source => `${source.id}(${source.kind},${source.page_count}页)`).join('；') +
    (pages.size ? `；引用页 ${[...pages.values()].map(ref => `${ref.source_id} p${ref.page}`).join(', ')}` : ''),
    [...pages.values()].map(ref => ({ source_id: ref.source_id, page: ref.page, quote: ref.quote })));

  return {
    paper_id: record.paper.paper_id, paper_title: record.paper.title, doi: record.paper.doi,
    sample_id: sampleId, sample_name: target.name, material_state: target.material_state,
    record_ref: { paper_id: record.paper.paper_id, version, revision: record.revision, verified_at: record.verified_at },
    cells: {
      phase: phaseCell, materials: materialCell, steps: stepCell, key_conditions: keyConditions,
      state: cell(target.material_state, []), gaps: gapCell, sources: sourceCell,
    },
  };
}

const COLUMNS = [
  ['论文 / 样品', row => cell(`${row.paper_id} ${row.sample_id}`, [])],
  ['目标相（化学式｜身份｜金属集合）', row => row.cells.phase],
  ['原料与用量', row => row.cells.materials],
  ['关键步骤', row => row.cells.steps],
  ['温度 / 时长 / 气氛', row => row.cells.key_conditions],
  ['样品形态', row => row.cells.state],
  ['重要缺项与来源限制', row => row.cells.gaps],
  ['来源与引用页', row => row.cells.sources],
  ['record_ref', row => cell(`${row.record_ref.version}@r${row.record_ref.revision} ${row.record_ref.verified_at}`, [])],
];

function toMarkdown(rows, meta) {
  const escape = value => String(value).replaceAll('|', '\\|').replace(/\r?\n/g, '<br>');
  const attributed = value => value.fields.length && !value.text.includes('〔')
    ? `${value.text}〔${[...new Set(value.fields.map(field => field.sample_id ?? field.source_id ?? '论文'))].join('/')}〕`
    : value.text;
  const header = `| ${COLUMNS.map(([title]) => title).join(' | ')} |`;
  const divider = `| ${COLUMNS.map(() => '---').join(' | ')} |`;
  const body = rows.map(row => `| ${COLUMNS.map(([, read]) => escape(attributed(read(row)) || '—')).join(' | ')} |`);
  return [
    '# SpinA 候选样品对照', '',
    `生成时间：${meta.generated_at}（北京时间）`,
    `数据库：${meta.database}`,
    `查询条件：${meta.conditions || '（未记录，本次为手工选择样品）'}`,
    '', '每个单元格后的〔…〕标注该内容来自哪个样品或来源；共用祖先的字段保留原始归属，不合并为单一配方。',
    '缺项与来源限制按样品分别保留；不同论文的条件不能拼成一条路线。', '',
    header, divider, ...body, '',
    '## 版本绑定', '',
    ...rows.map(row => `- ${row.paper_id} / ${row.sample_id}：${row.record_ref.version} 修订 ${row.record_ref.revision}，${row.record_ref.verified_at}`),
    '', '旧文件不会随库更新而变化；需要最新版本时重新导出。',
  ].join('\n');
}

function toCsv(rows) {
  const quote = value => `"${String(value ?? '').replaceAll('"', '""').replace(/\r?\n/g, ' ')}"`;
  const header = COLUMNS.map(([title]) => quote(title)).join(',');
  const body = rows.map(row => COLUMNS.map(([, read]) => {
    const value = read(row);
    const fields = value.fields.length ? `〔${[...new Set(value.fields.map(field => field.field_path))].join('；')}〕` : '';
    return quote(`${value.text}${fields}`);
  }).join(','));
  return [header, ...body].join('\n');
}

function toJson(rows, meta) {
  return JSON.stringify({ ...meta, samples: rows.map(row => ({ ...row, columns: Object.fromEntries(COLUMNS.map(([title, read]) => [title, read(row)])) })) }, null, 2);
}

function parseSelection(values) {
  const samples = [];
  for (const spec of values.paper ?? []) {
    const parts = spec.split(':');
    if (parts.length < 2) throw new Error(`--paper 需要 <论文ID>:<样品ID>，收到 ${spec}`);
    samples.push({ paper_id: parts[0], sample_id: parts[1], ...(parts[2] ? { version: parts[2] } : {}) });
  }
  return samples;
}

async function main() {
  const { values } = parseFlags(process.argv.slice(2), {
    booleans: ['help', 'stdout', 'json', 'force'], repeated: ['paper'],
  });
  if (values.help) { console.log(usage); return; }
  let conditions = values.conditions ?? '';
  let selections = parseSelection(values);
  if (values.select) {
    const file = JSON.parse((await readFile(resolve(root, values.select), 'utf8')).replace(/^\uFEFF/, ''));
    conditions = file.conditions ?? conditions;
    selections = [...(file.samples ?? []), ...selections];
  }
  if (!selections.length) throw new Error('请用 --paper <论文ID>:<样品ID> 或 --select selection.json 指定样品');
  if (selections.length > 20) throw new Error('一次最多导出 20 个样品；组会对照建议 2–5 个');

  const database = values.database ? resolve(root, values.database) : workDatabase;
  const store = await ExperimentStore.openReadOnly(database);
  const rows = [];
  try {
    for (const selection of selections) {
      const version = selection.version ?? (store.getPaper(selection.paper_id, 'verified') ? 'verified' : 'uncertain');
      if (version !== 'verified' && version !== 'uncertain') throw new Error(`版本必须为 verified 或 uncertain：${selection.paper_id}`);
      const record = store.getPaper(selection.paper_id, version);
      if (!record) throw new Error(`库中没有该论文：${selection.paper_id}（${version}）`);
      try { rows.push(collect(record, selection.sample_id, version)); }
      catch (error) { throw new Error(`${selection.paper_id}/${selection.sample_id}：${error instanceof Error ? error.message : String(error)}`); }
    }
  } finally { store.close(); }

  const meta = {
    schema_version: 1,
    generated_at: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date()),
    database: database.replaceAll('\\', '/'),
    conditions,
    note: '单元格保留样品与字段归属；不跨论文合并条件。',
  };
  const format = values.format ?? 'md';
  if (!['md', 'csv', 'json'].includes(format)) throw new Error('--format 必须为 md、csv 或 json');
  const content = format === 'md' ? toMarkdown(rows, meta) : format === 'csv' ? toCsv(rows) : toJson(rows, meta);

  if (values.json) { printJson({ ...meta, samples: rows }); return; }
  if (values.stdout) console.log(content);
  const output = resolve(root, values.output ?? `exports/spina-comparison-${stamp()}.${format}`);
  const relativePath = relative(root, output);
  if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) throw new Error('导出路径必须在项目内');
  if (await stat(output).then(() => true).catch(() => false)) {
    if (!values.force) throw new Error(`输出文件已存在，拒绝覆盖：${output}；换一个 --output 或加 --force`);
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${content}\n`);
  console.log(`已导出 ${rows.length} 个样品：${output}`);
  console.log(`格式 ${format}；条件：${conditions || '（未记录）'}`);
  console.log('每个样品绑定导出时的 record_ref；库更新后旧文件保持原样。');
}

try { await main(); }
catch (error) { console.error(`导出失败：${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
