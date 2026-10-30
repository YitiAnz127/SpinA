import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Check } from 'typebox/value';
import * as conditions from '../src/distillation/conditions.ts';

const project = fileURLToPath(new URL('../', import.meta.url)), base = resolve(project, '.runtime/tests');
let root;
before(async () => {
  await mkdir(base, { recursive: true }); root = await mkdtemp(resolve(base, 'conditions-'));
  await mkdir(resolve(root, 'data/distillation'), { recursive: true });
  await copyFile(resolve(project, 'data/demo/spina.sqlite'), resolve(root, 'data/distillation/spina.sqlite'));
});
after(async () => {
  const rel = relative(base, root); assert.ok(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\'));
  await rm(root, { recursive: true, force: true });
});

test('condition tool schema rejects standalone step terms and empty numeric bounds, and states the existing default', async () => {
  const schema = conditions.PreparationConditionQuerySchema;
  assert.ok(schema);
  assert.equal(Check(schema, { step_terms: ['anneal'] }), false);
  assert.equal(Check(schema, { temperature: {} }), false);
  assert.equal(Check(schema, { temperature: { max: 400 }, step_terms: ['anneal'] }), true);
  assert.equal(schema.properties.include_uncertain.default, true);
  await assert.rejects(conditions.searchPreparationConditions(root, { step_terms: ['anneal'] }), /step_terms.*同时使用/);
});

test('step terms actually restrict material-only searches in the real library', async () => {
  const query = { materials: [{ terms: ['urea'], mode: 'listed' }], step_terms: ['hydrothermal'], limit: 100 };
  const found = await conditions.searchPreparationConditions(root, query);
  assert.ok(found.total > 0); assert.ok(found.results.every(result => result.step_matches.length > 0));
  const db = new DatabaseSync(resolve(root, 'data/distillation/spina.sqlite'), { readOnly: true });
  try {
    for (const result of found.results) {
      const table = result.record_ref.version === 'verified' ? 'papers' : 'uncertain_papers';
      const record = JSON.parse(db.prepare(`SELECT record_json FROM ${table} WHERE paper_id=?`).get(result.paper.paper_id).record_json);
      for (const match of result.step_matches) {
        const sample = record.draft.samples.find(sample => sample.local_id === match.source_sample_id);
        const step = sample.steps.find(step => step.local_id === match.step_id);
        assert.match([step.local_id, step.operation.raw, step.description.raw].join(' '), /hydrothermal/i);
      }
    }
  } finally { db.close(); }
});

test('condition filtering retains the documented version default and strict false behavior', async () => {
  const query = { materials: [{ terms: ['urea'], mode: 'listed' }], limit: 100 };
  const normal = await conditions.searchPreparationConditions(root, query);
  const explicit = await conditions.searchPreparationConditions(root, { ...query, include_uncertain: true });
  assert.deepEqual(normal.results, explicit.results); assert.equal(normal.total, explicit.total);
  const confirmed = await conditions.searchPreparationConditions(root, { ...query, include_uncertain: false });
  assert.ok(confirmed.results.every(result => result.record_ref.version === 'verified' && !result.possible));
});
