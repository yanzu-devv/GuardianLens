# Seated desk and laptop mode

GuardianLens has a seated detector for someone working at a desk or laptop. It uses local pose landmarks and an explicitly captured seated reference to measure head position and motion relative to the shoulders. A lowered, sideways-tilted, or slumped head posture with little head movement for **10 continuous seconds** starts an **Are you okay?** prompt. Fast movement alone does not trigger it. Hips, legs, and the floor do not need to be visible.

The output is a **possible seated slump** and a check-in. It does not establish fainting, loss of consciousness, abnormal breathing, or the cause of a posture change. Eye closure and blinking are not inputs to this detector.

## Start a seated session

1. Complete the response plan, grant monitoring consent, and save at least one opted-in demonstration contact. Choose device location or a manually entered address. Contact calls remain simulated.
2. Put the laptop on a stable surface. Select **Seated · desk and laptop** in the camera card.
3. Choose **Enable camera** and allow camera access. Wait for the local pose model to finish loading.
4. Sit in your usual comfortable posture. Include your whole head and both shoulders, with space around them. Keep your face clear of your hands or arms. The camera should not be so close that a shoulder or your head touches the frame edge.
5. Choose **Calibrate seated position**. Hold that posture still for about two seconds while the progress indicator completes. Movement or an incomplete view restarts or interrupts the capture; follow the displayed framing message.
6. Wait for **Seated reference ready**, then choose **Enable seated monitoring**. Calibration does not turn monitoring on automatically.
7. Confirm that the dashboard says **Monitoring active**, the seated reference is calibrated, and head and shoulder tracking is ready. A live camera preview alone is not active monitoring.

You can remain seated throughout setup. Standing up to show your hips is only relevant to the separate full-body mode.

## A live preview, partial tracking, and paused monitoring are different

A close-up with an arm across the face can show a person in the preview while the required head landmarks are obscured. The detector reports partial tracking and blocks new seated detections while that view is unusable. Lower the arm, leave a little more space around your head and shoulders, and capture a fresh seated reference if requested.

**Monitoring paused** is a separate control state. Improving the framing does not enable monitoring. After the camera view and calibration are ready, explicitly choose **Enable seated monitoring**.

## What the implemented rules check

The pretrained pose model estimates body landmarks. `src/shared/seatedDetector.ts` then applies explicit movement rules; this is AI perception with rule-based event detection, not a medical classifier.

- The required view contains both shoulders and a usable head position from the nose or both ears. Landmark visibility, frame margins, shoulder width, and detected hand or arm occlusion are checked before movement evidence is accepted.
- A stable, approximately upright reference is collected only after the user requests calibration. The head-to-shoulder ratio is `(head_y - shoulder_midpoint_y) / current_shoulder_width`. Negative values put the head above the shoulder midpoint; positive values put it below. The calibrated ratio uses the reference's own width, and head lowering is the current ratio minus that calibrated ratio. Geometry uses the video's actual aspect ratio so the axes have consistent units. Uniform changes in scale do not change this ratio within the accepted framing limits.
- A head-lowering change of at least 0.25 shoulder widths, a head ratio of at least -0.15 with at least 0.1 lowering, or a sideways head displacement of at least 0.35 shoulder widths from calibration starts a candidate posture. Release thresholds provide hysteresis while the posture is held.
- Sideways head tilt also qualifies when the line between both ears changes by at least 15° relative to the shoulder line and calibrated angle (10° release threshold). Both ears must be reliably measured during calibration and current tracking; otherwise the angle is unavailable. Other head-position rules remain available. Eye closure is not used.
- Quiet time also checks head rotation. A head-angle change beyond 0.08 radians (about 4.6°) from the quiet interval's start restarts it. Missing ear-angle evidence resets a tilt-only hold and cannot rearm a completed tilted episode without observed recovery.
- The posture must stay with little head movement for 10 continuous seconds. The quiet timer compares only head position and head rotation with the start of that quiet interval. Head translation beyond 0.05 shoulder widths (using the fixed width at the interval start) or head rotation beyond 0.08 radians restarts the timer. Shoulder movement alone does not restart it; shoulders still determine posture and tracking readiness. Comparing with the interval's anchor also catches slow cumulative motion; small landmark jitter is tolerated.
- Fast downward or sideways motion is displayed as a measurement only. It cannot bypass the quiet timer. Returning upright or losing usable tracking resets the pending hold. Shoulder tilt alone does not start it.
- A completed episode stays latched through cancellation and tracking loss. A new prompt requires a usable return to the calibrated head position and a new qualifying quiet posture.
- Live measurements show current and calibrated relative head position, lowering, recent speed, and **Quiet hold: 0.0 / 10.0 s**. The ten-second quiet hold comes before the question and is separate from its response countdown.
- The detector prefers the nose and uses a nose-to-ear offset measured during calibration when paired ears provide a fallback. If that offset was not captured, an alternate head source pauses detection until the original landmarks return rather than inventing movement.

