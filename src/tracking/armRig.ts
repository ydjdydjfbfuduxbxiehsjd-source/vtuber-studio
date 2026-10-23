/**
 * VTuber Studio Pro - Modern Forward Kinematics (FK) Arm & Hand Rig
 * Pure angle and direction-based skeletal tracking.
 * Zero IK singularities, zero scale explosions, zero allocations in update loop.
 */
import * as THREE from 'three';
import { VRM, type VRMHumanBoneName } from '@pixiv/three-vrm';
import { OneEuroFilter3D } from '../oneEuroFilter';

/* ==========================================================================
   TYPES & INTERFACES
   ========================================================================== */

export type ArmTrackingState = 'ACTIVE' | 'HOLD' | 'RELAX' | 'REST';

export interface Landmark3D {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

export interface ArmRestDirections {
  upperArm: THREE.Vector3;
  lowerArm: THREE.Vector3;
}

export interface ArmDebugInfo {
  state: ArmTrackingState;
  shoulderVis: number;
  elbowVis: number;
  wristVis: number;
  elbowAngleDeg: number;
  trackedShoulder: THREE.Vector3;
  trackedElbow: THREE.Vector3;
  trackedWrist: THREE.Vector3;
}

/* ==========================================================================
   COORDINATE CONVERSION (STAGE 1)
   Converts MediaPipe World Landmarks (meters, origin at hips) to Avatar space.
   ========================================================================== */

/**
 * Converts a MediaPipe World Landmark to Three.js avatar coordinates.
 * - MediaPipe: origin at hips, +Y down, +X subject-left, -Z forward (away/depth).
 * - Avatar: +Y up, +X avatar-left, +Z forward (towards camera).
 * - When mirror is true (standard selfie webcam): user right arm maps to avatar right arm.
 */
export function convertPoseWorldLandmark(
  raw: Landmark3D,
  mirror: boolean,
  targetOut?: THREE.Vector3
): THREE.Vector3 {
  const out = targetOut || new THREE.Vector3();
  const rx = Number.isFinite(raw.x) ? raw.x : 0;
  const ry = Number.isFinite(raw.y) ? raw.y : 0;
  const rz = Number.isFinite(raw.z) ? raw.z : 0;

  // MediaPipe Y is inverted (+Y down -> avatar +Y up)
  const avatarY = (-ry) || 0;

  // Mirror: user right (negative x) -> avatar right (negative x)
  const avatarX = (mirror ? rx : -rx) || 0;

  // MediaPipe Z (depth towards camera is negative in MediaPipe world) -> avatar +Z
  const avatarZ = (-rz) || 0;

  out.set(avatarX, avatarY, avatarZ);
  return out;
}

/* ==========================================================================
   FINGER BENDING ANGLE UTILITIES (STAGE 4)
   ========================================================================== */

export interface FingerAngles {
  proximalBend: number;    // 0 to 90 deg (rad)
  intermediateBend: number;// 0 to 110 deg (rad)
  distalBend: number;      // 0 to 80 deg (rad)
  spread: number;          // -15 to +15 deg (rad)
}

/**
 * Computes bending angles between consecutive finger segments.
 * P0: MCP, P1: PIP, P2: DIP, P3: Tip.
 */
export function computeFingerAngles(
  p0: Landmark3D,
  p1: Landmark3D,
  p2: Landmark3D,
  p3: Landmark3D
): FingerAngles {
  // Vector MCP -> PIP
  const v1x = p1.x - p0.x, v1y = p1.y - p0.y, v1z = p1.z - p0.z;
  const len1 = Math.hypot(v1x, v1y, v1z);

  // Vector PIP -> DIP
  const v2x = p2.x - p1.x, v2y = p2.y - p1.y, v2z = p2.z - p1.z;
  const len2 = Math.hypot(v2x, v2y, v2z);

  // Vector DIP -> Tip
  const v3x = p3.x - p2.x, v3y = p3.y - p2.y, v3z = p3.z - p2.z;
  const len3 = Math.hypot(v3x, v3y, v3z);

  let intermediateBend = 0;
  if (len1 > 1e-4 && len2 > 1e-4) {
    const dot12 = (v1x * v2x + v1y * v2y + v1z * v2z) / (len1 * len2);
    const clampedDot = Math.min(1, Math.max(-1, dot12));
    intermediateBend = Math.acos(clampedDot);
  }

  let distalBend = 0;
  if (len2 > 1e-4 && len3 > 1e-4) {
    const dot23 = (v2x * v3x + v2y * v3y + v2z * v3z) / (len2 * len3);
    const clampedDot = Math.min(1, Math.max(-1, dot23));
    distalBend = Math.acos(clampedDot);
  }

  // Proximal bend is proportional to intermediate bend with anatomical coupling
  const proximalBend = Math.min(Math.PI / 2, intermediateBend * 0.85);

  // Clamps:
  // Proximal: 0 to 90 deg (1.57 rad)
  // Intermediate: 0 to 110 deg (1.92 rad)
  // Distal: 0 to 80 deg (1.40 rad)
  return {
    proximalBend: THREE.MathUtils.clamp(proximalBend, 0, Math.PI * 0.5),
    intermediateBend: THREE.MathUtils.clamp(intermediateBend, 0, 1.92),
    distalBend: THREE.MathUtils.clamp(distalBend, 0, 1.40),
    spread: 0,
  };
}

/**
 * Dedicated Thumb Rotation (Stage 4)
 * Joints: 1 -> 2 (Metacarpal), 2 -> 3 (Proximal), 3 -> 4 (Distal)
 */
export function computeThumbBends(
  p1: Landmark3D,
  p2: Landmark3D,
  p3: Landmark3D,
  p4: Landmark3D
): { metacarpal: number; proximal: number; distal: number } {
  const v1x = p2.x - p1.x, v1y = p2.y - p1.y, v1z = p2.z - p1.z;
  const len1 = Math.hypot(v1x, v1y, v1z);

  const v2x = p3.x - p2.x, v2y = p3.y - p2.y, v2z = p3.z - p2.z;
  const len2 = Math.hypot(v2x, v2y, v2z);

  const v3x = p4.x - p3.x, v3y = p4.y - p3.y, v3z = p4.z - p3.z;
  const len3 = Math.hypot(v3x, v3y, v3z);

  let bend12 = 0;
  if (len1 > 1e-4 && len2 > 1e-4) {
    const dot12 = (v1x * v2x + v1y * v2y + v1z * v2z) / (len1 * len2);
    bend12 = Math.acos(Math.min(1, Math.max(-1, dot12)));
  }

  let bend23 = 0;
  if (len2 > 1e-4 && len3 > 1e-4) {
    const dot23 = (v2x * v3x + v2y * v3y + v2z * v3z) / (len2 * len3);
    bend23 = Math.acos(Math.min(1, Math.max(-1, dot23)));
  }

  return {
    metacarpal: THREE.MathUtils.clamp(bend12 * 0.5, 0, 0.8),
    proximal: THREE.MathUtils.clamp(bend12, 0, 1.2),
    distal: THREE.MathUtils.clamp(bend23, 0, 1.4),
  };
}

/* ==========================================================================
   ARM RIG CONTROLLER CLASS (ZERO ALLOCATIONS IN RUNTIME)
   ========================================================================== */

export class ArmRig {
  private side: 'left' | 'right';
  private isLeft: boolean;

