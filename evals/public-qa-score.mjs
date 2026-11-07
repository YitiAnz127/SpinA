import { readFile, writeFile } from 'node:fs/promises';
import { numericAnswerMatches } from './numeric-answer.mjs';
const dir = 'reports/answer-pilot-20261101';
const manifest = JSON.parse(await readFile(dir + '/public-qa-manifest.json', 'utf8'));
const results = [];
for (const task of manifest.cases) {
  let response;
  try { response = JSON.parse(await readFile(`${dir}/${task.id}.json`, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { response = JSON.parse(await readFile(`${dir}/initial-network-failures/${task.id}.json`, 'utf8')); }
    catch (missing) { if (missing.code !== 'ENOENT') throw missing; results.push({ id: task.id, status: 'not_run' }); continue; }
  }
  const answer = response.turns.at(-1)?.answers.filter(m => m.stopReason === 'stop').at(-1);
  const text = answer?.content.filter(x => x.type === 'text').map(x => x.text).join('\n') ?? '';
  const match = /FINAL_ANSWER\s*:\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/i.exec(text);
  const value = match ? Number(match[1]) : null;
  const completed = response.exit_code === 0 && response.completed_turns === 1 && !!answer && !response.provider_error;
  const correct = completed ? numericAnswerMatches(value, task.answer) : null;
  results.push({ id: task.id, qid: task.qid, category: task.category, difficulty: task.difficulty, reference: task.answer, unit: task.unit,
    predicted: value, status: completed ? 'answered' : 'infrastructure_failure', correct, answer_text: text, elapsed_ms: response.elapsed_ms });
}
const answered = results.filter(r => r.status === 'answered'), correct = answered.filter(r => r.correct).length;
const summary = { intended: results.length, answered: answered.length, correct, accuracy_on_answered: answered.length ? correct / answered.length : null,
  all_completed: answered.length === results.length, protocol: manifest.grading, results };
await writeFile(dir + '/public-qa-summary.json', JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ intended: summary.intended, answered: summary.answered, correct, accuracy: summary.accuracy_on_answered,
  results: results.map(({ answer_text, ...r }) => r) }, null, 2));
