/**
 * Legacy Arm Tracking (Two-Bone Positional IK + Body Colliders + Face-Touch Engine)
 * Preserved for fallback and comparison.
 */
import * as THREE from 'three';
import { VRM, type VRMHumanBoneName } from '@pixiv/three-vrm';
import { OneEuroFilter3D } from '../oneEuroFilter';
import { solveTwoBoneCosines } from '../ikMath';

export interface ArmLengths {
  L1: number;
  L2: number;
  total: number;
}

export const avatarArmLengths: { left: ArmLengths; right: ArmLengths } = {
  left: { L1: 0.22, L2: 0.215, total: 0.435 },
  right: { L1: 0.22, L2: 0.215, total: 0.435 },
};

export function computeAvatarArmLengths(currentVrm: VRM | null) {
  if (!currentVrm || !currentVrm.humanoid) return;
  const sides: ('left' | 'right')[] = ['left', 'right'];
  for (const side of sides) {
    const upperName = (side + 'UpperArm') as VRMHumanBoneName;
    const lowerName = (side + 'LowerArm') as VRMHumanBoneName;
    const handName = (side + 'Hand') as VRMHumanBoneName;

    const uNode = currentVrm.humanoid.getNormalizedBoneNode(upperName);
    const lNode = currentVrm.humanoid.getNormalizedBoneNode(lowerName);
    const hNode = currentVrm.humanoid.getNormalizedBoneNode(handName);

    if (uNode && lNode && hNode) {
      const pU = new THREE.Vector3();
      const pL = new THREE.Vector3();
      const pH = new THREE.Vector3();
      uNode.getWorldPosition(pU);
      lNode.getWorldPosition(pL);
      hNode.getWorldPosition(pH);

      const d1 = pU.distanceTo(pL);
      const d2 = pL.distanceTo(pH);

      if (d1 > 0.05 && d1 < 0.8 && d2 > 0.05 && d2 < 0.8) {
        avatarArmLengths[side] = {
          L1: d1,
          L2: d2,
          total: d1 + d2,
        };
      }
    }
  }
}

// Scratch reusable objects (zero allocations)
const _scratchV1 = new THREE.Vector3();
const _scratchV2 = new THREE.Vector3();
const _scratchV3 = new THREE.Vector3();
const _scratchV4 = new THREE.Vector3();
const _scratchQ1 = new THREE.Quaternion();
const _scratchQ2 = new THREE.Quaternion();
const _scratchQ3 = new THREE.Quaternion();
const _colHeadPos = new THREE.Vector3();
const _colVHead = new THREE.Vector3();
const _colChestPos = new THREE.Vector3();
const _colHipsPos = new THREE.Vector3();
const _colVAB = new THREE.Vector3();
const _colCenter = new THREE.Vector3();

export function resolveBodyColliders(
  currentVrm: VRM | null,
  point: THREE.Vector3,
  minMargin = 0.035,
  isWristOrHand = false,
  faceTouchWeight = 0.0
): THREE.Vector3 {
  if (!currentVrm || !currentVrm.humanoid) return point.clone();
  const out = point.clone();

  // 1. Head Sphere Collider
  const headNode = currentVrm.humanoid.getNormalizedBoneNode('head');
  if (headNode) {
    headNode.getWorldPosition(_colHeadPos);
    _colHeadPos.y += 0.02;
    _colVHead.subVectors(out, _colHeadPos);
    const distSq = _colVHead.lengthSq();

    if (isWristOrHand) {
      const collisionFactor = THREE.MathUtils.clamp(1.0 - faceTouchWeight, 0.0, 1.0);
      const wristHeadRadius = 0.07 + 0.005;
      if (collisionFactor > 0.01 && distSq < wristHeadRadius * wristHeadRadius && distSq > 1e-6) {
        const dist = Math.sqrt(distSq);
        _scratchV1.copy(_colHeadPos).addScaledVector(_colVHead.multiplyScalar(1 / dist), wristHeadRadius);
        out.lerp(_scratchV1, collisionFactor);
      }
    } else {
      const elbowHeadRadius = 0.11 + minMargin;
      if (distSq < elbowHeadRadius * elbowHeadRadius && distSq > 1e-6) {
        const dist = Math.sqrt(distSq);
        out.copy(_colHeadPos).addScaledVector(_colVHead.multiplyScalar(1 / dist), elbowHeadRadius);
      }
    }
  }

  // 2. Torso Elliptical Capsule Collider
  const chestNode = currentVrm.humanoid.getNormalizedBoneNode('chest');
  const hipsNode = currentVrm.humanoid.getNormalizedBoneNode('hips');
  if (chestNode && hipsNode) {
    chestNode.getWorldPosition(_colChestPos);
    _colChestPos.y += 0.03;
    hipsNode.getWorldPosition(_colHipsPos);
    _colHipsPos.y -= 0.03;

    _colVAB.subVectors(_colHipsPos, _colChestPos);
    const lenSq = _colVAB.lengthSq();
    if (lenSq > 1e-4) {
      const t = THREE.MathUtils.clamp(
        _scratchV2.subVectors(out, _colChestPos).dot(_colVAB) / lenSq,
        0,
        1
      );
      _colCenter.copy(_colChestPos).addScaledVector(_colVAB, t);
      const rx = THREE.MathUtils.lerp(0.145, 0.165, t) + minMargin;
      const rz = THREE.MathUtils.lerp(0.115, 0.135, t) + minMargin;

      const dx = out.x - _colCenter.x;
      const dz = out.z - _colCenter.z;

      const normDistSq = (dx * dx) / (rx * rx) + (dz * dz) / (rz * rz);
      if (normDistSq < 1.0 && normDistSq > 1e-6) {
        const scale = 1.0 / Math.sqrt(normDistSq);
        out.x = _colCenter.x + dx * scale;
        out.z = _colCenter.z + dz * scale;
      }
    }
  }
  return out;
}

