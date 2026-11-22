/**
 * Coyote V3 BLE protocol primitives.
 * Spec: https://github.com/dungeonlab-open/dglab-bluetooth-protocol
 *
 * The payloads here intentionally follow the public V3 spec. No byte swapping
 * is required on V3 (unlike V2).
 */

export const PROTOCOL = Object.freeze({
  SERVICE_CONTROL: 0x180c,
  CHARACTERISTIC_WRITE: 0x150a,
  CHARACTERISTIC_NOTIFY: 0x150b,
  SERVICE_BATTERY: 0x180a,
  CHARACTERISTIC_BATTERY: 0x1500,
  HEADER_B0: 0xb0,
  HEADER_BF: 0xbf,
  HEADER_B1: 0xb1,
  TICK_MS: 100,
  SUB_TICK_MS: 25,
  MAX_INTENSITY: 200,
  MAX_WAVEFORM_INTENSITY: 100,
  MIN_FREQUENCY: 10,
  MAX_FREQUENCY: 1000,
  MAX_PROTOCOL_FREQUENCY: 240,
});

/** Two-bit intensity interpretation modes, per channel. */
export const MODE = Object.freeze({
  HOLD: 0b00,
  INCREASE: 0b01,
  DECREASE: 0b10,
  ABSOLUTE: 0b11,
});

export const ZERO_SAMPLE = Object.freeze({ frequency: 10, intensity: 0 });

/** Clamp a number to an integer inside [min, max]. */
export function clampInt(value, min, max, fallback = min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function clampNumber(value, min, max, fallback = min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function normalizeIntensity(value) {
  return clampInt(value, 0, PROTOCOL.MAX_INTENSITY);
}

export function normalizeWaveformIntensity(value) {
  return clampInt(value, 0, PROTOCOL.MAX_WAVEFORM_INTENSITY);
}

export function normalizeSequence(value) {
  return clampInt(value, 0, 15);
}

/**
 * Convert a human-facing 10–1000 Hz request into the V3 wire range of 10–240.
 * See the frequency mapping table in the public V3 protocol.
 */
export function toProtocolFrequency(value) {
  const input = clampNumber(value, PROTOCOL.MIN_FREQUENCY, PROTOCOL.MAX_FREQUENCY);
  let mapped;
  if (input <= 100) {
    mapped = input;
  } else if (input <= 600) {
    mapped = (input - 100) / 5 + 100;
  } else {
    mapped = (input - 600) / 10 + 200;
  }
  return clampInt(mapped, PROTOCOL.MIN_FREQUENCY, PROTOCOL.MAX_PROTOCOL_FREQUENCY);
}

/** Inverse of toProtocolFrequency, for display and diagnostics. */
export function fromProtocolFrequency(value) {
  const input = clampInt(value, PROTOCOL.MIN_FREQUENCY, PROTOCOL.MAX_PROTOCOL_FREQUENCY);
  if (input <= 100) return input;
  if (input <= 200) return (input - 100) * 5 + 100;
  return (input - 200) * 10 + 600;
}

export function normalizeMode(value) {
  return clampInt(value, 0, 3, 0);
}

/** Clamp a sample and make sure every generated value is wire-legal. */
export function normalizeSample(sample) {
  if (!sample || typeof sample !== 'object') return { ...ZERO_SAMPLE };
  return {
    frequency: clampNumber(
      Number.isFinite(Number(sample.frequency)) ? Number(sample.frequency) : PROTOCOL.MIN_FREQUENCY,
      PROTOCOL.MIN_FREQUENCY,
      PROTOCOL.MAX_FREQUENCY,
      PROTOCOL.MIN_FREQUENCY,
    ),
    intensity: normalizeWaveformIntensity(sample.intensity),
  };
}

function writeWaveform(view, offset, samples) {
  const list = Array.isArray(samples) ? samples : [];
  for (let index = 0; index < 4; index += 1) {
    const sample = normalizeSample(list[index]);
    view[offset + index] = toProtocolFrequency(sample.frequency);
    view[offset + 4 + index] = sample.intensity;
  }
}

/**
 * Build a 20-byte B0 frame for both channels.
 *
 * @param {{sequence?:number, modeA?:number, modeB?:number, intensityA?:number,
 *          intensityB?:number, samplesA?:Array, samplesB?:Array}} command
 * @returns {Uint8Array}
 */
export function encodeB0Frame(command = {}) {
  let sequence = normalizeSequence(command.sequence);
  const modeA = normalizeMode(command.modeA);
  const modeB = normalizeMode(command.modeB);

  // A sequence number is only meaningful when an intensity change is requested.
  if (modeA === MODE.HOLD && modeB === MODE.HOLD) sequence = 0;

  const frame = new Uint8Array(20);
  frame[0] = PROTOCOL.HEADER_B0;
  frame[1] = ((sequence & 0x0f) << 4) | ((modeA & 0x03) << 2) | (modeB & 0x03);
  frame[2] = normalizeIntensity(command.intensityA);
  frame[3] = normalizeIntensity(command.intensityB);
  writeWaveform(frame, 4, command.samplesA);
  writeWaveform(frame, 12, command.samplesB);
  return frame;
}

/**
 * Build a 7-byte BF frame containing soft limits and both balance pairs.
 * BF takes effect immediately and persists across power cycles.
 */
export function encodeBFFrame(options = {}) {
  const frame = new Uint8Array(7);
  frame[0] = PROTOCOL.HEADER_BF;
  frame[1] = normalizeIntensity(options.limitA);
  frame[2] = normalizeIntensity(options.limitB);
  frame[3] = clampInt(options.balance1A, 0, 255, 128);
  frame[4] = clampInt(options.balance1B, 0, 255, 128);
  frame[5] = clampInt(options.balance2A, 0, 255, 128);
  frame[6] = clampInt(options.balance2B, 0, 255, 128);
  return frame;
}

/**
 * Parse the documented notification messages.
 * @param {DataView|Uint8Array|ArrayBuffer|number[]} value
 * @returns {{type:'B1', sequence:number, intensityA:number, intensityB:number}|null}
 */
export function parseNotification(value) {
  if (!value) return null;
  let bytes;
  if (value instanceof DataView) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else if (value instanceof Uint8Array) {
    bytes = value;
  } else if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (Array.isArray(value)) {
    bytes = Uint8Array.from(value);
  } else {
    return null;
  }

  if (bytes.length < 4) return null;
  if (bytes[0] !== PROTOCOL.HEADER_B1) return null;

  return {
    type: 'B1',
    sequence: bytes[1] & 0x0f,
    intensityA: normalizeIntensity(bytes[2]),
    intensityB: normalizeIntensity(bytes[3]),
  };
}

export function parseBattery(value) {
  if (!value) return null;
  try {
    const view = value instanceof DataView ? value : new DataView(value.buffer ?? value);
    if (view.byteLength < 1) return null;
    return clampInt(view.getUint8(0), 0, 100);
  } catch {
    return null;
  }
}

export function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ').toUpperCase();
}

/** The neutral "no pulse" waveform. */
export function silentSamples() {
  return [
    { ...ZERO_SAMPLE },
    { ...ZERO_SAMPLE },
    { ...ZERO_SAMPLE },
    { ...ZERO_SAMPLE },
  ];
}
