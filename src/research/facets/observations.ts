import type { PublishedRecord, RecordReference } from '../../distillation/store.ts';
import type { Evidence, SourceDocument } from '../../distillation/schema.ts';
import type { Observation } from '../store.ts';
import { newId, nowIso } from '../contracts.ts';
import { sampleFingerprint, type SampleFingerprint } from '../specimen-identity.ts';

/**
 * Observation facet: read one metric from a paper's tables and bind it to record samples.
 *
 * This is deliberately deterministic and table-first: the number, unit and sample label come
 * from a real table row, not from a model's memory. Context (light source, sacrificial agent,
 * method) is read from the page text; when it is absent it stays absent and the comparison
 * reports that the measurement context is unknown.
 */

export const METRIC_GROUPS: Record<string, string[]> = {
  h2_evolution_rate: ['h2 evolution rate', 'hydrogen evolution rate', 'h2 production rate', 'hydrogen production rate', 'h2 generation rate', '产氢速率', '析氢速率', '光催化产氢速率'],
  oer_overpotential: ['overpotential', '过电位', 'η10', 'eta10'],
  specific_capacitance: ['specific capacitance', '比电容'],
  degradation_rate_constant: ['degradation rate constant', 'rate constant', 'kapp', '降解速率常数'],
  conversion: ['conversion', '转化率'],
};

const normalize = (value: unknown) => String(value ?? '').normalize('NFKC').toLowerCase()
  .replace(/[−–—]/g, '-').replace(/[µμ]/g, 'u').replace(/\s+/g, ' ').trim();
const normalizeLabel = (value: unknown) => normalize(value).replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
const truncate = (value: string, max: number) => value.length <= max ? value : `${value.slice(0, max - 1)}…`;

export function resolveMetric(metric: string): { key: string; aliases: string[]; label: string } {
  const key = metric.trim();
  const aliases = METRIC_GROUPS[key] ?? [key];
  return { key, aliases, label: key };
}

function unitFromHeader(header: string): string | null {
  const groups = [...String(header).matchAll(/[\(\[（【]([^\)\]）】]+)[\)\]）】]/g)].map(match => match[1]);
  const unit = groups.find(group => /[\/]|g-?1|h-?1|%|m2|mv|ma/.test(normalize(group))) ?? groups.at(-1);
  if (!unit) return null;
  const normalized = normalize(unit).replace(/·/g, ' ').replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim()
    .replace(/\bmv\b/g, 'mV').replace(/\bma\b/g, 'mA');
  return normalized || null;
}

function parseCellValue(cell: string | null): { value: number; note: string } | null {
  const text = String(cell ?? '').trim();
  if (!text) return null;
  if (/^(n\.?\s*r\.?|n\/?a|[-–—]|—|\/|not reported|未报告)$/i.test(text)) return null;
  const cleaned = text.replace(/,/g, '').replace(/\s*±\s*[\d.]+/g, '').replace(/^(~|约|about|ca\.)\s*/i, '');
  const scientific = /([\d.]+)\s*[×x]\s*10\s*\^?\s*([+-]?\d+)/i.exec(cleaned);
  if (scientific) return { value: Number(scientific[1]) * 10 ** Number(scientific[2]), note: 'scientific_notation' };
  const match = /[-+]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(cleaned);
  if (!match) return null;
  const value = Number(match[0]);
  if (!Number.isFinite(value)) return null;
  return { value, note: /±/.test(text) ? 'uncertainty_dropped' : '' };
}

interface SampleMatch {
  sampleId?: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  candidates: string[];
}

