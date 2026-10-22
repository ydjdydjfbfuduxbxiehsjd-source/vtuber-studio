import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils, VRM, type VRMHumanBoneName } from '@pixiv/three-vrm';

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
  gestureEmotes: boolean;
  armCollision: boolean;
  torso: boolean;
  torsoSens: number;
  mirror: boolean;
  showSkeleton: boolean;
  bgColor: string;
}

const settings: TrackingSettings = {
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
  gestureEmotes: true,
  armCollision: true,
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
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
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

function loadVRM(url: string, name = 'Sample Model') {
  modelStatusText.textContent = `Модель: Загрузка (${name})...`;

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
      applyRestingPose();

      modelStatusText.textContent = `Модель: ${name}`;
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
    }
  );
}

// Load default sample avatar
loadVRM('/models/sample.vrm', 'Стандартный Аватар');

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

  const targetEuler = new THREE.Euler(
    rotation.x * dampener,
    rotation.y * dampener,
    rotation.z * dampener,
    'XYZ'
  );
  const targetQuat = new THREE.Quaternion().setFromEuler(targetEuler);
  const rate = lerpRate !== undefined ? lerpRate : 1 - settings.smoothing;
  boneNode.quaternion.slerp(targetQuat, THREE.MathUtils.clamp(rate, 0.05, 0.8));
}

function setExpression(name: string, value: number) {
  if (!currentVrm || !currentVrm.expressionManager) return;
  currentVrm.expressionManager.setValue(name, THREE.MathUtils.clamp(value, 0, 1));
}
/* ==========================================================================
   ENHANCED PRESET EMOTIONS SYSTEM
   ========================================================================== */
export type RecognizedGesture = 'NONE' | 'ROCK' | 'PEACE' | 'THUMBS_UP' | 'FIST' | 'OPEN_PALM';

export type EmotionPresetId =
  | 'AUTO'
  | 'NEUTRAL'
  | 'HAPPY'
  | 'THUMBS_UP'
  | 'PEACE'
  | 'ROCK'
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
  guideId: string;
  values: EmotionValues;
}

const EMOTION_PRESETS: Record<EmotionPresetId, EmotionPresetDef> = {
  AUTO: {
    id: 'AUTO',
    name: 'Авто (По жестам)',
    icon: '✨',
    desc: 'Распознавание жестов рук и адаптивная мимика',
    guideId: '',
    values: { happy: 0, relaxed: 0, surprised: 0, angry: 0, sad: 0, mouthSmile: 0, mouthOpen: 0 },
  },
  NEUTRAL: {
    id: 'NEUTRAL',
    name: 'Нейтрально',
    icon: '😐',
    desc: 'Чистое естественное отслеживание с веб-камеры',
    guideId: '',
    values: { happy: 0, relaxed: 0, surprised: 0, angry: 0, sad: 0, mouthSmile: 0, mouthOpen: 0 },
  },
  THUMBS_UP: {
    id: 'THUMBS_UP',
    name: 'Одобрение / Респект',
    icon: '👍',
    desc: 'Уверенная дружеская улыбка, открытые глаза',
    guideId: 'guide-thumbs',
    values: { happy: 0.85, relaxed: 0.35, surprised: 0, angry: 0, sad: 0, mouthSmile: 0.6, mouthOpen: 0.05 },
  },
  PEACE: {
    id: 'PEACE',
    name: 'Победа / Peace',
    icon: '✌️',
    desc: 'Милая аниме-улыбка, сияющие глаза',
    guideId: 'guide-peace',
    values: { happy: 0.95, relaxed: 0.45, surprised: 0, angry: 0, sad: 0, mouthSmile: 0.65, mouthOpen: 0.08 },
  },
  ROCK: {
    id: 'ROCK',
    name: 'Рок / Драйв',
    icon: '🤘',
    desc: 'Энергичный рок-н-ролл взгляд (глаза полностью открыты)',
    guideId: 'guide-rock',
    values: { happy: 0.75, relaxed: 0, surprised: 0.2, angry: 0, sad: 0, mouthSmile: 0.5, mouthOpen: 0.12 },
  },
  OPEN_PALM: {
    id: 'OPEN_PALM',
    name: 'Приветствие',
    icon: '🖐️',
    desc: 'Тёплое открытое приветствие',
    guideId: 'guide-palm',
    values: { happy: 0.75, relaxed: 0.3, surprised: 0, angry: 0, sad: 0, mouthSmile: 0.5, mouthOpen: 0.04 },
  },
  HAPPY: {
    id: 'HAPPY',
    name: 'Радость',
    icon: '😊',
    desc: 'Яркая открытая радостная улыбка',
    guideId: '',
    values: { happy: 0.9, relaxed: 0.4, surprised: 0, angry: 0, sad: 0, mouthSmile: 0.7, mouthOpen: 0.05 },
  },
  ANGRY: {
    id: 'ANGRY',
    name: 'Решимость / Бой',
    icon: '✊',
    desc: 'Сосредоточенный решительный боевой взгляд',
    guideId: 'guide-fist',
    values: { happy: 0, relaxed: 0, surprised: 0, angry: 0.55, sad: 0, mouthSmile: 0, mouthOpen: 0 },
  },
  SURPRISED: {
    id: 'SURPRISED',
    name: 'Удивление',
    icon: '😲',
    desc: 'Широко открытые глаза и приоткрытый рот',
    guideId: '',
    values: { happy: 0, relaxed: 0, surprised: 0.85, angry: 0, sad: 0, mouthSmile: 0, mouthOpen: 0.28 },
  },
  RELAXED: {
    id: 'RELAXED',
    name: 'Спокойствие',
    icon: '😌',
    desc: 'Мягкое гармоничное умиротворение',
    guideId: '',
    values: { happy: 0.4, relaxed: 0.8, surprised: 0, angry: 0, sad: 0, mouthSmile: 0.3, mouthOpen: 0 },
  },
};

