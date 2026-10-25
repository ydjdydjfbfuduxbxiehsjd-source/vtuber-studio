console.log("[VTuber Studio Pro] solveArmVectorIK & OneEuroFilter loaded successfully");
console.log(
  '%c VTuber Studio PRO %c v1.2.4 build 2026-10-24 00:25 %c feature/arm-tracking-rewrite ',
  'background:#4f46e5;color:#fff;font-weight:bold;padding:3px 6px;border-radius:4px 0 0 4px;',
  'background:#10b981;color:#000;font-weight:bold;padding:3px 6px;',
  'background:#1e293b;color:#94a3b8;padding:3px 6px;border-radius:0 4px 4px 0;'
);
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils, VRM, type VRMHumanBoneName } from '@pixiv/three-vrm';
import { Face as KalidokitFace } from 'kalidokit';
import { OneEuroFilter3D } from './oneEuroFilter';
import { ArmRig, ArmDebugVisualizer } from './tracking/armRig';
import { solveArmVectorIKLegacy } from './legacy/armTrackingLegacy';

// Declare globals for MediaPipe UMD scripts loaded via index.html
declare global {
  interface Window {
    Camera: any;
    Holistic: any;
  }
}

/* ==========================================================================
   APP STATE & SETTINGS
   ========================================================================== */
interface TrackingSettings {
  legacyArmTracking: boolean;
  head: boolean;
  mouth: boolean;
  hands: boolean;
  leftHand: boolean;
  rightHand: boolean;
  micLipSync: boolean;
  smoothing: number; // 0.1 to 0.8
  headSens: number;
  handSens: number;
  mouthSens: number;
  eyeSens: number;
  armCollision: boolean;
  reachMultiplier: number;
  torso: boolean;
  torsoSens: number;
  mirror: boolean;
  showSkeleton: boolean;
  bgColor: string;
}


const settings: TrackingSettings = {
  legacyArmTracking: false,
  head: true,
  mouth: true,
  hands: true,
  leftHand: true,
  rightHand: true,
  micLipSync: false,
  smoothing: 0.35,
  headSens: 1.0,
  handSens: 1.0,
  mouthSens: 1.2,
  eyeSens: 1.0,
  armCollision: true,
  reachMultiplier: 1.15,
  torso: true,
  torsoSens: 1.0,
  mirror: true,
  showSkeleton: true,
  bgColor: '#161822',
};

// Natural Resting / Idle Posture Rotations
const idleArmRotations = {
  leftShoulder: new THREE.Euler(0, 0, 0),
  rightShoulder: new THREE.Euler(0, 0, 0),
  leftUpperArm: new THREE.Euler(0, 0, THREE.MathUtils.degToRad(-72)),
  leftLowerArm: new THREE.Euler(0, 0, THREE.MathUtils.degToRad(-15)),
  leftHand: new THREE.Euler(0, 0, 0),
  rightUpperArm: new THREE.Euler(0, 0, THREE.MathUtils.degToRad(72)),
  rightLowerArm: new THREE.Euler(0, 0, THREE.MathUtils.degToRad(15)),
  rightHand: new THREE.Euler(0, 0, 0),
};

/* ==========================================================================
   THREE.JS SCENE SETUP
   ========================================================================== */
const canvas = document.getElementById('vrm-canvas') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({
  canvas,
  alpha: true,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
const armRigLeft = new ArmRig('left');
const armRigRight = new ArmRig('right');
const armDebugVisualizer = new ArmDebugVisualizer(scene);
scene.background = new THREE.Color(settings.bgColor);

const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 20.0);
camera.position.set(0.0, 1.4, 1.35);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0.0, 1.3, 0.0);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.maxDistance = 4.0;
controls.minDistance = 0.4;
controls.update();

// Lights
const ambientLight = new THREE.AmbientLight(0xffffff, 1.2);
scene.add(ambientLight);

const keyLight = new THREE.DirectionalLight(0xffffff, 1.3);
keyLight.position.set(1.5, 2.5, 2.0);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xa5c5ff, 0.7);
fillLight.position.set(-1.5, 2.0, 1.5);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0xfff0dd, 0.9);
rimLight.position.set(0.0, 2.5, -2.0);
scene.add(rimLight);
/* ==========================================================================
   VRM MODEL MANAGEMENT
   ========================================================================== */
let currentVrm: VRM | null = null;
const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

const modelStatusText = document.getElementById('model-status-text')!;

function setWorkflowStep(id: string, state: 'pending' | 'active' | 'complete' | 'error', label: string) {
  const step = document.getElementById(id);
  if (!step) return;
  if (step.dataset.state !== state) step.dataset.state = state;
  const stateLabel = step.querySelector('.workflow-state');
  if (stateLabel && stateLabel.textContent !== label) stateLabel.textContent = label;
}

function relaxFingers(side: 'left' | 'right') {
  if (!currentVrm || !currentVrm.humanoid) return;
  const prefix = side;
  const curl = THREE.MathUtils.degToRad(14);
  const fingerBones = [
    'IndexProximal', 'IndexIntermediate', 'IndexDistal',
    'MiddleProximal', 'MiddleIntermediate', 'MiddleDistal',
    'RingProximal', 'RingIntermediate', 'RingDistal',
    'LittleProximal', 'LittleIntermediate', 'LittleDistal',
  ];
  for (const f of fingerBones) {
    const boneName = `${prefix}${f}` as VRMHumanBoneName;
    const node = currentVrm.humanoid.getNormalizedBoneNode(boneName);
    if (node) {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, side === 'left' ? -1 : 1), curl);
      node.quaternion.slerp(q, 0.1);
    }
  }
  const thumbBones = ['ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal'];
  for (const t of thumbBones) {
    const boneName = `${prefix}${t}` as VRMHumanBoneName;
    const node = currentVrm.humanoid.getNormalizedBoneNode(boneName);
    if (node) {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, side === 'left' ? -1 : 1), curl * 0.5);
      node.quaternion.slerp(q, 0.1);
    }
  }
}

function resetEntireArmToIdle(side: 'left' | 'right') {
  if (!currentVrm || !currentVrm.humanoid) return;
  const rate = 0.15;
  if (side === 'left') {
    const bones: [VRMHumanBoneName, THREE.Euler][] = [
      ['leftShoulder', idleArmRotations.leftShoulder],
      ['leftUpperArm', idleArmRotations.leftUpperArm],
      ['leftLowerArm', idleArmRotations.leftLowerArm],
      ['leftHand', idleArmRotations.leftHand],
    ];
    for (const [name, targetEuler] of bones) {
      const node = currentVrm.humanoid.getNormalizedBoneNode(name);
      if (node) {
        const q = new THREE.Quaternion().setFromEuler(targetEuler);
        node.quaternion.slerp(q, rate);
      }
    }
    relaxFingers('left');
  } else {
    const bones: [VRMHumanBoneName, THREE.Euler][] = [
      ['rightShoulder', idleArmRotations.rightShoulder],
      ['rightUpperArm', idleArmRotations.rightUpperArm],
      ['rightLowerArm', idleArmRotations.rightLowerArm],
      ['rightHand', idleArmRotations.rightHand],
    ];
    for (const [name, targetEuler] of bones) {
      const node = currentVrm.humanoid.getNormalizedBoneNode(name);
      if (node) {
        const q = new THREE.Quaternion().setFromEuler(targetEuler);
        node.quaternion.slerp(q, rate);
      }
    }
    relaxFingers('right');
  }
}

function showEmotionToast(icon: string, title: string, desc: string) {
  console.log(`[VTuber Studio] ${icon} ${title}: ${desc}`);
}

function applyRestingPose() {
  if (!currentVrm || !currentVrm.humanoid) return;
  const bones = [
    { name: 'leftShoulder' as VRMHumanBoneName, euler: idleArmRotations.leftShoulder },
    { name: 'leftUpperArm' as VRMHumanBoneName, euler: idleArmRotations.leftUpperArm },
    { name: 'leftLowerArm' as VRMHumanBoneName, euler: idleArmRotations.leftLowerArm },
    { name: 'leftHand' as VRMHumanBoneName, euler: idleArmRotations.leftHand },
    { name: 'rightShoulder' as VRMHumanBoneName, euler: idleArmRotations.rightShoulder },
    { name: 'rightUpperArm' as VRMHumanBoneName, euler: idleArmRotations.rightUpperArm },
    { name: 'rightLowerArm' as VRMHumanBoneName, euler: idleArmRotations.rightLowerArm },
    { name: 'rightHand' as VRMHumanBoneName, euler: idleArmRotations.rightHand },
  ];
  for (const b of bones) {
    const node = currentVrm.humanoid.getNormalizedBoneNode(b.name);
    if (node) {
      node.quaternion.setFromEuler(b.euler);
    }
  }
  relaxFingers('left');
  relaxFingers('right');
}

let isArkitModel = false;
const modelExpressionNames = new Set<string>();

function updateModelCapabilities() {
  modelExpressionNames.clear();
  if (currentVrm?.expressionManager?.expressionMap) {
    for (const name of Object.keys(currentVrm.expressionManager.expressionMap)) {
      modelExpressionNames.add(name);
    }
  }
  isArkitModel =
    modelExpressionNames.has('eyeBlinkLeft') ||
    modelExpressionNames.has('jawOpen') ||
    modelExpressionNames.has('mouthSmileLeft');

  console.log("[VTuber Studio Pro] solveArmVectorIK & OneEuroFilter loaded successfully");
console.log(
    `[Model Detection] Expressions: ${modelExpressionNames.size}, ARKit 52 Perfect Sync: ${isArkitModel}`
  );
}

// setExpression defined above with capability check

const btnLoadSample = document.getElementById('btn-load-sample');

function updateActiveModelButton(activeModel: 'sample' | 'custom') {
  if (btnLoadSample) {
    if (activeModel === 'sample') {
      btnLoadSample.classList.add('active-model-btn');
      btnLoadSample.style.border = '1.5px solid var(--accent-primary)';
      btnLoadSample.style.background = 'rgba(99, 102, 241, 0.15)';
    } else {
      btnLoadSample.classList.remove('active-model-btn');
      btnLoadSample.style.border = '1px solid rgba(255, 255, 255, 0.1)';
      btnLoadSample.style.background = 'rgba(255, 255, 255, 0.04)';
    }
  }
}

if (btnLoadSample) {
  btnLoadSample.addEventListener('click', () => {
    updateActiveModelButton('sample');
    loadVRM('/models/sample.vrm', 'Базовый VRM');
  });
}

// Setup Legacy Arm Tracking toggle UI
const toggleLegacyArms = document.getElementById('toggle-legacy-arms') as HTMLInputElement | null;
if (toggleLegacyArms) {
  toggleLegacyArms.checked = settings.legacyArmTracking;
  const legacyEls = document.querySelectorAll('.legacy-arm-control');
  legacyEls.forEach(el => (el as HTMLElement).style.display = settings.legacyArmTracking ? 'block' : 'none');

  toggleLegacyArms.addEventListener('change', (e) => {
    settings.legacyArmTracking = (e.target as HTMLInputElement).checked;
    legacyEls.forEach(el => (el as HTMLElement).style.display = settings.legacyArmTracking ? 'block' : 'none');
  });
}

updateActiveModelButton('sample');
loadVRM('/models/sample.vrm', 'Базовый VRM');

/* ==========================================================================
   AVATAR REAL SKELETON ARM LENGTHS (STAGE 1)
   ========================================================================== */
export interface ArmLengths {
  L1: number;
  L2: number;
  total: number;
}

export const avatarArmLengths: { left: ArmLengths; right: ArmLengths } = {
  left: { L1: 0.225, L2: 0.218, total: 0.443 },
  right: { L1: 0.225, L2: 0.218, total: 0.443 },
};

export function computeAvatarArmLengths() {
  if (!currentVrm || !currentVrm.humanoid) return;

  currentVrm.scene.updateMatrixWorld(true);

  const sides: ('left' | 'right')[] = ['left', 'right'];
  for (const side of sides) {
    const upper = currentVrm.humanoid.getNormalizedBoneNode((side + 'UpperArm') as VRMHumanBoneName);
    const lower = currentVrm.humanoid.getNormalizedBoneNode((side + 'LowerArm') as VRMHumanBoneName);
    const hand = currentVrm.humanoid.getNormalizedBoneNode((side + 'Hand') as VRMHumanBoneName);

    if (upper && lower && hand) {
      const pUpper = new THREE.Vector3();
      const pLower = new THREE.Vector3();
      const pHand = new THREE.Vector3();

      upper.getWorldPosition(pUpper);
      lower.getWorldPosition(pLower);
      hand.getWorldPosition(pHand);

      const dUpperToLower = pUpper.distanceTo(pLower);
      const dLowerToHand = pLower.distanceTo(pHand);

      const L1 = (Number.isFinite(dUpperToLower) && dUpperToLower > 0.05 && dUpperToLower < 1.0) ? dUpperToLower : 0.225;
      const L2 = (Number.isFinite(dLowerToHand) && dLowerToHand > 0.05 && dLowerToHand < 1.0) ? dLowerToHand : 0.218;

      avatarArmLengths[side] = {
        L1,
        L2,
        total: L1 + L2,
      };
    }
  }

  console.log("[VTuber Studio Pro] solveArmVectorIK & OneEuroFilter loaded successfully");
console.log(
    "[Skeleton Arm Lengths] Left: L1=" + avatarArmLengths.left.L1.toFixed(3) + "m, L2=" + avatarArmLengths.left.L2.toFixed(3) + "m (Total: " + avatarArmLengths.left.total.toFixed(3) + "m) | Right: L1=" + avatarArmLengths.right.L1.toFixed(3) + "m, L2=" + avatarArmLengths.right.L2.toFixed(3) + "m (Total: " + avatarArmLengths.right.total.toFixed(3) + "m)"
  );
}

