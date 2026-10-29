# Twilio demo calling

The detector and two check-in questions are unchanged. With `CALL_MODE=twilio`, **Get help now**, or expiration of both questions, requests real calls to opted-in contacts in order. The recipient must press **1** on the phone. Answering, voicemail, other digits, and an unanswered call do not acknowledge the incident. Acknowledgment does not resolve the incident; the operator resolves it separately. Emergency-service dialing remains disabled.

## Local configuration

Node 24+ loads `.env` automatically for `npm start`, `npm run desktop`, and `npm run callbacks`. Keep it private; it is ignored by source control. Start from `.env.example` on another machine.

Required for real mode:

- `CALL_MODE=twilio`
- `TWILIO_ACCOUNT_SID` and the primary `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`: use the caller number shown for this recipient in Twilio's Voice trial console, or a voice-capable number authorized for your account
- `TWILIO_ALLOWED_TO`: comma-separated approved demo numbers, with country codes, e.g. `+15555550123`
- `TWILIO_CALLBACK_ORIGIN`: public HTTPS callback origin with no path or custom port
- `TWILIO_TRIAL_MODE=true` for the new guided Voice trial. This sends only To, From, Url, and StatusCallback. The full request options caused HTTP 400 / error 0 in the verified trial account.

The saved response plan must also contain the recipient's matching phone number and explicit opt-in. Credentials remain on the server, are not written to incident state or browser bundles, and are not included in call speech. A failed or incomplete live configuration refuses startup rather than silently claiming real calls are enabled.

## Callback connection

1. Start `npm run callbacks`. It listens on `127.0.0.1:8788` and forwards only POST requests matching `/twilio/<attempt-id>/voice`, `/digits`, or `/status` to the local app on port 8787. Dashboard pages, assets, and private API routes return 404 through this proxy.
2. After authorizing a tunnel provider, tunnel **port 8788**, not the dashboard. For Cloudflare Quick Tunnels: `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8788 --protocol http2`.
3. Put the resulting HTTPS origin in `TWILIO_CALLBACK_ORIGIN`. This temporary address changes when the tunnel is recreated. Keep both processes running.
4. Set `CALL_MODE=twilio`, restart the app, and open its fresh private dashboard link. The top bar must show **Real calls enabled · Twilio**. Camera monitoring needs explicit re-enablement and calibration after reload.
5. Run a clearly labeled example incident with an opted-in demo recipient ready to receive it. In real mode this example can place real contact calls. Choose **Get help now**, answer the phone, and press **1**. Confirm acknowledgment on the dashboard, then mark the incident resolved.

`PUBLIC_ORIGIN` is separate: it is optional hosting for paired phone response pages. The callback-only tunnel deliberately cannot serve those pages. Local dashboard access continues to work without phone pairing.

## Behavior and limits

- Calls use the Twilio REST API. Standard callbacks require Twilio signatures. The new trial's TwiML proxy was observed omitting its signature on the voice request. Trial voice/keypad URLs therefore carry a 256-bit HMAC capability scoped to the attempt and callback action. It is accepted only in explicitly enabled trial mode when no signature is supplied; account, provider call ID, allowed participants, and active attempt checks still apply. Status callbacks still require Twilio signatures. Keep capability URLs private; they are credentials and are not saved in incident state. Browser simulator commands cannot fabricate real call outcomes.
- The attempt is saved before an outbound request. A provider ID is stored after acceptance. Repeated updates do not create duplicate requests.
- Pressing **I'm okay** requests cancellation, including when creation is still in flight. Obsolete calls are stopped before another contact can be requested. Failed cancellation is recorded and blocks further placements until a later reconciliation succeeds.
- Call-creation network errors have uncertain delivery. The plan stops and the request is not retried automatically. A call might still ring; check Twilio call logs. Late callbacks for an inactive incident return Hangup.
- Restart stops pending timers and does not replay calls. In real mode, saved provider IDs are used to request cancellation. On normal shutdown, cancellation is requested before exit. An abrupt crash before a provider ID is saved can still leave a provider call; the provider's call time limit and late inactive callback guard are backstops. Do not treat cancellation as guaranteed delivery of a hangup.
- Standard mode requests a 20-second ringing timeout and a hard provider time limit. Trial mode omits those unsupported options: Twilio's trial limits apply, with app cancellation requested at the app deadline. Cancellation is not guaranteed. The app allows extra time for dialing and the prompt; the configured acknowledgment interval follows the prompt.
- No audio recording, speech recognition, raw-video upload, or automatic emergency-service call is requested. The spoken message identifies a demo check-in, reads the location saved when the incident began, then asks for a keypad acknowledgment. A manual address is spoken as entered (including city/state if supplied). Device mode speaks latitude/longitude, cardinal directions, and estimated accuracy; fixes older than two minutes at call time carry a warning. Unavailable location is stated explicitly. Later live positions never replace the incident location. No reverse-geocoding service is contacted. The speech includes a reminder to confirm the person's location and no diagnosis. Twilio, the callback relay, and the called contact receive this location as part of delivering the user-requested spoken message.
- Callback traffic contains phone numbers, call IDs, and status/digit fields. An authorized HTTPS tunnel provider relays that traffic. Keep its exposure limited to the callback proxy.

Provider and webhook tests use injected fake responses. They do not prove a phone will ring. A successful call from the Twilio console establishes that console test only; an end-to-end GuardianLens call must be verified separately.

Live check (October 28, 2026): after two authorized calls identified trial request restrictions and a missing voice-proxy signature, a third explicitly approved call verified the corrected voice callback and physical press-1 acknowledgment. The incident recorded acknowledgment; a read-only Twilio query confirmed the call completed (22 seconds). An immediate cancellation request raced with TwiML completion and produced a historical warning; the provider subsequently confirmed completion. Location speech was added afterward at the user's request and passed local tests; it has not been tested in another physical call. Automated tests: 194 passing; production build passed. Rejection logs contain fixed diagnostic categories only.

References: [Twilio Voice trial](https://www.twilio.com/docs/usage/trials/try-out-voice), [Call resource](https://www.twilio.com/docs/voice/api/call-resource), [Gather](https://www.twilio.com/docs/voice/twiml/gather), [webhook signatures](https://www.twilio.com/docs/usage/security), [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).
