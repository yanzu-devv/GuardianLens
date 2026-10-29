# GuardianLens — Project Handoff

## Objective and context

- Help me build **GuardianLens** for the **SOLIXEmpower 2026 Hackathon**, AI in Healthcare track.
- Event starts Wednesday, October 28, 2026.
- Track description: “Apply AI to real clinical, operational, or patient-facing problems.”
- GuardianLens addresses patient-facing assistance and caregiver response.
- Planning assumption: **3 people and 12 coding hours**. Confirm actual team skills and constraints before scheduling.
- Prioritize a working, polished demonstration over a large feature set.
- No application has been implemented yet; previous work covered strategy, requirements, and generated visual concepts.

## Product identity

- **Name:** GuardianLens.
- **Tagline:** “When you can’t call for help, your room can.”
- **Core promise:** Detect a possible collapse, check whether the person needs help, and follow their configured contact plan when they cannot respond.
- **Long-term vision:** A gentle everyday companion with emergency assistance.
- **Hackathon focus:** One complete emergency-response loop.
- Do not expand into stroke diagnosis, a broad medical chatbot, or numerous wellness features.

## Intended environment

- One consenting adult.
- One fixed camera.
- One configured room with a known address.
- An awake Mac runs camera analysis.
- A paired phone provides response controls.
- Saved, opted-in emergency contacts receive calls.
- Bystanders can access essential assistance through the Mac’s incident screen.
- Monitoring covers only the camera’s usable field of view.

## Main workflow

1. Person completes setup, grants permissions, and enables monitoring.
2. AI estimates body pose and analyzes movement over time.
3. A suspected collapse creates one active incident with a timestamp.
4. GuardianLens displays and speaks:
   - “A possible fall was detected. Are you okay? Do you need help?”
5. Show response controls on the Mac and paired phone:
   - **I’m okay:** cancel the incident and resume monitoring.
   - **Get help now:** immediately start the configured help pathway.
   - **Unclear speech:** keep the incident active; offer buttons.
   - **No response:** begin contact escalation after the check-in countdown.
6. Call the first saved emergency contact.
7. Explain the configured location and observed event.
8. Request explicit acknowledgment:
   - “Press 1 to acknowledge that you’re responding.”
9. Voicemail, decline, timeout, wrong digit, and answering without acknowledgment do not count as acceptance.
10. Try subsequent contacts according to the saved plan.
11. If nobody acknowledges, demonstrate a clearly labeled **simulated emergency-service escalation**.
12. Record actions and outcomes in the incident timeline.
13. Keep **acknowledged** and **resolved** as separate states.

## Emergency boundaries

- Detect **possible collapse**, not confirmed fainting, stroke, cardiac arrest, or death.
- A missing response to the app does not establish unconsciousness.
- Camera observations do not establish normal or abnormal breathing.
- Recognized stroke signs or an unresponsive person with abnormal breathing require immediate emergency action rather than waiting through family calls.
- A guided stroke test must not delay requesting help.
- Never display “no stroke detected” as reassurance.
- Keep actual emergency dialing disabled in the prototype.
- Do not place real 911 calls during development, testing, or demonstrations.
- Production emergency calling would require a supported, verified integration with correct routing, location, and failure handling.
- Do not claim regulatory status, medical validation, or production readiness.

## macOS quick-access experience

- The user specifically wants a **menu-bar app**, resembling macOS’s music-control popover.
- A small GuardianLens icon remains in the menu bar.
- Clicking it opens a compact panel with:
  - Room name.
  - Monitoring status.
  - Camera on/off.
  - Microphone on/off.
  - Optional small camera preview.
  - Camera connection status.
  - Paired phone connection status.
  - Pause monitoring.
  - Open dashboard.
- Request camera and microphone permissions through the operating system.
- Closing the panel should leave the monitoring process active.
- Quitting the app, computer sleep, or closing a laptop lid must not be represented as continued protection.
- Show monitoring interruption explicitly.
- A possible incident opens a dedicated check-in window, not just a tiny menu-bar message.

## Phone response experience

- Pair the phone to the monitoring session through a protected link or pairing token.
- For the MVP, use a mobile-friendly web page with:
  - “Possible collapse” status.
  - “Are you okay?”
  - Countdown.
  - **I’m okay** and **Get help now** buttons.
- A response from either Mac or phone updates both.
- Clearly label shortened timers as **Demo timer**.
- Do not claim a web page guarantees lock-screen popups or delivery.
- Optional web push requires supported devices, installation/permissions where applicable, and testing.
- Native iPhone actionable notifications are a future option if response buttons directly inside notifications are required.

## Bystander Mode

