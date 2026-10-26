import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { ArmRig, computeFingerAngles, shortestTwistAngle } from '../tracking/armRig';
import { measureMouth, jawOpenFromRatio, mixStandardMouth, mixArkitMouth } from '../tracking/mouthSignals';

describe('hand retargeting regressions', () => {
  it('holds the last valid pose instead of filtering invalid coordinates as zero', () => {
    const rig = new ArmRig('left') as any;
    const vrm = { humanoid: { getNormalizedBoneNode: () => null } } as any;
    const shoulder = { x: 0.2, y: -0.4, z: 0, visibility: 1 };
    const elbow = { x: 0.3, y: -0.2, z: 0, visibility: 1 };
    const wrist = { x: 0.4, y: 0.1, z: 0, visibility: 1 };
    rig.update(vrm, shoulder, elbow, wrist, null, null, true, 1000);
    const previous = [rig.lastGoodShoulder.clone(), rig.lastGoodElbow.clone(), rig.lastGoodWrist.clone()];
    rig.update(vrm, { ...shoulder, x: NaN }, { ...elbow, y: Infinity },
      { ...wrist, z: -Infinity }, null, null, true, 1016);
    expect(rig.state).toBe('HOLD');
    expect(rig.lastGoodShoulder).toEqual(previous[0]);
    expect(rig.lastGoodElbow).toEqual(previous[1]);
    expect(rig.lastGoodWrist).toEqual(previous[2]);
    rig.update(vrm, shoulder, elbow, wrist, null, null, true, 1032);
    expect(rig.state).toBe('ACTIVE');
    expect(rig.lastGoodWrist.distanceTo(previous[2])).toBeLessThan(1e-8);
  });
  it('does not invent finger spread when distal joints move sideways', () => {
    const measureSpread = (tipX: number) => {
      const rig = new ArmRig('left') as any;
      rig._palmSide.set(1, 0, 0);
      rig._palmForward.set(0, 1, 0);
      rig._palmNormal.set(0, 0, 1);
      const lm = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
      for (const base of [5, 9, 13, 17]) {
        for (let joint = 0; joint < 4; joint++) {
          lm[base + joint] = { x: (base - 9) * 0.005, y: joint * 0.025, z: 0 };
        }
      }
      lm[8].x += tipX;
      let spread = NaN;
      rig.applyFingerBend = (_node: unknown, name: string, _sign: number,
        _angle: number, _alpha: number, _axis: unknown, value: number) => {
        if (name === 'IndexProximal') spread = value;
      };
      rig.updateFingers({ humanoid: { getNormalizedBoneNode: () => ({}) } }, lm, 0.016);
      return spread;
    };
    expect(measureSpread(0)).toBe(0);
    expect(measureSpread(-0.04)).toBe(0);
    expect(measureSpread(0.04)).toBe(0);
  });
  it('does not flip the half-twist when the quaternion representation changes sign', () => {
    const axis = new Vector3(1, 0, 0);
    for (const angle of [-2.9, -0.3, 0, 0.3, 2.9]) {
      const q = new Quaternion().setFromAxisAngle(axis, angle);
      const negative = new Quaternion(-q.x, -q.y, -q.z, -q.w);
      expect(shortestTwistAngle(q, axis)).toBeCloseTo(shortestTwistAngle(negative, axis), 8);
    }
  });

  it('tracks a knuckle bent 90 degrees with straight PIP and DIP joints', () => {
    const angles = computeFingerAngles(
      { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0.03 },
      { x: 0, y: 0, z: 0.05 }, { x: 0, y: 0, z: 0.07 },
      { x: 0, y: 0, z: 1 },
    );
    expect(angles.proximalBend).toBeCloseTo(Math.PI / 2);
    expect(angles.intermediateBend).toBeCloseTo(0);
    expect(angles.distalBend).toBeCloseTo(0);
  });

  it('does not curl the knuckle when only PIP bends or the finger spreads', () => {
    const angles = computeFingerAngles(
      { x: 0, y: 0, z: 0 }, { x: 0.03, y: 0.03, z: 0 },
      { x: 0.03, y: 0.03, z: 0.02 }, { x: 0.03, y: 0.03, z: 0.04 },
      { x: 0, y: 0, z: 1 },
    );
    expect(angles.proximalBend).toBeCloseTo(0);
    expect(angles.intermediateBend).toBeCloseTo(Math.PI / 2);
  });

  it('does not turn backward knuckle extension into inward curl', () => {
    const angles = computeFingerAngles(
      { x: 0, y: 0, z: 0 }, { x: 0.03, y: 0, z: -0.01 },
      { x: 0.06, y: 0, z: -0.02 }, { x: 0.09, y: 0, z: -0.03 },
      { x: 0, y: 0, z: 1 },
    );
    expect(angles.proximalBend).toBe(0);
  });
});