function loadVRM(url: string, name = 'Sample Model') {
  modelStatusText.textContent = `Модель: Загрузка (${name})...`;
  setWorkflowStep('workflow-model', 'active', 'Загружается');

  loader.load(
    url,
    (gltf) => {
      if (currentVrm) {
        scene.remove(currentVrm.scene);
        VRMUtils.deepDispose(currentVrm.scene);
      }

      const vrm = gltf.userData.vrm as VRM;
      currentVrm = vrm;

      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.removeUnnecessaryJoints(gltf.scene);
      VRMUtils.rotateVRM0(vrm);

      scene.add(vrm.scene);
      updateModelCapabilities();
      applyRestingPose();
      computeAvatarArmLengths();
      armRigLeft.initFromVRM(vrm);
      armRigRight.initFromVRM(vrm);

      modelStatusText.textContent = `Модель: ${name} ${isArkitModel ? '(ARKit 52 ✨)' : ''}`;
      setWorkflowStep('workflow-model', 'complete', 'Готово');
      console.log("[VTuber Studio Pro] solveArmVectorIK & OneEuroFilter loaded successfully");
console.log('Loaded VRM successfully:', vrm);
    },
    (progress) => {
      if (progress.total > 0) {
        const pct = Math.round((progress.loaded / progress.total) * 100);
        modelStatusText.textContent = `Модель: Загрузка ${pct}%`;
      }
    },
    (error) => {
      console.error('Error loading VRM:', error);
      modelStatusText.textContent = 'Ошибка загрузки модели';
      setWorkflowStep('workflow-model', 'error', 'Ошибка загрузки');
    }
  );
}

/* ==========================================================================
   PERFORMANCE: REUSABLE SCRATCH OBJECTS (STAGE 9: ZERO ALLOCATIONS IN HOT LOOP)
   ========================================================================== */
const _scratchV1 = new THREE.Vector3();
const _scratchV2 = new THREE.Vector3();
const _scratchQ1 = new THREE.Quaternion();
const _scratchQ2 = new THREE.Quaternion();
const _scratchE1 = new THREE.Euler();
const BEND_AXIS_Z_POS = new THREE.Vector3(0, 0, 1);
const BEND_AXIS_Z_NEG = new THREE.Vector3(0, 0, -1);

const _colHeadPos = new THREE.Vector3();
const _colChestPos = new THREE.Vector3();
const _colHipsPos = new THREE.Vector3();
const _colVHead = new THREE.Vector3();
const _colVAB = new THREE.Vector3();
const _colCenter = new THREE.Vector3();

/* ==========================================================================
   BONE RIGGING & HELPER FUNCTIONS
   ========================================================================== */
function rigRotation(
  boneName: VRMHumanBoneName,
  rotation?: { x: number; y: number; z: number } | null,
  dampener = 1,
  lerpRate?: number
) {
  if (!currentVrm || !currentVrm.humanoid || !rotation) return;
  const boneNode = currentVrm.humanoid.getNormalizedBoneNode(boneName);
  if (!boneNode) return;

  _scratchE1.set(rotation.x * dampener, rotation.y * dampener, rotation.z * dampener, 'XYZ');
  _scratchQ1.setFromEuler(_scratchE1);

  const rate = lerpRate !== undefined ? lerpRate : 1 - settings.smoothing;
  boneNode.quaternion.slerp(_scratchQ1, THREE.MathUtils.clamp(rate, 0.05, 0.8));
}

function setExpression(name: string, value: number) {
  if (!currentVrm || !currentVrm.expressionManager) return;
  currentVrm.expressionManager.setValue(name, THREE.MathUtils.clamp(value, 0, 1));
}

interface FaceExpressionFilterState {
  value: number;
  timestamp: number;
}

const faceExpressionFilters = new Map<string, FaceExpressionFilterState>();

function remapFaceFeature(value: number, low: number, high: number, sensitivity = 1) {
  if (!Number.isFinite(value) || high <= low) return 0;
  const t = THREE.MathUtils.clamp(((value - low) / (high - low)) * sensitivity, 0, 1);
  return t * t * (3 - 2 * t);
}

function setFaceExpression(name: string, target: number, timestamp = performance.now()) {
  if (!currentVrm || !currentVrm.expressionManager) return;

  const safeTarget = THREE.MathUtils.clamp(Number.isFinite(target) ? target : 0, 0, 1);
  const previous = faceExpressionFilters.get(name) ?? { value: 0, timestamp: timestamp - 1000 / 30 };
  const dt = THREE.MathUtils.clamp((timestamp - previous.timestamp) / 1000, 1 / 240, 0.12);
  const smoothing = THREE.MathUtils.clamp(settings.smoothing, 0.1, 0.8);
  const baseTime = THREE.MathUtils.lerp(0.025, 0.09, smoothing);
  const timeConstant = safeTarget > previous.value ? baseTime * 0.55 : baseTime * 1.25;
  const alpha = 1 - Math.exp(-dt / timeConstant);
  const value = THREE.MathUtils.lerp(previous.value, safeTarget, alpha);

  faceExpressionFilters.set(name, { value, timestamp });
  setExpression(name, value);
}

function clearFaceExpressionFilters() {
  faceExpressionFilters.clear();
}
/* ==========================================================================
   PRESET EMOTIONS SYSTEM (MANUAL)
   ========================================================================== */
export type EmotionPresetId =
  | 'NEUTRAL'
  | 'HAPPY'
  | 'SURPRISED'
  | 'ANGRY'
  | 'RELAXED'
  | 'OPEN_PALM';

interface EmotionValues {
  happy: number;
  relaxed: number;
  surprised: number;
  angry: number;
  sad: number;
  mouthSmile: number;
  mouthOpen: number;
}

interface EmotionPresetDef {
  id: EmotionPresetId;
  name: string;
  icon: string;
  desc: string;
  values: EmotionValues;
}

const EMOTION_PRESETS: Record<EmotionPresetId, EmotionPresetDef> = {
  NEUTRAL: {
    id: 'NEUTRAL',
    name: 'Нейтрально',
    icon: '😐',
    desc: 'Чистое естественное отслеживание с веб-камеры',
    values: { happy: 0, relaxed: 0, surprised: 0, angry: 0, sad: 0, mouthSmile: 0, mouthOpen: 0 },
  },
  HAPPY: {
    id: 'HAPPY',
    name: 'Радость',
    icon: '😊',
    desc: 'Яркая открытая радостная улыбка',
    values: { happy: 0.9, relaxed: 0.4, surprised: 0, angry: 0, sad: 0, mouthSmile: 0.7, mouthOpen: 0.05 },
  },
  SURPRISED: {
    id: 'SURPRISED',
    name: 'Удивление',
    icon: '😲',
    desc: 'Широко открытые глаза и приоткрытый рот',
    values: { happy: 0, relaxed: 0, surprised: 0.85, angry: 0, sad: 0, mouthSmile: 0, mouthOpen: 0.28 },
  },
  RELAXED: {
    id: 'RELAXED',
    name: 'Спокойствие',
    icon: '😌',
    desc: 'Мягкое гармоничное умиротворение',
    values: { happy: 0.4, relaxed: 0.8, surprised: 0, angry: 0, sad: 0, mouthSmile: 0.3, mouthOpen: 0 },
  },
  ANGRY: {
    id: 'ANGRY',
    name: 'Решимость / Бой',
    icon: '✊',
    desc: 'Сосредоточенный решительный боевой взгляд',
    values: { happy: 0, relaxed: 0, surprised: 0, angry: 0.55, sad: 0, mouthSmile: 0, mouthOpen: 0 },
  },
  OPEN_PALM: {
    id: 'OPEN_PALM',
    name: 'Приветствие',
    icon: '🖐️',
    desc: 'Тёплое открытое приветствие',
    values: { happy: 0.75, relaxed: 0.3, surprised: 0, angry: 0, sad: 0, mouthSmile: 0.5, mouthOpen: 0.04 },
  },
};

// Current Emotion State Manager
let selectedEmotionMode: EmotionPresetId = 'NEUTRAL';

// Smoothed blended emotion weights
const blendedEmotion: EmotionValues = {
  happy: 0,
  relaxed: 0,
  surprised: 0,
  angry: 0,
  sad: 0,
  mouthSmile: 0,
  mouthOpen: 0,
};

/**
 * Robust 3D Vector Inverse Kinematics for Arms
 * Uses poseWorldLandmarks (true 3D in meters) for upper & lower arm.
 * Uses full 3D orthonormal basis from hand landmarks for 100% natural wrist twist (pronation/supination).
 */

/* ==========================================================================
   BODY COLLISION RESOLUTION (Torso, Chest, Head, Hips)
   Prevents hands, forearms, and elbows from passing through the body
   ========================================================================== */
