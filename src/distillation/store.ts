import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { realpathSync as realpath } from 'node:fs';
import { resolve, relative, sep, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PaperIdentity, Draft, Verification, SourceDocument, Fact } from './schema.ts';
import { deriveMetalElements, preparationVariables } from './schema.ts';

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
}

type DeliveryInput = Pick<PublishedRecord, 'paper' | 'sources' | 'draft' | 'match_entries'> & Partial<Pick<PublishedRecord, 'verification' | 'verification_status' | 'uncertainties' | 'candidate_match_entries'>>;
/** Shared by the reader and verifier so neither silently loses preparation constraints. */
export function deliveryRecord(record: DeliveryInput) {
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
    ...(record.verification_status === 'uncertain' ? { status: 'uncertain', issues: record.uncertainties ?? [] } : {}),
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
      const issues = [...new Set([...sample.unresolved_questions, ...(record.verification?.issues ?? [])
        .filter(issue => issue.resolution_status !== 'resolved' && (issue.sample_local_id === null || issue.sample_local_id === sample.local_id))
        .filter(issue => issue.affects_matching || /(?:^|\.)(?:method|materials|steps)(?:\.|\[|$)/.test(issue.field_path))
        .map(issue => `${issue.field_path}: ${issue.proposed_correction || issue.current_value}`)])];
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
        shared_from: sample.shared_from, pages: [...pages.values()], issues,
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

  getPaper(paperId: string): PublishedRecord | null {
    const row = this.db.prepare('SELECT record_json FROM papers WHERE paper_id = ?').get(paperId) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as PublishedRecord : this.getUncertainPaper(paperId);
  }

  getUncertainPaper(paperId: string): PublishedRecord | null {
    if (!this.hasUncertainTable) return null;
    const row = this.db.prepare('SELECT record_json FROM uncertain_papers WHERE paper_id = ?').get(paperId) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as PublishedRecord : null;
  }

  searchByElements(metals: string[], includeUncertain = true, limit = 20) {
    const key = [...new Set(metals)].sort().join('|');
    if (!metals.length || deriveMetalElements([...new Set(metals)].sort().join(''))?.join('|') !== key) throw new Error('请提供有效的金属元素符号集合');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit 必须为 1–100');
    const rows = this.db.prepare('SELECT record_json FROM papers ORDER BY paper_id').all() as { record_json: string }[];
    if (includeUncertain && this.hasUncertainTable) rows.push(...this.db.prepare('SELECT record_json FROM uncertain_papers ORDER BY paper_id').all() as { record_json: string }[]);
    const results = [];
    for (const row of rows) {
      const record = JSON.parse(row.record_json) as PublishedRecord;
      const unresolved = record.verification.issues.filter(issue => issue.resolution_status !== 'resolved');
      const issueText = (issue: Verification['issues'][number]) => `${issue.field_path}: ${issue.proposed_correction || issue.current_value}`;
      const knownIssueMessages = new Set(unresolved.map(issueText));
      const paperIssues = (record.uncertainties ?? []).filter(message => !knownIssueMessages.has(message));
      const seen = new Set<string>();
      const entries = [...record.match_entries.map(entry => ({ ...entry, possible: false })), ...(includeUncertain ? (record.candidate_match_entries ?? []).map(entry => ({ ...entry, possible: true })) : [])];
      for (const entry of entries) {
        const identity = `${entry.sample_local_id}:${entry.phase_local_id}`;
        if (entry.element_key !== key || seen.has(identity)) continue;
        seen.add(identity);
        const scope = new Set<string>();
        let sample = record.draft.samples.find(sample => sample.local_id === entry.sample_local_id);
        while (sample && !scope.has(sample.local_id)) {
          scope.add(sample.local_id);
          sample = record.draft.samples.find(parent => parent.local_id === sample!.shared_from);
        }
        const issues = [...new Set([
          ...record.draft.samples.filter(sample => scope.has(sample.local_id)).flatMap(sample => sample.unresolved_questions),
          ...unresolved.filter(issue => issue.sample_local_id === null || scope.has(issue.sample_local_id)).map(issueText),
        ])];
        results.push({ paper: record.paper, sample_id: entry.sample_local_id, phase_id: entry.phase_local_id,
          sample: record.draft.samples.find(sample => sample.local_id === entry.sample_local_id)?.name,
          metal_elements: entry.metal_elements, certainty: record.verification_status ?? 'verified', possible: entry.possible,
          ...(record.verification_status === 'uncertain' ? { issues, ...(paperIssues.length ? { paper_issues: paperIssues } : {}) } : {}),
        });
        if (results.length >= limit) return results;
      }
    }
    return results;
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

  publish(record: PublishedRecord, expectedRevision: number): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getPaper(record.paper.paper_id);
      if ((current?.revision ?? 0) !== expectedRevision) throw new Error('该论文已被另一个任务更新，请重新蒸馏当前版本');
      if (record.verification_status === 'uncertain') {
        this.db.prepare('INSERT INTO uncertain_papers (paper_id, record_json) VALUES (?, ?) ON CONFLICT(paper_id) DO UPDATE SET record_json=excluded.record_json').run(record.paper.paper_id, JSON.stringify(record));
        this.db.exec('COMMIT');
        return;
      }
      this.db.prepare('INSERT INTO papers (paper_id, doi, title, revision, verified_at, record_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(paper_id) DO UPDATE SET doi=excluded.doi, title=excluded.title, revision=excluded.revision, verified_at=excluded.verified_at, record_json=excluded.record_json')
        .run(record.paper.paper_id, record.paper.doi, record.paper.title, record.revision, record.verified_at, JSON.stringify(record));
      this.db.prepare('DELETE FROM uncertain_papers WHERE paper_id = ?').run(record.paper.paper_id);
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
