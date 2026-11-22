/**
 * Pattern engine.
 *
 * Every pattern is a continuous function of time that returns a carrier
 * frequency and a 0..1 pulse envelope. Four samples are generated for each
 * 100 ms B0 frame (25 ms per sample). Channel intensity is controlled
 * separately and is never modified here.
 */

import { clampInt, clampNumber, fromProtocolFrequency, toProtocolFrequency } from './protocol.js';

export const PATTERNS = Object.freeze([
  {
    id: 'breathe',
    name: '呼吸',
    short: '慢波',
    description: '4.2 秒一轮的柔和起伏，适合热身和长时间使用。',
    period: 4.2,
  },
  {
    id: 'tide',
    name: '潮汐',
    short: '涌动',
    description: '更长的 7.5 秒周期，包络与频率一起缓慢涨落。',
    period: 7.5,
  },
  {
    id: 'heartbeat',
    name: '心跳',
    short: '双击',
    description: '一小一大两次脉冲，间隔 1.05 秒。',
    period: 1.05,
  },
  {
    id: 'tap',
    name: '连击',
    short: '短促',
    description: '每 0.55 秒一次的短促点状脉冲。',
    period: 0.55,
  },
  {
    id: 'ripple',
    name: '涟漪',
    short: '频率漫游',
    description: '包络连绵，载波频率在 30–220 Hz 之间游走。',
    period: 2.8,
  },
  {
    id: 'step',
    name: '阶梯',
    short: '分段',
    description: '六级台阶式强度，每两级改变一次频率。',
    period: 3.3,
  },
  {
    id: 'chaos',
    name: '随机',
    short: '漂移',
    description: '确定性的平滑噪声，每次打开都相同，方便复现。',
    period: 5.6,
  },
  {
    id: 'static',
    name: '恒定',
    short: '连续',
    description: '不中断的连续输出，适合配合外部节奏使用。',
    period: 1,
  },
]);

const PATTERN_BY_ID = new Map(PATTERNS.map((pattern) => [pattern.id, pattern]));
const TAU = Math.PI * 2;

export function getPatternInfo(id) {
  return PATTERN_BY_ID.get(id) ?? PATTERNS[0];
}

export function listPatterns() {
  return PATTERNS.map((pattern) => ({ ...pattern }));
}

function fract(value) {
  return value - Math.floor(value);
}

function smoothstep(value) {
  const x = clampNumber(value, 0, 1);
  return x * x * (3 - 2 * x);
}