function resolveBodyColliders(
  point: THREE.Vector3,
  minMargin = 0.035,
  isWristOrHand = false,
  faceTouchWeight = 0.0
): THREE.Vector3 {
  if (!currentVrm || !currentVrm.humanoid) return point.clone();

  const out = point.clone();

  // 1. Head Sphere Collider (Stage 6: Soft head collision for wrist, attenuated by face-touch mode)
  const headNode = currentVrm.humanoid.getNormalizedBoneNode('head');
  if (headNode) {
    headNode.getWorldPosition(_colHeadPos);
    _colHeadPos.y += 0.02; // Center on skull
    _colVHead.subVectors(out, _colHeadPos);
    const distSq = _colVHead.lengthSq();

    if (isWristOrHand) {
      // Radius ~0.07m for wrist, minimal clearance 0.005m, attenuated while face-touch mode is active
      const collisionFactor = THREE.MathUtils.clamp(1.0 - faceTouchWeight, 0.0, 1.0);
      const wristHeadRadius = 0.07 + 0.005;
      if (collisionFactor > 0.01 && distSq < wristHeadRadius * wristHeadRadius && distSq > 1e-6) {
        const dist = Math.sqrt(distSq);
        _scratchV1.copy(_colHeadPos).addScaledVector(_colVHead.multiplyScalar(1 / dist), wristHeadRadius);
        out.lerp(_scratchV1, collisionFactor);
      }
    } else {
      // Elbows collide fully with head sphere so they never clip into the head
      const elbowHeadRadius = 0.11 + minMargin;
      if (distSq < elbowHeadRadius * elbowHeadRadius && distSq > 1e-6) {
        const dist = Math.sqrt(distSq);
        out.copy(_colHeadPos).addScaledVector(_colVHead.multiplyScalar(1 / dist), elbowHeadRadius);
      }
    }
  }

  // 2. Torso Elliptical Capsule Collider (Chest down to Hips)
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

      // Anatomical width (rx) and depth (rz) of the avatar at height t
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

// Hand Tracking Temporal Hysteresis (~250ms window)
let rightHandLastSeenTime = 0;
let leftHandLastSeenTime = 0;
let lastValidRightHandLM: any[] | null = null;
let lastValidLeftHandLM: any[] | null = null;
const HAND_HYSTERESIS_MS = 250;

// Pose Landmark Visibility Caching Filter (falls back to last good coordinate if visibility < 0.5)
interface CachedJoint {
  x: number;
  y: number;
  z: number;
}
const lastGoodPoseLandmarks: Record<number, CachedJoint> = {};

function getValidPoseLandmark(index: number, rawPl: any[] | null | undefined, rawWl: any[] | null | undefined): CachedJoint {
  const pCheck = rawPl && rawPl[index];
  const wPoint = (rawWl && rawWl[index]) || pCheck;
  const vis = pCheck?.visibility ?? 1.0;

  if (wPoint && vis >= 0.5) {
    lastGoodPoseLandmarks[index] = { x: wPoint.x, y: wPoint.y, z: wPoint.z };
    return lastGoodPoseLandmarks[index];
  }

  if (lastGoodPoseLandmarks[index]) {
    return lastGoodPoseLandmarks[index];
  }

  if (wPoint) {
    return { x: wPoint.x, y: wPoint.y, z: wPoint.z };
  }

  return { x: 0, y: 0, z: 0 };
}

// Avatar Shoulder Width & Rolling Median Scale Filter (0.8 - 1.3)
function getAvatarShoulderWidth(): number {
  if (!currentVrm || !currentVrm.humanoid) return 0.32;
  const lShoulder = currentVrm.humanoid.getNormalizedBoneNode('leftUpperArm');
  const rShoulder = currentVrm.humanoid.getNormalizedBoneNode('rightUpperArm');
  if (lShoulder && rShoulder) {
    const pL = new THREE.Vector3();
    const pR = new THREE.Vector3();
    lShoulder.getWorldPosition(pL);
    rShoulder.getWorldPosition(pR);
    const dist = pL.distanceTo(pR);
    if (dist > 0.15 && dist < 0.8) return dist;
  }
  return 0.32;
}

/* ==========================================================================
   USER SHOULDER SCALE & 2-SECOND MEDIAN FILTER (STAGE 2)
   ========================================================================== */
export const shoulderSamples: number[] = [];
export const MAX_SHOULDER_SAMPLES = 120; // ~2 seconds of history at 60 FPS
export let lastGoodUserShoulderWidth: number = 0.32;
export let lastGoodArmScale: number = 1.0;

export function computeArmScale(userShoulderWidth: number | null): number {
  if (userShoulderWidth !== null && Number.isFinite(userShoulderWidth) && userShoulderWidth > 0.08 && userShoulderWidth < 1.5) {
    shoulderSamples.push(userShoulderWidth);
    if (shoulderSamples.length > MAX_SHOULDER_SAMPLES) {
      shoulderSamples.shift();
    }
  }
  if (shoulderSamples.length > 0) {
    const sorted = [...shoulderSamples].sort((a, b) => a - b);
    const medianUser = sorted[Math.floor(sorted.length / 2)];
    lastGoodUserShoulderWidth = medianUser;
    const avatarWidth = getAvatarShoulderWidth();
    const rawScale = avatarWidth / medianUser;
    const scale = THREE.MathUtils.clamp(rawScale, 0.8, 1.4);
    lastGoodArmScale = scale;
    return scale;
  }
  return lastGoodArmScale || 1.0;
}

/* ==========================================================================
   FACE TOUCH ENGINE WITH HYSTERESIS & EXPONENTIAL BLENDING (STAGE 4)
   ========================================================================== */
export interface FaceTouchState {
  isActive: boolean;
  weight: number; // 0.0 to 1.0
  lastTimestamp: number;
}

/* ==========================================================================
   ELBOW POLE VECTOR CACHE & ANATOMICAL CONSTRAINTS (STAGE 5)
   ========================================================================== */

/* ==========================================================================
   1€ FILTERS FOR ELBOW & WRIST POSITIONS (STAGE 7)
   minCutoff: 1.2 Hz (smooth at low speeds), beta: 0.02 (zero latency at fast speed)
   ========================================================================== */

/* ==========================================================================
   DEBUG MODE HUD & 3D TARGET SPHERES (STAGE 8)
   ========================================================================== */
export let isDebugEnabled = false;
let debugWristSphereL: THREE.Mesh | null = null;
let debugWristSphereR: THREE.Mesh | null = null;

export function updateDebugSpheres(leftTarget?: THREE.Vector3, rightTarget?: THREE.Vector3) {
  if (!isDebugEnabled) {
    if (debugWristSphereL) debugWristSphereL.visible = false;
    if (debugWristSphereR) debugWristSphereR.visible = false;
    return;
  }
  if (!debugWristSphereL) {
    const geo = new THREE.SphereGeometry(0.022, 12, 12);
    const matL = new THREE.MeshBasicMaterial({ color: 0x06b6d4, wireframe: true });
    debugWristSphereL = new THREE.Mesh(geo, matL);
    scene.add(debugWristSphereL);

    const matR = new THREE.MeshBasicMaterial({ color: 0xec4899, wireframe: true });
    debugWristSphereR = new THREE.Mesh(geo, matR);
    scene.add(debugWristSphereR);
  }
  if (leftTarget && debugWristSphereL) {
    debugWristSphereL.position.copy(leftTarget);
    debugWristSphereL.visible = true;
  }
  if (rightTarget && debugWristSphereR) {
    debugWristSphereR.position.copy(rightTarget);
    debugWristSphereR.visible = true;
  }
}

export function toggleDebugMode() {
  isDebugEnabled = !isDebugEnabled;
  const panel = document.getElementById('debug-panel');
  if (panel) {
    if (isDebugEnabled) panel.classList.remove('hidden');
    else panel.classList.add('hidden');
  }
  const btn = document.getElementById('btn-toggle-debug');
  if (btn) {
    if (isDebugEnabled) btn.classList.add('active');
    else btn.classList.remove('active');
  }
  if (!isDebugEnabled) {
    updateDebugSpheres();
  }
  if (armDebugVisualizer) {
    armDebugVisualizer.setVisible(isDebugEnabled);
  }
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

export const faceTouchState: { left: FaceTouchState; right: FaceTouchState } = {
  left: { isActive: false, weight: 0.0, lastTimestamp: 0 },
  right: { isActive: false, weight: 0.0, lastTimestamp: 0 },
};

export function solveArmVectorIK(
  targetSide: 'left' | 'right',
  S3d: { x: number; y: number; z: number },
  E3d: { x: number; y: number; z: number },
  W3d: { x: number; y: number; z: number },
  handLM: any[] | null | undefined,
  _isUserRight: boolean,
  faceLM?: any[] | null,
  armScale: number = 1.0,
  shoulderVis: number = 1.0,
  elbowVis: number = 1.0
) {
  if (!currentVrm || !currentVrm.humanoid) return;

  const isLeft = targetSide === 'left';
  const vRest = new THREE.Vector3(isLeft ? 1 : -1, 0, 0);
  const slerpRate = THREE.MathUtils.clamp((1 - settings.smoothing) * 1.4, 0.18, 0.55);
  const mirrorX = settings.mirror ? -1 : 1;

  const upperBone = currentVrm.humanoid.getNormalizedBoneNode(isLeft ? 'leftUpperArm' : 'rightUpperArm');
  const lowerBone = currentVrm.humanoid.getNormalizedBoneNode(isLeft ? 'leftLowerArm' : 'rightLowerArm');
  const handBone = currentVrm.humanoid.getNormalizedBoneNode(isLeft ? 'leftHand' : 'rightHand');
  if (!upperBone || !lowerBone || !handBone) return;

  const shoulderPos = new THREE.Vector3();
  upperBone.getWorldPosition(shoulderPos);

  // 1. Arm segment lengths from real VRM skeleton (computed on model load)
  const armLen = avatarArmLengths[targetSide];
  const L1_avatar = armLen.L1;
  const L2_avatar = armLen.L2;
  const L_avatar = armLen.total;

  // 2. Position-based Target Wrist from Shoulder with Dampened Z (0.35x)
  // X and Y drive the primary screen position; Z foreshortening is dampened to prevent distortion
  const vUserWrist = new THREE.Vector3(
    (W3d.x - S3d.x) * mirrorX,
    -(W3d.y - S3d.y),
    -(W3d.z - S3d.z) * 0.4
  );
  if (vUserWrist.lengthSq() < 1e-6) vUserWrist.set(isLeft ? 0.25 : -0.25, -0.4, 0.1);

  // Scaled by shoulder width ratio (range: 0.8 - 1.3)
  let targetWristPos = shoulderPos.clone().addScaledVector(vUserWrist, armScale);

  // 3. FACE-TOUCH MODE (STAGE 4: HYSTERESIS & EXPONENTIAL BLENDING)
  const ftState = faceTouchState[targetSide];
  const nowTime = performance.now();
  if (ftState.lastTimestamp === 0) ftState.lastTimestamp = nowTime;
  const dt = Math.min(0.1, Math.max(0.001, (nowTime - ftState.lastTimestamp) / 1000));
  ftState.lastTimestamp = nowTime;

  let headWristTarget: THREE.Vector3 | null = null;

  if (faceLM && faceLM.length >= 468 && handLM && handLM.length === 21) {
    const nose = faceLM[1];
    const forehead = faceLM[10];
    const chin = faceLM[152];
    const leftCheek = faceLM[234];
    const rightCheek = faceLM[454];

    // Face height between forehead (10) and chin (152)
    const faceSize = Math.hypot(forehead.x - chin.x, forehead.y - chin.y);
    const validFaceSize = (Number.isFinite(faceSize) && faceSize > 0.05) ? faceSize : 0.15;

    // Wrist (0), Index MCP (5), Pinky MCP (17), Palm Center
    const p0 = handLM[0];
    const p5 = handLM[5];
    const p17 = handLM[17];
    const palmCenter = {
      x: (p0.x + p5.x + p17.x) / 3,
      y: (p0.y + p5.y + p17.y) / 3,
    };

    const distToPt = (pt: { x: number; y: number }) => Math.min(
      Math.hypot(p0.x - pt.x, p0.y - pt.y),
      Math.hypot(palmCenter.x - pt.x, palmCenter.y - pt.y)
    );

    const dNose = distToPt(nose);
    const dForehead = distToPt(forehead);
    const dChin = distToPt(chin);
    const dLCheek = distToPt(leftCheek);
    const dRCheek = distToPt(rightCheek);

    const minDistToFace = Math.min(dNose, dForehead, dChin, dLCheek, dRCheek);
    const normDist = minDistToFace / validFaceSize;

    // Hysteresis: activate at < 0.25, deactivate at > 0.35
    if (!ftState.isActive && normDist < 0.25) {
      ftState.isActive = true;
    } else if (ftState.isActive && normDist > 0.35) {
      ftState.isActive = false;
    }

    if (ftState.isActive || ftState.weight > 0.01) {
      const headNode = currentVrm.humanoid.getNormalizedBoneNode('head');
      if (headNode) {
        const headPos = new THREE.Vector3();
        const headQuat = new THREE.Quaternion();
        headNode.getWorldPosition(headPos);
        headNode.getWorldQuaternion(headQuat);

        const faceW = Math.max(0.08, Math.hypot(leftCheek.x - rightCheek.x, leftCheek.y - rightCheek.y));
        const faceMidY = (forehead.y + chin.y) / 2;
        const bestPt = Math.hypot(p0.x - nose.x, p0.y - nose.y) < Math.hypot(palmCenter.x - nose.x, palmCenter.y - nose.y) ? p0 : palmCenter;
        const relX = (bestPt.x - nose.x) / faceW;
        const relY = (bestPt.y - faceMidY) / validFaceSize;

        // Target surface of head with 0.025m outward margin to prevent mesh penetration
        const localHeadOffset = new THREE.Vector3(
          THREE.MathUtils.clamp(relX * mirrorX * 0.11, -0.11, 0.11),
          THREE.MathUtils.clamp(-relY * 0.13 - 0.015, -0.14, 0.10),
          0.105
        );
        headWristTarget = headPos.clone().add(localHeadOffset.applyQuaternion(headQuat));
      }
    }
  } else {
    ftState.isActive = false;
  }

  // Smooth exponential blending (100 - 150 ms)
  const targetWeight = ftState.isActive ? 1.0 : 0.0;
  const blendAlpha = 1.0 - Math.exp(-dt / 0.12);
  ftState.weight += (targetWeight - ftState.weight) * blendAlpha;
  ftState.weight = THREE.MathUtils.clamp(ftState.weight, 0.0, 1.0);

  if (headWristTarget && ftState.weight > 0.001) {
    targetWristPos.lerp(headWristTarget, ftState.weight);
  }

  // Body collision resolution on wrist (isWristOrHand = true bypasses head sphere)
  const resolvedWristPos = settings.armCollision
    ? resolveBodyColliders(targetWristPos, 0.02, true, ftState.weight)
    : targetWristPos;
  if (isDebugEnabled) {
    if (isLeft) updateDebugSpheres(resolvedWristPos, undefined);
    else updateDebugSpheres(undefined, resolvedWristPos);
  }

  // 4. Reach vector and distance clamping (max 0.98 * (L1 + L2) to prevent locking!)
  const vReach = new THREE.Vector3().subVectors(resolvedWristPos, shoulderPos);
  const rawReachDist = vReach.length();
  const scaledReachDist = rawReachDist * (settings.reachMultiplier || 1.15);
  const maxReach = L_avatar * 0.98; // 0.98 * (L1 + L2)
  const dClamped = THREE.MathUtils.clamp(scaledReachDist, 0.03, maxReach);

  const dTarget = rawReachDist > 1e-6
    ? vReach.clone().multiplyScalar(1 / rawReachDist)
    : new THREE.Vector3(isLeft ? 0.3 : -0.3, -0.8, 0).normalize();

  // 5. Law of Cosines for Shoulder Angle (alpha)
  const cosAlpha = (L1_avatar * L1_avatar + dClamped * dClamped - L2_avatar * L2_avatar) / (2 * L1_avatar * dClamped);
  const alpha = Math.acos(THREE.MathUtils.clamp(cosAlpha, -1, 1));

  // 6. Elbow Direction from MediaPipe Pose with Visibility Caching & Anatomical Constraints (Stage 5)
  const vUserElbow = new THREE.Vector3();
  if (shoulderVis >= 0.5 && elbowVis >= 0.5) {
    vUserElbow.set(
      (E3d.x - S3d.x) * mirrorX,
      -(E3d.y - S3d.y),
      -(E3d.z - S3d.z) * 0.4
    );
    if (vUserElbow.lengthSq() > 1e-5) {
      lastGoodElbowVec[targetSide].copy(vUserElbow).normalize();
    } else {
      vUserElbow.copy(lastGoodElbowVec[targetSide]);
    }
  } else {
    // Visibility of shoulder or elbow < 0.5: smoothly fallback to last good direction vector
    vUserElbow.copy(lastGoodElbowVec[targetSide]);
  }

  // Anatomical constraint: prevent elbow from going inside the torso or flipping unnaturally upwards
  const defaultDownOut = new THREE.Vector3(isLeft ? 0.45 : -0.45, -0.75, -0.15).normalize();
  const inwardPenalty = isLeft ? Math.max(0, 0.08 - vUserElbow.x) : Math.max(0, vUserElbow.x + 0.08);
  const upwardTolerance = targetWristPos.y > shoulderPos.y + 0.1 ? 0.45 : 0.05;
  const upwardPenalty = Math.max(0, vUserElbow.y - upwardTolerance);

  const correctionWeight = THREE.MathUtils.clamp((inwardPenalty * 4.0) + (upwardPenalty * 3.0), 0.0, 0.85);
  if (correctionWeight > 0.01) {
    vUserElbow.lerp(defaultDownOut, correctionWeight).normalize();
  }

  // Bend plane normal: dTarget x vUserElbow
  let planeNormal = new THREE.Vector3().crossVectors(dTarget, vUserElbow).normalize();
  if (planeNormal.lengthSq() < 1e-4) {
    const defaultPole = new THREE.Vector3(isLeft ? 0.35 : -0.35, -0.9, -0.2);
    planeNormal = new THREE.Vector3().crossVectors(dTarget, defaultPole).normalize();
    if (planeNormal.lengthSq() < 1e-4) {
      planeNormal.set(0, 0, isLeft ? 1 : -1);
    }
  }

  // Upper arm vector: rotate dTarget around bend plane normal by alpha
  const dUpper = dTarget.clone().applyAxisAngle(planeNormal, alpha).normalize();

  // Elbow position: shoulder + dUpper * L1
  const elbowPos = shoulderPos.clone().addScaledVector(dUpper, L1_avatar);
  const resolvedElbowPos = settings.armCollision
    ? resolveBodyColliders(elbowPos, 0.02, false)
    : elbowPos;

  if (resolvedElbowPos.distanceToSquared(elbowPos) > 1e-5) {
    dUpper.subVectors(resolvedElbowPos, shoulderPos).normalize();
  }

  // Forearm vector: from elbow to resolved wrist
  const dForearm = new THREE.Vector3().subVectors(resolvedWristPos, resolvedElbowPos).normalize();

  // 7. Apply Bone Rotations
  const qUpperTarget = new THREE.Quaternion().setFromUnitVectors(vRest, dUpper);
  upperBone.quaternion.slerp(qUpperTarget, slerpRate);

  const currentUpperQ = upperBone.quaternion.clone();
  const qUpperInv = currentUpperQ.clone().invert();
  const vLocalForearm = dForearm.clone().applyQuaternion(qUpperInv).normalize();

  const qLowerTarget = new THREE.Quaternion().setFromUnitVectors(vRest, vLocalForearm);
  lowerBone.quaternion.slerp(qLowerTarget, slerpRate);

  // 8. Direct Wrist Orientation (Orthonormal Basis from Hand Landmarks)
  if (handLM && handLM.length === 21) {
    const p0 = handLM[0];
    const p5 = handLM[5];
    const p9 = handLM[9];
    const p17 = handLM[17];

    let vFwd = new THREE.Vector3(
      (p9.x - p0.x) * mirrorX,
      -(p9.y - p0.y),
      -(p9.z - p0.z)
    ).normalize();

    let vAcross = new THREE.Vector3(
      (p5.x - p17.x) * mirrorX,
      -(p5.y - p17.y),
      -(p5.z - p17.z)
    );

    if (vAcross.lengthSq() < 1e-6) vAcross.set(0, 1, 0);
    else vAcross.normalize();

    vAcross.sub(vFwd.clone().multiplyScalar(vAcross.dot(vFwd))).normalize();

    let mBasis: THREE.Matrix4;
    if (isLeft) {
      const localX = vFwd;
      const localZ = vAcross;
      const localY = new THREE.Vector3().crossVectors(localZ, localX).normalize();
      mBasis = new THREE.Matrix4().makeBasis(localX, localY, localZ);
    } else {
      const localX = vFwd.clone().negate();
      const localZ = vAcross;
      const localY = new THREE.Vector3().crossVectors(localZ, localX).normalize();
      mBasis = new THREE.Matrix4().makeBasis(localX, localY, localZ);
    }

    const qHandWorld = new THREE.Quaternion().setFromRotationMatrix(mBasis);
    const currentLowerQ = lowerBone.quaternion.clone();
    const qArmWorld = currentUpperQ.clone().multiply(currentLowerQ);
    const qHandLocalTarget = qArmWorld.clone().invert().multiply(qHandWorld);

    handBone.quaternion.slerp(qHandLocalTarget, slerpRate * 0.85);
  } else {
    handBone.quaternion.slerp(new THREE.Quaternion(), 0.1);
  }

  // 9. Direct 5-Finger Tracking (All 21 Landmarks)
  if (handLM && handLM.length === 21) {
    const fingerDefs = [
      { name: 'Thumb', joints: [1, 2, 3, 4], isThumb: true },
      { name: 'Index', joints: [5, 6, 7, 8], isThumb: false },
      { name: 'Middle', joints: [9, 10, 11, 12], isThumb: false },
      { name: 'Ring', joints: [13, 14, 15, 16], isThumb: false },
      { name: 'Little', joints: [17, 18, 19, 20], isThumb: false },
    ];
    const bendAxis = isLeft ? BEND_AXIS_Z_NEG : BEND_AXIS_Z_POS;
    const thumbBendAxis = isLeft ? BEND_AXIS_Z_POS : BEND_AXIS_Z_NEG;
    for (const f of fingerDefs) {
      const [j0, j1, j2, j3] = f.joints;
      const p0 = handLM[j0];
      const p3 = handLM[j3];
      const d01 = Math.hypot(handLM[j1].x - p0.x, handLM[j1].y - p0.y, handLM[j1].z - p0.z);
      const d12 = Math.hypot(handLM[j2].x - handLM[j1].x, handLM[j2].y - handLM[j1].y, handLM[j2].z - handLM[j1].z);
      const d23 = Math.hypot(p3.x - handLM[j2].x, p3.y - handLM[j2].y, p3.z - handLM[j2].z);
      const totalLen = d01 + d12 + d23;
      const directDist = Math.hypot(p3.x - p0.x, p3.y - p0.y, p3.z - p0.z);
      const openRatio = totalLen > 1e-4 ? directDist / totalLen : 1;
      const curl = THREE.MathUtils.clamp((0.92 - openRatio) / 0.52, 0, 1) * settings.handSens;
      const a1 = curl * (f.isThumb ? 0.6 : 1.25);
      const a2 = curl * (f.isThumb ? 0.7 : 1.35);
      const a3 = curl * (f.isThumb ? 0.7 : 1.15);
      const prefix = isLeft ? 'left' : 'right';
      const b1Name = (prefix + f.name + (f.isThumb ? 'Metacarpal' : 'Proximal')) as VRMHumanBoneName;
      const b2Name = (prefix + f.name + (f.isThumb ? 'Proximal' : 'Intermediate')) as VRMHumanBoneName;
      const b3Name = (prefix + f.name + 'Distal') as VRMHumanBoneName;

      const b1 = currentVrm.humanoid.getNormalizedBoneNode(b1Name);
      const b2 = currentVrm.humanoid.getNormalizedBoneNode(b2Name);
      const b3 = currentVrm.humanoid.getNormalizedBoneNode(b3Name);

      const jointBendAxis = f.isThumb ? thumbBendAxis : bendAxis;
      if (b1) { _scratchQ1.setFromAxisAngle(jointBendAxis, a1); b1.quaternion.slerp(_scratchQ1, 0.5); }
      if (b2) { _scratchQ1.setFromAxisAngle(jointBendAxis, a2); b2.quaternion.slerp(_scratchQ1, 0.5); }
      if (b3) { _scratchQ1.setFromAxisAngle(jointBendAxis, a3); b3.quaternion.slerp(_scratchQ1, 0.5); }
    }
  } else {
    relaxFingers(targetSide);
  }
}

/* ==========================================================================
   MEDIAPIPE HOLISTIC TRACKING & RESULTS ENGINE
   ========================================================================== */
const videoElement = document.getElementById('webcam') as HTMLVideoElement;
const pipOverlay = document.getElementById('pip-overlay') as HTMLCanvasElement;
const pipCtx = pipOverlay.getContext('2d')!;
const camStatusText = document.getElementById('cam-status-text')!;
const leftHandBadge = document.getElementById('left-hand-state')!;
const rightHandBadge = document.getElementById('right-hand-state')!;
const pipFaceStatus = document.getElementById('pip-face-status')!;

let holisticInstance: any = null;
let cameraInstance: any = null;
let isCameraRunning = false;

function updateHandBadge(el: HTMLElement, active: boolean) {
  if (active) {
    el.classList.add('active');
    el.textContent = 'TRACKED';
  } else {
    el.classList.remove('active');
    el.textContent = 'IDLE';
  }
}

// Draw Landmark points on video overlay
function drawLandmarkSkeleton(results: any) {
  pipOverlay.width = videoElement.videoWidth || 320;
  pipOverlay.height = videoElement.videoHeight || 240;
  pipCtx.clearRect(0, 0, pipOverlay.width, pipOverlay.height);

  const w = pipOverlay.width;
  const h = pipOverlay.height;

  const getX = (x: number) => (settings.mirror ? (1 - x) * w : x * w);
  const getY = (y: number) => y * h;

  // Composite the same camera source Holistic processes. This avoids a black
  // preview when the browser compositor fails to paint the video element.
  const hasVideoFrame = videoElement.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    videoElement.videoWidth > 0 && videoElement.videoHeight > 0;
  if (hasVideoFrame) {
    pipCtx.save();
    if (settings.mirror) {
      pipCtx.translate(w, 0);
      pipCtx.scale(-1, 1);
    }
    pipCtx.drawImage(videoElement, 0, 0, w, h);
    pipCtx.restore();
  }

  const facePointCount = Array.isArray(results.faceLandmarks) ? results.faceLandmarks.length : 0;
  if (!hasVideoFrame) {
    pipFaceStatus.textContent = 'Нет видеокадра';
    pipFaceStatus.classList.remove('tracked');
    pipFaceStatus.classList.add('missing');
    setWorkflowStep('workflow-tracking', 'active', 'Жду видеокадр');
  } else if (facePointCount >= 468) {
    pipFaceStatus.textContent = `Лицо найдено · ${facePointCount} точек`;
    pipFaceStatus.classList.add('tracked');
    pipFaceStatus.classList.remove('missing');
    setWorkflowStep('workflow-tracking', 'complete', 'Лицо найдено');
  } else {
    pipFaceStatus.textContent = 'Лицо не найдено';
    pipFaceStatus.classList.remove('tracked');
    pipFaceStatus.classList.add('missing');
    setWorkflowStep('workflow-tracking', 'active', 'Ищу лицо');
  }

  if (!settings.showSkeleton) return;

  // Face Oval
  if (results.faceLandmarks) {
    pipCtx.fillStyle = 'rgba(99, 102, 241, 0.4)';
    const samplePoints = [10, 152, 234, 454, 1, 13, 14, 33, 263];
    for (const idx of samplePoints) {
      const pt = results.faceLandmarks[idx];
      if (pt) {
        pipCtx.beginPath();
        pipCtx.arc(getX(pt.x), getY(pt.y), 2.5, 0, Math.PI * 2);
        pipCtx.fill();
      }
    }
  }

  // Draw Torso & Arms from Pose landmarks
  if (results.poseLandmarks) {
    const pl = results.poseLandmarks;
    pipCtx.lineWidth = 3;

    // Shoulder Line (11 to 12)
    if (pl[11] && pl[12]) {
      pipCtx.strokeStyle = 'rgba(168, 85, 247, 0.8)';
      pipCtx.beginPath();
      pipCtx.moveTo(getX(pl[11].x), getY(pl[11].y));
      pipCtx.lineTo(getX(pl[12].x), getY(pl[12].y));
      pipCtx.stroke();
    }

    // Torso Frame: Shoulders to Hips
    if (pl[23] && pl[24]) {
      pipCtx.strokeStyle = 'rgba(99, 102, 241, 0.4)';
      pipCtx.beginPath();
      pipCtx.moveTo(getX(pl[11].x), getY(pl[11].y));
      pipCtx.lineTo(getX(pl[23].x), getY(pl[23].y));
      pipCtx.moveTo(getX(pl[12].x), getY(pl[12].y));
      pipCtx.lineTo(getX(pl[24].x), getY(pl[24].y));
      pipCtx.moveTo(getX(pl[23].x), getY(pl[23].y));
      pipCtx.lineTo(getX(pl[24].x), getY(pl[24].y));
      // Spine
      const sMidX = (pl[11].x + pl[12].x) / 2;
      const sMidY = (pl[11].y + pl[12].y) / 2;
      const hMidX = (pl[23].x + pl[24].x) / 2;
      const hMidY = (pl[23].y + pl[24].y) / 2;
      pipCtx.moveTo(getX(sMidX), getY(sMidY));
      pipCtx.lineTo(getX(hMidX), getY(hMidY));
      pipCtx.stroke();
    }

    // Left Arm (11 -> 13 -> 15)
    if (pl[11] && pl[13] && pl[15]) {
      pipCtx.strokeStyle = '#06b6d4';
      pipCtx.beginPath();
      pipCtx.moveTo(getX(pl[11].x), getY(pl[11].y));
      pipCtx.lineTo(getX(pl[13].x), getY(pl[13].y));
      pipCtx.lineTo(getX(pl[15].x), getY(pl[15].y));
      pipCtx.stroke();
    }

    // Right Arm (12 -> 14 -> 16)
    if (pl[12] && pl[14] && pl[16]) {
      pipCtx.strokeStyle = '#ec4899';
      pipCtx.beginPath();
      pipCtx.moveTo(getX(pl[12].x), getY(pl[12].y));
      pipCtx.lineTo(getX(pl[14].x), getY(pl[14].y));
      pipCtx.lineTo(getX(pl[16].x), getY(pl[16].y));
      pipCtx.stroke();
    }

    // Joint markers
    const armJoints = [11, 12, 13, 14, 15, 16, 23, 24];
    for (const idx of armJoints) {
      const pt = pl[idx];
      if (pt && (pt.visibility === undefined || pt.visibility > 0.3)) {
        pipCtx.beginPath();
        pipCtx.arc(getX(pt.x), getY(pt.y), 4, 0, Math.PI * 2);
        pipCtx.fillStyle = idx % 2 === 1 ? '#06b6d4' : '#ec4899';
        pipCtx.fill();
        pipCtx.strokeStyle = '#ffffff';
        pipCtx.lineWidth = 1.5;
        pipCtx.stroke();
      }
    }
  }

  // Draw Hand Joints
  const drawHandJoints = (landmarks: any[], color: string) => {
    pipCtx.strokeStyle = color;
    pipCtx.fillStyle = '#ffffff';
    pipCtx.lineWidth = 2;

    const fingerBones = [
      [0, 1, 2, 3, 4],
      [0, 5, 6, 7, 8],
      [0, 9, 10, 11, 12],
      [0, 13, 14, 15, 16],
      [0, 17, 18, 19, 20],
    ];

    for (const chain of fingerBones) {
      pipCtx.beginPath();
      for (let i = 0; i < chain.length; i++) {
        const pt = landmarks[chain[i]];
        const x = getX(pt.x);
        const y = getY(pt.y);
        if (i === 0) pipCtx.moveTo(x, y);
        else pipCtx.lineTo(x, y);
      }
      pipCtx.stroke();
    }

    for (const pt of landmarks) {
      pipCtx.beginPath();
      pipCtx.arc(getX(pt.x), getY(pt.y), 2.5, 0, Math.PI * 2);
      pipCtx.fill();
    }
  };

  if (results.leftHandLandmarks) {
    drawHandJoints(results.leftHandLandmarks, '#06b6d4');
  }
  if (results.rightHandLandmarks) {
    drawHandJoints(results.rightHandLandmarks, '#ec4899');
  }
}

// MediaPipe Results Processing
function onHolisticResults(results: any) {
  const frameStartTime = performance.now();
  drawLandmarkSkeleton(results);

  if (!currentVrm) return;

  // 1. Target Emotion Values based on active manual preset
  const targetEmotion: EmotionValues = EMOTION_PRESETS[selectedEmotionMode]?.values || EMOTION_PRESETS.NEUTRAL.values;

  // Smoothly blend emotion values towards target
  const blendRate = 0.16;
  blendedEmotion.happy = THREE.MathUtils.lerp(blendedEmotion.happy, targetEmotion.happy, blendRate);
  blendedEmotion.relaxed = THREE.MathUtils.lerp(blendedEmotion.relaxed, targetEmotion.relaxed, blendRate);
  blendedEmotion.surprised = THREE.MathUtils.lerp(blendedEmotion.surprised, targetEmotion.surprised, blendRate);
  blendedEmotion.angry = THREE.MathUtils.lerp(blendedEmotion.angry, targetEmotion.angry, blendRate);
  blendedEmotion.sad = THREE.MathUtils.lerp(blendedEmotion.sad, targetEmotion.sad, blendRate);
  blendedEmotion.mouthSmile = THREE.MathUtils.lerp(blendedEmotion.mouthSmile, targetEmotion.mouthSmile, blendRate);
  blendedEmotion.mouthOpen = THREE.MathUtils.lerp(blendedEmotion.mouthOpen, targetEmotion.mouthOpen, blendRate);

  // Apply base emotion blendshapes
  if (isArkitModel) {
    if (blendedEmotion.surprised > 0.05) {
      setExpression('browInnerUp', blendedEmotion.surprised);
      setExpression('eyeWideLeft', blendedEmotion.surprised * 0.7);
      setExpression('eyeWideRight', blendedEmotion.surprised * 0.7);
    }
    if (blendedEmotion.angry > 0.05) {
      setExpression('browDownLeft', blendedEmotion.angry);
      setExpression('browDownRight', blendedEmotion.angry);
      setExpression('noseSneerLeft', blendedEmotion.angry * 0.6);
      setExpression('noseSneerRight', blendedEmotion.angry * 0.6);
    }
  } else {
    setExpression('happy', blendedEmotion.happy);
    setExpression('relaxed', blendedEmotion.relaxed);
    setExpression('surprised', blendedEmotion.surprised);
    setExpression('angry', blendedEmotion.angry);
    setExpression('sad', blendedEmotion.sad);
  }

  // 2. FACE & HEAD ENGINE (ARKit 52 Perfect Sync & VRM Standard)
  if (results.faceLandmarks && results.faceLandmarks.length >= 468) {
    const lm = results.faceLandmarks;
    const solvedFace = settings.mouth
      ? KalidokitFace.solve(lm, { runtime: 'mediapipe', smoothBlink: false })
      : undefined;
    const faceH = Math.hypot(lm[10].x - lm[152].x, lm[10].y - lm[152].y);
    const faceW = Math.hypot(lm[234].x - lm[454].x, lm[234].y - lm[454].y);

    // A. Head & Neck Orientation
    if (settings.head) {
      // Yaw
      const dL = lm[1].x - lm[234].x;
      const dR = lm[454].x - lm[1].x;
      const rawYaw = (dR - dL) / (Math.abs(dR + dL) > 1e-4 ? dR + dL : 1);
      const headYaw = THREE.MathUtils.clamp((settings.mirror ? rawYaw : -rawYaw) * settings.headSens * 0.85, -0.65, 0.65);

      // Pitch
      const hTop = lm[1].y - lm[10].y;
      const hBot = lm[152].y - lm[1].y;
      const rawPitch = (hTop - hBot) / (Math.abs(hTop + hBot) > 1e-4 ? hTop + hBot : 1);
      const headPitch = THREE.MathUtils.clamp(rawPitch * settings.headSens * 1.1, -0.45, 0.45);

      // Roll
      const eyeDX = Math.abs(lm[263].x - lm[33].x);
      const eyeDY = lm[263].y - lm[33].y;
      const rawRoll = Math.atan2(eyeDY, eyeDX > 1e-4 ? eyeDX : 1);
      const headRoll = THREE.MathUtils.clamp((settings.mirror ? rawRoll : -rawRoll) * settings.headSens * 0.75, -0.4, 0.4);

      rigRotation('neck', { x: headPitch * 0.25, y: headYaw * 0.25, z: headRoll * 0.25 }, 1, 0.35);
      rigRotation('head', { x: headPitch * 0.75, y: headYaw * 0.75, z: headRoll * 0.75 }, 1, 0.35);
    }

    // B. Eyes: Natural Blinking & Micro-Expressions (ARKit / VRM)
    if (settings.mouth) {
      const leftH = Math.hypot(lm[159].x - lm[145].x, lm[159].y - lm[145].y);
      const leftW = Math.hypot(lm[133].x - lm[33].x, lm[133].y - lm[33].y);
      const leftRatio = leftH / (leftW > 1e-4 ? leftW : 1);

      const rightH = Math.hypot(lm[386].x - lm[374].x, lm[386].y - lm[374].y);
      const rightW = Math.hypot(lm[362].x - lm[263].x, lm[362].y - lm[263].y);
      const rightRatio = rightH / (rightW > 1e-4 ? rightW : 1);

      // Smooth blink envelope keeps partial eyelid closure visible without flicker.
      const calcBlink = (ratio: number) => {
        return remapFaceFeature(0.21 - ratio, 0.0, 0.09, settings.eyeSens);
      };

      const userLeftBlink = lm.length >= 478 && solvedFace
        ? remapFaceFeature(1 - solvedFace.eye.l, 0.08, 0.72, settings.eyeSens)
        : calcBlink(leftRatio);
      const userRightBlink = lm.length >= 478 && solvedFace
        ? remapFaceFeature(1 - solvedFace.eye.r, 0.08, 0.72, settings.eyeSens)
        : calcBlink(rightRatio);

      const avatarBlinkL = settings.mirror ? userRightBlink : userLeftBlink;
      const avatarBlinkR = settings.mirror ? userLeftBlink : userRightBlink;

      if (isArkitModel) {
        setFaceExpression('eyeBlinkLeft', avatarBlinkL, frameStartTime);
        setFaceExpression('eyeBlinkRight', avatarBlinkR, frameStartTime);

        // Eye Wide
        const userLeftWide = remapFaceFeature(leftRatio, 0.22, 0.34, settings.eyeSens);
        const userRightWide = remapFaceFeature(rightRatio, 0.22, 0.34, settings.eyeSens);
        setFaceExpression('eyeWideLeft', settings.mirror ? userRightWide : userLeftWide, frameStartTime);
        setFaceExpression('eyeWideRight', settings.mirror ? userLeftWide : userRightWide, frameStartTime);

        // Eye Squint
        const userLeftSquint = remapFaceFeature(0.23 - leftRatio, 0.015, 0.10, settings.eyeSens) * (1 - userLeftBlink);
        const userRightSquint = remapFaceFeature(0.23 - rightRatio, 0.015, 0.10, settings.eyeSens) * (1 - userRightBlink);
        setFaceExpression('eyeSquintLeft', settings.mirror ? userRightSquint : userLeftSquint, frameStartTime);
        setFaceExpression('eyeSquintRight', settings.mirror ? userLeftSquint : userRightSquint, frameStartTime);

        // Iris / Gaze direction tracking (MediaPipe landmarks 468 & 473)
        if (lm.length >= 478) {
          const lCenterX = (lm[33].x + lm[133].x) / 2;
          const lCenterY = (lm[159].y + lm[145].y) / 2;
          const rCenterX = (lm[263].x + lm[362].x) / 2;
          const rCenterY = (lm[386].y + lm[374].y) / 2;

          // Normalize iris motion by eye width, not eyelid opening. Dividing by
          // lid height made gaze explode during blinks and disappear on wide eyes.
          const gazeLX = (lm[468].x - lCenterX) / (leftW > 1e-4 ? leftW : 1);
          const gazeLY = (lCenterY - lm[468].y) / (leftW > 1e-4 ? leftW : 1);
          const gazeRX = (lm[473].x - rCenterX) / (rightW > 1e-4 ? rightW : 1);
          const gazeRY = (rCenterY - lm[473].y) / (rightW > 1e-4 ? rightW : 1);

          const lookUpL = remapFaceFeature(gazeLY, 0.01, 0.075, settings.eyeSens);
          const lookDownL = remapFaceFeature(-gazeLY, 0.01, 0.075, settings.eyeSens);
          const lookInL = remapFaceFeature(gazeLX, 0.015, 0.105, settings.eyeSens);
          const lookOutL = remapFaceFeature(-gazeLX, 0.015, 0.105, settings.eyeSens);

          const lookUpR = remapFaceFeature(gazeRY, 0.01, 0.075, settings.eyeSens);
          const lookDownR = remapFaceFeature(-gazeRY, 0.01, 0.075, settings.eyeSens);
          const lookInR = remapFaceFeature(-gazeRX, 0.015, 0.105, settings.eyeSens);
          const lookOutR = remapFaceFeature(gazeRX, 0.015, 0.105, settings.eyeSens);

          setFaceExpression('eyeLookUpLeft', settings.mirror ? lookUpR : lookUpL, frameStartTime);
          setFaceExpression('eyeLookDownLeft', settings.mirror ? lookDownR : lookDownL, frameStartTime);
          setFaceExpression('eyeLookInLeft', settings.mirror ? lookInR : lookInL, frameStartTime);
          setFaceExpression('eyeLookOutLeft', settings.mirror ? lookOutR : lookOutL, frameStartTime);

          setFaceExpression('eyeLookUpRight', settings.mirror ? lookUpL : lookUpR, frameStartTime);
          setFaceExpression('eyeLookDownRight', settings.mirror ? lookDownL : lookDownR, frameStartTime);
          setFaceExpression('eyeLookInRight', settings.mirror ? lookInL : lookInR, frameStartTime);
          setFaceExpression('eyeLookOutRight', settings.mirror ? lookOutL : lookOutR, frameStartTime);
        }

        // Eyebrows
        const glabellaY = lm[168].y;
        const innerBrowDist = (glabellaY - (lm[107].y + lm[336].y) / 2) / (faceH > 1e-4 ? faceH : 1);
        const browInnerUp = Math.max(
          remapFaceFeature(innerBrowDist, 0.025, 0.105, settings.eyeSens),
          (solvedFace?.brow ?? 0) * settings.eyeSens
        );
        setFaceExpression('browInnerUp', browInnerUp, frameStartTime);

        const browDownRawL = (lm[107].y - glabellaY) / (faceH > 1e-4 ? faceH : 1);
        const browDownRawR = (lm[336].y - glabellaY) / (faceH > 1e-4 ? faceH : 1);
        const browDownL = remapFaceFeature(browDownRawL, -0.035, 0.035, settings.eyeSens);
        const browDownR = remapFaceFeature(browDownRawR, -0.035, 0.035, settings.eyeSens);
        setFaceExpression('browDownLeft', settings.mirror ? browDownR : browDownL, frameStartTime);
        setFaceExpression('browDownRight', settings.mirror ? browDownL : browDownR, frameStartTime);

        const outerDistL = (lm[33].y - lm[70].y) / (faceH > 1e-4 ? faceH : 1);
        const outerDistR = (lm[263].y - lm[300].y) / (faceH > 1e-4 ? faceH : 1);
        const browOuterL = remapFaceFeature(outerDistL, 0.065, 0.16, settings.eyeSens);
        const browOuterR = remapFaceFeature(outerDistR, 0.065, 0.16, settings.eyeSens);
        setFaceExpression('browOuterUpLeft', settings.mirror ? browOuterR : browOuterL, frameStartTime);
        setFaceExpression('browOuterUpRight', settings.mirror ? browOuterL : browOuterR, frameStartTime);
      } else {
        setFaceExpression('blinkLeft', avatarBlinkL, frameStartTime);
        setFaceExpression('blinkRight', avatarBlinkR, frameStartTime);
        if (Math.abs(avatarBlinkL - avatarBlinkR) < 0.25) {
          setFaceExpression('blink', Math.max(avatarBlinkL, avatarBlinkR), frameStartTime);
        } else {
          setFaceExpression('blink', 0, frameStartTime);
        }
      }

      // C. Mouth, Jaw & Cheeks: independent normalized signals for speech and expression
      const mouthH = Math.hypot(lm[13].x - lm[14].x, lm[13].y - lm[14].y);
      const mouthW = Math.hypot(lm[61].x - lm[291].x, lm[61].y - lm[291].y);
      const mouthOpenRatio = mouthH / (mouthW > 1e-4 ? mouthW : 1);

      const webcamMouthOpen = remapFaceFeature(mouthOpenRatio, 0.07, 0.34, settings.mouthSens);

      // Smile & Frown from mouth corners
      const lipMidY = (lm[13].y + lm[14].y) / 2;
      const cornerDeltaL = (lipMidY - lm[61].y) / (mouthW > 1e-4 ? mouthW : 1);
      const cornerDeltaR = (lipMidY - lm[291].y) / (mouthW > 1e-4 ? mouthW : 1);

      const smileL = remapFaceFeature(cornerDeltaL, 0.015, 0.12, settings.mouthSens);
      const smileR = remapFaceFeature(cornerDeltaR, 0.015, 0.12, settings.mouthSens);
      const frownL = remapFaceFeature(-cornerDeltaL, 0.015, 0.11, settings.mouthSens);
      const frownR = remapFaceFeature(-cornerDeltaR, 0.015, 0.11, settings.mouthSens);

      // Pucker & Funnel
      const mouthWidthNorm = mouthW / (faceW > 1e-4 ? faceW : 1);
      const puckerRatio = remapFaceFeature(0.37 - mouthWidthNorm, 0.015, 0.12, settings.mouthSens);
      const pucker = puckerRatio * (1 - webcamMouthOpen);
      const funnel = puckerRatio * THREE.MathUtils.clamp(webcamMouthOpen * 1.5, 0, 1);
      const vowelShapes = solvedFace?.mouth.shape;
      const mouthSens = settings.mouthSens;
      currentFaceMouthA = Math.max(webcamMouthOpen, THREE.MathUtils.clamp((vowelShapes?.A ?? 0) * mouthSens, 0, 1));
      currentFaceMouthE = THREE.MathUtils.clamp((vowelShapes?.E ?? 0) * mouthSens, 0, 1);
      currentFaceMouthI = THREE.MathUtils.clamp((vowelShapes?.I ?? 0) * mouthSens, 0, 1);
      currentFaceMouthO = THREE.MathUtils.clamp((vowelShapes?.O ?? 0) * mouthSens, 0, 1);
      currentFaceMouthU = THREE.MathUtils.clamp((vowelShapes?.U ?? 0) * mouthSens, 0, 1);

      // Cheeks & Nose
      const cheekDist = Math.hypot(lm[205].x - lm[425].x, lm[205].y - lm[425].y) / (faceW > 1e-4 ? faceW : 1);
      const cheekPuff = (webcamMouthOpen < 0.15 ? 1 : 0.25) * remapFaceFeature(cheekDist, 0.72, 0.84, settings.mouthSens);
      const cheekSquintL = THREE.MathUtils.clamp(smileL * 0.75, 0, 1);
      const cheekSquintR = THREE.MathUtils.clamp(smileR * 0.75, 0, 1);
      const noseSneer = THREE.MathUtils.clamp((smileL + smileR) * 0.25 + (frownL + frownR) * 0.25, 0, 1);

      // Jaw shift
      const chinShiftX = (lm[152].x - lm[1].x) / (faceW > 1e-4 ? faceW : 1);
      const jawL = remapFaceFeature(-chinShiftX, 0.015, 0.09, settings.mouthSens);
      const jawR = remapFaceFeature(chinShiftX, 0.015, 0.09, settings.mouthSens);

      currentWebcamMouthOpen = webcamMouthOpen;
      currentWebcamSmileL = smileL;
      currentWebcamSmileR = smileR;
      currentWebcamFrownL = frownL;
      currentWebcamFrownR = frownR;
      currentMouthPucker = Math.max(pucker, currentFaceMouthU);
      currentMouthFunnel = Math.max(funnel, currentFaceMouthO);
      currentCheekPuff = cheekPuff;
      currentCheekSquintL = cheekSquintL;
      currentCheekSquintR = cheekSquintR;
      currentNoseSneer = noseSneer;
      currentJawLeft = jawL;
      currentJawRight = jawR;

      applyMouthExpressions();
    }
  } else {
    releaseFaceTracking(frameStartTime);
  }

  // 3. FULL 3D TORSO TRACKING & VISIBILITY FILTERING
  const pl = results.poseLandmarks;
  // The bundled Holistic build minifies the `world_landmarks` output key to `za`.
  // Newer builds expose `poseWorldLandmarks`; older builds have also used `ea`.
  // Keep this lookup explicit so the arm rigs never silently receive null joints.
  const wl = results.poseWorldLandmarks ?? results.worldLandmarks ?? results.za ?? results.ea ?? null;

  if (pl && (pl[11] || pl[12])) {
    const s11 = getValidPoseLandmark(11, pl, wl);
    const s12 = getValidPoseLandmark(12, pl, wl);
    const sMidX = (s11.x + s12.x) / 2;
    const sMidY = (s11.y + s12.y) / 2;

    // Shoulder width in coronal plane: only accept when visibility of both shoulders > 0.6
    const vis11 = pl[11]?.visibility ?? 0;
    const vis12 = pl[12]?.visibility ?? 0;
    let userShoulderWidth: number | null = null;
    if (vis11 > 0.6 && vis12 > 0.6) {
      userShoulderWidth = Math.hypot(s12.x - s11.x, s12.y - s11.y, (s12.z - s11.z) * 0.4);
    }
    const armScale = computeArmScale(userShoulderWidth);

    if (settings.torso) {
      const tSens = settings.torsoSens;

      // Torso Roll
      const dX = Math.abs(s12.x - s11.x);
      const dY = s12.y - s11.y;
      const shoulderAngle = Math.atan2(dY, dX > 1e-4 ? dX : 1);
      const rawRoll = (settings.mirror ? shoulderAngle : -shoulderAngle) * tSens * 0.7;
      const torsoRoll = THREE.MathUtils.clamp(rawRoll, -0.35, 0.35);

      // Torso Yaw
      const dZ = s12.z - s11.z;
      const rawYaw = (settings.mirror ? -dZ : dZ) * tSens * 1.2;
      const torsoYaw = THREE.MathUtils.clamp(rawYaw, -0.35, 0.35);

      // Torso Pitch
      let torsoPitch = 0;
      if (pl[23] && pl[24] && (pl[23].visibility ?? 1) > 0.4 && (pl[24].visibility ?? 1) > 0.4) {
        const hMidZ = (pl[23].z + pl[24].z) / 2;
        const sMidZ = (s11.z + s12.z) / 2;
        torsoPitch = (hMidZ - sMidZ) * 0.8 * tSens;
      }
      torsoPitch = THREE.MathUtils.clamp(torsoPitch, -0.25, 0.25);

      // Distribute: 35% Spine, 65% Chest
      _scratchE1.set(torsoPitch * 0.35, torsoYaw * 0.35, torsoRoll * 0.35, 'YXZ');
      _scratchQ1.setFromEuler(_scratchE1);
      const spineBone = currentVrm.humanoid?.getNormalizedBoneNode('spine');
      if (spineBone) spineBone.quaternion.slerp(_scratchQ1, 0.2);

      _scratchE1.set(torsoPitch * 0.65, torsoYaw * 0.65, torsoRoll * 0.65, 'YXZ');
      _scratchQ2.setFromEuler(_scratchE1);
      const chestBone = currentVrm.humanoid?.getNormalizedBoneNode('chest');
      if (chestBone) chestBone.quaternion.slerp(_scratchQ2, 0.2);

      // Hips Horizontal Sway
      const rawSway = (settings.mirror ? -(sMidX - 0.5) : sMidX - 0.5) * 0.25 * tSens;
      const swayOffset = THREE.MathUtils.clamp(rawSway, -0.15, 0.15);
      const hipsBone = currentVrm.humanoid?.getNormalizedBoneNode('hips');
      if (hipsBone) {
        hipsBone.position.x = THREE.MathUtils.lerp(hipsBone.position.x, swayOffset, 0.1);
      }
    }

    // 4. POSITION-ANCHORED ARMS (3D World Landmarks + Full 3D Wrist Orientation)

    if (settings.hands) {
      const targetRightArm = settings.mirror ? 'left' : 'right';
      const targetLeftArm = settings.mirror ? 'right' : 'left';

      // HAND TRACKING WITH 250MS TEMPORAL HYSTERESIS:
      // Prevents arms from dropping or twitching if hands are briefly occluded while touching face
      const now = performance.now();
      const handAspect = videoElement.videoWidth > 0 && videoElement.videoHeight > 0
        ? videoElement.videoWidth / videoElement.videoHeight
        : 4 / 3;

      const rightRawDetected = Boolean(results.rightHandLandmarks && results.rightHandLandmarks.length === 21);
      if (rightRawDetected) {
        rightHandLastSeenTime = now;
        lastValidRightHandLM = results.rightHandLandmarks;
      }
      const isRightActive = rightRawDetected || (now - rightHandLastSeenTime < HAND_HYSTERESIS_MS);
      const activeRightHandLM = rightRawDetected ? results.rightHandLandmarks : lastValidRightHandLM;

      const leftRawDetected = Boolean(results.leftHandLandmarks && results.leftHandLandmarks.length === 21);
      if (leftRawDetected) {
        leftHandLastSeenTime = now;
        lastValidLeftHandLM = results.leftHandLandmarks;
      }
      const isLeftActive = leftRawDetected || (now - leftHandLastSeenTime < HAND_HYSTERESIS_MS);
      const activeLeftHandLM = leftRawDetected ? results.leftHandLandmarks : lastValidLeftHandLM;

      // Clavicle shrug (only active when the hand is visible)
      const userRightShrug = isRightActive ? (sMidY - s12.y) * 3.2 : 0;
      const userLeftShrug = isLeftActive ? (sMidY - s11.y) * 3.2 : 0;

      if (settings.rightHand) {
        const boneName = targetRightArm === 'left' ? 'leftShoulder' : 'rightShoulder';
        rigRotation(boneName, {
          x: 0,
          y: 0,
          z: targetRightArm === 'left'
            ? THREE.MathUtils.clamp(userRightShrug, -0.2, 0.45)
            : THREE.MathUtils.clamp(-userRightShrug, -0.45, 0.2),
        }, 1, 0.25);
      }
      if (settings.leftHand) {
        const boneName = targetLeftArm === 'left' ? 'leftShoulder' : 'rightShoulder';
        rigRotation(boneName, {
          x: 0,
          y: 0,
          z: targetLeftArm === 'left'
            ? THREE.MathUtils.clamp(userLeftShrug, -0.2, 0.45)
            : THREE.MathUtils.clamp(-userLeftShrug, -0.45, 0.2),
        }, 1, 0.25);
      }

      // Visibility-filtered joint coordinates
      const e13 = getValidPoseLandmark(13, pl, wl);
      const e14 = getValidPoseLandmark(14, pl, wl);
      const w15 = getValidPoseLandmark(15, pl, wl);
      const w16 = getValidPoseLandmark(16, pl, wl);

      if (!settings.legacyArmTracking) {
        // Map each physical user hand to one avatar rig in one place.

        const userRightShoulder = wl && wl[12] ? { x: wl[12].x, y: wl[12].y, z: wl[12].z, visibility: pl?.[12]?.visibility ?? 1 } : null;
        const userRightElbow    = wl && wl[14] ? { x: wl[14].x, y: wl[14].y, z: wl[14].z, visibility: pl?.[14]?.visibility ?? 1 } : null;
        const userRightWrist    = wl && wl[16] ? { x: wl[16].x, y: wl[16].y, z: wl[16].z, visibility: pl?.[16]?.visibility ?? 1 } : null;

        const userLeftShoulder  = wl && wl[11] ? { x: wl[11].x, y: wl[11].y, z: wl[11].z, visibility: pl?.[11]?.visibility ?? 1 } : null;
        const userLeftElbow     = wl && wl[13] ? { x: wl[13].x, y: wl[13].y, z: wl[13].z, visibility: pl?.[13]?.visibility ?? 1 } : null;
        const userLeftWrist     = wl && wl[15] ? { x: wl[15].x, y: wl[15].y, z: wl[15].z, visibility: pl?.[15]?.visibility ?? 1 } : null;

        const rightRig = targetRightArm === 'right' ? armRigRight : armRigLeft;
        const leftRig = targetLeftArm === 'left' ? armRigLeft : armRigRight;

        if (settings.rightHand) {
          rightRig.update(
            currentVrm,
            userRightShoulder, userRightElbow, userRightWrist,
            activeRightHandLM,
            pl ? [pl[20], pl[18]] : null,
            settings.mirror,
            now,
            settings.handSens,
            handAspect,
            armScale
          );
        } else {
          rightRig.applyIdlePose(currentVrm, 0.15);
        }

        if (settings.leftHand) {
          leftRig.update(
            currentVrm,
            userLeftShoulder, userLeftElbow, userLeftWrist,
            activeLeftHandLM,
            pl ? [pl[19], pl[17]] : null,
            settings.mirror,
            now,
            settings.handSens,
            handAspect,
            armScale
          );
        } else {
          leftRig.applyIdlePose(currentVrm, 0.15);
        }

        updateHandBadge(rightHandBadge, settings.rightHand && rightRig.state === 'ACTIVE');
        updateHandBadge(leftHandBadge, settings.leftHand && leftRig.state === 'ACTIVE');

        if (armDebugVisualizer) {
          armDebugVisualizer.update(armRigLeft, armRigRight);
        }
      } else {
        // LEGACY ARM TRACKING (Two-Bone Positional IK + Face-Touch Engine)
        if (settings.rightHand && isRightActive) {
          const filteredE14 = elbowFilters.right.filter(e14, now);
          const filteredW16 = wristFilters.right.filter(w16, now);
          solveArmVectorIKLegacy(currentVrm, targetRightArm, s12, filteredE14, filteredW16, activeRightHandLM, true, results.faceLandmarks, armScale, pl[12]?.visibility ?? 1.0, pl[14]?.visibility ?? 1.0, settings.reachMultiplier);
          updateHandBadge(rightHandBadge, true);
        } else {
          lastValidRightHandLM = null;
          elbowFilters.right.reset();
          wristFilters.right.reset();
          resetEntireArmToIdle(targetRightArm);
          updateHandBadge(rightHandBadge, false);
        }

        if (settings.leftHand && isLeftActive) {
          const filteredE13 = elbowFilters.left.filter(e13, now);
          const filteredW15 = wristFilters.left.filter(w15, now);
          solveArmVectorIKLegacy(currentVrm, targetLeftArm, s11, filteredE13, filteredW15, activeLeftHandLM, false, results.faceLandmarks, armScale, pl[11]?.visibility ?? 1.0, pl[13]?.visibility ?? 1.0, settings.reachMultiplier);
          updateHandBadge(leftHandBadge, true);
        } else {
          lastValidLeftHandLM = null;
          elbowFilters.left.reset();
          wristFilters.left.reset();
          resetEntireArmToIdle(targetLeftArm);
          updateHandBadge(leftHandBadge, false);
        }
      }
    }
  } else {
        resetEntireArmToIdle('left');
    resetEntireArmToIdle('right');
    updateHandBadge(leftHandBadge, false);
    updateHandBadge(rightHandBadge, false);
  }

  // Update Debug HUD if active (Stage 8)
  if (isDebugEnabled) {
    const frameTime = (performance.now() - frameStartTime).toFixed(1);
        const fpsEl = document.getElementById('dbg-fps');
    const shAvEl = document.getElementById('dbg-sh-avatar');
    const shUsEl = document.getElementById('dbg-sh-user');
    const lAvEl = document.getElementById('dbg-l-avatar');
    const lUsEl = document.getElementById('dbg-l-user');
    const ftEl = document.getElementById('dbg-ft-w');
    const shVisEl = document.getElementById('dbg-sh-vis');
    const elVisEl = document.getElementById('dbg-el-vis');

    const modeEl = document.getElementById('dbg-arm-mode');
    const stateLEl = document.getElementById('dbg-state-left');
    const stateREl = document.getElementById('dbg-state-right');
    const elbowAnglesEl = document.getElementById('dbg-elbow-angles');
    const wristVisEl = document.getElementById('dbg-wrist-vis');

    if (modeEl) modeEl.textContent = settings.legacyArmTracking ? 'Legacy 2-Bone IK' : 'FK Modern (Direction-Based)';
    if (stateLEl) stateLEl.textContent = armRigLeft.state;
    if (stateREl) stateREl.textContent = armRigRight.state;
    if (elbowAnglesEl) elbowAnglesEl.textContent = Math.round(armRigLeft.debugInfo.elbowAngleDeg) + '° / ' + Math.round(armRigRight.debugInfo.elbowAngleDeg) + '°';
    const wristAnglesEl = document.getElementById('dbg-wrist-angles');
    if (wristAnglesEl) wristAnglesEl.textContent = Math.round(armRigLeft.debugInfo.wristAngleDeg) + '° / ' + Math.round(armRigRight.debugInfo.wristAngleDeg) + '°';
    const wristFlexEl = document.getElementById('dbg-wrist-flex');
    if (wristFlexEl) wristFlexEl.textContent = armRigLeft.debugInfo.wristFlexIndicator + ' / ' + armRigRight.debugInfo.wristFlexIndicator;
    if (wristVisEl && pl) wristVisEl.textContent = ((pl[15]?.visibility ?? 0)).toFixed(2) + ' / ' + ((pl[16]?.visibility ?? 0)).toFixed(2);

        if (fpsEl) fpsEl.textContent = (fpsVal ? fpsVal.textContent : "60") + " FPS (" + frameTime + "ms)";
    if (shAvEl) shAvEl.textContent = (getAvatarShoulderWidth() * 100).toFixed(0) + " cm";
    if (shUsEl) shUsEl.textContent = (lastGoodUserShoulderWidth * 100).toFixed(0) + " cm";
    if (lAvEl) lAvEl.textContent = (avatarArmLengths.left.total * 100).toFixed(0) + "cm / " + (avatarArmLengths.right.total * 100).toFixed(0) + "cm";

    // User Arm lengths from Pose
    if (pl && pl[11] && pl[13] && pl[15] && pl[12] && pl[14] && pl[16]) {
      const lUserLeft = (Math.hypot(pl[11].x - pl[13].x, pl[11].y - pl[13].y) + Math.hypot(pl[13].x - pl[15].x, pl[13].y - pl[15].y)) * 100;
      const lUserRight = (Math.hypot(pl[12].x - pl[14].x, pl[12].y - pl[14].y) + Math.hypot(pl[14].x - pl[16].x, pl[14].y - pl[16].y)) * 100;
      if (lUsEl) lUsEl.textContent = lUserLeft.toFixed(0) + "cm / " + lUserRight.toFixed(0) + "cm";
    }

    if (ftEl) ftEl.textContent = faceTouchState.left.weight.toFixed(2) + " / " + faceTouchState.right.weight.toFixed(2);
    if (shVisEl && pl) shVisEl.textContent = ((pl[11]?.visibility ?? 0)).toFixed(2) + " / " + ((pl[12]?.visibility ?? 0)).toFixed(2);
    if (elVisEl && pl) elVisEl.textContent = ((pl[13]?.visibility ?? 0)).toFixed(2) + " / " + ((pl[14]?.visibility ?? 0)).toFixed(2);
  }
}
/* ==========================================================================
   INITIALIZATION & AUDIO LIP-SYNC
   ========================================================================== */
async function initTracking() {
  if (!window.Holistic || !window.Camera) {
    camStatusText.textContent = 'Ошибка скриптов MediaPipe';
    setWorkflowStep('workflow-camera', 'error', 'Не удалось загрузить');
    setWorkflowStep('workflow-tracking', 'error', 'Трекинг недоступен');
    alert('MediaPipe скрипты не были загружены. Проверьте подключение.');
    return;
  }

  camStatusText.textContent = 'Инициализация AI...';
  setWorkflowStep('workflow-camera', 'active', 'Подключается');
  setWorkflowStep('workflow-tracking', 'active', 'Запускается');
  pipFaceStatus.textContent = 'Ожидание первого кадра';
  pipFaceStatus.classList.remove('tracked', 'missing');

  holisticInstance = new window.Holistic({
    locateFile: (file: string) => `/mediapipe/${file}`,
  });

  holisticInstance.setOptions({
    modelComplexity: 0,
    smoothLandmarks: true,
    enableSegmentation: false,
    smoothSegmentation: false,
    refineFaceLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  holisticInstance.onResults(onHolisticResults);

  if (videoElement.srcObject instanceof MediaStream) {
    try {
      videoElement.srcObject.getTracks().forEach((t) => t.stop());
    } catch (_) {}
    videoElement.srcObject = null;
  }

  try {
    let isHolisticBusy = false;
    cameraInstance = new window.Camera(videoElement, {
      onFrame: async () => {
        if (isCameraRunning && holisticInstance && !isHolisticBusy) {
          isHolisticBusy = true;
          try {
            await holisticInstance.send({ image: videoElement });
          } catch (_) {} finally {
            isHolisticBusy = false;
          }
        }
      },
      width: 640,
      height: 480,
    });

    await cameraInstance.start();
    videoElement.muted = true;
    videoElement.playsInline = true;
    await videoElement.play();
    isCameraRunning = true;
    camStatusText.textContent = 'Камера: В эфире';
    setWorkflowStep('workflow-camera', 'complete', 'Подключена');
    setWorkflowStep('workflow-tracking', 'active', 'Ищу лицо');
    pipFaceStatus.textContent = 'Ищу лицо…';
    const btnText = document.getElementById('camera-btn-text')!;
    btnText.textContent = 'Остановить отслеживание';
    console.log("[VTuber Studio Pro] solveArmVectorIK & OneEuroFilter loaded successfully");
console.log('Camera and Holistic tracking started successfully.');
  } catch (err: any) {
    console.error('Camera start error:', err);
    camStatusText.textContent = 'Ошибка доступа к камере';
    setWorkflowStep('workflow-camera', 'error', 'Нет доступа');
    setWorkflowStep('workflow-tracking', 'error', 'Трекинг остановлен');
    pipFaceStatus.textContent = 'Ошибка камеры';
    pipFaceStatus.classList.remove('tracked');
    pipFaceStatus.classList.add('missing');
    alert('Не удалось получить доступ к веб-камере. Проверьте разрешения.');
  }
}


let currentWebcamMouthOpen = 0;
let currentFaceMouthA = 0;
let currentFaceMouthE = 0;
let currentFaceMouthI = 0;
let currentFaceMouthO = 0;
let currentFaceMouthU = 0;
let currentWebcamSmileL = 0;
let currentWebcamSmileR = 0;
let currentWebcamFrownL = 0;
let currentWebcamFrownR = 0;
let currentMouthPucker = 0;
let currentMouthFunnel = 0;
let currentCheekPuff = 0;
let currentCheekSquintL = 0;
let currentCheekSquintR = 0;
let currentNoseSneer = 0;
let currentJawLeft = 0;
let currentJawRight = 0;
let currentAudioMouthOpen = 0;
let audioTimeData: Uint8Array | null = null;
let micStream: MediaStream | null = null;

function applyMouthExpressions() {
  if (!currentVrm || !currentVrm.expressionManager) return;

  const mouthFromWebcam = settings.mouth ? Math.max(currentWebcamMouthOpen, currentFaceMouthA) : 0;
  const mouthFromAudio = settings.micLipSync ? currentAudioMouthOpen : 0;
  const mouthFromEmotion = blendedEmotion.mouthOpen;

  const totalOpen = Math.max(mouthFromWebcam, mouthFromAudio, mouthFromEmotion);
  const clampedOpen = THREE.MathUtils.clamp(totalOpen, 0, 1);

  if (isArkitModel) {
    setFaceExpression('jawOpen', clampedOpen);

    const avatarSmileL = settings.mouth ? (settings.mirror ? currentWebcamSmileR : currentWebcamSmileL) : 0;
    const avatarSmileR = settings.mouth ? (settings.mirror ? currentWebcamSmileL : currentWebcamSmileR) : 0;
    const avatarFrownL = settings.mouth ? (settings.mirror ? currentWebcamFrownR : currentWebcamFrownL) : 0;
    const avatarFrownR = settings.mouth ? (settings.mirror ? currentWebcamFrownL : currentWebcamFrownR) : 0;

    if (blendedEmotion.happy > 0.05) {
      setFaceExpression('mouthSmileLeft', Math.max(avatarSmileL, blendedEmotion.happy));
      setFaceExpression('mouthSmileRight', Math.max(avatarSmileR, blendedEmotion.happy));
    } else {
      setFaceExpression('mouthSmileLeft', avatarSmileL);
      setFaceExpression('mouthSmileRight', avatarSmileR);
    }

    if (blendedEmotion.sad > 0.05) {
      setFaceExpression('mouthFrownLeft', Math.max(avatarFrownL, blendedEmotion.sad));
      setFaceExpression('mouthFrownRight', Math.max(avatarFrownR, blendedEmotion.sad));
    } else {
      setFaceExpression('mouthFrownLeft', avatarFrownL);
      setFaceExpression('mouthFrownRight', avatarFrownR);
    }

    setFaceExpression('mouthPucker', settings.mouth ? Math.max(currentMouthPucker, currentFaceMouthU) : 0);
    setFaceExpression('mouthFunnel', settings.mouth ? Math.max(currentMouthFunnel, currentFaceMouthO) : 0);
    setFaceExpression('mouthStretchLeft', settings.mouth ? currentFaceMouthI : 0);
    setFaceExpression('mouthStretchRight', settings.mouth ? currentFaceMouthI : 0);
    setFaceExpression('mouthDimpleLeft', avatarSmileL);
    setFaceExpression('mouthDimpleRight', avatarSmileR);
    setFaceExpression('cheekPuff', settings.mouth ? currentCheekPuff : 0);
    setFaceExpression('cheekSquintLeft', settings.mouth ? (settings.mirror ? currentCheekSquintR : currentCheekSquintL) : 0);
    setFaceExpression('cheekSquintRight', settings.mouth ? (settings.mirror ? currentCheekSquintL : currentCheekSquintR) : 0);
    setFaceExpression('noseSneerLeft', settings.mouth ? currentNoseSneer : 0);
    setFaceExpression('noseSneerRight', settings.mouth ? currentNoseSneer : 0);
    setFaceExpression('jawLeft', settings.mouth ? (settings.mirror ? currentJawRight : currentJawLeft) : 0);
    setFaceExpression('jawRight', settings.mouth ? (settings.mirror ? currentJawLeft : currentJawRight) : 0);
  } else {
    setFaceExpression('aa', Math.max(clampedOpen, settings.mouth ? currentFaceMouthA : 0));
    setFaceExpression('oh', Math.max(clampedOpen * 0.35, settings.mouth ? currentFaceMouthO : 0));
    setFaceExpression('ih', Math.max(mouthFromAudio * 0.2, settings.mouth ? currentFaceMouthI : 0));
    setFaceExpression('ou', Math.max(clampedOpen * 0.15, settings.mouth ? currentFaceMouthU : 0));
    setFaceExpression('ee', settings.mouth ? currentFaceMouthE : 0);

    const avgSmile = (currentWebcamSmileL + currentWebcamSmileR) / 2;
    if (blendedEmotion.happy > 0.05) {
      setFaceExpression('happy', Math.max(blendedEmotion.happy, avgSmile));
    } else if (settings.mouth) {
      setFaceExpression('happy', avgSmile);
    }
  }
}

function releaseFaceTracking(timestamp: number) {
  for (const name of faceExpressionFilters.keys()) {
    const heldByEmotion =
      (blendedEmotion.surprised > 0.05 && ['browInnerUp', 'eyeWideLeft', 'eyeWideRight'].includes(name)) ||
      (blendedEmotion.angry > 0.05 && ['browDownLeft', 'browDownRight', 'noseSneerLeft', 'noseSneerRight'].includes(name)) ||
      (blendedEmotion.happy > 0.05 && ['mouthSmileLeft', 'mouthSmileRight', 'happy'].includes(name)) ||
      (blendedEmotion.sad > 0.05 && ['mouthFrownLeft', 'mouthFrownRight'].includes(name));
    if (!heldByEmotion) setFaceExpression(name, 0, timestamp);
  }

  currentWebcamMouthOpen = 0;
  currentFaceMouthA = 0;
  currentFaceMouthE = 0;
  currentFaceMouthI = 0;
  currentFaceMouthO = 0;
  currentFaceMouthU = 0;
  currentWebcamSmileL = 0;
  currentWebcamSmileR = 0;
  currentWebcamFrownL = 0;
  currentWebcamFrownR = 0;
  currentMouthPucker = 0;
  currentMouthFunnel = 0;
  currentCheekPuff = 0;
  currentCheekSquintL = 0;
  currentCheekSquintR = 0;
  currentNoseSneer = 0;
  currentJawLeft = 0;
  currentJawRight = 0;
  applyMouthExpressions();
}

let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;

async function setupAudioLipSync() {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    const source = audioCtx.createMediaStreamSource(micStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.3;
    source.connect(analyser);
    audioTimeData = new Uint8Array(analyser.fftSize);
    console.log("[VTuber Studio Pro] solveArmVectorIK & OneEuroFilter loaded successfully");
console.log('Microphone lip-sync initialized. AudioContext state:', audioCtx.state);
  } catch (err) {
    console.warn('Microphone access denied or unavailable:', err);
    const toggle = document.getElementById('toggle-mic') as HTMLInputElement;
    if (toggle) toggle.checked = false;
    settings.micLipSync = false;
    alert('Не удалось получить доступ к микрофону. Проверьте разрешения в браузере.');
  }
}

function updateAudioLipSync() {
  if (!settings.micLipSync || !analyser || !audioTimeData) {
    currentAudioMouthOpen = 0;
    return;
  }

  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  analyser.getByteTimeDomainData(audioTimeData as any);

  let sumSquares = 0;
  for (let i = 0; i < audioTimeData.length; i++) {
    const norm = (audioTimeData[i] - 128) / 128;
    sumSquares += norm * norm;
  }
  const rms = Math.sqrt(sumSquares / audioTimeData.length);

  const noiseFloor = 0.015;
  let targetMouth = 0;
  if (rms > noiseFloor) {
    targetMouth = THREE.MathUtils.clamp(((rms - noiseFloor) / 0.14) * settings.mouthSens, 0, 1);
  }

  const lerpRate = targetMouth > currentAudioMouthOpen ? 0.5 : 0.22;
  currentAudioMouthOpen = THREE.MathUtils.lerp(currentAudioMouthOpen, targetMouth, lerpRate);

  if (currentAudioMouthOpen < 0.01) {
    currentAudioMouthOpen = 0;
  }
}

/* ==========================================================================
   UI EVENT HANDLERS
   ========================================================================== */
const cameraBtn = document.getElementById('btn-start-camera')!;
cameraBtn.addEventListener('click', () => {
  if (!isCameraRunning) {
    initTracking();
  } else {
    isCameraRunning = false;
    if (cameraInstance) {
      try { cameraInstance.stop(); } catch (_) {}
    }
    if (videoElement.srcObject instanceof MediaStream) {
    try {
      videoElement.srcObject.getTracks().forEach((t) => t.stop());
    } catch (_) {}
    videoElement.srcObject = null;
  }
    camStatusText.textContent = 'Камера: Остановлена';
    setWorkflowStep('workflow-camera', 'pending', 'Остановлена');
    setWorkflowStep('workflow-tracking', 'pending', 'Ожидает камеру');
    pipCtx.clearRect(0, 0, pipOverlay.width, pipOverlay.height);
    pipFaceStatus.textContent = 'Камера остановлена';
    pipFaceStatus.classList.remove('tracked');
    pipFaceStatus.classList.add('missing');
    document.getElementById('camera-btn-text')!.textContent = 'Запустить отслеживание';
    updateHandBadge(leftHandBadge, false);
    updateHandBadge(rightHandBadge, false);
    resetEntireArmToIdle('left');
    resetEntireArmToIdle('right');
  }
});

// Tracking Toggles
document.getElementById('toggle-head')?.addEventListener('change', (e) => {
  settings.head = (e.target as HTMLInputElement).checked;
});

document.getElementById('toggle-mouth')?.addEventListener('change', (e) => {
  settings.mouth = (e.target as HTMLInputElement).checked;
  if (!settings.mouth) {
    clearFaceExpressionFilters();
    for (const expression of [
      'eyeBlinkLeft', 'eyeBlinkRight', 'blink', 'blinkLeft', 'blinkRight',
      'eyeWideLeft', 'eyeWideRight', 'eyeSquintLeft', 'eyeSquintRight',
      'eyeLookUpLeft', 'eyeLookDownLeft', 'eyeLookInLeft', 'eyeLookOutLeft',
      'eyeLookUpRight', 'eyeLookDownRight', 'eyeLookInRight', 'eyeLookOutRight',
      'browInnerUp', 'browDownLeft', 'browDownRight', 'browOuterUpLeft', 'browOuterUpRight',
    ]) setExpression(expression, 0);
  }
  applyMouthExpressions();
});

document.getElementById('toggle-torso')?.addEventListener('change', (e) => {
  settings.torso = (e.target as HTMLInputElement).checked;
  if (!settings.torso && currentVrm?.humanoid) {
    const spine = currentVrm.humanoid.getNormalizedBoneNode('spine');
    const chest = currentVrm.humanoid.getNormalizedBoneNode('chest');
    const hips = currentVrm.humanoid.getNormalizedBoneNode('hips');
    if (spine) spine.quaternion.identity();
    if (chest) chest.quaternion.identity();
    if (hips) hips.position.x = 0;
  }
});

document.getElementById('input-torso-sens')?.addEventListener('input', (e) => {
  const val = Number((e.target as HTMLInputElement).value);
  settings.torsoSens = val / 10;
  const label = document.getElementById('val-torso-sens');
  if (label) label.textContent = `${(val / 10).toFixed(1)}x`;
});


// Emotion Palette Grid Buttons
document.querySelectorAll('.emotion-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.emotion-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');

    const emotionId = (btn as HTMLElement).dataset.emotion as EmotionPresetId;
    if (emotionId) {
      selectedEmotionMode = emotionId;
      // active manual emotion preset updated
    }
  });
});

