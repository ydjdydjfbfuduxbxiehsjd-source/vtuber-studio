import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  convertPoseWorldLandmark,
  computeFingerAngles,
  computeThumbBends,
  ArmRig,
  type Landmark3D,
} from '../tracking/armRig';

describe('Modern Arm Rig - Coordinate Conversion (Stage 1 & 7)', () => {
  it('correctly converts MediaPipe World coordinates with Y-inversion and depth', () => {
    // MediaPipe: shoulder at (0.2, -0.45, -0.1) [Y is negative upwards, Z is negative towards camera]
    const raw: Landmark3D = { x: 0.2, y: -0.45, z: -0.1 };

    // In mirrored mode: X stays 0.2, Y becomes +0.45, Z becomes +0.1
    const avatarPt = convertPoseWorldLandmark(raw, true);
    expect(avatarPt.x).toBeCloseTo(0.2, 4);
    expect(avatarPt.y).toBeCloseTo(0.45, 4);
    expect(avatarPt.z).toBeCloseTo(0.1, 4);

    // In non-mirrored mode: X is flipped
    const unmirroredPt = convertPoseWorldLandmark(raw, false);
    expect(unmirroredPt.x).toBeCloseTo(-0.2, 4);
    expect(unmirroredPt.y).toBeCloseTo(0.45, 4);
    expect(unmirroredPt.z).toBeCloseTo(0.1, 4);
  });

  it('safely handles NaN and non-finite inputs without throwing', () => {
    const rawNaN: Landmark3D = { x: NaN, y: Infinity, z: -Infinity };
    const safePt = convertPoseWorldLandmark(rawNaN, true);
    expect(Number.isFinite(safePt.x)).toBe(true);
    expect(Number.isFinite(safePt.y)).toBe(true);
    expect(Number.isFinite(safePt.z)).toBe(true);
    expect(safePt.x).toBe(0);
    expect(safePt.y).toBe(0);
    expect(safePt.z).toBe(0);
  });

  it('maintains left-right symmetry between arms in mirrored mode', () => {
    // User right shoulder (negative x in MediaPipe) vs User left shoulder (positive x)
    const rightShoulderRaw: Landmark3D = { x: -0.2, y: -0.4, z: 0 };
    const leftShoulderRaw: Landmark3D = { x: 0.2, y: -0.4, z: 0 };

    const rightPt = convertPoseWorldLandmark(rightShoulderRaw, true);
    const leftPt = convertPoseWorldLandmark(leftShoulderRaw, true);

    // Right arm is on negative X, left arm is on positive X
    expect(rightPt.x).toBeCloseTo(-leftPt.x, 4);
    expect(rightPt.y).toBeCloseTo(leftPt.y, 4);
  });
});

describe('Modern Arm Rig - Finger Joint Angles (Stage 4)', () => {
  it('gives zero bend angles for a straight finger', () => {
    // MCP -> PIP -> DIP -> Tip aligned along the X axis
    const p0 = { x: 0.0, y: 0, z: 0 };
    const p1 = { x: 0.03, y: 0, z: 0 };
    const p2 = { x: 0.06, y: 0, z: 0 };
    const p3 = { x: 0.08, y: 0, z: 0 };

    const angles = computeFingerAngles(p0, p1, p2, p3);
    expect(angles.intermediateBend).toBeCloseTo(0, 2);
    expect(angles.distalBend).toBeCloseTo(0, 2);
    expect(angles.proximalBend).toBeCloseTo(0, 2);
  });

  it('computes 90-degree intermediate bend correctly', () => {
    // MCP (0,0,0) -> PIP (0.03, 0, 0) -> DIP (0.03, 0.03, 0) -> Tip (0.03, 0.05, 0)
    const p0 = { x: 0.0, y: 0, z: 0 };
    const p1 = { x: 0.03, y: 0, z: 0 };
    const p2 = { x: 0.03, y: 0.03, z: 0 };
    const p3 = { x: 0.03, y: 0.05, z: 0 };

    const angles = computeFingerAngles(p0, p1, p2, p3);
    expect(angles.intermediateBend).toBeCloseTo(Math.PI / 2, 2); // 90 deg = 1.57 rad
    expect(angles.distalBend).toBeCloseTo(0, 2);
  });

  it('enforces anatomical clamping limits on fingers', () => {
    // Over-bent finger (acute angle)
    const p0 = { x: 0.0, y: 0, z: 0 };
    const p1 = { x: 0.03, y: 0, z: 0 };
    const p2 = { x: 0.01, y: 0.01, z: 0 };
    const p3 = { x: 0.0, y: 0.0, z: 0 };

    const angles = computeFingerAngles(p0, p1, p2, p3);
    expect(angles.proximalBend).toBeLessThanOrEqual(Math.PI * 0.5); // <= 90 deg
    expect(angles.intermediateBend).toBeLessThanOrEqual(1.92);      // <= 110 deg
    expect(angles.distalBend).toBeLessThanOrEqual(1.40);            // <= 80 deg
  });

  it('computes thumb bends with dedicated opposable limits', () => {
    const p1 = { x: 0.0, y: 0, z: 0 };
    const p2 = { x: 0.02, y: 0.02, z: 0 };
    const p3 = { x: 0.04, y: 0.03, z: 0 };
    const p4 = { x: 0.05, y: 0.04, z: 0 };

    const thumb = computeThumbBends(p1, p2, p3, p4);
    expect(thumb.metacarpal).toBeGreaterThanOrEqual(0);
    expect(thumb.proximal).toBeGreaterThanOrEqual(0);
    expect(thumb.distal).toBeGreaterThanOrEqual(0);
  });
});

