import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExperimentStore } from './distillation/store.ts';
import { searchPreparationConditionsWith } from './distillation/conditions.ts';
import { table, printJson, truncate, parseFlags } from './cli-format.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const demoDatabase = resolve(root, 'data/demo/spina.sqlite');
const workDatabase = resolve(root, 'data/distillation/spina.sqlite');

const SCENARIOS = ['browse', 'ask', 'distill', 'all'];
const usage = `SpinA 环境诊断

  npm run doctor                            检查"只读浏览"场景（默认）
  npm run doctor -- --scenario ask          浏览 + 自然语言问答
  npm run doctor -- --scenario distill      问答 + 新论文蒸馏
  npm run doctor -- --scenario all          全部检查
  npm run doctor -- --json                  机器可读输出
  npm run doctor -- --online                额外做一次真实联网检查（会发出网络请求）

退出码：0 表示该场景必需项全部通过；1 表示有必需项未通过。可选项缺失只提示，不改变退出码。`;

const exists = async path => { try { await access(path); return true; } catch { return false; } };

async function pythonVersion(python) {
  const result = await exec(python, ['-c', 'import sys; print(sys.executable); print("%d.%d" % sys.version_info[:2])'], { windowsHide: true, timeout: 15000 });
  const [executable, version] = result.stdout.trim().split(/\r?\n/);
  return { executable, version };
}

