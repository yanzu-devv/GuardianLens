# GuardianLens

A local-first hackathon prototype that watches for a sustained lowered or tilted head posture, asks the person to check in, and can call opted-in contacts through Twilio if help is requested or the check-in is unanswered.

## Features

- Local MediaPipe pose estimation; no raw-video recording or upload.
- Seated head-posture checks require 10 continuous seconds with little head movement.
- Two-stage check-in, ordered contact calls, and phone keypad acknowledgment.
- Calls read the incident’s saved address or shared device coordinates, with stale/unavailable warnings.
- Incident history and separate explicit resolution.

This prototype does not diagnose a medical condition. Emergency-service dialing is disabled. Contact calls default to simulation.

## Run in a browser

Install Node.js 24 or newer, then run from this repository folder:

```sh
cd app
npm ci --ignore-scripts
npm run prepare:models
npm run build
npm start
```

Open the private dashboard link printed in the terminal. Camera monitoring requires consent, camera permission, calibration, and explicit activation. A labeled example incident can test the response flow without camera input.

## Optional Twilio calls

See [Twilio setup](app/docs/twilio-calling.md). Copy `app/.env.example` to `app/.env` and configure your own credentials, approved recipient numbers, and HTTPS callback connection. Keep credentials private. No developer credentials or personal incident records are included in this upload copy.

## Project folders

- `app/`: browser/Electron interface, local server, detector, and tests.
- `python-detector/`: separate earlier Python prototype.
- `references/`: original project context.

More detail: [app guide](app/README.md), [seated detection](app/docs/seated-mode.md), and [response state machine](app/docs/incident-state-machine.md).

## Validation

```sh
cd app
npm test
npm run build
```

The latest local run passed 194 automated tests and the production build. A real Twilio call and phone press-1 acknowledgment were verified. Location speech was added afterward and tested locally. These checks do not establish clinical detection accuracy.
# GuardianLens