document.getElementById('toggle-hands')?.addEventListener('change', (e) => {
  settings.hands = (e.target as HTMLInputElement).checked;
  const subOptions = document.getElementById('hands-suboptions')!;
  subOptions.style.opacity = settings.hands ? '1' : '0.4';
  if (!settings.hands) {
    updateHandBadge(leftHandBadge, false);
    updateHandBadge(rightHandBadge, false);
    resetEntireArmToIdle('left');
    resetEntireArmToIdle('right');
  }
});

document.getElementById('toggle-collision')?.addEventListener('change', (e) => {
  settings.armCollision = (e.target as HTMLInputElement).checked;
});

document.getElementById('toggle-left-hand')?.addEventListener('change', (e) => {
  settings.leftHand = (e.target as HTMLInputElement).checked;
  if (!settings.leftHand) {
    updateHandBadge(leftHandBadge, false);
    resetEntireArmToIdle('left');
  }
});

document.getElementById('toggle-right-hand')?.addEventListener('change', (e) => {
  settings.rightHand = (e.target as HTMLInputElement).checked;
  if (!settings.rightHand) {
    updateHandBadge(rightHandBadge, false);
    resetEntireArmToIdle('right');
  }
});

document.getElementById('toggle-mic')?.addEventListener('change', async (e) => {
  settings.micLipSync = (e.target as HTMLInputElement).checked;
  if (settings.micLipSync) {
    if (!audioCtx || !analyser) {
      await setupAudioLipSync();
    } else if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }
  } else {
    currentAudioMouthOpen = 0;
    applyMouthExpressions();
  }
});

