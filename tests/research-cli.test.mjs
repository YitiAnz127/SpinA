import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { ResearchStore } from '../src/research/store.ts';
import { root, run, runJson } from './helpers/cli.mjs';

const demoDatabase = resolve(root, 'data/demo/spina.sqlite');
const hashDemo = async () => createHash('sha256').update(await readFile(demoDatabase)).digest('hex');

async function fixture(t) {
  const base = resolve(root, '.runtime/tests'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'research-cli-'));
  t.after(async () => {
    const rel = relative(base, directory);
    assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  });
  const researchDb = relative(root, join(directory, 'research.sqlite')).split('\\').join('/');
  const env = { ...process.env, SPINA_RESEARCH_DB: researchDb };
  return { directory, researchDb, env };
}

const identityArgs = ['identity', '--paper', 'SPINA-0020', '--sample', 'S_CoFe_ZrO2_series', '--database', 'data/demo/spina.sqlite', '--json'];

test('the research CLI plans, resolves identity and never writes the demo database', async t => {
  const { env, researchDb } = await fixture(t);
  const before = await hashDemo();
  const plan = await runJson('src/research.mjs', ['plan', '--type', 'series_analysis', '--question', '作者是否只改变了温度？', '--paper', 'SPINA-0093', '--json'], { env });
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.nodes.map(node => node.capability), ['resolve_material_identity', 'build_specimen_lineage', 'analyze_sample_series']);
  assert.ok(plan.required_facets.includes('observations'));
  assert.ok(plan.model_steps.some(step => step.step === 'load_facet:observations'));

  const identity = await runJson('src/research.mjs', identityArgs, { env });
  assert.equal(identity.identity.composition.status, 'variable');
  assert.deepEqual(identity.identity.composition.variables, ['x']);
  assert.deepEqual(identity.identity.composition.element_ranges.Co, { min: 0, max: 1 });
  assert.equal(identity.identity.structure.family, 'spinel');
  assert.equal(identity.identity.record_ref.version, 'uncertain');
  assert.match(identity.artifact.artifact_id, /^mat_/);

  const after = await hashDemo();
  assert.equal(after, before, '研究命令不得修改演示库');

  const store = await ResearchStore.openFile(resolve(root, researchDb), true);
  try {
    assert.ok(store.counts().artifacts >= 1);
    assert.ok(store.listArtifacts({ kind: 'material_identity' }).length >= 1);
  } finally { store.close(); }
});

test('material relations and specimen lineage are exposed with their layers', async t => {
  const { env } = await fixture(t);
  const relation = await runJson('src/research.mjs', ['relate', '--entity', 'SPINA-0020:S_CoFe_ZrO2_series', '--entity', 'SPINA-0093:S3', '--database', 'data/demo/spina.sqlite', '--json'], { env });
  assert.equal(relation.relation.layers.element_set, 'different');
  assert.equal(relation.relation.layers.structure, 'candidate_match');
  assert.ok(relation.relation.statements.length >= 2);

  const lineage = await runJson('src/research.mjs', ['lineage', '--paper', 'SPINA-0093', '--sample', 'S3', '--database', 'data/demo/spina.sqlite', '--json'], { env });
  assert.equal(lineage.graph.root, 'SPINA-0093::S3');
  assert.ok(lineage.graph.specimens.length >= 1);
  assert.ok(lineage.graph.unresolved.some(item => item.includes('未记录分装')));
});

test('series analysis reports confounders instead of a single-variable conclusion', async t => {
  const { env } = await fixture(t);
  const result = await runJson('src/research.mjs', ['series', '--paper', 'SPINA-0093', '--database', 'data/demo/spina.sqlite', '--json'], { env });
  assert.ok(result.contrast.contrasts.length >= 1);
  const confounded = result.contrast.contrasts.find(item => item.confounded);
  assert.ok(confounded, '演示库系列应至少有一个多变量对照');
  assert.equal(confounded.assessment.status, 'cannot_isolate_variable');
  assert.match(confounded.assessment.explanation, /不能把观察差异单独归因/);
});

