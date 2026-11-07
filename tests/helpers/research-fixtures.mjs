import { deriveMetalElements } from '../../src/distillation/schema.ts';

/** Minimal but schema-shaped records for the research layer tests. */

export const evidence = (page = 1, quote = 'annealed at 900 °C for 4 h') => [{ source_id: 'src_1', page, quote }];

export const fact = (raw, value, unit = null, status = 'reported', extra = {}) => ({
  raw, value, unit, status, evidence: status === 'reported' ? evidence() : [], note: '', ...extra,
});
export const emptyFact = () => ({ raw: null, value: null, unit: null, status: 'not_reported', evidence: [], note: '' });

export function makeSample(options = {}) {
  const {
    id, name = id, sharedFrom = null, state = 'as_prepared',
    formula = 'NiFe2O4', identity = 'spinel',
    temperature = '900 °C', duration = '4 h', temperatureStatus = 'reported', durationStatus = 'reported',
    materials = ['NiO'], extraCondition = null, variables = [],
  } = options;
  const materialFacts = materials.map((material, index) => ({
    local_id: `M${index + 1}`,
    identity: fact(material, material, null),
    role: 'precursor',
    amount: fact('1 g', '1 g', 'g'),
    concentration: emptyFact(),
  }));
  return {
    local_id: id, name, aliases: [], material_state: state,
    variables: variables.map(variable => ({ name: variable.name, fact: fact(variable.value, variable.value, variable.unit ?? null) })),
    nominal_composition: emptyFact(), measured_composition: emptyFact(),
    phases: [{
      local_id: 'P1', role: 'target_spinel',
      formula: fact(formula, formula, null), identity: fact(identity, identity, null), purity: emptyFact(),
    }],
    method: fact('co-precipitation', 'co-precipitation', null),
    materials: materialFacts,
    steps: [{
      local_id: 'ST1', operation: fact('annealing', 'annealing', null), description: emptyFact(),
      material_refs: materialFacts.map(material => material.local_id),
      conditions: [
        { name: 'temperature', fact: temperatureStatus === 'reported' ? fact(temperature, temperature, '°C') : { ...emptyFact(), note: '原文未报告温度' } },
        { name: 'duration', fact: durationStatus === 'reported' ? fact(duration, duration, 'h') : { ...emptyFact(), note: '原文未报告时长' } },
        ...(extraCondition ? [{ name: extraCondition.name, fact: fact(extraCondition.value, extraCondition.value, extraCondition.unit ?? null) }] : []),
      ],
    }],
    shared_from: sharedFrom, unresolved_questions: [],
  };
}

export function makeRecord(options = {}) {
  const { paperId = 'RES-1', samples = [], revision = 1, verifiedAt = '2026-10-01T00:00:00.000Z', issues = [] } = options;
  return {
    schema_version: 1,
    paper: { paper_id: paperId, doi: '10.1234/research', title: 'Research fixture' },
    revision, verified_at: verifiedAt, verified_by: 'fixture', verification_status: 'verified',
    sources: [{ id: 'src_1', path: 'data/paper/fixture.pdf', kind: 'body', page_count: 10, empty_text_pages: [] }],
    draft: { assessment: 'original_experiments', samples, notes: [] },
    verification: {
      source_identity: 'confirmed', coverage: 'complete', notes: [], issues,
      samples: samples.map(sample => ({
        sample_local_id: sample.local_id, has_confirmed_errors: false, has_unresolved_issues: false,
        can_match: true, expandable_fields: [], missing_or_uncertain: [],
      })),
    },
    match_entries: samples.flatMap(sample => sample.phases
      .filter(phase => phase.role === 'target_spinel')
      .flatMap(phase => {
        const metals = deriveMetalElements(phase.formula.value ?? '');
        return metals ? [{
          sample_local_id: sample.local_id, phase_local_id: phase.local_id,
          metal_elements: metals, element_key: metals.join('|'), material_state: sample.material_state,
        }] : [];
      })),
  };
}