// Fine-Tuning Sliders
document.getElementById('input-smoothing')?.addEventListener('input', (e) => {
  const val = Number((e.target as HTMLInputElement).value);
  settings.smoothing = val / 100;
  document.getElementById('val-smoothing')!.textContent = `${val}%`;
});

document.getElementById('input-head-sens')?.addEventListener('input', (e) => {
  const val = Number((e.target as HTMLInputElement).value);
  settings.headSens = val / 10;
  document.getElementById('val-head-sens')!.textContent = `${(val / 10).toFixed(1)}x`;
});

document.getElementById('input-hand-sens')?.addEventListener('input', (e) => {
  const val = Number((e.target as HTMLInputElement).value);
  settings.handSens = val / 10;
  document.getElementById('val-hand-sens')!.textContent = `${(val / 10).toFixed(1)}x`;
});

const inputReachMult = document.getElementById('input-reach-mult') as HTMLInputElement | null;
const valReachMult = document.getElementById('val-reach-mult');
if (inputReachMult && valReachMult) {
  inputReachMult.value = Math.round(settings.reachMultiplier * 100).toString();
  valReachMult.textContent = settings.reachMultiplier.toFixed(2) + "x";
  inputReachMult.addEventListener('input', (e) => {
    const val = Number((e.target as HTMLInputElement).value) / 100;
    settings.reachMultiplier = val;
    valReachMult.textContent = val.toFixed(2) + "x";
    try {
      localStorage.setItem('vtuber_reach_multiplier', val.toString());
    } catch (_) {}
  });
}

