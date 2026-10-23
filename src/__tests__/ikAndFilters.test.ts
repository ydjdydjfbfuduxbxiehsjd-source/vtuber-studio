import { describe, it, expect } from 'vitest';
import { solveTwoBoneCosines, computeRollingMedian, computeFaceTouchDistance } from '../ikMath';
import { OneEuroFilter, OneEuroFilter3D } from '../oneEuroFilter';

describe('Two-Bone IK Law of Cosines', () => {
  it('correctly calculates shoulder angle for standard reach', () => {
    const L1 = 0.25;
    const L2 = 0.25;
    const targetDist = 0.35; // triangle with sides 0.25, 0.25, 0.35
    const result = solveTwoBoneCosines(L1, L2, targetDist);

    expect(Number.isFinite(result.alpha)).toBe(true);
    expect(result.alpha).toBeGreaterThan(0);
    expect(result.alpha).toBeLessThan(Math.PI / 2);
    expect(result.clampedDist).toBe(0.35);
  });

  it('clamps overextension to 0.98 * (L1 + L2)', () => {
    const L1 = 0.22;
    const L2 = 0.22;
    const targetDist = 1.5; // Way beyond reach
    const result = solveTwoBoneCosines(L1, L2, targetDist);

    const maxExpected = (0.22 + 0.22) * 0.98;
    expect(result.clampedDist).toBeCloseTo(maxExpected, 4);
    expect(Number.isFinite(result.alpha)).toBe(true);
  });

  it('handles zero or near-zero distance without producing NaN', () => {
    const result = solveTwoBoneCosines(0.25, 0.25, 0.0);
    expect(Number.isFinite(result.alpha)).toBe(true);
    expect(Number.isNaN(result.alpha)).toBe(false);
    expect(result.clampedDist).toBeGreaterThanOrEqual(0.03);
  });
});

describe('Rolling Median Shoulder Filter', () => {
  it('rejects extreme outliers from perspective foreshortening', () => {
    // Normal shoulder width ~ 0.32m, with single-frame blowout to 0.95m
    const samples = [0.32, 0.31, 0.33, 0.95, 0.32, 0.31, 0.32];
    const median = computeRollingMedian(samples);
    expect(median).toBe(0.32);
  });

  it('handles empty and single-element inputs', () => {
    expect(computeRollingMedian([])).toBe(0);
    expect(computeRollingMedian([0.45])).toBe(0.45);
  });
});

describe('Face Touch Distance & Hysteresis Metric', () => {
  it('detects proximity to face landmarks', () => {
    const hand = { x: 0.50, y: 0.40 };
    const facePoints = [
      { x: 0.50, y: 0.42 }, // Nose (very close)
      { x: 0.50, y: 0.25 }, // Forehead
      { x: 0.50, y: 0.60 }, // Chin
    ];

    const dist = computeFaceTouchDistance(hand, facePoints);
    expect(dist).toBeCloseTo(0.02, 4);
  });
});

describe('1€ Filter (One Euro Filter)', () => {
  it('smooths high-frequency noise at low velocities', () => {
    const filter = new OneEuroFilter(1.2, 0.02, 1.0);
    let time = 0;
    const outputs: number[] = [];

    // Jitter around 0.5
    for (let i = 0; i < 20; i++) {
      time += 16.6; // ~60 FPS
      const noise = (i % 2 === 0 ? 0.02 : -0.02);
      outputs.push(filter.filter(0.5 + noise, time));
    }

    const lastOutput = outputs[outputs.length - 1];
    expect(lastOutput).toBeCloseTo(0.5, 1);
  });

  it('adapts cutoff dynamically at high speed without lagging behind', () => {
    const filter = new OneEuroFilter(1.2, 0.02, 1.0);
    let time = 0;
    filter.filter(0.0, time);

    let fastVal = 0;
    // Step response over 7-8 frames (~120ms)
    for (let i = 1; i <= 8; i++) {
      time += 16.6;
      fastVal = filter.filter(1.0, time);
    }

    // Should catch up quickly due to dynamic cutoff adaptation
    expect(fastVal).toBeGreaterThan(0.7);
  });

  it('filters 3D vectors correctly', () => {
    const filter3D = new OneEuroFilter3D(1.2, 0.02, 1.0);
    const v1 = filter3D.filter({ x: 0.1, y: 0.2, z: 0.3 }, 0);
    expect(v1.x).toBe(0.1);
    expect(v1.y).toBe(0.2);
    expect(v1.z).toBe(0.3);

    const v2 = filter3D.filter({ x: 0.12, y: 0.19, z: 0.31 }, 16.6);
    expect(Number.isFinite(v2.x)).toBe(true);
    expect(Number.isFinite(v2.y)).toBe(true);
    expect(Number.isFinite(v2.z)).toBe(true);
  });
});
