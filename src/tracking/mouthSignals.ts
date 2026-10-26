interface Point2D { x: number; y: number }

export function mixArkitMouth(input: {
  smileLeft: number; smileRight: number; frownLeft: number; frownRight: number;
  pucker: number; funnel: number; cheekPuff: number;
}) {
  const safe = (v: number) => Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  // Opposing corner motions must not pull the same vertices both ways.
  const smileLeft = Math.max(0, safe(input.smileLeft) - safe(input.frownLeft));
  const smileRight = Math.max(0, safe(input.smileRight) - safe(input.frownRight));
  const frownLeft = Math.max(0, safe(input.frownLeft) - safe(input.smileLeft));
  const frownRight = Math.max(0, safe(input.frownRight) - safe(input.smileRight));
  // Lip narrowing and cheek puff are width-based estimates, which become
  // unreliable during a smile. Do not stack them on stretched lip corners.
  const remaining = 1 - Math.max(smileLeft, smileRight);
  const pucker = safe(input.pucker);
  const funnel = safe(input.funnel);
  const scale = Math.min(1, remaining / Math.max(1e-9, pucker + funnel));
  return { smileLeft, smileRight, frownLeft, frownRight,
    pucker: pucker * scale, funnel: funnel * scale, cheekPuff: Math.min(safe(input.cheekPuff), remaining) };
}

/** VRM presets often move the same vertices; keep their combined travel bounded. */
export function mixStandardMouth(weights: Record<'aa' | 'oh' | 'ih' | 'ou' | 'ee' | 'happy', number>) {
  const result = { ...weights };
  let total = 0;
  for (const name of Object.keys(result) as (keyof typeof result)[]) {
    result[name] = Number.isFinite(result[name]) ? Math.min(1, Math.max(0, result[name])) : 0;
    total += result[name];
  }
  if (total > 1) {
    for (const name of Object.keys(result) as (keyof typeof result)[]) result[name] /= total;
  }
  return result;
}

/** Measure lips in the face's image plane, so head roll does not create a smirk. */
export function measureMouth(lm: Point2D[], aspect = 1) {
  const dx = (lm[263].x - lm[33].x) * aspect;
  const dy = lm[263].y - lm[33].y;
  const length = Math.hypot(dx, dy);
  const downX = length > 1e-6 ? -dy / length : 0;
  const downY = length > 1e-6 ? dx / length : 1;
  const vertical = (a: Point2D, b: Point2D) =>
    (a.x - b.x) * aspect * downX + (a.y - b.y) * downY;
  const width = Math.max(1e-6, Math.hypot((lm[61].x - lm[291].x) * aspect, lm[61].y - lm[291].y));
  const faceWidth = Math.max(length, 1e-6);
  // Favor the upper lip: lowering the jaw alone should not lift both corners.
  const center = { x: lm[13].x * 0.8 + lm[14].x * 0.2, y: lm[13].y * 0.8 + lm[14].y * 0.2 };
  return {
    openRatio: Math.abs(vertical(lm[14], lm[13])) / width,
    cornerLeft: vertical(center, lm[61]) / width,
    cornerRight: vertical(center, lm[291]) / width,
    // Measure lateral jaw motion along the eyes, not the image's X axis.
    jawShift: (((lm[152].x - lm[1].x) * aspect) * (dx / Math.max(length, 1e-6)) +
      (lm[152].y - lm[1].y) * (dy / Math.max(length, 1e-6))) / faceWidth,
  };
}

/** ARKit jaw travel is distinct from the exaggerated phoneme A blendshape. */
export function jawOpenFromRatio(ratio: number, sensitivity: number) {
  return Math.min(1, Math.max(0, (ratio - 0.04) / (0.65 - 0.04) * sensitivity));
}
