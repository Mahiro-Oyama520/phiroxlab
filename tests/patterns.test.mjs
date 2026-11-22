import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PATTERNS,
  averageFrequency,
  averageIntensity,
  evaluatePattern,
  getPatternInfo,
  getWaveformPreview,
  sampleChannel,
} from '../js/patterns.js';
import { toProtocolFrequency } from '../js/protocol.js';

test('all patterns are discoverable and unique', () => {
  const ids = new Set(PATTERNS.map((pattern) => pattern.id));
  assert.equal(ids.size, PATTERNS.length);
  assert.ok(PATTERNS.length >= 6);
  for (const pattern of PATTERNS) {
    assert.equal(getPatternInfo(pattern.id).id, pattern.id);
    assert.ok(pattern.name.length > 0);
    assert.ok(pattern.period > 0);
  }
  assert.equal(getPatternInfo('does-not-exist').id, PATTERNS[0].id);
});

test('sampleChannel returns four wire-legal samples for every pattern and channel', () => {
  const times = [0, 1, 37, 99, 250, 999, 3000, 60_000];
  for (const pattern of PATTERNS) {
    for (const channel of ['A', 'B']) {
      for (const time of times) {
        for (const speed of [0.5, 1, 1.5, 2]) {
          for (const depth of [10, 50, 100]) {
            const samples = sampleChannel(pattern.id, time, { channel, speed, depth });
            assert.equal(samples.length, 4);
            for (const sample of samples) {
              assert.ok(Number.isInteger(sample.intensity));
              assert.ok(sample.intensity >= 0 && sample.intensity <= 100);
              assert.ok(sample.frequency >= 10 && sample.frequency <= 1000);
              assert.ok(toProtocolFrequency(sample.frequency) >= 10);
              assert.ok(toProtocolFrequency(sample.frequency) <= 240);
            }
          }
        }
      }
    }
  }
});

test('depth is an upper bound of the pulse envelope', () => {
  for (const pattern of PATTERNS) {
    const samples = sampleChannel(pattern.id, 445, { depth: 35 });
    for (const sample of samples) assert.ok(sample.intensity <= 35);
  }
  const zero = sampleChannel('static', 1234, { depth: 0 });
  assert.deepEqual(zero.map((sample) => sample.intensity), [0, 0, 0, 0]);
});

test('sampling is deterministic', () => {
  const a = sampleChannel('chaos', 12_345, { depth: 70, speed: 1.25, channel: 'A' });
  const b = sampleChannel('chaos', 12_345, { depth: 70, speed: 1.25, channel: 'A' });
  assert.deepEqual(a, b);
});

test('static pattern has a continuous full envelope', () => {
  for (const sample of sampleChannel('static', 0, { depth: 100 })) {
    assert.equal(sample.frequency, 90);
    assert.equal(sample.intensity, 100);
  }
});

test('heartbeat has peaks and rests', () => {
  const intensities = [];
  for (let ms = 0; ms < 1050; ms += 25) {
    intensities.push(...sampleChannel('heartbeat', ms, { depth: 100 }).map((sample) => sample.intensity));
  }
  assert.ok(Math.max(...intensities) >= 50);
  assert.ok(intensities.includes(0));
  assert.ok(new Set(intensities).size > 2);
});

test('speed changes how far a pattern advances', () => {
  const slow = sampleChannel('breathe', 1000, { speed: 0.5, depth: 100 });
  const fast = sampleChannel('breathe', 1000, { speed: 2, depth: 100 });
  assert.notDeepEqual(slow, fast);
});

test('preview series are bounded and sized', () => {
  for (const pattern of PATTERNS) {
    const preview = getWaveformPreview(pattern.id, { points: 64, depth: 80, cycles: 1.25, channel: 'B' });
    assert.equal(preview.series.length, 65);
    assert.ok(preview.duration > 0);
    for (const point of preview.series) {
      assert.ok(point.amplitude >= 0 && point.amplitude <= 1);
      assert.ok(point.intensity >= 0 && point.intensity <= 80);
      assert.ok(point.frequency >= 10 && point.frequency <= 1000);
    }
  }
});

test('average helpers report display-friendly values', () => {
  const samples = [
    { frequency: 100, intensity: 10 },
    { frequency: 100, intensity: 20 },
    { frequency: 100, intensity: 30 },
    { frequency: 100, intensity: 40 },
  ];
  assert.equal(averageFrequency(samples), 100);
  assert.equal(averageIntensity(samples), 25);
  assert.equal(averageIntensity([]), 0);
});

test('evaluatePattern never emits NaN', () => {
  for (const pattern of PATTERNS) {
    for (const t of [0, 0.001, 0.5, 1, 5, 1000, Number.NaN]) {
      const value = evaluatePattern(pattern.id, t, 'A');
      assert.ok(Number.isFinite(value.frequency));
      assert.ok(Number.isFinite(value.amplitude));
    }
  }
});
