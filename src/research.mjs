import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExperimentStore } from './distillation/store.ts';
import { ResearchStore, SPECIMEN_RELATION_TYPES } from './research/store.ts';
import { CAPABILITIES, TASK_LABELS, TASK_TYPES, newId, nowIso, makeArtifact, planResearchTask } from './research/contracts.ts';
import { resolveMaterialIdentity, relateMaterials } from './research/materials.ts';
import { buildSpecimenLineage } from './research/specimens.ts';
import { sampleFingerprint } from './research/specimen-identity.ts';
import { checkEvidenceContinuity } from './research/continuity.ts';
import { analyzeSampleSeries } from './research/study-design.ts';
import { explainDisagreement, validateClaim, CLAIM_KIND_LABELS } from './research/claims.ts';
import { identifyDiscriminatingObservations, ingestHypotheses, validateHypothesis } from './research/hypotheses.ts';
import { prepareComputationSpec, resolveStructureCandidate } from './research/computation.ts';
import { extractTableObservations, toObservation } from './research/facets/observations.ts';
import { readSources } from './distillation/documents.ts';
import { resolveSample } from './research/adapters/preparation-reader.ts';
import { table, printJson, truncate, parseFlags } from './cli-format.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const workDatabase = resolve(root, 'data/distillation/spina.sqlite');

const usage = `SpinA 研究分析层（F1–F6）

  npm run research -- plan --type series_analysis --question "..." [--paper P --sample S] [--json]
  npm run research -- identity --paper SPINA-0020 [--sample S] [--phase PH] [--version uncertain]
  npm run research -- relate --entity SPINA-0020:S1 --entity SPINA-0031:S2
  npm run research -- lineage --paper SPINA-0093 --sample S3
  npm run research -- continuity --paper SPINA-0093 [--json]
  npm run research -- series --paper SPINA-0093 [--control S3] [--sample S4]...
  npm run research -- observe --paper SPINA-0093 --metric h2_evolution_rate
                          [--sample S3 --sample S4] [--table 1] [--map '{"Cat-A":"S3"}']
                          [--no-save] [--version verified|uncertain] [--json]
  npm run research -- disagreement [--paper P] [--file claims.json]
  npm run research -- hypotheses --file hypotheses.json
  npm run research -- structure --file data/structures/x.cif [--formula NiCo2O4]
  npm run research -- computation --file intent.json
  npm run research -- ingest --file research-input.json
  npm run research -- capabilities

共同选项：
  --database <路径>   知识库，默认工作库，只读打开
  --json              机器可读输出
  --no-save           不把分析产物/观察写入 data/research/research.sqlite
  SPINA_RESEARCH_DB   覆盖研究产物数据库路径（测试用）

边界：研究产物与论文事实分开保存；系统假设不会写入制备记录。
身份关联不等于物相确认；样品继承不等于因果关系；计算准备不等于计算完成。`;

async function loadJson(path) {
  return JSON.parse((await readFile(resolve(root, path), 'utf8')).replace(/^\uFEFF/, ''));
}

function saveArtifact(research, input) {
  const artifact = makeArtifact(input);
  research.saveArtifact(artifact);
  return artifact;
}

async function openKnowledge(database) {
  if (database) return ExperimentStore.openReadOnly(resolve(root, database));
  const store = await ExperimentStore.openExisting(root);
  if (!store) throw new Error('工作库不存在：请先蒸馏，或用 --database data/demo/spina.sqlite 只读演示库');
  return store;
}

async function openResearch(readOnly = false) {
  const override = process.env.SPINA_RESEARCH_DB;
  if (readOnly) {
    const path = resolve(root, override ?? 'data/research/research.sqlite');
    try { await access(path); }
    catch (error) { if (error.code === 'ENOENT') return ResearchStore.inMemory(); throw error; }
    return ResearchStore.openFile(path, true);
  }
  if (override) return ResearchStore.openFile(resolve(root, override), false);
  return ResearchStore.open(root);
}

function parseEntity(spec) {
  const [paperId, sampleId, phaseId] = String(spec).split(':');
  if (!paperId || !sampleId) throw new Error(`--entity 需要 <论文ID>:<样品ID>[:相ID]，收到 ${spec}`);
  return { paper_id: paperId, sample_id: sampleId, ...(phaseId ? { phase_id: phaseId } : {}) };
}

