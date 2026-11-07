import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { parseFormula } from '../src/research/materials.ts';
import { compareComposition, parseCif, parsePoscar, prepareComputationSpec, resolveStructureCandidate, STANDARD_DECISIONS } from '../src/research/computation.ts';

const POSCAR = `NiCo2O4 test
1.0
8.0 0.0 0.0
0.0 8.0 0.0
0.0 0.0 8.0
Ni Co O
1 2 4
Direct
0.0 0.0 0.0
0.5 0.5 0.5
0.25 0.25 0.25
0.5 0.5 0.0
0.0 0.5 0.5
0.5 0.0 0.5
0.25 0.25 0.75
`;

const CIF = `data_NiCo2O4
_cell_length_a 8.0
_cell_length_b 8.0
_cell_length_c 8.0
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
_symmetry_space_group_name_H-M 'F d -3 m'
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
_atom_site_occupancy
Ni1 Ni 0.0 0.0 0.0 1
Co1 Co 0.5 0.5 0.5 1
Co2 Co 0.25 0.25 0.25 1
O1 O 0.25 0.25 0.75 1
O2 O 0.75 0.25 0.25 1
O3 O 0.25 0.75 0.25 1
O4 O 0.75 0.75 0.75 1
`;

async function fixture(t) {
  const base = resolve('.runtime/tests'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'research-structure-'));
  t.after(async () => {
    const rel = relative(base, directory);
    assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('POSCAR parsing reads lattice, species and sites', () => {
  const parsed = parsePoscar(POSCAR);
  assert.equal(parsed.sites.length, 7);
  assert.deepEqual(parsed.composition, { Co: 2, Ni: 1, O: 4 });
  assert.equal(parsed.lattice.a, 8);
  assert.equal(parsed.lattice.gamma, 90);
});

test('CIF parsing reads cell, space group and atom sites', () => {
  const parsed = parseCif(CIF);
  assert.equal(parsed.sites.length, 7);
  assert.deepEqual(parsed.composition, { Co: 2, Ni: 1, O: 4 });
  assert.equal(parsed.space_group, 'F d -3 m');
});

test('composition comparison distinguishes exact, supercell and mismatch', () => {
  const expected = parseFormula('NiCo2O4');
  assert.equal(compareComposition({ Co: 2, Ni: 1, O: 4 }, expected).status, 'exact');
  const multiple = compareComposition({ Co: 4, Ni: 2, O: 8 }, expected);
  assert.equal(multiple.status, 'multiple');
  assert.equal(multiple.factor, 2);
  assert.equal(compareComposition({ Co: 1, Ni: 2, O: 4 }, expected).status, 'mismatch');
  assert.equal(compareComposition({ Co: 2, Ni: 1, O: 4 }, parseFormula('Co_xFe_{3-x}O4')).status, 'unresolved');
});

test('a structure file is parsed with explicit warnings and no physical claims', async t => {
  const directory = await fixture(t);
  const path = join(directory, 'NiCo2O4.vasp');
  await writeFile(path, POSCAR);
  const structure = await resolveStructureCandidate(resolve('.'), { path, expected_formula: 'NiCo2O4' });
  assert.equal(structure.format, 'poscar');
  assert.equal(structure.composition_match.status, 'exact');
  assert.match(structure.warnings.join('；'), /不代表结构物理合理/);
  assert.ok(!structure.unresolved.some(item => item.includes('未提供期望化学式')));
});

test('a structure outside the project is refused', async () => {
  await assert.rejects(resolveStructureCandidate(resolve('.'), { path: '../outside.cif' }), /项目内/);
});

test('a computation spec lists undecided parameters and never fixes them silently', async t => {
  const directory = await fixture(t);
  const path = join(directory, 'NiCo2O4.vasp');
  await writeFile(path, POSCAR);
  const spec = await prepareComputationSpec(resolve('.'), {
    question: '比较两种占位假设', observable: 'relative_total_energy',
    structures: [{ path, expected_formula: 'NiCo2O4' }],
    hypotheses: [
      { hypothesis_id: 'h1', statement: '正尖晶石更稳定', predicts: [{ observable: 'relative_total_energy', expected: 'lower for normal' }] },
      { hypothesis_id: 'h2', statement: '反尖晶石更稳定' },
    ],
    fixed_parameters: { exchange_correlation_functional: 'PBE' },
  });
  assert.ok(!spec.requires_decision.includes('exchange_correlation_functional'));
  for (const key of STANDARD_DECISIONS.filter(item => item !== 'exchange_correlation_functional')) {
    assert.ok(spec.requires_decision.includes(key), `缺少待决定项 ${key}`);
  }
  assert.equal(spec.expected_outputs[0].discriminating_if, 'lower for normal');
  assert.equal(spec.expected_outputs[1].discriminating_if, null);
  assert.ok(spec.unresolved.some(item => item.includes('没有给出')));
  assert.match(spec.warnings.join('；'), /不是计算完成/);
});

test('without a structure the spec is a requirements list, not fabricated input', async () => {
  const spec = await prepareComputationSpec(resolve('.'), { question: '比较占位', observable: 'energy' });
  assert.equal(spec.candidates.length, 0);
  assert.ok(spec.structure_requirements.length >= 3);
  assert.ok(spec.unresolved.some(item => item.includes('缺少候选结构')));
  assert.match(spec.warnings.join('；'), /不会被默认固定/);
});

test('a missing structure file is reported instead of ignored', async () => {
  const spec = await prepareComputationSpec(resolve('.'), {
    question: '比较占位', observable: 'energy',
    structures: [{ path: '.runtime/tests/does-not-exist.cif' }],
  });
  assert.equal(spec.candidates.length, 0);
  assert.ok(spec.unresolved.some(item => item.includes('无法读取结构文件')));
});

test('Cartesian axes, sites and leading decimals use the same POSCAR scale', () => {
  const result = parsePoscar('example\n2 3 4\n1 1 0\n0 1 0\n0 0 1\nFe\n1\nCartesian\n.25 .5 .75');
  assert.deepEqual(result.lattice.vectors[0], [2, 3, 0]);
  assert.deepEqual([result.sites[0].x, result.sites[0].y, result.sites[0].z], [.5, 1.5, 3]);
});
test('CIF site uncertainty and symmetry multiplicity are explicit', () => {
  const data = CIF.replace('Ni1 Ni 0.0', 'Ni1 Ni 0.12(2)');
  assert.equal(parseCif(data).sites[0].x, .12);
  assert.equal(parseCif(data).multiplicities_known, false);
  assert.throws(() => parseCif(CIF.replace('Ni1 Ni 0.0', 'Ni1 Ni ?')), /坐标/);
});
