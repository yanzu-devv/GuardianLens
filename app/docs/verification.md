# Verification record

## Optional Twilio calling integration

All **186 automated tests passed**, followed by TypeScript and Vite build success (`index-ad3_ZQmw.js`). Calling tests use fake provider responses and signed local callback fixtures. They cover allowlisting, the published Twilio signature test vector, authenticated callback/participant/SID matching, duplicate updates, keypad acknowledgment versus connection, wrong digits/timeouts, cancellation during call creation and after archiving, restart without replay, failed persistence, uncertain delivery without retry, report provenance, and a callback-only proxy blocking private routes.

Private credentials authenticated in a read-only account request; the account was active. The user reported their console keypad test succeeded. No end-to-end GuardianLens call was placed. A check found no configured Auth Token in browser build files or incident state. Real calling remains off. A temporary callback-only Cloudflare tunnel was blocked by automatic approval review pending specific user authorization for that provider/exposure; it was not started. Kluster is unavailable. See [Twilio setup and limitations](twilio-calling.md).

## Head-only quiet-hold update

The quiet-motion gate now measures only head position and head rotation against the beginning of the quiet interval. It uses a fixed initial shoulder width for normalization, so shoulder shifting, width, and rotation do not directly reset quiet time. Shoulders still determine posture eligibility and usable framing. Head translation, angular movement, recovery, and unusable tracking retain their reset behavior.

All **168 tests passed**, including four new stationary-head/moving-shoulder cases, followed by TypeScript/Vite build success. Asset: `index-Cn1vffx_.js`. These synthetic checks do not establish live-camera accuracy. Earlier sections describe preceding rules. Kluster remains unavailable.

## Sideways head-tilt reference update

The user's attached sideways-head posture prompted an additional ear-line angle rule, relative to the shoulder line and saved calibration. A 15° change qualifies, with a 10° release threshold and the existing ten-second quiet hold. Angular movement restarts that hold; missing ear-angle evidence cannot complete a tilt-only hold or rearm its latch. Both ears must have been measured during calibration. Closed eyes are not an input.

The packaged local pose model found one pose in the supplied image, with required landmark visibility above 0.998 and an ear-line angle of about 18.3° relative to the shoulders. This single-image measurement has no recorded upright baseline or temporal evidence. The threshold was chosen to include the supplied reference range; no independent evaluation or real-camera accuracy claim is made.

All **164 automated tests passed**, and TypeScript/Vite build passed. New tests cover left/right and moderate head tilt, threshold timing, recovery, missing ears, rotation resetting quiet time, stable calibration, and aspect ratios. Frontend asset: `index-Hrxifk5Z.js`. Kluster remains unavailable.

## Latest ten-second quiet-hold update

The user requested fewer immediate prompts during writing or brief head lowering. Seated monitoring now requires a lowered or slumped posture with little head and upper-body movement for 10 continuous seconds. Movement, recovery, and any unusable tracking reset the quiet timer; rapid movement alone cannot trigger. Small landmark jitter is tolerated. A new evidence identifier prevents old seated renderers from sending the former immediate-trigger evidence to the updated server.

All **152 automated tests passed**, including the revised seated timing/geometry suite and server persistence checks, followed by TypeScript and Vite build success. The production frontend is `index-Bwewwyms.js`. The detector suite replaces old immediate-trigger assertions with quiet-hold checks; its synthetic results do not establish physical-camera accuracy. The server was restarted using the existing saved data. Camera monitoring requires a fresh page load, camera enablement, calibration, and explicit monitoring enablement. Earlier verification below describes prior behavior. Kluster remains unavailable.

Recorded October 28, 2026. This separates verified software behavior from hardware and service behavior that still needs demonstration.

## Completed automated verification

The immediate head-motion and two-stage response update passed **all 151 automated tests**, including **43 seated-detector tests** and **54 engine and seated-domain tests**, plus TypeScript checking and the Vite production build. The final build emitted `/assets/index-CN9PsHmx.js`. Local network permission was granted for this turn, so the previously restricted server tests ran successfully.

Production application is complete: the old process, PID `10949`, exited and port `8787` became free. The updated server was launched with the same saved app data. A fresh private owner dashboard was opened, and its DOM verified the fast-downward/sideways-or-lowered-head criteria plus the ten-second first question and the existing configured five-second help window. The updated backend is active. Use the new private owner link after this restart and pair phones again; no capability token is recorded in this document.

The earlier restart attempt had been blocked because the sandbox rejected stopping PID `10949` with `Operation not permitted`; that is now a historical interruption, not a remaining activation task. An older labeled example incident in simulated escalation was explicitly marked resolved to make calibration available. The camera was left off, and no new camera or location permission was granted. Physical head-motion detection remains unverified.

Before the immediate head-motion and two-stage check-in update, the relative-head-height version passed **133 tests across six non-server suites**, including **50 focused seated-detector tests**, followed by successful TypeScript checking and a Vite production build. The server suite was not rerun in that version because of the known local-listener restriction. In the preceding full-suite attempt, 16 server tests were blocked solely by the sandbox denying binding to `127.0.0.1` (`listen EPERM`). That test restriction was resolved for the latest run by the local network grant; all current tests passed.