function matchSample(label: string, record: PublishedRecord, sampleMap: Record<string, string>): SampleMatch {
  const samples = record.draft.samples;
  const mapped = sampleMap[label] ?? sampleMap[normalizeLabel(label)];
  if (mapped) {
    return samples.some(sample => sample.local_id === mapped)
      ? { sampleId: mapped, confidence: 'high', reason: '手动映射', candidates: [] }
      : { confidence: 'low', reason: `手动映射指向不存在的样品 ${mapped}`, candidates: samples.map(sample => sample.local_id) };
  }
  const key = normalizeLabel(label);
  if (!key) return { confidence: 'low', reason: '空标签', candidates: [] };
  const exact = samples.filter(sample => [sample.local_id, sample.name, ...(sample.aliases ?? [])].some(value => normalizeLabel(value) === key));
  if (exact.length === 1) return { sampleId: exact[0].local_id, confidence: 'high', reason: '标签完全匹配', candidates: [] };
  if (exact.length > 1) return { confidence: 'low', reason: '多个样品标签相同', candidates: exact.map(sample => sample.local_id) };
  const contains = samples.filter(sample => [sample.local_id, sample.name].some(value => {
    const candidate = normalizeLabel(value);
    if (!candidate || Math.min(candidate.length, key.length) < 2) return false;
    return candidate.includes(key) || key.includes(candidate);
  }));
  if (contains.length === 1) return { sampleId: contains[0].local_id, confidence: 'medium', reason: '标签包含匹配，需复核', candidates: [] };
  return { confidence: 'low', reason: '没有匹配到记录样品', candidates: samples.map(sample => sample.local_id).slice(0, 8) };
}

function contextFromText(text: string): Record<string, string> {
  const context: Record<string, string> = {};
  const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
  const light = /(\d{2,4})\s*w\s*(?:xe|xenon|hg|halogen)\s*lamp/i.exec(text)
    ?? /(am\s*1\.5g)/i.exec(text) ?? /(λ\s*[>≥]\s*\d{3}\s*nm)/i.exec(text);
  if (light) context.light_source = light[0].trim();
  const sacrificial = /(teoa|triethanolamine|methanol|ethanol|na2s|na2so3|lactic acid|乳酸|三乙醇胺|甲醇|乙醇)/i.exec(text);
  if (sacrificial) context.sacrificial_agent = sacrificial[0].trim();
  const electrolyte = /(\d+(?:\.\d+)?\s*m\s*(?:naoh|koh|h2so4|hcl|na2so4|nahco3)|(?:naoh|koh)\s*solution)/i.exec(text);
  if (electrolyte) context.electrolyte = clean(electrolyte[0]);
  const cocatalyst = /((?:pt|au|ag|nio|coox|cop|mos2)\s*(?:loading|deposited|photodeposited|cocatalyst)|\d+(?:\.\d+)?\s*wt%\s*(?:pt|au|ag))/i.exec(text);
  if (cocatalyst) context.cocatalyst = clean(cocatalyst[0]);
  const method = /(photocatalytic|photocatalysis|electrocatalytic|electrocatalysis|光催化|电催化)/i.exec(text);
  if (method) context.method = clean(method[0]);
  return context;
}

function extractContext(document: SourceDocument, pageNumber: number, aliases: string[]) {
  const page = document.pages.find(item => item.number === pageNumber) ?? document.pages[0];
  if (!page) return { context: {}, evidence: [] as Evidence[] };
  const sentences = page.text.split(/(?<=[.!?。！？])\s+|\n+/).map(item => item.trim()).filter(Boolean);
  const relevant = sentences.filter(sentence => aliases.some(alias => normalize(sentence).includes(normalize(alias)))
    || /photocatal|光催化|electrocatal|电催化/i.test(sentence));
  const context: Record<string, string> = {};
  for (const sentence of relevant) Object.assign(context, contextFromText(sentence));
  const evidence: Evidence[] = relevant.slice(0, 2).map(sentence => ({
    source_id: document.id, page: page.number, quote: truncate(sentence, 300), basis: 'page_text',
  }));
  return { context, evidence };
}

