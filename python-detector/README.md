# GuardianLens: local fall and slump detector

A small webcam module for a hackathon: one fixed camera, one consenting person, one room. The default seated mode compares your head and shoulders with a saved normal seated posture; hips and legs are not required. Pretrained MediaPipe Pose supplies landmarks and readable temporal rules emit possible-event callbacks. A separate local check-in subscriber asks “Are you okay?” on screen or in the console. There is no training, phone calling, or emergency-contact escalation.

This is an experimental posture/movement detector. Its rules do not establish a medical diagnosis or validated fall-detection accuracy. A deliberate deep bend or prolonged unusual posture can resemble an event.

## Setup

Use **Python 3.10–3.12**, preferably 3.12. The pinned MediaPipe release supplies the requested legacy `mp.solutions.pose.Pose` API; its published wheels do not support Python 3.13/3.14. Keep this project in its own environment.

```bash
cd python-detector
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python test_synthetic.py
python -m unittest test_synthetic test_runtime test_seated -v
```

On Windows, activate with `.venv\Scripts\activate` instead. On macOS, allow camera access for the terminal or Python application when asked. Stop other apps that are using the same camera.

The requirements use `opencv-contrib-python`, which includes the same `cv2` API as `opencv-python` and is required by MediaPipe. **Do not install both OpenCV distributions in this environment:** they provide the same `cv2` package. NumPy and MediaPipe are pinned to compatible versions.