export const elbowFilters = {
  left: new OneEuroFilter3D(1.2, 0.02, 1.0),
  right: new OneEuroFilter3D(1.2, 0.02, 1.0),
};

export const wristFilters = {
  left: new OneEuroFilter3D(1.2, 0.02, 1.0),
  right: new OneEuroFilter3D(1.2, 0.02, 1.0),
};

export const lastGoodElbowVec: { left: THREE.Vector3; right: THREE.Vector3 } = {
  left: new THREE.Vector3(0.35, -0.75, -0.2).normalize(),
  right: new THREE.Vector3(-0.35, -0.75, -0.2).normalize(),
};

export interface FaceTouchState {
  isActive: boolean;
  weight: number;
  lastTimestamp: number;
}

export const faceTouchState: { left: FaceTouchState; right: FaceTouchState } = {
  left: { isActive: false, weight: 0.0, lastTimestamp: 0 },
  right: { isActive: false, weight: 0.0, lastTimestamp: 0 },
};

export const shoulderSamples: number[] = [];
export const MAX_SHOULDER_SAMPLES = 120;
export let calibratedArmScale: number | null = null;
export let lastGoodUserShoulderWidth = 0.32;
export let lastGoodArmScale = 1.0;

export function computeArmScale(currentVrm: VRM | null, userShoulderWidth: number | null): number {
  if (calibratedArmScale !== null) return calibratedArmScale;
  if (userShoulderWidth !== null && Number.isFinite(userShoulderWidth) && userShoulderWidth > 0.08 && userShoulderWidth < 1.5) {
    shoulderSamples.push(userShoulderWidth);
    if (shoulderSamples.length > MAX_SHOULDER_SAMPLES) shoulderSamples.shift();
  }
  if (shoulderSamples.length > 0) {
    const sorted = [...shoulderSamples].sort((a, b) => a - b);
    const medianWidth = sorted[Math.floor(sorted.length / 2)];
    lastGoodUserShoulderWidth = medianWidth;

    let avatarWidth = 0.32;
    if (currentVrm && currentVrm.humanoid) {
      const lS = currentVrm.humanoid.getNormalizedBoneNode('leftUpperArm');
      const rS = currentVrm.humanoid.getNormalizedBoneNode('rightUpperArm');
      if (lS && rS) {
        const pL = new THREE.Vector3();
        const pR = new THREE.Vector3();
        lS.getWorldPosition(pL);
        rS.getWorldPosition(pR);
        const dist = pL.distanceTo(pR);
        if (dist > 0.15 && dist < 0.8) avatarWidth = dist;
      }
    }
    const rawScale = avatarWidth / (medianWidth > 1e-4 ? medianWidth : 0.32);
    lastGoodArmScale = THREE.MathUtils.clamp(rawScale, 0.8, 1.3);
    return lastGoodArmScale;
  }
  return lastGoodArmScale || 1.0;
}

