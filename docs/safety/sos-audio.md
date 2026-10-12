# SOS microphone recording

Tests: `test/sos-audio.e2e-spec.ts` (API, 22 tests), `src/modules/safety/sos-audio.spec.ts` (WAV/Range/state helpers), Flutter `test/features/safety/sos_audio_test.dart` (chunking, disk spool, upload retries, session, card).

## What happens
When a rider or driver presses **SOS** (and confirms):
1. The alert, the admin notification and the WhatsApp messages go out **exactly as before**. Audio never delays or blocks them.
2. The phone starts recording the microphone (16 kHz mono) and uploads it in **5-second chunks** to the API. Chunks wait on disk until the server confirms them, so a bad network delays the sound but does not lose it.
3. The **safety team** opens the incident in the admin panel: **Sound from the phone** → *Listen live* (about 5–10 s behind), *Play recording*, *Download (.wav)*.
4. The **emergency contacts'** WhatsApp message already carries the *Track live* link. For an SOS link that page now also shows a **Sound from their phone** card: *Listen live* and a player for the recording so far.
5. When the safety team resolves/closes the incident, the phone stops, the contacts' link stops working, and the recording stays with the safety team until the retention date.

### Why not LiveKit / WebRTC
It needs a LiveKit server, an Egress service and an S3 bucket, none of which this deployment has, and the phone has to stream through them. Chunked upload uses the API and MongoDB that already run, and works through any network that lets HTTPS through. The cost is a delay of 5–10 s instead of sub-second. If real-time becomes a requirement, only `SosAudioService` (storage + serving) and the phone's uploader would change; the SOS flow, UI states, access log and retention stay.

## What the people see
Phone (SOS sheet → *Sound* card), always from what the **server confirmed**:

| Card | Meaning |
|---|---|
| Starting the microphone… | asking for / opening the mic |
| Recording sound · 1:05 saved | the server holds 65 s |
| Recording — waiting for signal | no connection; `N s` waiting on the phone, retrying |
| Microphone interrupted — reconnecting | a call/another app took the mic; it reopens it |
| The microphone is turned off | permission off; alert + location were still sent; *Try again* |
| Couldn't record sound | mic could not be opened; *Try again* |
| Recording ended · 1:05 saved | stopped (by the person, or the alert closed) |

The SOS button shows a mic and *SOS active · recording* while it records, and tapping it reopens the sheet instead of asking again. *Stop recording* (with a confirmation) is there because a person must be able to stop being recorded; what was recorded stays.

Admin (incident page): state badge (Recording now / Recording ended / **Audio stopped arriving** / **Phone could not record** / No audio yet), saved length and size, gaps (`missingChunks`), the phone's own report (permission off, stopped…), the notice version the person accepted, retention date, and **who listened** (admins by name; contacts as "tracking link").

## API
Phone (customer/driver token; only the person who raised the alert):

| | |
|---|---|
| `PUT /rides/:rideId/sos/:sosId/audio/:seq` | body = raw PCM (`application/octet-stream`, 16-bit LE mono 16 kHz, ≤ 400 kB, even length). Repeating a `seq` is safe. 409 `SOS_CLOSED` / `SOS_AUDIO_LIMIT` / `SOS_AUDIO_DISABLED` carry `data.stop = true`: the phone stops. |
| `POST /rides/:rideId/sos/:sosId/audio/state` | `{state: RECORDING|STOPPED|PERMISSION_DENIED|FAILED, consentVersion?}` so a recording that cannot happen is visible to the safety team |

`GET /rides/:id/sos` (the phone) now includes `audio: {state, chunks, seconds, nextSeq}`; a phone that restarts continues numbering at `nextSeq`.

Admin (`/admin/sos/:id/audio/…`): `chunks?after=<seq>|tail=<n>`, `chunks/:seq` (one chunk as WAV), `recording` (whole WAV, HTTP Range, `?download=1`). The incident detail has `audio` (see `AdminSosAudio`).

Contacts' link (token = the SOS tracking token, same as the page): `/shared-rides/:token/audio/chunks`, `/audio/chunks/:seq`, `/audio.wav`, plus the player script `/shared-rides/assets/sos-audio.js`. An ordinary share-my-ride link gets **404** on all of these, and an ended/revoked link gets the same 404/410 as the status page.

## Data
`sos_audio_chunks` (raw PCM, unique `{sosId, seq}`, TTL index on `expireAt`) and `sos_events.audio` / `audioAccess`. About **115 MB per recorded hour**. `SOS_AUDIO_MAX_SECONDS` (default 4 h) caps one incident.

| Env | Default | |
|---|---|---|
| `SOS_AUDIO_ENABLED` | `true` | off = the app records nothing and says so |
| `SOS_AUDIO_RETENTION_DAYS` | `90` | chunks are deleted by Mongo's TTL after this |
| `SOS_AUDIO_MAX_SECONDS` | `14400` | per incident |

## Android / iOS
- Android: `RECORD_AUDIO` (already requested) and `FOREGROUND_SERVICE_MICROPHONE`; `SosRecordingService` (a quiet foreground service of type *microphone*, started when SOS is pressed while the app is on screen) keeps the mic working with the screen locked. Its notification has no sound and hides its content on the lock screen, in line with the silent SOS notices. If Android refuses to start it, the sheet says *Keep the app open*.
- iOS: `NSMicrophoneUsageDescription` and the `audio` background mode were added to `Info.plist`.

## Things to know / decide
- **Security of the link**: anyone holding the SOS tracking link can listen while the incident is open (it is the same capability link that already shows the live location; 192-bit token, ends when the incident closes). The audio card says not to forward it. Add an OTP gate if you want stricter contact access.
- **WhatsApp template text**: the message body was approved before audio existed. Edit `tirvona_sos_alert` in WhatsApp Manager to mention it (e.g. "Open the link to see the location and hear the sound"); it needs re-approval, the code does not change.
- **Same origin**: the tracking page loads its audio from `/api/v1/shared-rides/…`, so `SHARE_RIDE_LINK_BASE_URL` must point at the API host (the default does).
- **Not covered**: the phone does not resume a recording after the app is killed or restarted (the sheet offers *Record again*, continuing the numbering); audio on the phone's disk is not encrypted while waiting to upload (app-private cache, deleted after upload); chunks in MongoDB are not encrypted by the application (use Atlas encryption at rest).
- **Legal**: recording and sharing audio of people in a vehicle needs consent wording reviewed for India (the confirm dialog says it; the accepted version `sos-audio-v1` is stored). Retention and who may listen are your policy decisions.
- **Not tested on a device**: microphone capture, the foreground service and screen-locked behaviour need a real phone (Android 11–15). The pipeline around them is tested with fakes.
