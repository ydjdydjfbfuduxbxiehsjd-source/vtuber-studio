# VTuber Studio Pro ✨ (Web Edition)

<p align="center">
  <span>English Version</span> | <a href="README.md"><strong>Русская версия</strong></a>
</p>

<p align="center">
  <img src="screenshots/screenshot_01.png" alt="VTuber Studio Pro Interface" width="760">
</p>

A standalone browser-based 3D virtual avatar VTuber studio with high-precision AI face tracking, Apple ARKit 52 Perfect Sync expressions, full hand & finger IK, and torso tracking using a regular webcam!

---

## 🚀 Quick Start (For Users)

1. Go to the **[Releases](https://github.com/ydjdydjfbfuduxbxiehsjd-source/vtuber-studio/releases)** page and download **`VTuber_Studio_Pro.zip`**.
2. Extract the archive to any folder.
3. Launch **`start.bat`** (or `run.bat`).
4. Your browser will automatically open **`http://localhost:5173/`**.

> [!NOTE]
> **No Node.js or Python required for running prebuilt releases!**  
> All neural network weights (MediaPipe Holistic, Three.js, VRM Loader) and avatars are bundled inside the portable archive. It runs 100% offline using the built-in Windows PowerShell HTTP server (`server.ps1`).

---

## 💻 Developer Setup (Build from Source)

To clone and build from source code, you need **[Node.js](https://nodejs.org/) (v18+)** and **npm** installed.

```bash
# 1. Clone repository
git clone https://github.com/ydjdydjfbfuduxbxiehsjd-source/vtuber-studio.git
cd vtuber-studio

# 2. Install dependencies
npm install

# 3. Start local development server with hot reload
npm run dev

# 4. Build production bundle to dist/
npm run build

# 5. Preview production build locally
npm run preview
```

---

## 🎀 Avatar Models

* **Standard VRM** — baseline VRM avatar for testing tracking and standard blendshapes.
* **Gyaru (ARKit 52 ✨)** — avatar with full 52 Apple ARKit blendshapes.
* **Custom Avatar** — simply drag & drop any `.vrm` file directly into your browser window or place it in `public/models/`.

---

## ⚖️ Model & Code Licenses

* **Application Code**: Licensed under the open-source **MIT License** (see [LICENSE](LICENSE)). Free for personal, educational, and commercial streaming use.
* **3D Avatar Models (`.vrm`)**:
  > [!IMPORTANT]
  > The MIT License applies **strictly to the source code** of this software.  
  > 3D avatar models carry their own copyright and license terms:
  > * `sample.vrm` is an official sample model by pixiv Inc. released under the [VRM 1.0 License](https://vrm.dev/licenses/1.0/) (allows free use, modification, and redistribution).
  > * Third-party avatars belong to their respective creators (VRoid Hub, Booth, etc.). Please verify the model creator's terms before using avatars in public broadcasts.

---

## ⚡ Key Features

* **Facial Tracking (Apple ARKit 52)**: 468/478 FaceMesh points with Perfect Sync blendshapes (individual eye blinks, wide eyes, squints, brow raises/furrows, asymmetrical smiles, cheek puff, mouth pucker/funnel, gaze tracking).
* **Hand & Finger IK**: Full 21-joint skeletal hand tracking, anatomical elbow IK, face-touch snapping, body collision avoidance, and graceful idle A-pose transitions.
* **Torso & Posture Tracking**: Shoulder roll, body yaw/pitch, and natural sway.
* **Audio Lip-Sync**: Real-time microphone audio amplitude analysis blended with webcam mouth movements.
* **OBS Studio Integration**: Transparent background, Chroma Key (Green / Blue / Magenta), hotkeys, and full-screen support.

---

## ⌨️ Hotkeys

| Key | Action |
| :--- | :--- |
| **H** | Hide / Show side control panel (for clean OBS screen capture) |
| **Space** | Reset avatar pose & center 3D camera |
| **LMB + Drag** | Orbit camera around avatar |
| **RMB + Drag** | Pan scene camera |
| **Mouse Wheel** | Zoom in / out |

---

## 📄 License

MIT License (see [LICENSE](LICENSE)).
