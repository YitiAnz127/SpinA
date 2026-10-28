import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { realpathSync as realpath } from 'node:fs';
import { resolve, relative, sep, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PaperIdentity, Draft, Verification, SourceDocument, Fact } from './schema.ts';
import { deriveMetalElements, preparationVariables } from './schema.ts';
import { isExtractionIssue, isSourceLimitationIssue, issueText, missingInformation, sourceLimitations, sourceInformationMessages, type MissingInformation } from './missing-information.ts';
import type { ErrorKind } from '../errors.ts';

export interface PublishedRecord {
  schema_version: 1;
  paper: PaperIdentity;
  revision: number;
  verified_at: string;
  verified_by: string;
  distilled_by?: string;
  verification_status?: 'verified' | 'uncertain';
  uncertainties?: string[];
  repair_rounds?: number;
  sources: { id: string; path: string; kind: 'body' | 'si'; page_count: number; empty_text_pages: number[]; page_images?: { number: number; path: string }[]; page_extraction?: { number: number; method: string; table_count: number; warnings: string[] }[] }[];
  draft: Draft;
  verification: Verification;
  match_entries: { sample_local_id: string; phase_local_id: string; metal_elements: string[]; element_key: string; material_state: string }[];
  candidate_match_entries?: PublishedRecord['match_entries'];
}
export interface RunState {
  run_id: string;
  paper_id: string;
  status: 'running' | 'published' | 'published_uncertain' | 'needs_review' | 'skipped' | 'failed' | 'cancelled';
  stage: string;
  started_at: string;
  updated_at: string;
  message: string;
  error_kind?: ErrorKind;
}

export interface RecordReference {
  paper_id: string;
  version: 'verified' | 'uncertain';
  revision: number;
  verified_at: string;
}
/** Exact snapshots of both stored versions, including index-only changes with unchanged revision/time. */
export interface PaperState {
  paper_id: string;
  verified: string | null;
  uncertain: string | null;
}
export interface ExperimentSearchOptions {
  includeUncertain?: boolean;
  limit?: number;
  offset?: number;
  match?: 'exact' | 'superset';
}
interface ExperimentSearchResult {
  paper: PaperIdentity;
  record_ref: RecordReference;
  sample_id: string;
  phase_id: string;
  sample?: string;
  metal_elements: string[];
  certainty: 'verified' | 'uncertain';
  possible: boolean;
  method_summary?: { text: string | null; status: Fact['status']; source_sample_id: string; note?: string };
  missing_information?: MissingInformation[];
  source_limitations?: MissingInformation[];
  issues?: string[];
  notes?: string[];
  review_notes?: string[];
}

