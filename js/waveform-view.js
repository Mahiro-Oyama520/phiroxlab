/** Lightweight canvas oscilloscope for the current waveform envelope. */

import { clampNumber } from './protocol.js';
import { evaluatePattern, getPatternInfo } from './patterns.js';

const reduceMotion = typeof window !== 'undefined'
  && window.matchMedia
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export class WaveformScope {
  constructor(canvas, { channel, getConfig }) {
    this.canvas = canvas;
    this.channel = channel;
    this.getConfig = getConfig;
    this.context = canvas.getContext('2d');
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.color = channel === 'B' ? '#ffb662' : '#55e5b0';
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(0, rect.width);
    const height = Math.max(0, rect.height);
    if (!width || !height) return false;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (Math.abs(width - this.width) > 0.5 || Math.abs(height - this.height) > 0.5 || dpr !== this.dpr) {
      this.width = width;
      this.height = height;
      this.dpr = dpr;
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
      this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    const card = this.canvas.closest('.channel');
    if (card) {
      const cssColor = getComputedStyle(card).getPropertyValue('--ch').trim();
      if (cssColor) this.color = cssColor;
    }
    return true;
  }

  draw(now, { active = false, speed = 1, depth = 70, patternId = 'breathe' } = {}) {
    if (!this.context || !this._resize()) return;
    const ctx = this.context;
    const width = this.width;
    const height = this.height;
    const baseline = height - 4;
    const amplitudeHeight = Math.max(4, height - 12);
    const intensityScale = clampNumber(depth, 0, 100) / 100;
    const info = getPatternInfo(patternId);

    ctx.clearRect(0, 0, width, height);
    ctx.save();

    // Horizon line and subtle quarter marks.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, baseline + 0.5);
    ctx.lineTo(width, baseline + 0.5);
    for (let x = width / 4; x < width; x += width / 4) {
      ctx.moveTo(x, height - 8);
      ctx.lineTo(x, height - 2);
    }
    ctx.stroke();

    const cycle = info.period;
    const duration = cycle * 2;
    const scrollSpeed = active ? Math.max(0.25, speed) : 0.12;
    const offset = reduceMotion ? 0 : ((now / 1000) * scrollSpeed) % cycle;

    const points = [];
    const segments = Math.max(42, Math.min(140, Math.floor(width / 2)));
    for (let index = 0; index <= segments; index += 1) {
      const along = index / segments;
      const value = evaluatePattern(patternId, offset + along * duration, this.channel);
      const amplitude = clampNumber(value.amplitude, 0, 1) * intensityScale;
      const y = baseline - amplitude * amplitudeHeight * 0.93;
      points.push({ x: along * width, y });
    }

    // Filled envelope.
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, `${this.color}44`);
    gradient.addColorStop(0.7, `${this.color}18`);
    gradient.addColorStop(1, `${this.color}00`);
    ctx.beginPath();
    ctx.moveTo(0, baseline);
    for (const point of points) ctx.lineTo(point.x, point.y);
    ctx.lineTo(width, baseline);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.globalAlpha = active ? 1 : 0.55;
    ctx.fill();

    // Soft glow + crisp trace.
    const stroke = () => {
      ctx.beginPath();
      points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.stroke();
    };

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.globalAlpha = active ? 0.22 : 0.11;
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 4;
    stroke();

    ctx.globalAlpha = active ? 0.95 : 0.48;
    ctx.lineWidth = 1.35;
    stroke();

    // A single leading dot provides a sense of motion without visual noise.
    if (active && points.length) {
      const last = points[points.length - 1];
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = this.color;
      ctx.beginPath();
      ctx.arc(last.x - 1, last.y, 1.7, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }
}