- This is an important addition to the product story.
- Someone arriving after the incident may not know what happened.
- Provide an **“I’m here to help”** action on the Mac incident screen.
- Opening it must not cancel escalation.
- Essential information should be accessible without a login or mandatory QR scan.
- Show:
  - Configured location.
  - Emergency-call action.
  - Observed event timeline.
  - Contact and acknowledgment status.
  - Clear unknowns.
  - Short, predefined first-aid guidance.
- Example factual summary:
  - “Sudden downward movement detected at 2:14:08 PM.”
  - “Person remained near floor level.”
  - “No response to the app’s check-in.”
  - “Cause unknown. Breathing not assessed.”
- Distinguish detection time from symptom onset or last-known-well time.
- Do not expose private medical history or family phone numbers publicly.
- Emergency guidance must use reviewed, predefined content grounded in authoritative sources.
- An LLM must not improvise treatment instructions.

## AI functionality

- **Essential: pretrained body-pose estimation.**
  - Display an optional skeleton overlay.
- **Essential: movement analysis over time.**
  - Consider downward movement, low posture, and subsequent stillness.
  - Pose model plus hand-written thresholds should be described honestly as AI perception with rule-based event detection.
- **Optional: speech understanding.**
  - Explicit “Help me” and “I’m okay” responses.
  - Ambiguous speech or background conversation must not automatically cancel an incident.
  - Phone buttons remain available.
- **Optional: grounded incident summary.**
  - Summarize structured observations and event logs only.
  - Do not invent symptoms, diagnoses, or unseen events.
  - Keep LLM generation outside the escalation decision path.
- Countdown, contact order, retries, cancellation, and acknowledgment use explicit rules.
- Do not add AI simply for appearance.

## AI observation panel

- Display measured observations such as:
  - Person in view.
  - Rapid downward movement observed.
  - Person near floor level.
  - Limited movement afterward.
  - Check-in unanswered.
- Do not show invented clinical confidence percentages.
- Do not infer that standing upright means medically healthy.
- Clearly distinguish live camera input, recorded demo input, and example incident data.

## Required screens

1. **Setup**
   - Consent, permissions, room, address, contacts, escalation settings, test call.
2. **Menu-bar quick access**
   - Compact controls and connection status.
3. **Monitoring dashboard**
   - Camera, AI observations, monitoring health, incident timeline.
4. **Emergency check-in**
   - Large question, countdown, response buttons.
5. **Paired phone response**
   - Synchronized check-in controls.
6. **Bystander assistance**
   - Observations, location, emergency action, predefined guidance.
7. **Caregiver incident**
   - Summary, acknowledgment, response history, resolution.

- Reuse components and incident data across screens.

## Status and reliability requirements

- Distinguish:
  - Monitoring active.
  - Monitoring paused.
  - Camera disconnected.
  - Person out of view.
  - Possible collapse.
  - Check-in active.
  - Contact call attempted.
  - Call connected.
  - Caregiver acknowledged.
  - Incident cancelled.
  - Incident resolved.
  - Escalation failed or pending.
- “Sent” does not mean delivered.
- “Answered” does not mean acknowledged.
- “Acknowledged” does not mean help arrived.
- Never display “help dispatched” without verified confirmation.
- Support one active incident at a time.
- Prevent duplicate calls from repeated detections or callbacks.
- Handle cancellation during an in-progress call and clearly record any call already placed.
- Make network and callback failures visible.

## Everyday companion features

- Future options:
  - User-configured water reminders.
  - Screen breaks.
  - Movement reminders.
  - Snooze and scheduling preferences.
- If time remains, add one simple movement reminder.
- Ignoring a wellness reminder must never trigger emergency escalation.
- Do not claim the camera measures dehydration or determines medical need.
- Keep dementia-specific companionship as a future research direction.

## Design direction — approved

- **Style:** futuristic, high-end, calm, minimal.
- Matte black surfaces and restrained electric-lime accents.
- Avoid excessive glow, fake medical charts, decorative code, or crowded sci-fi visuals.
- Generous spacing, readable typography, clear status labels.

### Palette

- Background: `#080B09`.
- Cards: `#121713`.
- Borders: `#29352C`.
- Primary lime: `#B6FF3B`.
- Main text: `#F2F6EF`.
- Secondary text: `#A5B2A7`.
- Warning amber: `#FFCA64`.
- Urgent coral red: `#FF6464`.

### Logo

- Open protective lens arcs surrounding a minimal person.
- Lime symbol.
- White “Guardian” with lime “Lens” can be used in the wordmark.
- Simple, flat, readable at small menu-bar sizes.
- The generated previews contain slightly different logo interpretations; choose and standardize one before implementation.
- The exact final vector logo has not been created.

### UI components

