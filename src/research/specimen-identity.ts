import { createHash } from 'node:crypto';
import { deriveMetalElements, type Draft } from '../distillation/schema.ts';

/**
 * A specimen fingerprint lets a later revision answer "is this still the same experimental
 * sample?" without keeping every historical revision. Two keys are stored because they fail
 * differently: the chemistry key survives a rename, the label key survives a corrected formula.
 *
 * A fingerprint is evidence of continuity, never of physical identity: equal formulas in two
 * samples still do not prove the same batch, and a changed fingerprint does not prove a
 * different material — it only means the record changed enough that a person must look.
 */

export interface SampleFingerprint {
  sample_id: string;
  name: string;
  chemistry_key: string;
  label_key: string;
  formulas: string[];
  metal_elements: string[];
  material_state: string;
}

type Sample = Draft['samples'][number];

const SUBSCRIPTS: Record<string, string> = {
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
  '₊': '+', '₋': '-',
};

/** Unicode subscripts, full-width digits and spacing variants must not split one formula into two. */
export function normalizeFormulaText(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/[₀-₉₊₋]/g, character => SUBSCRIPTS[character] ?? character)
    .replace(/[−–—]/g, '-')
    .replace(/\s+/g, '')
    .toLowerCase()
    // A hyphen between two letters is a word separator in descriptive labels ("Ni-Co oxide"),
    // not part of a stoichiometry; keeping it would turn a rewording into a "redefined" sample.
    .replace(/(?<=[a-z])-(?=[a-z])/g, '');
}

const labelKeyOf = (input: string) => input.normalize('NFKC').toLowerCase().replace(/[\s_\-./·]+/g, '');

const hash = (parts: string[]) => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);

const reported = (fact: { status: string; raw: string | null; value: unknown }) =>
  fact.status === 'reported' || Boolean(fact.raw) || fact.value !== null;

function phaseFormulas(sample: Sample): string[] {
  return sample.phases
    .filter(phase => phase.role === 'target_spinel')
    .filter(phase => reported(phase.formula))
    .map(phase => normalizeFormulaText(String(phase.formula.raw ?? phase.formula.value ?? '')))
    .filter(Boolean)
    .sort();
}

function metalElements(sample: Sample): string[] {
  const elements = new Set<string>();
  for (const phase of sample.phases) {
    if (phase.role !== 'target_spinel') continue;
    // Prefer the stored derivation; fall back to the formula so a record without the derived
    // field does not fingerprint differently from the same sample with it.
    if (phase.metal_elements) {
      const raw = phase.metal_elements.value;
      const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,;]+/) : [];
      for (const item of list) {
        const symbol = String(item).trim();
        if (symbol) elements.add(symbol[0].toUpperCase() + symbol.slice(1).toLowerCase());
      }
      continue;
    }
    const formula = String(phase.formula.raw ?? phase.formula.value ?? '').trim();
    for (const symbol of (formula ? deriveMetalElements(formula) : null) ?? []) elements.add(symbol);
  }
  return [...elements].sort();
}

export function sampleFingerprint(sample: Sample): SampleFingerprint {
  const formulas = phaseFormulas(sample);
  const elements = metalElements(sample);
  const nominal = reported(sample.nominal_composition) ? normalizeFormulaText(String(sample.nominal_composition.raw ?? sample.nominal_composition.value ?? '')) : '';
  // Chemistry falls back to the nominal composition so a sample without a target phase is still
  // distinguishable; with neither, the key stays empty and continuity is reported as unverifiable.
  const chemistryParts = formulas.length ? formulas : nominal ? [`nominal:${nominal}`] : [];
  const chemistryKey = chemistryParts.length ? hash([...chemistryParts, ...elements]) : '';
  return {
    sample_id: sample.local_id,
    name: sample.name,
    chemistry_key: chemistryKey,
    label_key: labelKeyOf([sample.name, ...sample.aliases].filter(Boolean).join('|')),
    formulas: [...new Set(formulas)],
    metal_elements: elements,
    material_state: sample.material_state,
  };
}

export function fingerprintDraft(draft: Draft): SampleFingerprint[] {
  return draft.samples.map(sampleFingerprint);
}

export type ContinuityStatus =
  /** Same sample ID, same reported chemistry. */
  | 'same_specimen'
  /** Same sample ID but the reported chemistry changed: the ID now points at a different material. */
  | 'redefined'
  /** The sample ID is gone but exactly one sample carries the same chemistry. */
  | 'relabelled'
  /** The sample ID is gone and no single sample matches the recorded chemistry. */
  | 'missing'
  /** Nothing recorded to compare (legacy row without fingerprint, or no formula at all). */
  | 'unverifiable'
  /** The stored reference already matches the current revision. */
  | 'current';

export interface ContinuityCheck {
  status: ContinuityStatus;
  /** Sample that now carries the same specimen, when it moved. */
  resolved_sample_id: string | null;
  explanation: string;
}

/**
 * Resolve one stored fingerprint against the current draft. `relabelled` requires a unique
 * chemistry match: two candidates mean the record no longer distinguishes them, which is a
 * review item, not a silent rebind.
 */
export function checkContinuity(fingerprint: SampleFingerprint | null | undefined, current: SampleFingerprint[], sampleId: string): ContinuityCheck {
  const byId = current.find(item => item.sample_id === sampleId) ?? null;
  if (!fingerprint || !fingerprint.chemistry_key) {
    return byId
      ? { status: 'unverifiable', resolved_sample_id: byId.sample_id, explanation: '旧记录没有可用于比对的化学指纹；样品 ID 仍存在，但无法确认是否为同一实验样品' }
      : { status: 'missing', resolved_sample_id: null, explanation: '旧记录没有化学指纹，当前修订中也没有该样品 ID' };
  }
  if (byId) {
    if (byId.chemistry_key === fingerprint.chemistry_key) {
      return { status: 'same_specimen', resolved_sample_id: byId.sample_id, explanation: '样品 ID 与目标相化学指纹均未变化' };
    }
    return {
      status: 'redefined', resolved_sample_id: byId.sample_id,
      explanation: `样品 ID 未变，但目标相化学指纹变化（${fingerprint.formulas.join('、') || '未记录'} → ${byId.formulas.join('、') || '未记录'}）；旧观察不能直接沿用`,
    };
  }
  const matches = current.filter(item => item.chemistry_key === fingerprint.chemistry_key);
  if (matches.length === 1) {
    return {
      status: 'relabelled', resolved_sample_id: matches[0].sample_id,
      explanation: `样品 ID 由 ${sampleId} 变为 ${matches[0].sample_id}，化学指纹一致；需要确认是否同一批样品后再复用旧观察`,
    };
  }
  if (matches.length > 1) {
    return {
      status: 'missing', resolved_sample_id: null,
      explanation: `样品 ${sampleId} 已不存在，且有 ${matches.length} 个样品化学指纹相同（${matches.map(item => item.sample_id).join('、')}），不能自动判断归属`,
    };
  }
  return { status: 'missing', resolved_sample_id: null, explanation: `样品 ${sampleId} 在当前修订中不存在，也没有化学指纹相同的样品` };
}