function printIdentity(identity, artifact) {
  const composition = identity.composition;
  console.log(`${identity.subject.paper_id} / ${identity.subject.sample_id}${identity.subject.phase_id ? ` / ${identity.subject.phase_id}` : ''} · ${identity.composition_role === 'target' ? '目标相' : identity.composition_role}`);
  console.log(`化学式：${composition.formula || '（未报告）'}（${composition.status}）`);
  console.log(`元素：${composition.elements.join('、') || '—'}；金属：${composition.metals.join('、') || '—'}`);
  if (composition.stoichiometry) console.log(`计量：${Object.entries(composition.stoichiometry).map(([element, count]) => `${element}${count}`).join('')}`);
  if (composition.variables.length) console.log(`变量：${composition.variables.join('、')}${composition.domain ? `；定义域 ${composition.domain.symbol} = ${composition.domain.min}–${composition.domain.max}` : '；未给出定义域'}`);
  if (composition.element_ranges) console.log(`元素范围：${Object.entries(composition.element_ranges).map(([element, range]) => `${element} ${range.min}–${range.max}`).join('；')}`);
  console.log(`结构：${identity.structure.confirmed ? `${identity.structure.family}${identity.structure.subtype ? `/${identity.structure.subtype}` : ''}` : '未确认'}（${identity.structure.note}）`);
  console.log(`样品状态：${identity.material_state}`);
  console.log(`record_ref：${JSON.stringify(identity.record_ref)}`);
  if (identity.unresolved.length) console.log(`未解决：\n${identity.unresolved.map(item => `  · ${item}`).join('\n')}`);
  if (artifact) console.log(`产物：${artifact.artifact_id}`);
}

function printRelation(relation, artifact) {
  const labels = { same: '相同', different: '不同', unknown: '未知', family: '同族', unresolved: '未解决', candidate_match: '候选一致' };
  console.log(`左：${relation.left.subject.paper_id}/${relation.left.subject.sample_id} · ${relation.left.composition.formula}`);
  console.log(`右：${relation.right.subject.paper_id}/${relation.right.subject.sample_id} · ${relation.right.composition.formula}`);
  console.log(table(['层次', '判断'], [
    ['元素集合', labels[relation.layers.element_set]],
    ['计量组成', labels[relation.layers.composition]],
    ['结构身份', labels[relation.layers.structure]],
    ['是否同一样品', relation.layers.specimen === 'same' ? '是' : '否'],
  ]));
  console.log('说明：');
  for (const statement of relation.statements) console.log(`  · ${statement}`);
  if (relation.unresolved.length) console.log(`未解决：\n${relation.unresolved.map(item => `  · ${item}`).join('\n')}`);
  if (artifact) console.log(`产物：${artifact.artifact_id}`);
}

function printLineage(graph, artifact) {
  console.log(`样品谱系：${graph.root}`);
  console.log(table(['样品', '状态', '材料身份', '外部'], graph.specimens.map(node => [
    node.specimen_id, node.material_state,
    node.identity ? `${node.identity.composition.formula || '未报告'} / ${node.identity.structure.confirmed ? node.identity.structure.family : '结构未确认'}` : '未解析',
    node.external ? '是' : '',
  ])));
  if (graph.edges.length) {
    console.log('关系：');
    for (const edge of graph.edges) console.log(`  ${edge.from} → ${edge.to}  ${edge.relation}${edge.basis === 'record_shared_from' ? '（制备继承，不是物理转化）' : ''}`);
  }
  console.log(`观察：${graph.observations.length ? graph.observations.map(item => `${item.specimen_id} ${item.metric}=${item.value}${item.unit ?? ''}`).join('；') : '无绑定观察'}`);
  if (graph.unresolved.length) console.log(`未解决：\n${graph.unresolved.map(item => `  · ${item}`).join('\n')}`);
  if (artifact) console.log(`产物：${artifact.artifact_id}`);
}