document.getElementById('input-mouth-sens')?.addEventListener('input', (e) => {
  const val = Number((e.target as HTMLInputElement).value);
  settings.mouthSens = val / 10;
  document.getElementById('val-mouth-sens')!.textContent = `${(val / 10).toFixed(1)}x`;
});

document.getElementById('input-eye-sens')?.addEventListener('input', (e) => {
  const val = Number((e.target as HTMLInputElement).value);
  settings.eyeSens = val / 10;
  const label = document.getElementById('val-eye-sens');
  if (label) label.textContent = `${(val / 10).toFixed(1)}x`;
});

// Background Color Presets
document.querySelectorAll('.bg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.bg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const color = (btn as HTMLElement).dataset.bg;
    if (color === 'transparent') {
      scene.background = null;
      document.body.style.backgroundColor = 'transparent';
    } else if (color) {
      scene.background = new THREE.Color(color);
      document.body.style.backgroundColor = color;
    }
  });
});


document.getElementById('btn-toggle-debug')?.addEventListener('click', () => {
  toggleDebugMode();
});


/* ==========================================================================
   OBS BROWSER SOURCE & TRANSPARENT MODE (STAGE 10)
   ========================================================================== */
export function setOBSTransparentMode(enabled: boolean) {
  if (enabled) {
    scene.background = null;
    renderer.setClearColor(0x000000, 0);
    // Hide UI
    const tb = document.getElementById('top-bar'); if (tb && !tb.classList.contains('hidden')) toggleUIVisibility();
    showEmotionToast('🎥', 'OBS Режим', 'Прозрачный фон включен. Нажмите H для показа UI');
  } else {
    scene.background = new THREE.Color(settings.bgColor);
    renderer.setClearColor(new THREE.Color(settings.bgColor), 1);
  }
}

