import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MODE,
  PROTOCOL,
  encodeB0Frame,
  encodeBFFrame,
  fromProtocolFrequency,
  normalizeIntensity,
  parseBattery,
  parseNotification,
  silentSamples,
  toHex,
  toProtocolFrequency,
} from '../js/protocol.js';

test('B0 frame is exactly 20 bytes and uses the documented header', () => {
  const frame = encodeB0Frame({});
  assert.equal(frame.length, 20);
  assert.equal(frame[0], 0xb0);
  assert.equal(toHex(frame), 'B0 00 00 00 0A 0A 0A 0A 00 00 00 00 0A 0A 0A 0A 00 00 00 00');
});

test('B0 packs sequence and both intensity modes into byte 1', () => {
  const frame = encodeB0Frame({
    sequence: 1,
    modeA: MODE.ABSOLUTE,
    modeB: MODE.HOLD,
    intensityA: 24,
    intensityB: 0,
  });
  assert.equal(frame[1], 0x1c); // seq=1, mode A=11, mode B=00
  assert.equal(frame[2], 24);
  assert.equal(frame[3], 0);

  const both = encodeB0Frame({
    sequence: 15,
    modeA: MODE.ABSOLUTE,
    modeB: MODE.ABSOLUTE,
    intensityA: 12,
    intensityB: 30,
  });
  assert.equal(both[1], 0xff);

  const hold = encodeB0Frame({
    sequence: 9,
    modeA: MODE.HOLD,
    modeB: MODE.HOLD,
    intensityA: 200,
    intensityB: 200,
  });
  assert.equal(hold[1], 0, 'sequence must be zero when no intensity change is requested');
});

test('B0 encodes four waveform samples per channel', () => {
  const frame = encodeB0Frame({
    samplesA: [
      { frequency: 10, intensity: 0 },
      { frequency: 100, intensity: 25 },
      { frequency: 600, intensity: 50 },
      { frequency: 1000, intensity: 100 },
    ],
    samplesB: [
      { frequency: 20, intensity: 1 },
      { frequency: 30, intensity: 2 },
      { frequency: 40, intensity: 3 },
      { frequency: 50, intensity: 4 },
    ],
  });
  assert.deepEqual(Array.from(frame.slice(4, 8)), [10, 100, 200, 240]);
  assert.deepEqual(Array.from(frame.slice(8, 12)), [0, 25, 50, 100]);
  assert.deepEqual(Array.from(frame.slice(12, 16)), [20, 30, 40, 50]);
  assert.deepEqual(Array.from(frame.slice(16, 20)), [1, 2, 3, 4]);
});

test('B0 clamps out-of-range inputs instead of sending invalid waveform data', () => {
  const frame = encodeB0Frame({
    sequence: 99,
    modeA: 9,
    modeB: -1,
    intensityA: 500,
    intensityB: -20,
    samplesA: [
      { frequency: -100, intensity: 999 },
      { frequency: 5000, intensity: -4 },
      null,
      { frequency: 60, intensity: 70 },
    ],
    samplesB: [],
  });
  assert.equal((frame[1] >> 4) & 0x0f, 15);
  assert.equal((frame[1] >> 2) & 0x03, 3);
  assert.equal(frame[1] & 0x03, 0);
  assert.equal(frame[2], 200);
  assert.equal(frame[3], 0);
  assert.deepEqual(Array.from(frame.slice(4, 8)), [10, 240, 10, 60]);
  assert.deepEqual(Array.from(frame.slice(8, 12)), [100, 0, 0, 70]);
});

test('frequency mapping follows the V3 piecewise table', () => {
  const cases = [
    [10, 10],
    [100, 100],
    [101, 100],
    [105, 101],
    [600, 200],
    [601, 200],
    [1000, 240],
    [5000, 240],
    [0, 10],
  ];
  for (const [input, expected] of cases) {
    assert.equal(toProtocolFrequency(input), expected, `${input} Hz -> ${expected}`);
  }
  assert.equal(fromProtocolFrequency(100), 100);
  assert.equal(fromProtocolFrequency(200), 600);
  assert.equal(fromProtocolFrequency(240), 1000);
});

test('BF frame is 7 bytes and clamps limits and balances', () => {
  const frame = encodeBFFrame({
    limitA: 42,
    limitB: 999,
    balance1A: 0,
    balance1B: 255,
    balance2A: 128,
    balance2B: -10,
  });
  assert.equal(frame.length, 7);
  assert.equal(frame[0], 0xbf);
  assert.deepEqual(Array.from(frame.slice(1)), [42, 200, 0, 255, 128, 0]);
});

test('notifications parse a B1 acknowledgement', () => {
  const data = new DataView(new Uint8Array([0xb1, 0x03, 0x19, 0x0a]).buffer);
  const message = parseNotification(data);
  assert.deepEqual(message, { type: 'B1', sequence: 3, intensityA: 25, intensityB: 10 });
  assert.equal(parseNotification([0xb1, 0x01, 0xc8, 0x00]).intensityA, 200);
  assert.equal(parseNotification([0xb1, 0x01]), null);
  assert.equal(parseNotification([0xb0, 0, 0, 0]), null);
});

test('battery and intensity helpers clamp to their wire ranges', () => {
  assert.equal(parseBattery(new DataView(new Uint8Array([86]).buffer)), 86);
  assert.equal(parseBattery(new DataView(new Uint8Array([220]).buffer)), 100);
  assert.equal(normalizeIntensity(-5), 0);
  assert.equal(normalizeIntensity('42'), 42);
  assert.equal(normalizeIntensity(500), 200);
  assert.equal(silentSamples().length, 4);
  assert.deepEqual(silentSamples()[0], { frequency: 10, intensity: 0 });
});

test('documented protocol example encodes as expected', () => {
  const frame = encodeB0Frame({
    sequence: 0,
    modeA: MODE.HOLD,
    modeB: MODE.HOLD,
    intensityA: 0,
    intensityB: 0,
    samplesA: [
      { frequency: 10, intensity: 0 },
      { frequency: 10, intensity: 10 },
      { frequency: 20, intensity: 20 },
      { frequency: 30, intensity: 30 },
    ],
    samplesB: [
      { frequency: 10, intensity: 0 },
      { frequency: 10, intensity: 0 },
      { frequency: 10, intensity: 0 },
      { frequency: 10, intensity: 0 },
    ],
  });
  assert.equal(toHex(frame), 'B0 00 00 00 0A 0A 14 1E 00 0A 14 1E 0A 0A 0A 0A 00 00 00 00');
  assert.equal(frame.length, PROTOCOL.TICK_MS === 100 ? 20 : 20);
});