function printSeries(contrast, artifact) {
  console.log(`${contrast.paper_id} · 系列对照（对照 ${contrast.control}；样品 ${contrast.series.sample_ids.join('、')}；依据 ${contrast.series.basis}）`);
  for (const item of contrast.contrasts) {
    console.log(`\n对照 ${contrast.control} vs ${item.sample_id}`);
    if (item.varied.length) {
      console.log('  改变：');
      for (const difference of item.varied) console.log(`    ${difference.label}：${truncate(difference.control.value, 40)} → ${truncate(difference.treatment.value, 40)}`);
    } else console.log('  改变：无（已报告字段）');
    console.log(`  保持一致：${item.held_constant.length ? item.held_constant.map(field => field.label).join('、') : '无'}`);
    if (item.unreported.length) console.log(`  未报告：${item.unreported.map(field => field.label).join('、')}`);
    if (item.not_aligned.length) console.log(`  未对齐：${item.not_aligned.map(field => field.label).join('、')}`);
    console.log(`  混杂：${item.confounded ? `是（${item.varied.length} 个变量同时改变）` : '否'}`);
    if (item.observations.length) {
      for (const observation of item.observations) console.log(`  观察 ${observation.metric}：${observation.comparable ? (observation.delta === null ? '可比（非数值）' : `差值 ${observation.delta}`) : '不可比'} — ${observation.reason}`);
    } else console.log('  观察：无绑定结果');
    console.log(`  判断：${item.assessment.status} — ${item.assessment.explanation}`);
  }
  if (contrast.author_claims.length) console.log(`\n作者解释（${contrast.author_claims.length} 条）：${contrast.author_claims.map(claim => claim.statement).join('；')}`);
  if (contrast.unresolved.length) console.log(`未解决：\n${contrast.unresolved.map(item => `  · ${item}`).join('\n')}`);
  if (artifact) console.log(`产物：${artifact.artifact_id}`);
}

function printDisagreement(graph, artifact) {
  if (!graph.topics.length) console.log('没有登记可比较的论断。先用 research ingest 登记带 topic 的论断。');
  for (const topic of graph.topics) {
    console.log(`\n主题：${topic.topic}（${topic.claims.length} 条论断）`);
    for (const claim of topic.claims) console.log(`  ${claim.claim_id} · ${claim.paper_id} · ${CLAIM_KIND_LABELS[claim.kind]} · ${claim.stance}：${truncate(claim.statement, 80)}`);
    for (const pair of topic.pairs) {
      console.log(`  对 ${pair.a} vs ${pair.b} → ${pair.classification}`);
      console.log(`    ${pair.explanation}`);
      if (pair.misaligned.length) console.log(`    未对齐：${pair.misaligned.join('；')}`);
    }
    for (const support of topic.independent_support) console.log(`  独立支持 ${support.claim_id}：${support.count} 个来源家族 — ${support.note}`);
  }
  if (graph.unresolved.length) console.log(`未解决：\n${graph.unresolved.map(item => `  · ${item}`).join('\n')}`);
  if (artifact) console.log(`产物：${artifact.artifact_id}`);
}

function printStructure(structure) {
  console.log(`结构：${structure.path}（${structure.format}，来源 ${structure.source}）`);
  if (structure.lattice) console.log(`晶胞：a=${structure.lattice.a} b=${structure.lattice.b} c=${structure.lattice.c}；α=${structure.lattice.alpha} β=${structure.lattice.beta} γ=${structure.lattice.gamma}`);
  console.log(`位点：${structure.sites.length}；组成：${Object.entries(structure.composition).map(([element, count]) => `${element}${count}`).join('')}`);
  if (structure.expected_formula) console.log(`期望化学式：${structure.expected_formula}；匹配：${structure.composition_match?.status} — ${structure.composition_match?.detail}`);
  if (structure.space_group) console.log(`空间群：${structure.space_group}`);
  console.log(`警告：${structure.warnings.join('；')}`);
  if (structure.unresolved.length) console.log(`未解决：${structure.unresolved.join('；')}`);
}

function printComputation(spec, artifact) {
  console.log(`计算任务：${spec.question}`);
  console.log(`可观测量：${spec.observable}`);
  console.log(`候选结构：${spec.candidates.length ? spec.candidates.map(item => `${item.path}（${item.composition_match?.status ?? '未检查'}）`).join('；') : '无'}`);
  console.log(`需决定：${spec.requires_decision.length ? spec.requires_decision.join('、') : '无（全部已指定）'}`);
  console.log(`已固定：${Object.keys(spec.fixed_parameters).length ? Object.entries(spec.fixed_parameters).map(([key, value]) => `${key}=${value}`).join('；') : '无'}`);
  for (const output of spec.expected_outputs) console.log(`预期输出：${output.quantity} 检验 ${output.tests_hypothesis}${output.discriminating_if ? `（若为 ${output.discriminating_if} 则支持）` : '（缺少预期）'}`);
  if (spec.unresolved.length) console.log(`未解决：\n${spec.unresolved.map(item => `  · ${item}`).join('\n')}`);
  console.log(`警告：${spec.warnings.join('；')}`);
  if (artifact) console.log(`产物：${artifact.artifact_id}`);
}