type DeliveryInput = Pick<PublishedRecord, 'paper' | 'sources' | 'draft' | 'match_entries'> & Partial<Pick<PublishedRecord, 'verification' | 'verification_status' | 'uncertainties' | 'candidate_match_entries'>>;
/** Shared by the reader and verifier so neither silently loses preparation constraints. */
export function deliveryRecord(record: DeliveryInput) {
  const sourceMessages = sourceInformationMessages(record);
  const knownIssues = new Set((record.verification?.issues ?? []).map(issueText));
  const reviewNotes = [...new Set([
    ...(record.uncertainties ?? []).filter(message => !sourceMessages.has(message) && !knownIssues.has(message)),
    ...(record.verification?.issues ?? []).filter(issue => issue.resolution_status === 'unresolved' && !isExtractionIssue(issue) && !isSourceLimitationIssue(issue)).map(issueText),
  ])];
  const value = (fact: Fact, keepNote = false) => {
    if (fact.status === 'not_reported') return keepNote ? { status: fact.status, ...(fact.note ? { note: fact.note } : {}) } : undefined;
    const raw = fact.raw ?? fact.value;
    const display = fact.unit && typeof raw === 'string' && !raw.replace(/\s/g, '').includes(fact.unit.replace(/\s/g, '')) ? `${raw} ${fact.unit}` : raw;
    if (fact.status === 'reported') return keepNote && fact.note ? { value: display, note: fact.note } : display;
    return { value: display, status: fact.status, ...(fact.note ? { note: fact.note } : {}) };
  };
  const nonempty = (object: Record<string, unknown>): unknown => Object.fromEntries(Object.entries(object).filter(([, item]) => item !== undefined && item !== null && !(Array.isArray(item) && !item.length)));
  const relevant = new Set(record.draft.samples.filter(sample => sample.phases.some(phase => phase.role === 'target_spinel')).map(sample => sample.local_id));
  for (const id of relevant) {
    const parent = record.draft.samples.find(sample => sample.local_id === id)?.shared_from;
    if (parent) relevant.add(parent);
  }
  return {
    paper: record.paper,
    ...(record.verification_status === 'uncertain' ? { status: 'uncertain',
      issues: (record.verification?.issues ?? []).filter(isExtractionIssue).map(issueText) } : {}),
    ...(reviewNotes.length ? { review_notes: reviewNotes } : {}),
    sources: record.sources.map(source => ({ id: source.id, path: source.path })),
    samples: record.draft.samples.filter(sample => relevant.has(sample.local_id)).map(sample => {
      const pages = new Map<string, { source: string; page: number }>();
      const collect = (entry: unknown): void => {
        if (Array.isArray(entry)) { entry.forEach(collect); return; }
        if (!entry || typeof entry !== 'object') return;
        const object = entry as Record<string, unknown>;
        if ('raw' in object) {
          for (const ref of (entry as Fact).evidence) pages.set(`${ref.source_id}:${ref.page}`, { source: ref.source_id, page: ref.page });
        } else Object.values(object).forEach(collect);
      };
      const variables = preparationVariables(sample);
      collect([sample.phases, sample.method, sample.materials, sample.steps, variables]);
      const gaps = missingInformation(record, new Set([sample.local_id]));
      const scope = new Set([sample.local_id]);
      const limitations = sourceLimitations(record, scope);
      const scopedSourceMessages = sourceInformationMessages(record, scope);
      const issues = [...new Set((record.verification?.issues ?? [])
        .filter(issue => isExtractionIssue(issue) && (issue.sample_local_id === null || scope.has(issue.sample_local_id)))
        .map(issueText))];
      const notes = sample.unresolved_questions.filter(message => !scopedSourceMessages.has(message) && !issues.includes(message));
      return nonempty({
        id: sample.local_id, name: sample.name,
        state: sample.material_state === 'as_prepared' ? undefined : sample.material_state,
        variables: variables.map(variable => ({ name: variable.name, value: value(variable.fact, true) })),
        phases: sample.phases.map(phase => nonempty({
          id: phase.local_id, role: phase.role === 'target_spinel' ? undefined : phase.role,
          formula: value(phase.formula, true), identity: value(phase.identity, true),
          metals: record.match_entries.find(entry => entry.sample_local_id === sample.local_id && entry.phase_local_id === phase.local_id)?.metal_elements,
          possible_metals: record.candidate_match_entries?.find(entry => entry.sample_local_id === sample.local_id && entry.phase_local_id === phase.local_id)?.metal_elements,
        })),
        method: sample.method.status === 'not_reported' ? undefined : value(sample.method, true),
        materials: sample.materials.map(material => nonempty({ id: material.local_id, name: value(material.identity, true), amount: value(material.amount, true), concentration: value(material.concentration, true) })),
        steps: sample.steps.map(step => nonempty({
          operation: value(step.operation, true), inputs: step.material_refs,
          text: step.description.raw && step.description.raw !== step.operation.raw ? value(step.description, true) : undefined,
          conditions: step.conditions.map(condition => nonempty({ name: condition.name, value: value(condition.fact, true) })),
        })),
        shared_from: sample.shared_from, pages: [...pages.values()], missing_information: gaps,
        source_limitations: limitations, issues, notes,
      });
    }),
  };
}

/** Only structured experiments enter SQLite. PDF text stays in its source files. */
export class ExperimentStore {
  private db: DatabaseSync;
  private root: string;
  private runsDirectory: string;
  private hasUncertainTable: boolean;

