import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile, realpath, lstat, stat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readCatalogFile } from './distillation/catalog.ts';
import { deliveryRecord } from './distillation/store.ts';
import { isExtractionIssue, isSourceLimitationIssue } from './distillation/missing-information.ts';
import { DraftSchema, VerificationSchema } from './distillation/schema.ts';
import { Type } from 'typebox';
import { Check } from 'typebox/value';

const root = fileURLToPath(new URL('../', import.meta.url));
const entrySchema = Type.Object({ sample_local_id: Type.String(), phase_local_id: Type.String(),
  metal_elements: Type.Array(Type.String()), element_key: Type.String() });
const recordSchema = Type.Object({ paper: Type.Object({ paper_id: Type.String({ minLength: 1 }), title: Type.String(), doi: Type.String() }),
  revision: Type.Integer({ minimum: 1 }), verified_at: Type.String(),
  sources: Type.Array(Type.Object({ id: Type.String(), path: Type.String() })),
  draft: DraftSchema, verification: VerificationSchema, match_entries: Type.Array(entrySchema),
  candidate_match_entries: Type.Optional(Type.Array(entrySchema)), uncertainties: Type.Optional(Type.Array(Type.String())),
});
function assertWithin(path, label) {
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`${label}必须位于项目内：${path}`);
}
async function projectPath(input, label) {
  const path = resolve(root, input); assertWithin(path, label);
  let cursor = path;
  while (true) {
    try { assertWithin(await realpath(cursor), label); return path; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const entry = await lstat(cursor).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (entry?.isSymbolicLink()) throw new Error(`${label}包含不可解析的目录链接：${cursor}`);
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
}
async function inputFile(input, label, optional = false) {
  const path = await projectPath(input, label);
  const info = await stat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) { if (optional) return null; throw new Error(`${label}不存在：${path}`); }
  if (!info.isFile()) throw new Error(`${label}不是文件：${path}`);
  return path;
}

async function main() {
  const { values } = parseArgs({ options: { database: { type: 'string' }, output: { type: 'string' }, catalog: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('用法：npm run report -- [--database 项目内数据库] [--catalog 项目内题录JSONL] [--output 项目内新目录]\n只读取数据库和可选题录，不读取 PDF；输出目录必须不存在。指定 --database 时默认不混入项目题录，可用 --catalog 显式选择。');
    return;
  }
  const generated = new Date();
  const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    .format(generated).replace(/[^0-9]/g, '');
  const output = await projectPath(values.output ?? `reports/knowledge-base-${stamp}`, '输出目录');
  if (await lstat(output).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) throw new Error(`输出目录已存在：${output}`);
  const database = await inputFile(values.database ?? 'data/distillation/spina.sqlite', '数据库');
  const sourceCatalog = values.catalog ? await inputFile(values.catalog, '题录')
    : values.database ? null : await inputFile('data/literature/selected-500.jsonl', '题录', true);
  let db;
  try { db = new DatabaseSync(database, { readOnly: true }); }
  catch (error) { throw new Error(`无法读取数据库：${database}（${error.message}）`); }
  let confirmed, uncertain, runs;
  const skipped = [], views = new Map();
  try {
    db.exec('BEGIN');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    if (!tables.has('papers') && !tables.has('uncertain_papers')) throw new Error('数据库缺少实验记录表：papers / uncertain_papers');
    const read = (table, column, key, version) => {
      if (!tables.has(table)) return [];
      let rows;
      try { rows = db.prepare(`SELECT ${key} AS row_key, paper_id, ${column} FROM ${table}`).all(); }
      catch (error) { throw new Error(`无法读取数据库表 ${table}：${error.message}`); }
      const valid = [];
      for (const row of rows) {
        try {
          const value = JSON.parse(row[column]);
          if (table === 'runs') {
            if (!value || value.run_id !== row.row_key || value.paper_id !== row.paper_id || typeof value.updated_at !== 'string' || typeof value.status !== 'string') throw new Error('任务记录结构或身份无效');
          } else {
            if (!Check(recordSchema, value)) throw new Error('实验记录结构无效');
            if (value.paper.paper_id !== row.paper_id) throw new Error('实验记录论文 ID 与数据库主键不一致');
            views.set(`${version}:${row.paper_id}`, deliveryRecord(value));
          }
          valid.push(value);
        } catch (error) {
          skipped.push({ table, version, paper_id: row.paper_id, ...(table === 'runs' ? { run_id: row.row_key } : {}),
            reason: error instanceof SyntaxError ? 'JSON 无法解析' : error.message });
        }
      }
      return valid;
    };
    confirmed = read('papers', 'record_json', 'paper_id', 'verified');
    uncertain = read('uncertain_papers', 'record_json', 'paper_id', 'uncertain');
    runs = read('runs', 'state_json', 'run_id', 'run');
    db.exec('COMMIT');
  } finally { db.close(); }
  const catalog = sourceCatalog ? await readCatalogFile(sourceCatalog) : [];
  const confirmedById = new Map(confirmed.map(record => [record.paper.paper_id, record]));
  const uncertainById = new Map(uncertain.map(record => [record.paper.paper_id, record]));
  const preferred = new Map([...uncertainById, ...confirmedById]);
  const catalogById = new Map(catalog.map(paper => [paper.paper_id, paper]));
  const latestRuns = new Map();
  for (const run of runs) if (!latestRuns.has(run.paper_id) || run.updated_at > latestRuns.get(run.paper_id).updated_at) latestRuns.set(run.paper_id, run);
  const ids = [...new Set([...catalogById.keys(), ...preferred.keys(), ...latestRuns.keys(), ...skipped.map(row => row.paper_id).filter(Boolean)])].sort();
  const inventory = ids.map(id => {
    const record = preferred.get(id), paper = record?.paper ?? catalogById.get(id), run = latestRuns.get(id);
    return { paper_id: id, title: paper?.title ?? '', doi: paper?.doi ?? '',
      version: record ? confirmedById.has(id) ? 'verified' : 'uncertain' : null,
      revision: record?.revision ?? null, verified_at: record?.verified_at ?? null,
      has_alternate_uncertain: confirmedById.has(id) && uncertainById.has(id),
      sample_count: record?.draft.samples.length ?? 0, match_count: record?.match_entries.length ?? 0,
      candidate_count: record?.candidate_match_entries?.length ?? 0,
      unreadable_versions: skipped.filter(row => row.table !== 'runs' && row.paper_id === id).map(row => row.version),
      extraction_issues: record?.verification.issues.filter(isExtractionIssue).length ?? 0,
      source_limitations: record?.verification.issues.filter(isSourceLimitationIssue).length ?? 0,
      latest_run: run ?? null };
  });
  const sampleRows = [...preferred].sort(([a], [b]) => a.localeCompare(b)).flatMap(([id, record]) => record.draft.samples.map(sample => ({
    paper_id: id, version: confirmedById.has(id) ? 'verified' : 'uncertain', sample_id: sample.local_id, name: sample.name,
    material_state: sample.material_state, shared_from: sample.shared_from,
    own_materials: sample.materials.length, own_steps: sample.steps.length,
    metal_sets: record.match_entries.filter(entry => entry.sample_local_id === sample.local_id).map(entry => entry.metal_elements.join('+')),
  })));
  const count = key => inventory.reduce((sum, paper) => sum + paper[key], 0);
  const overlap = inventory.filter(paper => paper.has_alternate_uncertain).length;
  const statistics = { catalog_papers: catalog.length, listed_papers: ids.length, unique_stored_papers: preferred.size,
    confirmed_versions: confirmed.length, uncertain_versions: uncertain.length, dual_version_papers: overlap,
    uncertain_only_papers: uncertainById.size - overlap, stored_versions: confirmed.length + uncertain.length,
    preferred_samples: sampleRows.length, preferred_match_entries: count('match_count'), preferred_possible_entries: count('candidate_count'),
    stored_empty_papers: inventory.filter(paper => paper.version && !paper.sample_count).length,
    not_stored_papers: inventory.filter(paper => !paper.version && !paper.unreadable_versions.length).length,
    unreadable_papers: inventory.filter(paper => !paper.version && paper.unreadable_versions.length).length,
    skipped_rows: skipped.length, runs: runs.length,
    extraction_issues: count('extraction_issues'), source_limitations: count('source_limitations') };
  const text = value => value === null || value === undefined ? '' : Array.isArray(value) ? value.join('；') : String(value);
  const cell = value => text(value).replaceAll('|', '\\|').replace(/\r?\n/g, ' ').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const table = (headers, rows) => [headers, headers.map(() => '---'), ...rows].map(row => `| ${row.map(cell).join(' | ')} |`).join('\n');
  const time = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'medium', hour12: false }).format(generated);
  const snapshot = { schema_version: 1, generated_at: generated.toISOString(), timezone: 'Asia/Shanghai', source_database: database, source_catalog: sourceCatalog,
    statistics, skipped, inventory, confirmed_records: confirmed, uncertain_records: uncertain, runs };
  // A new directory preserves existing reports, including snapshots from older workflows.
  await mkdir(dirname(output), { recursive: true });
  await projectPath(dirname(output), '输出目录');
  try { await mkdir(output); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`输出目录已存在：${output}`); throw error; }
  const save = (name, value) => writeFile(resolve(output, name), value + '\n');
  await save('records.json', JSON.stringify(snapshot, null, 2));
  await save('summary.json', JSON.stringify({ generated_at: snapshot.generated_at, source_database: database, source_catalog: sourceCatalog, ...statistics, skipped }, null, 2));
  await save('all-papers.md', ['# SpinA 全部论文清单', `生成时间：${time}（北京时间）。覆盖当前题录、实验库及库内任务的论文 ID 并集。`,
    table(['论文 ID', '默认版本', '题名', 'DOI', '样品', '匹配项', '可能匹配', '并存待核对版', '最近任务', '损坏版本'], inventory.map(paper => [paper.paper_id, paper.version ?? (paper.unreadable_versions.length ? '记录损坏' : '未入库'), paper.title, paper.doi, paper.sample_count, paper.match_count, paper.candidate_count, paper.has_alternate_uncertain ? '是' : '', paper.latest_run?.status ?? '', paper.unreadable_versions])),
    '## 未入库论文及库内任务说明', table(['论文 ID', '状态', '说明'], inventory.filter(paper => !paper.version && !paper.unreadable_versions.length).map(paper => [paper.paper_id, paper.latest_run?.status ?? '无任务', paper.latest_run?.message ?? '尚无库内任务记录']))].join('\n\n'));
  await save('all-samples.md', ['# SpinA 全部样品清单', `生成时间：${time}（北京时间）。按默认优先版本统计；原料和步骤数量仅指样品自身字段。`,
    table(['论文 ID', '版本', '样品 ID', '样品名', '材料状态', '共用父流程', '自身原料数', '自身步骤数', '匹配金属集合'], sampleRows.map(sample => [sample.paper_id, sample.version, sample.sample_id, sample.name, sample.material_state, sample.shared_from, sample.own_materials, sample.own_steps, sample.metal_sets])),
    '完整字段、短引文和并存版本见 records.json。具体方法使用 get_sample_preparation 展开。'].join('\n\n'));
  const details = ['# SpinA 逐篇制备知识', `生成时间：${time}（北京时间）。读取默认优先版本，保留库内缺项、来源限制和抽取问题。`];
  for (const [id, record] of [...preferred].sort(([a], [b]) => a.localeCompare(b))) details.push(`## ${id} · ${record.paper.title}`,
    `版本：${confirmedById.has(id) ? 'verified' : 'uncertain'}；修订：${record.revision}；DOI：${record.paper.doi}`,
    '```json\n' + JSON.stringify(views.get(`${confirmedById.has(id) ? 'verified' : 'uncertain'}:${id}`), null, 2) + '\n```');
  await save('knowledge-details.md', details.join('\n\n'));
  await save('report.md', ['# SpinA 知识库报告', `快照时间：${time}（北京时间）。只使用当前数据库和可选题录，不读取或要求保留原文文件。`,
    ...(skipped.length ? ['## 数据不完整：已跳过损坏记录', `有 ${skipped.length} 行无法读取，下列统计只覆盖可读取记录。损坏版本不计为未入库论文。`,
      table(['表', '版本', '论文 ID', '任务 ID', '原因'], skipped.map(row => [row.table, row.version, row.paper_id, row.run_id ?? '', row.reason]))] : []),
    `数据库：${database}；题录：${sourceCatalog ?? '未加入题录，仅统计本库实验和任务'}。`,
    table(['统计项', '数量'], [['题录论文', statistics.catalog_papers], ['全部列举论文 ID', statistics.listed_papers], ['已入库独立论文', statistics.unique_stored_papers], ['确认版本', statistics.confirmed_versions], ['待核对版本', statistics.uncertain_versions], ['两种版本并存的论文', statistics.dual_version_papers], ['仅有待核对版本的论文', statistics.uncertain_only_papers], ['默认版本样品记录', statistics.preferred_samples], ['默认版本匹配项', statistics.preferred_match_entries], ['默认版本可能匹配项', statistics.preferred_possible_entries], ['空实验记录', statistics.stored_empty_papers], ['未入库论文', statistics.not_stored_papers], ['库内任务记录', statistics.runs]]),
    '默认版本有确认版时优先确认版，否则读取待核对版；完整导出保留两种版本。匹配项按样品及相计数，样品可包含系列、共用流程和中间体，均不等于独立配方数量。',
    `默认版本有 ${statistics.extraction_issues} 条具体抽取问题和 ${statistics.source_limitations} 条核验来源限制。历史 uncertain 状态本身不等于发现错误；缺项、来源限制和抽取问题保持各自语义。`,
    '报告不以原文是否仍存在判断记录可用性。库内来源路径只作元数据保留；完整字段及保存的短引文见 records.json。',
    '## 文件', '- [全部论文](all-papers.md)\n- [全部样品](all-samples.md)\n- [逐篇制备内容](knowledge-details.md)\n- [完整结构化快照](records.json)\n- [统计 JSON](summary.json)'].join('\n\n'));
  console.log(JSON.stringify({ output, statistics, skipped }, null, 2));
}

try { await main(); }
catch (error) { console.error(`报告生成失败：${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
