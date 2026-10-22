#!/usr/bin/env node
// Measures transport waiting time against a local simulator, not Minecraft's
// block-update throughput. The simulator answers independent commands in parallel.
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { BedrockBridge } from '../src/bedrock.js';

const options = { count: 128, delayMs: 20, concurrency: 8, iterations: 3 };
const flags = new Map([
  ['--count', ['count', 1, 128]],
  ['--delay-ms', ['delayMs', 0, 1000]],
  ['--concurrency', ['concurrency', 1, 16]],
  ['--iterations', ['iterations', 1, 20]],
]);

for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index];
  if (flag === '--help') {
    console.log('Usage: node scripts/benchmark.mjs [--count 128] [--delay-ms 20] [--concurrency 8] [--iterations 3]');
    console.log('Optional BEDROCK_BENCH_BASELINE points to the original src/bedrock.js module.');
    console.log('Output is JSON. Results describe an unencrypted local simulator, not live Minecraft.');
    process.exit(0);
  }
  const specification = flags.get(flag);
  if (!specification) throw new Error(`Unknown option: ${flag}. Use --help.`);
  const [name, minimum, maximum] = specification;
  const raw = process.argv[++index];
  const value = Number(raw);
  if (raw === undefined || raw.trim() === '' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${flag} must be an integer between ${minimum} and ${maximum}.`);
  }
  options[name] = value;
}

const BaselineBridge = process.env.BEDROCK_BENCH_BASELINE
  ? (await import(pathToFileURL(resolve(process.env.BEDROCK_BENCH_BASELINE)).href)).BedrockBridge
  : BedrockBridge;
if (typeof BaselineBridge !== 'function') throw new TypeError('The baseline module must export BedrockBridge.');
if (typeof BedrockBridge.prototype.batch !== 'function') throw new TypeError('The current bridge must implement batch().');

async function measure(Bridge, pipeline) {
  const bridge = new Bridge({ port: 0, commandTimeoutMs: Math.max(5000, options.delayMs * 5) });
  const timers = new Set();
  const commands = Array.from({ length: options.count }, (_, index) => `setblock ${index} 64 0 minecraft:stone`);
  let game;
  let outstanding = 0;
  let maxOutstanding = 0;
  let received = 0;
  let closing = false;
  let rejectGame;
  const gameFailure = new Promise((_, reject) => { rejectGame = reject; });
  // The socket can fail during setup, before Promise.race has been installed.
  gameFailure.catch(() => {});

  try {
    const { port } = await bridge.start();
    game = new WebSocket(`ws://127.0.0.1:${port}`);
    game.on('error', rejectGame);
    game.on('close', () => {
      if (!closing) rejectGame(new Error('The simulator disconnected before the run completed.'));
    });
    game.on('message', data => {
      try {
        const request = JSON.parse(data.toString());
        if (request.header?.messagePurpose !== 'commandRequest' || request.body?.commandLine !== commands[received]) {
          throw new Error('The simulator received an unexpected or reordered command.');
        }
        received += 1;
        outstanding += 1;
        maxOutstanding = Math.max(maxOutstanding, outstanding);
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (closing || game.readyState !== WebSocket.OPEN) return;
          outstanding -= 1;
          game.send(JSON.stringify({
            header: { version: 1, requestId: request.header.requestId, messagePurpose: 'commandResponse' },
            body: { statusCode: 0, statusMessage: 'Simulated OK' },
          }), error => { if (error) rejectGame(error); });
        }, options.delayMs);
        timers.add(timer);
      } catch (error) {
        rejectGame(error);
        game.terminate();
      }
    });
    await once(game, 'open');
    const started = performance.now();
    const run = (async () => {
      if (pipeline) {
        const outcome = await bridge.batch(commands, { concurrency: options.concurrency, stopOnError: false });
        if (outcome.error || outcome.resultUnknown || outcome.completed !== commands.length || outcome.results.length !== commands.length) {
          throw new Error(`Pipeline did not complete the benchmark: ${JSON.stringify(outcome)}`);
        }
        for (const result of outcome.results) {
          if (result.statusCode !== 0) throw new Error('The simulator returned a failed pipeline command.');
        }
      } else {
        for (const command of commands) {
          const result = await bridge.command(command);
          if (result.statusCode !== 0) throw new Error('The simulator returned a failed sequential command.');
        }
      }
    })();
    await Promise.race([run, gameFailure]);
    const elapsedMs = performance.now() - started;
    if (received !== options.count || outstanding !== 0) throw new Error('The simulator command counts did not match.');
    if (maxOutstanding > (pipeline ? options.concurrency : 1)) throw new Error('The configured concurrency limit was exceeded.');
    return { elapsedMs, commandsPerSecond: options.count * 1000 / elapsedMs, maxOutstanding };
  } finally {
    closing = true;
    for (const timer of timers) clearTimeout(timer);
    game?.terminate();
    await bridge.close();
  }
}

const measurements = { sequential: [], pipeline: [] };
for (let iteration = 0; iteration < options.iterations; iteration += 1) {
  // Alternate which mode runs first to reduce warm-up and scheduling bias.
  for (const mode of iteration % 2 === 0 ? ['sequential', 'pipeline'] : ['pipeline', 'sequential']) {
    measurements[mode].push(await measure(mode === 'sequential' ? BaselineBridge : BedrockBridge, mode === 'pipeline'));
  }
}
const round = value => Math.round(value * 100) / 100;
const summarize = samples => {
  const elapsedMs = samples.reduce((total, sample) => total + sample.elapsedMs, 0) / samples.length;
  return {
    meanElapsedMs: round(elapsedMs),
    commandsPerSecond: round(options.count * 1000 / elapsedMs),
    maxOutstanding: Math.max(...samples.map(sample => sample.maxOutstanding)),
    elapsedMsByIteration: samples.map(sample => round(sample.elapsedMs)),
  };
};
const sequential = summarize(measurements.sequential);
const pipeline = summarize(measurements.pipeline);
console.log(JSON.stringify({
  simulationOnly: true,
  transport: 'unencrypted loopback WebSocket',
  note: 'Synthetic responses run independently. Live Bedrock world updates can remain the bottleneck.',
  baseline: process.env.BEDROCK_BENCH_BASELINE ? 'original module supplied through BEDROCK_BENCH_BASELINE' : 'current bridge, sequential commands',
  options,
  sequential,
  pipeline,
  speedup: round(sequential.meanElapsedMs / pipeline.meanElapsedMs),
}, null, 2));