- Rounded charcoal cards with fine borders.
- Lime primary buttons with dark text.
- Dark secondary buttons with clear outlines.
- Large, separated emergency response controls.
- Amber for check-in warnings; coral red for urgent actions.
- Icons paired with text; never rely on color alone.
- Clean sans-serif typography.
- Monospace reserved for timers and timestamps.
- Verify actual contrast, keyboard access, focus states, and touch-target sizes.

## Existing visual previews

- Two AI-generated visual concept boards were approved:
  1. Logo, full dashboard, and phone check-in.
  2. Menu-bar quick access, Mac check-in window, and paired phone web page.
- They are design references, not functioning interfaces.
- Ask me to attach them if their images are unavailable in the new chat.
- Do not assume a displayed domain is owned or deployed.
- The generated images may contain incidental date or text details that should not be copied blindly.

## Recommended technical direction — provisional

- **Electron:** macOS menu-bar app and desktop shell.
- **React + TypeScript + Vite:** reusable UI.
- **MediaPipe Pose Landmarker for Web:** browser-based pose estimation.
- **Node.js backend:** explicit incident state machine and call orchestration.
- **SQLite or similarly lightweight storage:** incident event log.
- **WebSockets:** synchronize desktop and paired phone.
- **Twilio Programmable Voice:** real demo contact calls and keypad acknowledgment.
- **One HTTPS tunnel:** ngrok OR Tailscale Funnel for development callbacks.
- Do not expose the camera feed or unprotected dashboard publicly.
- Validate callback authenticity and protect paired-session access.
- Keep Twilio credentials on the backend.
- Xcode is not required for the Electron/web MVP.
- A native iPhone companion would introduce Xcode and additional scope.
- Earlier Python/OpenCV/FastAPI suggestions were alternatives; the latest preference is one TypeScript-based project.
- Validate camera processing, desktop background behavior, and calling-service access early.

## Privacy

- Explicit monitoring consent.
- Visible monitoring status and pause control.
- Prefer local video analysis.
- No raw-video storage by default.
- Verify that frames are not uploaded or written by debug code.
- Disclose cloud audio or event processing if used.
- Avoid recording calls unless explicitly required and authorized.
- Restrict caregiver and phone links.
- Do not claim “everything stays local” if calling, push, or cloud services are used.

## Testing and demonstration

- Use consenting teammates and safely staged recordings; no unsafe falls.
- Test:
  - Staged collapse.
  - Sitting quickly.
  - Bending.
  - Intentionally lying down.
  - Leaving the view.
  - Camera disconnection.
  - Cancellation.
  - Immediate help request.
  - Contact presses 1.
  - Voicemail, rejection, timeout, wrong digit.
  - Network failure and duplicate callbacks.
- Tune on different clips from evaluation clips.
- Report actual counts and conditions, not unsupported clinical accuracy.
- Measure detection-to-alert latency and acknowledgment success.
- Prepare a clearly labeled backup recording.

## Demo story

- Briefly introduce someone alone and unable to reach a phone.
- Show one ordinary activity.
- Run a safely staged collapse.
- Show the unanswered check-in.
- Make a real teammate’s phone ring.
- Collect acknowledgment.
- Show the event timeline.
- Briefly show Bystander Mode.
- Show simulated emergency escalation separately or through a labeled recording.
- Keep alternate failure cases on a results screen rather than overloading the live demo.

## Differentiation and positioning

- Existing competitors include camera-based fall detection and older-adult companions.
- SafelyYou overlaps with camera-based fall detection in memory care.
- ElliQ overlaps with companionship and reminders.
- Do not claim GuardianLens is the first or only such product.
- Emphasize:
  - Observable incident evidence.
  - Explicit caregiver acknowledgment.
  - User-configured response plans.
  - Bystander handoff.
  - Visible monitoring failures.
  - Privacy-conscious design.
- Memory loss, Alzheimer’s disease, and all older adults are not interchangeable audiences.
- Do not pivot to dementia-specific care without learning from caregivers.

## Build priorities

1. Prove camera input and pose processing.
2. Prove one real call and keypad acknowledgment.
3. Implement the incident state machine.
4. Complete the check-in and cancellation flow.
5. Synchronize the phone.
6. Add the menu-bar experience and dashboard.
7. Add Bystander Mode.
8. Test failure paths and rehearse.
9. Add voice recognition or one wellness reminder only if time remains.

## Instructions for the new chat

- Treat this as the agreed product direction.
- Help implement it in small, testable steps.
- Confirm actual hardware, team skills, available time, and calling-service access.
- First inspect any existing project and applicable instructions.
- Define the incident state machine and acceptance criteria before implementing escalation.
- Keep emergency dialing explicitly simulated.
- Follow my applicable AGENTS.md instructions, including required Kluster checks; disclose if the required tools are unavailable.
- Do not present mockups or simulated behavior as completed functionality.
- Favor completing the core loop over expanding scope.