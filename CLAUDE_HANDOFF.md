# GuardianLens — read this first

This package is the current saved GuardianLens codebase and context for continuing development. It was prepared from the organized October 28, 2026 snapshot. Use `app/` as the current application; earlier ZIP versions are intentionally excluded.

## Read next

1. `PROGRESS.md` — implemented features, unfinished tasks, and verification limits.
2. `app/README.md`, `app/docs/verification.md`, and `app/docs/seated-mode.md` — existing architecture and development history.
3. `app/package.json` and source in `app/src/` — the actual current implementation.
4. `python-detector/README.md` — separate Python prototype.
5. `references/Original-project-handoff.md` — original requirements, some of which remain future scope.

When older documentation differs from source, check the source and progress report. Contact name, relationship, and phone fields were added after the older README; phone numbers do not yet initiate real calls. Do not replace this source with older prototypes.

## Current behavior

The app has a black/lime dashboard, logo zoom intro, explicit camera consent, seated calibration and head-motion/lowering rules, optional full-body mode, spoken check-in prompts, and a two-stage response flow. First it asks “Are you okay?” for 10 seconds; unanswered, it asks “Do you need help?” for a configurable interval. Okay cancels, help starts the simulated contact plan. Contact connection, explicit acknowledgment, and resolution remain distinct. Phone pairing/WebSocket responses, device/manual location, incident history/reporting, bystander assistance, and an Electron tray/dashboard shell exist.

All actual phone/emergency dialing is currently disabled. The newest outstanding user request is to call an opted-in demo phone when help is requested or the check-in goes unanswered. Twilio trial onboarding/recipient verification was unfinished, and no real call has been placed. Ask the user to complete any required account steps and provide secrets through local environment configuration rather than chat. Implement and test the provider integration; adding contact fields alone does not satisfy the call requirement.

Further unfinished work: live-camera reliability evaluation; physical Mac tray/camera/background/lock/sleep behavior; physical iPhone HTTPS-tunnel/reconnect tests; Python MediaPipe live startup on macOS; and connecting Python events to the web workflow if the user chooses that detector. Native push and speech-response recognition are future scope. Spoken output already exists.

## Install/run the app

Use Node.js 24 or newer. From the extracted handoff folder:

```sh
cd app
npm ci --ignore-scripts
npm run prepare:models
npm run prepare:desktop
npm run build
npm run desktop
```

The preparation scripts restore the excluded local model/WASM assets and Electron runtime. For browser hosting after building, run `npm start` instead of the desktop command and open the fresh private owner URL printed by the server. Port 8787 is the default; stop an existing instance before starting another. `npm run dev` is for local development and must not be publicly tunneled.

For browser-only source work the Electron preparation is optional. Existing scripts do not automatically load `.env`; `.env.example` documents process environment variables. Fresh state is expected in this source package; private saved contacts, location, and incident history are excluded. Camera monitoring must be explicitly enabled and calibrated, and phone links recreated after a restart. Physical iPhone access needs a configured HTTPS tunnel as documented in the app README.

## Python prototype

This is separate from the web app. Use Python 3.10–3.12 (3.12 recommended):

```sh
cd python-detector
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python main.py
```

The Python README contains an old workspace-specific `../../work/...` venv path. Use the new local `.venv` above. Prior live SDK startup was blocked by a macOS OpenGL context error; do not claim webcam inference is verified.

## Verification history and constraints

- An earlier full web update passed 151 tests and a build; this predates the latest detector timing correction/contact fields.
- The newest timing correction recorded 46 detector passes and a build.
- Python recorded 50 synthetic/integration-contract passes.
- No tests/builds were rerun while making this source handoff. These counts are historical, not verification of a new change.
- Run focused tests and a build after changes; evaluate real-device behavior separately. Synthetic tests do not establish detection accuracy or medical validation.
- Preserve local camera processing and no raw-video recording. An unanswered check-in is not a diagnosis or confirmation of unconsciousness. Keep actual emergency-service dialing disabled during demos.
- The user's existing Kluster instructions require review after modifications and dependency validation before package operations. Kluster was unavailable in the prior session; report its absence honestly if still unavailable. Ordinary tests do not replace it.

## Included / omitted

Included: current web/server/Electron source, tests, docs, dependency lockfile, authored logo/icons, model preparation scripts, Python code/configs/tests, progress, and original requirements.

Omitted: private state, actual credentials, dependency installations/caches, generated builds, model/WASM binaries, screenshots, reference video, and obsolete ZIPs. The preparation scripts regenerate required runtime assets. This source-only package starts without the prior user's private data.
