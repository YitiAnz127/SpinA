import { elementSymbols, nonmetalSymbols, type Draft, type Evidence, type Fact } from '../distillation/schema.ts';
import type { RecordReference } from '../distillation/store.ts';
import { newId, type SubjectRef } from './contracts.ts';

/**
 * F1: material identity.
 *
 * Deterministic parsing only. A formula yields an element set and a stoichiometry; it never
 * yields a space group, a cation distribution or a confirmed phase. Those require a source
 * label or an actual structure file.
 */

type Linear = { constant: number; terms: Record<string, number> };

const VARIABLES = new Set(['x', 'y', 'z', 'n', 'm', 'δ']);
const SUBSCRIPTS: Record<string, string> = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9' };

export function normalizeFormulaText(text: string): string {
  return String(text)
    .normalize('NFKC')
    .replace(/[₀-₉]/g, char => SUBSCRIPTS[char] ?? char)
    .replace(/\\(?:mathrm|text|ce)\{([^{}]*)\}/g, '$1')
    .replace(/[−–—]/g, '-')
    .replace(/\s+/g, '')
    .replace(/^~|~$/g, '');
}

function parseLinear(text: string): Linear | null {
  const tokens = text.replace(/\s+/g, '').match(/\d+(?:\.\d+)?|[A-Za-zδ]|[+\-]/g);
  if (!tokens || !tokens.length) return null;
  const linear: Linear = { constant: 0, terms: {} };
  let sign = 1, index = 0, sawTerm = false;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '+') { sign = 1; index++; continue; }
    if (token === '-') { sign = -sign; index++; continue; }
    let factor = 1, hasFactor = false;
    if (/^\d/.test(token)) { factor = Number(token); hasFactor = true; index++; }
    const next = tokens[index];
    if (next && /^[A-Za-zδ]$/.test(next)) {
      index++;
      linear.terms[next] = (linear.terms[next] ?? 0) + sign * factor;
      sawTerm = true;
    } else if (hasFactor) {
      linear.constant += sign * factor;
      sawTerm = true;
    } else return null;
    sign = 1;
  }
  return sawTerm ? linear : null;
}

const linearText = (linear: Linear): string => {
  const parts: string[] = [];
  if (Math.abs(linear.constant) > 1e-12 || !Object.keys(linear.terms).length) parts.push(String(Number(linear.constant.toFixed(6))));
  for (const [symbol, coefficient] of Object.entries(linear.terms)) {
    if (Math.abs(coefficient) < 1e-12) continue;
    parts.push(`${coefficient === 1 ? '' : coefficient === -1 ? '-' : Number(coefficient.toFixed(6))}${symbol}`);
  }
  return parts.join('+').replace(/\+-/g, '-');
};
const evaluate = (linear: Linear, values: Record<string, number>): number =>
  linear.constant + Object.entries(linear.terms).reduce((sum, [symbol, coefficient]) => sum + coefficient * (values[symbol] ?? 0), 0);

export interface FormulaDomain { symbol: string; min: number; max: number; source: string }
export interface FormulaTerm { element: string; expression: string; linear: Linear }
export interface FormulaParse {
  input: string;
  normalized: string;
  status: 'fixed' | 'variable' | 'unparsed';
  formula: string;
  elements: string[];
  metals: string[];
  terms: FormulaTerm[];
  variables: string[];
  domain: FormulaDomain | null;
  stoichiometry: Record<string, number> | null;
  element_ranges: Record<string, { min: number; max: number }> | null;
  composition_key: string | null;
  hydrate: boolean;
  reason: string | null;
}

const empty = (input: string, reason: string): FormulaParse => ({
  input, normalized: normalizeFormulaText(input), status: 'unparsed', formula: input, elements: [], metals: [],
  terms: [], variables: [], domain: null, stoichiometry: null, element_ranges: null, composition_key: null, hydrate: false, reason,
});

/** Extract a variable range such as `x = 0.0–1.0` from a sample name or note. */
export function extractFormulaDomain(text: string): FormulaDomain | null {
  const match = /([xyzδ])\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*(?:-|~|至|to)\s*([0-9]+(?:\.[0-9]+)?)/i.exec(String(text ?? '').replace(/[−–—]/g, '-'));
  if (!match) return null;
  const min = Number(match[2]), max = Number(match[3]);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return null;
  return { symbol: match[1], min, max, source: 'text_range' };
}