async function main() {
  const { values, positional } = parseFlags(process.argv.slice(2), {
    booleans: ['json', 'help', 'noSave'],
    repeated: ['entity', 'sample', 'claim'],
  });
  if (values.help) { console.log(usage); return; }
  const command = positional[0];
  if (!command) { console.log(usage); return; }
  if (values.version && !['verified', 'uncertain'].includes(values.version)) throw new Error('--version 必须为 verified 或 uncertain');
  // --sample is repeatable for `series`; single-sample commands take the first value.
  const sampleArg = Array.isArray(values.sample) ? values.sample[0] : values.sample;
  if (command === 'ingest' && values.noSave) throw new Error('ingest 需要写入，不能与 --no-save 同用');
  const research = await openResearch(Boolean(values.noSave) || ['plan','capabilities'].includes(command));
  let knowledge = null;
  try {
    if (command === 'capabilities') {
      const rows = Object.values(CAPABILITIES).map(contract => [contract.name, contract.input_type, contract.output_type, contract.deterministic ? '确定性' : '模型', contract.unsupported_cases.join('；')]);
      if (values.json) { printJson(CAPABILITIES); return; }
      console.log(table(['能力', '输入', '输出', '类型', '明确不支持'], rows));
      return;
    }
    if (command === 'plan') {
      const type = values.type;
      if (!TASK_TYPES.includes(type)) throw new Error(`--type 必须为 ${TASK_TYPES.join('、')}`);
      const refs = (values.paper ? [values.paper] : []).map(paper => ({ paper_id: paper, ...(sampleArg ? { sample_id: sampleArg } : {}) }));
      const plan = planResearchTask({ task_type: type, question: values.question ?? '', subject_refs: refs });
      if (values.json) { printJson(plan); return; }
      console.log(`任务：${TASK_LABELS[type]}（${type}）`);
      console.log(`问题：${plan.task.question || '（未填写）'}`);
      console.log(`就绪：${plan.ready ? '是' : '否'}`);
      console.log(table(['步骤', '能力', '输入 → 输出', '类型'], plan.nodes.map(node => [node.step, node.capability, `${node.input_type} → ${node.output_type}`, node.deterministic ? '确定性' : '模型'])));
      if (plan.model_steps.length) console.log(`模型步骤：${plan.model_steps.map(step => `${step.step}（${step.contract}）`).join('；')}`);
      if (plan.unresolved_inputs.length) console.log(`未满足输入：${plan.unresolved_inputs.join('；')}`);
      console.log(`需要的信息域：${plan.required_facets.join('、')}`);
      return;
    }

    if (command === 'ingest') {
      if (!values.file) throw new Error('ingest 需要 --file research-input.json');
      const input = await loadJson(values.file);
      // Validate the model-authored objects before writing anything, so a bad claim cannot
      // leave a half-ingested file behind.
      const validatedClaims = (input.claims ?? []).map(validateClaim);
      const validatedHypotheses = (input.hypotheses ?? []).map(validateHypothesis);
      const counts = { specimen_relations: 0, observations: 0, claims: 0, hypotheses: 0 };
      if (input.specimen_relations?.length || input.observations?.length) knowledge = await openKnowledge(values.database);
      // Stamp every manual row with the revision and chemistry it was written against, so a later
      // re-distillation can tell "same sample, new revision" from "sample redefined".
      const stamp = (paperId, sampleId) => {
        const resolved = resolveSample(knowledge, paperId, sampleId);
        const sample = resolved.record.draft.samples.find(item => item.local_id === sampleId);
        return {
          version: resolved.version,
          record_ref: { paper_id: paperId, version: resolved.version, revision: resolved.record.revision, verified_at: resolved.record.verified_at },
          fingerprint: sample ? sampleFingerprint(sample) : null,
        };
      };
      research.transaction(() => {
        if (input.specimen_relations?.length) {
          for (const [index, relation] of input.specimen_relations.entries()) {
            if (!SPECIMEN_RELATION_TYPES.includes(relation.relation)) throw new Error(`specimen_relations[${index}].relation 必须为 ${SPECIMEN_RELATION_TYPES.join('、')}`);
            if (!relation.paper_id || !String(relation.from ?? '').includes('::') || !String(relation.to ?? '').includes('::')) throw new Error(`specimen_relations[${index}] 需要 paper_id 与 from/to 样品 ID`);
            if (!String(relation.note ?? '').trim()) throw new Error(`specimen_relations[${index}] 需要 note 说明关系依据`);
            const record = knowledge.getPaper(relation.paper_id);
            if (!record) throw new Error(`specimen_relations[${index}] 的论文不在库中：${relation.paper_id}`);
            for (const id of [relation.from, relation.to]) {
              const local = String(id).split('::')[1];
              if (!local || id !== `${relation.paper_id}::${local}`) throw new Error(`specimen_relations[${index}] 的样品 ID 需要 <论文ID>::<样品ID>：${id}`);
              try { resolveSample(knowledge, relation.paper_id, local); }
              catch { throw new Error(`specimen_relations[${index}] 的样品不在该论文中：${id}`); }
            }
            const fromStamp = stamp(relation.paper_id, String(relation.from).split('::')[1]);
            const toStamp = stamp(relation.paper_id, String(relation.to).split('::')[1]);
            /** @type {import('./research/store.ts').SpecimenRelation} */
            const stored = {
              relation_id: relation.relation_id ?? newId('srel'), paper_id: relation.paper_id,
              from_specimen: relation.from, to_specimen: relation.to, relation: relation.relation,
              evidence: relation.evidence ?? [], note: relation.note,
              record_ref: fromStamp.record_ref,
              fingerprints: { from: fromStamp.fingerprint, to: toStamp.fingerprint },
              created_at: nowIso(),
            };
            research.addSpecimenRelation(stored); counts.specimen_relations++;
          }
        }
        if (input.observations?.length) {

          for (const [index, observation] of input.observations.entries()) {
            if (!observation.paper_id || !observation.sample_id || !observation.metric) throw new Error(`observations[${index}] 需要 paper_id、sample_id、metric`);
            if (observation.value === undefined || observation.value === null) throw new Error(`observations[${index}] 需要 value`);
            try { resolveSample(knowledge, observation.paper_id, observation.sample_id); }
            catch { throw new Error(`observations[${index}] 的论文或样品不在库中：${observation.paper_id} / ${observation.sample_id}`); }
            const sampleStamp = stamp(observation.paper_id, observation.sample_id);
            /** @type {import('./research/store.ts').Observation} */
            const stored = {
              observation_id: observation.observation_id ?? newId('obs'), paper_id: observation.paper_id,
              sample_id: observation.sample_id, metric: String(observation.metric), value: observation.value,
              unit: observation.unit ?? null, method: observation.method ?? null, context: observation.context ?? {},
              evidence: observation.evidence ?? [], provenance: observation.provenance ?? 'source_reported',
              record_ref: sampleStamp.record_ref, sample_fingerprint: sampleStamp.fingerprint, created_at: nowIso(),
            };
            research.addObservation(stored); counts.observations++;
          }
        }
        for (const claim of validatedClaims) { research.addClaim(claim); counts.claims++; }
        for (const hypothesis of validatedHypotheses) { research.addHypothesis(hypothesis); counts.hypotheses++; }
      });
      if (values.json) { printJson(counts); return; }
      console.log(`已登记：关系 ${counts.specimen_relations}；观察 ${counts.observations}；论断 ${counts.claims}；假设 ${counts.hypotheses}`);
      console.log('研究产物写入 data/research/research.sqlite，不修改制备记录。');
      return;
    }

    if (command === 'structure') {
      if (!values.file) throw new Error('structure 需要 --file');
      const structure = await resolveStructureCandidate(root, { path: values.file, expected_formula: values.formula, source: 'user_file' });
      const artifact = values.noSave ? null : saveArtifact(research, {
        kind: 'structure_artifact', provenance: 'deterministic_analysis',
        inputs: values.paper ? [{ paper_id: values.paper, structure_id: structure.structure_id }] : [],
        warnings: structure.warnings, unresolved: structure.unresolved, data: structure,
      });
      if (values.json) { printJson({ structure, artifact }); return; }
      printStructure(structure);
      if (artifact) console.log(`产物：${artifact.artifact_id}`);
      return;
    }

    if (command === 'computation') {
      if (!values.file) throw new Error('computation 需要 --file intent.json');
      const intent = await loadJson(values.file);
      const spec = await prepareComputationSpec(root, intent);
      const artifact = values.noSave ? null : saveArtifact(research, {
        kind: 'computation_spec', provenance: 'deterministic_analysis',
        inputs: intent.paper_id ? [{ paper_id: intent.paper_id }] : [],
        warnings: spec.warnings, unresolved: spec.unresolved, data: spec,
      });
      if (values.json) { printJson({ spec, artifact }); return; }
      printComputation(spec, artifact);
      return;
    }

    if (command === 'hypotheses') {
      if (!values.file) throw new Error('hypotheses 需要 --file hypotheses.json');
      const input = await loadJson(values.file);
      const list = Array.isArray(input) ? input : input.hypotheses;
      if (!Array.isArray(list)) throw new Error('假设文件需要 hypotheses 数组');
      const hypotheses = list.map(validateHypothesis);
      const result = identifyDiscriminatingObservations(hypotheses);
      if (!values.noSave) research.transaction(() => { for (const hypothesis of hypotheses) research.addHypothesis(hypothesis); });
      const artifact = values.noSave ? null : saveArtifact(research, {
        kind: 'hypothesis_set', provenance: 'model_hypothesis',
        inputs: values.paper ? [{ paper_id: values.paper }] : [],
        warnings: ['假设由模型或用户提供；区分性观察为确定性分析，不代表假设成立。'],
        unresolved: result.unresolved, data: { hypotheses, discrimination: result },
      });
      if (values.json) { printJson({ hypotheses, result, artifact }); return; }
      for (const pair of result.pairs) console.log(`${pair.a} vs ${pair.b} → ${pair.verdict}：${pair.explanation}`);
      for (const item of result.per_hypothesis) console.log(`\n${item.hypothesis_id} 的可反驳条件：\n${item.falsifiers.map(line => `  · ${line}`).join('\n')}`);
      if (result.unresolved.length) console.log(`未解决：\n${result.unresolved.map(item => `  · ${item}`).join('\n')}`);
      if (artifact) console.log(`产物：${artifact.artifact_id}`);
      return;
    }

    if (command === 'observe') {
      if (!values.paper) throw new Error('observe 需要 --paper');
      if (!values.metric) throw new Error('observe 需要 --metric，例如 h2_evolution_rate');
      knowledge = await openKnowledge(values.database);
      const resolved = resolveSample(knowledge, values.paper, sampleArg, values.version);
      const sources = resolved.record.sources.map(source => ({ path: source.path, kind: source.kind }));
      if (!sources.length) throw new Error('该记录没有来源文件，无法读取表格');
      let documents;
      try { documents = await readSources(root, sources, undefined, { allowSI: true }); }
      catch (error) { throw new Error(`无法读取原件表格：${error instanceof Error ? error.message : String(error)}。请确认 data/paper 中的 PDF 仍在，并已配置 pdfplumber`); }
      let sampleMap = {};
      if (values.map) {
        try { sampleMap = JSON.parse(values.map); }
        catch { throw new Error('--map 需要 JSON 对象，例如 {"Cat-A":"S3"}'); }
      }
      const extraction = extractTableObservations(resolved.record, documents, {
        metric: values.metric, samples: values.sample, table_index: values.table,
        sample_map: sampleMap, version: resolved.version,
      });
      const saved = [];
      if (!values.noSave) for (const candidate of extraction.candidates) { research.addObservation(toObservation(candidate)); saved.push(candidate.observation_id); }
      const sampleIds = [...new Set(extraction.candidates.map(candidate => candidate.sample_id))];
      const comparison = sampleIds.length >= 2 && !values.noSave
        ? analyzeSampleSeries(resolved.record, resolved.version, research, { samples: sampleIds })
        : null;
      if (values.json) { printJson({ extraction, saved, comparison }); return; }
      console.log(`${resolved.record.paper.paper_id} · 指标 ${extraction.metric}${extraction.metric_label ? `（表头「${extraction.metric_label}」）` : ''}`);
      console.log(`扫描表格 ${extraction.tables_scanned} 个；候选观察 ${extraction.candidates.length} 条；写入 ${saved.length} 条`);
      if (extraction.candidates.length) {
        console.log(table(['样品', '表标签', '数值', '单位', '方法', '测量条件', '置信度'], extraction.candidates.map(candidate => [
          candidate.sample_id, truncate(candidate.matched_label, 18), candidate.value, candidate.unit ?? '—',
          candidate.method ?? '—', Object.entries(candidate.context).map(([key, value]) => `${key}=${value}`).join('；') || '未记录',
          candidate.confidence,
        ])));
        for (const candidate of extraction.candidates.slice(0, 3)) {
          const evidence = candidate.evidence[0];
          console.log(`  依据：${evidence.source_id} p${evidence.page} ${evidence.location ?? ''}「${truncate(evidence.quote, 100)}」`);
        }
      }
      for (const item of extraction.unmatched_labels) console.log(`未匹配：${truncate(item.label.replace(/\s+/g, ' '), 60)}（${item.reason}${item.candidates.length ? `；候选 ${item.candidates.join('、')}` : ''}）`);
      for (const item of extraction.skipped) console.log(`跳过：${item.label} = ${item.value}（${item.reason}）`);
      for (const item of extraction.unresolved) console.log(`注意：${item}`);
      if (comparison) {
        console.log(`\n系列对照（对照 ${comparison.control}）`);
        for (const contrast of comparison.contrasts) {
          for (const observation of contrast.observations) {
            console.log(`  ${contrast.sample_id} · ${observation.metric}：${observation.comparability}${observation.delta === null ? '' : `，差值 ${observation.delta}`}`);
            console.log(`    ${observation.reason}`);
            const evidence = observation.treatment?.evidence?.[0];
            if (evidence) console.log(`    依据：${evidence.source_id} p${evidence.page} ${evidence.location ?? ''}「${truncate(evidence.quote, 100)}」`);
          }
          console.log(`  判断：${contrast.assessment.status} — ${contrast.assessment.explanation}`);
        }
      } else if (sampleIds.length < 2) {
        console.log('\n只匹配到一个样品，未做系列对照。');
      }
      if (values.noSave) console.log('\n未写入观察（--no-save），因此未做系列对照。');
      return;
    }

    if (command === 'disagreement') {
      const claims = values.file
        ? (await loadJson(values.file)).claims?.map(validateClaim) ?? []
        : research.listClaims(values.paper);
      if (!claims.length) throw new Error('没有可比较的论断：请先用 ingest 登记，或用 --file claims.json');
      const graph = explainDisagreement(claims);
      const artifact = values.noSave ? null : saveArtifact(research, {
        kind: 'claim_graph', provenance: 'deterministic_analysis',
        inputs: [...new Set(claims.map(claim => claim.paper_id))].map(paper_id => ({ paper_id })),
        warnings: [], unresolved: graph.unresolved, data: graph,
      });
      if (values.json) { printJson({ graph, artifact }); return; }
      printDisagreement(graph, artifact);
      return;
    }

    knowledge = await openKnowledge(values.database);
    if (command === 'identity') {
      if (!values.paper) throw new Error('identity 需要 --paper');
      const resolved = resolveSample(knowledge, values.paper, sampleArg, values.version);
      if (!resolved.sampleId && resolved.record.draft.samples.length !== 1) throw new Error('identity 需要 --sample（该论文有多个样品）');
      const sampleId = resolved.sampleId ?? resolved.record.draft.samples[0]?.local_id;
      if (!sampleId) throw new Error('该论文没有样品');
      const identity = resolveMaterialIdentity(resolved.record, resolved.version, sampleId, values.phase);
      const artifact = values.noSave ? null : saveArtifact(research, {
        kind: 'material_identity', provenance: 'deterministic_analysis', inputs: [identity.subject],
        warnings: [], unresolved: identity.unresolved, data: identity,
      });
      if (values.json) { printJson({ identity, artifact }); return; }
      printIdentity(identity, artifact);
      return;
    }
    if (command === 'relate') {
      if ((values.entity ?? []).length !== 2) throw new Error('relate 需要两个 --entity 论文ID:样品ID');
      const identities = values.entity.map(spec => {
        const subject = parseEntity(spec);
        const resolved = resolveSample(knowledge, subject.paper_id, subject.sample_id, values.version);
        return resolveMaterialIdentity(resolved.record, resolved.version, subject.sample_id, subject.phase_id);
      });
      const relation = relateMaterials(identities[0], identities[1]);
      const artifact = values.noSave ? null : saveArtifact(research, {
        kind: 'material_relation', provenance: 'deterministic_analysis', inputs: [identities[0].subject, identities[1].subject],
        warnings: [], unresolved: relation.unresolved, data: relation,
      });
      if (values.json) { printJson({ relation, artifact }); return; }
      printRelation(relation, artifact);
      return;
    }
    if (command === 'lineage') {
      if (!values.paper || !sampleArg) throw new Error('lineage 需要 --paper 与 --sample');
      const resolved = resolveSample(knowledge, values.paper, sampleArg, values.version);
      const graph = buildSpecimenLineage(resolved.record, resolved.version, research, sampleArg);
      const artifact = values.noSave ? null : saveArtifact(research, {
        kind: 'specimen_graph', provenance: 'deterministic_analysis',
        inputs: [{ paper_id: values.paper, sample_id: sampleArg }],
        warnings: [], unresolved: graph.unresolved, data: graph,
      });
      if (values.json) { printJson({ graph, artifact }); return; }
      printLineage(graph, artifact);
      return;
    }
    if (command === 'continuity') {
      if (!values.paper) throw new Error('continuity 需要 --paper');
      const resolved = resolveSample(knowledge, values.paper, undefined, values.version);
      const report = checkEvidenceContinuity(resolved.record, resolved.version, research);
      const artifact = values.noSave ? null : saveArtifact(research, {
        kind: 'evidence_continuity', provenance: 'deterministic_analysis',
        inputs: [{ paper_id: values.paper }], warnings: [], unresolved: report.unresolved,
        data: report,
      });
      if (values.json) { printJson({ report, artifact }); return; }
      console.log(`${report.paper_id} · 当前 r${report.current.revision}（${report.current.version}，${report.current.verified_at}）`);
      console.log(`观察 ${report.observations.length} 条：可直接复用 ${report.summary.reusable_observations}；需按当前版本复核 ${report.summary.needs_revalidation}；无法归属 ${report.summary.orphaned}`);
      console.log(`关系 ${report.relations.length} 条：可沿用 ${(report.summary.relations.current ?? 0) + (report.summary.relations.reusable ?? 0)}；需处理 ${report.summary.relations.blocked ?? 0}`);
      if (report.observations.length) {
        console.log(table(['状态', '样品', '指标', '绑定修订', '说明'], report.observations.map(item => [
          item.status, item.sample_id, truncate(item.metric, 20),
          item.record_ref ? `r${item.record_ref.revision}@${item.record_ref.verified_at.slice(0, 10)}` : '未绑定',
          truncate(item.explanation, 60),
        ])));
      }
      if (report.relations.length) {
        console.log(table(['状态', '关系', '起点', '终点', '说明'], report.relations.map(item => [
          item.reusable ? '可沿用' : '需处理', item.relation,
          `${item.from.specimen_id} ${item.from.status}`, `${item.to.specimen_id} ${item.to.status}`,
          truncate(`${item.from.explanation}；${item.to.explanation}`, 70),
        ])));
      }
      for (const item of report.unresolved) console.log(`注意：${item}`);
      console.log(`\n${report.semantics}`);
      if (artifact) console.log(`产物：${artifact.artifact_id}`);
      return;
    }
    if (command === 'series') {
      if (!values.paper) throw new Error('series 需要 --paper');
      const resolved = resolveSample(knowledge, values.paper, values.control, values.version);
      const contrast = analyzeSampleSeries(resolved.record, resolved.version, research, {
        control: values.control, samples: values.sample,
      });
      const artifact = values.noSave ? null : saveArtifact(research, {
        kind: 'study_contrast', provenance: 'deterministic_analysis',
        inputs: [{ paper_id: values.paper }], warnings: [], unresolved: contrast.unresolved, data: contrast,
      });
      if (values.json) { printJson({ contrast, artifact }); return; }
      printSeries(contrast, artifact);
      return;
    }
    throw new Error(`未知子命令：${command}\n\n${usage}`);
  } finally {
    knowledge?.close();
    research.close();
  }
}

try { await main(); }
catch (error) { console.error(`研究命令失败：${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