async function pdfDependencies(python) {
  const requirements = (await readFile(resolve(root, 'requirements-pdf.txt'), 'utf8')).split(/\r?\n/)
    .filter(line => line.trim() && !line.trim().startsWith('#')).map(line => {
      const match = /^([\w-]+)==([^\s#]+)\s*$/.exec(line.trim());
      return match ? { name: match[1], expected: match[2] } : null;
    }).filter(Boolean);
  const probe = await exec(python, ['-c',
    'import importlib.metadata,json,sys; print(json.dumps({n: importlib.metadata.version(n) for n in json.loads(sys.argv[1])}))',
    JSON.stringify(requirements.map(item => item.name))], { windowsHide: true, timeout: 30000 });
  const installed = JSON.parse(probe.stdout);
  return requirements.map(item => ({ ...item, installed: installed[item.name] ?? null, matches: installed[item.name] === item.expected }));
}

async function checkPdf() {
  const notes = [];
  let configured = {};
  try { configured = JSON.parse((await readFile(resolve(root, '.runtime/pdf-tools.json'), 'utf8')).replace(/^\uFEFF/, '')); } catch { configured = {}; }
  const candidates = [process.env.SPINA_PDF_PYTHON, configured.python, 'python', 'python3',
    resolve(root, process.platform === 'win32' ? '.runtime/pdf-python/Scripts/python.exe' : '.runtime/pdf-python/bin/python')].filter(Boolean);
  let python = null, version = null;
  for (const candidate of candidates) {
    try { const info = await pythonVersion(candidate); python = info.executable; version = info.version; break; } catch { /* try next */ }
  }
  let dependencies = [], complete = false;
  if (python) {
    try {
      dependencies = await pdfDependencies(python);
      complete = dependencies.every(item => item.matches);
      for (const item of dependencies.filter(item => !item.matches)) notes.push(`${item.name} 需要 ${item.expected}，当前 ${item.installed ?? '未安装'}`);
    } catch (error) { notes.push(`PDF 依赖探测失败：${String(error.message).split('\n')[0]}`); }
  } else notes.push('未找到 Python；将退回 PDF.js 纯文字层，没有表格与 OCR');

  let pdftoppm = null;
  for (const candidate of [process.env.SPINA_PDFTOPPM_PATH, 'pdftoppm'].filter(Boolean)) {
    try { await exec(candidate, ['-v'], { windowsHide: true, timeout: 10000 }); pdftoppm = candidate; break; } catch { /* try next */ }
  }
  if (!pdftoppm) notes.push('未找到 pdftoppm；普通文本页没有原页图，只有 OCR 页保留图像');

  const langPath = process.env.SPINA_OCR_LANG_PATH ?? resolve(root, '.runtime/tessdata');
  const languages = (process.env.SPINA_OCR_LANGUAGES ?? 'eng+chi_sim').split('+').filter(Boolean);
  const missingLanguages = [];
  for (const language of languages) if (!await exists(resolve(langPath, `${language}.traineddata`))) missingLanguages.push(language);
  if (missingLanguages.length) notes.push(`缺少 OCR 语言包：${missingLanguages.join('、')}（运行 npm run setup:pdf 下载）`);

  return {
    ok: Boolean(python) && complete, python, version,
    dependencies: dependencies.map(item => `${item.name}==${item.installed ?? '未安装'}${item.matches ? '' : `（要求 ${item.expected}）`}`),
    pdftoppm: Boolean(pdftoppm), ocr_languages: languages, missing_languages: missingLanguages,
    notes,
  };
}

async function checkModels(scenario) {
  const result = { deepseek: null, verifier: null, chat: null, notes: [] };
  try {
    const { deepSeekConfig } = await import('./distillation/deepseek.ts');
    const config = deepSeekConfig();
    result.deepseek = { configured: true, model: config.model, effort: config.effort, repair_effort: config.repairEffort };
  } catch (error) {
    result.deepseek = { configured: false };
    result.notes.push(error instanceof Error ? error.message : String(error));
  }
  if (scenario === 'browse') return result;
  try {
    const { ModelRuntime, ModelRegistry } = await import('@earendil-works/pi-coding-agent');
    const { SOL_POLICY, SOL_LABEL } = await import('./model-policy.ts');
    const registry = new ModelRegistry(await ModelRuntime.create({ modelsStorePath: resolve(root, '.runtime/model-store.json') }));
    const model = registry.find(SOL_POLICY.provider, SOL_POLICY.model);
    result.verifier = { model: SOL_LABEL, configured: Boolean(model && registry.hasConfiguredAuth(model)) };
    if (!result.verifier.configured) result.notes.push(`核验模型 ${SOL_LABEL} 未配置认证；请先在 SpinA 内完成 ChatGPT OAuth 登录`);
    const available = registry.getAvailable();
    result.chat = { available: available.length, examples: available.slice(0, 3).map(item => `${item.provider}/${item.id}`) };
    if (!available.length) result.notes.push('没有可用的对话模型；请运行 npm start 后 /login 或 /model');
    const registryError = registry.getError?.();
    if (registryError) result.notes.push(`模型清单读取警告：${registryError}`);
  } catch (error) {
    result.notes.push(`模型认证检查失败：${error instanceof Error ? error.message : String(error)}`);
  }
  return result;
}

async function checkDatabases() {
  const databases = [];
  for (const [label, path] of [['演示库', demoDatabase], ['工作库', workDatabase]]) {
    if (!await exists(path)) { databases.push({ label, path, exists: false }); continue; }
    try {
      const store = await ExperimentStore.openReadOnly(path);
      try { databases.push({ label, path, exists: true, readable: true, counts: store.counts() }); }
      finally { store.close(); }
    } catch (error) {
      databases.push({ label, path, exists: true, readable: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return databases;
}

async function checkQueries(databases) {
  const target = databases.find(database => database.readable && database.label === '演示库') ?? databases.find(database => database.readable);
  if (!target) return { ok: false, reason: '没有可读取的数据库，无法自检查询', database: null };
  const store = await ExperimentStore.openReadOnly(target.path);
  try {
    const search = store.searchByElements(['Ni', 'Co'], { limit: 1 });
    const conditions = searchPreparationConditionsWith(store, { temperature: { max: 400 }, limit: 1 });
    const shape = Array.isArray(search.results) && typeof search.total === 'number' &&
      typeof conditions.total === 'number' && Array.isArray(conditions.results);
    return {
      ok: shape, database: target.path,
      metal_search: { total: search.total, first: search.results[0]?.paper.paper_id ?? null },
      conditions: { total: conditions.total, field_matches: conditions.field_matches },
      ...(shape ? {} : { reason: '查询返回结构不符合预期' }),
    };
  } finally { store.close(); }
}

async function checkOnline() {
  const started = Date.now();
  try {
    const { deepSeekConfig } = await import('./distillation/deepseek.ts');
    let config;
    try { config = deepSeekConfig(); } catch { return { checked: false, reason: '未配置 DeepSeek 密钥，跳过联网检查' }; }
    const response = await fetch('https://api.deepseek.com/models', {
      headers: { Authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(15000),
    });
    return {
      checked: true, ok: response.ok, status: response.status, ms: Date.now() - started,
      ...(response.ok ? {} : { reason: response.status === 401 ? 'DeepSeek 密钥无效' : response.status === 402 ? 'DeepSeek 余额不足' : `HTTP ${response.status}` }),
    };
  } catch (error) {
    return { checked: true, ok: false, ms: Date.now() - started, reason: `联网失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

async function main() {
  const { values } = parseFlags(process.argv.slice(2), { booleans: ['json', 'help', 'online'] });
  if (values.help) { console.log(usage); return; }
  const scenario = values.scenario ?? 'browse';
  if (!SCENARIOS.includes(scenario)) throw new Error(`--scenario 必须为 ${SCENARIOS.join('、')}`);
  const needsModels = scenario !== 'browse';

  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const minimum = String(manifest.engines?.node ?? '>=22.19.0').replace(/^[>=^~\s]+/, '');
  const current = process.versions.node;
  const compare = (a, b) => {
    const left = a.split('.').map(Number), right = b.split('.').map(Number);
    for (let index = 0; index < 3; index++) if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) - (right[index] ?? 0);
    return 0;
  };
  const checks = [];
  const add = (name, ok, detail, options = {}) => checks.push({
    name, ok, detail, required: options.required ?? true, scenarios: options.scenarios ?? SCENARIOS,
    ...(options.notes?.length ? { notes: options.notes } : {}),
  });

  add('Node 版本', compare(current, minimum) >= 0, `当前 ${current}，要求 ≥ ${minimum}`, { required: true });
  add('项目文件', await exists(resolve(root, 'src/cli.mjs')) && await exists(resolve(root, 'src/spina.ts')),
    'src/cli.mjs、src/spina.ts 存在', { required: true });
  add('依赖安装', await exists(resolve(root, 'node_modules/@earendil-works/pi-coding-agent')),
    'node_modules 已安装', { required: true });

  const databases = await checkDatabases();
  const demo = databases.find(database => database.label === '演示库');
  add('演示库', Boolean(demo?.readable), demo?.readable
    ? `${demo.path}（确认 ${demo.counts.papers} / 待核对 ${demo.counts.uncertain_papers} / 任务 ${demo.counts.runs}）`
    : demo?.exists ? `无法读取：${demo.error}` : '未找到 data/demo/spina.sqlite', { required: true, scenarios: ['browse', 'ask', 'distill', 'all'] });
  const work = databases.find(database => database.label === '工作库');
  add('工作库', Boolean(work?.readable), work?.readable
    ? `${work.path}（确认 ${work.counts.papers} / 待核对 ${work.counts.uncertain_papers}）`
    : work?.exists ? `无法读取：${work.error}` : '尚未创建；首次蒸馏时自动创建，演示与只读检索不需要它', { required: false });

  let researchState = { exists: false };
  try {
    const { ResearchStore } = await import('./research/store.ts');
    const research = await ResearchStore.openExisting(root);
    if (research) {
      try { researchState = { exists: true, readable: true, counts: research.counts() }; }
      finally { research.close(); }
    }
  } catch (error) { researchState = { exists: true, readable: false, error: error instanceof Error ? error.message : String(error) }; }
  add('研究产物库', researchState.readable !== false, researchState.readable
    ? `data/research/research.sqlite（产物 ${researchState.counts.artifacts} / 观察 ${researchState.counts.observations} / 论断 ${researchState.counts.claims} / 假设 ${researchState.counts.hypotheses}）`
    : researchState.exists ? `无法读取：${researchState.error}` : '尚未创建；首次研究分析时自动创建，不影响制备检索', { required: false });

  const queries = await checkQueries(databases);
  add('查询自检', queries.ok, queries.ok
    ? `金属检索 ${queries.metal_search.total} 条（首条 ${queries.metal_search.first ?? '无'}）；条件筛选 ${queries.conditions.total} 条`
    : queries.reason, { required: true });

  const pdf = await checkPdf();
  add('PDF / OCR', pdf.ok, pdf.ok
    ? `Python ${pdf.version}；${pdf.dependencies.join('，')}${pdf.pdftoppm ? '；pdftoppm 可用' : '；无 pdftoppm'}`
    : pdf.python ? `Python ${pdf.version}，但提取依赖不完整` : '未找到 Python', { required: false, notes: pdf.notes });

  const models = await checkModels(scenario);
  if (needsModels) {
    add('对话模型认证', Boolean(models.chat?.available), models.chat?.available
      ? `可用 ${models.chat.available} 个（如 ${models.chat.examples.join('、')}）`
      : '没有可用对话模型', { required: true, scenarios: ['ask', 'distill', 'all'] });
    add('核验模型认证', Boolean(models.verifier?.configured), models.verifier?.configured
      ? models.verifier.model : `${models.verifier?.model ?? 'openai-codex/gpt-6.1-sol'} 未配置`, { required: true, scenarios: ['ask', 'distill', 'all'] });
    add('蒸馏密钥', Boolean(models.deepseek?.configured), models.deepseek?.configured
      ? `${models.deepseek.model} / 蒸馏 ${models.deepseek.effort} / 修正 ${models.deepseek.repair_effort}`
      : '未配置 DeepSeek API Key', { required: true, scenarios: ['distill', 'all'] });
  }

  let online = null;
  if (values.online) {
    online = await checkOnline();
    add('联网检查', online.checked ? Boolean(online.ok) : true,
      online.checked ? (online.ok ? `DeepSeek 可达（${online.ms} ms）` : online.reason) : online.reason, { required: false });
  }

  const relevant = checks.filter(check => scenario === 'all' || check.scenarios.includes(scenario));
  const failed = relevant.filter(check => check.required && !check.ok);
  const warnings = relevant.filter(check => !check.required && !check.ok);
  const report = {
    generated_at: new Date().toISOString(), scenario, node: current, root,
    ok: failed.length === 0, failed: failed.map(check => check.name), warnings: warnings.map(check => check.name),
    checks: relevant, databases, research: researchState, pdf, models, ...(online ? { online } : {}),
  };

  if (values.json) { printJson(report); process.exitCode = failed.length ? 1 : 0; return; }

  console.log(`SpinA 环境诊断 · 场景：${scenario}`);
  console.log(table(['检查项', '结果', '必需', '说明'], relevant.map(check => [
    check.name, check.ok ? '通过' : check.required ? '失败' : '提示', check.required ? '是' : '否', truncate(check.detail, 78),
  ])));
  for (const check of relevant) for (const note of check.notes ?? []) console.log(`  · ${check.name}：${note}`);
  if (failed.length) {
    console.log(`\n${failed.length} 项必需检查未通过：${failed.map(check => check.name).join('、')}`);
    if (scenario === 'browse') console.log('只读浏览只依赖 Node、依赖安装和可读数据库；修好上面几项即可离线检索。');
    else console.log('未配置模型认证时仍可用 npm run demo 离线浏览演示库。');
  } else {
    console.log(`\n该场景必需项全部通过。${warnings.length ? `另有 ${warnings.length} 项提示（可选项缺失，不影响使用）。` : ''}`);
  }
  if (!values.online) console.log('联网检查未执行；需要时加 --online。');
  process.exitCode = failed.length ? 1 : 0;
}

try { await main(); }
catch (error) { console.error(`诊断失败：${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
