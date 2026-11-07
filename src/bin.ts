#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { run } from './cli.js';

/** Asks for a secret without echoing it. */
function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput.bind(rl);
    let asked = false;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (!asked) return write(s);
      if (s.includes('\n')) write('\n');
    };
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
    asked = true;
  });
}

const code = await run(process.argv.slice(2), {
  out: (s) => process.stdout.write(s + '\n'),
  err: (s) => process.stderr.write(s + '\n'),
  env: process.env,
  readSecret,
});
process.exitCode = code;