test('ingest, disagreement, hypotheses and computation run as one workflow', async t => {
  const { directory, env } = await fixture(t);
  const input = join(directory, 'input.json');
  await writeFile(input, JSON.stringify({
    observations: [{ paper_id: 'SPINA-0093', sample_id: 'S3', metric: 'H2 rate', value: 120, unit: 'umol g-1 h-1', context: { light: '300 W Xe' } }],
    claims: [
      { claim_id: 'c1', paper_id: 'SPINA-0093', topic: 'origin', statement: '能带变化', kind: 'author_interpretation', stance: 'positive', subject_refs: [{ paper_id: 'SPINA-0093', sample_id: 'S3', material: 'MnFe2O4' }], scope: { measurement: '300 W Xe' }, support_refs: [{ kind: 'observation', paper_id: 'SPINA-0093', sample_id: 'S3' }], origin_family: 'paper:A' },
      { claim_id: 'c2', paper_id: 'SPINA-0094', topic: 'origin', statement: '比表面积变化', kind: 'author_interpretation', stance: 'negative', subject_refs: [{ paper_id: 'SPINA-0094', sample_id: 'S1', material: 'MnFe2O4' }], scope: { measurement: '300 W Xe' }, support_refs: [{ kind: 'observation', paper_id: 'SPINA-0094', sample_id: 'S1' }], origin_family: 'paper:B' },
    ],
  }));
  const ingested = await runJson('src/research.mjs', ['ingest', '--file', relative(root, input), '--database', 'data/demo/spina.sqlite', '--json'], { env });
  assert.equal(ingested.observations, 1);
  assert.equal(ingested.claims, 2);

  const disagreement = await runJson('src/research.mjs', ['disagreement', '--json'], { env });
  assert.equal(disagreement.graph.topics[0].pairs[0].classification, 'true_conflict');

  const hypothesesFile = join(directory, 'hypotheses.json');
  await writeFile(hypothesesFile, JSON.stringify({
    hypotheses: [
      { hypothesis_id: 'h1', statement: '表面积变化', explains: ['活性提高'], predicts: [{ observable: 'normalized activity', expected: 'no difference' }], falsifiers: [{ observation: 'normalized activity', outcome: 'still higher' }] },
      { hypothesis_id: 'h2', statement: '本征活性变化', explains: ['活性提高'], predicts: [{ observable: 'normalized activity', expected: 'higher' }], falsifiers: [{ observation: 'normalized activity', outcome: 'no difference' }] },
    ],
  }));
  const hypotheses = await runJson('src/research.mjs', ['hypotheses', '--file', relative(root, hypothesesFile), '--json'], { env });
  assert.equal(hypotheses.result.pairs[0].verdict, 'discriminating');

  const structurePath = join(directory, 'NiCo2O4.vasp');
  await writeFile(structurePath, `test\n1.0\n8 0 0\n0 8 0\n0 0 8\nNi Co O\n1 2 4\nDirect\n0 0 0\n0.5 0.5 0.5\n0.25 0.25 0.25\n0.5 0.5 0\n0 0.5 0.5\n0.5 0 0.5\n0.25 0.25 0.75\n`);
  const structure = await runJson('src/research.mjs', ['structure', '--file', relative(root, structurePath), '--formula', 'NiCo2O4', '--json'], { env });
  assert.equal(structure.structure.composition_match.status, 'exact');

  const intentFile = join(directory, 'intent.json');
  await writeFile(intentFile, JSON.stringify({
    question: '比较占位假设', observable: 'relative_total_energy',
    structures: [{ path: relative(root, structurePath), expected_formula: 'NiCo2O4' }],
    hypotheses: [{ hypothesis_id: 'h1', statement: '正尖晶石更稳定', predicts: [{ observable: 'relative_total_energy', expected: 'lower for normal' }] }],
  }));
  const computation = await runJson('src/research.mjs', ['computation', '--file', relative(root, intentFile), '--json'], { env });
  assert.ok(computation.spec.requires_decision.includes('hubbard_u'));
  assert.equal(computation.spec.candidates.length, 1);
});

test('ambiguous sample selection and missing databases fail with actionable messages', async t => {
  const { env } = await fixture(t);
  const ambiguous = await run('src/research.mjs', ['identity', '--paper', 'SPINA-0093', '--database', 'data/demo/spina.sqlite'], { env });
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.stderr, /需要 --sample/);
  const missing = await run('src/research.mjs', ['identity', '--paper', 'NOPE', '--sample', 'S1', '--database', 'data/demo/spina.sqlite'], { env });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /库中没有该论文/);
});

test('capabilities expose what each tool does not support', async t => {
  const { env } = await fixture(t);
  const capabilities = await runJson('src/research.mjs', ['capabilities', '--json'], { env });
  assert.ok(Object.keys(capabilities).length >= 9);
  for (const contract of Object.values(capabilities)) {
    assert.ok(contract.input_type && contract.output_type);
    assert.ok(contract.unsupported_cases.length >= 1);
    assert.ok(['parsed', 'derived_analysis', 'model_interpretation', 'model_hypothesis', 'simulation_result'].includes(contract.result_kind));
  }
});

test('invalid second observation rolls back the complete CLI import', async t => {
  const { env, directory, researchDb } = await fixture(t);
  const file = join(directory, 'invalid.json');
  const good = {paper_id:'SPINA-0020',sample_id:'S_CoFe_ZrO2_series',metric:'test',value:42};
  await writeFile(file, JSON.stringify({observations:[good,{...good,sample_id:'missing'}]}));
  assert.equal((await run('src/research.mjs',['ingest','--file',file,'--database',demoDatabase],{env})).code, 1);
  const store = await ResearchStore.openFile(resolve(root,researchDb), true);
  try { assert.equal(store.counts().observations, 0); } finally { store.close(); }
});

test('no-save identity leaves a new research workspace untouched', async t => {
  const { env, researchDb } = await fixture(t);
  const result = await runJson('src/research.mjs', [...identityArgs, '--no-save'], {env});
  assert.equal(result.artifact, null);
  await assert.rejects(stat(resolve(root, researchDb)), /ENOENT/);
});
