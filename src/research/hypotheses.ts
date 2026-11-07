import type { Hypothesis, ResearchStore } from './store.ts';
import { newId, nowIso } from './contracts.ts';

/**
 * F5: competing hypotheses and discriminating observations.
 *
 * Generation is a model role; this module validates the structure and performs the
 * deterministic discrimination test. A hypothesis without a falsifier is rejected.
 */

export interface HypothesisInput {
  hypothesis_id?: string;
  task_id?: string;
  statement: string;
  explains: string[];
  assumptions?: string[];
  predicts: { observable: string; expected: string }[];
  falsifiers: { observation: string; outcome: string }[];
  support?: string[];
  counter?: string[];
}

const clean = (value: unknown) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();

export function validateHypothesis(input: HypothesisInput): Hypothesis {
  if (!input || typeof input !== 'object') throw new Error('hypothesis 必须是对象');
  const statement = clean(input.statement);
  if (!statement) throw new Error('hypothesis.statement 不能为空');
  const explains = (input.explains ?? []).map(clean).filter(Boolean);
  if (!explains.length) throw new Error('hypothesis 需要说明它试图解释的观察');
  const predicts = (input.predicts ?? []).map(item => ({ observable: clean(item.observable), expected: clean(item.expected) }))
    .filter(item => item.observable && item.expected);
  if (!predicts.length) throw new Error('hypothesis 需要至少一个“可观测量 → 预期”的预测，否则无法参与区分');
  const falsifiers = (input.falsifiers ?? []).map(item => ({ observation: clean(item.observation), outcome: clean(item.outcome) }))
    .filter(item => item.observation && item.outcome);
  if (!falsifiers.length) throw new Error('hypothesis 至少需要一个可反驳条件；不可证伪的泛化解释不予登记');
  return {
    hypothesis_id: input.hypothesis_id?.trim() || newId('hyp'),
    task_id: input.task_id?.trim() || undefined,
    statement, explains, assumptions: (input.assumptions ?? []).map(clean).filter(Boolean),
    predicts, falsifiers,
    support: (input.support ?? []).map(clean).filter(Boolean),
    counter: (input.counter ?? []).map(clean).filter(Boolean),
    created_at: nowIso(),
  };
}

export function ingestHypotheses(store: ResearchStore, inputs: HypothesisInput[]): Hypothesis[] {
  if (!Array.isArray(inputs) || !inputs.length) throw new Error('没有要登记的假设');
  const hypotheses = inputs.map(validateHypothesis);
  if (new Set(hypotheses.map(item => item.hypothesis_id)).size !== hypotheses.length) throw new Error('hypothesis_id 重复');
  for (const hypothesis of hypotheses) store.addHypothesis(hypothesis);
  return hypotheses;
}

export interface ObservableComparison {
  observable: string;
  expected_a: string | null;
  expected_b: string | null;
  discriminating: boolean;
}

export interface HypothesisPair {
  a: string;
  b: string;
  observables: ObservableComparison[];
  discriminating: string[];
  verdict: 'discriminating' | 'same_expectation' | 'no_shared_observable';
  explanation: string;
}

export interface DiscriminationResult {
  pairs: HypothesisPair[];
  per_hypothesis: { hypothesis_id: string; falsifiers: string[]; missing_information: string[] }[];
  unresolved: string[];
  provenance: 'derived_analysis';
}

const key = (value: string) => clean(value).toLowerCase();

/** Two explanations are only distinguishable where they predict different outcomes for the same observable. */
export function identifyDiscriminatingObservations(hypotheses: Hypothesis[]): DiscriminationResult {
  if (hypotheses.length < 2) throw new Error('区分性观察至少需要两条竞争假设');
  const pairs: HypothesisPair[] = [];
  for (let i = 0; i < hypotheses.length; i++) {
    for (let j = i + 1; j < hypotheses.length; j++) {
      const a = hypotheses[i], b = hypotheses[j];
      const left = new Map(a.predicts.map(item => [key(item.observable), item]));
      const right = new Map(b.predicts.map(item => [key(item.observable), item]));
      const shared = [...new Set([...left.keys(), ...right.keys()])];
      const observables: ObservableComparison[] = shared.map(name => {
        const one = left.get(name), two = right.get(name);
        return {
          observable: one?.observable ?? two!.observable,
          expected_a: one?.expected ?? null, expected_b: two?.expected ?? null,
          discriminating: Boolean(one && two && key(one.expected) !== key(two.expected)),
        };
      });
      const discriminating = observables.filter(item => item.discriminating).map(item => item.observable);
      const both = observables.filter(item => item.expected_a && item.expected_b);
      const verdict: HypothesisPair['verdict'] = discriminating.length ? 'discriminating'
        : both.length ? 'same_expectation' : 'no_shared_observable';
      pairs.push({
        a: a.hypothesis_id, b: b.hypothesis_id, observables, discriminating, verdict,
        explanation: verdict === 'discriminating'
          ? `可用「${discriminating.join('、')}」区分：两条假设对该观察量的预期不同。`
          : verdict === 'same_expectation'
            ? '两条假设对共同观察量的预期相同，这些观察不能区分它们。'
            : '两条假设没有对同一观察量给出预期；现有信息不能区分。',
      });
    }
  }
  const unresolved: string[] = [];
  if (!pairs.some(pair => pair.verdict === 'discriminating')) unresolved.push('现有假设之间没有可区分观察；允许输出“现有信息不能区分”，不能升级为已证明。');
  return {
    pairs,
    per_hypothesis: hypotheses.map(hypothesis => ({
      hypothesis_id: hypothesis.hypothesis_id,
      falsifiers: hypothesis.falsifiers.map(item => `若${item.observation}为${item.outcome}，则该假设被削弱或否定`),
      missing_information: hypothesis.predicts.filter(item => !item.expected).map(item => item.observable),
    })),
    unresolved,
    provenance: 'derived_analysis',
  };
}
