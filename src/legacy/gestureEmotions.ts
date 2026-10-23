/**
 * Legacy AI Hand Gesture Recognition & Auto-Emotions System
 * Extracted from main.ts (v1.2.1) for archival and safe rollback.
 * Not active in runtime.
 */

export type RecognizedGesture = 'NONE' | 'ROCK' | 'PEACE' | 'THUMBS_UP' | 'FIST' | 'OPEN_PALM';

export interface EmotionValues {
  happy: number;
  relaxed: number;
  surprised: number;
  angry: number;
  sad: number;
  mouthSmile: number;
  mouthOpen: number;
}

export interface EmotionPresetDef {
  id: string;
  name: string;
  icon: string;
  desc: string;
  guideId: string;
  values: EmotionValues;
}

export const GESTURE_EMOTION_PRESETS: Record<string, EmotionPresetDef> = {
  AUTO: {
    id: 'AUTO',
    name: 'Авто (По жестам)',
    icon: '✨',
    desc: 'Распознавание жестов рук и адаптивная мимика',
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
};

/**
 * AI Hand Gesture Recognition
 */
export function detectHandGestureLegacy(lm: any[] | null | undefined): RecognizedGesture {
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

  const dThumbIndex = Math.hypot(lm[4].x - lm[5].x, lm[4].y - lm[5].y, lm[4].z - lm[5].z);
  const dThumbPip = Math.hypot(lm[3].x - lm[5].x, lm[3].y - lm[5].y, lm[3].z - lm[5].z);
  const thumbOpen = dThumbIndex > dThumbPip * 1.05;

  if (indexOpen && pinkyOpen && !middleOpen && !ringOpen) return 'ROCK';
  if (indexOpen && middleOpen && !ringOpen && !pinkyOpen) return 'PEACE';
  if (thumbOpen && !indexOpen && !middleOpen && !ringOpen && !pinkyOpen) return 'THUMBS_UP';
  if (!thumbOpen && !indexOpen && !middleOpen && !ringOpen && !pinkyOpen) return 'FIST';
  if (thumbOpen && indexOpen && middleOpen && ringOpen && pinkyOpen) return 'OPEN_PALM';

  return 'NONE';
}