export function solveArmVectorIKLegacy(
  currentVrm: VRM | null,
  targetSide: 'left' | 'right',
  S3d: { x: number; y: number; z: number },
  E3d: { x: number; y: number; z: number },
  W3d: { x: number; y: number; z: number },
  handLM: any[] | null | undefined,
  _isUserRight: boolean,
  faceLM: any[] | null | undefined,
  armScale = 1.0,
  shoulderVis = 1.0,
  elbowVis = 1.0,
  reachMultiplier = 1.15
) {
  if (!currentVrm || !currentVrm.humanoid) return;

  const upperArmNode = currentVrm.humanoid.getNormalizedBoneNode((targetSide + 'UpperArm') as VRMHumanBoneName);
  const lowerArmNode = currentVrm.humanoid.getNormalizedBoneNode((targetSide + 'LowerArm') as VRMHumanBoneName);
  const handNode = currentVrm.humanoid.getNormalizedBoneNode((targetSide + 'Hand') as VRMHumanBoneName);

  if (!upperArmNode || !lowerArmNode || !handNode) return;

  const armLen = avatarArmLengths[targetSide];
  const L1 = armLen.L1;
  const L2 = armLen.L2;
  const isLeft = targetSide === 'left';
  const naturalRestUpper = isLeft ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(-1, 0, 0);

  const rawDeltaX = W3d.x - S3d.x;
  const rawDeltaY = -(W3d.y - S3d.y);
  const rawDeltaZ = (W3d.z - S3d.z) * 0.4;

  const scaledDx = (isLeft ? rawDeltaX : -rawDeltaX) * armScale * reachMultiplier;
  const scaledDy = rawDeltaY * armScale * reachMultiplier;
  const scaledDz = rawDeltaZ * armScale * reachMultiplier;

  const pUpper = _scratchV1;
  upperArmNode.getWorldPosition(pUpper);
  const targetWristPos = _scratchV2.set(pUpper.x + scaledDx, pUpper.y + scaledDy, pUpper.z + scaledDz);

  // Face touch detection
  let isFaceTouchActive = false;
  if (handLM && handLM.length > 0 && faceLM && faceLM.length > 0) {
    const palmCenter = handLM[0];
    const nosePt = faceLM[1] || faceLM[0];
    if (palmCenter && nosePt) {
      const dFace = Math.hypot(palmCenter.x - nosePt.x, palmCenter.y - nosePt.y);
      const ftPrev = faceTouchState[targetSide].isActive;
      isFaceTouchActive = ftPrev ? dFace < 0.35 : dFace < 0.25;
    }
  }

  const ftState = faceTouchState[targetSide];
  ftState.isActive = isFaceTouchActive;
  const now = performance.now();
  const dt = ftState.lastTimestamp > 0 ? (now - ftState.lastTimestamp) / 1000 : 0.016;
  ftState.lastTimestamp = now;

  const targetWeight = isFaceTouchActive ? 1.0 : 0.0;
  const blendSpeed = 8.0;
  ftState.weight += (targetWeight - ftState.weight) * Math.min(1.0, dt * blendSpeed);

  if (ftState.weight > 0.01 && faceLM && faceLM.length > 0) {
    const headNode = currentVrm.humanoid.getNormalizedBoneNode('head');
    if (headNode) {
      const pHead = _scratchV3;
      headNode.getWorldPosition(pHead);
      const palmPt = handLM ? handLM[0] : null;
      const nosePt = faceLM[1] || faceLM[0];
      if (palmPt && nosePt) {
        const offX = (palmPt.x - nosePt.x) * (isLeft ? 0.35 : -0.35);
        const offY = -(palmPt.y - nosePt.y) * 0.35;
        const faceTouchWrist = _scratchV4.set(pHead.x + offX, pHead.y + offY, pHead.z + 0.10);
        targetWristPos.lerp(faceTouchWrist, ftState.weight);
      }
    }
  }

  const safeWrist = resolveBodyColliders(currentVrm, targetWristPos, 0.02, true, ftState.weight);
  targetWristPos.copy(safeWrist);

  const vGoal = _scratchV3.subVectors(targetWristPos, pUpper);
  const targetDist = vGoal.length();

  const { alpha, clampedDist } = solveTwoBoneCosines(L1, L2, targetDist, 0.98, 0.03);
  if (targetDist > 1e-4) {
    vGoal.multiplyScalar(clampedDist / targetDist);
  }

  // Elbow pole vector
  let vElbowUser = _scratchV4;
  if (elbowVis >= 0.5 && shoulderVis >= 0.5) {
    vElbowUser.set(isLeft ? E3d.x - S3d.x : -(E3d.x - S3d.x), -(E3d.y - S3d.y), (E3d.z - S3d.z) * 0.4);
    if (vElbowUser.lengthSq() > 1e-4) {
      vElbowUser.normalize();
      lastGoodElbowVec[targetSide].copy(vElbowUser);
    } else {
      vElbowUser.copy(lastGoodElbowVec[targetSide]);
    }
  } else {
    vElbowUser.copy(lastGoodElbowVec[targetSide]);
  }

  const dDir = _scratchV1.copy(vGoal).normalize();
  const sideVec = isLeft ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 0, 1);
  let normal = _scratchV2.crossVectors(dDir, sideVec);
  if (normal.lengthSq() < 1e-4) normal.set(0, 1, 0);
  else normal.normalize();

  const vP = _scratchV4.copy(vElbowUser).addScaledVector(dDir, -vElbowUser.dot(dDir));
  let planeNormal = normal;
  if (vP.lengthSq() > 1e-4) {
    planeNormal = vP.normalize();
  }

  // Upper arm rotation
  const rotAxis = _scratchV2.crossVectors(dDir, planeNormal).normalize();
  _scratchQ1.setFromAxisAngle(rotAxis, -alpha);
  const vUpperDir = _scratchV4.copy(dDir).applyQuaternion(_scratchQ1).normalize();

  _scratchQ2.setFromUnitVectors(naturalRestUpper, vUpperDir);
  upperArmNode.quaternion.slerp(_scratchQ2, 0.35);

  // Lower arm rotation
  const pElbow = _scratchV1.copy(pUpper).addScaledVector(vUpperDir, L1);
  const vLowerDir = _scratchV2.subVectors(targetWristPos, pElbow).normalize();
  // const naturalRestLower = naturalRestUpper;

  _scratchQ1.setFromUnitVectors(vUpperDir, vLowerDir);
  const targetLowerWorldQ = _scratchQ3.multiplyQuaternions(_scratchQ1, _scratchQ2);
  const parentInvQ = _scratchQ1.copy(upperArmNode.quaternion).invert();
  const localLowerQ = _scratchQ2.multiplyQuaternions(parentInvQ, targetLowerWorldQ);
  lowerArmNode.quaternion.slerp(localLowerQ, 0.4);

  // Wrist orientation
  if (handLM && handLM.length === 21) {
    const p0 = handLM[0];
    const p5 = handLM[5];
    const p17 = handLM[17];
    const forwardX = isLeft ? (p5.x + p17.x) / 2 - p0.x : -((p5.x + p17.x) / 2 - p0.x);
    const forwardY = -((p5.y + p17.y) / 2 - p0.y);
    const forwardZ = ((p5.z + p17.z) / 2 - p0.z) * 0.4;
    const vForward = _scratchV1.set(forwardX, forwardY, forwardZ).normalize();

    const sideX = isLeft ? p17.x - p5.x : -(p17.x - p5.x);
    const sideY = -(p17.y - p5.y);
    const sideZ = (p17.z - p5.z) * 0.4;
    const vSide = _scratchV2.set(sideX, sideY, sideZ).normalize();

    const vNorm = _scratchV3.crossVectors(vForward, vSide).normalize();
    const vCorrectSide = _scratchV4.crossVectors(vNorm, vForward).normalize();

    const rotMatrix = new THREE.Matrix4().makeBasis(
      isLeft ? vCorrectSide : vCorrectSide.negate(),
      vNorm,
      vForward
    );
    const targetHandWorldQ = _scratchQ1.setFromRotationMatrix(rotMatrix);
    const lowerArmWorldQ = _scratchQ2;
    lowerArmNode.getWorldQuaternion(lowerArmWorldQ);
    const lowerArmInvQ = lowerArmWorldQ.invert();
    const localHandQ = _scratchQ3.multiplyQuaternions(lowerArmInvQ, targetHandWorldQ);
    handNode.quaternion.slerp(localHandQ, 0.45);
  }
}