function hash01(value) {
  const x = Math.sin(value * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

function valueNoise(value) {
  const index = Math.floor(value);
  const fraction = value - index;
  const eased = smoothstep(fraction);
  return hash01(index) * (1 - eased) + hash01(index + 1) * eased;
}

function gaussian(x, center, width) {
  const distance = (x - center) / width;
  return Math.exp(-(distance * distance));
}

/** Return a carrier frequency and envelope amplitude for a point in pattern time. */
export function evaluatePattern(id, seconds, channel = 'A') {
  const t = Math.max(0, Number(seconds) || 0);
  const channelShift = channel === 'B' ? 0.7 : 0;

  switch (id) {
    case 'breathe': {
      const phase = fract(t / 4.2);
      const envelope = 0.08 + 0.92 * (0.5 - 0.5 * Math.cos(TAU * phase));
      return {
        frequency: 45 + 90 * (0.5 - 0.5 * Math.cos(TAU * phase)),
        amplitude: envelope,
      };
    }
    case 'tide': {
      const phase = fract(t / 7.5);
      const envelope = 0.14 + 0.86 * Math.pow(0.5 - 0.5 * Math.cos(TAU * phase), 1.35);
      return {
        frequency: 28 + 175 * (0.5 + 0.5 * Math.sin(TAU * phase + 0.9)),
        amplitude: envelope,
      };
    }
    case 'heartbeat': {
      const phase = fract(t / 1.05);
      const first = gaussian(phase, 0.035, 0.036);
      const second = 0.64 * gaussian(phase, 0.19, 0.052);
      const tail = 0.1 * gaussian(phase, 0.28, 0.075);
      return {
        frequency: 58,
        amplitude: Math.min(1, first + second + tail),
      };
    }
    case 'tap': {
      const phase = fract(t / 0.55);
      let amplitude = 0;
      if (phase < 0.18) amplitude = Math.sin((phase / 0.18) * Math.PI);
      return {
        frequency: 135 + 35 * Math.sin(TAU * phase),
        amplitude,
      };
    }
    case 'ripple': {
      const envelope = 0.32 + 0.5 * (0.5 - 0.5 * Math.cos(TAU * (t / 2.8) - 0.6));
      const frequency = 30 + 190 * (0.5 + 0.5 * Math.sin(TAU * t / 3.7 + channelShift));
      return { frequency, amplitude: envelope };
    }
    case 'step': {
      const stepLength = 0.55;
      const step = Math.floor(t / stepLength) % 6;
      const levels = [0.16, 0.38, 0.66, 1, 0.56, 0.28];
      return {
        frequency: 70 + step * 28,
        amplitude: levels[step],
      };
    }
    case 'chaos': {
      const x = t * 0.72 + channelShift * 11;
      const amplitude = 0.12 + 0.88 * valueNoise(x);
      const frequency = 25 + 255 * valueNoise(x * 0.62 + 37.4);
      return { frequency, amplitude };
    }
    case 'static':
    default:
      return { frequency: 90, amplitude: 1 };
  }
}

/**
 * Generate the four 25 ms samples for one B0 frame.
 *
 * @param {string} id
 * @param {number} timeMs elapsed pattern time in milliseconds
 * @param {{speed?:number, depth?:number, channel?:'A'|'B'}} options
 */
export function sampleChannel(id, timeMs, options = {}) {
  const speed = clampNumber(options.speed, 0.25, 4, 1);
  const depth = clampInt(options.depth, 0, 100, 70);
  const channel = options.channel === 'B' ? 'B' : 'A';
  const samples = [];

  for (let index = 0; index < 4; index += 1) {
    const sampleTime = ((Number(timeMs) || 0) + index * 25) / 1000;
    const value = evaluatePattern(id, sampleTime * speed, channel);
    samples.push({
      frequency: clampNumber(value.frequency, 10, 1000, 90),
      intensity: clampInt(value.amplitude * depth, 0, 100, 0),
    });
  }

  return samples;
}

/** A stable preview series for canvas rendering. */
export function getWaveformPreview(id, options = {}) {
  const info = getPatternInfo(id);
  const points = clampInt(options.points, 12, 600, 140);
  const cycles = clampNumber(options.cycles, 0.5, 3, 1.25);
  const depth = clampInt(options.depth, 0, 100, 100);
  const duration = Math.max(0.4, info.period * cycles);
  const channel = options.channel === 'B' ? 'B' : 'A';
  const series = [];

  for (let index = 0; index <= points; index += 1) {
    const t = (index / points) * duration;
    const value = evaluatePattern(id, t, channel);
    series.push({
      t,
      amplitude: clampNumber(value.amplitude, 0, 1),
      intensity: clampInt(value.amplitude * depth, 0, 100, 0),
      frequency: clampNumber(value.frequency, 10, 1000, 90),
    });
  }

  return {
    duration,
    series,
    period: info.period,
  };
}

/** Average waveform frequency, mapped back to the user-facing Hz range. */
export function averageFrequency(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  const sum = samples.reduce(
    (total, sample) => total + fromProtocolFrequency(toProtocolFrequency(sample.frequency)),
    0,
  );
  return Math.round(sum / samples.length);
}

/** Mean pulse envelope in the wire range (0–100), used for labels. */
export function averageIntensity(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return 0;
  return Math.round(samples.reduce((total, sample) => total + sample.intensity, 0) / samples.length);
}

export function formatPatternDescription(id) {
  return getPatternInfo(id).description;
}
