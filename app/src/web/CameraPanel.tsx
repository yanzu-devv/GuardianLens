import { useEffect, useRef, useState } from 'react';
import type { PoseLandmarker } from '@mediapipe/tasks-vision';
import { configuredDetectionMode, type Command, type Snapshot, type DetectionCoverage, type DetectionMode, type DetectionEvidence } from '../shared/domain';
import { CollapseDetector, type DetectionObservation, type Landmark } from '../shared/detector';
import { SeatedDetector, type SeatedObservation } from '../shared/seatedDetector';
import './seated-camera.css';

interface Props {
  snapshot: Snapshot;
  send: (command: Command) => Promise<void>;
  connected: boolean;
}

const NO_OBSERVATION: DetectionObservation = {
  personInView: false, rapidDownward: false, nearFloor: false,
  limitedMovement: false, possibleCollapse: false,
};

const NO_SEATED_OBSERVATION: SeatedObservation = { personInView: false, trackingReady: false, coverage: 'absent', message: 'Keep your head and both shoulders in view.', calibration: 'none', calibrationProgress: 0, calibratedAt: null, rapidMovement: false, slumped: false, limitedMovement: false, possibleEvent: false };

const CONNECTIONS = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [25, 27], [26, 28],
];

/** Camera frames and landmarks remain in this renderer; only health/event commands leave it. */
export function CameraPanel({ snapshot, send, connected }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const modelRef = useRef<PoseLandmarker | null>(null);
  const detectorRef = useRef(new CollapseDetector());
  const seatedDetectorRef = useRef(new SeatedDetector());
  const calibrationWallTimeRef = useRef<number | null>(null);
  const serverCalibrationRef = useRef<number | null>(snapshot.monitoring.calibratedAt ?? null);
  const snapshotRef = useRef(snapshot);
  const sendRef = useRef(send);
  const connectedRef = useRef(connected);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const skeletonRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFrameRef = useRef(0);
  const lastHeartbeatRef = useRef(0);
  const lastVideoTimeRef = useRef(-1);
  const lastStatusRef = useRef('');
  const lastObservationRef = useRef('');
  const interruptionRef = useRef(false);
  const pendingPauseReasonRef = useRef<string | null>(null);
  const cameraControlRef = useRef<(enabled: boolean) => void>(() => {});
  const [phase, setPhase] = useState<'off' | 'starting' | 'live' | 'error'>('off');
  const [error, setError] = useState<string | null>(null);
  const [skeleton, setSkeleton] = useState(true);
  const [observation, setObservation] = useState<DetectionObservation>(NO_OBSERVATION);
  const [seatedObservation, setSeatedObservation] = useState<SeatedObservation>(NO_SEATED_OBSERVATION);
  const [modeSaving, setModeSaving] = useState(false);
  const [calibrationStarting, setCalibrationStarting] = useState(false);
  const mode = configuredDetectionMode(snapshot.config);
  const activeIncident = Boolean(snapshot.incident && !['cancelled', 'resolved'].includes(snapshot.incident.status));

  snapshotRef.current = snapshot;
  sendRef.current = send;
  connectedRef.current = connected;
  skeletonRef.current = skeleton;

  const safeSend = async (command: Command) => {
    try {
      await sendRef.current(command);
      return true;
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof Error ? cause.message : 'The monitoring server did not receive this update.');
      return false;
    }
  };

  const publishCamera = async (poseReady: boolean, personInView: boolean, interruption: string | null = null, coverage: DetectionCoverage = 'absent', coverageMessage: string | null = null) => {
    const detectionMode = configuredDetectionMode(snapshotRef.current.config);
    const calibratedAt = detectionMode === 'seated' ? calibrationWallTimeRef.current : null;
    const metadata = { poseReady, personInView, interruption, detectionMode, coverage, calibratedAt, coverageMessage };
    const signature = JSON.stringify(metadata);
    const health = snapshotRef.current.monitoring;
    if (lastStatusRef.current === signature && health.camera === 'connected'
      && health.poseReady === poseReady && health.personInView === personInView
      && health.coverage === coverage && health.detectionMode === detectionMode && health.coverageMessage === coverageMessage
      && (health.calibratedAt ?? null) === calibratedAt && (!interruption || health.interruption === interruption)) return true;
    const accepted = await safeSend({ type: 'camera', camera: 'connected', ...metadata });
    if (accepted) lastStatusRef.current = signature;
    return accepted;
  };

  const clearSeatedReference = () => {
    seatedDetectorRef.current.reset();
    lastObservationRef.current = '';
    calibrationWallTimeRef.current = null;
    if (mountedRef.current) setSeatedObservation(NO_SEATED_OBSERVATION);
  };

  const releaseResources = () => {
    generationRef.current++;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    const stream = streamRef.current;
    streamRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());
    const model = modelRef.current;
    modelRef.current = null;
    try { model?.close(); } catch { /* Resources are already being released. */ }
    if (videoRef.current) videoRef.current.srcObject = null;
    canvasRef.current?.getContext('2d')?.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    detectorRef.current.reset();
    clearSeatedReference();
    lastStatusRef.current = '';
    lastObservationRef.current = '';
    lastFrameRef.current = 0;
    lastHeartbeatRef.current = 0;
    lastVideoTimeRef.current = -1;
    interruptionRef.current = false;
    pendingPauseReasonRef.current = null;
  };

  const stop = async (reason: string | null = null) => {
    releaseResources();
    if (mountedRef.current) {
      setPhase(reason ? 'error' : 'off');
      setObservation(NO_OBSERVATION);
      setError(reason);
    }
    await safeSend({
      type: 'camera', camera: reason ? 'disconnected' : 'off', poseReady: false,
      personInView: false, interruption: reason ?? 'Camera stopped. Monitoring is interrupted.',
    });
  };

  const draw = (landmarks: readonly Landmark[] | null) => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!landmarks || !skeletonRef.current) return;
    context.strokeStyle = '#B6FF3B';
    context.fillStyle = '#B6FF3B';
    context.lineWidth = 3;
    const seatedMode = configuredDetectionMode(snapshotRef.current.config) === 'seated';
    const connections = seatedMode ? CONNECTIONS.filter(([a, b]) => a! < 23 && b! < 23) : CONNECTIONS;
    for (const [a, b] of connections) {
      const start = landmarks[a!];
      const end = landmarks[b!];
      if (!start || !end || (start.visibility ?? 1) < 0.55 || (end.visibility ?? 1) < 0.55) continue;
      context.beginPath();
      context.moveTo(start.x * canvas.width, start.y * canvas.height);
      context.lineTo(end.x * canvas.width, end.y * canvas.height);
      context.stroke();
    }
    for (const key of (seatedMode ? [0, 7, 8, 11, 12, 13, 14, 15, 16] : [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28])) {
      const point = landmarks[key];
      if (!point || (point.visibility ?? 1) < 0.55) continue;
      context.beginPath();
      context.arc(point.x * canvas.width, point.y * canvas.height, 4, 0, Math.PI * 2);
      context.fill();
    }
  };

  const runFrame = async (generation: number) => {
    if (generationRef.current !== generation || !mountedRef.current) return;
    const next = () => { timerRef.current = setTimeout(() => { void runFrame(generation); }, 100); };
    const video = videoRef.current;
    const model = modelRef.current;
    const now = performance.now();
    if (!video || !model || !streamRef.current) return;
    if (!snapshotRef.current.config.consent) {
      await stop();
      return;
    }

    // In Electron the dashboard can remain hidden while its background renderer runs.
    // A background browser tab is explicitly interrupted rather than assumed protected.
    const desktop = Boolean((window as Window & { guardianDesktop?: unknown }).guardianDesktop);
    const backgroundBrowser = document.hidden && !desktop;
    if (backgroundBrowser || !connectedRef.current || !navigator.onLine) {
      detectorRef.current.reset();
      if (!interruptionRef.current) {
        interruptionRef.current = true;
        clearSeatedReference();
        lastStatusRef.current = '';
        const reason = backgroundBrowser ? 'Browser tab is hidden. Keep the monitoring tab visible or use the desktop app.'
          : 'Connection to the monitoring server was lost.';
        pendingPauseReasonRef.current = reason;
        if (await safeSend({ type: 'interrupt', reason })) pendingPauseReasonRef.current = null;
      }
      next();
      return;
    }

    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.paused || video.currentTime === lastVideoTimeRef.current) {
      if (lastFrameRef.current && now - lastFrameRef.current > 3000 && !interruptionRef.current) {
        interruptionRef.current = true;
        detectorRef.current.reset();
        clearSeatedReference();
        const reason = 'Camera frames stopped updating. Monitoring is paused; check the camera before enabling it again.';
        pendingPauseReasonRef.current = reason;
        if (await safeSend({ type: 'interrupt', reason })) pendingPauseReasonRef.current = null;
      }
      next();
      return;
    }

    if (pendingPauseReasonRef.current) {
      if (await safeSend({ type: 'interrupt', reason: pendingPauseReasonRef.current })) pendingPauseReasonRef.current = null;
      else { next(); return; }
    }

    lastVideoTimeRef.current = video.currentTime;
    try {
      const result = model.detectForVideo(video, now);
      if (generationRef.current !== generation) return;
      const landmarks = result.landmarks[0] ?? null;
      const active = snapshotRef.current.incident && !['cancelled', 'resolved'].includes(snapshotRef.current.incident.status);
      const selectedMode = configuredDetectionMode(snapshotRef.current.config);
      const mayDetect = snapshotRef.current.monitoring.enabled && !active;
      let personInView = false;
      let coverage: DetectionCoverage = 'absent';
      let coverageMessage = '';
      let possibleEvent = false;
      let evidence: DetectionEvidence = 'full_body_collapse';
      if (selectedMode === 'seated') {
        if (!mayDetect) seatedDetectorRef.current.resetEvidence();
        const seated = seatedDetectorRef.current.update(landmarks, now, video.videoWidth / video.videoHeight);
        if (seated.calibration === 'ready' && seated.calibratedAt !== null) {
          if (calibrationWallTimeRef.current === null) calibrationWallTimeRef.current = Date.now();
        } else calibrationWallTimeRef.current = null;
        setSeatedObservation(current => JSON.stringify(current) === JSON.stringify(seated) ? current : seated);
        personInView = seated.personInView;
        coverage = seated.coverage;
        coverageMessage = seated.message;
        possibleEvent = seated.possibleEvent;
        evidence = seated.eventEvidence ?? 'seated_still_slump';
      } else {
        if (!mayDetect) detectorRef.current.reset();
        const observed = detectorRef.current.update(landmarks, now);
        const anyPose = Boolean(landmarks && [0, 11, 12, 23, 24].some(key => {
          const point = landmarks[key];
          return point && (point.visibility ?? 1) >= 0.55 && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
        }));
        personInView = observed.personInView || anyPose;
        coverage = observed.personInView ? 'ready' : anyPose ? 'partial' : 'absent';
        coverageMessage = observed.personInView ? 'Shoulders and hips visible for full-body movement rules.' : 'Full-body mode needs shoulders and hips in view. Choose seated mode for a desk camera.';
        const signature = JSON.stringify(observed);
        if (lastObservationRef.current !== signature) { lastObservationRef.current = signature; setObservation(observed); }
        possibleEvent = observed.possibleCollapse;
      }
      lastFrameRef.current = performance.now();
      interruptionRef.current = false;
      draw(landmarks);
      await publishCamera(true, personInView, null, coverage, coverageMessage);
      if (generationRef.current !== generation || !mountedRef.current) return;

      if (now - lastHeartbeatRef.current >= 2000 && performance.now() - lastFrameRef.current < 3000) {
        lastHeartbeatRef.current = now;
        await safeSend({ type: 'heartbeat' });
      }
      if (possibleEvent && mayDetect) {
        await safeSend({ type: 'trigger', source: 'camera', evidence });
      }

    } catch (cause) {
      const reason = `Pose processing stopped: ${cause instanceof Error ? cause.message : 'model error'}`;
      void stop(reason);
      return;
    }
    next();
  };

  const start = async () => {
    if (!snapshotRef.current.config.consent || !connectedRef.current || phase === 'starting') return;
    releaseResources();
    const generation = generationRef.current;
    setPhase('starting');
    setError(null);
    // A new camera session must never inherit a previous monitoring request.
    if (!await safeSend({ type: 'monitoring', enabled: false })) {
      setPhase('error');
      return;
    }
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access requires localhost or HTTPS in a supported browser.');
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 960 }, height: { ideal: 600 }, frameRate: { ideal: 15, max: 20 } }, audio: false,
      });
      if (!mountedRef.current || generationRef.current !== generation || !snapshotRef.current.config.consent) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      stream.getVideoTracks().forEach((track) => track.addEventListener('ended', () => {
        if (streamRef.current === stream) void stop('Camera disconnected or permission was revoked.');
      }, { once: true }));
      const video = videoRef.current;
      if (!video) throw new Error('Camera preview is not available.');
      video.srcObject = stream;
      await video.play();
      if (generationRef.current !== generation) return;
      await publishCamera(false, false, 'Loading the local pose model. Detection is not ready yet.');
      const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision');
      const fileset = await FilesetResolver.forVisionTasks('/mediapipe');
      const model = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task', delegate: 'CPU' },
        runningMode: 'VIDEO', numPoses: 1, outputSegmentationMasks: false,
        minPoseDetectionConfidence: 0.6, minPosePresenceConfidence: 0.6, minTrackingConfidence: 0.6,
      });
      if (!mountedRef.current || generationRef.current !== generation) {
        model.close();
        return;
      }
      modelRef.current = model;
      setPhase('live');
      void runFrame(generation);
    } catch (cause) {
      if (generationRef.current !== generation || !mountedRef.current) return;
      let reason = cause instanceof Error ? cause.message : 'Camera or pose model could not start.';
      if (cause instanceof DOMException && cause.name === 'NotAllowedError') reason = 'Camera permission was denied. Allow camera access in system/browser settings, then retry.';
      if (cause instanceof DOMException && cause.name === 'NotFoundError') reason = 'No camera was found. Connect a camera, then retry.';
      await stop(reason);
    }
  };

  const calibrateSeated = async () => {
    if (phase !== 'live' || !connectedRef.current || activeIncident || calibrationStarting) return;
    setCalibrationStarting(true);
    try {
      if (snapshotRef.current.monitoring.enabled && !await safeSend({ type: 'monitoring', enabled: false })) return;
      clearSeatedReference();
      serverCalibrationRef.current = null;
      lastStatusRef.current = '';
      const visible = snapshotRef.current.monitoring.personInView;
      if (!await publishCamera(true, visible, null, visible ? 'uncalibrated' : 'absent', 'Calibration requested. Waiting for a clear, steady head-and-shoulders view.')) return;
      if (!mountedRef.current || !streamRef.current) return;
      seatedDetectorRef.current.beginCalibration();
      setSeatedObservation(current => ({ ...current, calibration: 'collecting', calibrationProgress: 0, calibratedAt: null, coverage: 'uncalibrated', message: 'Keep your head and both shoulders visible. Calibration begins when the view is steady.' }));
    } finally { if (mountedRef.current) setCalibrationStarting(false); }
  };

  const cancelCalibration = () => {
    clearSeatedReference();
    lastStatusRef.current = '';
    const health = snapshotRef.current.monitoring;
    void publishCamera(health.poseReady, health.personInView, null, health.personInView ? 'uncalibrated' : 'absent', 'Calibration cancelled. Start again when ready.');
  };

  const changeMode = async (detectionMode: DetectionMode) => {
    if (activeIncident || modeSaving) return;
    setModeSaving(true);
    try {
      await sendRef.current({ type: 'configure', config: { ...snapshotRef.current.config, detectionMode } });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Detection mode could not change.'); }
    finally { setModeSaving(false); }
  };

  useEffect(() => {
    clearSeatedReference();
    detectorRef.current.reset();
    lastStatusRef.current = '';
    lastObservationRef.current = '';
    setObservation(NO_OBSERVATION);
  }, [mode]);

  useEffect(() => {
    const serverCalibration = snapshot.monitoring.calibratedAt ?? null;
    if (serverCalibrationRef.current !== null && serverCalibration === null && (seatedDetectorRef.current.calibrated || !snapshot.monitoring.poseReady)) {
      clearSeatedReference();
      lastStatusRef.current = '';
    }
    serverCalibrationRef.current = serverCalibration;
  }, [snapshot.monitoring.calibratedAt, snapshot.monitoring.poseReady]);

  cameraControlRef.current = (enabled: boolean) => {
    if (enabled) void start();
    else void stop();
  };

  useEffect(() => window.guardianDesktop?.onCameraControl(enabled => cameraControlRef.current(enabled)), []);

  useEffect(() => {
    if (!snapshot.config.consent && (streamRef.current || phase === 'starting')) {
      // Revoking consent stops capture even while the preview stays mounted.
      // An outstanding OS permission request is invalidated by the generation.
      void stop();
    }
  }, [snapshot.config.consent, phase]);

  useEffect(() => {
    mountedRef.current = true;
    const beforeUnload = () => {
      // The server's missing-frame heartbeat also expires if this message cannot arrive.
      if (streamRef.current) void safeSend({ type: 'interrupt', reason: 'Monitoring window closed.' });
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      mountedRef.current = false;
      window.removeEventListener('beforeunload', beforeUnload);
      const hadCamera = Boolean(streamRef.current);
      releaseResources();
      if (hadCamera) void safeSend({ type: 'camera', camera: 'disconnected', poseReady: false, personInView: false, interruption: 'Monitoring camera view closed.' });
    };
  }, []);

  const live = phase === 'live';
  const setupReady = snapshot.config.consent && Boolean(snapshot.config.room.trim()) && (snapshot.config.locationMode === 'device' || Boolean(snapshot.config.address.trim())) && snapshot.config.contacts.some(contact => contact.optedIn);
  const seatedReady = seatedObservation.coverage === 'ready' && calibrationWallTimeRef.current !== null && snapshot.monitoring.calibratedAt === calibrationWallTimeRef.current;
  const monitoringReady = connected && live && snapshot.monitoring.coverage === 'ready' && (mode !== 'seated' || seatedReady);
  return <>
    <div className="camera-mode-choice"><label>Monitoring mode<select value={mode} disabled={!connected || modeSaving || activeIncident} onChange={event => { void changeMode(event.target.value as DetectionMode); }}><option value="seated">Seated · desk and laptop</option><option value="full_body">Full body · wider fixed view</option></select></label><p>{mode === 'seated' ? 'Stay seated. Frame your head and both shoulders, then calibrate your normal position. Legs and hips are not required.' : 'Use a wider stationary view with shoulders and hips visible. This mode looks for descent toward a low horizontal posture.'}</p></div>
    <div className="camera-stage" style={{ position: 'relative', overflow: 'hidden', background: '#090e0b', aspectRatio: '16 / 10', minHeight: 280 }}>
      <video ref={videoRef} className="camera-mirrored-media" autoPlay muted playsInline aria-label="Mirrored live camera preview, processed on this Mac"
        style={{ width: '100%', height: '100%', objectFit: 'contain', display: streamRef.current ? 'block' : 'none' }} />
      <canvas ref={canvasRef} className="camera-mirrored-media" aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }} />
      {!streamRef.current && <div className="camera-empty" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', position: 'absolute', inset: 0, gap: 14, textAlign: 'center', padding: 30 }}>
        <svg width="58" height="58" viewBox="0 0 48 48" fill="none" aria-hidden="true"><rect x="7" y="12" width="26" height="24" rx="7" stroke="#56665a" strokeWidth="1.5" /><path d="m33 20 8-4v16l-8-4" stroke="#56665a" strokeWidth="1.5" /><circle cx="20" cy="24" r="5" stroke="#B6FF3B" strokeWidth="1.5" /></svg>
        <strong style={{ fontSize: 20, color: '#F2F6EF' }}>{phase === 'starting' ? 'Preparing your camera…' : 'Your camera is off'}</strong>
        <span style={{ maxWidth: 330, color: '#A5B2A7', fontSize: 13, lineHeight: 1.7 }}>{mode === 'seated' ? 'Enable the camera, stay seated, and keep your head and both shoulders visible. Capture a seated reference before enabling monitoring.' : 'Enable a fixed camera with shoulders and hips visible. This wider-view mode uses full-body movement rules.'}</span>
      </div>}
      {streamRef.current && <span style={{ position: 'absolute', left: 16, top: 16, borderRadius: 6, background: '#080B09dd', padding: '7px 10px', fontSize: 11, letterSpacing: 1, color: '#F2F6EF' }}>
        {live ? '● LIVE CAMERA' : 'CAMERA ON · MODEL LOADING'}
      </span>}
      {live && <span style={{ position: 'absolute', left: 16, bottom: 16, borderRadius: 6, background: '#080B09dd', padding: '7px 10px', fontSize: 12, color: '#F2F6EF' }}>
        {snapshot.monitoring.enabled && !snapshot.monitoring.interruption && snapshot.monitoring.coverage === 'ready' ? 'Monitoring active' : mode === 'seated' && !seatedReady ? 'Preview · seated calibration needed' : 'Preview · monitoring paused'}
      </span>}
    </div>
    <div className="camera-controls" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12, padding: '16px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <button className="button secondary" type="button" onClick={() => { if (streamRef.current) void stop(); else void start(); }} disabled={phase === 'starting' || (!streamRef.current && (!snapshot.config.consent || !connected))}>
          {phase === 'starting' ? 'Loading local model…' : streamRef.current ? 'Stop camera' : phase === 'error' ? 'Retry camera' : 'Enable camera'}
        </button>
        {phase === 'starting' && <button className="button secondary" type="button" onClick={() => { void stop(); }}>Cancel</button>}
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: '#A5B2A7', fontSize: 12, minHeight: 44 }}>
          <input type="checkbox" checked={skeleton} onChange={(event) => setSkeleton(event.target.checked)} style={{ accentColor: '#B6FF3B' }} /> Skeleton overlay
        </label>
      </div>
      <span style={{ color: '#A5B2A7', fontSize: 11 }}>No raw-video recording</span>
    </div>
    {!snapshot.config.consent && <p style={{ margin: '0 20px 18px', color: '#FFCA64', fontSize: 12 }}>Complete the response plan and monitoring consent to enable your camera.</p>}
    {error && <p role="alert" style={{ margin: '0 20px 18px', color: '#FFCA64', fontSize: 13, lineHeight: 1.6 }}>{error}</p>}
    {mode === 'seated' && <section className="seated-calibration" aria-label="Seated position calibration">
      <div className="seated-calibration-heading"><span className="seated-step">2</span><div><strong>{seatedReady ? 'Seated reference ready' : seatedObservation.calibration === 'collecting' ? 'Capturing your seated reference…' : 'Calibrate while sitting normally'}</strong><p>{live ? seatedObservation.message : 'Start the camera, then show your head and both shoulders.'}</p></div><span className={`pill ${seatedReady ? 'lime-pill' : 'amber-pill'}`}>{seatedReady ? 'Calibrated' : 'Not ready'}</span></div>
      {seatedObservation.calibration === 'collecting' && <progress aria-label="Seated calibration progress" max={1} value={seatedObservation.calibrationProgress} />}
      <div className="seated-calibration-actions"><button className="button secondary" disabled={!live || !connected || calibrationStarting || activeIncident} onClick={() => { void calibrateSeated(); }}>{calibrationStarting ? 'Preparing calibration…' : seatedObservation.calibration === 'collecting' ? 'Restart calibration' : seatedReady ? 'Recalibrate seated position' : 'Calibrate seated position'}</button>{seatedObservation.calibration === 'collecting' && !calibrationStarting && <button className="button secondary" onClick={cancelCalibration}>Cancel calibration</button>}<button className="button primary" disabled={!monitoringReady || !setupReady || snapshot.monitoring.enabled || activeIncident} onClick={() => { void safeSend({ type: 'monitoring', enabled: true }); }}>{snapshot.monitoring.enabled && !snapshot.monitoring.interruption ? 'Monitoring enabled' : 'Enable seated monitoring'}</button></div>
      {!live ? <p>Enable the camera to start calibration.</p> : !connected ? <p>Reconnect to the server to start calibration.</p> : activeIncident ? <p>Finish the active incident before recalibrating.</p> : <p>Click to start. Your reference is accepted only after a clear, steady view for two seconds.</p>}
      <p className="seated-limit">A lowered head, sideways head tilt, or slumped posture must stay with little head movement for 10 continuous seconds before the app asks “Are you okay?”. Head movement, returning upright, or losing required tracking restarts this quiet timer. Shoulder movement alone does not restart it. Fast movement alone does not trigger a check-in. After the question appears, a separate 10-second response window runs before “Do you need help?”.</p>
      <p className="seated-limit">It cannot confirm fainting, consciousness, breathing, or a fall to the floor. Ordinary leaning can look similar.</p>
    </section>}
    {live && <div className="camera-measured-observations" aria-label="Measured camera observations">
      {mode === 'seated' && seatedObservation.measurements && <><span>Head position: {seatedObservation.measurements.headToShoulderWidths.toFixed(2)} widths from shoulder line (below is positive)</span><span>Calibrated position: {seatedObservation.measurements.baselineHeadToShoulderWidths.toFixed(2)} widths</span><span>Head lowering: {seatedObservation.measurements.headDropWidths.toFixed(2)} / 0.25 shoulder widths</span><span>Sideways head tilt: {seatedObservation.measurements.headTiltDegrees === null ? 'unavailable — both ears must be visible during calibration and tracking' : `${seatedObservation.measurements.headTiltDegrees.toFixed(0)}° / 15° from calibration`}</span><span>Recent downward speed: {seatedObservation.measurements.headVelocityWidthsPerSecond.toFixed(2)} widths/s</span><span>Sideways speed: {Math.abs(seatedObservation.measurements.headSideVelocityWidthsPerSecond).toFixed(2)} widths/s</span><span>Quiet hold: {(Math.min(seatedObservation.measurements.holdMs, seatedObservation.measurements.holdRequiredMs) / 1000).toFixed(1)} / {(seatedObservation.measurements.holdRequiredMs / 1000).toFixed(1)} s</span></>}
      {mode === 'seated' ? <><span>{seatedObservation.trackingReady ? 'Head + both shoulders visible' : seatedObservation.personInView ? 'Partial upper-body view' : 'No reliable upper-body pose'}</span>{seatedObservation.rapidMovement && <span className="camera-warning">Fast head movement relative to shoulders</span>}{seatedObservation.slumped && <span className="camera-warning">Head lowered, tilted, or slumped from calibrated position</span>}{seatedObservation.limitedMovement && <span className="camera-warning">Little head movement</span>}</> : <><span>{observation.personInView ? 'Shoulders and hips visible' : 'Full-body view incomplete'}</span>{observation.rapidDownward && <span className="camera-warning">Rapid downward movement observed</span>}{observation.nearFloor && <span className="camera-warning">Low horizontal posture observed</span>}{observation.limitedMovement && <span className="camera-warning">Limited body movement</span>}</>}
    </div>}

    <p style={{ margin: '0 20px 20px', fontSize: 11, lineHeight: 1.7, color: '#A5B2A7' }}>{mode === 'seated' ? 'Experimental movement rules, not a fainting diagnosis. Recalibrate after moving the laptop, changing camera angle, restarting the camera, or a hidden tab. Leaving the camera view alone keeps your reference.' : 'Experimental full-body movement rules. Recheck framing after moving the camera or an interruption.'} Covers only the usable view; safely staged-clip evaluation is still required.</p>
  </>;
}
