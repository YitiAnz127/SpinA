import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFormula, extractFormulaDomain, structureIdentity, relateMaterials, compositionKey } from '../src/research/materials.ts';

const identity = (formula, label = null, sample = 'S1', paper = 'P1') => {
  const composition = parseFormula(formula);
  return {
    identity_id: `id-${formula}-${sample}`, subject: { paper_id: paper, sample_id: sample },
    record_ref: { paper_id: paper, version: 'verified', revision: 1, verified_at: '2026-10-01T00:00:00.000Z' },
    label: formula, composition_role: 'target', composition,
    element_set: [...composition.elements].sort(), structure: structureIdentity(label, composition),
    material_state: 'as_prepared', evidence: [], unresolved: [], provenance: 'deterministic_analysis',
  };
};

test('fixed formulas keep an order-independent stoichiometry key', () => {
  const a = parseFormula('NiCo2O4'), b = parseFormula('Co2NiO4');
  assert.equal(a.status, 'fixed');
  assert.equal(a.composition_key, b.composition_key);
  assert.equal(a.composition_key, 'Co:2|Ni:1|O:4');
  assert.deepEqual(a.metals, ['Co', 'Ni']);
  assert.equal(compositionKey({ O: 4, Ni: 1, Co: 2 }), a.composition_key);
});

test('unicode subscripts and decimal coefficients are parsed', () => {
  assert.equal(parseFormula('NiCo₂O₄').composition_key, 'Co:2|Ni:1|O:4');
  const fractional = parseFormula('Ni0.5Co2.5O4');
  assert.equal(fractional.status, 'fixed');
  assert.equal(fractional.stoichiometry.Co, 2.5);
});

test('a variable formula keeps symbols and ranges instead of collapsing to one composition', () => {
  const withoutDomain = parseFormula('Co_xFe_{3−x}O4');
  assert.equal(withoutDomain.status, 'variable');
  assert.deepEqual(withoutDomain.variables, ['x']);
  assert.equal(withoutDomain.domain, null);
  assert.equal(withoutDomain.element_ranges, null);
  assert.equal(withoutDomain.composition_key, null);
  const withDomain = parseFormula('Co_xFe_{3−x}O4', { domain: { symbol: 'x', min: 0, max: 1, source: 'text_range' } });
  assert.deepEqual(withDomain.element_ranges, { Co: { min: 0, max: 1 }, Fe: { min: 2, max: 3 }, O: { min: 4, max: 4 } });
  assert.equal(withDomain.composition_key, null);
});

test('domains are read from sample text and only applied to matching symbols', () => {
  assert.deepEqual(extractFormulaDomain('Co_xFe_{3-x}O4 (x = 0.0–1.0)'), { symbol: 'x', min: 0, max: 1, source: 'text_range' });
  assert.equal(extractFormulaDomain('no range here'), null);
  const mismatch = parseFormula('Co_xFe_{3-x}O4', { domain: { symbol: 'y', min: 0, max: 1, source: 'text_range' } });
  assert.equal(mismatch.domain, null);
});

test('hydrates, charge notation and mixtures are handled explicitly', () => {
  const hydrate = parseFormula('CuSO4·5H2O');
  assert.equal(hydrate.status, 'fixed');
  assert.equal(hydrate.hydrate, true);
  assert.equal(hydrate.stoichiometry.H, 10);
  assert.equal(parseFormula('(Ni,Mn)Fe2O4').status, 'unparsed');
  assert.match(parseFormula('(Ni,Mn)Fe2O4').reason, /混合物|占位/);
  assert.equal(parseFormula('Fe3+').status, 'unparsed');
  const deficiency = parseFormula('CoFe2O4-δ');
  assert.equal(deficiency.status, 'variable');
  assert.deepEqual(deficiency.variables, ['δ']);
});

test('structure identity comes from the source label, not from stoichiometry', () => {
  const labeled = structureIdentity('inverse spinel', parseFormula('NiCo2O4'));
  assert.equal(labeled.confirmed, true);
  assert.equal(labeled.subtype, 'inverse');
  const guessed = structureIdentity(null, parseFormula('NiCo2O4'));
  assert.equal(guessed.confirmed, false);
  assert.equal(guessed.family, 'unknown');
  assert.equal(guessed.basis, 'stoichiometry_candidate');
  const unknown = structureIdentity(null, parseFormula('NaCl'));
  assert.equal(unknown.basis, 'none');
});

test('the same element set with a different stoichiometry is reported as different', () => {
  const relation = relateMaterials(identity('NiCo2O4', 'spinel', 'S1'), identity('Ni2CoO4', 'spinel', 'S2'));
  assert.equal(relation.layers.element_set, 'same');
  assert.equal(relation.layers.composition, 'different');
  assert.equal(relation.layers.structure, 'candidate_match');
  assert.match(relation.statements.join('；'), /元素集合相同不等于同一计量/);
});

test('variable compositions only match as a family and keep the unresolved domain', () => {
  const relation = relateMaterials(identity('Co_xFe_{3-x}O4', 'spinel', 'S1'), identity('CoFe2O4', 'spinel', 'S2'));
  assert.equal(relation.layers.element_set, 'same');
  assert.equal(relation.layers.composition, 'family');
  assert.match(relation.statements.join('；'), /变量组成/);
  assert.ok(relation.unresolved.some(item => item.includes('定义域')));
});

test('unparsed formulas cannot be silently treated as matching', () => {
  const relation = relateMaterials(identity('(Ni,Mn)Fe2O4', 'spinel', 'S1'), identity('NiFe2O4', 'spinel', 'S2'));
  assert.equal(relation.layers.composition, 'unresolved');
  assert.ok(relation.unresolved.some(item => item.includes('无法解析')));
});

test('the same paper and sample is reported as the same specimen', () => {
  const relation = relateMaterials(identity('NiFe2O4', 'spinel', 'S1', 'P1'), identity('NiFe2O4', 'spinel', 'S1', 'P1'));
  assert.equal(relation.layers.specimen, 'same');
  assert.equal(relation.layers.composition, 'same');
  assert.match(relation.statements.join('；'), /同一记录样品/);
});

test('qualified or negative phase labels cannot confirm a spinel', () => {
  for (const label of ['non-spinel', 'possibly spinel', 'spinel-like']) assert.equal(structureIdentity(label, null).confirmed, false);
});

test('formula units with the same proportions represent the same composition', () => {
  assert.equal(relateMaterials(identity('NiCo2O4'), identity('Ni2Co4O8')).layers.composition, 'same');
  assert.equal(structureIdentity(null, parseFormula('Ni9Co9O4')).basis, 'none');
});
