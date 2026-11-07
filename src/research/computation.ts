import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { parseFormula, type FormulaParse } from './materials.ts';
import { newId, nowIso } from './contracts.ts';

/**
 * F6: structure parsing and computation-task preparation.
 *
 * This module reads structures and checks inputs. It does not run DFT, does not judge whether
 * a structure is physically sensible, and never fills an unspecified parameter with a default.
 */

export interface Lattice {
  a: number; b: number; c: number; alpha: number; beta: number; gamma: number;
  vectors: number[][];
}
export interface StructureSite { element: string; x: number; y: number; z: number; occupancy: number; fractional: boolean }

export interface StructureArtifact {
  structure_id: string;
  path: string;
  format: 'poscar' | 'cif';
  source: string;
  lattice: Lattice | null;
  sites: StructureSite[];
  composition: Record<string, number>;
  expected_formula: string | null;
  composition_match: { status: 'exact' | 'multiple' | 'mismatch' | 'unresolved'; factor: number | null; detail: string } | null;
  space_group: string | null;
  warnings: string[];
  unresolved: string[];
  provenance: 'deterministic_analysis';
}

const numbers = (line: string) => {
  const tokens = line.trim().split(/\s+/);
  const values: number[] = [];
  for (const token of tokens) {
    if (/^[TF]$/i.test(token) || token.startsWith('!') || token.startsWith('#')) break;
    const value = Number(token);
    if (!token || !Number.isFinite(value)) throw new Error('POSCAR 中含无效数字');
    values.push(value);
  }
  return values;
};
const round = (value: number) => Number(value.toFixed(6));

function latticeFromCell(a: number, b: number, c: number, alpha: number, beta: number, gamma: number): Lattice {
  const rad = (value: number) => value * Math.PI / 180;
  const ca = Math.cos(rad(alpha)), cb = Math.cos(rad(beta)), cg = Math.cos(rad(gamma)), sg = Math.sin(rad(gamma));
  const volumeFactor = Math.sqrt(Math.max(0, 1 - ca * ca - cb * cb - cg * cg + 2 * ca * cb * cg));
  return {
    a, b, c, alpha, beta, gamma,
    vectors: [
      [a, 0, 0],
      [b * cg, b * sg, 0],
      [c * cb, c * (ca - cb * cg) / sg, c * volumeFactor / sg],
    ],
  };
}

const cellFromVectors = (vectors: number[][]): Lattice => {
  const [a1, a2, a3] = vectors;
  const norm = (vector: number[]) => Math.hypot(...vector);
  const dot = (left: number[], right: number[]) => left.reduce((sum, value, index) => sum + value * right[index], 0);
  const angle = (left: number[], right: number[]) => Math.acos(Math.max(-1, Math.min(1, dot(left, right) / (norm(left) * norm(right))))) * 180 / Math.PI;
  return {
    a: round(norm(a1)), b: round(norm(a2)), c: round(norm(a3)),
    alpha: round(angle(a2, a3)), beta: round(angle(a1, a3)), gamma: round(angle(a1, a2)),
    vectors,
  };
};

