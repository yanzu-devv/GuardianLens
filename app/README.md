> Calling update: optional Twilio contact calling is now implemented. Simulation remains the default until local credentials and an approved HTTPS callback connection are configured. Earlier verification entries below describe earlier versions. See [Twilio calling](docs/twilio-calling.md).

# GuardianLens

**When you can’t call for help, your room can.**

GuardianLens is a working hackathon prototype for one consenting adult and one fixed camera view. You can use device-reported location when moving the laptop between places, or keep a manual address. Pause monitoring before carrying the laptop, then set it down and check the camera view before resuming. It combines local body-pose estimation with experimental movement rules, then runs an explicit check-in and simulated contact plan. Contact calls default to simulation. Optional Twilio demo calling is implemented behind private server configuration; emergency-service dialing remains disabled. See [Twilio setup and verification](docs/twilio-calling.md).

The interface uses the agreed matte-black and electric-lime palette and a consistent protective-lens symbol. The earlier generated concept images were unavailable; no generated image is presented as a functioning camera view.

## Run it on your Mac

Use Node.js **24 or newer**. Run these commands from the GuardianLens project folder:

```sh
npm ci --ignore-scripts
npm run prepare:models
npm run prepare:desktop
npm run build
npm run desktop
```

The preparation commands download the local pose model/runtime assets and the Electron runtime. The desktop command starts the local backend and opens the Mac app with a menu-bar icon. Keep its terminal process running. This is a development application, not a signed, packaged macOS release.

For a browser-only preview, run `npm start` after building and open the **private Mac dashboard** link printed in the terminal. Stop the desktop process before starting the browser server; both use port `8787` by default. `npm run dev` is available for local UI development, but must not be exposed through a public tunnel.

The seated detector now requires a lowered or slumped head posture with little head movement for **10 continuous seconds** before opening the first question. Movement, returning upright, or unusable tracking restarts the quiet timer; fast motion alone cannot trigger. This detection timer is separate from the ten-second **Are you okay?** response window. After updating, restart the server, open its fresh private dashboard link, enable the camera, recalibrate, and enable monitoring again. Pair phones again after a restart.

The updated local server has now been restarted with the existing saved app data, and the two-stage backend is active. A fresh private dashboard was opened and checked for the new head-motion criteria and response timing. Use the fresh owner link after the restart and pair the phone again if needed. The camera remains off; enable it, calibrate, and explicitly enable monitoring when ready.

Node 24 loads private `.env` settings automatically for the start, desktop, and callbacks commands. See `.env.example` and the Twilio calling guide.

## First use

1. Open **Response plan**. Name the monitoring device, choose device location or a manual address, explicitly choose camera-monitoring consent, and mark at least one demo contact as opted in. Contact names are used for simulation; no phone numbers or Twilio credentials are needed. Save the plan before starting device location.
2. Save the plan. Consent defaults to **off**, and no camera is opened automatically.
3. To try the real camera path, click **Enable camera** and accept the operating-system/browser permission request. Choose **Seated · desk and laptop**, keep your head and both shoulders visible, and select **Calibrate seated position**. Hold your usual seated posture still for about two seconds. Then select **Enable seated monitoring**. Keep the laptop fixed; legs and hips are not required in seated mode.
4. To test the response loop without camera input, use the clearly labeled **example incident** control. Its observations are example data, not a camera detection.
5. The first prompt asks **Are you okay?**. Try **I’m okay** or **Get help now**. With no response for ten seconds, a second prompt asks **Do you need help?**; its unanswered demo window then starts the simulated contact plan. The call simulator supports connected, explicit acknowledgment, voicemail, rejection, timeout, wrong-digit, and network-failure outcomes.
6. Open **I’m here to help** for the bystander handoff. Opening it leaves the contact plan running.

The first **Are you okay?** response window lasts ten seconds. With no response, **Do you need help?** starts a separate window using the configured **Time to answer “Do you need help?”** setting. “I’m okay” cancels either stage; “Get help now” starts the simulated contact plan immediately. No response at the end of the second window also starts that plan. **Wait for contact acknowledgment** is the maximum wait for one simulated contact to press 1. These are demo settings, not medically validated response intervals; an actual emergency must not wait for the app.

## Device location and incident records