describe('mouth signals', () => {
  it('bounds every frame when a lingering smile transitions into puckered speech', () => {
    let pose = mixArkitMouth({ smileLeft: 1, smileRight: 0.8, frownLeft: 0, frownRight: 0,
      pucker: 0, funnel: 0, cheekPuff: 0 });
    const target = { smileLeft: 0, smileRight: 0, frownLeft: 0, frownRight: 0,
      pucker: 0.5, funnel: 0.5, cheekPuff: 1 };
    for (let frame = 0; frame < 180; frame++) {
      for (const key of Object.keys(pose) as (keyof typeof pose)[]) {
        pose[key] += (target[key] - pose[key]) * (target[key] > pose[key] ? 0.35 : 0.1);
      }
      pose = mixArkitMouth(pose);
      const smile = Math.max(pose.smileLeft, pose.smileRight);
      expect(smile + pose.pucker + pose.funnel).toBeLessThanOrEqual(1 + 1e-12);
      expect(smile + pose.cheekPuff).toBeLessThanOrEqual(1 + 1e-12);
    }
    expect(pose.pucker).toBeCloseTo(0.5, 5);
    expect(pose.funnel).toBeCloseTo(0.5, 5);
  });
  it('keeps the ARKit constraint stable when applied to the filtered pose repeatedly', () => {
    const pose = mixArkitMouth({ smileLeft: 0.6, smileRight: 0.4, frownLeft: 0.1, frownRight: 0,
      pucker: 0.6, funnel: 0.5, cheekPuff: 0.7 });
    expect(mixArkitMouth(pose)).toEqual(pose);
    expect(pose.pucker + pose.funnel + Math.max(pose.smileLeft, pose.smileRight)).toBeLessThanOrEqual(1);
  });
  it('does not stack lip narrowing and puff on a full ARKit smile', () => {
    const pose = mixArkitMouth({ smileLeft: 1, smileRight: 1, frownLeft: 0, frownRight: 0,
      pucker: 0.8, funnel: 0.7, cheekPuff: 1 });
    expect(pose.smileLeft).toBe(1);
    expect(pose.smileRight).toBe(1);
    expect(pose.pucker).toBe(0);
    expect(pose.funnel).toBe(0);
    expect(pose.cheekPuff).toBe(0);
  });
  it('preserves ARKit asymmetry and speech without opposing corner pulls', () => {
    const pose = mixArkitMouth({ smileLeft: 0.7, smileRight: 0.1, frownLeft: 0.2, frownRight: 0.6,
      pucker: 1, funnel: 1, cheekPuff: 0 });
    expect(pose.smileLeft).toBeCloseTo(0.5);
    expect(pose.frownLeft).toBe(0);
    expect(pose.smileRight).toBe(0);
    expect(pose.frownRight).toBeCloseTo(0.5);
    expect(pose.pucker + pose.funnel).toBeCloseTo(0.5);
  });
  it('bounds overlapping smile and vowel deformations while preserving proportions', () => {
    const weights = mixStandardMouth({ aa: 1, oh: 0.5, ih: 0.25, ou: 0.25, ee: 0.5, happy: 1 });
    expect(Object.values(weights).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
    expect(weights.happy).toBe(weights.aa);
    expect(weights.oh).toBeCloseTo(weights.aa / 2);
  });
  it('preserves a single smile and releases all shapes at neutral', () => {
    const neutral = { aa: 0, oh: 0, ih: 0, ou: 0, ee: 0, happy: 0 };
    expect(mixStandardMouth(neutral)).toEqual(neutral);
    expect(mixStandardMouth({ ...neutral, happy: 0.8 }).happy).toBe(0.8);
    expect(mixStandardMouth({ ...neutral, aa: NaN, oh: Infinity, ih: -1 })).toEqual(neutral);
  });
  const landmarks = () => {
    const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
    lm[33] = { x: 0.3, y: 0.3 }; lm[263] = { x: 0.7, y: 0.3 };
    lm[61] = { x: 0.35, y: 0.57 }; lm[291] = { x: 0.65, y: 0.56 };
    lm[13] = { x: 0.5, y: 0.6 }; lm[14] = { x: 0.5, y: 0.66 };
    return lm;
  };
  it('preserves smile asymmetry and jaw aperture during head roll in a widescreen image', () => {
    const lm = landmarks();
    const aspect = 16 / 9;
    const baseline = measureMouth(lm, aspect);
    for (const angle of [-0.7, 0.5]) {
      const rotated = lm.map(p => ({
        x: (p.x * aspect * Math.cos(angle) - p.y * Math.sin(angle)) / aspect,
        y: p.x * aspect * Math.sin(angle) + p.y * Math.cos(angle),
      }));
      const actual = measureMouth(rotated, aspect);
      expect(actual.openRatio).toBeCloseTo(baseline.openRatio, 8);
      expect(actual.cornerLeft).toBeCloseTo(baseline.cornerLeft, 8);
      expect(actual.cornerRight).toBeCloseTo(baseline.cornerRight, 8);
    }
  });
  it('keeps a modest open smile below half jaw travel, but allows a fully open jaw', () => {
    expect(jawOpenFromRatio(0.2, 1.2)).toBeLessThan(0.5);
    expect(jawOpenFromRatio(0, 1.2)).toBe(0);
    expect(jawOpenFromRatio(0.8, 1.2)).toBe(1);
  });
});