export interface ObservationCandidate {
  observation_id: string;
  paper_id: string;
  sample_id: string;
  metric: string;
  metric_label: string;
  value: number;
  unit: string | null;
  method: string | null;
  context: Record<string, string>;
  context_status: 'complete' | 'partial' | 'unknown';
  evidence: Evidence[];
  table: { source_id: string; page: number; index: number; row: number; header: string[] };
  matched_label: string;
  confidence: 'high' | 'medium' | 'low';
  warnings: string[];
  record_ref: RecordReference;
  /** Chemistry of the matched sample at extraction time, for later continuity checks. */
  sample_fingerprint: SampleFingerprint;
}

export interface ObservationExtraction {
  paper_id: string;
  metric: string;
  metric_label: string | null;
  tables_scanned: number;
  candidates: ObservationCandidate[];
  unmatched_labels: { label: string; reason: string; candidates: string[] }[];
  skipped: { label: string; value: string; reason: string }[];
  unresolved: string[];
  provenance: 'deterministic_analysis';
}

export interface ObservationFacetOptions {
  metric: string;
  samples?: string[];
  table_index?: number;
  sample_map?: Record<string, string>;
  /** Version the record was read from; defaults to the record's stored status. */
  version?: 'verified' | 'uncertain';
}

/**
 * Read one metric from all tables of the supplied sources. Rows that cannot be paired or
 * parsed are listed, never dropped silently.
 */
