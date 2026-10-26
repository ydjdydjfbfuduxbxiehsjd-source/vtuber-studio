/**
 * VTuber Studio Pro - Modern Forward Kinematics (FK) Arm & Hand Rig
 * Reach-clamped two-bone arm solving with model-specific rest-pose calibration.
 * Landmark distances are scaled to the avatar so tracked wrists land near their image targets.
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
  wristAngleDeg: number;
  wristFlexDeg: number;
  wristFlexIndicator: string;
  trackedShoulder: THREE.Vector3;
  trackedElbow: THREE.Vector3;
  trackedWrist: THREE.Vector3;
}

interface StabilizedFingerValue {
  value: number;
  pending: number;
  pendingFrames: number;
}

/* ==========================================================================
   COORDINATE CONVERSION (STAGE 1 & 7)
   Converts MediaPipe World Landmarks (meters, origin at hips) to Avatar space.
   ========================================================================== */

/**
 * Converts metric MediaPipe pose coordinates to the avatar's camera-facing frame.
 * MediaPipe world landmarks are hip-centered; Three.js uses +Y up and +Z toward camera.
 * Horizontal reflection follows the visible webcam mode; semantic side mapping is handled
 * separately by the caller.
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

  // Reflect X only when the webcam preview is mirrored; rig-side mapping is separate.
  const avatarX = (mirror ? -rx : rx) || 0;

  // MediaPipe Z (depth towards camera is negative in MediaPipe world) -> avatar +Z
  const avatarZ = (-rz) || 0;

  out.set(avatarX, avatarY, avatarZ);
  return out;
}

/**
 * Converts normalized Holistic hand landmarks to isotropic camera-space coordinates.
 * x and z use image-width units while y uses image-height units, so scale x/z by aspect.
 */