That earlier production build emitted `/assets/index-r5FcSGX0.js`. Browser asset verification for the preceding camera fix is recorded below separately.

An earlier recorded root-agent run passed **124 tests** with `npm test`, followed by a successful `npm run build` (TypeScript checking and Vite production output). The coverage description below records that earlier run.

Coverage includes the incident state machine, server access controls and synchronization, and eight synthetic temporal-detector cases. The tests exercise cancellation, immediate help, countdown expiry, one active incident, duplicate/stale outcomes, explicit acknowledgment separate from resolution, failed contact outcomes, restart interruption, phone permission limits, consent withdrawal, and malformed WebSocket requests. Synthetic detector cases cover a rapid descent with stillness, quick sitting, bending, slow intentional lying down, starting near the floor, lost/occluded pose, stalled frames, and movement that resets the stillness interval.

These tests do not measure medical accuracy, real-world fall-detection accuracy, physical camera behavior, telephone delivery, or iPhone background delivery. No real calls were attempted.

## Source and privacy review

Camera code requests video only after consent and a user action. It sends structured health/event commands without pixels or landmarks, stores no raw video, and requests no microphone audio. Withdrawing saved consent stops capture, closes the model, and invalidates pending camera acquisition. Phone state is restricted and phone commands cannot operate the detector or contact simulator.