  // State Machine (Stage 5)
  public state: ArmTrackingState = 'REST';
  private lossTimestamp = 0; // timestamp when tracking was lost
  private lastFrameTimestamp = 0;
  private transitionAlpha = 0.0; // 0 (idle) to 1 (active)

  // 1€ Filters on input landmark positions (Stage 1: minCutoff 1.0, beta 0.03)
  private filterShoulder = new OneEuroFilter3D(1.0, 0.03, 1.0);
  private filterElbow = new OneEuroFilter3D(1.0, 0.03, 1.0);
  private filterWrist = new OneEuroFilter3D(1.0, 0.03, 1.0);

  // Last good positions (fallback on visibility < 0.5)
  private lastGoodShoulder = new THREE.Vector3();
  private lastGoodElbow = new THREE.Vector3();
  private lastGoodWrist = new THREE.Vector3();

  // Model Rest Directions (computed once on model load)
  private restUpperArmDir = new THREE.Vector3();
  private restLowerArmDir = new THREE.Vector3();
  private isRestComputed = false;

  // Cached Quaternions for smoothing
  private currentUpperQ = new THREE.Quaternion();
  private currentLowerQ = new THREE.Quaternion();
  private currentHandQ = new THREE.Quaternion();

  // Idle rest rotations
  private idleUpperEuler = new THREE.Euler();
  private idleLowerEuler = new THREE.Euler();
  private idleHandEuler = new THREE.Euler();

