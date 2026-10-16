import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSources } from '../src/distillation/documents.ts';
import { ExperimentStore } from '../src/distillation/store.ts';
import spina from '../src/spina.ts';

const base = fileURLToPath(new URL('../.runtime/tests/', import.meta.url));
async function workspace() {
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'sources-'));
  await mkdir(join(root, 'data/paper'), { recursive: true });
  return root;
}
async function cleanup(root) {
  assert.ok(resolve(root).startsWith(resolve(base) + sep));
  await rm(root, { recursive: true, force: true });
}
// A synthetic, single-page PDF: no downloaded scientific data is used as a test oracle.
function pdf(text) {
  const stream = `BT /F1 12 Tf 50 700 Td (${text.replace(/[\\()]/g, '\\$&')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let output = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

test('reads source pages and distinguishes SI from the body', async () => {
  const root = await workspace();
  try {
    await writeFile(join(root, 'data/paper/body.pdf'), pdf('Sample A is pure NiFe2O4 spinel. This is synthetic source text.'));
    await writeFile(join(root, 'data/paper/si.pdf'), pdf('Supporting Information for the synthetic sample A.'));
    const sources = await readSources(root, [{ path: 'data/paper/body.pdf' }, { path: 'data/paper/si.pdf' }]);
    assert.deepEqual(sources.map(source => source.kind), ['body', 'si']);
    assert.equal(sources[0].pages[0].number, 1);
    assert.match(sources[0].pages[0].text, /NiFe2O4/);
    await assert.rejects(readSources(root, [{ path: 'data/paper/si.pdf' }]), /只有 SI/);
    await assert.rejects(readSources(root, [{ path: 'data/paper/si.pdf', kind: 'body' }]), /不能指定为正文/);
  } finally { await cleanup(root); }
});

test('rejects documents outside the paper directory', async () => {
  const root = await workspace();
  try {
    await writeFile(join(root, 'private.pdf'), pdf('A PDF outside the authorized paper directory.'));
    await assert.rejects(readSources(root, [{ path: 'private.pdf' }]), /只能读取/);
  } finally { await cleanup(root); }
});

test('reading an absent database does not create one', async () => {
  const root = await workspace();
  try { assert.equal(await ExperimentStore.openExisting(root), null); }
  finally { await cleanup(root); }
});

test('repeating a resumed run returns its saved result without starting another model call', async () => {
  const root = await workspace();
  try {
    const store = await ExperimentStore.open(root);
    const prior = store.createRun('TEST-RESUME'); prior.status = 'failed'; store.saveRun(prior);
    const resumed = store.createRun('TEST-RESUME'); resumed.status = 'published_uncertain'; store.saveRun(resumed);
    await store.saveArtifact(prior, 'resumed_run.json', { run_id: resumed.run_id }); store.close();
    const tools = new Map();
    spina({ registerTool: tool => tools.set(tool.name, tool), registerCommand: () => {}, on: () => {} });
    // No model registry or credentials: a repeated resume must not need either.
    const result = await tools.get('resume_distillation_run').execute('resume', { run_id: prior.run_id }, undefined, undefined, { cwd: root });
    assert.equal(result.details.run_id, resumed.run_id);
    assert.equal(result.details.status, 'published_uncertain');
  } finally { await cleanup(root); }
});

test('registers native tools and validates slash-command input before starting a turn', async () => {
  const tools = new Map(); const commands = new Map(); const sent = [];
  spina({ registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command), on: () => {}, sendUserMessage: async message => sent.push(message) });
  assert.ok(tools.has('distill_paper') && tools.has('inspect_paper_sources') && tools.has('get_distillation_result') && tools.has('search_spinel_experiments'));
  const messages = [];
  const ctx = { ui: { notify: message => messages.push(message) } };
  await commands.get('distill').handler('{"paper_id":"../../bad"}', ctx);
  assert.equal(sent.length, 0);
  await commands.get('distill').handler('SPINA-0100', ctx);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /SPINA-0100/);
});

test('native tool distills through DeepSeek and independently verifies through Pi', async t => {
  const keys = ['DEEPSEEK_API_KEY', 'SPINA_DISTILL_MODEL', 'SPINA_DISTILL_EFFORT'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.DEEPSEEK_API_KEY = 'fixture-key';
  process.env.SPINA_DISTILL_MODEL = 'deepseek-flash';
  process.env.SPINA_DISTILL_EFFORT = 'high';
  t.after(() => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  const root = await workspace();
  try {
    const quote = 'Sample A is pure NiFe2O4 spinel.';
    await writeFile(join(root, 'data/paper/body.pdf'), pdf(quote));
    const evidence = { source_id: 'src_1', page: 1, quote };
    const fact = value => ({ raw: value, value, unit: null, status: value === null ? 'not_reported' : 'reported', evidence: value === null ? [] : [evidence], note: '' });
    const draft = { assessment: 'original_experiments', notes: [], samples: [{ local_id: 'a', name: 'A', aliases: [], material_state: 'as_prepared', variables: [], nominal_composition: fact('NiFe2O4'), measured_composition: fact(null), phases: [{ local_id: 'p', role: 'target_spinel', formula: fact('NiFe2O4'), identity: fact('spinel'), purity: fact('pure') }], method: fact(null), materials: [], steps: [], shared_from: null, unresolved_questions: [] }] };
    const verification = { source_identity: 'confirmed', coverage: 'complete', issues: [], notes: [], samples: [{ sample_local_id: 'a', has_confirmed_errors: false, has_unresolved_issues: false, can_match: true, expandable_fields: ['phases'], missing_or_uncertain: ['method'] }] };
    const tools = new Map(); const contexts = [];
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(url, 'https://api.deepseek.com/chat/completions');
      const body = JSON.parse(options.body); requests.push(body);
      assert.equal(body.model, 'deepseek-flash'); assert.equal(body.reasoning_effort, 'high');
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(draft) } }] });
    });
    spina({ registerTool: tool => tools.set(tool.name, tool), registerCommand: () => {}, on: () => {}, getThinkingLevel: () => 'off' });
    const solModel = { provider: 'openai-codex', id: 'gpt-6.1-sol', maxTokens: 8000, contextWindow: 128000 };
    const ctx = {
      cwd: root, hasUI: false, thinkingLevel: 'off',
      model: { provider: 'deepseek', id: 'deepseek-flash' },
      modelRegistry: { find: (provider, model) => { assert.equal(provider,'openai-codex'); assert.equal(model,'gpt-6.1-sol'); return solModel; }, hasConfiguredAuth: model => model === solModel, streamSimple: (_model, context, options) => {
        assert.equal(_model,solModel);
        contexts.push(context);
        assert.equal(options.reasoning, 'low');
        const input = JSON.parse(context.messages[0].content);
        assert.equal(options.maxTokens, 8000);
        assert.ok('draft' in input && 'reader_view' in input);
        return { result: async () => ({ stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(verification) }] }) };
      } },
    };
    const result = await tools.get('distill_paper').execute('fixture-call', { paper_id: 'FIXTURE-001', doi: '10.1234/fixture', title: 'Synthetic tool integration fixture', sources: [{ path: 'data/paper/body.pdf' }] }, new AbortController().signal, undefined, ctx);
    assert.equal(result.details.status, 'published');
    assert.equal(requests.length, 1); assert.equal(contexts.length, 1);
    assert.ok(contexts.every(context => context.messages.length === 1));
    assert.deepEqual(Object.keys(JSON.parse(requests[0].messages[1].content)).sort(), ['paper', 'sources']);
    const store = await ExperimentStore.open(root);
    assert.equal(store.getPaper('FIXTURE-001').distilled_by, 'deepseek/deepseek-flash:high');
    assert.equal(store.getPaper('FIXTURE-001').verified_by, 'openai-codex/gpt-6.1-sol:low');
    store.close();
    const stored = await tools.get('get_distillation_result').execute('read', { paper_id: 'FIXTURE-001' }, undefined, undefined, ctx);
    assert.deepEqual(stored.details.samples[0].phases[0].metals, ['Fe', 'Ni']);
    assert.equal(stored.details.verification, undefined);
    const found=await tools.get('search_spinel_experiments').execute('search',{metal_elements:['Ni','Fe']},undefined,undefined,ctx);
    assert.equal(found.details[0].certainty,'verified');assert.equal(found.details[0].possible,false);
  } finally { await cleanup(root); }
});