Choose **Use device location** to request browser/system location permission. Once permission is granted, location resumes automatically when this dashboard opens or reconnects, with a fresh fix requested every 30 seconds. Stop location disables automatic resumption in this browser until you enable it again. The app displays coordinates, estimated accuracy, and the time reported by the device. Browsers may use GPS or network-based positioning; GuardianLens does not verify a GPS sensor or an exact address. Indoor room, floor, and unit details cannot be inferred from coordinates. A position older than two minutes is labeled stale; the two-minute threshold is an application rule. A provider failure remains visible even if a last position exists. Manual location remains available. See the [W3C geolocation specification](https://www.w3.org/TR/geolocation/).

Location consent is separate from camera consent. Enabling it sends coordinates to the GuardianLens server. Each incident freezes the location available at detection; later laptop movement or plan edits cannot rewrite the historical location. Stopping clears the current shared fix, while past incident snapshots remain. An idle paired phone does not receive a continuous location feed; it can receive the location captured for its active incident. Restarting the server clears live location; an open dashboard with permission and automatic updates enabled can resume sharing after reconnecting. Location availability does not establish that monitoring is active, and missing location does not block incident response.

**Incident history** offers an explicitly labeled example record without triggering an incident. Actual records include detection time/source, location at detection, measured observations, check-in and contact outcomes, unknowns, and a separate optional person/witness/caregiver account. Downloading the text report is an explicit local action. Account entries are reported statements, not camera-verified findings; they do not resolve an incident or establish injuries, loss of consciousness, or a diagnosis. Legacy records without a captured location remain unknown rather than using today’s address.

The account structure is informed by NICE’s guidance on documenting circumstances and descriptions before, during, and after a suspected blackout; it does not mean GuardianLens has established a blackout or received clinical validation. [NICE CG109 recommendations](https://www.nice.org.uk/guidance/cg109/chapter/Recommendations).

Only one incident can remain active. **Answered**, **acknowledged**, and **resolved** are separate states. Acknowledgment does not establish that help has arrived. An unanswered app check-in does not establish unconsciousness. If nobody acknowledges, the final emergency-service escalation is visibly simulated, with actual dialing disabled. See the [incident state machine and acceptance criteria](docs/incident-state-machine.md).

## Camera behavior and limitations

The camera component loads the pretrained MediaPipe Pose Landmarker from local assets. Seated mode requires an explicit stable head-and-shoulders reference. A head lowered at least 0.25 shoulder widths from calibration, close to the shoulder line with a relative drop, leaning sideways at least 0.35 shoulder widths, or sideways head tilt of at least 15° relative to the calibrated shoulder/head angle can start a quiet timer. Tilt measurement requires both ears during calibration and tracking. The posture must remain with little head movement for 10 continuous seconds before **Are you okay?** appears. Movement, recovery, or unusable tracking restarts the timer; fast head movement alone cannot trigger. Small landmark jitter is tolerated. Live measurements show head position, lowering, recent speeds, and quiet-hold progress. Shoulder tilt alone is not a trigger. Full-body mode keeps its separate rules. See [seated mode setup and limitations](docs/seated-mode.md).

These are **unvalidated image-coordinate thresholds**. Seated calibration captures image geometry, not medical health or consciousness. A low position in full-body mode is not a measured floor height. Shallow reading below the threshold is ignored, but a deep intentional bow, prolonged deeper reading posture, or shoulder shrug can prompt a check-in. Onset speed does not determine intent. Camera placement, lighting, occlusion, furniture, and different body positions can change the result. The software identifies a **possible collapse**; it does not diagnose fainting, stroke, cardiac arrest, unconsciousness, or breathing. Synthetic tests do not establish real-world or clinical accuracy.

In a browser, keep the monitoring tab visible; hiding it interrupts monitoring. In Electron, the dashboard is designed to keep its camera renderer running when the window or quick-access panel is hidden. Sleep, screen lock, quitting, camera loss, or a missing processing heartbeat mark monitoring as interrupted. Physical camera behavior while hiding windows, locking, sleeping, and resuming still needs testing on your Mac. Recheck the camera and explicitly resume monitoring after an interruption.

## Pair your iPhone

**A `127.0.0.1` or `localhost` link points to the device opening it.** A default local pairing link works for a second browser session on the Mac, but cannot reach the Mac from your iPhone.

For an iPhone demo, install and authenticate [ngrok](https://ngrok.com/docs/share-localhost/), then run one HTTPS tunnel in a separate terminal:

```sh
ngrok http 8787
```

Copy the assigned HTTPS origin, stop the running GuardianLens process, and restart the **built** application with that origin:

```sh
PUBLIC_ORIGIN='https://YOUR-ASSIGNED-DOMAIN' npm run desktop
```

You can use `npm start` instead of `npm run desktop` for a browser host. Keep the tunnel and GuardianLens processes running. Do not tunnel `npm run dev`; the server rejects a public origin in development mode. The backend stays bound to loopback and accepts the configured public host/origin. Rebuild after source changes before restarting the production preview.

Inside the private Mac dashboard, create a new protected phone link and open **that phone link** on the iPhone. Keep the owner link private. Phone links expire after 30 minutes; creating another link revokes the previous one. The phone can respond to the active incident and receives a limited state projection. It cannot change the plan, trigger incidents, simulate caregiver outcomes, or resolve incidents.

The page synchronizes through WebSockets while connected. It does not implement native iPhone notifications or guarantee background, lock-screen, push, or message delivery. Actual iPhone and HTTPS-tunnel behavior remains to be tested.

## Privacy and access

- Camera frames and landmarks are processed in the renderer and are not sent to the backend. Only structured health and incident commands leave the camera component. This build records no raw video, microphone audio, or calls; microphone access is disabled.
- MediaPipe `1.2.0` contains a performance-metrics logger that attempts requests to `odml.pa.googleapis.com/v1/log`. The application’s restrictive `connect-src 'self'` content security policy blocks that external endpoint. Do not describe the dependency as making no telemetry attempts. See Google’s [MediaPipe privacy notice](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/tasks/web/vision/README.md#privacy-notice).
- The server prints a random owner capability link. Its token is in a URL **fragment**, not a query string. The browser removes the fragment and keeps the token in `sessionStorage`; API requests use authorization headers and WebSocket authentication uses subprotocols. Anyone holding a valid capability can use its allowed controls.
- Restarting the server rotates owner and phone access. Create fresh links after a restart. An existing camera session cannot silently resume protection.
- Configuration and the event log are saved in local `data/state.json`; the directory is created with mode `0700` and state files with mode `0600`. These are filesystem permissions, not encryption. Recent incident history is limited to 20 archived incidents.
- Connection and disk-write failures are visible. A server restart during a check-in or simulated call stops timed actions and records interrupted simulated escalation; it does not replay contact calls.
- A public tunnel carries phone event/response traffic through the tunnel provider. It does not expose a camera-stream endpoint or an unauthenticated dashboard API. Static UI/model assets remain publicly retrievable through that tunnel.

Withdrawing saved monitoring consent stops active camera capture and releases the pose model. Pausing monitoring disables detection; the camera preview can remain on until **Stop camera** is selected.

## Verify and continue

```sh
npm test
npm run build
```

The immediate head-motion and two-stage response update passed **all 151 automated tests**, including **43 seated-detector tests** and **54 engine and seated-domain tests**, plus TypeScript checking and the Vite production build. Local network permission allowed the server tests to run successfully; the 16 tests blocked by an earlier sandbox restriction are no longer blocked in this verification. That build emitted `/assets/index-CN9PsHmx.js`. The updated backend has been restarted and the fresh dashboard checked. See [verification results](docs/verification.md).

Earlier verification passed 124 tests and a production build. In that earlier work, a browser diagnostic initialized the local CPU/WASM pose model and completed one inference on a blank canvas in **303 ms**, returning zero poses. Browser checks verified protected phone cancellation and synchronization on the same Mac, bystander assistance leaving a check-in active, and simulated help → connected → explicit acknowledgment → separate resolution. These results do not verify a physical camera or iPhone. Native Electron launch aborted in the execution sandbox, so native behavior remains unverified. See [verification results and the next manual checks](docs/verification.md).

Next, evaluate safely staged recordings with consenting participants. Keep threshold-tuning clips separate from evaluation clips, record actual counts for collapse and ordinary-activity cases, and measure detection-to-check-in latency. The new seated mode still needs physical calibration and safely staged seated-clip evaluation. Twilio demo calling now has server-held credentials, verified callbacks, provider call IDs, explicit keypad acknowledgment, cancellation handling, and automated failure tests. Complete the callback connection and an end-to-end demo call using [the setup guide](docs/twilio-calling.md). Actual emergency dialing must remain disabled during development and demonstrations.

Kluster tools were unavailable during implementation, so required Kluster review and dependency-validation checks could not run. After correcting an accidental source-only selection, the user explicitly authorized applying and building this update without Kluster. The ordinary tests above are separate checks and do not substitute for Kluster verification.

## Reference material

- [MediaPipe Pose Landmarker for Web](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker/web_js) — pretrained perception and local model loading.
- [Electron Tray](https://www.electronjs.org/docs/latest/api/tray) and [powerMonitor](https://www.electronjs.org/docs/latest/api/power-monitor) — menu-bar and interruption APIs.
- [ngrok: share localhost](https://ngrok.com/docs/share-localhost/) — HTTPS access for the phone demonstration.
- [American Red Cross: unresponsive and breathing person](https://www.redcross.org/take-a-class/resources/learn-first-aid/unresponsive-and-breathing-person) — the predefined bystander guidance source. A real unresponsive person or abnormal breathing requires immediate emergency action, rather than waiting through the simulated contact plan.
- [Twilio Gather](https://www.twilio.com/docs/voice/twiml/gather) and [webhook security](https://www.twilio.com/docs/usage/webhooks/webhooks-security) — references for the future real-call integration.