export function parsePoscar(text: string): { lattice: Lattice; sites: StructureSite[]; composition: Record<string, number> } {
  const lines = text.split(/\r?\n/).filter(line => line.trim().length);
  if (lines.length < 8) throw new Error('POSCAR 行数不足');
  const scaleLine = numbers(lines[1]);
  if (![1, 3].includes(scaleLine.length) || scaleLine.includes(0) || (scaleLine.length === 3 && scaleLine.some(value => value <= 0))) throw new Error('POSCAR 缺少缩放系数');
  const rawVectors = [2, 3, 4].map(index => numbers(lines[index]));
  if (rawVectors.some(vector => vector.length < 3)) throw new Error('POSCAR 晶格向量不完整');
  let scale = scaleLine[0];
  if (scaleLine.length === 3) {
    rawVectors.forEach(vector => { for (let axis = 0; axis < 3; axis++) vector[axis] *= scaleLine[axis]; });
    scale = 1;
  } else if (scale < 0) {
    const [a1, a2, a3] = rawVectors;
    const determinant = Math.abs(
      a1[0] * (a2[1] * a3[2] - a2[2] * a3[1]) -
      a1[1] * (a2[0] * a3[2] - a2[2] * a3[0]) +
      a1[2] * (a2[0] * a3[1] - a2[1] * a3[0]),
    );
    if (!determinant) throw new Error('POSCAR 晶格体积为零');
    scale = Math.cbrt(Math.abs(scale) / determinant);
  }
  const vectors = rawVectors.map(vector => vector.slice(0, 3).map(value => value * scale));
  const symbolsLine = lines[5].trim();
  let symbols: string[];
  let counts: number[];
  let cursor: number;
  if (/[A-Za-z]/.test(symbolsLine)) {
    symbols = symbolsLine.split(/\s+/);
    counts = numbers(lines[6]);
    cursor = 7;
  } else {
    counts = numbers(symbolsLine);
    symbols = counts.map((_, index) => `X${index + 1}`);
    cursor = 6;
  }
  if (!counts.length || counts.some(count => !Number.isSafeInteger(count) || count < 0) || !counts.some(Boolean)) throw new Error('POSCAR 原子计数无效');
  if (counts.length !== symbols.length) throw new Error('POSCAR 元素数与计数数不一致');
  if (lines[cursor]?.trim().toLowerCase().startsWith('s')) cursor++;
  const mode = lines[cursor]?.trim().toLowerCase() ?? '';
  if (!mode.startsWith('d') && !mode.startsWith('c') && !mode.startsWith('k')) throw new Error('POSCAR 缺少 Direct/Cartesian 标记');
  const fractional = mode.startsWith('d');
  cursor++;
  const total = counts.reduce((sum, value) => sum + value, 0);
  const sites: StructureSite[] = [];
  for (let index = 0; index < total; index++) {
    const values = numbers(lines[cursor + index] ?? '');
    if (values.length < 3) throw new Error(`POSCAR 第 ${cursor + index + 1} 行坐标不完整`);
    let elementIndex = 0, accumulated = 0;
    while (elementIndex < counts.length - 1 && index >= accumulated + counts[elementIndex]) { accumulated += counts[elementIndex]; elementIndex++; }
    if (!fractional) for (let axis = 0; axis < 3; axis++) values[axis] *= scaleLine.length === 3 ? scaleLine[axis] : scale;
    sites.push({ element: symbols[elementIndex], x: values[0], y: values[1], z: values[2], occupancy: 1, fractional });
  }
  return { lattice: cellFromVectors(vectors), sites, composition: compositionOf(sites) };
}

function compositionOf(sites: StructureSite[]): Record<string, number> {
  const composition: Record<string, number> = {};
  for (const site of sites) composition[site.element] = round((composition[site.element] ?? 0) + site.occupancy);
  return Object.fromEntries(Object.entries(composition).sort(([a], [b]) => a.localeCompare(b)));
}

const unquote = (value: string) => value.replace(/^['"]|['"]$/g, '').replace(/\(\d+\)$/, '');

export function parseCif(text: string): { lattice: Lattice; sites: StructureSite[]; composition: Record<string, number>; space_group: string | null; multiplicities_known: boolean } {
  const lines = text.split(/\r?\n/).map(line => line.replace(/#.*$/, '').trim()).filter(Boolean);
  const values: Record<string, string> = {};
  for (const line of lines) {
    const match = /^(_[A-Za-z0-9_.\-]+)\s+(.+)$/.exec(line);
    if (match) values[match[1].toLowerCase()] = unquote(match[2].trim());
  }
  const cellKeys = ['_cell_length_a', '_cell_length_b', '_cell_length_c', '_cell_angle_alpha', '_cell_angle_beta', '_cell_angle_gamma'];
  const cell = cellKeys.map(key => Number(values[key]));
  if (cell.some(value => !Number.isFinite(value) || value <= 0)) throw new Error('CIF 缺少有效的晶胞参数');
  const sites: StructureSite[] = [];
  const composition: Record<string, number> = {};
  let hasMultiplicity = false;
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].toLowerCase() !== 'loop_') continue;
    const tags: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length && lines[cursor].startsWith('_')) { tags.push(lines[cursor].toLowerCase().split(/\s+/)[0]); cursor++; }
    if (!tags.includes('_atom_site_fract_x')) continue;
    const column = (name: string) => tags.indexOf(name);
    const xIndex = column('_atom_site_fract_x'), yIndex = column('_atom_site_fract_y'), zIndex = column('_atom_site_fract_z');
    const symbolIndex = column('_atom_site_type_symbol');
    const labelIndex = column('_atom_site_label');
    const occupancyIndex = column('_atom_site_occupancy');
    const mult = column('_atom_site_symmetry_multiplicity');
    hasMultiplicity = mult >= 0;
    while (cursor < lines.length && !lines[cursor].startsWith('_') && !lines[cursor].startsWith('loop_') && !lines[cursor].startsWith('data_')) {
      const parts = lines[cursor].split(/\s+/);
      const rawSymbol = symbolIndex >= 0 ? parts[symbolIndex] : (parts[labelIndex] ?? '');
      const element = /^([A-Z][a-z]?)/.exec(rawSymbol)?.[1];
      if (!element || [xIndex, yIndex, zIndex].includes(-1)) throw new Error('CIF 位点缺少元素或坐标列');
      const coords = [xIndex, yIndex, zIndex].map(i => Number(unquote(parts[i] ?? '?')));
      const occ = occupancyIndex < 0 ? 1 : Number(unquote(parts[occupancyIndex] ?? '?'));
      if (!coords.every(Number.isFinite) || !Number.isFinite(occ) || occ < 0 || occ > 1) throw new Error('CIF 坐标或占位率无效');
      const multiplicity = mult < 0 ? 1 : Number(parts[mult]);
      if (!Number.isSafeInteger(multiplicity) || multiplicity < 1) throw new Error('CIF 位点多重性无效');
      composition[element] = round((composition[element] ?? 0) + occ * multiplicity);
      sites.push({ element, x: coords[0], y: coords[1], z: coords[2], occupancy: occ, fractional: true });
      cursor++;
    }
    break;
  }
  if (!sites.length) throw new Error('CIF 未找到原子位点（_atom_site_fract_x 循环）');
  return {
    lattice: latticeFromCell(cell[0], cell[1], cell[2], cell[3], cell[4], cell[5]),
    sites, composition, multiplicities_known: hasMultiplicity || /^p\s*1$/i.test(values['_symmetry_space_group_name_h-m'] ?? values['_space_group_name_h-m_alt'] ?? ''),
    space_group: values['_symmetry_space_group_name_h-m'] ?? values['_space_group_name_h-m_alt'] ?? null,
  };
}

