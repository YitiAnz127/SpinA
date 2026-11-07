import { cp, mkdir, readFile, readdir, rename, rm, lstat, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExperimentStore } from './distillation/store.ts';
import { ResearchStore } from './research/store.ts';
import { table, printJson, parseFlags } from './cli-format.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const workDatabase = resolve(root, 'data/distillation/spina.sqlite');

const backupsRoot = resolve(root, 'backups');

const usage = `SpinA 数据备份与恢复

  npm run backup                                  轻量包（只含可查询知识）
  npm run backup -- --full                        完整工作包（含任务产物与配置摘要）
  npm run backup -- --include-sources             完整工作包并复制记录引用的 PDF 原件
  npm run backup -- --output backups/my-backup    指定输出目录（必须不存在）
  npm run backup -- --database <path>             备份其他数据库（仍在项目内）
  npm run backup -- --verify backups/<name>       校验既有备份：摘要、计数、固定查询
  npm run backup -- --restore backups/<name> --to restore-check
                                                  恢复到独立空目录并立即校验
  npm run backup -- --drill                       自动演练：备份 → 校验 → 恢复 → 校验

一致性：数据库使用 SQLite VACUUM INTO 生成快照，不复制正在写入的数据库文件。
凭据与会话历史（.env、.runtime/sessions、.runtime/model-store.json）不进入任何备份包。
备份先写入临时目录，成功后才改名；目标已存在时拒绝覆盖。`;