/** Parse a formula into element terms. Variables stay symbolic until a domain is supplied. */
export function parseFormula(input: string, options: { domain?: FormulaDomain | null } = {}): FormulaParse {
  const normalized = normalizeFormulaText(input);
  if (!normalized) return empty(input, '空化学式');
  if (/[,，/]/.test(normalized)) return empty(input, '混合物或占位表达不能作为确定组成');
  if (/[+\-](?:\d|$)/.test(normalized) && !/[_^{(]/.test(normalized)) return empty(input, '带电荷或未加括号的表达式不能作为确定组成');

  const hydrateParts = normalized.split('·');
  const terms: FormulaTerm[] = [];
  let index = 0;
  let current = hydrateParts[0];

  const readCoefficient = (): Linear => {
    if (current[index] === '_') {
      index++;
      if (current[index] === '{') {
        const end = current.indexOf('}', index);
        if (end < 0) throw new Error('括号未闭合');
        const text = current.slice(index + 1, end);
        index = end + 1;
        const linear = parseLinear(text);
        if (!linear) throw new Error(`无法解析系数：${text}`);
        return linear;
      }
      const match = /^[A-Za-zδ]/.exec(current.slice(index));
      if (match) { index += match[0].length; return { constant: 0, terms: { [match[0]]: 1 } }; }
      throw new Error('下划线后缺少系数');
    }
    if (current[index] === '{') {
      const end = current.indexOf('}', index);
      if (end < 0) throw new Error('括号未闭合');
      const text = current.slice(index + 1, end);
      index = end + 1;
      const linear = parseLinear(text);
      if (!linear) throw new Error(`无法解析系数：${text}`);
      return linear;
    }
    // Numeric coefficients may carry a linear correction such as `4-δ` (oxygen deficiency).
    const match = /^\d+(?:\.\d+)?(?:[+\-][A-Za-zδ])?/.exec(current.slice(index));
    if (match) {
      index += match[0].length;
      const linear = parseLinear(match[0]);
      if (!linear) throw new Error(`无法解析系数：${match[0]}`);
      return linear;
    }
    return { constant: 1, terms: {} };
  };

  const merge = (target: FormulaTerm[], source: FormulaTerm[], multiplier: Linear) => {
    for (const term of source) {
      if (Object.keys(term.linear.terms).length && Object.keys(multiplier.terms).length) throw new Error('非线性系数（变量相乘）不能作为确定组成');
      target.push({
        element: term.element,
        expression: linearText({
          constant: term.linear.constant * multiplier.constant,
          terms: Object.fromEntries([
            ...Object.entries(term.linear.terms).map(([symbol, value]) => [symbol, value * multiplier.constant]),
            ...Object.entries(multiplier.terms).map(([symbol, value]) => [symbol, value * term.linear.constant]),
          ]),
        }),
        linear: {
          constant: term.linear.constant * multiplier.constant,
          terms: Object.fromEntries([
            ...Object.entries(term.linear.terms).map(([symbol, value]) => [symbol, value * multiplier.constant]),
            ...Object.entries(multiplier.terms).map(([symbol, value]) => [symbol, value * term.linear.constant]),
          ]),
        },
      });
    }
  };

  const parseSequence = (insideGroup: boolean): FormulaTerm[] => {
    const collected: FormulaTerm[] = [];
    let count = 0;
    while (index < current.length && current[index] !== ')') {
      if (current[index] === '(') {
        index++;
        const inner = parseSequence(true);
        if (current[index] !== ')') throw new Error('括号未闭合');
        index++;
        merge(collected, inner, readCoefficient());
        count++;
        continue;
      }
      const atom = /^[A-Z][a-z]?/.exec(current.slice(index));
      if (!atom) throw new Error(`无法识别的字符：${current[index]}`);
      const element = atom[0];
      if (!elementSymbols.has(element)) throw new Error(`未知元素符号：${element}`);
      index += element.length;
      const coefficient = readCoefficient();
      collected.push({ element, expression: linearText(coefficient), linear: coefficient });
      count++;
    }
    if (!count) throw new Error('缺少元素项');
    return collected;
  };

  try {
    terms.push(...parseSequence(false));
    if (index !== current.length) throw new Error('表达式未完整解析');
    // Hydrate parts (e.g. ·2H2O) are separate compositions; sum them into the same element terms.
    for (const part of hydrateParts.slice(1)) {
      current = part;
      index = 0;
      let multiplier: Linear = { constant: 1, terms: {} };
      const leading = /^\d+(?:\.\d+)?/.exec(current);
      if (leading) { multiplier = { constant: Number(leading[0]), terms: {} }; index = leading[0].length; }
      const inner = parseSequence(false);
      if (index !== current.length) throw new Error('水合物部分未完整解析');
      merge(terms, inner, multiplier);
    }
  } catch (error) {
    return empty(input, error instanceof Error ? error.message : String(error));
  }

  const merged = new Map<string, Linear>();
  for (const term of terms) {
    const existing = merged.get(term.element) ?? { constant: 0, terms: {} };
    existing.constant += term.linear.constant;
    for (const [symbol, value] of Object.entries(term.linear.terms)) existing.terms[symbol] = (existing.terms[symbol] ?? 0) + value;
    merged.set(term.element, existing);
  }
  const variables = [...new Set(Object.values(Object.fromEntries(merged)).flatMap(linear => Object.keys(linear.terms)))].sort();
  const elements = [...merged.keys()];
  const metals = elements.filter(element => !nonmetalSymbols.has(element)).sort();
  const status: FormulaParse['status'] = variables.length ? 'variable' : 'fixed';
  const domain = options.domain && variables.includes(options.domain.symbol) ? options.domain : null;

  let stoichiometry: Record<string, number> | null = null;
  if (status === 'fixed') {
    stoichiometry = Object.fromEntries(elements.map(element => [element, Number(merged.get(element)!.constant.toFixed(6))]));
  }

  let elementRanges: Record<string, { min: number; max: number }> | null = null;
  const domains: Record<string, FormulaDomain> = {};
  if (domain) domains[domain.symbol] = domain;
  if (variables.length && variables.every(symbol => domains[symbol])) {
    elementRanges = {};
    for (const [element, linear] of merged) {
      const atMin = evaluate(linear, Object.fromEntries(Object.values(domains).map(item => [item.symbol, item.min])));
      const atMax = evaluate(linear, Object.fromEntries(Object.values(domains).map(item => [item.symbol, item.max])));
      elementRanges[element] = { min: Number(Math.min(atMin, atMax).toFixed(6)), max: Number(Math.max(atMin, atMax).toFixed(6)) };
    }
  }

  return {
    input, normalized, status, formula: input, elements, metals,
    terms: elements.map(element => {
      const linear = merged.get(element)!;
      return { element, expression: linearText(linear), linear };
    }),
    variables, domain, stoichiometry, element_ranges: elementRanges,
    composition_key: status === 'fixed' ? compositionKey(stoichiometry!) : null,
    hydrate: hydrateParts.length > 1,
    reason: null,
  };
}

export function compositionKey(stoichiometry: Record<string, number>): string {
  return Object.entries(stoichiometry).sort(([a], [b]) => a.localeCompare(b))
    .map(([element, count]) => `${element}:${Number(count.toFixed(6))}`).join('|');
}

export interface StructureIdentity {
  family: 'spinel' | 'related_spinel' | 'unknown';
  subtype: 'normal' | 'inverse' | 'mixed' | 'oxyspinel' | null;
  label: string | null;
  confirmed: boolean;
  basis: 'source_label' | 'stoichiometry_candidate' | 'none';
  note: string;
}

/** Structure identity comes from the source label; stoichiometry alone is only a candidate. */
export function structureIdentity(label: string | null, formula: FormulaParse | null): StructureIdentity {
  const text = String(label ?? '').normalize('NFKC').toLowerCase().trim();
  const make = (family: StructureIdentity['family'], subtype: StructureIdentity['subtype'], note: string): StructureIdentity =>
    ({ family, subtype, label: label ?? null, confirmed: family === 'spinel', basis: 'source_label', note });
  if (text) {
    if (/(?:non[- ]?|not\b.*|no\b.*|possible\b.*|possibly\b.*|unconfirmed\b.*|未确认|可能|非)(?:spinel|尖晶石)|(?:spinel|尖晶石).*(?:not confirmed|unconfirmed|未确认)/.test(text)) return make('unknown', null, '来源有否定或不确定限定');
    if (/(related|like|defect|disordered)/.test(text) && /spinel/.test(text)) return make('related_spinel', null, '来源仅指相关结构');
    if (/inverse\s*spinel/.test(text)) return make('spinel', 'inverse', '原文标注反尖晶石');
    if (/normal\s*spinel/.test(text)) return make('spinel', 'normal', '原文标注正尖晶石');
    if (/oxyspinel/.test(text)) return make('spinel', 'oxyspinel', '原文标注氧尖晶石');
    if (/spinel/.test(text)) return make('spinel', null, '原文标注尖晶石，未说明正/反占位');

  }
  const counts = formula?.stoichiometry;
  const candidate = formula?.status === 'fixed' && counts && counts.O > 0 && formula.elements.length === formula.metals.length + 1 &&
    Math.abs(formula.metals.reduce((sum, metal) => sum + counts[metal], 0) / counts.O - 0.75) < 1e-9 ? '化学计量接近 AB2O4，只能作为结构候选' : '缺少结构来源';
  return { family: 'unknown', subtype: null, label: label ?? null, confirmed: false, basis: candidate.startsWith('化学计量') ? 'stoichiometry_candidate' : 'none', note: candidate };
}

const factText = (fact: Fact | undefined): string | null => {
  if (!fact) return null;
  if (typeof fact.value === 'string') return fact.value;
  if (fact.raw) return fact.raw;
  return null;
};
const factEvidence = (fact: Fact | undefined): Evidence[] => fact?.evidence ?? [];

export interface MaterialIdentity {
  identity_id: string;
  subject: SubjectRef;
  record_ref: RecordReference;
  label: string;
  composition_role: 'target' | 'nominal' | 'measured' | 'precursor';
  composition: FormulaParse;
  element_set: string[];
  structure: StructureIdentity;
  material_state: string;
  evidence: Evidence[];
  unresolved: string[];
  provenance: 'deterministic_analysis';
}

function identityFor(record: { paper: { paper_id: string }; draft: Draft }, version: RecordReference['version'],
  sample: Draft['samples'][number], phase: Draft['samples'][number]['phases'][number] | null,
  fact: Fact | undefined, role: MaterialIdentity['composition_role']): MaterialIdentity {
  const label = factText(fact) ?? '';
  const domain = extractFormulaDomain(`${sample.name} ${sample.unresolved_questions.join(' ')} ${record.draft.notes.join(' ')}`);
  const composition = parseFormula(label, { domain });
  const identityLabel = phase?.identity.status === 'reported' ? factText(phase.identity) : null;
  const structure = structureIdentity(identityLabel, composition);
  const unresolved: string[] = [];
  if (composition.status === 'unparsed') unresolved.push(`化学式无法解析：${composition.reason ?? '未知原因'}`);
  if (composition.status === 'variable' && !composition.domain) unresolved.push('变量化学式未给出定义域，不能实例化为确定组成');
  if (!structure.confirmed) unresolved.push('结构身份未由原文标注确认；化学式相同不能确定晶型或阳离子占位');
  if (role === 'target' && !phase) unresolved.push('未定位到目标相');
  return {
    identity_id: newId('mat'),
    subject: { paper_id: record.paper.paper_id, sample_id: sample.local_id, ...(phase ? { phase_id: phase.local_id } : {}) },
    record_ref: { paper_id: record.paper.paper_id, version, revision: 0, verified_at: '' },
    label: label || sample.name,
    composition_role: role,
    composition,
    element_set: [...composition.elements].sort(),
    structure,
    material_state: sample.material_state,
    evidence: [...factEvidence(fact), ...(phase ? factEvidence(phase.identity) : [])],
    unresolved,
    provenance: 'deterministic_analysis',
  };
}

/** Resolve the identity of a sample's target phase, falling back to nominal composition. */
export function resolveMaterialIdentity(record: {
  paper: { paper_id: string }; draft: Draft; revision: number; verified_at: string;
}, version: RecordReference['version'], sampleId: string, phaseId?: string): MaterialIdentity {
  const sample = record.draft.samples.find(item => item.local_id === sampleId);
  if (!sample) throw new Error(`样品不存在：${sampleId}`);
  const phases = sample.phases.filter(phase => phase.role === 'target_spinel');
  if (!phaseId && phases.length > 1) throw new Error('样品有多个目标相，请指定 phase_id');
  const phase = phaseId ? phases.find(item => item.local_id === phaseId) : phases[0] ?? null;
  if (phaseId && !phase) throw new Error(`相不存在：${phaseId}`);
  if (!phase) {
    if (sample.nominal_composition.status === 'reported' || sample.nominal_composition.raw) {
      const identity = identityFor(record, version, sample, null, sample.nominal_composition, 'nominal');
      identity.record_ref = { paper_id: record.paper.paper_id, version, revision: record.revision, verified_at: record.verified_at };
      return identity;
    }
    throw new Error(`样品 ${sampleId} 没有目标相或标称组成，无法解析材料身份`);
  }
  const identity = identityFor(record, version, sample, phase, phase.formula, 'target');
  identity.record_ref = { paper_id: record.paper.paper_id, version, revision: record.revision, verified_at: record.verified_at };
  return identity;
}

export interface MaterialRelation {
  left: MaterialIdentity;
  right: MaterialIdentity;
  layers: {
    element_set: 'same' | 'different' | 'unknown';
    composition: 'same' | 'different' | 'family' | 'unresolved';
    structure: 'candidate_match' | 'different' | 'unresolved';
    specimen: 'same' | 'different';
  };
  statements: string[];
  unresolved: string[];
  provenance: 'deterministic_analysis';
}

/**
 * Relate two identities layer by layer. There is intentionally no aggregate score: a pair can
 * share an element set while differing in stoichiometry, which is exactly the case that must
 * not be reported as "the same material".
 */
export function relateMaterials(left: MaterialIdentity, right: MaterialIdentity): MaterialRelation {
  const statements: string[] = [];
  const unresolved: string[] = [];
  const elementSame = left.element_set.length && right.element_set.length
    ? left.element_set.join('|') === right.element_set.join('|') : null;
  if (elementSame === null) { statements.push('元素集合至少一方未知，不能比较'); unresolved.push('元素集合未知'); }
  else if (elementSame) statements.push(`元素集合相同：${left.element_set.join('–')}`);
  else statements.push(`元素集合不同：${left.element_set.join('–')} vs ${right.element_set.join('–')}`);

  let composition: MaterialRelation['layers']['composition'] = 'unresolved';
  if (left.composition.status === 'fixed' && right.composition.status === 'fixed') {
    const a = left.composition.stoichiometry!, b = right.composition.stoichiometry!;
    const first = left.element_set.find(key => a[key] > 0 && b[key] > 0);
    const same = Boolean(elementSame && first && left.element_set.every(key =>
      Math.abs(a[key] / a[first] - b[key] / b[first]) < 1e-8));
    composition = same ? 'same' : 'different';
    statements.push(same
      ? `计量组成相同：${left.composition.formula}`
      : `计量组成不同：${left.composition.formula}（${left.composition.composition_key}）vs ${right.composition.formula}（${right.composition.composition_key}）；元素集合相同不等于同一计量`);
  } else if (left.composition.status === 'variable' || right.composition.status === 'variable') {
    if (elementSame) {
      composition = 'family';
      statements.push('至少一方为变量组成，只能判断属于同一组成家族，不能合并为同一计量');
      if (!left.composition.domain || !right.composition.domain) unresolved.push('变量组成缺少定义域，端点关系未判定');
    } else unresolved.push('变量组成且元素集合不同，无法建立组成关系');
  } else {
    unresolved.push('至少一方化学式无法解析，组成关系未知');
  }

  let structure: MaterialRelation['layers']['structure'] = 'unresolved';
  if (left.structure.family !== 'unknown' && right.structure.family !== 'unknown') {
    if (left.structure.family === right.structure.family) {
      structure = 'candidate_match';
      statements.push(`结构家族表述一致（${left.structure.family}${left.structure.subtype ? `/${left.structure.subtype}` : ''}），仍不等于同一晶型或同一占位`);
    } else {
      structure = 'different';
      statements.push('结构家族表述不同');
    }
  } else {
    statements.push('结构身份未确认：化学式相同不能推出晶型或阳离子占位相同');
    unresolved.push('结构身份缺少来源标注或结构文件');
  }

  const specimen = left.subject.paper_id === right.subject.paper_id && left.subject.sample_id === right.subject.sample_id ? 'same' : 'different';
  if (specimen === 'same') statements.push('指向同一论文的同一记录样品');

  return { left, right, layers: { element_set: elementSame === null ? 'unknown' : elementSame ? 'same' : 'different', composition, structure, specimen }, statements, unresolved, provenance: 'deterministic_analysis' };
}