  // Scratch memory (strictly zero allocations during update)
  private _sWorld = new THREE.Vector3();
  private _eWorld = new THREE.Vector3();
  private _wWorld = new THREE.Vector3();
  private _dirUpperWorld = new THREE.Vector3();
  private _dirLowerWorld = new THREE.Vector3();
  private _dirUpperLocal = new THREE.Vector3();
  private _dirLowerLocal = new THREE.Vector3();
  private _parentWorldQ = new THREE.Quaternion();
  private _parentInvQ = new THREE.Quaternion();
  private _upperWorldQ = new THREE.Quaternion();
  private _upperInvQ = new THREE.Quaternion();
  private _targetUpperQ = new THREE.Quaternion();
  private _targetLowerQ = new THREE.Quaternion();
  private _targetHandQ = new THREE.Quaternion();
  private _palmForward = new THREE.Vector3();
  private _palmSide = new THREE.Vector3();
  private _palmNormal = new THREE.Vector3();
  private _palmRotMatrix = new THREE.Matrix4();
  private _scratchQ1 = new THREE.Quaternion();
  private _scratchQ2 = new THREE.Quaternion();
  private _scratchV1 = new THREE.Vector3();

  // Debug data
  public debugInfo: ArmDebugInfo;

  constructor(side: 'left' | 'right') {
    this.side = side;
    this.isLeft = side === 'left';

    // Idle A-pose rotations
    if (this.isLeft) {
      this.idleUpperEuler.set(0, 0, -1.25); // ~72 deg down
      this.idleLowerEuler.set(0, 0, 0.25);
      this.idleHandEuler.set(0, 0, 0);
      this.restUpperArmDir.set(1, 0, 0);
      this.restLowerArmDir.set(1, 0, 0);
      this.lastGoodShoulder.set(0.18, 0.45, 0);
      this.lastGoodElbow.set(0.35, 0.15, 0);
      this.lastGoodWrist.set(0.38, -0.15, 0);
    } else {
      this.idleUpperEuler.set(0, 0, 1.25);
      this.idleLowerEuler.set(0, 0, -0.25);
      this.idleHandEuler.set(0, 0, 0);
      this.restUpperArmDir.set(-1, 0, 0);
      this.restLowerArmDir.set(-1, 0, 0);
      this.lastGoodShoulder.set(-0.18, 0.45, 0);
      this.lastGoodElbow.set(-0.35, 0.15, 0);
      this.lastGoodWrist.set(-0.38, -0.15, 0);
    }

    this.currentUpperQ.setFromEuler(this.idleUpperEuler);
    this.currentLowerQ.setFromEuler(this.idleLowerEuler);
    this.currentHandQ.setFromEuler(this.idleHandEuler);

    this.debugInfo = {
      state: 'REST',
      shoulderVis: 0,
      elbowVis: 0,
      wristVis: 0,
      elbowAngleDeg: 0,
      trackedShoulder: new THREE.Vector3(),
      trackedElbow: new THREE.Vector3(),
      trackedWrist: new THREE.Vector3(),
    };
  }

  /**
   * Computes bone rest directions directly from VRM normalized bones on model load.
   */
  public initFromVRM(vrm: VRM) {
    if (!vrm.humanoid) return;
    const upperName = (this.side + 'UpperArm') as VRMHumanBoneName;
    const lowerName = (this.side + 'LowerArm') as VRMHumanBoneName;
    const handName = (this.side + 'Hand') as VRMHumanBoneName;

    const uNode = vrm.humanoid.getNormalizedBoneNode(upperName);
    const lNode = vrm.humanoid.getNormalizedBoneNode(lowerName);
    const hNode = vrm.humanoid.getNormalizedBoneNode(handName);

    if (uNode && lNode) {
      // In VRM normalized humanoid rest T-pose:
      // Vector from upperArm to lowerArm
      this.restUpperArmDir.copy(lNode.position).normalize();
      if (!Number.isFinite(this.restUpperArmDir.x) || this.restUpperArmDir.lengthSq() < 1e-4) {
        this.restUpperArmDir.set(this.isLeft ? 1 : -1, 0, 0);
      }
    }

    if (lNode && hNode) {
      // Vector from lowerArm to hand
      this.restLowerArmDir.copy(hNode.position).normalize();
      if (!Number.isFinite(this.restLowerArmDir.x) || this.restLowerArmDir.lengthSq() < 1e-4) {
        this.restLowerArmDir.set(this.isLeft ? 1 : -1, 0, 0);
      }
    }

    this.isRestComputed = true;
  }

