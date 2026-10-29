import { mkdir, cp, writeFile, rename, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// These are model/runtime assets, never camera frames. The server CSP blocks external runtime connections.
const root = process.cwd();
await mkdir(path.join(root, 'public/models'), { recursive: true });
await cp(path.join(root, 'node_modules/@mediapipe/tasks-vision/wasm'), path.join(root, 'public/mediapipe'), { recursive: true });
await cp(path.join(root, 'node_modules/@mediapipe/tasks-vision/vision_bundle.mjs'), path.join(root, 'public/mediapipe/vision_bundle.mjs'));
const modelPath = path.join(root, 'public/models/pose_landmarker_lite.task');
const modelUrl = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
let model;
try { model = await readFile(modelPath); }
catch {
  const response = await fetch(modelUrl, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Model download failed: ${response.status}`);
  model = Buffer.from(await response.arrayBuffer());
  if (model.length < 1_000_000 || model.length > 30_000_000) throw new Error('Unexpected pose model size.');
  await writeFile(`${modelPath}.tmp`, model);
  await rename(`${modelPath}.tmp`, modelPath);
}
console.log(`Local pose assets ready. Model SHA-256: ${createHash('sha256').update(model).digest('hex')}`);