// Current Emotion State Manager
let selectedEmotionMode: EmotionPresetId = 'AUTO';
let currentActiveGesture: RecognizedGesture = 'NONE';

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

// Toast HUD & UI feedback
const toastEl = document.getElementById('gesture-toast');
const toastIcon = document.getElementById('gesture-toast-icon');
const toastTitle = document.getElementById('gesture-toast-title');
const toastDesc = document.getElementById('gesture-toast-desc');

function showEmotionToast(icon: string, title: string, desc: string) {
  if (toastEl && toastIcon && toastTitle && toastDesc) {
    toastIcon.textContent = icon;
    toastTitle.textContent = title;
    toastDesc.textContent = desc;
    toastEl.classList.remove('hidden');
  }
}

function hideEmotionToast() {
  if (toastEl) toastEl.classList.add('hidden');
}

function updateEmotionUI(activeId: EmotionPresetId, gesture: RecognizedGesture) {
  // Update guide highlights
  document.querySelectorAll('.gesture-item').forEach((item) => item.classList.remove('active'));

  if (activeId !== 'NEUTRAL' && activeId !== 'AUTO') {
    const preset = EMOTION_PRESETS[activeId];
    if (preset) {
      showEmotionToast(preset.icon, preset.name, preset.desc);
      if (preset.guideId) {
        const guideEl = document.getElementById(preset.guideId);
        if (guideEl) guideEl.classList.add('active');
      }
    }
  } else if (activeId === 'AUTO' && gesture !== 'NONE') {
    const gestureKey = gesture as EmotionPresetId;
    const preset = EMOTION_PRESETS[gestureKey];
    if (preset) {
      showEmotionToast(preset.icon, preset.name, preset.desc);
      if (preset.guideId) {
        const guideEl = document.getElementById(preset.guideId);
        if (guideEl) guideEl.classList.add('active');
      }
    }
  } else {
    hideEmotionToast();
  }
}
/* ==========================================================================
   AI HAND GESTURE RECOGNITION & FINGER POSING
   ========================================================================== */