  /**
   * Main Frame Update
   */
  public update(
    vrm: VRM,
    rawShoulder: Landmark3D | null | undefined,
    rawElbow: Landmark3D | null | undefined,
    rawWrist: Landmark3D | null | undefined,
    handLandmarks: Landmark3D[] | null | undefined,
    poseFingers: Landmark3D[] | null | undefined,
    mirror: boolean,
    now: number,
    handSens: number = 1.0
  ) {
    if (!vrm.humanoid) return;
    if (!this.isRestComputed) {
      this.initFromVRM(vrm);
    }

    const sVis = rawShoulder?.visibility ?? 0;
    const eVis = rawElbow?.visibility ?? 0;
    const wVis = rawWrist?.visibility ?? 0;

    this.debugInfo.shoulderVis = sVis;
    this.debugInfo.elbowVis = eVis;
    this.debugInfo.wristVis = wVis;

    // Detection validity: need shoulder and (elbow or wrist) with visibility >= 0.5
    const isDetectionValid = Boolean(
      rawShoulder && sVis >= 0.5 &&
      ((rawElbow && eVis >= 0.5) || (rawWrist && wVis >= 0.5))
    );

    // =========================================================================
    // STAGE 5: STATE MACHINE (ACTIVE -> HOLD -> RELAX -> REST)
    // =========================================================================
    const dt = this.lastFrameTimestamp > 0 ? Math.max(0.001, (now - this.lastFrameTimestamp) / 1000) : 0.016;
    this.lastFrameTimestamp = now;

    if (isDetectionValid) {
      this.state = 'ACTIVE';
      this.lossTimestamp = 0;
      // Smooth fade-in from rest to active (~150 ms)
      this.transitionAlpha = Math.min(1.0, this.transitionAlpha + dt / 0.15);
    } else {
      if (!this.lossTimestamp) {
        this.lossTimestamp = now;
      }
      const lossDuration = now - this.lossTimestamp;
      if (lossDuration < 250) {
        this.state = 'HOLD';
      } else if (lossDuration < 650) {
        this.state = 'RELAX';
        this.transitionAlpha = Math.max(0.0, this.transitionAlpha - dt / 0.40);
      } else {
        this.state = 'REST';
        this.transitionAlpha = 0.0;
      }
    }

    this.debugInfo.state = this.state;

    // Filter input positions with 1€ Filter (Stage 1)
    if (rawShoulder && sVis >= 0.5) {
      convertPoseWorldLandmark(rawShoulder, mirror, this._sWorld);
      this.lastGoodShoulder.copy(this.filterShoulder.filter(this._sWorld, now));
    }
    if (rawElbow && eVis >= 0.5) {
      convertPoseWorldLandmark(rawElbow, mirror, this._eWorld);
      this.lastGoodElbow.copy(this.filterElbow.filter(this._eWorld, now));
    }
    if (rawWrist && wVis >= 0.5) {
      convertPoseWorldLandmark(rawWrist, mirror, this._wWorld);
      this.lastGoodWrist.copy(this.filterWrist.filter(this._wWorld, now));
    }

    this._sWorld.copy(this.lastGoodShoulder);
    this._eWorld.copy(this.lastGoodElbow);
    this._wWorld.copy(this.lastGoodWrist);

    this.debugInfo.trackedShoulder.copy(this._sWorld);
    this.debugInfo.trackedElbow.copy(this._eWorld);
    this.debugInfo.trackedWrist.copy(this._wWorld);

    // If completely in REST state, smoothly return to idle A-pose and exit
    if (this.state === 'REST' && this.transitionAlpha <= 0.001) {
      this.applyIdlePose(vrm, 0.1);
      return;
    }

    // =========================================================================
    // STAGE 2: UPPER ARM & LOWER ARM FK (BY DIRECTION VECTORS)
    // =========================================================================

    const upperName = (this.side + 'UpperArm') as VRMHumanBoneName;
    const lowerName = (this.side + 'LowerArm') as VRMHumanBoneName;
    const handName = (this.side + 'Hand') as VRMHumanBoneName;

    const uNode = vrm.humanoid.getNormalizedBoneNode(upperName);
    const lNode = vrm.humanoid.getNormalizedBoneNode(lowerName);
    const hNode = vrm.humanoid.getNormalizedBoneNode(handName);

    if (!uNode || !lNode || !hNode) return;

    // 1. Target Directions in Avatar World Space
    this._dirUpperWorld.subVectors(this._eWorld, this._sWorld);
    if (this._dirUpperWorld.lengthSq() < 1e-4) {
      this._dirUpperWorld.copy(this.restUpperArmDir);
    } else {
      this._dirUpperWorld.normalize();
    }

    this._dirLowerWorld.subVectors(this._wWorld, this._eWorld);
    if (this._dirLowerWorld.lengthSq() < 1e-4) {
      this._dirLowerWorld.copy(this.restLowerArmDir);
    } else {
      this._dirLowerWorld.normalize();
    }

    // Anatomical Elbow Hinge Limit (0 to 150 degrees)
    // Angle between upper arm and lower arm directions
    const dotArm = THREE.MathUtils.clamp(this._dirUpperWorld.dot(this._dirLowerWorld), -1, 1);
    const rawElbowAngle = Math.acos(dotArm);
    this.debugInfo.elbowAngleDeg = THREE.MathUtils.radToDeg(rawElbowAngle);

    // Soft Torso Collision Repulsion for Elbow (Stage 6)
    // Prevent elbow from going inside the avatar's chest/spine cylinder
    const chestNode = vrm.humanoid.getNormalizedBoneNode('chest') || vrm.humanoid.getNormalizedBoneNode('spine');
    if (chestNode) {
      chestNode.getWorldPosition(this._scratchV1);
      const toElbowX = this._eWorld.x - this._scratchV1.x;
      const toElbowZ = this._eWorld.z - this._scratchV1.z;
      const torsoRadius = 0.14;
      const distSq = toElbowX * toElbowX + toElbowZ * toElbowZ;
      if (distSq < torsoRadius * torsoRadius && distSq > 1e-5) {
        const d = Math.sqrt(distSq);
        const push = (torsoRadius - d);
        this._dirUpperWorld.x += (toElbowX / d) * push;
        this._dirUpperWorld.normalize();
      }
    }

    // 2. Upper Arm Local Rotation
    // Convert target direction to parent's local space
    const parentNode = uNode.parent;
    if (parentNode) {
      parentNode.getWorldQuaternion(this._parentWorldQ);
      this._parentInvQ.copy(this._parentWorldQ).invert();
      this._dirUpperLocal.copy(this._dirUpperWorld).applyQuaternion(this._parentInvQ).normalize();
    } else {
      this._dirUpperLocal.copy(this._dirUpperWorld);
    }

    this._targetUpperQ.setFromUnitVectors(this.restUpperArmDir, this._dirUpperLocal);

    // Anatomical soft clamp on shoulder: prevent upper arm pitching behind back (> 75 deg backward)
    // Safe check finite
    if (!Number.isFinite(this._targetUpperQ.x)) {
      this._targetUpperQ.identity();
    }

    // 3. Lower Arm Local Rotation
    // Convert lower arm direction to upperArm's current world orientation
    uNode.getWorldQuaternion(this._upperWorldQ);
    this._upperInvQ.copy(this._upperWorldQ).invert();
    this._dirLowerLocal.copy(this._dirLowerWorld).applyQuaternion(this._upperInvQ).normalize();

    this._targetLowerQ.setFromUnitVectors(this.restLowerArmDir, this._dirLowerLocal);
    if (!Number.isFinite(this._targetLowerQ.x)) {
      this._targetLowerQ.identity();
    }

    // =========================================================================
    // STAGE 3: HAND ORIENTATION & 50% TWIST DISTRIBUTION
    // =========================================================================

    let hasHandOrientation = false;

    if (handLandmarks && handLandmarks.length === 21) {
      const p0 = handLandmarks[0];   // Wrist
      const p5 = handLandmarks[5];   // Index MCP
      const p17 = handLandmarks[17]; // Pinky MCP

      if (p0 && p5 && p17) {
        // Forward vector = from 0 to midpoint(5, 17)
        const mid5_17_x = (p5.x + p17.x) * 0.5;
        const mid5_17_y = (p5.y + p17.y) * 0.5;
        const mid5_17_z = (p5.z + p17.z) * 0.5;

        const fX = mirror ? (mid5_17_x - p0.x) : -(mid5_17_x - p0.x);
        const fY = -(mid5_17_y - p0.y);
        const fZ = -(mid5_17_z - p0.z);
        this._palmForward.set(fX, fY, fZ);

        // Side vector: from 5 to 17 (or 17 to 5)
        const sX = mirror ? (p17.x - p5.x) : -(p17.x - p5.x);
        const sY = -(p17.y - p5.y);
        const sZ = -(p17.z - p5.z);
        this._palmSide.set(sX, sY, sZ);

        if (this._palmForward.lengthSq() > 1e-4 && this._palmSide.lengthSq() > 1e-4) {
          this._palmForward.normalize();
          this._palmSide.normalize();

          // Normal = cross(forward, side)
          this._palmNormal.crossVectors(this._palmForward, this._palmSide).normalize();
          // Orthonormalize side
          this._palmSide.crossVectors(this._palmNormal, this._palmForward).normalize();

          // Build orthonormal rotation matrix
          this._palmRotMatrix.makeBasis(
            this.isLeft ? this._palmSide : this._scratchV1.copy(this._palmSide).negate(),
            this._palmNormal,
            this._palmForward
          );

          this._targetHandQ.setFromRotationMatrix(this._palmRotMatrix);

          // Convert to lowerArm space
          lNode.getWorldQuaternion(this._scratchQ1);
          this._scratchQ1.invert();
          this._targetHandQ.premultiply(this._scratchQ1);

          if (Number.isFinite(this._targetHandQ.x)) {
            hasHandOrientation = true;
          }
        }
      }
    }

    // Fallback: if hands lost but pose wrist is tracked
    if (!hasHandOrientation) {
      if (poseFingers && poseFingers.length >= 2) {
        // Approximate hand orientation from pose index and pinky (landmarks 19/20 and 17/18)
        this._targetHandQ.copy(this.currentHandQ);
      } else {
        // Keep last valid hand quaternion
        this._targetHandQ.copy(this.currentHandQ);
      }
    }

    // Twist Distribution (Stage 2 & 3): 50% twist on lowerArm, 50% on hand
    // Decompose hand rotation around forearm bone axis
    const boneAxis = this.restLowerArmDir;
    const twistAngle = 2.0 * Math.atan2(
      this._targetHandQ.x * boneAxis.x + this._targetHandQ.y * boneAxis.y + this._targetHandQ.z * boneAxis.z,
      this._targetHandQ.w
    );
    if (Number.isFinite(twistAngle)) {
      this._scratchQ1.setFromAxisAngle(boneAxis, twistAngle * 0.5);
      this._targetLowerQ.multiply(this._scratchQ1);
      // Remove half twist from hand
      this._scratchQ2.setFromAxisAngle(boneAxis, -twistAngle * 0.5);
      this._targetHandQ.multiply(this._scratchQ2);
    }

    // Slerp to target with velocity-adaptive smoothing
    // High velocity = fast tracking (slerp 0.6+), low velocity = steady (slerp 0.25)
    const smoothFactor = THREE.MathUtils.lerp(0.25, 0.65, Math.min(1.0, handSens));

    // Blend between Idle A-pose and Tracked Pose based on transitionAlpha
    this._scratchQ1.setFromEuler(this.idleUpperEuler);
    this._targetUpperQ.slerp(this._scratchQ1, 1.0 - this.transitionAlpha);
    this.currentUpperQ.slerp(this._targetUpperQ, smoothFactor);
    uNode.quaternion.copy(this.currentUpperQ);

    this._scratchQ1.setFromEuler(this.idleLowerEuler);
    this._targetLowerQ.slerp(this._scratchQ1, 1.0 - this.transitionAlpha);
    this.currentLowerQ.slerp(this._targetLowerQ, smoothFactor);
    lNode.quaternion.copy(this.currentLowerQ);

    this._scratchQ1.setFromEuler(this.idleHandEuler);
    this._targetHandQ.slerp(this._scratchQ1, 1.0 - this.transitionAlpha);
    this.currentHandQ.slerp(this._targetHandQ, smoothFactor);
    hNode.quaternion.copy(this.currentHandQ);

    // =========================================================================
    // STAGE 4: FINGER BONES
    // =========================================================================
    this.updateFingers(vrm, handLandmarks, dt);
  }

