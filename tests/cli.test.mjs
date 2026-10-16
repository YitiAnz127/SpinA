import test from 'node:test';
import assert from 'node:assert/strict';
import {buildLaunchOptions} from '../src/cli.mjs';

test('SpinA launches question answering with GPT-6.1-Sol low independently of global Pi defaults',()=>{
  const options=buildLaunchOptions([],{});
  assert.equal(options.args[options.args.indexOf('--model')+1],'openai-codex/gpt-6.1-sol');
  assert.equal(options.args[options.args.indexOf('--thinking')+1],'low');
  assert.ok(options.args.includes('--no-context-files'));
  assert.ok(options.args.includes('--no-skills'));
  assert.match(options.args[options.args.indexOf('--skill') + 1], /pdf-extraction/);
  assert.match(options.args[options.args.indexOf('--system-prompt') + 1], /read_paper_pages/);
});