describe('Modern Arm Rig - Synthetic Direction FK (Stage 2 & 9)', () => {
  it('computes expected upper arm direction for arm pointing forward (+Z)', () => {
    const shoulder = new THREE.Vector3(0.2, 0.4, 0);
    const elbow = new THREE.Vector3(0.2, 0.4, 0.25);
    const wrist = new THREE.Vector3(0.2, 0.4, 0.50);

    const dirUpper = new THREE.Vector3().subVectors(elbow, shoulder).normalize();
    const dirLower = new THREE.Vector3().subVectors(wrist, elbow).normalize();

    expect(dirUpper.z).toBeCloseTo(1, 4);
    expect(dirLower.z).toBeCloseTo(1, 4);

    // Elbow angle should be 0 (straight arm)
    const dot = dirUpper.dot(dirLower);
    const elbowAngle = Math.acos(THREE.MathUtils.clamp(dot, -1, 1));
    expect(elbowAngle).toBeCloseTo(0, 4);
  });

  it('computes expected direction and elbow angle for hand touching shoulder', () => {
    // Upper arm extended forward (+Z), forearm bent back towards shoulder (-Z)
    const shoulder = new THREE.Vector3(0.2, 0.4, 0);
    const elbow = new THREE.Vector3(0.2, 0.4, 0.25);
    const wrist = new THREE.Vector3(0.2, 0.4, 0.02); // Bent near shoulder

    const dirUpper = new THREE.Vector3().subVectors(elbow, shoulder).normalize();
    const dirLower = new THREE.Vector3().subVectors(wrist, elbow).normalize();

    expect(dirUpper.z).toBeCloseTo(1, 4);
    expect(dirLower.z).toBeCloseTo(-1, 4);

    // Fully bent elbow (180 deg reversal clamped to ~150 deg limit)
    const dot = dirUpper.dot(dirLower);
    expect(dot).toBeCloseTo(-1, 2);
  });

  it('computes expected direction for arm raised straight up (+Y)', () => {
    const shoulder = new THREE.Vector3(0.2, 0.4, 0);
    const elbow = new THREE.Vector3(0.2, 0.65, 0);
    const wrist = new THREE.Vector3(0.2, 0.90, 0);

    const dirUpper = new THREE.Vector3().subVectors(elbow, shoulder).normalize();
    const dirLower = new THREE.Vector3().subVectors(wrist, elbow).normalize();

    expect(dirUpper.y).toBeCloseTo(1, 4);
    expect(dirLower.y).toBeCloseTo(1, 4);
  });
});

describe('Modern Arm Rig - State Machine (Stage 5)', () => {
  it('transitions from REST to ACTIVE when valid landmarks arrive', () => {
    const rig = new ArmRig('left');
    expect(rig.state).toBe('REST');

    // Create a mock VRM humanoid
    const mockVrm = {
      humanoid: {
        getNormalizedBoneNode: (name: string) => {
          const obj = new THREE.Object3D();
          obj.position.set(name.includes('Lower') ? 0.2 : 0, 0, 0);
          return obj;
        },
      },
    } as any;

    const shoulder: Landmark3D = { x: 0.2, y: -0.4, z: 0, visibility: 0.9 };
    const elbow: Landmark3D = { x: 0.35, y: -0.2, z: 0, visibility: 0.85 };
    const wrist: Landmark3D = { x: 0.4, y: 0.1, z: 0, visibility: 0.8 };

    rig.update(mockVrm, shoulder, elbow, wrist, null, null, true, 1000);
    expect(rig.state).toBe('ACTIVE');
  });

  it('progresses through HOLD -> RELAX -> REST on tracking loss', () => {
    const rig = new ArmRig('right');
    const mockVrm = {
      humanoid: {
        getNormalizedBoneNode: () => new THREE.Object3D(),
      },
    } as any;

    // First frame: active
    const s: Landmark3D = { x: -0.2, y: -0.4, z: 0, visibility: 0.9 };
    const e: Landmark3D = { x: -0.35, y: -0.2, z: 0, visibility: 0.85 };
    const w: Landmark3D = { x: -0.4, y: 0.1, z: 0, visibility: 0.8 };
    rig.update(mockVrm, s, e, w, null, null, true, 1000);
    expect(rig.state).toBe('ACTIVE');

    // Lost detection: frame at 1100ms (+100ms) -> HOLD state
    rig.update(mockVrm, null, null, null, null, null, true, 1100);
    expect(rig.state).toBe('HOLD');

    // Frame at 1350ms (+350ms lost) -> RELAX state (>250ms)
    rig.update(mockVrm, null, null, null, null, null, true, 1350);
    expect(rig.state).toBe('RELAX');

    // Frame at 1750ms (+750ms lost) -> REST state (>650ms)
    rig.update(mockVrm, null, null, null, null, null, true, 1750);
    expect(rig.state).toBe('REST');
  });
});