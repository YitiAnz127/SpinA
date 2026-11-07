import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { buildLaunchOptions } from '../src/cli.mjs';
import { SOL_POLICY } from '../src/model-policy.ts';

const directory = resolve('reports/answer-pilot-20261101');
const tasks = JSON.parse(await readFile(resolve('evals/answer-pilot-tasks.json'), 'utf8'));
const selected = process.argv.slice(2).length ? tasks.filter(t => process.argv.slice(2).includes(t.id)) : tasks;
if (!selected.length) throw Error('No matching task');
await mkdir(directory, { recursive: true });
for (const task of selected) {
  const file = resolve(directory, task.id + '.json');
  const options = buildLaunchOptions(['--mode', 'json', '--no-session', '--extension', resolve('evals/answer-only-extension.mjs'), ...task.turns]);
  const started = Date.now(), events = [];
  const decoder = new StringDecoder('utf8');
  let buffer = '', stderr = '', timedOut = false, providerError = false;
  const child = spawn(options.executable, options.args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const consume = line => {
    if (!line.trim()) return;
    let event; try { event = JSON.parse(line); } catch { return; }
    if (event.type === 'message_end') {
      const message = event.message;
      events.push({ type: event.type, message: { ...message, content: Array.isArray(message.content) ? message.content.filter(block => block.type !== 'thinking') : message.content } });
      if (message.role === 'assistant' && message.stopReason === 'error') { providerError = true; child.kill(); }
    } else if (['agent_start', 'agent_settled', 'tool_execution_start', 'tool_execution_end'].includes(event.type)) events.push(event);
  };
  child.stdout.on('data', bytes => { buffer += decoder.write(bytes); let end; while ((end = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, end)); buffer = buffer.slice(end + 1); } });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-4000); });
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 240000 * task.turns.length);
  const exitCode = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
  clearTimeout(timeout); buffer += decoder.end(); consume(buffer);
  const turns = []; let current;
  for (const event of events) {
    if (event.type === 'message_end' && event.message.role === 'user') { current = { prompt: event.message.content, answers: [], tools: [] }; turns.push(current); }
    else if (current && event.type === 'message_end' && event.message.role === 'assistant') current.answers.push(event.message);
    else if (current && event.type === 'tool_execution_start') current.tools.push({ name: event.toolName, args: event.args });
  }
  const result = { id: task.id, kind: task.kind, model: SOL_POLICY, started_at: new Date(started).toISOString(), elapsed_ms: Date.now() - started,
    exit_code: exitCode, timed_out: timedOut, provider_error: providerError, stderr, completed_turns: events.filter(e => e.type === 'agent_settled' && !e.aborted).length,
    prompts: task.turns, turns, events };
  await writeFile(file, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ id: task.id, exit_code: exitCode, completed_turns: result.completed_turns, elapsed_ms: result.elapsed_ms,
    tools: turns.flatMap(t => t.tools.map(x => x.name)), error: turns.flatMap(t => t.answers).filter(m => m.stopReason === 'error').map(m => m.errorMessage), stderr: stderr.slice(-500) }));
  // An infrastructure failure is not an accuracy failure and must not trigger more requests.
  if (exitCode !== 0 || timedOut || providerError || result.completed_turns !== task.turns.length || turns.some(t => !t.answers.some(m => m.stopReason === 'stop'))) break;
}