const toggleObs = document.getElementById('toggle-obs-mode') as HTMLInputElement | null;
if (toggleObs) {
  toggleObs.addEventListener('change', (e) => {
    setOBSTransparentMode((e.target as HTMLInputElement).checked);
  });
}

// Auto-enable OBS mode if URL contains ?obs=true or #obs
if (window.location.search.includes('obs=true') || window.location.hash.includes('obs')) {
  window.addEventListener('DOMContentLoaded', () => {
    if (toggleObs) toggleObs.checked = true;
    setOBSTransparentMode(true);
  });
}

// Recalibrate / Reset Center
const recalibrateBtn = document.getElementById('btn-recalibrate')!;
recalibrateBtn.addEventListener('click', () => {
  controls.target.set(0.0, 1.3, 0.0);
  camera.position.set(0.0, 1.4, 1.35);
  controls.update();
  applyRestingPose();

  // Reset spine, chest and hips
  if (currentVrm?.humanoid) {
    const spine = currentVrm.humanoid.getNormalizedBoneNode('spine');
    const chest = currentVrm.humanoid.getNormalizedBoneNode('chest');
    const hips = currentVrm.humanoid.getNormalizedBoneNode('hips');
    if (spine) spine.quaternion.identity();
    if (chest) chest.quaternion.identity();
    if (hips) {
      hips.quaternion.identity();
      hips.position.set(0, 0, 0);
    }
  }
});