export function compareComposition(actual: Record<string, number>, expected: FormulaParse | null): StructureArtifact['composition_match'] {
  if (!expected) return null;
  if (expected.status !== 'fixed' || !expected.stoichiometry) {
    return { status: 'unresolved', factor: null, detail: '变量或无法解析的化学式不能直接与结构组成比较；需先确定超胞与有序化选择' };
  }
  const elements = new Set([...Object.keys(actual), ...Object.keys(expected.stoichiometry)]);
  const ratios: number[] = [];
  for (const element of elements) {
    const have = actual[element] ?? 0, want = expected.stoichiometry[element] ?? 0;
    if (want <= 0) return { status: 'mismatch', factor: null, detail: `结构中含化学式未声明的元素 ${element}` };
    if (have <= 0) return { status: 'mismatch', factor: null, detail: `结构缺少元素 ${element}` };
    ratios.push(have / want);
  }
  const factor = ratios[0];
  if (ratios.every(ratio => Math.abs(ratio - factor) < 1e-3)) {
    return { status: Math.abs(factor - 1) < 1e-3 ? 'exact' : 'multiple', factor: round(factor),
      detail: Math.abs(factor - 1) < 1e-3 ? '结构与化学式元素计量一致' : `结构是化学式的 ${round(factor)} 倍（可能为超胞）` };
  }
  return { status: 'mismatch', factor: null, detail: `元素比例不一致：${ratios.map(value => round(value)).join('、')}` };
}

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
};

export async function resolveStructureCandidate(root: string, input: { path: string; expected_formula?: string; source?: string; label?: string }): Promise<StructureArtifact> {
  const path = resolve(root, input.path);
  if (!inside(root, path)) throw new Error('结构文件必须位于项目内');
  let actual: string;
  try { actual = await realpath(path); }
  catch { throw new Error(`无法读取结构文件：${input.path}`); }
  if (!inside(await realpath(root), actual)) throw new Error('结构文件必须位于项目内');
  let text: string;
  try { text = await readFile(actual, 'utf8'); }
  catch (error) { throw new Error(`无法读取结构文件：${input.path}（${error instanceof Error ? error.message : String(error)}）`); }
  const isCif = /\.cif$/i.test(path) || /_cell_length_a/i.test(text);
  const parsed = isCif ? parseCif(text) : parsePoscar(text);
  const spaceGroup = isCif ? (parsed as ReturnType<typeof parseCif>).space_group ?? null : null;
  const expected = input.expected_formula ? parseFormula(input.expected_formula) : null;
  const warnings = [
    '格式检查通过不代表结构物理合理、计算收敛或解释成立。',
    '未检查最近邻距离、原子重叠、电荷平衡与磁性排序。',
  ];
  const unresolved: string[] = [];
  if (!isCif && !parsed.lattice) unresolved.push('未解析出晶格');
  const incompleteCell = isCif && !(parsed as ReturnType<typeof parseCif>).multiplicities_known;
  if (incompleteCell) unresolved.push('缺少位点多重性，列出的占位汇总不能确定晶胞组成');
  if (isCif && !spaceGroup) unresolved.push('CIF 未提供空间群名称');
  if (expected?.status === 'variable') unresolved.push('变量组成需要先选择超胞与有序化方案，不能直接计算单个晶胞');
  if (expected && expected.status === 'unparsed') unresolved.push(`期望化学式无法解析：${expected.reason ?? ''}`);
  if (!expected) unresolved.push('未提供期望化学式，未做组成一致性检查');
  return {
    structure_id: newId('struct'), path: relative(root, path).split(sep).join('/'),
    format: isCif ? 'cif' : 'poscar', source: input.source ?? 'user_file',
    lattice: parsed.lattice, sites: parsed.sites, composition: parsed.composition,
    expected_formula: input.expected_formula ?? null,
    composition_match: expected && incompleteCell ? { status: 'unresolved', factor: null, detail: '缺少位点多重性，无法比较完整晶胞计量' } : compareComposition(parsed.composition, expected),
    space_group: spaceGroup,
    warnings, unresolved, provenance: 'deterministic_analysis',
  };
}

