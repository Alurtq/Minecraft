const DIMENSIONS = new Set(['overworld', 'nether', 'the_end']);
const SET_BLOCK_MODES = new Set(['replace', 'keep', 'destroy']);
const FILL_MODES = new Set(['replace', 'keep', 'outline', 'hollow', 'destroy']);
const IDENTIFIER = /^(?:[a-z0-9_.-]+:)?[a-z0-9_][a-z0-9_./-]*$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

// A conservative project cap, not a statement about the engine's current limit.
const MAX_FILL_VOLUME = 32768n;

export function normalizeCommand(command) {
  if (typeof command !== 'string' || CONTROL_CHARACTERS.test(command)) {
    throw new TypeError('command must be a single-line string without control characters');
  }
  const normalized = command.trim().replace(/^\//, '').trim();
  if (!normalized) throw new TypeError('command must not be empty');
  return normalized;
}

function coordinates(position, name) {
  if (!position || typeof position !== 'object' || Array.isArray(position)) {
    throw new TypeError(`${name} must contain absolute integer x, y, z coordinates`);
  }
  return ['x', 'y', 'z'].map((axis) => {
    if (!Number.isSafeInteger(position[axis])) {
      throw new TypeError(`${name}.${axis} must be an absolute safe integer`);
    }
    return position[axis];
  });
}

function blockArgument(block, states) {
  if (typeof block !== 'string' || CONTROL_CHARACTERS.test(block) || !IDENTIFIER.test(block)) {
    throw new TypeError('block must be a block identifier, optionally namespaced');
  }
  if (!states || typeof states !== 'object' || Array.isArray(states)) {
    throw new TypeError('states must be an object');
  }
  const entries = Object.entries(states).map(([key, value]) => {
    if (CONTROL_CHARACTERS.test(key) || !IDENTIFIER.test(key)) throw new TypeError('block state keys must be identifiers');
    if (typeof value === 'string') {
      // Avoid relying on Minecraft command-parser escape rules for custom states.
      if (CONTROL_CHARACTERS.test(value) || /["\\]/.test(value)) {
        throw new TypeError('block state strings cannot contain controls, quotes, or backslashes');
      }
    } else if (typeof value !== 'boolean' && !Number.isSafeInteger(value)) {
      throw new TypeError('block state values must be strings, booleans, or safe integers');
    }
    return `${JSON.stringify(key)}=${JSON.stringify(value)}`;
  });
  return entries.length ? `${block} [${entries.join(',')}]` : block;
}

function inDimension(command, dimension) {
  if (!DIMENSIONS.has(dimension)) {
    throw new TypeError('dimension must be overworld, nether, or the_end');
  }
  return `execute in ${dimension} run ${command}`;
}

export function makeSetBlock({ position, block, states = {}, mode = 'replace', dimension = 'overworld' } = {}) {
  const target = coordinates(position, 'position');
  if (!SET_BLOCK_MODES.has(mode)) throw new TypeError('setblock mode must be replace, keep, or destroy');
  return inDimension(`setblock ${target.join(' ')} ${blockArgument(block, states)} ${mode}`, dimension);
}

export function makeFill({ from, to, block, states = {}, mode = 'replace', dimension = 'overworld' } = {}) {
  const start = coordinates(from, 'from');
  const end = coordinates(to, 'to');
  if (!FILL_MODES.has(mode)) throw new TypeError('fill mode must be replace, keep, outline, hollow, or destroy');
  const volume = start.reduce((product, coordinate, axis) => {
    const difference = BigInt(coordinate) - BigInt(end[axis]);
    return product * ((difference < 0n ? -difference : difference) + 1n);
  }, 1n);
  if (volume > MAX_FILL_VOLUME) {
    throw new RangeError(`fill volume ${volume} exceeds the project cap of ${MAX_FILL_VOLUME} blocks per command`);
  }
  return inDimension(`fill ${start.join(' ')} ${end.join(' ')} ${blockArgument(block, states)} ${mode}`, dimension);
}