const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const stamp = () => {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
};
const exists = async path => { try { await stat(path); return true; } catch { return false; } };
async function assertInside(path, label) {
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`${label}必须位于项目内：${path}`);
  let current = path;
  while (relative(root, current)) {
    const info = await lstat(current).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (info?.isSymbolicLink()) throw new Error(`${label}不允许目录链接或符号链接`);
    current = dirname(current);
  }
}
const safeParts = name => typeof name === 'string' && name.split('/').every(part =>
  part && !/[\\:\x00-\x1f]/.test(part) && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
const paperPath = name => safeParts(name) && /^data\/paper\/.+\.pdf$/i.test(name);
const sqlPath = path => `'${path.replaceAll("'", "''")}'`;

async function directorySize(path) {
  let bytes = 0, files = 0;
  for (const entry of await readdir(path, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const info = await stat(join(entry.parentPath ?? entry.path, entry.name));
    bytes += info.size; files++;
  }
  return { bytes, files };
}

async function listFiles(path, base = path) {
  const out = [];
  for (const entry of await readdir(path, { withFileTypes: true, recursive: true })) {
    if (entry.isSymbolicLink()) throw new Error('任务产物含链接，无法创建独立备份');
    if (!entry.isFile()) continue;
    const absolute = join(entry.parentPath ?? entry.path, entry.name);
    out.push({ path: relative(base, absolute).split(sep).join('/'), absolute });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

async function configSummary() {
  const { SOL_POLICY } = await import('./model-policy.ts');
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  return {
    tool: { name: manifest.name, version: manifest.version },
    node: process.versions.node,
    verifier: `${SOL_POLICY.provider}/${SOL_POLICY.model}:${SOL_POLICY.reasoning}`,
    distillation: {
      model: process.env.SPINA_DISTILL_MODEL ?? 'deepseek-flash',
      effort: process.env.SPINA_DISTILL_EFFORT ?? 'high',
      repair_effort: process.env.SPINA_REPAIR_EFFORT ?? 'max',
      api_key_configured: Boolean(process.env.DEEPSEEK_API_KEY?.trim()),
    },
    batch_concurrency: process.env.SPINA_BATCH_CONCURRENCY ?? '2',
    pdf: {
      python: process.env.SPINA_PDF_PYTHON ?? null,
      ocr_languages: process.env.SPINA_OCR_LANGUAGES ?? 'eng+chi_sim',
      pdftoppm: process.env.SPINA_PDFTOPPM_PATH ?? null,
    },
    data_contract: { record_schema_version: 1, database: 'spina.sqlite' },
  };
}

function vacuumInto(database, destination) {
  const db = new DatabaseSync(database, { readOnly: true });
  try { db.exec(`VACUUM INTO ${sqlPath(destination)}`); }
  finally { db.close(); }
}

async function referencedSources(database) {
  const store = await ExperimentStore.openReadOnly(database);
  try {
    const { records } = store.readPublishedVersions(true);
    const paths = new Set();
    for (const { record } of records) for (const source of record.sources) paths.add(source.path);
    return [...paths].sort();
  } finally { store.close(); }
}

async function createBackup(options) {
  const database = resolve(root, options.database ?? workDatabase);
  await assertInside(database, '数据库');
  if (!await exists(database)) throw new Error(`数据库不存在：${database}；没有可备份的知识库`);
  const output = resolve(root, options.output ?? join('backups', `spina-${stamp()}`));
  await assertInside(output, '备份目录');
  if (await exists(output)) throw new Error(`备份目录已存在，不覆盖上一份备份：${output}`);
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${randomUUID()}`;
  await mkdir(temporary, { recursive: true });
  try {
    const backupDatabase = join(temporary, 'spina.sqlite');
    vacuumInto(database, backupDatabase);
    // Research artifacts live beside the knowledge DB, not inside it. Only accept the
    // standard `<project>/data/...` layout; otherwise fall back to the repository root.
    const derivedRoot = resolve(dirname(dirname(dirname(database))));
    const relativeToDerived = relative(derivedRoot, database).split(sep).join('/');
    const projectRoot = relativeToDerived.startsWith('data/') ? derivedRoot : root;
    const runsDirectory = join(dirname(database), 'runs');
    const researchDatabase = resolve(projectRoot, 'data/research/research.sqlite');
    const store = await ExperimentStore.openReadOnly(backupDatabase);
    let digest, counts;
    try { digest = store.digest(); counts = digest.counts; }
    finally { store.close(); }

    const manifest = {
      schema_version: 1,
      kind: options.full || options.includeSources ? 'full' : 'light',
      created_at: new Date().toISOString(),
      source: { database, relative: relative(root, database).split(sep).join('/') },
      database: {
        file: 'spina.sqlite', bytes: (await stat(backupDatabase)).size,
        sha256: await sha256(backupDatabase), digest, counts,
      },
      config: await configSummary(),
      excluded: ['.env', '.runtime/sessions', '.runtime/model-store.json', 'node_modules'],
      artifacts: { included: false },
      research: { included: false },
      sources: { included: false, files: 0 },
    };

    if (manifest.kind === 'full' && relativeToDerived.startsWith('data/distillation/') && await exists(researchDatabase)) {
      await assertInside(researchDatabase, '研究库');
      const target = join(temporary, 'research.sqlite');
      vacuumInto(researchDatabase, target);
      const research = await ResearchStore.openFile(target, true);
      let counts;
      try { counts = research.counts(); } finally { research.close(); }
      manifest.research = { included: true, file: 'research.sqlite', bytes: (await stat(target)).size, sha256: await sha256(target), counts };
    }

    if (manifest.kind === 'full') {
      const files = [];
      if (await exists(runsDirectory)) {
        await assertInside(runsDirectory, '任务目录');
        for (const entry of await listFiles(runsDirectory)) {
          const target = join(temporary, 'runs', entry.path);
          await mkdir(dirname(target), { recursive: true });
          await cp(entry.absolute, target);
        }
        await mkdir(join(temporary, 'runs'), { recursive: true });
        for (const file of await listFiles(join(temporary, 'runs'))) {
          files.push({ path: `runs/${file.path}`, bytes: (await stat(file.absolute)).size, sha256: await sha256(file.absolute) });
        }
      }
      const batchDirectory = join(dirname(database), 'batch');
      for (const name of ['queue.json', 'state.json', 'control.json']) {
        const path = join(batchDirectory, name);
        if (!await exists(path)) continue;
        await assertInside(path, '批处理文件');
        await cp(path, join(temporary, 'batch', name));
        files.push({ path: `batch/${name}`, bytes: (await stat(join(temporary, 'batch', name))).size, sha256: await sha256(join(temporary, 'batch', name)) });
      }
      await writeFile(join(temporary, 'artifacts.json'), `${JSON.stringify({ schema_version: 1, files }, null, 2)}\n`);
      const size = await directorySize(join(temporary, 'runs')).catch(() => ({ bytes: 0, files: 0 }));
      manifest.artifacts = { included: true, runs_files: files.filter(file => file.path.startsWith('runs/')).length, bytes: size.bytes, files };
    }

    if (options.includeSources) {
      const sources = await referencedSources(backupDatabase);
      const copied = [];
      for (const source of sources) {
        if (!paperPath(source)) throw new Error('来源必须是 data/paper 内的 PDF');
        const path = resolve(projectRoot, source);
        await assertInside(path, '原件');
        if (!await exists(path)) continue;
        const target = join(temporary, 'sources', source);
        await mkdir(dirname(target), { recursive: true });
        await cp(path, target);
        copied.push({ path: relative(temporary, target).split(sep).join('/'), source, bytes: (await stat(target)).size, sha256: await sha256(target) });
      }
      manifest.sources = { included: true, files: copied.length, referenced: sources.length, manifest: copied };
      await writeFile(join(temporary, 'sources.json'), `${JSON.stringify({ schema_version: 1, files: copied }, null, 2)}\n`);
    }

    await writeFile(join(temporary, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(temporary, output);
    return { output, manifest };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function verifyBackup(directory) {
  const path = resolve(root, directory);
  await assertInside(path, '备份目录');
  await assertInside(join(path, 'manifest.json'), '备份清单');
  const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
  if (manifest.database.file !== 'spina.sqlite' || (manifest.research?.included && manifest.research.file !== 'research.sqlite')) throw new Error('备份数据库文件名无效');
  const database = join(path, manifest.database.file);
  await assertInside(database, '备份数据库');
  const problems = [];
  if (!await exists(database)) problems.push('缺少数据库文件');
  else {
    const actualHash = await sha256(database);
    if (actualHash !== manifest.database.sha256) problems.push(`数据库摘要不符：期望 ${manifest.database.sha256.slice(0, 12)}…，实际 ${actualHash.slice(0, 12)}…`);
    const store = await ExperimentStore.openReadOnly(database);
    try {
      const digest = store.digest();
      if (digest.sha256 !== manifest.database.digest.sha256) problems.push(`知识摘要不符：期望 ${manifest.database.digest.sha256.slice(0, 12)}…，实际 ${digest.sha256.slice(0, 12)}…`);
      for (const key of ['papers', 'uncertain_papers', 'runs', 'review_actions']) {
        if (digest.counts[key] !== manifest.database.counts[key]) problems.push(`${key} 计数不符：期望 ${manifest.database.counts[key]}，实际 ${digest.counts[key]}`);
      }
      if (digest.samples !== manifest.database.digest.samples) problems.push(`样品数不符：期望 ${manifest.database.digest.samples}，实际 ${digest.samples}`);
      if (digest.match_entries !== manifest.database.digest.match_entries) problems.push(`匹配项数不符：期望 ${manifest.database.digest.match_entries}，实际 ${digest.match_entries}`);
      const search = store.searchByElements(['Ni', 'Co'], { limit: 1 });
      if (!Array.isArray(search.results)) problems.push('固定查询失败：金属检索返回结构异常');
    } finally { store.close(); }
  }
  if (manifest.research?.included) {
    const researchPath = join(path, manifest.research.file);
    await assertInside(researchPath, '研究库');
    if (!await exists(researchPath)) problems.push('缺少研究产物库');
    else {
      if (await sha256(researchPath) !== manifest.research.sha256) problems.push('研究产物库摘要不符');
      try {
        const research = await ResearchStore.openFile(researchPath, true);
        try {
          const counts = research.counts();
          for (const key of ['artifacts', 'specimen_relations', 'observations', 'claims', 'hypotheses']) {
            if (counts[key] !== manifest.research.counts[key]) problems.push(`研究产物 ${key} 计数不符：期望 ${manifest.research.counts[key]}，实际 ${counts[key]}`);
          }
        } finally { research.close(); }
      } catch (error) { problems.push(`研究产物库无法读取：${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  let artifacts = null;
  await assertInside(join(path, 'artifacts.json'), '文件清单');
  if (Boolean(manifest.artifacts.included) !== await exists(join(path, 'artifacts.json'))) problems.push('备份 artifacts 清单缺失或与 manifest 不一致');
  if (await exists(join(path, 'artifacts.json'))) {
    artifacts = JSON.parse(await readFile(join(path, 'artifacts.json'), 'utf8'));
    if (JSON.stringify(artifacts.files) !== JSON.stringify(manifest.artifacts.files)) problems.push('artifacts 清单与 manifest 不一致');
    for (const file of artifacts.files ?? []) {
      if (!(safeParts(file.path) && /^(runs|batch)\//.test(file.path))) throw new Error('备份文件路径无效');
      await assertInside(join(path, file.path), '备份文件');
      const absolute = join(path, file.path);
      if (!await exists(absolute)) { problems.push(`任务产物缺失：${file.path}`); continue; }
      if (await sha256(absolute) !== file.sha256) problems.push(`任务产物摘要不符：${file.path}`);
    }
  }
  let sources = null;
  await assertInside(join(path, 'sources.json'), '文件清单');
  if (Boolean(manifest.sources.included) !== await exists(join(path, 'sources.json'))) problems.push('备份 sources 清单缺失或与 manifest 不一致');
  if (await exists(join(path, 'sources.json'))) {
    sources = JSON.parse(await readFile(join(path, 'sources.json'), 'utf8'));
    if (JSON.stringify(sources.files) !== JSON.stringify(manifest.sources.manifest)) problems.push('sources 清单与 manifest 不一致');
    for (const file of sources.files ?? []) {
      if (!(paperPath(file.source) && file.path === 'sources/' + file.source)) throw new Error('备份文件路径无效');
      await assertInside(join(path, file.path), '备份文件');
      const absolute = join(path, file.path);
      if (!await exists(absolute)) { problems.push(`原件缺失：${file.path}`); continue; }
      if (await sha256(absolute) !== file.sha256) problems.push(`原件摘要不符：${file.path}`);
    }
  }
  return { directory: path, ok: problems.length === 0, problems, manifest, artifacts, sources };
}

async function restoreBackup(directory, target, options) {
  const verification = await verifyBackup(directory);
  if (!verification.ok) throw new Error(`备份本身未通过校验，拒绝恢复：${verification.problems.join('；')}`);
  const destination = resolve(root, target);
  await assertInside(destination, '恢复目录');
  const databaseTarget = join(destination, 'data/distillation/spina.sqlite');
  if (await exists(databaseTarget) && !options.force) throw new Error(`恢复目录已有工作库，拒绝覆盖：${databaseTarget}；确认要覆盖请加 --force`);
  const targets = [databaseTarget,
    ...(verification.artifacts?.files ?? []).map(file => join(destination, 'data/distillation', file.path)),
    ...(verification.sources?.files ?? []).map(file => join(destination, file.source)),
    ...(verification.manifest.research?.included ? [join(destination, 'data/research/research.sqlite')] : [])];
  for (const path of targets) {
    await assertInside(path, '恢复目标');
    if (!options.force && await exists(path)) throw new Error(`恢复目标已存在，拒绝覆盖：${path}`);
  }
  await mkdir(dirname(databaseTarget), { recursive: true });
  await cp(join(verification.directory, verification.manifest.database.file), databaseTarget);
  if (verification.artifacts) {
    for (const file of verification.artifacts.files ?? []) {
      const source = join(verification.directory, file.path);
      const targetPath = join(destination, 'data/distillation', file.path);
      await mkdir(dirname(targetPath), { recursive: true });
      await cp(source, targetPath);
    }
  }
  if (verification.manifest.research?.included) {
    const target = join(destination, 'data/research', verification.manifest.research.file);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(verification.directory, verification.manifest.research.file), target);
  }
  if (verification.sources) {
    for (const file of verification.sources.files ?? []) {
      const source = join(verification.directory, file.path);
      const targetPath = join(destination, file.source);
      await mkdir(dirname(targetPath), { recursive: true });
      await cp(source, targetPath);
    }
  }
  const store = await ExperimentStore.openReadOnly(databaseTarget);
  let digest;
  try { digest = store.digest(); } finally { store.close(); }
  const problems = [];
  if (verification.manifest.research?.included) {
    const researchPath = join(destination, 'data/research', verification.manifest.research.file);
    try {
      const research = await ResearchStore.openFile(researchPath, true);
      try {
        const counts = research.counts();
        for (const key of ['artifacts', 'specimen_relations', 'observations', 'claims', 'hypotheses']) {
          if (counts[key] !== verification.manifest.research.counts[key]) problems.push(`恢复后的研究产物 ${key} 计数不一致`);
        }
      } finally { research.close(); }
    } catch { problems.push('恢复后的研究产物库无法读取'); }
  }
  if (digest.sha256 !== verification.manifest.database.digest.sha256) problems.push('恢复后的知识摘要与备份不一致');
  for (const key of ['papers', 'uncertain_papers', 'runs', 'review_actions']) {
    if (digest.counts[key] !== verification.manifest.database.counts[key]) problems.push(`${key} 计数不一致`);
  }
  return { destination, database: databaseTarget, digest, ok: problems.length === 0, problems };
}

function printBackup(result) {
  const { manifest } = result;
  console.log(`备份完成：${relative(root, result.output)}`);
  console.log(`类型：${manifest.kind === 'full' ? '完整工作包' : '轻量知识包'}；数据库 ${(manifest.database.bytes / 1048576).toFixed(2)} MB`);
  console.log(`论文：确认 ${manifest.database.counts.papers} / 待核对 ${manifest.database.counts.uncertain_papers}；任务 ${manifest.database.counts.runs}；审核记录 ${manifest.database.counts.review_actions}`);
  console.log(`样品 ${manifest.database.digest.samples} 个；匹配项 ${manifest.database.digest.match_entries} 条`);
  console.log(`数据库摘要：${manifest.database.sha256}`);
  if (manifest.artifacts.included) console.log(`任务产物：${manifest.artifacts.runs_files} 个文件，${(manifest.artifacts.bytes / 1048576).toFixed(2)} MB`);
  if (manifest.research?.included) console.log(`研究产物：${manifest.research.counts.artifacts} 个分析产物、${manifest.research.counts.claims} 条论断、${manifest.research.counts.observations} 条观察`);
  if (manifest.sources.included) console.log(`原件：${manifest.sources.files}/${manifest.sources.referenced} 个已复制`);
  console.log(`未包含：${manifest.excluded.join('、')}`);
  console.log(`\n校验：npm run backup -- --verify ${relative(root, result.output)}`);
}

function printVerify(result) {
  console.log(`${result.ok ? '校验通过' : '校验失败'}：${relative(root, result.directory)}`);
  const { manifest } = result;
  console.log(`生成时间：${manifest.created_at}；类型：${manifest.kind}；来源：${manifest.source.relative}`);
  console.log(`论文 确认 ${manifest.database.counts.papers} / 待核对 ${manifest.database.counts.uncertain_papers}；任务 ${manifest.database.counts.runs}；审核记录 ${manifest.database.counts.review_actions}`);
  if (manifest.research?.included) console.log(`研究产物：${manifest.research.counts.artifacts} 个分析产物、${manifest.research.counts.claims} 条论断`);
  for (const problem of result.problems) console.log(`  · ${problem}`);
  if (!result.ok) process.exitCode = 1;
}

async function drill(options) {
  const database = resolve(root, options.database ?? workDatabase);
  const output = options.output ? resolve(root, options.output) : resolve(backupsRoot, `drill-${stamp()}-${randomUUID().slice(0, 6)}`);
  const restoreTarget = resolve(root, `.runtime/restore-drill-${randomUUID().slice(0, 8)}`);
  console.log('恢复演练：备份 → 校验 → 恢复到独立目录 → 再校验');
  try {
    const backup = await createBackup({ ...options, database, output, full: true });
    console.log(`1/4 备份完成：${relative(root, backup.output)}`);
    const first = await verifyBackup(backup.output);
    if (!first.ok) throw new Error(`备份校验失败：${first.problems.join('；')}`);
    console.log('2/4 备份校验通过');
    const restored = await restoreBackup(backup.output, restoreTarget, {});
    if (!restored.ok) throw new Error(`恢复校验失败：${restored.problems.join('；')}`);
    console.log(`3/4 恢复到 ${relative(root, restoreTarget)}，摘要与计数一致`);
    const second = await verifyBackup(backup.output);
    if (!second.ok) throw new Error('重复校验失败');
    console.log('4/4 重复校验通过');
    console.log(`\n演练成功。备份保留在 ${relative(root, backup.output)}；恢复副本已清理。`);
    console.log('结论：当前数据可以生成一致快照，并能在独立空目录恢复后通过固定查询与计数核对。');
  } finally {
    await rm(restoreTarget, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseFlags(process.argv.slice(2), {
    booleans: ['json', 'help', 'full', 'includeSources', 'force', 'drill'],
  });
  if (values.help) { console.log(usage); return; }
  if (values.drill) { await drill(values); return; }
  if (values.verify) {
    const result = await verifyBackup(values.verify);
    if (values.json) printJson(result);
    else printVerify(result);
    return;
  }
  if (values.restore) {
    if (!values.to) throw new Error('--restore 需要同时指定 --to <目标目录>');
    const result = await restoreBackup(values.restore, values.to, { force: Boolean(values.force) });
    if (values.json) printJson(result);
    else {
      console.log(`${result.ok ? '恢复完成' : '恢复完成但校验未通过'}：${relative(root, result.destination)}`);
      console.log(`工作库：${relative(root, result.database)}`);
      console.log(`论文 确认 ${result.digest.counts.papers} / 待核对 ${result.digest.counts.uncertain_papers}；任务 ${result.digest.counts.runs}；审核记录 ${result.digest.counts.review_actions}`);
      for (const problem of result.problems) console.log(`  · ${problem}`);
      console.log('\n把该目录下的 data/distillation/spina.sqlite 放回项目即可继续使用；原件路径按记录中的相对路径解析。');
      if (!result.ok) process.exitCode = 1;
    }
    return;
  }
  const result = await createBackup({ ...values, full: Boolean(values.full), includeSources: Boolean(values.includeSources) });
  if (values.json) printJson(result);
  else printBackup(result);
}

try { await main(); }
catch (error) { console.error(`备份失败：${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