// Hide/Show UI for OBS Capture
const topBar = document.getElementById('top-bar')!;
const controlsPanel = document.getElementById('controls-panel')!;
const pipContainer = document.getElementById('pip-container')!;
const restoreBtn = document.getElementById('btn-restore-ui')!;
const hideUiBtn = document.getElementById('btn-hide-ui')!;

function toggleUIVisibility() {
  const isHidden = topBar.classList.toggle('hidden');
  controlsPanel.classList.toggle('hidden', isHidden);
  pipContainer.classList.toggle('hidden', isHidden);
  restoreBtn.classList.toggle('hidden', !isHidden);
}

hideUiBtn.addEventListener('click', toggleUIVisibility);
restoreBtn.addEventListener('click', toggleUIVisibility);

// Keyboard shortcuts
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyD') {
    toggleDebugMode();
  } else if (e.code === 'KeyH') {
    toggleUIVisibility();
  } else if (e.code === 'Space') {
    e.preventDefault();
    recalibrateBtn.click();
  }
});

// PIP Controls
document.getElementById('btn-toggle-mirror')?.addEventListener('click', () => {
  settings.mirror = !settings.mirror;
  videoElement.style.transform = settings.mirror ? 'scaleX(-1)' : 'scaleX(1)';
});

document.getElementById('btn-toggle-skeleton')?.addEventListener('click', (e) => {
  settings.showSkeleton = !settings.showSkeleton;
  (e.currentTarget as HTMLElement).classList.toggle('active', settings.showSkeleton);
  if (!settings.showSkeleton) {
    pipCtx.clearRect(0, 0, pipOverlay.width, pipOverlay.height);
  }
});

document.getElementById('btn-minimize-pip')?.addEventListener('click', () => {
  const body = document.querySelector('.pip-body') as HTMLElement;
  body.style.display = body.style.display === 'none' ? 'block' : 'none';
});

// Drag & Drop VRM Model Loading
const dropZone = document.getElementById('drop-zone')!;
const fileInput = document.getElementById('vrm-file-input') as HTMLInputElement;

dropZone.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) {
    const url = URL.createObjectURL(file);
    updateActiveModelButton('custom'); loadVRM(url, file.name);
  }
});

window.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});

window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
});

window.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer?.files?.[0];
  if (file && file.name.toLowerCase().endsWith('.vrm')) {
    const url = URL.createObjectURL(file);
    updateActiveModelButton('custom'); loadVRM(url, file.name);
  }
});

// Window Resize
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* ==========================================================================
   RENDER & ANIMATION LOOP
   ========================================================================== */
const clock = new THREE.Clock();
let frameCount = 0;
let lastFpsTime = performance.now();
const fpsVal = document.getElementById('fps-val')!;

function animate() {
  requestAnimationFrame(animate);

  const delta = clock.getDelta();

  // Update audio lip sync first
  updateAudioLipSync();
  // Apply combined mouth expressions (Audio + Webcam + Emotion)
  applyMouthExpressions();

  if (currentVrm) {
    currentVrm.update(delta);
  }

  controls.update();
  renderer.render(scene, camera);

  // FPS Counter
  frameCount++;
  const now = performance.now();
  if (now - lastFpsTime >= 500) {
    const currentFps = Math.round((frameCount * 1000) / (now - lastFpsTime));
    fpsVal.textContent = currentFps.toString();
    frameCount = 0;
    lastFpsTime = now;
  }
}

animate();
