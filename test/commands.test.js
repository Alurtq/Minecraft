import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFill, makeSetBlock, normalizeCommand } from '../src/commands.js';

const origin = { x: 0, y: 64, z: 0 };
const fill = { from: origin, to: origin, block: 'stone' };
const set = { position: origin, block: 'minecraft:stone' };

test('normalizes console commands without invoking a shell', () => {
  assert.equal(normalizeCommand('  /say hello  '), 'say hello');
  assert.equal(normalizeCommand('list'), 'list');
  assert.equal(normalizeCommand('say $(example) & text'), 'say $(example) & text');
});

test('rejects empty, multiline, and control-containing commands', () => {
  for (const command of ['', '  ', '/', ' / ', 'say hello\nstop', 'list\r', '\tlist', 'say\0hi', 'say\u007fhi', 'say\u0085hi', 'say\u2028hi', null, 1]) {
    assert.throws(() => normalizeCommand(command), TypeError);
  }
});

test('builds dimension-qualified setblock with defaults', () => {
  assert.equal(makeSetBlock(set), 'execute in overworld run setblock 0 64 0 minecraft:stone replace');
  assert.equal(makeSetBlock({ ...set, position: { x: -4, y: -64, z: 12 }, mode: 'keep', dimension: 'nether' }),
    'execute in nether run setblock -4 -64 12 minecraft:stone keep');
});

test('serializes Bedrock block states with equals separators and typed values', () => {
  assert.equal(makeSetBlock({
    ...set, block: 'custom:sample',
    states: { 'minecraft:cardinal_direction': 'north', open_bit: true, custom_integer: 2 },
  }), 'execute in overworld run setblock 0 64 0 custom:sample ["minecraft:cardinal_direction"="north","open_bit"=true,"custom_integer"=2] replace');
  assert.equal(makeFill({ ...fill, states: { enabled: false }, mode: 'hollow', dimension: 'the_end' }),
    'execute in the_end run fill 0 64 0 0 64 0 stone ["enabled"=false] hollow');
});

test('accepts every supported setblock and fill mode', () => {
  for (const mode of ['replace', 'keep', 'destroy']) {
    assert.ok(makeSetBlock({ ...set, mode }).endsWith(` ${mode}`));
  }
  for (const mode of ['replace', 'keep', 'outline', 'hollow', 'destroy']) {
    assert.ok(makeFill({ ...fill, mode }).endsWith(` ${mode}`));
  }
});

test('fill cap counts inclusive endpoints regardless of endpoint order', () => {
  const box = { ...fill, from: { x: 31, y: 31, z: 31 }, to: { x: 0, y: 0, z: 0 } };
  assert.equal(makeFill(box), 'execute in overworld run fill 31 31 31 0 0 0 stone replace');
  assert.throws(() => makeFill({ ...box, from: { x: 32, y: 31, z: 31 } }), /project cap of 32768/);
  assert.throws(() => makeFill({ ...box, to: { x: -1, y: 0, z: 0 } }), /project cap of 32768/);
});

test('accepts single-block and degenerate line or plane fills within cap', () => {
  assert.ok(makeFill(fill).includes('fill 0 64 0 0 64 0'));
  assert.ok(makeFill({ ...fill, to: { x: 32767, y: 64, z: 0 } }));
  assert.ok(makeFill({ ...fill, to: { x: 255, y: 64, z: 127 } }));
  assert.throws(() => makeFill({ ...fill, to: { x: 32768, y: 64, z: 0 } }), RangeError);
});

test('never splits oversized hollow or outline fills', () => {
  for (const mode of ['hollow', 'outline']) {
    assert.throws(() => makeFill({ ...fill, to: { x: 32, y: 96, z: 32 }, mode }), /project cap/);
  }
});

test('rejects relative, fractional, nonnumeric, and unsafe coordinates', () => {
  for (const x of ['~', '^1', '1', 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, undefined]) {
    const position = { ...origin, x };
    assert.throws(() => makeSetBlock({ ...set, position }), TypeError);
    assert.throws(() => makeFill({ ...fill, to: position }), TypeError);
  }
  for (const position of [null, [], '0 64 0', {}]) {
    assert.throws(() => makeSetBlock({ ...set, position }), TypeError);
  }
  assert.throws(() => makeFill({ ...fill, to: { x: Number.MAX_SAFE_INTEGER, y: 64, z: 0 } }), RangeError);
});

test('rejects command injection through constructed fields', () => {
  for (const block of ['stone replace air', 'stone\nstop', 'stone\n', 'stone["x"=1]', '', '/stone', 'stone;stop']) {
    assert.throws(() => makeSetBlock({ ...set, block }), TypeError);
  }
  for (const dimension of ['overworld run stop', 'minecraft:overworld', '', null]) {
    assert.throws(() => makeFill({ ...fill, dimension }), TypeError);
  }
  for (const mode of ['hollow', 'replace\nstop', 'replace air']) {
    assert.throws(() => makeSetBlock({ ...set, mode }), TypeError);
  }
  assert.throws(() => makeFill({ ...fill, mode: 'replace\nstop' }), TypeError);
  for (const states of [null, [], { 'x"=1]': 1 }, { 'state\n': 1 }, { state: '\nstop' }, { state: '" ],stop' }, { state: '\\' }, { state: {} }, { state: 1.5 }, { state: NaN }, { state: undefined }]) {
    assert.throws(() => makeSetBlock({ ...set, states }), TypeError);
  }
});
