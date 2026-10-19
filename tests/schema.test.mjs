import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelJson, deriveMetalElements, validateEvidence, validateDraft } from '../src/distillation/schema.ts';
import * as schema from '../src/distillation/schema.ts';

test('reads a single JSON payload but rejects prose and extra payloads', () => {
  assert.deepEqual(parseModelJson('```json\n{"samples":[]}\n```'), { samples: [] });
  assert.throws(() => parseModelJson('Here is the answer: {"samples":[]}'));
  assert.throws(() => parseModelJson('{} {}'));
});

test('derives a phase element set without including oxygen or another phase', () => {
  assert.deepEqual(deriveMetalElements('NiFe₂O₄'), ['Fe', 'Ni']);
  assert.deepEqual(deriveMetalElements('Ni_{0.382}Fe_{2.618}O_4'), ['Fe', 'Ni']);
  assert.equal(deriveMetalElements('Ni_{1-x}Co_xFe2O4'), null);
  assert.deepEqual(deriveMetalElements('CoIn2Se4'), ['Co', 'In']);
  assert.deepEqual(deriveMetalElements('Mg(Fe0.5Co0.5)2O4'), ['Co', 'Fe', 'Mg']);
  assert.deepEqual(deriveMetalElements('NiFe2O4−δ'), ['Fe', 'Ni']);
  assert.equal(deriveMetalElements('Mg(Fe0.5Co0.5)0O4'), null);
  assert.equal(deriveMetalElements('Ni1-xCoxFe2O4'), null);
  assert.equal(deriveMetalElements('NiFe2O4/Al2O3'), null);
  assert.equal(deriveMetalElements('Fe0NiCo2O4'), null);
});

test('phase metal names require model confirmation unless an exact formula establishes membership', () => {
  const f=(raw,value)=>({raw,value,status:'reported',unit:null,evidence:[{source_id:'src_1',page:1,quote:raw}],note:''});
  const phase={formula:f('Ni_{0.382}Fe_{2.618}O_4','Ni_{0.382}Fe_{2.618}O_4'),metal_elements:f('Ni(II) ferrite',['Ni','Fe'])};
  assert.deepEqual(schema.derivePhaseMetalElements(phase),['Fe','Ni']);
  phase.formula={...phase.formula,status:'ambiguous'};
  assert.equal(schema.derivePhaseMetalElements(phase),null);
  assert.deepEqual(schema.derivePhaseMetalElements(phase,true),['Fe','Ni']);
});

test('requires a real source page and a quote that occurs on that page', () => {
  const sources = [{ id: 'src_1', pages: [{ number: 1, text: 'Calcined at 400 °C for 2 h.' }] }];
  assert.deepEqual(validateEvidence([{ source_id: 'src_1', page: 1, quote: 'Calcined at 400 °C' }], sources), []);
  assert.equal(validateEvidence([{ source_id: 'src_1', page: 2, quote: 'Calcined at 400 °C' }], sources).length, 1);
  assert.equal(validateEvidence([{ source_id: 'src_1', page: 1, quote: 'Calcined at 900 °C' }], sources).length, 1);
});

test('image evidence requires a supplied page image, while text evidence remains literal', () => {
  const quote={source_id:'src_1',page:1,quote:'NiCo2O4 spinel was prepared',basis:'page_image'};
  const page={number:1,text:'NiC0204 spinel was prepared'};
  assert.equal(validateEvidence([quote],[{id:'src_1',pages:[page]}]).length,1);
  const sources=[{id:'src_1',pages:[{...page,image_path:'.runtime/rendered/page-1.png'}]}];
  assert.deepEqual(validateEvidence([quote],sources),[]);
  assert.equal(validateEvidence([{...quote,basis:'page_text'}],sources).length,1);
});