function detectHandGesture(lm: any[] | null | undefined): RecognizedGesture {
  if (!lm || lm.length < 21) return 'NONE';
  const p0 = lm[0];

  const isExtended = (tipIdx: number, pipIdx: number) => {
    const dTip = Math.hypot(lm[tipIdx].x - p0.x, lm[tipIdx].y - p0.y, lm[tipIdx].z - p0.z);
    const dPip = Math.hypot(lm[pipIdx].x - p0.x, lm[pipIdx].y - p0.y, lm[pipIdx].z - p0.z);
    return dTip > dPip * 1.15;
  };

  const indexOpen = isExtended(8, 6);
  const middleOpen = isExtended(12, 10);
  const ringOpen = isExtended(16, 14);
  const pinkyOpen = isExtended(20, 18);

  // Thumb open check
  const dThumbIndex = Math.hypot(lm[4].x - lm[5].x, lm[4].y - lm[5].y, lm[4].z - lm[5].z);
  const dThumbPip = Math.hypot(lm[3].x - lm[5].x, lm[3].y - lm[5].y, lm[3].z - lm[5].z);
  const thumbOpen = dThumbIndex > dThumbPip * 1.05;

  // 1. ROCK / Коза
  if (indexOpen && pinkyOpen && !middleOpen && !ringOpen) return 'ROCK';

  // 2. PEACE / Знак V
  if (indexOpen && middleOpen && !ringOpen && !pinkyOpen) return 'PEACE';

  // 3. THUMBS UP Большой палец вверх
  if (thumbOpen && !indexOpen && !middleOpen && !ringOpen && !pinkyOpen) return 'THUMBS_UP';

  // 4. FIST Кулак
  if (!thumbOpen && !indexOpen && !middleOpen && !ringOpen && !pinkyOpen) return 'FIST';

  // 5. OPEN PALM Ладонь
  if (thumbOpen && indexOpen && middleOpen && ringOpen && pinkyOpen) return 'OPEN_PALM';

  return 'NONE';
}

/**
 * Robust 3D Vector Inverse Kinematics for Arms
 * Uses poseWorldLandmarks (true 3D in meters) for upper & lower arm.
 * Uses full 3D orthonormal basis from hand landmarks for 100% natural wrist twist (pronation/supination).
 */

/* ==========================================================================
   BODY COLLISION RESOLUTION (Torso, Chest, Head, Hips)
   Prevents hands, forearms, and elbows from passing through the body
   ========================================================================== */