  private constructor(root: string, directory: string, readOnly = false) {
    this.root = root;
    this.runsDirectory = resolve(directory, 'runs');
    this.db = new DatabaseSync(resolve(directory, 'spina.sqlite'), { readOnly });
    if (!readOnly) this.db.exec(`
      CREATE TABLE IF NOT EXISTS papers (
        paper_id TEXT PRIMARY KEY, doi TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
        revision INTEGER NOT NULL, verified_at TEXT NOT NULL, record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, state_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS uncertain_papers (
        paper_id TEXT PRIMARY KEY, record_json TEXT NOT NULL
      );
    `);
    this.hasUncertainTable = Boolean(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='uncertain_papers'").get());
  }

  static async open(root: string): Promise<ExperimentStore> {
    root = await realpath(root);
    const data = resolve(root, 'data');
    await mkdir(data, { recursive: true });
    assertWithin(root, realpath(data));
    const directory = resolve(root, 'data/distillation');
    await mkdir(directory, { recursive: true });
    const actual = await realpath(directory);
    assertWithin(root, actual);
    await mkdir(resolve(actual, 'runs'), { recursive: true });
    assertWithin(root, realpath(resolve(actual, 'runs')));
    try { assertWithin(root, realpath(resolve(actual, 'spina.sqlite'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return new ExperimentStore(root, actual);
  }

  static async openExisting(root: string): Promise<ExperimentStore | null> {
    root = realpath(root);
    const directory = resolve(root, 'data/distillation');
    try { assertWithin(root, realpath(resolve(directory, 'spina.sqlite'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    return new ExperimentStore(root, directory, true);
  }

  getPaper(paperId: string, version: 'preferred' | RecordReference['version'] = 'preferred'): PublishedRecord | null {
    if (version === 'uncertain') return this.getUncertainPaper(paperId);
    const row = this.db.prepare('SELECT record_json FROM papers WHERE paper_id = ?').get(paperId) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as PublishedRecord : version === 'preferred' ? this.getUncertainPaper(paperId) : null;
  }

  getReferencedPaper(ref: RecordReference): PublishedRecord {
    const record = this.getPaper(ref.paper_id, ref.version);
    if (!record || record.revision !== ref.revision || record.verified_at !== ref.verified_at) {
      throw new Error('检索版本已更新或不可用，请重新检索后展开；不会自动读取其他版本');
    }
    return record;
  }

  getUncertainPaper(paperId: string): PublishedRecord | null {
    if (!this.hasUncertainTable) return null;
    const row = this.db.prepare('SELECT record_json FROM uncertain_papers WHERE paper_id = ?').get(paperId) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as PublishedRecord : null;
  }

  getPaperState(paperId: string): PaperState {
    const query = "SELECT 'verified' AS version, record_json FROM papers WHERE paper_id = ?" +
      (this.hasUncertainTable ? " UNION ALL SELECT 'uncertain' AS version, record_json FROM uncertain_papers WHERE paper_id = ?" : '');
    const rows = this.db.prepare(query).all(...(this.hasUncertainTable ? [paperId, paperId] : [paperId])) as { version: 'verified' | 'uncertain'; record_json: string }[];
    const state: PaperState = { paper_id: paperId, verified: null, uncertain: null };
    for (const row of rows) state[row.version] = row.record_json;
    return state;
  }

  searchByElements(metals: string[], options: ExperimentSearchOptions = {}) {
    const { includeUncertain = true, limit = 20, offset = 0, match = 'exact' } = options;
    const elements = [...new Set(metals)].sort();
    const key = elements.join('|');
    if (!metals.length || deriveMetalElements([...new Set(metals)].sort().join(''))?.join('|') !== key) throw new Error('请提供有效的金属元素符号集合');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit 必须为 1–100');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset 必须为非负安全整数');
    if (match !== 'exact' && match !== 'superset') throw new Error('match 必须为 exact 或 superset');
    const rows = this.db.prepare("SELECT record_json, 'verified' AS version FROM papers ORDER BY paper_id").all() as { record_json: string; version: RecordReference['version'] }[];
    if (includeUncertain && this.hasUncertainTable) rows.push(...this.db.prepare("SELECT record_json, 'uncertain' AS version FROM uncertain_papers ORDER BY paper_id").all() as typeof rows);
    const exact: ExperimentSearchResult[] = [], related: ExperimentSearchResult[] = [];
    for (const row of rows) {
      const record = JSON.parse(row.record_json) as PublishedRecord;
      const unresolved = record.verification.issues.filter(issue => issue.resolution_status !== 'resolved');
      const sourceMessages = sourceInformationMessages(record);
      const knownIssueMessages = new Set(unresolved.map(issueText));
      const reviewNotes = (record.uncertainties ?? []).filter(message => !knownIssueMessages.has(message) && !sourceMessages.has(message));
      const seen = new Set<string>();
      const entries = [...record.match_entries.map(entry => ({ ...entry, possible: false })), ...(includeUncertain ? (record.candidate_match_entries ?? []).map(entry => ({ ...entry, possible: true })) : [])];
      for (const entry of entries) {
        const identity = `${entry.sample_local_id}:${entry.phase_local_id}`;
        const isExact = entry.element_key === key;
        const isRelated = entry.metal_elements.length > elements.length && elements.every(element => entry.metal_elements.includes(element));
        if ((!isExact && !isRelated) || seen.has(identity)) continue;
        seen.add(identity);
        const scope = new Set<string>();
        let sample = record.draft.samples.find(sample => sample.local_id === entry.sample_local_id);
        let methodSummary: ExperimentSearchResult['method_summary'];
        while (sample && !scope.has(sample.local_id)) {
          scope.add(sample.local_id);
          const method = sample.method;
          if (!methodSummary && (method.status !== 'not_reported' || method.raw || method.value !== null || method.note)) {
            methodSummary = { text: method.raw ?? (typeof method.value === 'string' ? method.value : null),
              status: method.status, source_sample_id: sample.local_id, ...(method.note ? { note: method.note } : {}) };
          }
          sample = record.draft.samples.find(parent => parent.local_id === sample!.shared_from);
        }
        const scopedSourceMessages = sourceInformationMessages(record, scope);
        const issues = [...new Set(unresolved.filter(issue => isExtractionIssue(issue) && (issue.sample_local_id === null || scope.has(issue.sample_local_id))).map(issueText))];
        const notes = [...new Set(record.draft.samples.filter(sample => scope.has(sample.local_id))
          .flatMap(sample => sample.unresolved_questions).filter(message => !scopedSourceMessages.has(message) && !issues.includes(message)))];
        const gaps = missingInformation(record, scope);
        const limitations = sourceLimitations(record, scope);
        const scopedReviewNotes = [...new Set([...reviewNotes,
          ...unresolved.filter(issue => !isExtractionIssue(issue) && !isSourceLimitationIssue(issue) && (issue.sample_local_id === null || scope.has(issue.sample_local_id))).map(issueText),
        ])];
        (isExact ? exact : related).push({ paper: record.paper,
          record_ref: { paper_id: record.paper.paper_id, version: row.version, revision: record.revision, verified_at: record.verified_at },
          sample_id: entry.sample_local_id, phase_id: entry.phase_local_id,
          sample: record.draft.samples.find(sample => sample.local_id === entry.sample_local_id)?.name,
          metal_elements: entry.metal_elements, certainty: row.version, possible: entry.possible,
          ...(methodSummary ? { method_summary: methodSummary } : {}),
          ...(gaps.length ? { missing_information: gaps } : {}),
          ...(limitations.length ? { source_limitations: limitations } : {}),
          ...(issues.length ? { issues } : {}),
          ...(notes.length ? { notes } : {}),
          ...(scopedReviewNotes.length ? { review_notes: scopedReviewNotes } : {}),
        });
      }
    }
    const compare = (a: ExperimentSearchResult, b: ExperimentSearchResult) =>
      a.paper.paper_id.localeCompare(b.paper.paper_id) ||
      Number(a.certainty === 'uncertain') - Number(b.certainty === 'uncertain') ||
      a.sample_id.localeCompare(b.sample_id) || a.phase_id.localeCompare(b.phase_id);
    exact.sort(compare); related.sort(compare);
    const matches = match === 'exact' ? exact : related;
    const results = matches.slice(offset, offset + limit);
    const next = offset + results.length;
    const sets = new Map<string, { metal_elements: string[]; total: number }>();
    for (const row of related) {
      const key = [...row.metal_elements].sort().join('|');
      const group = sets.get(key) ?? { metal_elements: [...row.metal_elements].sort(), total: 0 };
      group.total++; sets.set(key, group);
    }
    return {
      metal_elements: elements, match, total: matches.length, offset, limit,
      has_more: next < matches.length, next_offset: next < matches.length ? next : null, results,
      related: { total: related.length, uncertain: related.filter(row => row.certainty === 'uncertain').length,
        possible: related.filter(row => row.possible).length,
        metal_sets: [...sets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => group) },
    };
  }

  createRun(paperId: string): RunState {
    const now = new Date().toISOString();
    const run: RunState = { run_id: randomUUID(), paper_id: paperId, status: 'running', stage: 'preparing', started_at: now, updated_at: now, message: '' };
    this.saveRun(run);
    return run;
  }

  saveRun(run: RunState): void {
    run.updated_at = new Date().toISOString();
    this.db.prepare('INSERT INTO runs (run_id, paper_id, state_json) VALUES (?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET state_json = excluded.state_json')
      .run(run.run_id, run.paper_id, JSON.stringify(run));
  }

  getRun(runId: string): RunState | null {
    const row = this.db.prepare('SELECT state_json FROM runs WHERE run_id = ?').get(runId) as { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) as RunState : null;
  }

  async saveArtifact(run: RunState, name: string, value: unknown): Promise<void> {
    if (!/^[a-f0-9-]{36}$/.test(run.run_id)) throw new Error('无效的运行 ID');
    if (!/^[a-z0-9_-]+\.json$/.test(name)) throw new Error('无效的运行产物名称');
    assertWithin(this.root, realpath(this.runsDirectory));
    const directory = resolve(this.runsDirectory, run.run_id);
    await mkdir(directory, { recursive: true });
    const actual = await realpath(directory);
    assertWithin(this.root, actual);
    const destination = resolve(actual, name);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, destination);
  }

  publish(record: PublishedRecord, expected: PaperState, completedRun?: RunState): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getPaperState(record.paper.paper_id);
      if (expected?.paper_id !== current.paper_id || current.verified !== expected.verified || current.uncertain !== expected.uncertain) throw new Error('该论文已被另一个任务更新，请重新蒸馏当前版本');
      if (completedRun) {
        const active = this.getRun(completedRun.run_id);
        const expectedStatus = record.verification_status === 'uncertain' ? 'published_uncertain' : 'published';
        if (!active || active.status !== 'running' || active.paper_id !== record.paper.paper_id || completedRun.paper_id !== record.paper.paper_id || completedRun.status !== expectedStatus) throw new Error('发布任务与论文或终态不一致');
      }
      if (record.verification_status === 'uncertain') {
        this.db.prepare('INSERT INTO uncertain_papers (paper_id, record_json) VALUES (?, ?) ON CONFLICT(paper_id) DO UPDATE SET record_json=excluded.record_json').run(record.paper.paper_id, JSON.stringify(record));
      } else {
        this.db.prepare('INSERT INTO papers (paper_id, doi, title, revision, verified_at, record_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(paper_id) DO UPDATE SET doi=excluded.doi, title=excluded.title, revision=excluded.revision, verified_at=excluded.verified_at, record_json=excluded.record_json')
          .run(record.paper.paper_id, record.paper.doi, record.paper.title, record.revision, record.verified_at, JSON.stringify(record));
        this.db.prepare('DELETE FROM uncertain_papers WHERE paper_id = ?').run(record.paper.paper_id);
      }
      if (completedRun) this.saveRun(completedRun);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void { this.db.close(); }
}

function assertWithin(root: string, path: string): void {
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('输出目录不能指向项目外部');
}

export function sourceManifest(sources: SourceDocument[]): PublishedRecord['sources'] {
  return sources.map(source => ({
    id: source.id, path: source.path, kind: source.kind, page_count: source.pages.length,
    empty_text_pages: source.pages.filter(page => !page.text.trim()).map(page => page.number),
    ...(source.pages.some(page => page.image_path) ? { page_images: source.pages.filter(page => page.image_path).map(page => ({ number: page.number, path: page.image_path! })) } : {}),
    ...(source.pages.some(page => page.extraction_method) ? { page_extraction: source.pages.map(page => ({ number: page.number, method: page.extraction_method ?? 'pdfjs', table_count: page.tables?.length ?? 0, warnings: page.warnings ?? [] })) } : {}),
  }));
}