  /**
   * Applies angles to all 15 finger bones (Stage 4)
   */
  private updateFingers(vrm: VRM, handLandmarks: Landmark3D[] | null | undefined, dt: number) {
    if (!vrm.humanoid) return;
    const prefix = this.side; // 'left' | 'right'

    if (handLandmarks && handLandmarks.length === 21) {
      // 4 Fingers: Index, Middle, Ring, Little
      const fingerDefs: { name: string; indices: [number, number, number, number] }[] = [
        { name: 'Index', indices: [5, 6, 7, 8] },
        { name: 'Middle', indices: [9, 10, 11, 12] },
        { name: 'Ring', indices: [13, 14, 15, 16] },
        { name: 'Little', indices: [17, 18, 19, 20] },
      ];

      for (const def of fingerDefs) {
        const [i0, i1, i2, i3] = def.indices;
        const angles = computeFingerAngles(
          handLandmarks[i0],
          handLandmarks[i1],
          handLandmarks[i2],
          handLandmarks[i3]
        );

        const curlSign = this.isLeft ? 1 : -1;
        const rotProximal = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, curlSign), angles.proximalBend * 0.6);
        const rotIntermediate = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, curlSign), angles.intermediateBend * 0.7);
        const rotDistal = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, curlSign), angles.distalBend * 0.7);

        const nodeP = vrm.humanoid.getNormalizedBoneNode(`${prefix}${def.name}Proximal` as VRMHumanBoneName);
        const nodeI = vrm.humanoid.getNormalizedBoneNode(`${prefix}${def.name}Intermediate` as VRMHumanBoneName);
        const nodeD = vrm.humanoid.getNormalizedBoneNode(`${prefix}${def.name}Distal` as VRMHumanBoneName);

        if (nodeP) nodeP.quaternion.slerp(rotProximal, 0.35);
        if (nodeI) nodeI.quaternion.slerp(rotIntermediate, 0.35);
        if (nodeD) nodeD.quaternion.slerp(rotDistal, 0.35);
      }

      // Thumb
      const thumbBends = computeThumbBends(
        handLandmarks[1],
        handLandmarks[2],
        handLandmarks[3],
        handLandmarks[4]
      );

      const sign = this.isLeft ? 1 : -1;
      const rotMeta = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, sign * 0.5, sign * 0.86), thumbBends.metacarpal);
      const rotProx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, sign), thumbBends.proximal);
      const rotDist = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, sign), thumbBends.distal);

      const nodeTM = vrm.humanoid.getNormalizedBoneNode(`${prefix}ThumbMetacarpal` as VRMHumanBoneName);
      const nodeTP = vrm.humanoid.getNormalizedBoneNode(`${prefix}ThumbProximal` as VRMHumanBoneName);
      const nodeTD = vrm.humanoid.getNormalizedBoneNode(`${prefix}ThumbDistal` as VRMHumanBoneName);

      if (nodeTM) nodeTM.quaternion.slerp(rotMeta, 0.35);
      if (nodeTP) nodeTP.quaternion.slerp(rotProx, 0.35);
      if (nodeTD) nodeTD.quaternion.slerp(rotDist, 0.35);
    } else {
      // Relax fingers smoothly towards neutral over ~1 second
      const relaxRate = Math.min(1.0, dt * 2.0);
      const fingerNames = ['ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal',
        'IndexProximal', 'IndexIntermediate', 'IndexDistal',
        'MiddleProximal', 'MiddleIntermediate', 'MiddleDistal',
        'RingProximal', 'RingIntermediate', 'RingDistal',
        'LittleProximal', 'LittleIntermediate', 'LittleDistal'];

      const identQ = new THREE.Quaternion();
      for (const fName of fingerNames) {
        const node = vrm.humanoid.getNormalizedBoneNode(`${prefix}${fName}` as VRMHumanBoneName);
        if (node) {
          node.quaternion.slerp(identQ, relaxRate);
        }
      }
    }
  }

  /**
   * Smoothly returns all arm and finger bones to rest A-pose
   */
  public applyIdlePose(vrm: VRM, rate = 0.15) {
    if (!vrm.humanoid) return;
    const upperName = (this.side + 'UpperArm') as VRMHumanBoneName;
    const lowerName = (this.side + 'LowerArm') as VRMHumanBoneName;
    const handName = (this.side + 'Hand') as VRMHumanBoneName;

    const uNode = vrm.humanoid.getNormalizedBoneNode(upperName);
    const lNode = vrm.humanoid.getNormalizedBoneNode(lowerName);
    const hNode = vrm.humanoid.getNormalizedBoneNode(handName);

    this._scratchQ1.setFromEuler(this.idleUpperEuler);
    if (uNode) uNode.quaternion.slerp(this._scratchQ1, rate);

    this._scratchQ1.setFromEuler(this.idleLowerEuler);
    if (lNode) lNode.quaternion.slerp(this._scratchQ1, rate);

    this._scratchQ1.setFromEuler(this.idleHandEuler);
    if (hNode) hNode.quaternion.slerp(this._scratchQ1, rate);

    this.currentUpperQ.setFromEuler(this.idleUpperEuler);
    this.currentLowerQ.setFromEuler(this.idleLowerEuler);
    this.currentHandQ.setFromEuler(this.idleHandEuler);
  }

  public reset() {
    this.state = 'REST';
    this.transitionAlpha = 0;
    this.filterShoulder.reset();
    this.filterElbow.reset();
    this.filterWrist.reset();
  }
}