The installed MediaPipe `1.2.0` bundle contains a logger for `https://odml.pa.googleapis.com/v1/log`, using `fetch` for metrics. The server CSP permits same-origin connections, which excludes that endpoint. The dependency therefore attempts telemetry; runtime confirmation that the CSP blocks it is still pending. Google documents performance/utilization metrics in the [MediaPipe privacy notice](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/tasks/web/vision/README.md#privacy-notice).

Kluster tools were not available. Neither Kluster code review nor Kluster dependency validation was performed, and ordinary tests are not represented as those checks. After correcting an accidental source-only selection, the user explicitly authorized applying and building the current update without Kluster.

## Runtime and hardware checks

| Check | Status and evidence required |
| --- | --- |
| Latest immediate check-in production application | Passed: the updated backend was launched on port `8787` after the old process exited. A fresh owner dashboard displayed the new OR detection criteria and ten-second first question followed by the saved five-second help window. Existing app data was retained. Camera remained off; live camera detection was not tested. |
| Preceding camera-fix production browser assets | Historical: browser verification confirmed that the server on port `8787` served `/assets/index-B5P58jWJ.js`; a later relative-height build emitted `/assets/index-r5FcSGX0.js`. Those frontend-only changes required a renderer reload. The latest immediate check-in update also changes backend timers, so it requires restarting the server and loading the rebuilt renderer. Camera calibration and monitoring require explicit setup again. |
| Local WASM/model diagnostic | Passed in the in-app browser: local CPU/WASM model initialized and one inference completed on a blank 640 × 480 canvas, returning zero poses. Load plus inference took 303 ms in this single diagnostic run; this is not detection latency or a performance benchmark. |
| Real Mac camera and permissions | Pending. Verify allow/deny/revoke, stream disconnection, model readiness, skeleton alignment, and consent withdrawal stopping capture. |
| Native desktop shell | Launch of the official Electron binary aborted with exit code 134 and no stderr in the execution sandbox. Tray, popover, dedicated check-in window, and window hiding remain unverified. |
| Background and interruption behavior | Pending physical tests for hiding the dashboard, screen lock, sleep/lid closure, resume, quitting, and renderer termination. Confirm visible interruption and explicit recovery. |
| Paired-page browser flow | Passed on the same Mac: setup, protected pairing, example incident, and “I’m okay” on the phone response page. Cancellation appeared on the phone page and synchronized to the Mac dashboard. |
| Browser bystander and simulated contact flow | Passed: bystander assistance opened without cancelling the active check-in and displayed the configured example location and clear unknowns. “Get help now” started a simulated attempt; “Connected” still awaited acknowledgment; “Press 1” produced acknowledged/unresolved status; a separate “Mark resolved” action ended the incident. |
| iPhone response | Physical iPhone and HTTPS-tunnel checks remain pending, including both response actions, expiration/re-pairing, and loss/recovery of connectivity. Same-Mac browser results do not establish iPhone delivery. |
| Real contact calling | Not implemented. All displayed attempts and outcomes are simulated. |
| Clinical or real-world accuracy | Not established. No evaluated population, clip counts, or accuracy percentages are claimed. |

## Next evaluation steps

Use consenting participants and safely staged clips; do not ask anyone to fall unsafely. Evaluate collapse-like movement, quick sitting, bending, intentional lying down, leaving the camera view, occlusion, and camera disconnection. Use different recordings for tuning and evaluation, document camera/room conditions, and keep example incident data separate from actual detector results.

Record true positives, missed events, false alerts, and ordinary-activity counts by scenario. Measure detection-to-check-in latency and, when real calls are implemented, acknowledgment success and timing. Repeat cancellation during a pending call, wrong-digit/voicemail/no-answer behavior, duplicate callbacks, network interruption, and disk-write failure. Keep a clearly labeled backup demonstration recording.

Bystander wording is predefined and linked to the [American Red Cross](https://www.redcross.org/take-a-class/resources/learn-first-aid/unresponsive-and-breathing-person). No LLM generates treatment advice. Emergency dialing remains disabled throughout testing.


## Location and history update

The October 28 update adds owner-only device-location commands and frozen per-incident locations. Tests cover invalid or old fixes, provider failure, manual-mode cleanup, gradual device movement, restart behavior, report provenance, and withholding live location and human accounts from paired phones. Four report-export tests ensure example labeling, unknown legacy locations, source attribution, and uncertainty survive download. All 78 tests passed; TypeScript and the production build passed.

Chrome checks confirmed the revised sidebar, response-window explanations, saving device-location mode without starting location access, and the separate example history preview with zero recorded incidents. Physical location permission was not granted or requested by loading/saving the preference. Real location acquisition and native desktop geolocation remain unverified. Device location is an estimate, and carrying the laptop still requires pausing and repositioning the camera.

The history’s optional person/witness/caregiver account is recorded separately from camera observations. It is not clinically verified and does not change response status. Its structure is informed by [NICE CG109](https://www.nice.org.uk/guidance/cg109/chapter/Recommendations); no clinician review or medical validation is claimed.


## Seated monitoring update

Before the relative-head-height update, an earlier build passed 134 automated tests and TypeScript/Vite build verification, including 33 synthetic seated-detector tests, readiness/calibration and mode/evidence gates, camera-recovery safeguards, and history mode provenance. The next relative-head-height version passed 133 tests across six non-server suites, including 50 focused seated-detector tests, and TypeScript/Vite build verification; the server-suite limitation is recorded above. These historical runs do not validate the latest immediate head-motion behavior. The experimental rules do not establish real-world or medical accuracy. An intentional nod, quick sideways head movement, deep reading posture, or shoulder shrug can also trigger a check-in.

The camera interface separates model readiness, partial upper-body coverage, calibration, and active monitoring. Head plus both shoulders are required; hips are not read by the seated detector. Missing or unusable poses cannot contribute valid-frame confirmation or velocity evidence. The reference is retained while camera frames continue, so returning restores coverage without manual recalibration. A camera/frame interruption, substantially changed framing, a changed video aspect ratio, camera restart, or significant device movement still invalidates calibration. A stopped or warming-up camera pauses monitoring; recovery cannot silently enable it. A local stop control remains available when the server connection is lost.

The latest detector compares current head height relative to the shoulder midpoint, divided by current shoulder width, with the calibrated ratio. Fast downward or sideways head velocity, or a lowered position of at least 0.25 shoulder widths from baseline, can start the check-in after brief valid-frame confirmation. There is no two- or five-second quiet gate. Rapid motion requires two same-direction supporting current frames, each supported by two qualifying historical anchors at ordinary processing rates or one anchor when frame spacing exceeds 350 milliseconds. Live measurements expose current and calibrated head position, lowering, recent motion speed, and frame confirmation. The 43 passing detector tests cover eligible motion and position changes, confirmation, ordinary activity and shrug ambiguity, scale and aspect-ratio geometry, recovery, episode latching, tracking loss, and nose/ear fallback.

The response now begins with **Are you okay?** for ten seconds. With no response, the same incident advances to **Do you need help?** for the configured check-in duration; only expiration of that second window starts the simulated contact plan. Cancellation, immediate help, stale/duplicate commands, and restart handling are covered by automated verification; the complete physical response demonstration remains separate. The backend restart and fresh dashboard load needed to activate this change are complete. No five-minute inactivity detector is implemented.

Automatic device location resumes with an existing permission grant or an earlier explicit automatic-location choice, uses the browser permission gate, requests a fresh fix every 30 seconds, and respects Stop location across dashboard windows in the same browser. Physical detection accuracy and automatic-location provider behavior still require live verification.

Chrome live verification obtained a fresh position with reported ±35 m accuracy after browser permission, then resumed automatic updates after reload without pressing the location button. The in-app browser timed out while obtaining its own position; Chrome supplied the shared live position. Browser verification confirms acquisition and reload resumption in this session, not future provider availability. The revised seated rules have not yet been evaluated with a live staged slump.

Chrome confirmed the seated default, framing instructions, disabled calibration/enable controls while the camera is off, and switching to the optional full-body mode and back. The camera was left off after refresh; no new physical camera or location permission was requested during this verification. Live seated calibration, real staged-clip detection, false-alert counts, and detection latency remain to be tested with consenting participants.

## Brief head-motion timing correction

The latest correction passed all 46 detector tests and TypeScript/Vite production checks. New cases cover short downward/left/right movements that stop before the confirming frame. Existing spike-rejection, body-translation, tracking-gap, and head-lowering cases remain passing. This is synthetic verification; camera accuracy remains unmeasured. Refresh and recalibrate to load the new frontend.
