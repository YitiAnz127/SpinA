import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { realpathSync as realpath } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Evidence } from '../distillation/schema.ts';
import type { ArtifactKind, ProvenanceKind, ResearchArtifact, SubjectRef } from './contracts.ts';
import type { RecordReference } from '../distillation/store.ts';
import type { SampleFingerprint } from './specimen-identity.ts';

export const SPECIMEN_RELATION_TYPES = ['aliquot_of', 'deposited_on', 'processed_into', 'state_after', 'observes'] as const;
export type SpecimenRelationType = (typeof SPECIMEN_RELATION_TYPES)[number];

export const CLAIM_KINDS = ['author_observation', 'author_interpretation', 'computed_result', 'system_hypothesis'] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];
export const CLAIM_RELATION_TYPES = ['supports', 'contradicts', 'depends_on', 'alternative_to', 'cites'] as const;
export type ClaimRelationType = (typeof CLAIM_RELATION_TYPES)[number];

export interface SpecimenRelation {
  relation_id: string;
  paper_id: string;
  from_specimen: string;
  to_specimen: string;
  relation: SpecimenRelationType;
  evidence: Evidence[];
  note: string;
  /** The record revision that established this relation; null for legacy rows. */
  record_ref?: RecordReference | null;
  /** Chemistry fingerprints of both endpoints, captured when the relation was recorded. */
  fingerprints?: { from: SampleFingerprint | null; to: SampleFingerprint | null } | null;
  created_at: string;
}

export interface Observation {
  observation_id: string;
  paper_id: string;
  sample_id: string;
  metric: string;
  value: string | number;
  unit: string | null;
  method: string | null;
  context: Record<string, string>;
  evidence: Evidence[];
  provenance: ProvenanceKind;
  /** The record revision the observation was read from; null for legacy/manual rows. */
  record_ref?: RecordReference | null;
  /** Chemistry fingerprint of the sample at the time of recording; lets a later revision judge continuity. */
  sample_fingerprint?: SampleFingerprint | null;
  created_at: string;
}

export interface ClaimSupportRef {
  kind: 'observation' | 'claim' | 'evidence';
  id?: string;
  paper_id?: string;
  sample_id?: string;
  field_path?: string;
  quote?: string;
}

export interface ScientificClaim {
  claim_id: string;
  paper_id: string;
  topic: string;
  statement: string;
  kind: ClaimKind;
  stance: 'positive' | 'negative' | 'neutral';
  subject_refs: SubjectRef[];
  scope: { composition?: string; treatment?: string; measurement?: string };
  support_refs: ClaimSupportRef[];
  assumptions: string[];
  counter_refs: ClaimSupportRef[];
  origin_family: string;
  relations: { type: ClaimRelationType; target_claim_id: string }[];
  evidence: Evidence[];
  created_at: string;
}

export interface Hypothesis {
  hypothesis_id: string;
  task_id?: string;
  statement: string;
  explains: string[];
  assumptions: string[];
  predicts: { observable: string; expected: string }[];
  falsifiers: { observation: string; outcome: string }[];
  support: string[];
  counter: string[];
  created_at: string;
}

const json = (value: unknown) => JSON.stringify(value ?? null);
const parse = <T>(value: unknown, fallback: T): T => {
  try { return JSON.parse(String(value)) as T; } catch { return fallback; }
};

/**
 * Research artifacts live in their own database under `data/research/`.
 *
 * Keeping them out of `spina.sqlite` means a research hypothesis can never be mistaken for
 * a paper fact, and a failed analysis cannot damage the preparation knowledge base.
 */
export class ResearchStore {
  private db: DatabaseSync;
  readonly databasePath: string;