test('shared material references resolve only through the actual ancestor chain', () => {
  const empty={raw:null,value:null,unit:null,status:'not_reported',evidence:[],note:''};
  const sample=id=>({local_id:id,name:id,aliases:[],material_state:'as_prepared',variables:[],nominal_composition:empty,measured_composition:empty,phases:[],method:empty,materials:[],steps:[],shared_from:null,unresolved_questions:[]});
  const a=sample('parent'),b=sample('child'),other=sample('unrelated');
  a.materials=[{local_id:'co_salt',identity:empty,role:'precursor',amount:empty,concentration:empty}];
  other.materials=structuredClone(a.materials);b.shared_from='parent';b.steps=[{local_id:'mix',operation:empty,description:empty,conditions:[],material_refs:['parent.co_salt']}];
  const d={assessment:'original_experiments',notes:[],samples:[a,b,other]};
  assert.deepEqual(validateDraft(d,[]),[]);
  b.steps[0].material_refs=['co_salt'];assert.deepEqual(validateDraft(d,[]),[]);
  b.steps[0].material_refs=['unrelated.co_salt'];assert.ok(validateDraft(d,[]).some(x=>x.includes('原料')));
  a.shared_from='unrelated';b.steps[0].material_refs=['co_salt'];assert.ok(validateDraft(d,[]).some(x=>x.includes('原料')));
});

test('a focused step patch merges by local_id instead of replacing the whole step list', () => {
  const empty = { raw: null, value: null, unit: null, status: 'not_reported', evidence: [], note: '' };
  const step = (id, refs = []) => ({ local_id: id, operation: { ...empty, raw: id, status: 'reported' }, conditions: [], material_refs: refs });
  const sample = {
    local_id: 's1', name: 'S1', aliases: [], material_state: 'as_prepared', variables: [],
    nominal_composition: empty, measured_composition: empty, phases: [], method: empty, materials: [],
    steps: [step('st1'), step('st2'), step('st3')], shared_from: null, unresolved_questions: [],
  };
  const draft = { assessment: 'original_experiments', notes: [], samples: [sample] };
  const patch = JSON.stringify({ patches: [{ sample_local_id: 's1', changes: { steps: [step('st2', ['m_new'])] } }] });
  const result = schema.applyFocusedRepair(patch, draft);
  assert.deepEqual(result.samples[0].steps.map(item => item.local_id), ['st1', 'st2', 'st3']);
  assert.deepEqual(result.samples[0].steps[1].material_refs, ['m_new']);
  assert.equal(result.samples[0].steps[0].operation.raw, 'st1');
  assert.equal(result.samples[0].steps[2].operation.raw, 'st3');
});

test('a clear_steps flag still removes every step when the branch is genuinely empty', () => {
  const empty = { raw: null, value: null, unit: null, status: 'not_reported', evidence: [], note: '' };
  const step = id => ({ local_id: id, operation: { ...empty, raw: id, status: 'reported' }, description: empty, conditions: [], material_refs: [] });
  const sample = {
    local_id: 's1', name: 'S1', aliases: [], material_state: 'as_prepared', variables: [],
    nominal_composition: empty, measured_composition: empty, phases: [], method: empty, materials: [],
    steps: [step('st1'), step('st2')], shared_from: null, unresolved_questions: [],
  };
  const result = schema.applyFocusedRepair(JSON.stringify({ patches: [{ sample_local_id: 's1', clear_steps: true, changes: { steps: [] } }] }), { assessment: 'original_experiments', notes: [], samples: [sample] });
  assert.deepEqual(result.samples[0].steps, []);
});

test('explicit phase metals support an established family without inventing individual stoichiometry', () => {
  const f=(raw,value,status='reported')=>({raw,value,status,unit:null,evidence:[{source_id:'src_1',page:1,quote:raw}],note:''});
  const phase={formula:f('NixCo(3-x)O4','NixCo(3-x)O4'),metal_elements:f('NixCo(3-x)O4 with 0.6 ≤ x ≤ 1.3',['Ni','Co'])};
  assert.equal(typeof schema.derivePhaseMetalElements,'function');
  assert.deepEqual(schema.derivePhaseMetalElements(phase),['Co','Ni']);
  phase.metal_elements.status='ambiguous';assert.equal(schema.derivePhaseMetalElements(phase),null);
  phase.metal_elements=f('Co3O4 spinel',['Co','Sr']);assert.equal(schema.derivePhaseMetalElements(phase),null);
});