Disappearing from view alone does not create an incident. Brief head-down writing, nodding, or a fast slump followed by recovery before ten quiet seconds does not prompt. A deep intentional reading posture or a shoulder shrug held sufficiently still for ten seconds can still prompt; the detector cannot determine intent. Confident but incorrect pose estimates can also defeat framing guards. Use **I’m okay** to cancel an unwanted check-in.

## Two-stage response

An eligible posture starts **Are you okay?** only after its ten-second quiet hold. If the app receives no response for ten seconds, it asks **Do you need help?** and starts a second response window using the configured check-in duration. No response when that second window expires starts the existing simulated contact workflow. **I’m okay** cancels either stage; **Get help now** skips the remaining response time and starts that workflow immediately.

No response means only that the app did not receive a response. It does not establish unconsciousness, fainting, or a need for a particular treatment. No five-minute inactivity check is implemented.

## When a fresh calibration is needed

Unusable tracking resets the pending quiet hold and pauses movement checks but preserves the seated reference while camera frames continue arriving. Missing or unusable frames never count as quiet time; any dropout clears the pending hold and recent velocity history. No event is emitted while the required pose is unusable. Returning to a usable view resumes checks against the original reference without another calibration. Substantially changed shoulder scale or a changed video aspect ratio invalidates the reference. A frame gap over 0.5 seconds discards pending evidence; a gap over 1.5 seconds also clears calibration. This distinguishes a person leaving the view from the camera itself stopping. An incident already started continues its server-controlled response windows despite a later tracking interruption.

Camera stop/restart, detection-mode changes, browser-tab hiding, and a lost server connection clear or invalidate the reference. The desktop app can keep its dedicated monitoring renderer running when its menu-bar panel closes; a normal browser tab must remain visible. Device sleep or stopped camera frames is an interruption, not continued monitoring.

Pause before moving the laptop or changing its camera angle. Set it down, frame the seated view again, recalibrate, and explicitly enable monitoring. A detected device-location change can pause monitoring and invalidate calibration, but location accuracy does not guarantee that every camera movement will be noticed.

An incident already in progress retains its response workflow when monitoring is interrupted. Opening bystander assistance does not cancel it. Monitoring readiness, incident cancellation, caregiver acknowledgment, and resolution remain separate states.

## Evaluate safely before a demonstration

Use ordinary, comfortable motions and consenting, safely staged recordings. Do not attempt a real fall or force a sudden neck or body movement to test the detector.

Compare a normal seated session, a brief nod, shallow and deeper slow reading posture, comfortable sideways head movement, shoulder shrugging, face occlusion, leaving the view, and camera interruption. Use a safely staged clip for eligible head motion and lowering, and record both alerts and missed events. Test both unanswered response stages, cancellation in either stage, immediate help, calibration loss, simulated acknowledgment, and the contact workflow separately.

Existing automated tests exercise constructed landmark sequences and domain state transitions, including relative head height, sudden versus slower onset, scale changes, recovery, occlusion, and calibration loss. They do not measure real-camera detection performance. Physical evaluation on this Mac, with representative camera placement, lighting, clothing, and separate tuning and evaluation clips, remains pending. No clinical accuracy or validation is claimed.

Incident history preserves the detection mode, structured observations, response actions, and captured-location uncertainty. The example seated record is a labeled preview and does not start monitoring or place a call.

For a real emergency, use your own phone. If a person is unresponsive or breathing abnormally, request emergency help immediately rather than waiting for an app countdown. See the [American Red Cross guidance](https://www.redcross.org/take-a-class/resources/learn-first-aid/unresponsive-and-breathing-person). All emergency-service escalation in this prototype remains simulated.
