import { FilesetResolver, PoseLandmarker } from '/mediapipe/vision_bundle.mjs';
const result = document.getElementById('result');
const blocked = new Set();
document.addEventListener('securitypolicyviolation', event => { blocked.add(event.blockedURI); });
let model;
try {
  const started = performance.now();
  const fileset = await FilesetResolver.forVisionTasks('/mediapipe');
  model = await PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task', delegate: 'CPU' },
    runningMode: 'VIDEO', numPoses: 1,
  });
  const output = model.detectForVideo(document.getElementById('input'), performance.now());
  model.close(); model = null;
  result.textContent = `PASS · Local WebAssembly and model initialized.\nPASS · One inference completed on a blank canvas.\nDetected poses: ${output.landmarks.length}\nElapsed: ${Math.round(performance.now() - started)} ms\nPhysical camera and staged-clip evaluation remain untested.`;
  document.querySelector('h1').textContent = 'The local pose runtime works.';
  setTimeout(() => {
    if ([...blocked].some(uri => uri.includes('odml.pa.googleapis.com'))) result.textContent += '\nPASS · MediaPipe metrics connection blocked by content security policy.';
  }, 1000);
} catch (error) {
  result.textContent = `FAIL · ${error instanceof Error ? error.message : String(error)}\nRun npm run prepare:models, rebuild, and retry.`;
  document.querySelector('h1').textContent = 'The local pose runtime needs attention.';
} finally { model?.close(); }
