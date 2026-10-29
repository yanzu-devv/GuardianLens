# GuardianLens incident state machine

This prototype uses local AI perception and explicit rules. Every contact call and emergency-service escalation in this slice is simulated. The first check-in lasts ten seconds; the second response window and contact timers use the configured **Demo timers**. It never dials a telephone number or emergency service.

## States and transitions

| State | Meaning | Allowed transition |
| --- | --- | --- |
| No incident | No incident currently displayed | A labeled example or eligible camera observation creates `check_in` |
| `check_in`, stage `okay` | **Are you okay?**, waiting up to ten seconds | “I’m okay” → `cancelled`; “Get help now” → `calling`; no response at deadline → stage `help` |
| `check_in`, stage `help` | **Do you need help?**, waiting for the configured check-in duration | “I’m okay” → `cancelled`; “Get help now” or no response at deadline → `calling` |
| `calling` | A simulated attempt is active | “I’m okay” → `cancelled`; explicit simulated press 1 → `acknowledged`; a failed attempt or deadline tries the next opted-in contact |
| `acknowledged` | A contact explicitly accepted responsibility | User resolution → `resolved`; no claim that help arrived |
| `escalation_simulated` | No contact acknowledged; emergency escalation demonstration | User resolution → `resolved`; emergency dialing remains disabled |
| `cancelled` | Person cancelled through desktop or protected phone | A new incident can be created; previous incident retained in history |
| `resolved` | Incident closed explicitly | A new incident can be created; previous incident retained in history |

There is one active incident, including acknowledged or simulated escalation states. A new trigger during one does nothing. Contact order and opt-in status are copied into the incident at creation. Editing the plan during an active incident is rejected, while withdrawing monitoring consent remains available and leaves the existing incident response active.

## Callback and timer rules

- Each contact attempt has its own random ID. Only the currently active attempt can change the incident.
- `connected` records an answered call but does not acknowledge it. Only `acknowledged`, representing a simulated press 1, accepts the incident.
- Voicemail, decline, timeout, wrong digit, and network failure are failures. Each is visible in the timeline and moves to the next contact once.
- Duplicate outcomes, stale outcomes, and callbacks after cancellation or acknowledgment do nothing.
- Desktop and phone responses include the incident ID they were shown. A delayed response to an older incident cannot cancel or escalate the current incident.
- Server time controls check-in and contact deadlines. Browser countdowns are a display of those deadlines.
- New incidents start with `checkInStage: 'okay'` and a ten-second deadline. No response advances the same incident to `checkInStage: 'help'`, gives it a fresh configured check-in deadline, and records the second question. It does not place a contact attempt at the first deadline.
- Cancellation clears deadlines and marks any pending attempt cancelled while preserving its placement record.
- No response means only that the app received no response. It is not evidence of unconsciousness.
- Opening bystander assistance has no state transition and cannot stop escalation.

## Monitoring and interruption

Monitoring requested on, camera health, pose readiness, person visibility, and recent heartbeat are separate facts. Turning monitoring off, losing the camera, losing processing heartbeats, or an explicit sleep/restart interruption makes the interruption visible. These events never silently report healthy protection. Existing check-in/contact timers continue; a monitoring interruption does not dismiss an incident. Camera consent, a device label, and at least one opted-in contact are required before monitoring or examples begin. A manual plan requires an address. Device-location mode permits unavailable coordinates so that location failure cannot block incident response; the missing location is shown explicitly.

A camera trigger additionally requires monitoring enabled, connected camera, ready pose model, person in view, and a heartbeat within five seconds. Person visibility is an observation, not a medical assessment. Seated camera observations describe head movement relative to the shoulders or a lowered head position; full-body observations retain their separate movement rules. Detection time is not symptom onset. Cause and breathing remain unknown.

On server restart, an active incident is retained and explicitly interrupted. Check-in and contact deadlines are stopped, monitoring is disabled, and the incident enters `escalation_simulated` with an interruption event. The operator must inspect and resolve it; the system does not replay calls.

## Acceptance criteria

1. A setup without consent, room, address, or opted-in contacts cannot enable monitoring or create an example.
2. One eligible trigger produces one incident with timestamps and factual observations. Repeated triggers never add attempts.
3. “I’m okay” from either desktop or phone cancels the same incident. No later callback can re-open it.
4. “Get help now” bypasses either check-in stage. No response to **Are you okay?** for ten seconds advances to **Do you need help?** without starting a contact attempt. No response after the second configured window starts one simulated contact attempt.
5. Connecting a call does not acknowledge it. Only the explicit acknowledgment outcome changes the incident to `acknowledged`.
6. Every failure outcome tries exactly one subsequent contact; exhausting contacts enters explicitly simulated emergency escalation.
7. Acknowledgment stops contact timers but does not resolve the incident. Resolution requires a separate operator action.
8. Cancellation during a simulated call retains the original attempt, marks it cancelled, and records that a call was already attempted.
9. Callbacks with stale attempt IDs and duplicate callbacks cannot change state or place another simulated call.
10. Camera loss, a stale processing heartbeat, and explicit interruption are visible. A trigger with unhealthy monitoring is rejected.
11. No code in the engine places real calls, infers a diagnosis, estimates breathing, or claims help was dispatched.
12. Restart restoration preserves the audit trail and cannot resume timed actions automatically.


## Location and human accounts

Location sharing starts explicitly and is separate from camera consent. An incident freezes the configured manual location or the available device fix, estimated accuracy, acquisition timestamp, and freshness status. A location fix older than two minutes is marked stale; this is an application threshold, not a clinical standard. Location errors remain visible. No location is invented for old incidents that predate capture. Changing to manual mode clears the live device fix immediately. Restarting clears live location sharing while preserving frozen incident locations.

Location changes beyond the monitoring-start position’s uncertainty plus the new fix uncertainty plus 50 metres pause camera monitoring for repositioning. This is an estimate of device movement and does not establish movement or a medical event in the monitored person. Repeated monitoring-enable commands cannot move the anchor while monitoring is already enabled.

Person, witness, or caregiver accounts are timestamped separately, explicitly attributed, and unverified. Adding an account never acknowledges, cancels, or resolves an incident. Phones receive the incident location needed for that response, but neither a continuous device-location feed nor private reported accounts.


## Seated detector provenance

New and legacy unspecified configurations use seated mode by default. Camera-triggered incidents require matching mode evidence, ready coverage, recent frame health, and a valid seated calibration timestamp. A partial or occluded view cannot create a seated incident. Mode changes and interruptions invalidate calibration. Older queued calibration metadata cannot restore ready state after invalidation. Example incidents remain explicitly labeled and do not require actual camera calibration.

Each new incident freezes detection mode as well as location. Seated incident observations describe rapid downward or sideways head motion relative to the shoulders, or a head position lowered from the calibrated reference. They do not claim limited movement as a prerequisite: the check-in follows brief valid-frame confirmation instead. They never claim a floor-level fall, confirmed fainting, unconsciousness, or assessed breathing. Camera/model loss pauses monitoring while preserving any active response timer; restored frames require explicit monitoring re-enabling. No five-minute inactivity detector is implemented.