function resolveBodyColliders(point: THREE.Vector3, minMargin = 0.035, isWristOrHand = false): THREE.Vector3 {
  if (!currentVrm || !currentVrm.humanoid) return point.clone();

  const out = point.clone();

  // 1. Head Sphere Collider
  // For wrists and hands: omit head sphere collision completely so the user's hand can touch their cheeks, chin, nose, and face!
  // For elbows: keep head sphere collision active so elbows don't clip through the skull.
  if (!isWristOrHand) {
    const headNode = currentVrm.humanoid.getNormalizedBoneNode('head');
    if (headNode) {
      const headPos = new THREE.Vector3();
      headNode.getWorldPosition(headPos);
      headPos.y += 0.02; // Center on skull
      const vHead = new THREE.Vector3().subVectors(out, headPos);
      const headRadius = 0.11 + minMargin;
      const distSq = vHead.lengthSq();
      if (distSq < headRadius * headRadius && distSq > 1e-6) {
        const dist = Math.sqrt(distSq);
        out.copy(headPos).addScaledVector(vHead.multiplyScalar(1 / dist), headRadius);
      }
    }
  }

  // 2. Torso Elliptical Capsule Collider (Chest down to Hips)
  const chestNode = currentVrm.humanoid.getNormalizedBoneNode('chest');
  const hipsNode = currentVrm.humanoid.getNormalizedBoneNode('hips');
  if (chestNode && hipsNode) {
    const chestPos = new THREE.Vector3();
    chestNode.getWorldPosition(chestPos);
    chestPos.y += 0.03;

    const hipsPos = new THREE.Vector3();
    hipsNode.getWorldPosition(hipsPos);
    hipsPos.y -= 0.03;

    const vAB = new THREE.Vector3().subVectors(hipsPos, chestPos);
    const lenSq = vAB.lengthSq();
    if (lenSq > 1e-4) {
      const t = THREE.MathUtils.clamp(
        new THREE.Vector3().subVectors(out, chestPos).dot(vAB) / lenSq,
        0,
        1
      );
      const center = new THREE.Vector3().copy(chestPos).addScaledVector(vAB, t);

      // Anatomical width (rx) and depth (rz) of the avatar at height t
      const rx = THREE.MathUtils.lerp(0.145, 0.165, t) + minMargin;
      const rz = THREE.MathUtils.lerp(0.115, 0.135, t) + minMargin;

      const dx = out.x - center.x;
      const dz = out.z - center.z;

      const normDistSq = (dx * dx) / (rx * rx) + (dz * dz) / (rz * rz);
      if (normDistSq < 1.0 && normDistSq > 1e-6) {
        const scale = 1.0 / Math.sqrt(normDistSq);
        out.x = center.x + dx * scale;
        out.z = center.z + dz * scale;
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

function solveArmVectorIK(
  targetSide: 'left' | 'right',
  S3d: { x: number; y: number; z: number },
  E3d: { x: number; y: number; z: number },
  W3d: { x: number; y: number; z: number },
  handLM: any[] | null | undefined,
  _isUserRight: boolean,
  _faceLM?: any[] | null
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

  // 1. Arm Lengths & Scaling (Avatar / User)
  const L1_avatar = 0.22;
  const L2_avatar = 0.215;
  const L_avatar = L1_avatar + L2_avatar;

  const userL1 = Math.hypot(E3d.x - S3d.x, E3d.y - S3d.y, E3d.z - S3d.z);
  const userL2 = Math.hypot(W3d.x - E3d.x, W3d.y - E3d.y, W3d.z - E3d.z);
  const userArmLen = Math.max(0.12, userL1 + userL2);

  // Scale target reaching vector so user reaching their face guarantees avatar reaches its face
  const armScale = THREE.MathUtils.clamp(L_avatar / userArmLen, 0.65, 1.85);

  // 2. Position-based Target Wrist (Scaled from User Shoulder-to-Wrist)
  const vUserWrist = new THREE.Vector3(
    (W3d.x - S3d.x) * mirrorX,
    -(W3d.y - S3d.y),
    -(W3d.z - S3d.z)
  );
  if (vUserWrist.lengthSq() < 1e-6) vUserWrist.set(isLeft ? 0.25 : -0.25, -0.4, 0.1);

  const targetWristPos = shoulderPos.clone().addScaledVector(vUserWrist, armScale);

  // Body collision on wrist (isWristOrHand = true skips head sphere collision so hand can reach cheeks/face!)
  const resolvedWristPos = settings.armCollision
    ? resolveBodyColliders(targetWristPos, 0.02, true)
    : targetWristPos;

  // Reach vector from shoulder to resolved target wrist
  const vReach = new THREE.Vector3().subVectors(resolvedWristPos, shoulderPos);
  const reachDist = vReach.length();
  const maxReach = L_avatar * 0.998;
  const dClamped = THREE.MathUtils.clamp(reachDist, 0.03, maxReach);

  const dTarget = reachDist > 1e-6
    ? vReach.clone().multiplyScalar(1 / reachDist)
    : new THREE.Vector3(isLeft ? 0.3 : -0.3, -0.8, 0).normalize();

  // 3. Law of Cosines for Shoulder Angle (alpha)
  const cosAlpha = (L1_avatar * L1_avatar + dClamped * dClamped - L2_avatar * L2_avatar) / (2 * L1_avatar * dClamped);
  const alpha = Math.acos(THREE.MathUtils.clamp(cosAlpha, -1, 1));

  // 4. Elbow Direction from MediaPipe Pose
  const vUserElbow = new THREE.Vector3(
    (E3d.x - S3d.x) * mirrorX,
    -(E3d.y - S3d.y),
    -(E3d.z - S3d.z)
  );
  if (vUserElbow.lengthSq() < 1e-6) vUserElbow.set(isLeft ? 0.3 : -0.3, -0.7, -0.2);

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

  // 5. Apply Bone Rotations
  const qUpperTarget = new THREE.Quaternion().setFromUnitVectors(vRest, dUpper);
  upperBone.quaternion.slerp(qUpperTarget, slerpRate);

  const currentUpperQ = upperBone.quaternion.clone();
  const qUpperInv = currentUpperQ.clone().invert();
  const vLocalForearm = dForearm.clone().applyQuaternion(qUpperInv).normalize();

  const qLowerTarget = new THREE.Quaternion().setFromUnitVectors(vRest, vLocalForearm);
  lowerBone.quaternion.slerp(qLowerTarget, slerpRate);

  // 6. Direct Wrist Orientation (Orthonormal Basis from Hand Landmarks)
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

  // 7. Direct 5-Finger Tracking (All 21 Landmarks)
  if (handLM && handLM.length === 21) {
    const fingerDefs = [
      { name: 'Thumb', joints: [1, 2, 3, 4], isThumb: true },
      { name: 'Index', joints: [5, 6, 7, 8], isThumb: false },
      { name: 'Middle', joints: [9, 10, 11, 12], isThumb: false },
      { name: 'Ring', joints: [13, 14, 15, 16], isThumb: false },
      { name: 'Little', joints: [17, 18, 19, 20], isThumb: false },
    ];
    const bendAxis = new THREE.Vector3(0, 0, isLeft ? -1 : 1);
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
      const b2Name = (prefix + f.name + 'Intermediate') as VRMHumanBoneName;
      const b3Name = (prefix + f.name + 'Distal') as VRMHumanBoneName;
      const b1 = currentVrm.humanoid.getNormalizedBoneNode(b1Name);
      const b2 = currentVrm.humanoid.getNormalizedBoneNode(b2Name);
      const b3 = currentVrm.humanoid.getNormalizedBoneNode(b3Name);
      if (b1) b1.quaternion.slerp(new THREE.Quaternion().setFromAxisAngle(bendAxis, a1), 0.5);
      if (b2) b2.quaternion.slerp(new THREE.Quaternion().setFromAxisAngle(bendAxis, a2), 0.5);
      if (b3) b3.quaternion.slerp(new THREE.Quaternion().setFromAxisAngle(bendAxis, a3), 0.5);
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
  if (!settings.showSkeleton) {
    pipCtx.clearRect(0, 0, pipOverlay.width, pipOverlay.height);
    return;
  }

  pipOverlay.width = videoElement.videoWidth || 320;
  pipOverlay.height = videoElement.videoHeight || 240;
  pipCtx.clearRect(0, 0, pipOverlay.width, pipOverlay.height);

  const w = pipOverlay.width;
  const h = pipOverlay.height;

  const getX = (x: number) => (settings.mirror ? (1 - x) * w : x * w);
  const getY = (y: number) => y * h;

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
  drawLandmarkSkeleton(results);

  if (!currentVrm) return;

  // 1. GESTURE RECOGNITION FOR EMOTIONS
  // Detect if either hand is currently touching / resting on the face
  // Hands and fingers tracked directly from 21 MediaPipe landmarks

  const rawRight = detectHandGesture(results.rightHandLandmarks);
  const rawLeft = detectHandGesture(results.leftHandLandmarks);
  // When resting hand on face, do not trigger false waving (OPEN_PALM) or rock
  const gestureRight = rawRight;
  const gestureLeft = rawLeft;
  currentActiveGesture = gestureRight !== 'NONE' ? gestureRight : gestureLeft;

  // Target Emotion Values based on mode & gesture
  let targetEmotion: EmotionValues = EMOTION_PRESETS.NEUTRAL.values;

  if (selectedEmotionMode !== 'AUTO') {
    targetEmotion = EMOTION_PRESETS[selectedEmotionMode]?.values || EMOTION_PRESETS.NEUTRAL.values;
    updateEmotionUI(selectedEmotionMode, currentActiveGesture);
  } else if (settings.gestureEmotes && currentActiveGesture !== 'NONE') {
    const gestureKey = currentActiveGesture as EmotionPresetId;
    targetEmotion = EMOTION_PRESETS[gestureKey]?.values || EMOTION_PRESETS.NEUTRAL.values;
    updateEmotionUI('AUTO', currentActiveGesture);
  } else {
    targetEmotion = EMOTION_PRESETS.NEUTRAL.values;
    updateEmotionUI('AUTO', 'NONE');
  }

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
  setExpression('happy', blendedEmotion.happy);
  setExpression('relaxed', blendedEmotion.relaxed);
  setExpression('surprised', blendedEmotion.surprised);
  setExpression('angry', blendedEmotion.angry);
  setExpression('sad', blendedEmotion.sad);

  // 2. FACE & HEAD ENGINE
  if (results.faceLandmarks && results.faceLandmarks.length >= 468) {
    const lm = results.faceLandmarks;

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

    // B. Eyes: 100% natural blinking (NO forced sleepy winks!)
    if (settings.mouth) {
      const leftH = Math.hypot(lm[159].x - lm[145].x, lm[159].y - lm[145].y);
      const leftW = Math.hypot(lm[133].x - lm[33].x, lm[133].y - lm[33].y);
      const leftRatio = leftH / (leftW > 1e-4 ? leftW : 1);

      const rightH = Math.hypot(lm[386].x - lm[374].x, lm[386].y - lm[374].y);
      const rightW = Math.hypot(lm[362].x - lm[263].x, lm[362].y - lm[263].y);
      const rightRatio = rightH / (rightW > 1e-4 ? rightW : 1);

      // Hysteresis threshold
      const calcBlink = (ratio: number) => {
        if (ratio >= 0.21) return 0;
        if (ratio <= 0.12) return 1;
        const t = (0.21 - ratio) / (0.21 - 0.12);
        return THREE.MathUtils.clamp(t * t * (3 - 2 * t) * settings.eyeSens, 0, 1);
      };

      const userLeftBlink = calcBlink(leftRatio);
      const userRightBlink = calcBlink(rightRatio);

      const avatarBlinkL = settings.mirror ? userRightBlink : userLeftBlink;
      const avatarBlinkR = settings.mirror ? userLeftBlink : userRightBlink;

      setExpression('blinkLeft', avatarBlinkL);
      setExpression('blinkRight', avatarBlinkR);

      // When hand is on face, avoid forced dual-eye squint if only one eye is occluded
      if (Math.abs(avatarBlinkL - avatarBlinkR) < 0.25) {
        setExpression('blink', Math.max(avatarBlinkL, avatarBlinkR));
      } else {
        setExpression('blink', 0);
      }

      // C. Mouth: Strict noise gate at rest + expressive speech & smiles
      const mouthH = Math.hypot(lm[13].x - lm[14].x, lm[13].y - lm[14].y);
      const mouthW = Math.hypot(lm[61].x - lm[291].x, lm[61].y - lm[291].y);
      const mouthOpenRatio = mouthH / (mouthW > 1e-4 ? mouthW : 1);

      let webcamMouthOpen = 0;
      if (mouthOpenRatio > 0.14) {
        webcamMouthOpen = THREE.MathUtils.clamp(((mouthOpenRatio - 0.14) / 0.28) * settings.mouthSens, 0, 1);
      }

      // Smile from mouth corners
      const cornerMidY = (lm[61].y + lm[291].y) / 2;
      const smileRatio = (lm[13].y - cornerMidY) / (mouthW > 1e-4 ? mouthW : 1);
      const webcamSmile = smileRatio > 0.03 ? THREE.MathUtils.clamp((smileRatio - 0.03) * 6, 0, 0.7) : 0;

      currentWebcamMouthOpen = webcamMouthOpen;
      currentWebcamSmile = webcamSmile;
      applyMouthExpressions();
    }
  }

  // 3. FULL 3D TORSO TRACKING (Spine, Chest, Hips Sway)
  const pl = results.poseLandmarks;
  if (pl && pl[11] && pl[12]) {
    const s11 = pl[11];
    const s12 = pl[12];
    const sMidX = (s11.x + s12.x) / 2;
    const sMidY = (s11.y + s12.y) / 2;

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
      const qSpineTarget = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(torsoPitch * 0.35, torsoYaw * 0.35, torsoRoll * 0.35, 'YXZ')
      );
      const qChestTarget = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(torsoPitch * 0.65, torsoYaw * 0.65, torsoRoll * 0.65, 'YXZ')
      );

      const spineBone = currentVrm.humanoid?.getNormalizedBoneNode('spine');
      const chestBone = currentVrm.humanoid?.getNormalizedBoneNode('chest');
      if (spineBone) spineBone.quaternion.slerp(qSpineTarget, 0.2);
      if (chestBone) chestBone.quaternion.slerp(qChestTarget, 0.2);

      // Hips Horizontal Sway
      const rawSway = (settings.mirror ? -(sMidX - 0.5) : sMidX - 0.5) * 0.25 * tSens;
      const swayOffset = THREE.MathUtils.clamp(rawSway, -0.15, 0.15);
      const hipsBone = currentVrm.humanoid?.getNormalizedBoneNode('hips');
      if (hipsBone) {
        hipsBone.position.x = THREE.MathUtils.lerp(hipsBone.position.x, swayOffset, 0.1);
      }
    }

    // 4. VECTOR IK ARMS (3D World Landmarks + Full 3D Wrist Orientation)
    const wl = results.ea || results.poseWorldLandmarks || pl;

    if (settings.hands) {
      const targetRightArm = settings.mirror ? 'left' : 'right';
      const targetLeftArm = settings.mirror ? 'right' : 'left';

      // HAND TRACKING WITH 250MS TEMPORAL HYSTERESIS:
      // Prevents arms from dropping or twitching if hands are briefly occluded while touching face
      const now = performance.now();

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

      // User Right Arm
      if (settings.rightHand && isRightActive && wl[12] && wl[14] && wl[16]) {
        solveArmVectorIK(targetRightArm, wl[12], wl[14], wl[16], activeRightHandLM, true, results.faceLandmarks);
        updateHandBadge(rightHandBadge, true);
      } else {
        lastValidRightHandLM = null;
        resetEntireArmToIdle(targetRightArm);
        updateHandBadge(rightHandBadge, false);
      }

      // User Left Arm
      if (settings.leftHand && isLeftActive && wl[11] && wl[13] && wl[15]) {
        solveArmVectorIK(targetLeftArm, wl[11], wl[13], wl[15], activeLeftHandLM, false, results.faceLandmarks);
        updateHandBadge(leftHandBadge, true);
      } else {
        lastValidLeftHandLM = null;
        resetEntireArmToIdle(targetLeftArm);
        updateHandBadge(leftHandBadge, false);
      }
    }
  } else {
    resetEntireArmToIdle('left');
    resetEntireArmToIdle('right');
    updateHandBadge(leftHandBadge, false);
    updateHandBadge(rightHandBadge, false);
  }
}
/* ==========================================================================
   INITIALIZATION & AUDIO LIP-SYNC
   ========================================================================== */
async function initTracking() {
  if (!window.Holistic || !window.Camera) {
    camStatusText.textContent = 'Ошибка скриптов MediaPipe';
    alert('MediaPipe скрипты не были загружены. Проверьте подключение.');
    return;
  }

  camStatusText.textContent = 'Инициализация AI...';

  holisticInstance = new window.Holistic({
    locateFile: (file: string) => `/mediapipe/${file}`,
  });

  holisticInstance.setOptions({
    modelComplexity: 1,
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
    cameraInstance = new window.Camera(videoElement, {
      onFrame: async () => {
        if (isCameraRunning && holisticInstance) {
          await holisticInstance.send({ image: videoElement });
        }
      },
      width: 640,
      height: 480,
    });

    await cameraInstance.start();
    isCameraRunning = true;
    camStatusText.textContent = 'Камера: В эфире';
    const btnText = document.getElementById('camera-btn-text')!;
    btnText.textContent = 'Остановить камеру';
    console.log('Camera and Holistic tracking started successfully.');
  } catch (err: any) {
    console.error('Camera start error:', err);
    camStatusText.textContent = 'Ошибка доступа к камере';
    alert('Не удалось получить доступ к веб-камере. Проверьте разрешения.');
  }
}


let currentWebcamMouthOpen = 0;
let currentWebcamSmile = 0;
let currentAudioMouthOpen = 0;
let audioTimeData: Uint8Array | null = null;
let micStream: MediaStream | null = null;

function applyMouthExpressions() {
  if (!currentVrm || !currentVrm.expressionManager) return;

  const mouthFromWebcam = settings.mouth ? currentWebcamMouthOpen : 0;
  const mouthFromAudio = settings.micLipSync ? currentAudioMouthOpen : 0;
  const mouthFromEmotion = blendedEmotion.mouthOpen;

  const totalOpen = Math.max(mouthFromWebcam, mouthFromAudio, mouthFromEmotion);
  const clampedOpen = THREE.MathUtils.clamp(totalOpen, 0, 1);

  setExpression('aa', clampedOpen);
  setExpression('oh', clampedOpen * 0.35);
  setExpression('ih', mouthFromAudio * 0.2);
  setExpression('ou', clampedOpen * 0.15);
  setExpression('ee', 0);

  if (blendedEmotion.happy > 0.05) {
    setExpression('happy', blendedEmotion.happy);
  } else if (settings.mouth) {
    setExpression('happy', currentWebcamSmile);
  }
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
    document.getElementById('camera-btn-text')!.textContent = 'Запустить камеру';
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

document.getElementById('toggle-gestures')?.addEventListener('change', (e) => {
  settings.gestureEmotes = (e.target as HTMLInputElement).checked;
  if (!settings.gestureEmotes) {
    updateEmotionUI(selectedEmotionMode, 'NONE');
  }
});

// Emotion Palette Grid Buttons
document.querySelectorAll('.emotion-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.emotion-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');

    const emotionId = (btn as HTMLElement).dataset.emotion as EmotionPresetId;
    if (emotionId) {
      selectedEmotionMode = emotionId;
      updateEmotionUI(selectedEmotionMode, currentActiveGesture);
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
  if (e.code === 'KeyH') {
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
    loadVRM(url, file.name);
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
    loadVRM(url, file.name);
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