export function extractTableObservations(record: PublishedRecord, documents: SourceDocument[], options: ObservationFacetOptions): ObservationExtraction {
  const metric = resolveMetric(options.metric);
  const candidates: ObservationCandidate[] = [];
  const unmatched: ObservationExtraction['unmatched_labels'] = [];
  const skipped: ObservationExtraction['skipped'] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  let tablesScanned = 0, tableIndex = 0, metricLabel: string | null = null;
  // Fingerprints are computed once per sample; a paper can list dozens of rows.
  const fingerprints = new Map<string, SampleFingerprint>();
  const fingerprintOf = (sampleId: string) => {
    const cached = fingerprints.get(sampleId);
    if (cached) return cached;
    const sample = record.draft.samples.find(item => item.local_id === sampleId);
    if (!sample) throw new Error(`样品不存在：${sampleId}`);
    const value = sampleFingerprint(sample);
    fingerprints.set(sampleId, value);
    return value;
  };

  for (const document of documents) {
    for (const page of document.pages) {
      for (const table of page.tables ?? []) {
        const index = tableIndex++;
        if (options.table_index !== undefined && options.table_index !== index) continue;
        tablesScanned++;
        const rows = table.rows.map(row => row.map(cell => String(cell ?? '').trim()));
        let headerRow = -1, metricColumn = -1;
        for (let row = 0; row < rows.length && headerRow < 0; row++) {
          const column = rows[row].findIndex(cell => metric.aliases.some(alias => normalize(cell).includes(normalize(alias))));
          if (column >= 0) { headerRow = row; metricColumn = column; }
        }
        if (headerRow < 0) continue;
        metricLabel ??= rows[headerRow][metricColumn].replace(/\s+/g, ' ').trim();
        const header = rows[headerRow].map(cell => cell.replace(/\s+/g, ' ').trim());
        const sampleColumn = header.findIndex(cell => /sample|catalyst|material|photocatalyst|electrode|样品|催化剂|材料|电极/i.test(cell));
        const nextCell = rows[headerRow + 1]?.[metricColumn];
        const unit = unitFromHeader(header[metricColumn])
          ?? (nextCell && /^[\(\[（【].*[\)\]）】]$/.test(nextCell.trim()) ? unitFromHeader(nextCell) : null);
        const contextInfo = extractContext(document, page.number, metric.aliases);

        for (let row = headerRow + 1; row < rows.length; row++) {
          const cells = rows[row];
          const sampleLabel = cells[sampleColumn >= 0 ? sampleColumn : 0] ?? '';
          if (!sampleLabel) continue;
          const parsed = parseCellValue(cells[metricColumn]);
          if (!parsed) {
            if (cells[metricColumn]) skipped.push({ label: sampleLabel, value: cells[metricColumn], reason: '数值缺失或不可解析' });
            continue;
          }
          const match = matchSample(sampleLabel, record, options.sample_map ?? {});
          if (!match.sampleId) {
            unmatched.push({ label: sampleLabel, reason: match.reason, candidates: match.candidates });
            continue;
          }
          if (options.samples?.length && !options.samples.includes(match.sampleId)) continue;
          const key = `${match.sampleId}|${metric.key}|${parsed.value}|${unit ?? ''}|${page.number}`;
          if (seen.has(key)) continue;
          seen.add(key);
          // A "conditions" column is measurement context even when the caption says nothing.
          const conditionText = cells.filter((_, column) => column !== (sampleColumn >= 0 ? sampleColumn : 0) && column !== metricColumn).join(' ');
          const context = { ...contextInfo.context, ...contextFromText(`${sampleLabel} ${conditionText}`) };
          const contextStatus: ObservationCandidate['context_status'] = Object.keys(context).length >= 2 ? 'complete'
            : Object.keys(context).length === 1 ? 'partial' : 'unknown';
          const evidence: Evidence[] = [{
            source_id: document.id, page: page.number,
            quote: truncate([sampleLabel, header[metricColumn], cells[metricColumn]].filter(Boolean).join(' | '), 400),
            location: `table ${index + 1} row ${row + 1}`,
            basis: 'page_text',
          }, ...contextInfo.evidence];
          candidates.push({
            observation_id: newId('obs'), paper_id: record.paper.paper_id, sample_id: match.sampleId,
            metric: metric.key, metric_label: header[metricColumn], value: parsed.value, unit,
            method: context.method ?? null, context, context_status: contextStatus,
            evidence, table: { source_id: document.id, page: page.number, index, row: row + 1, header },
            matched_label: sampleLabel, confidence: match.confidence,
            warnings: [
              ...(parsed.note ? [parsed.note] : []),
              ...(unit ? [] : ['未解析出单位']),
              ...(match.confidence === 'high' ? [] : [match.reason]),
            ],
            record_ref: {
              paper_id: record.paper.paper_id,
              version: options.version ?? (record.verification_status === 'uncertain' ? 'uncertain' : 'verified'),
              revision: record.revision, verified_at: record.verified_at,
            },
            sample_fingerprint: fingerprintOf(match.sampleId),
          });
        }
      }
    }
  }

  if (!tablesScanned) unresolved.push('提供的来源中没有可读取的表格；需要 Python/pdfplumber 表格提取或原件不可用');
  else if (!metricLabel) unresolved.push(`未在任何表格中找到指标列「${options.metric}」`);
  if (metricLabel && !candidates.length) unresolved.push('找到指标列，但没有可配对的数据行；检查样品标签或表格结构');
  if (candidates.some(candidate => candidate.context_status === 'unknown')) unresolved.push('部分观察未从页面文字中取得测量条件；差值只能作为数值参考');

  return {
    paper_id: record.paper.paper_id, metric: metric.key, metric_label: metricLabel,
    tables_scanned: tablesScanned, candidates, unmatched_labels: unmatched, skipped,
    unresolved: [...new Set(unresolved)], provenance: 'deterministic_analysis',
  };
}

/** Convert a candidate into the stored observation shape, keeping the version binding. */
export function toObservation(candidate: ObservationCandidate): Observation {
  return {
    observation_id: candidate.observation_id, paper_id: candidate.paper_id, sample_id: candidate.sample_id,
    metric: candidate.metric, value: candidate.value, unit: candidate.unit, method: candidate.method,
    context: candidate.context, evidence: candidate.evidence, provenance: 'source_reported',
    record_ref: candidate.record_ref, sample_fingerprint: candidate.sample_fingerprint, created_at: nowIso(),
  };
}