  private constructor(databasePath: string, readOnly: boolean) {
    this.databasePath = databasePath;
    this.db = new DatabaseSync(databasePath, { readOnly });
    if (!readOnly) this.db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY, kind TEXT NOT NULL, provenance TEXT NOT NULL,
        task_id TEXT, created_at TEXT NOT NULL, artifact_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS specimen_relations (
        relation_id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, from_specimen TEXT NOT NULL,
        to_specimen TEXT NOT NULL, relation TEXT NOT NULL, evidence_json TEXT,
        note TEXT NOT NULL, record_ref_json TEXT, fingerprints_json TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS observations (
        observation_id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, sample_id TEXT NOT NULL,
        metric TEXT NOT NULL, value_json TEXT NOT NULL, unit TEXT, method TEXT,
        context_json TEXT, evidence_json TEXT, provenance TEXT NOT NULL,
        record_ref_json TEXT, sample_fingerprint_json TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS claims (
        claim_id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, topic TEXT NOT NULL,
        claim_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hypotheses (
        hypothesis_id TEXT PRIMARY KEY, task_id TEXT, statement TEXT NOT NULL,
        hypothesis_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS claims_topic ON claims(topic);
      CREATE INDEX IF NOT EXISTS observations_sample ON observations(paper_id, sample_id);
    `);
    // Lightweight migration for databases created before evidence versioning.
    if (!readOnly) {
      const ensure = (table: string, column: string, definition: string) => {
        const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        if (!columns.some(item => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      };
      ensure('observations', 'record_ref_json', 'TEXT');
      ensure('observations', 'sample_fingerprint_json', 'TEXT');
      ensure('specimen_relations', 'record_ref_json', 'TEXT');
      ensure('specimen_relations', 'fingerprints_json', 'TEXT');
    }
  }

  static inMemory(): ResearchStore { return new ResearchStore(':memory:', false); }

  static async open(root: string): Promise<ResearchStore> {
    const directory = resolve(root, 'data/research');
    await mkdir(directory, { recursive: true });
    return new ResearchStore(resolve(realpath(directory), 'research.sqlite'), false);
  }

  static async openExisting(root: string): Promise<ResearchStore | null> {
    const path = resolve(root, 'data/research/research.sqlite');
    try { return new ResearchStore(realpath(path), true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }

  /** Explicit path, used by tests and by read-only inspection of a copied workspace. */
  static async openFile(databasePath: string, readOnly = false): Promise<ResearchStore> {
    if (!readOnly) await mkdir(dirname(resolve(databasePath)), { recursive: true });
    return new ResearchStore(databasePath, readOnly);
  }

  saveArtifact<T>(artifact: ResearchArtifact<T>): void {
    this.db.prepare(`INSERT INTO artifacts (artifact_id, kind, provenance, task_id, created_at, artifact_json)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(artifact_id) DO UPDATE SET kind=excluded.kind, provenance=excluded.provenance, task_id=excluded.task_id, created_at=excluded.created_at, artifact_json=excluded.artifact_json`)
      .run(artifact.artifact_id, artifact.kind, artifact.provenance, artifact.task_id ?? null, artifact.created_at, JSON.stringify(artifact));
  }

  getArtifact<T = unknown>(artifactId: string): ResearchArtifact<T> | null {
    const row = this.db.prepare('SELECT artifact_json FROM artifacts WHERE artifact_id = ?').get(artifactId) as { artifact_json: string } | undefined;
    return row ? parse<ResearchArtifact<T>>(row.artifact_json, null as unknown as ResearchArtifact<T>) : null;
  }

  listArtifacts<T = unknown>(options: { kind?: ArtifactKind; paperId?: string; limit?: number } = {}): ResearchArtifact<T>[] {
    const rows = this.db.prepare('SELECT artifact_json FROM artifacts ORDER BY created_at DESC').all() as { artifact_json: string }[];
    const artifacts = rows.map(row => parse<ResearchArtifact<T> | null>(row.artifact_json, null)).filter((item): item is ResearchArtifact<T> => Boolean(item));
    return artifacts
      .filter(artifact => !options.kind || artifact.kind === options.kind)
      .filter(artifact => !options.paperId || artifact.inputs.some(ref => ref.paper_id === options.paperId))
      .slice(0, options.limit ?? 200);
  }

  addSpecimenRelation(relation: SpecimenRelation): void {
    this.db.prepare(`INSERT INTO specimen_relations (relation_id, paper_id, from_specimen, to_specimen, relation, evidence_json, note, record_ref_json, fingerprints_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(relation_id) DO UPDATE SET paper_id=excluded.paper_id, from_specimen=excluded.from_specimen, to_specimen=excluded.to_specimen, relation=excluded.relation, evidence_json=excluded.evidence_json, note=excluded.note, record_ref_json=excluded.record_ref_json, fingerprints_json=excluded.fingerprints_json, created_at=excluded.created_at`)
      .run(relation.relation_id, relation.paper_id, relation.from_specimen, relation.to_specimen, relation.relation, json(relation.evidence), relation.note, json(relation.record_ref ?? null), json(relation.fingerprints ?? null), relation.created_at);
  }

  listSpecimenRelations(paperId?: string): SpecimenRelation[] {
    const rows = (paperId
      ? this.db.prepare('SELECT * FROM specimen_relations WHERE paper_id = ? ORDER BY created_at').all(paperId)
      : this.db.prepare('SELECT * FROM specimen_relations ORDER BY created_at').all()) as Record<string, unknown>[];
    return rows.map(row => ({
      relation_id: String(row.relation_id), paper_id: String(row.paper_id),
      from_specimen: String(row.from_specimen), to_specimen: String(row.to_specimen),
      relation: String(row.relation) as SpecimenRelationType,
      evidence: parse<Evidence[]>(row.evidence_json, []), note: String(row.note ?? ''),
      record_ref: parse<RecordReference | null>(row.record_ref_json, null),
      fingerprints: parse<{ from: SampleFingerprint | null; to: SampleFingerprint | null } | null>(row.fingerprints_json, null),
      created_at: String(row.created_at),
    }));
  }

  addObservation(observation: Observation): void {
    if (!['number', 'string'].includes(typeof observation.value) ||
        (typeof observation.value === 'number' ? !Number.isFinite(observation.value) : !observation.value.trim()) ||
        !observation.context || typeof observation.context !== 'object' || Array.isArray(observation.context) ||
        !Object.values(observation.context).every(value => typeof value === 'string')) throw new Error('观察值或测量上下文格式无效');
    this.db.prepare(`INSERT INTO observations (observation_id, paper_id, sample_id, metric, value_json, unit, method, context_json, evidence_json, provenance, record_ref_json, sample_fingerprint_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(observation_id) DO UPDATE SET paper_id=excluded.paper_id, sample_id=excluded.sample_id, metric=excluded.metric, value_json=excluded.value_json, unit=excluded.unit, method=excluded.method, context_json=excluded.context_json, evidence_json=excluded.evidence_json, provenance=excluded.provenance, record_ref_json=excluded.record_ref_json, sample_fingerprint_json=excluded.sample_fingerprint_json, created_at=excluded.created_at`)
      .run(observation.observation_id, observation.paper_id, observation.sample_id, observation.metric, json(observation.value),
        observation.unit, observation.method, json(observation.context), json(observation.evidence), observation.provenance,
        json(observation.record_ref ?? null), json(observation.sample_fingerprint ?? null), observation.created_at);
  }

  listObservations(paperId: string, sampleId?: string): Observation[] {
    const rows = (sampleId
      ? this.db.prepare('SELECT * FROM observations WHERE paper_id = ? AND sample_id = ? ORDER BY metric').all(paperId, sampleId)
      : this.db.prepare('SELECT * FROM observations WHERE paper_id = ? ORDER BY sample_id, metric').all(paperId)) as Record<string, unknown>[];
    return rows.map(row => ({
      observation_id: String(row.observation_id), paper_id: String(row.paper_id), sample_id: String(row.sample_id),
      metric: String(row.metric), value: parse<string | number>(row.value_json, ''), unit: row.unit === null ? null : String(row.unit),
      method: row.method === null ? null : String(row.method), context: parse<Record<string, string>>(row.context_json, {}),
      evidence: parse<Evidence[]>(row.evidence_json, []), provenance: String(row.provenance) as ProvenanceKind,
      record_ref: parse<RecordReference | null>(row.record_ref_json, null),
      sample_fingerprint: parse<SampleFingerprint | null>(row.sample_fingerprint_json, null),
      created_at: String(row.created_at),
    }));
  }

  addClaim(claim: ScientificClaim): void {
    this.db.prepare(`INSERT INTO claims (claim_id, paper_id, topic, claim_json, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(claim_id) DO UPDATE SET paper_id=excluded.paper_id, topic=excluded.topic, claim_json=excluded.claim_json, created_at=excluded.created_at`)
      .run(claim.claim_id, claim.paper_id, claim.topic, JSON.stringify(claim), claim.created_at);
  }

  listClaims(paperId?: string): ScientificClaim[] {
    const rows = (paperId
      ? this.db.prepare('SELECT claim_json FROM claims WHERE paper_id = ? ORDER BY created_at').all(paperId)
      : this.db.prepare('SELECT claim_json FROM claims ORDER BY created_at').all()) as { claim_json: string }[];
    return rows.map(row => parse<ScientificClaim | null>(row.claim_json, null)).filter((item): item is ScientificClaim => Boolean(item));
  }

  addHypothesis(hypothesis: Hypothesis): void {
    this.db.prepare(`INSERT INTO hypotheses (hypothesis_id, task_id, statement, hypothesis_json, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(hypothesis_id) DO UPDATE SET task_id=excluded.task_id, statement=excluded.statement, hypothesis_json=excluded.hypothesis_json, created_at=excluded.created_at`)
      .run(hypothesis.hypothesis_id, hypothesis.task_id ?? null, hypothesis.statement, JSON.stringify(hypothesis), hypothesis.created_at);
  }

  listHypotheses(taskId?: string): Hypothesis[] {
    const rows = (taskId
      ? this.db.prepare('SELECT hypothesis_json FROM hypotheses WHERE task_id = ? ORDER BY created_at').all(taskId)
      : this.db.prepare('SELECT hypothesis_json FROM hypotheses ORDER BY created_at').all()) as { hypothesis_json: string }[];
    return rows.map(row => parse<Hypothesis | null>(row.hypothesis_json, null)).filter((item): item is Hypothesis => Boolean(item));
  }

  counts() {
    const count = (table: string) => {
      try { return (this.db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }).total; }
      catch { return 0; }
    };
    return { artifacts: count('artifacts'), specimen_relations: count('specimen_relations'), observations: count('observations'), claims: count('claims'), hypotheses: count('hypotheses') };
  }

  transaction<T>(write: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = write();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void { this.db.close(); }
}