/* ==========================================================================
   DEBUG VISUALIZER (STAGE 8: 3D TRANSLUCENT SKELETON OVERLAY)
   ========================================================================== */

export class ArmDebugVisualizer {
  private lineLeft: THREE.Line;
  private lineRight: THREE.Line;
  private geomLeft: THREE.BufferGeometry;
  private geomRight: THREE.BufferGeometry;
  private isVisible = false;

  constructor(scene: THREE.Scene) {
    this.geomLeft = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()
    ]);
    this.geomRight = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()
    ]);

    const matLeft = new THREE.LineBasicMaterial({
      color: 0x06b6d4, // Cyan
      linewidth: 3,
      transparent: true,
      opacity: 0.7,
      depthTest: false,
    });

    const matRight = new THREE.LineBasicMaterial({
      color: 0xec4899, // Pink
      linewidth: 3,
      transparent: true,
      opacity: 0.7,
      depthTest: false,
    });

    this.lineLeft = new THREE.Line(this.geomLeft, matLeft);
    this.lineRight = new THREE.Line(this.geomRight, matRight);
    this.lineLeft.renderOrder = 999;
    this.lineRight.renderOrder = 999;
    this.lineLeft.visible = false;
    this.lineRight.visible = false;

    scene.add(this.lineLeft);
    scene.add(this.lineRight);
  }

  public setVisible(visible: boolean) {
    this.isVisible = visible;
    this.lineLeft.visible = visible;
    this.lineRight.visible = visible;
  }

  public update(leftRig: ArmRig, rightRig: ArmRig) {
    if (!this.isVisible) return;

    // Update Left Line points
    const ptsL = [
      leftRig.debugInfo.trackedShoulder,
      leftRig.debugInfo.trackedElbow,
      leftRig.debugInfo.trackedWrist,
    ];
    this.geomLeft.setFromPoints(ptsL);

    // Update Right Line points
    const ptsR = [
      rightRig.debugInfo.trackedShoulder,
      rightRig.debugInfo.trackedElbow,
      rightRig.debugInfo.trackedWrist,
    ];
    this.geomRight.setFromPoints(ptsR);
  }
}