export interface ComputationIntent {
  question: string;
  observable: string;
  structures?: { path: string; expected_formula?: string; label?: string; source?: string }[];
  hypotheses?: { hypothesis_id?: string; statement: string; predicts?: { observable: string; expected: string }[] }[];
  fixed_parameters?: Record<string, string>;
  decisions_required?: string[];
}

export const STANDARD_DECISIONS = [
  'exchange_correlation_functional', 'pseudopotential_set', 'hubbard_u',
  'magnetic_configuration', 'k_point_sampling', 'smearing', 'convergence_criteria',
];

export interface ComputationSpec {
  spec_id: string;
  created_at: string;
  question: string;
  observable: string;
  candidates: StructureArtifact[];
  hypotheses: { hypothesis_id: string; statement: string; discriminating_if: string | null }[];
  fixed_parameters: Record<string, string>;
  requires_decision: string[];
  expected_outputs: { quantity: string; tests_hypothesis: string; discriminating_if: string | null; note: string }[];
  structure_requirements: string[];
  warnings: string[];
  unresolved: string[];
  provenance: 'deterministic_analysis';
}

/**
 * Assemble a hand-off package. Unspecified scientific parameters are listed as decisions,
 * never silently fixed; without a structure the output is a requirements list.
 */
export async function prepareComputationSpec(root: string, intent: ComputationIntent): Promise<ComputationSpec> {
  if (!intent.question?.trim()) throw new Error('计算准备需要明确的问题');
  if (!intent.observable?.trim()) throw new Error('计算准备需要明确的可观测量');
  const candidates: StructureArtifact[] = [];
  const unresolved: string[] = [];
  for (const structure of intent.structures ?? []) {
    try { candidates.push(await resolveStructureCandidate(root, structure)); }
    catch (error) { unresolved.push(error instanceof Error ? error.message : String(error)); }
  }
  const fixed = intent.fixed_parameters ?? {};
  const requires = [...new Set([...STANDARD_DECISIONS, ...(intent.decisions_required ?? [])])]
    .filter(key => !(key in fixed));
  const hypotheses = (intent.hypotheses ?? []).map(hypothesis => {
    const prediction = (hypothesis.predicts ?? []).find(item => item.observable.normalize('NFKC').toLowerCase().trim() === intent.observable.normalize('NFKC').toLowerCase().trim());
    if (!prediction) unresolved.push(`假设「${hypothesis.statement}」没有给出「${intent.observable}」的预期，无法说明计算结果如何区分`);
    return {
      hypothesis_id: hypothesis.hypothesis_id ?? newId('hyp'),
      statement: hypothesis.statement,
      discriminating_if: prediction?.expected ?? null,
    };
  });
  if (!candidates.length) unresolved.push('缺少候选结构：需要 CIF/POSCAR 文件或明确的构造假设；只有化学式时不能编造晶格与原子坐标');
  return {
    spec_id: newId('comp'), created_at: nowIso(),
    question: intent.question.trim(), observable: intent.observable.trim(),
    candidates, hypotheses, fixed_parameters: fixed, requires_decision: requires,
    expected_outputs: hypotheses.map(hypothesis => ({
      quantity: intent.observable.trim(), tests_hypothesis: hypothesis.hypothesis_id,
      discriminating_if: hypothesis.discriminating_if,
      note: hypothesis.discriminating_if ? '若计算结果与该预期不符，则该假设被削弱' : '需要先补充该假设对可观测量的预期',
    })),
    structure_requirements: [
      '目标组成的确定化学式或变量范围（含定义域）',
      '晶胞参数，或可直接读取的 CIF/POSCAR 文件',
      '无序占位与超胞/有序化选择',
      '磁性初始构型与是否自旋极化',
    ],
    warnings: [
      '这是计算任务准备，不是计算完成；文件通过格式检查不证明结构合理或解释成立。',
      '未指定的泛函、赝势、U 值、磁构型与 k 点不会被默认固定。',
    ],
    unresolved: [...new Set(unresolved)],
    provenance: 'deterministic_analysis',
  };
}
