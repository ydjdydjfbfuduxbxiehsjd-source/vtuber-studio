/**
 * Pure mathematical functions for two-bone IK and signal filtering.
 */

export function solveTwoBoneCosines(
  L1: number,
  L2: number,
  targetDist: number,
  maxReachFactor = 0.98,
  minDist = 0.03
): { alpha: number; clampedDist: number } {
  const maxReach = (L1 + L2) * maxReachFactor;
  const clampedDist = Math.min(Math.max(targetDist, minDist), maxReach);

  // Law of cosines:
  // cos(alpha) = (L1^2 + d^2 - L2^2) / (2 * L1 * d)
  const denom = 2 * L1 * clampedDist;
  if (!Number.isFinite(denom) || denom < 1e-6) {
    return { alpha: 0, clampedDist };
  }

  const cosAlpha = (L1 * L1 + clampedDist * clampedDist - L2 * L2) / denom;
  const clampedCos = Math.min(1, Math.max(-1, cosAlpha));
  const alpha = Math.acos(clampedCos);

  return {
    alpha: Number.isFinite(alpha) ? alpha : 0,
    clampedDist,
  };
}

export function computeRollingMedian(samples: number[]): number {
  if (!samples || samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted[mid];
}

export function computeFaceTouchDistance(
  handPoint: { x: number; y: number },
  facePoints: { x: number; y: number }[]
): number {
  if (!facePoints || facePoints.length === 0) return Infinity;
  let minD = Infinity;
  for (const pt of facePoints) {
    const d = Math.hypot(handPoint.x - pt.x, handPoint.y - pt.y);
    if (d < minD) minD = d;
  }
  return minD;
}