export function convertImageHandLandmark(
  raw: Landmark3D,
  mirror: boolean,
  aspect = 4 / 3,
  targetOut?: Landmark3D
): Landmark3D {
  const out = targetOut || { x: 0, y: 0, z: 0 };
  const safeAspect = Number.isFinite(aspect) ? THREE.MathUtils.clamp(aspect, 0.25, 4) : 4 / 3;
  const rx = Number.isFinite(raw.x) ? raw.x : 0;
  const ry = Number.isFinite(raw.y) ? raw.y : 0;
  const rz = Number.isFinite(raw.z) ? raw.z : 0;
  out.x = (mirror ? -rx : rx) * safeAspect;
  out.y = -ry;
  out.z = -rz * safeAspect;
  if (raw.visibility !== undefined) out.visibility = raw.visibility;
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

const FINGER_DEFS: { name: string; indices: [number, number, number, number] }[] = [
  { name: 'Index', indices: [5, 6, 7, 8] },
  { name: 'Middle', indices: [9, 10, 11, 12] },
  { name: 'Ring', indices: [13, 14, 15, 16] },
  { name: 'Little', indices: [17, 18, 19, 20] },
];

const FINGER_BONE_NAMES = [
  'ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal',
  'IndexProximal', 'IndexIntermediate', 'IndexDistal',
  'MiddleProximal', 'MiddleIntermediate', 'MiddleDistal',
  'RingProximal', 'RingIntermediate', 'RingDistal',
  'LittleProximal', 'LittleIntermediate', 'LittleDistal',
];

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
  const v1x = p1.x - p0.x, v1y = p1.y - p0.y, v1z = p1.z - p0.z;
  const len1 = Math.hypot(v1x, v1y, v1z);

  const v2x = p2.x - p1.x, v2y = p2.y - p1.y, v2z = p2.z - p1.z;
  const len2 = Math.hypot(v2x, v2y, v2z);

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

  const proximalBend = Math.min(Math.PI / 2, intermediateBend * 0.85);

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
  public side: 'left' | 'right';
  public isLeft: boolean;

  // State Machine (Stage 5)
  public state: ArmTrackingState = 'REST';
  private lossTimestamp = 0;
  private lastFrameTimestamp = 0;
  private transitionAlpha = 0.0;

  // 1€ Filters on input landmark positions (Stage 1: minCutoff 1.0, beta 0.03)
  private filterShoulder = new OneEuroFilter3D(1.0, 0.03, 1.0);
  private filterElbow = new OneEuroFilter3D(1.0, 0.03, 1.0);
  private filterWrist = new OneEuroFilter3D(1.0, 0.03, 1.0);

  // Last good positions (fallback on visibility < 0.5)
  private lastGoodShoulder = new THREE.Vector3();
  private lastGoodElbow = new THREE.Vector3();
  private lastGoodWrist = new THREE.Vector3();

  // Capture each model's actual bind pose; VRM assets can use different local axes.
  public restUpperArmDir = new THREE.Vector3();
  public restLowerArmDir = new THREE.Vector3();
  private restUpperLocalDir = new THREE.Vector3();
  private restLowerLocalDir = new THREE.Vector3();
  private restUpperLocalQ = new THREE.Quaternion();
  private restLowerLocalQ = new THREE.Quaternion();
  private restHandLocalQ = new THREE.Quaternion();
  private restHandFrameLocalQ = new THREE.Quaternion();
  private restUpperWorldQ = new THREE.Quaternion();
  private restLowerWorldQ = new THREE.Quaternion();
  private upperSegmentLength = 0.225;
  private lowerSegmentLength = 0.218;
  private fingerRestQ = new Map<string, THREE.Quaternion>();
  private fingerCurlAxes = new Map<string, THREE.Vector3>();
  private stabilizedFingerValues = new Map<string, StabilizedFingerValue>();
  private isRestComputed = false;

  // Cached Quaternions for smoothing
  public currentUpperQ = new THREE.Quaternion();
  public currentLowerQ = new THREE.Quaternion();
  public currentHandQ = new THREE.Quaternion();

  // Idle rest rotations (natural resting A-pose)
  private idleUpperEuler = new THREE.Euler();
  private idleLowerEuler = new THREE.Euler();
  private idleHandEuler = new THREE.Euler();

  // Reused vectors and quaternions for the tracking loop
  private _sWorld = new THREE.Vector3();
  private _eWorld = new THREE.Vector3();
  private _wWorld = new THREE.Vector3();
  private _dirUpperWorld = new THREE.Vector3();
  private _dirLowerWorld = new THREE.Vector3();
  private _reachDirection = new THREE.Vector3();
  private _elbowPole = new THREE.Vector3();
  private _measuredElbowPole = new THREE.Vector3();
  private _lastElbowPole = new THREE.Vector3();
  private _projectedElbowPole = new THREE.Vector3();
  private _outwardElbowPole = new THREE.Vector3();
  private hasLastElbowPole = false;
  private _elbowTargetWorld = new THREE.Vector3();
  private _targetWristWorld = new THREE.Vector3();
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
  private _colX = new THREE.Vector3();
  private _colY = new THREE.Vector3();
  private _colZ = new THREE.Vector3();
  private _palmRotMatrix = new THREE.Matrix4();
  private _scratchQ1 = new THREE.Quaternion();
  private _scratchQ2 = new THREE.Quaternion();
  private _fingerCurlQ = new THREE.Quaternion();
  private _fingerSpreadQ = new THREE.Quaternion();
  private _fingerSpreadAxis = new THREE.Vector3(0, 1, 0);
  private _fingerTargetQ = new THREE.Quaternion();
  private _fingerAxis = new THREE.Vector3();
  private _identityQ = new THREE.Quaternion();
  private _scratchV1 = new THREE.Vector3();
  private _p0World = new THREE.Vector3();
  private _p5World = new THREE.Vector3();
  private _p17World = new THREE.Vector3();
  private _trackingHandLandmarks: Landmark3D[] = Array.from(
    { length: 21 },
    () => ({ x: 0, y: 0, z: 0 })
  );
  private _avatarShoulderPos = new THREE.Vector3();

  // Debug data
  public debugInfo: ArmDebugInfo;

  constructor(side: 'left' | 'right') {
    this.side = side;
    this.isLeft = side === 'left';

    // In VRM 1.0 normalized humanoid space:
    // Left arm extends along +X, Right arm extends along -X in rest T-pose
    this.restUpperArmDir.set(this.isLeft ? 1 : -1, 0, 0);
    this.restLowerArmDir.set(this.isLeft ? 1 : -1, 0, 0);

    // Idle A-pose rotations
    if (this.isLeft) {
      this.idleUpperEuler.set(0, 0, -1.25); // ~72 deg down
      this.idleLowerEuler.set(0, 0, -0.25);
      this.idleHandEuler.set(0, 0, 0);
      this.lastGoodShoulder.set(0.18, 0.45, 0);
      this.lastGoodElbow.set(0.35, 0.15, 0);
      this.lastGoodWrist.set(0.38, -0.15, 0);
    } else {
      this.idleUpperEuler.set(0, 0, 1.25);
      this.idleLowerEuler.set(0, 0, 0.25);
      this.idleHandEuler.set(0, 0, 0);
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
      wristAngleDeg: 0,
      wristFlexDeg: 0,
      wristFlexIndicator: '0° •',
      trackedShoulder: new THREE.Vector3(),
      trackedElbow: new THREE.Vector3(),
      trackedWrist: new THREE.Vector3(),
    };
  }

  /**
   * Captures the model-specific bind pose before live tracking starts.
   */
  public initFromVRM(vrm: VRM) {
    if (!vrm.humanoid) return;
    const upper = vrm.humanoid.getNormalizedBoneNode((this.side + 'UpperArm') as VRMHumanBoneName);
    const lower = vrm.humanoid.getNormalizedBoneNode((this.side + 'LowerArm') as VRMHumanBoneName);
    const hand = vrm.humanoid.getNormalizedBoneNode((this.side + 'Hand') as VRMHumanBoneName);
    if (!upper || !lower || !hand) return;
    this.hasLastElbowPole = false;
    upper.updateWorldMatrix(true, true);
    this.restUpperLocalQ.copy(upper.quaternion);
    this.restLowerLocalQ.copy(lower.quaternion);
    this.restHandLocalQ.copy(hand.quaternion);
    this.fingerRestQ.clear();
    this.fingerCurlAxes.clear();
    for (const fingerName of FINGER_BONE_NAMES) {
      const fingerNode = vrm.humanoid.getNormalizedBoneNode((this.side + fingerName) as VRMHumanBoneName);
      if (fingerNode) this.fingerRestQ.set(fingerName, fingerNode.quaternion.clone());
    }

    // Thumb curl is a rotation in the palm plane. Derive its local axis from
    // this model's bind pose instead of assuming thumb bones share finger axes.
    const thumbDirection = new THREE.Vector3(0, 0, 1);
    const fingerDirection = new THREE.Vector3(this.isLeft ? 1 : -1, 0, 0);
    const thumbFlexAxisWorld = new THREE.Vector3()
      .crossVectors(thumbDirection, fingerDirection)
      .normalize()
      .applyQuaternion(hand.getWorldQuaternion(new THREE.Quaternion()))
      .normalize();
    // Build a model-specific palm frame from the actual rest skeleton. This
    // avoids assuming every VRM uses the same wrist/finger local axes.
    const indexMcp = vrm.humanoid.getNormalizedBoneNode((this.side + 'IndexProximal') as VRMHumanBoneName);
    const middleMcp = vrm.humanoid.getNormalizedBoneNode((this.side + 'MiddleProximal') as VRMHumanBoneName);
    const pinkyMcp = vrm.humanoid.getNormalizedBoneNode((this.side + 'LittleProximal') as VRMHumanBoneName);
    if (indexMcp && middleMcp && pinkyMcp) {
      const wristPos = hand.getWorldPosition(new THREE.Vector3());
      const forward = middleMcp.getWorldPosition(new THREE.Vector3()).sub(wristPos).normalize();
      const across = pinkyMcp.getWorldPosition(new THREE.Vector3())
        .sub(indexMcp.getWorldPosition(new THREE.Vector3())).normalize();
      const normal = this.isLeft
        ? new THREE.Vector3().crossVectors(across, forward).normalize()
        : new THREE.Vector3().crossVectors(forward, across).normalize();
      const worldQ = hand.getWorldQuaternion(new THREE.Quaternion());
      const invHandQ = worldQ.clone().invert();
      const localX = (this.isLeft ? forward : forward.clone().negate()).applyQuaternion(invHandQ).normalize();
      const localY = normal.negate().applyQuaternion(invHandQ).normalize();
      const localZ = new THREE.Vector3().crossVectors(localX, localY).normalize();
      this._palmRotMatrix.makeBasis(localX, localY, localZ);
      this.restHandFrameLocalQ.setFromRotationMatrix(this._palmRotMatrix);
    } else {
      this.restHandFrameLocalQ.identity();
    }

    const palmNormalWorld = new THREE.Vector3();
    if (indexMcp && middleMcp && pinkyMcp) {
      const wristPos = hand.getWorldPosition(new THREE.Vector3());
      const forward = middleMcp.getWorldPosition(new THREE.Vector3()).sub(wristPos).normalize();
      const across = pinkyMcp.getWorldPosition(new THREE.Vector3())
        .sub(indexMcp.getWorldPosition(new THREE.Vector3())).normalize();
      if (this.isLeft) palmNormalWorld.crossVectors(across, forward).normalize();
      else palmNormalWorld.crossVectors(forward, across).normalize();
    } else {
      palmNormalWorld.set(0, -1, 0).applyQuaternion(hand.getWorldQuaternion(new THREE.Quaternion())).normalize();
    }
    for (const fingerName of ['ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal']) {
      const fingerNode = vrm.humanoid.getNormalizedBoneNode((this.side + fingerName) as VRMHumanBoneName);
      if (!fingerNode) continue;
      const nodeRestWorldQ = fingerNode.getWorldQuaternion(new THREE.Quaternion());
      const localCurlAxis = thumbFlexAxisWorld.clone()
        .applyQuaternion(nodeRestWorldQ.invert())
        .normalize();
      this.fingerCurlAxes.set(fingerName, localCurlAxis);
    }
    for (const fingerName of ['Index', 'Middle', 'Ring', 'Little']) {
      const names = [`${fingerName}Proximal`, `${fingerName}Intermediate`, `${fingerName}Distal`];
      const nodes = names.map((name) => vrm.humanoid.getNormalizedBoneNode((this.side + name) as VRMHumanBoneName));
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (!node) continue;
        const segment = new THREE.Vector3();
        if (i < 2 && nodes[i + 1]) {
          segment.subVectors(nodes[i + 1]!.getWorldPosition(new THREE.Vector3()), node.getWorldPosition(new THREE.Vector3()));
        } else if (nodes[i - 1]) {
          segment.subVectors(node.getWorldPosition(new THREE.Vector3()), nodes[i - 1]!.getWorldPosition(new THREE.Vector3()));
        } else {
          segment.set(1, 0, 0).applyQuaternion(node.getWorldQuaternion(new THREE.Quaternion()));
        }
        if (segment.lengthSq() < 1e-6) continue;
        const worldAxis = segment.normalize().cross(palmNormalWorld).normalize();
        const localAxis = worldAxis.applyQuaternion(node.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize();
        this.fingerCurlAxes.set(names[i], localAxis);
      }
    }
    upper.getWorldQuaternion(this.restUpperWorldQ);
    lower.getWorldQuaternion(this.restLowerWorldQ);
    const upperWorldPos = upper.getWorldPosition(new THREE.Vector3());
    const lowerWorldPos = lower.getWorldPosition(new THREE.Vector3());
    const handWorldPos = hand.getWorldPosition(new THREE.Vector3());
    this.upperSegmentLength = Math.max(0.05, upperWorldPos.distanceTo(lowerWorldPos));
    this.lowerSegmentLength = Math.max(0.05, lowerWorldPos.distanceTo(handWorldPos));
    this.restUpperLocalDir.copy(lower.position).normalize();
    this.restLowerLocalDir.copy(hand.position).normalize();
    if (this.restUpperLocalDir.lengthSq() < 1e-5 || this.restLowerLocalDir.lengthSq() < 1e-5) return;
    this.restUpperArmDir.copy(this.restUpperLocalDir).applyQuaternion(this.restUpperWorldQ).normalize();
    this.restLowerArmDir.copy(this.restLowerLocalDir).applyQuaternion(this.restLowerWorldQ).normalize();
    this.isRestComputed = true;
  }

  /**
   * Main Frame Update (position IK & hand rig)
   */
  public update(
    vrm: VRM,
    rawShoulder: Landmark3D | null | undefined,
    rawElbow: Landmark3D | null | undefined,
    rawWrist: Landmark3D | null | undefined,
    handLandmarks: Landmark3D[] | null | undefined,
    _poseFingers: Landmark3D[] | null | undefined,
    mirror: boolean,
    now: number,
    handSens: number = 1.0,
    handAspect: number = 4 / 3,
    armScale: number = 1.0
  ) {
    if (!vrm.humanoid) return;
    if (!this.isRestComputed) {
      this.initFromVRM(vrm);
    }

    let trackingHandLandmarks: Landmark3D[] | null = null;
    if (handLandmarks?.length === 21) {
      for (let i = 0; i < 21; i++) {
        convertImageHandLandmark(handLandmarks[i], mirror, handAspect, this._trackingHandLandmarks[i]);
      }
      trackingHandLandmarks = this._trackingHandLandmarks;
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
    const dt = this.lastFrameTimestamp > 0
      ? THREE.MathUtils.clamp((now - this.lastFrameTimestamp) / 1000, 0.001, 0.1)
      : 0.016;
    this.lastFrameTimestamp = now;

    if (isDetectionValid) {
      this.state = 'ACTIVE';
      this.lossTimestamp = 0;
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

    // If completely in REST state, smoothly return to idle A-pose and exit
    if (this.state === 'REST' && this.transitionAlpha <= 0.001) {
      this.applyIdlePose(vrm, 0.1);
      return;
    }

    // =========================================================================
    // STAGE 2: REACH-CLAMPED TWO-BONE POSITION IK
    // =========================================================================

    const upperName = (this.side + 'UpperArm') as VRMHumanBoneName;
    const lowerName = (this.side + 'LowerArm') as VRMHumanBoneName;
    const handName = (this.side + 'Hand') as VRMHumanBoneName;

    const uNode = vrm.humanoid.getNormalizedBoneNode(upperName);
    const lNode = vrm.humanoid.getNormalizedBoneNode(lowerName);
    const hNode = vrm.humanoid.getNormalizedBoneNode(handName);

    if (!uNode || !lNode || !hNode) return;

    // Map the user's wrist offset from their shoulder onto the avatar's shoulder.
    // This keeps the endpoint aligned even when the avatar and user have different arm lengths.
    // The upper body may have been rotated earlier in this frame, so refresh the bone chain
    // before reading the shoulder's world position.
    uNode.updateWorldMatrix(true, false);
    uNode.getWorldPosition(this._avatarShoulderPos);
    const safeArmScale = Number.isFinite(armScale) ? THREE.MathUtils.clamp(armScale, 0.5, 2.0) : 1.0;
    this._reachDirection.subVectors(this._wWorld, this._sWorld);
    const requestedReach = this._reachDirection.length() * safeArmScale;
    if (this._reachDirection.lengthSq() < 1e-6) {
      this._reachDirection.copy(this.restUpperArmDir);
    } else {
      this._reachDirection.normalize();
    }

    // Avoid the straight-arm singularity where elbow direction becomes
    // undefined and the pole can suddenly flip while the hand passes overhead.
    const reachMax = (this.upperSegmentLength + this.lowerSegmentLength) * 0.97;
    const reachMin = Math.min(reachMax, Math.abs(this.upperSegmentLength - this.lowerSegmentLength) + 0.01);
    const reach = THREE.MathUtils.clamp(requestedReach, reachMin, reachMax);
    this._targetWristWorld.copy(this._avatarShoulderPos).addScaledVector(this._reachDirection, reach);

    // Project the model's anatomical outward direction onto the bend plane.
    // This keeps the elbow outside the torso instead of accepting the mirrored
    // (inward) solution of the two-bone IK.
    this._outwardElbowPole.copy(this.restUpperArmDir)
      .addScaledVector(this._reachDirection, -this.restUpperArmDir.dot(this._reachDirection));
    const hasOutwardPole = this._outwardElbowPole.lengthSq() > 1e-5;
    if (hasOutwardPole) this._outwardElbowPole.normalize();

    // Keep the elbow on the user's observed bend plane. Near full extension
    // the measured pole becomes noisy, so preserve its previous hemisphere.
    this._elbowPole.subVectors(this._eWorld, this._sWorld);
    this._elbowPole.addScaledVector(this._reachDirection, -this._elbowPole.dot(this._reachDirection));
    const measuredPoleValid = this._elbowPole.lengthSq() > 1e-5;
    if (measuredPoleValid) {
      this._elbowPole.normalize();
      this._measuredElbowPole.copy(this._elbowPole);
      if (hasOutwardPole && this._measuredElbowPole.dot(this._outwardElbowPole) < 0) {
        this._measuredElbowPole.negate();
      }
    }

    let hasProjectedHistory = false;
    if (this.hasLastElbowPole) {
      this._projectedElbowPole.copy(this._lastElbowPole)
        .addScaledVector(this._reachDirection, -this._lastElbowPole.dot(this._reachDirection));
      hasProjectedHistory = this._projectedElbowPole.lengthSq() > 1e-5;
      if (hasProjectedHistory) {
        this._projectedElbowPole.normalize();
        if (hasOutwardPole && this._projectedElbowPole.dot(this._outwardElbowPole) < 0) {
          this._projectedElbowPole.negate();
        }
      }
    }

    if (measuredPoleValid && hasProjectedHistory) {
      // The elbow lies on one side of the shoulder-wrist line. A noisy sign
      // change must not move it to the opposite solution of the IK equation.
      if (this._measuredElbowPole.dot(this._projectedElbowPole) < 0) this._measuredElbowPole.negate();
      const reachRatio = reach / (this.upperSegmentLength + this.lowerSegmentLength);
      const poleAlpha = 1 - Math.exp(-dt * (reachRatio > 0.9 ? 5 : 14));
      this._elbowPole.copy(this._projectedElbowPole).lerp(this._measuredElbowPole, poleAlpha).normalize();
    } else if (!measuredPoleValid && hasProjectedHistory) {
      this._elbowPole.copy(this._projectedElbowPole);
    } else if (!measuredPoleValid) {
      if (hasOutwardPole) this._elbowPole.copy(this._outwardElbowPole);
      else this._elbowPole.set(0, 0, this.isLeft ? 1 : -1);
      if (this._elbowPole.lengthSq() < 1e-5) {
        this._elbowPole.set(this.isLeft ? 1 : -1, -0.3, -0.15);
        this._elbowPole.addScaledVector(this._reachDirection, -this._elbowPole.dot(this._reachDirection));
      }
      if (this._elbowPole.lengthSq() < 1e-5) this._elbowPole.set(0, 0, this.isLeft ? 1 : -1);
      this._elbowPole.normalize();
    }
    this._lastElbowPole.copy(this._elbowPole);
    this.hasLastElbowPole = true;

    const upperLength = this.upperSegmentLength;
    const lowerLength = this.lowerSegmentLength;
    const alongReach = (upperLength * upperLength - lowerLength * lowerLength + reach * reach) / (2 * reach);
    const elbowHeight = Math.sqrt(Math.max(0, upperLength * upperLength - alongReach * alongReach));
    this._elbowTargetWorld.copy(this._avatarShoulderPos)
      .addScaledVector(this._reachDirection, alongReach)
      .addScaledVector(this._elbowPole, elbowHeight);

    this._dirUpperWorld.subVectors(this._elbowTargetWorld, this._avatarShoulderPos).normalize();
    this._dirLowerWorld.subVectors(this._targetWristWorld, this._elbowTargetWorld).normalize();

    const dotArm = THREE.MathUtils.clamp(this._dirUpperWorld.dot(this._dirLowerWorld), -1, 1);
    this.debugInfo.elbowAngleDeg = THREE.MathUtils.radToDeg(Math.acos(dotArm));

    // 2. Upper Arm Local Rotation
    // Step 2a: Update parent node world matrix to get parent's updated orientation in this frame
    const parentNode = uNode.parent;
    if (parentNode) {
      parentNode.updateWorldMatrix(true, false);
      parentNode.getWorldQuaternion(this._parentWorldQ);
      this._parentInvQ.copy(this._parentWorldQ).invert();
    } else {
      this._parentWorldQ.identity();
      this._parentInvQ.identity();
    }

    this._targetUpperQ.setFromUnitVectors(this.restUpperArmDir, this._dirUpperWorld);
    this._targetUpperQ.multiply(this.restUpperWorldQ);
    this._targetUpperQ.premultiply(this._parentInvQ);
    if (!Number.isFinite(this._targetUpperQ.x)) {
      this._targetUpperQ.identity();
    }

    // Blend Upper Arm with Idle A-pose
    this._scratchQ1.copy(this.restUpperLocalQ);
    this._targetUpperQ.slerp(this._scratchQ1, 1.0 - this.transitionAlpha);
    const smoothFactor = 1.0 - Math.exp(-dt * THREE.MathUtils.lerp(8, 18, THREE.MathUtils.clamp(handSens, 0, 1)));
    this.currentUpperQ.slerp(this._targetUpperQ, smoothFactor);
    uNode.quaternion.copy(this.currentUpperQ);

    // Step 2b: Update uNode world matrix immediately so lNode can compute orientation in updated frame!
    uNode.updateWorldMatrix(true, false);
    uNode.getWorldQuaternion(this._upperWorldQ);
    this._upperInvQ.copy(this._upperWorldQ).invert();

    // 3. Lower Arm Local Rotation
    this._targetLowerQ.setFromUnitVectors(this.restLowerArmDir, this._dirLowerWorld);
    this._targetLowerQ.multiply(this.restLowerWorldQ);
    this._targetLowerQ.premultiply(this._upperInvQ);
    if (!Number.isFinite(this._targetLowerQ.x)) {
      this._targetLowerQ.identity();
    }

    // Populate debug points at the actual solved avatar joints.
    this.debugInfo.trackedShoulder.copy(this._avatarShoulderPos);
    this.debugInfo.trackedElbow.copy(this._elbowTargetWorld);
    this.debugInfo.trackedWrist.copy(this._targetWristWorld);

    // =========================================================================
    // STAGE 3: HAND ORIENTATION & 50% FOREARM TWIST
    // =========================================================================

    let hasHandOrientation = false;

    if (trackingHandLandmarks) {
      const p0 = trackingHandLandmarks[0];   // Wrist
      const p5 = trackingHandLandmarks[5];   // Index MCP
      const p17 = trackingHandLandmarks[17]; // Pinky MCP

      if (p0 && p5 && p17) {
        this._p0World.set(p0.x, p0.y, p0.z);
        this._p5World.set(p5.x, p5.y, p5.z);
        this._p17World.set(p17.x, p17.y, p17.z);

        // Forward vector = from wrist to finger bases midpoint
        this._palmForward.set(
          (this._p5World.x + this._p17World.x) * 0.5 - this._p0World.x,
          (this._p5World.y + this._p17World.y) * 0.5 - this._p0World.y,
          (this._p5World.z + this._p17World.z) * 0.5 - this._p0World.z
        );

        // Side vector: from index to pinky
        this._palmSide.subVectors(this._p17World, this._p5World);

        // Reject collapsed/noisy palm geometry instead of steering the wrist
        // from a barely detected set of finger-base landmarks.
        if (this._palmForward.lengthSq() > 0.0025 && this._palmSide.lengthSq() > 0.0004) {
          this._palmForward.normalize();
          this._palmSide.normalize();

          // Palm normal: perpendicular to palm surface (pointing towards camera +Z when palm faces viewer)
          // The image-space reflection reverses handedness; compensate per hand.
          if (this.isLeft) {
            this._palmNormal.crossVectors(this._palmSide, this._palmForward).normalize();
          } else {
            this._palmNormal.crossVectors(this._palmForward, this._palmSide).normalize();
          }

          // Orthogonalize side vector
          if (this.isLeft) {
            this._palmSide.crossVectors(this._palmForward, this._palmNormal).normalize();
          } else {
            this._palmSide.crossVectors(this._palmNormal, this._palmForward).normalize();
          }

          // In VRM 1.0 normalized humanoid rest T-pose:
          // Left hand: fingers point +X, palm normal is -Y, thumb is +Z
          // Right hand: fingers point -X, palm normal is -Y, thumb is +Z
          if (this.isLeft) {
            this._colX.copy(this._palmForward);
            this._colY.copy(this._palmNormal).negate();
            this._colZ.crossVectors(this._colX, this._colY).normalize();
          } else {
            this._colX.copy(this._palmForward).negate();
            this._colY.copy(this._palmNormal).negate();
            this._colZ.crossVectors(this._colX, this._colY).normalize();
          }

          this._palmRotMatrix.makeBasis(this._colX, this._colY, this._colZ);
          this._targetHandQ.setFromRotationMatrix(this._palmRotMatrix);
          // Retarget the measured palm frame onto this model's captured rest
          // frame, preserving its own wrist bend and local bone orientation.
          this._scratchQ1.copy(this.restHandFrameLocalQ).invert();
          this._targetHandQ.multiply(this._scratchQ1);

          // Convert target hand world quaternion to lower arm local space
          // Note: lowerArm has orientation = parentWorldQ * targetUpperQ * targetLowerQ
          this._scratchQ1.multiplyQuaternions(this._upperWorldQ, this._targetLowerQ);
          this._scratchQ1.invert();
          this._targetHandQ.premultiply(this._scratchQ1);

          if (Number.isFinite(this._targetHandQ.x)) {
            hasHandOrientation = true;
          }
        }
      }
    }

    if (hasHandOrientation) {
      // Work with wrist motion relative to the model's captured neutral hand pose.
      this._scratchQ1.copy(this.restHandLocalQ).invert().multiply(this._targetHandQ);
      const absW = Math.min(1.0, Math.abs(this._scratchQ1.w));
      this.debugInfo.wristAngleDeg = THREE.MathUtils.radToDeg(2.0 * Math.acos(absW));

      this._scratchV1.copy(this.restLowerLocalDir).applyQuaternion(this._scratchQ1);
      const flexVal = THREE.MathUtils.clamp(-this._scratchV1.y, -1, 1);
      this.debugInfo.wristFlexDeg = THREE.MathUtils.radToDeg(Math.asin(flexVal));
      const flexSignStr = this.debugInfo.wristFlexDeg > 0 ? '+' : '';
      const flexArrow = this.debugInfo.wristFlexDeg > 3 ? '↑' : (this.debugInfo.wristFlexDeg < -3 ? '↓' : '•');
      this.debugInfo.wristFlexIndicator = flexSignStr + Math.round(this.debugInfo.wristFlexDeg) + '° ' + flexArrow;

      const boneAxis = this.restLowerLocalDir;
      const twistAngle = 2.0 * Math.atan2(
        this._scratchQ1.x * boneAxis.x + this._scratchQ1.y * boneAxis.y + this._scratchQ1.z * boneAxis.z,
        this._scratchQ1.w
      );
      if (Number.isFinite(twistAngle)) {
        this._scratchQ2.setFromAxisAngle(boneAxis, twistAngle * 0.5);
        this._targetLowerQ.multiply(this._scratchQ2);
        this._scratchQ2.setFromAxisAngle(boneAxis, -twistAngle * 0.5);
        this._targetHandQ.premultiply(this._scratchQ2);
      }
    } else {
      this._targetHandQ.copy(this.currentHandQ);
      this.debugInfo.wristAngleDeg = 0;
      this.debugInfo.wristFlexDeg = 0;
      this.debugInfo.wristFlexIndicator = '0° •';
    }

    // Blend Lower Arm with Idle A-pose & apply smoothly
    this._scratchQ1.copy(this.restLowerLocalQ);
    this._targetLowerQ.slerp(this._scratchQ1, 1.0 - this.transitionAlpha);
    this.currentLowerQ.slerp(this._targetLowerQ, smoothFactor);
    lNode.quaternion.copy(this.currentLowerQ);
    lNode.updateWorldMatrix(true, false);

    // Blend Hand with Idle & apply smoothly
    this._scratchQ1.copy(this.restHandLocalQ);
    this._targetHandQ.slerp(this._scratchQ1, 1.0 - this.transitionAlpha);
    const handSmoothFactor = Math.min(smoothFactor, 1 - Math.exp(-dt * 10));
    this.currentHandQ.slerp(this._targetHandQ, handSmoothFactor);
    hNode.quaternion.copy(this.currentHandQ);

    // =========================================================================
    // STAGE 4: FINGER BONES
    // =========================================================================
    this.updateFingers(vrm, trackingHandLandmarks, dt);
  }

  /**
   * Applies angles to all 15 finger bones (Stage 4)
   */
  private updateFingers(vrm: VRM, handLandmarks: Landmark3D[] | null | undefined, dt: number) {
    if (!vrm.humanoid) return;
    const prefix = this.side; // 'left' | 'right'

    if (handLandmarks && handLandmarks.length === 21) {
      const curlAlpha = 1 - Math.exp(-dt * 14);

      // Compute finger spread (abduction / adduction) across the palm plane
      const pSide = this._palmSide;
      const pFwd = this._palmForward;
      const hasPalmBasis = pSide.lengthSq() > 1e-4 && pFwd.lengthSq() > 1e-4;

      let spreadIdx = 0;
      let spreadRing = 0;
      let spreadLit = 0;
      let spreadTh = 0;

      if (hasPalmBasis) {
        const calcSpreadAngle = (mcpIdx: number, tipIdx: number) => {
          const pM = handLandmarks[mcpIdx];
          const pT = handLandmarks[tipIdx];
          const vx = pT.x - pM.x;
          const vy = pT.y - pM.y;
          const vz = pT.z - pM.z;
          const s = vx * pSide.x + vy * pSide.y + vz * pSide.z;
          const f = vx * pFwd.x + vy * pFwd.y + vz * pFwd.z;
          return Math.atan2(s, f);
        };

        const angleMid = calcSpreadAngle(9, 12);
        const angleIdx = calcSpreadAngle(5, 8);
        const angleRing = calcSpreadAngle(13, 16);
        const angleLit = calcSpreadAngle(17, 20);
        const angleTh = calcSpreadAngle(2, 4);

        // Side vector points from index towards pinky:
        // Index is negative relative to middle, ring & pinky are positive
        const rawSpreadIdx = angleMid - angleIdx;
        const rawSpreadRing = angleRing - angleMid;
        const rawSpreadLit = angleLit - angleMid;
        const rawSpreadTh = -angleTh - angleMid;

        spreadIdx = THREE.MathUtils.clamp((rawSpreadIdx - 0.05) * 1.5, 0, 0.45);
        spreadRing = THREE.MathUtils.clamp((rawSpreadRing - 0.04) * 1.5, 0, 0.35);
        spreadLit = THREE.MathUtils.clamp((rawSpreadLit - 0.07) * 1.6, 0, 0.55);
        spreadTh = THREE.MathUtils.clamp((rawSpreadTh - 0.35) * 1.3, 0, 0.65);
      }

      const sideFactor = this.isLeft ? 1 : -1;

      for (const def of FINGER_DEFS) {
        const [i0, i1, i2, i3] = def.indices;
        if (!this.hasUsableFingerLandmarks(handLandmarks, [i0, i1, i2, i3])) continue;
        const angles = computeFingerAngles(
          handLandmarks[i0],
          handLandmarks[i1],
          handLandmarks[i2],
          handLandmarks[i3]
        );

        let spreadY = 0;
        if (def.name === 'Index') spreadY = -spreadIdx * sideFactor;
        else if (def.name === 'Ring') spreadY = spreadRing * sideFactor;
        else if (def.name === 'Little') spreadY = spreadLit * sideFactor;

        const proximalBend = this.stabilizeFingerValue(`${def.name}.proximal`, angles.proximalBend, dt);
        const intermediateBend = this.stabilizeFingerValue(`${def.name}.intermediate`, angles.intermediateBend, dt);
        const distalBend = this.stabilizeFingerValue(`${def.name}.distal`, angles.distalBend, dt);
        const stableSpread = this.stabilizeFingerValue(`${def.name}.spread`, spreadY, dt);

        // Reduce spread when fingers curl into a fist
        const curlScale = Math.max(0, 1.0 - intermediateBend / 1.3);
        const finalSpread = stableSpread * curlScale;

        const curlSign = this.isLeft ? -1 : 1;
        const nodeP = vrm.humanoid.getNormalizedBoneNode((prefix + def.name + 'Proximal') as VRMHumanBoneName);
        const nodeI = vrm.humanoid.getNormalizedBoneNode((prefix + def.name + 'Intermediate') as VRMHumanBoneName);
        const nodeD = vrm.humanoid.getNormalizedBoneNode((prefix + def.name + 'Distal') as VRMHumanBoneName);

        if (nodeP) this.applyFingerBend(nodeP, def.name + 'Proximal', curlSign, proximalBend * 0.6, curlAlpha, this.fingerCurlAxes.get(def.name + 'Proximal'), finalSpread);
        if (nodeI) this.applyFingerBend(nodeI, def.name + 'Intermediate', curlSign, intermediateBend * 0.7, curlAlpha, this.fingerCurlAxes.get(def.name + 'Intermediate'));
        if (nodeD) this.applyFingerBend(nodeD, def.name + 'Distal', curlSign, distalBend * 0.7, curlAlpha, this.fingerCurlAxes.get(def.name + 'Distal'));
      }

      // Thumb
      if (!this.hasUsableFingerLandmarks(handLandmarks, [1, 2, 3, 4])) return;
      const thumbBends = computeThumbBends(
        handLandmarks[1],
        handLandmarks[2],
        handLandmarks[3],
        handLandmarks[4]
      );

      const sign = this.isLeft ? -1 : 1;
      const nodeTM = vrm.humanoid.getNormalizedBoneNode((prefix + 'ThumbMetacarpal') as VRMHumanBoneName);
      const nodeTP = vrm.humanoid.getNormalizedBoneNode((prefix + 'ThumbProximal') as VRMHumanBoneName);
      const nodeTD = vrm.humanoid.getNormalizedBoneNode((prefix + 'ThumbDistal') as VRMHumanBoneName);

      // Radial abduction: spread thumb outward when hand is open wide
      const stableThumbSpread = this.stabilizeFingerValue('Thumb.spread', spreadTh, dt);
      const metaBend = this.stabilizeFingerValue('Thumb.metacarpal', thumbBends.metacarpal, dt) - stableThumbSpread * 0.7;
      const proxBend = this.stabilizeFingerValue('Thumb.proximal', thumbBends.proximal, dt) - stableThumbSpread * 0.3;
      const distalBend = this.stabilizeFingerValue('Thumb.distal', thumbBends.distal, dt);

      if (nodeTM) this.applyFingerBend(nodeTM, 'ThumbMetacarpal', sign, metaBend, curlAlpha, this.fingerCurlAxes.get('ThumbMetacarpal'));
      if (nodeTP) this.applyFingerBend(nodeTP, 'ThumbProximal', sign, proxBend, curlAlpha, this.fingerCurlAxes.get('ThumbProximal'));
      if (nodeTD) this.applyFingerBend(nodeTD, 'ThumbDistal', sign, distalBend, curlAlpha, this.fingerCurlAxes.get('ThumbDistal'));
    }
    // Missing finger landmarks hold the last pose; the arm's own REST state
    // handles the slower return to neutral after tracking has been lost.
  }

  private hasUsableFingerLandmarks(landmarks: Landmark3D[], indices: number[]) {
    for (const index of indices) {
      const point = landmarks[index];
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) return false;
    }
    for (let i = 1; i < indices.length; i++) {
      const a = landmarks[indices[i - 1]];
      const b = landmarks[indices[i]];
      const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      if (!Number.isFinite(length) || length < 0.004 || length > 0.35) return false;
    }
    return true;
  }

  private stabilizeFingerValue(key: string, measured: number, dt: number) {
    let state = this.stabilizedFingerValues.get(key);
    if (!state) {
      state = { value: 0, pending: 0, pendingFrames: 0 };
      this.stabilizedFingerValues.set(key, state);
    }
    if (!Number.isFinite(measured)) return state.value;

    // Ignore a one-frame jump. A large motion must be seen consistently in
    // two consecutive frames before the filtered pose starts following it.
    if (Math.abs(measured - state.value) > 0.45) {
      if (state.pendingFrames > 0 && Math.abs(measured - state.pending) < 0.22) {
        state.pendingFrames++;
      } else {
        state.pending = measured;
        state.pendingFrames = 1;
      }
      if (state.pendingFrames < 2) return state.value;
    } else {
      state.pendingFrames = 0;
    }

    state.value += (measured - state.value) * (1 - Math.exp(-dt * 10));
    return state.value;
  }

  private applyFingerBend(
    node: THREE.Object3D,
    fingerName: string,
    sign: number,
    angle: number,
    alpha: number,
    axisOverride?: THREE.Vector3,
    spreadAngle: number = 0
  ) {
    if (axisOverride && axisOverride.lengthSq() > 1e-6) {
      this._fingerAxis.copy(axisOverride).normalize();
    } else {
      this._fingerAxis.set(0, 0, sign);
    }
    this._fingerCurlQ.setFromAxisAngle(this._fingerAxis, angle);
    if (Math.abs(spreadAngle) > 1e-4) {
      this._fingerSpreadQ.setFromAxisAngle(this._fingerSpreadAxis, spreadAngle);
      this._fingerCurlQ.multiply(this._fingerSpreadQ);
    }
    const restQ = this.fingerRestQ.get(fingerName) || this._identityQ;
    this._fingerTargetQ.multiplyQuaternions(restQ, this._fingerCurlQ);
    node.quaternion.slerp(this._fingerTargetQ, alpha);
  }

  /**
   * Smoothly resets arm to idle A-pose
   */
  public applyIdlePose(vrm: VRM, rate = 0.15) {
    if (!vrm.humanoid) return;
    const uNode = vrm.humanoid.getNormalizedBoneNode((this.side + 'UpperArm') as VRMHumanBoneName);
    const lNode = vrm.humanoid.getNormalizedBoneNode((this.side + 'LowerArm') as VRMHumanBoneName);
    const hNode = vrm.humanoid.getNormalizedBoneNode((this.side + 'Hand') as VRMHumanBoneName);

    this._scratchQ1.copy(this.restUpperLocalQ);
    this._scratchQ2.copy(this.restLowerLocalQ);

    this.currentUpperQ.slerp(this._scratchQ1, rate);
    this.currentLowerQ.slerp(this._scratchQ2, rate);
    this.currentHandQ.slerp(this.restHandLocalQ, rate);

    if (uNode) uNode.quaternion.copy(this.currentUpperQ);
    if (lNode) lNode.quaternion.copy(this.currentLowerQ);
    if (hNode) hNode.quaternion.copy(this.currentHandQ);
    this.relaxFingersToRest(vrm, rate);

    this.debugInfo.elbowAngleDeg = 0;
    this.debugInfo.wristAngleDeg = 0;
    this.debugInfo.wristFlexDeg = 0;
    this.debugInfo.wristFlexIndicator = '0° •';
  }

  public resetFilters() {
    this.state = 'REST';
    this.transitionAlpha = 0;
    this.lossTimestamp = 0;
    this.lastFrameTimestamp = 0;
    this.filterShoulder.reset();
    this.filterElbow.reset();
    this.filterWrist.reset();
    this.hasLastElbowPole = false;
  }

  private relaxFingersToRest(vrm: VRM, rate: number) {
    if (!vrm.humanoid) return;
    for (const fingerName of FINGER_BONE_NAMES) {
      const node = vrm.humanoid.getNormalizedBoneNode(`${this.side}${fingerName}` as VRMHumanBoneName);
      if (node) node.quaternion.slerp(this.fingerRestQ.get(fingerName) || this._identityQ, rate);
    }
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
  public isVisible = false;

  constructor(scene: THREE.Scene) {
    this.geomLeft = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()
    ]);
    this.geomRight = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()
    ]);

    const matLeft = new THREE.LineBasicMaterial({
      color: 0x06b6d4, // Cyan for left arm
      linewidth: 4,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
    });

    const matRight = new THREE.LineBasicMaterial({
      color: 0xec4899, // Pink for right arm
      linewidth: 4,
      transparent: true,
      opacity: 0.85,
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

    // Left Line: shoulder -> elbow -> wrist
    const ptsL = [
      leftRig.debugInfo.trackedShoulder,
      leftRig.debugInfo.trackedElbow,
      leftRig.debugInfo.trackedWrist,
    ];
    this.geomLeft.setFromPoints(ptsL);

    // Right Line: shoulder -> elbow -> wrist
    const ptsR = [
      rightRig.debugInfo.trackedShoulder,
      rightRig.debugInfo.trackedElbow,
      rightRig.debugInfo.trackedWrist,
    ];
    this.geomRight.setFromPoints(ptsR);
  }
}