Package installation needs internet access. After installation, processing runs locally. The detector uses model complexity **1** and checks that the bundled models exist before starting. It does not fetch missing models. Complexity 0/2 is deliberately rejected because this legacy SDK can download those models on initialization. See the [MediaPipe package release](https://pypi.org/project/mediapipe/0.10.21/) and [official Pose implementation](https://github.com/google-ai-edge/mediapipe/blob/v0.10.21/mediapipe/python/solutions/pose.py).

## Run

```bash
# Webcam 0, seated mode; q closes the window and releases the camera.
python main.py

# Optional wider view with the original shoulder/hip fall rules.
python main.py --mode full_body

# Another webcam.
python main.py --camera 1

# Existing local recorded clip; no output video is created.
python main.py --video /path/to/consenting-demo.mp4

# Live feature overlay and a new, features-only CSV.
python main.py --debug --csv features-session.csv

# Headless evaluation. Ctrl+C stops a webcam run; clips stop at EOF.
python main.py --video /path/to/demo.mp4 --debug --no-display

# Supply the actual frame rate when a clip's metadata is missing/incorrect.
python main.py --video /path/to/demo.mp4 --fps 30 --no-display

python main.py --help
```

In the camera window, **O** records “I’m okay” and dismisses an active check-in; **H** records a help request. No help is dispatched and no contacts are configured by this module. In `--no-display` mode the question is printed without waiting for terminal input; a host application can call `CheckInPrompt.respond()` through its own interface.

`--video` accepts an existing local regular file, not a URL or network stream. Clip timers use frame index divided by source FPS, rather than processing speed, so a fast headless run does not shorten the hold windows. Use constant-frame-rate clips; variable-frame-rate files need conversion before evaluation. The detector rejects long frame gaps rather than counting unobserved time as continuous evidence.

Without `--debug`, no feature CSV is opened. With `--debug`, the default filename is `features-<UTC timestamp>.csv`; `--csv` chooses another new path. Existing files are never overwritten, and the output cannot be the input clip. Rows contain derived features, source times, visibility, state, hold progress, and event type. They contain no images or video frames.

Local clips use OpenCV’s FFmpeg backend with only file/data/crypto protocols allowed. A local playlist cannot fetch remote media. This requires an FFmpeg-enabled OpenCV build. See [OpenCV capture options](https://github.com/opencv/opencv/wiki/Video-IO-hardware-acceleration#environment-variables) and [FFmpeg protocols](https://www.ffmpeg.org/ffmpeg-protocols.html#Protocol-Options).

## Seated mode: hips are not required

Sit normally with both shoulders visible; include your nose to enable the forward/head-drop checks. The detector collects about one second of stable upper-body geometry as its seated reference. It then compares the observed posture with that reference:

- A shoulder line tilted roughly 25° from its saved direction can indicate a sideways collapse or lean.
- A changed head-to-shoulder direction or a head drop relative to the shoulders can indicate a forward slump.
- A substantial downward shoulder displacement can also prompt a check.
- If a qualifying change remains for about two seconds, the detector emits **POSSIBLE_FALL** and the separate check-in subscriber asks **“Are you okay?”**. It does not require a rapid drop or a long stillness interval.

Returning to the normal posture before the hold completes cancels the candidate. The 30-second cooldown suppresses repeated events. Missing or low-confidence required shoulder observations clear pending evidence; time outside view never completes a hold. The shoulder-tilt/drop checks can run without the nose. A forward/head-drop check additionally needs a visible nose and a nose position saved in the initial reference. If the nose was absent during reference capture, reset/restart with it visible to enable that branch. A saved reference is not an identification of the person or a diagnosis.

A shoulder line measures **shoulder tilt**, not torso angle from vertical. Forward slumping can leave the shoulder line level, so the head position relative to the shoulders is also used. Shoulder-only rules cannot reliably determine whether someone fell, fainted, or deliberately leaned, and events outside the usable view can be missed. The UI and event call this a possible fall/posture change and ask the person first. Internally, the existing CONFIRMED_FALL state means the rule completed; in seated mode its event type remains POSSIBLE_FALL and the display says “Check-in requested.”

In seated mode, hip height/drop and full-torso angle are unavailable rather than invented. Debug output leaves them empty. The visible overlay shows shoulder tilt and hold progress.

## Optional full-body mode

Choose `--mode full_body` when the camera includes shoulders **11/12** and hips **23/24**. This retains the original wider-view rules:

- **NORMAL:** collecting usable observations; no pending event.
- **POSSIBLE_FALL:** hip drop greater than 0.15 within about 0.5 seconds, or torso angle above 60°, starts a possible-fall check while the body is not upright. It must remain down without recovery to upright for 4 seconds before a FALL event.
- **CONFIRMED_FALL:** the full-body rule completed and one FALL event was emitted. This is a rule result, not confirmation of a medical emergency.
- **SLUMP:** torso angle reaches the slump threshold or the head drops relative to its initial upright reference. Little movement must persist for 8 seconds before a SLUMP event. `confirmed` and `event` distinguish an emitted event from a pending check.

Full-body torso angle uses shoulder/hip midpoints and the actual image aspect ratio: 0° is upright and 90° horizontal. Hip height is normalized image y, increasing downward. Bounding-box aspect ratio uses visible landmarks in image dimensions. Motion is maximum normalized displacement within the motion window, not velocity.

An event’s confidence is the visibility quality of the landmarks used for that mode, not the probability of a fall or medical emergency. Deliberate leaning or prolonged bending can still prompt a check. Evaluate false alerts and missed events with representative, safely staged clips.

## Configuration and tuning

Example presets are provided in `config.example.json` (seated) and `config.full-body.example.json` (wider view). All detection thresholds live in the `DetectorConfig` dataclass in [config.py](config.py). Optional JSON overrides avoid a YAML dependency. For example, save this as `tuning.json`:

```json
{
  "mode": "seated",
  "seated_tilt_angle": 25.0,
  "seated_head_angle": 25.0,
  "seated_head_drop": 0.30,
  "seated_shoulder_drop": 0.35,
  "seated_hold_seconds": 2.0,
  "cooldown_seconds": 30.0
}
```

```bash
python main.py --config tuning.json --video /path/to/demo.mp4 --debug
```

Seated defaults:

| Parameter | Default | Effect |
| --- | ---: | --- |
| `seated_calibration_seconds` | 1 s | Initial stable reference capture |
| `seated_min_samples` | 5 | Minimum reference observations |
| `seated_calibration_motion` | 0.06 shoulder widths | Maximum reference-capture movement |
| `seated_calibration_tilt` | 5° | Maximum shoulder rotation while capturing a reference |
| `seated_tilt_angle` | 25° | Shoulder-line angle change |
| `seated_head_angle` | 25° | Head-to-shoulder direction change |
| `seated_head_drop` | 0.30 shoulder widths | Head drop relative to the shoulders |
| `seated_shoulder_drop` | 0.35 shoulder widths | Downward shoulder displacement |
| `seated_hold_seconds` | 2 s | Continuous abnormal-posture hold |
| `seated_min_shoulder_width` | 0.06 image width | Minimum usable shoulder span |

The following table lists retained **full-body** thresholds and shared tracking/cooldown values. Hip and torso thresholds are not used in seated mode.

Useful defaults:

| Parameter | Default | Effect |
| --- | ---: | --- |
| `visibility_threshold` | 0.60 | Minimum required landmark quality |
| `hip_drop_window` | 0.5 s | Rolling interval for rapid hip descent |
| `hip_drop_threshold` | 0.15 | Required normalized descent |
| `fall_angle` | 60° | Absolute fall-candidate angle |
| `upright_angle` | 25° | Recovery/upright boundary |
| `fall_hold_seconds` | 4 s | Continuous down-state confirmation |
| `slump_angle` | 35° | Torso slump boundary |
| `head_drop_threshold` | 0.10 | Nose/shoulder-gap increase |
| `slump_hold_seconds` | 8 s | Continuous quiet slump confirmation |
| `motion_window` | 0.5 s | Motion measurement window |
| `max_slump_motion` | 0.025 | Maximum quiet movement |
| `baseline_seconds` | 0.75 s | Initial stable upright reference |
| `cooldown_seconds` | 30 s | Event suppression after an alert |
| `max_frame_gap` | 0.6 s | Maximum continuous observation gap |

Start with normal standing/sitting, a brief bend, picking something up, temporary occlusion, and a safe staged fall/slump clip. Inspect feature CSVs to understand which condition fired before changing one threshold at a time. Keep tuning clips separate from evaluation clips. Synthetic checks validate rule timing and transitions; they do not establish webcam detection accuracy.

## Use events in another application

```python
from config import DetectorConfig
from detector import FallDetector
from check_in import CheckInPrompt

def handle_event(event):
    # Connect a separate prompt/contact system here.
    print(event.type.value, event.timestamp, event.confidence)

with FallDetector(DetectorConfig()) as detector:
    detector.on_event(handle_event)
    prompt = CheckInPrompt()
    detector.on_event(prompt.on_event)
    # Inside your existing capture loop:
    # result = detector.process_frame(frame)  # in-memory OpenCV BGR frame
```

`FallEvent` contains a UTC timestamp, type, visibility-based confidence, source time, and available posture evidence. Seated events have shoulder tilt and no full-torso angle. The detector itself does not implement the question or downstream response workflow. `DetectionResult` contains current state, features, keypoints, hold progress, cooldown remaining, confirmation status, and any event emitted for that frame. The detector owns its rolling buffers and state machine; the callback owns any downstream response workflow.

Files: [check_in.py](check_in.py), [detector.py](detector.py), [events.py](events.py), [config.py](config.py), [main.py](main.py), and [test_synthetic.py](test_synthetic.py).

## Privacy

No code path writes frames or video, and there is no recorder, network client, telemetry integration, or alerting service. Input clips are only read. Display images and rolling keypoints/features stay in memory; `--no-display` avoids GUI calls. Only `--debug` opens feature logs. Events and the local check-in question/response are printed to the console whether or not debug logging is enabled. Other software receiving callbacks is responsible for its own privacy behavior.


## Reuse your local environment

After completing Setup above, run these commands from `python-detector/` in a new terminal:

```bash
source .venv/bin/activate
python main.py
python main.py --debug --no-display
python -m unittest test_synthetic test_runtime test_seated -v
```

Create the local `.venv` using Setup when copying this project to another machine. On Windows, use the activation command in Setup.

## Verification and platform limits

All **50 synthetic and integration-contract tests passed** in the prepared Python 3.12 environment. Run them with the command above. Integration tests use in-memory frames with injected Pose/capture results; they do not measure model detection accuracy. Tests verify recovery, hold windows, cooldown, frame conversion, source timing, headless GUI avoidance, protocol restrictions, and features-only CSV behavior.

Actual MediaPipe startup was attempted using in-memory blank frames and Python socket/URL entry points blocked. It failed before inference with `Could not create an NSOpenGLPixelFormat` in this restricted macOS execution session. No webcam was opened and no frames were saved. **Live pretrained-model/webcam inference remains unverified here.** The application reports this failure clearly. Running in an ordinary logged-in macOS Terminal is a next verification step, not a guaranteed fix.

`--no-display` prevents this application's OpenCV window calls. The legacy macOS MediaPipe wheel may still initialize an OpenGL service internally; it is not equivalent to a CPU-only SDK build. There is no supported runtime `MEDIAPIPE_DISABLE_GPU` environment switch in this Python API. See the [GPU-service declaration](https://github.com/google-ai-edge/mediapipe/blob/v0.10.21/mediapipe/calculators/tensor/image_to_tensor_calculator.cc) and [default-service initialization](https://github.com/google-ai-edge/mediapipe/blob/v0.10.21/mediapipe/framework/calculator_graph.h).

On this Apple Silicon environment, `pip check` also reports that MediaPipe 0.10.21 is unsupported because the universal-wheel package contains an x86_64 WHEEL tag. This is an [upstream wheel-metadata issue](https://github.com/google-ai-edge/mediapipe/issues/6112); dependency installation and imports succeeded. No installed package metadata was modified.

Reset the detector or restart the session after repositioning the camera. The saved seated reference deliberately does not follow a slowly changing posture. Seated mode needs both shoulders, with the nose enabling forward/head-drop checks; full-body mode additionally needs hips. The current implementation remains separate from the running browser demo.
