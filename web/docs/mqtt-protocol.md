# ClassPulse MQTT protocol v1

The shared source of the data types and validation is `packages/mqtt-contracts/src/index.ts`; the question and state types are in `packages/shared-types/src/index.ts`. The backend is the only place that decides who may take part, the timing and which answers are valid. The simulator and the ESP32 do not connect to PostgreSQL and do not send statistics directly to the teacher web app.

The ESP-IDF firmware implements this protocol in [`apps/firmware`](../apps/firmware/README.md). The Wi-Fi/MQTT credentials are written over BLE GATT and stored in NVS, not hard-coded in the source. The firmware subscribes to the ACK before sending a join, uses QoS 1, keeps the request unchanged on a retry and stores the pending request/sequence across resets.

## Broker and identity

- MQTT TCP: `mqtt://localhost:1883`; MQTT over WebSocket for browsers: `ws://localhost:8083/mqtt`.
- A frontend deployed over HTTPS needs a `wss://` endpoint with a valid certificate.
- Inside Docker the backend uses the hostname `emqx`; browsers use a hostname that the user's machine can reach.
- The development account for the simulator: `simulator` / `simulator-dev-only`. This is a public development credential, not an EMQX admin account.
- Anonymous access is off. The backend has its own account to receive the device topics and publish ACKs/state.
- The MQTT `clientId` must be exactly the `deviceId`. Each tab/device has its own ID, 3 to 64 characters from `[a-zA-Z0-9_-]`.
- The simulator ACL only allows publishing to `quiz/v1/devices/${clientid}/join`, `/answer` and `/status`; subscribing to its own clientId's `/ack` and `/command` and to the room's `/question` and `/state` topics. It may not publish ACKs, room state, commands or another device's topics. All other permissions are denied by default.
- An ACL based on `${clientid}` with one shared credential is only enough for development: anyone who knows the password can choose another device's clientId. Production must provision a separate identity for each device and bind the username/certificate to the clientId (mTLS or a suitable HTTP/JWT authentication mechanism), and limit read access to the rooms that were granted. Replace every sample password before deploying.

The web simulator reads `VITE_MQTT_WS_URL`, `VITE_MQTT_USERNAME` and `VITE_MQTT_PASSWORD` (the aliases `VITE_MQTT_SIMULATOR_USERNAME` and `VITE_MQTT_SIMULATOR_PASSWORD` are also supported) at build time, or is configured directly on the page. Every `VITE_` variable can be read from the browser; never use an admin/backend credential.

## Provisioning devices for production

The repo has a command that provisions a separate account for each device:

```bash
MQTT_DEVICE_PASSWORD='<own-password-of-at-least-12-characters>' pnpm provision --deviceId=device-001
```

The command runs from an administrator's machine, loads `.env` and uses `EMQX_DASHBOARD_USER` / `EMQX_DASHBOARD_PASSWORD` to call the management API (`EMQX_API_URL`, default `http://127.0.0.1:18083/api/v5`). The admin credential is never put in the frontend. The device receives `username=device-001`, `clientId=device-001` and the separate password in `MQTT_DEVICE_PASSWORD`.

The ACL for `device-*` accounts binds the topics to the **authenticated `${username}`** instead of the `${clientid}` that the client chooses itself. Changing the clientId therefore does not grant permission to publish/subscribe to another device's topics. Permission to read a room snapshot currently uses `rooms/+`; if the class content must be confidential, add dynamic per-room authorization. Set `MQTT_SIMULATOR_ENABLED=false` to turn off the shared development account when using provisioned devices. Use TLS for MQTT/WebSocket and change the sample credentials before deploying.

## Topics

| Topic | Sender → receiver | QoS | Retain |
|---|---|---:|---|
| `quiz/v1/devices/{deviceId}/join` | Device → backend | 1 | false |
| `quiz/v1/devices/{deviceId}/answer` | Device → backend | 1 | false |
| `quiz/v1/devices/{deviceId}/status` | Device → backend | 1 | false |
| `quiz/v1/devices/{deviceId}/ack` | Backend → device | 1 | false |
| `quiz/v1/devices/{deviceId}/command` | Backend → device | 1 | false |
| `quiz/v1/rooms/{roomCode}/question` | Backend → device | 1 | true |
| `quiz/v1/rooms/{roomCode}/state` | Backend → device | 1 | true |

`command` sends a private result to a device when the session ends. The two room topics carry the **same `RoomState` structure** so a device that has just connected gets a full snapshot from the retained message. Join/answer/ACK/command are not retained, to avoid re-running an old operation on subscribe. A device drops a snapshot whose `serverTimestamp` is older than the one it already received.

When the session moves to `FINISHED`, the backend publishes to each device's command topic:

```json
{"type":"RESULT","roomCode":"123456","score":8,"correct":4,"total":5,"serverTimestamp":"2026-09-29T09:05:00.000Z"}
```

`score` is the score out of 10, rounded to an integer so it fits on two digits. The firmware only accepts a result whose `roomCode` matches the room it joined. After viewing the score, press `*` to clear the session state and enter a new room code.

A device must subscribe to its own ACK topic **before** publishing a join. It subscribes to the room's state/question once the roomCode is entered; it only counts as joined after a successful ACK.

## JSON and common fields

UTF-8 JSON objects; unknown fields are not accepted. Fields required on every device message:

| Field | Rule |
|---|---|
| `requestId` | A UUID; new for each user action, unchanged when retrying the same action |
| `deviceId` | Equal to the ID in the topic and to the client identity the broker authorised |
| `roomCode` | A string of exactly 6 digits, keeping a leading 0 |
| `clientTimestamp` | ISO-8601 with a time zone; used for diagnostics only |

The server uses the server/database time to decide the deadline. It cannot be extended by changing the device clock. The topic must match the pattern exactly and the `deviceId` in the payload must match the topic; a mismatch returns `INVALID_PAYLOAD`.

### Join

Topic: `quiz/v1/devices/device-001/join`.

```json
{
  "requestId": "039cbf48-7b76-42ba-a55d-1e0a906b9968",
  "deviceId": "device-001",
  "roomCode": "123456",
  "studentCode": "2026001",
  "clientTimestamp": "2026-09-29T09:00:00.000Z"
}
```

`studentCode` is 1–32 characters from `[A-Za-z0-9_-]`. The backend supports alphanumeric codes so future hardware can enter them through configuration; the MVP keypad enters **numeric** codes. One device and one student code map to only one participant in a session. Joining again with the same information is safe; changing the student code on the same device within a session is rejected to protect the identity behind the answers.

### Answer

Topic: `quiz/v1/devices/device-001/answer`.

```json
{
  "requestId": "061a7fb4-22a0-4767-b745-ed291ba1bde7",
  "deviceId": "device-001",
  "roomCode": "123456",
  "questionId": "5d44c3d8-817a-438b-9aa1-ac6f99e6d425",
  "answer": "B",
  "sequence": 1,
  "clientTimestamp": "2026-09-29T09:00:15.000Z"
}
```

`answer` is the **canonical key**: one letter `A`–`D`, or for a multiple-answer question (`currentQuestion.type = "MULTIPLE"`) several letters in alphabetical order without repeats (`AC`, `ABD`). An older device that only sends one letter is still valid. A key in the wrong order (`CA`), with repeated letters or other characters gets `INVALID_ANSWER`; sending several letters for a `SINGLE` question is also `INVALID_ANSWER`. A multiple-answer question counts as correct only when the key matches exactly. `questionId` is a UUID. `sequence` is an integer 1–2,147,483,647 that increases for each deviceId/questionId pair. Each new Confirm creates a new requestId and a larger sequence; a retry of the same Confirm keeps the **entire payload** unchanged, including the requestId, the sequence and the timestamp.

An answer is only accepted when the device has joined, the session is `QUESTION_ACTIVE`, the questionId is exact and the server has not reached `questionEndsAt`. A valid answer with the newest sequence overwrites the current answer; the deduplication record keeps the payload hash and the ACK in the database and does not store the full content of every change of answer. A message that arrives out of order with a lower sequence does not overwrite a newer answer. Once the question has closed, every new change is rejected.

### Status

```json
{
  "requestId": "96f06b8f-09ef-4b38-aae8-9dd5e2f15c90",
  "deviceId": "device-001",
  "roomCode": "123456",
  "online": true,
  "clientTimestamp": "2026-09-29T09:00:00.000Z"
}
```

Status reports the device state through the backend pipeline; it does not join a room by itself or grant the right to answer. The simulator shows the real connection state of mqtt.js. The Wi-Fi indicator on the web only reflects `navigator.onLine` and does not measure the ESP32's Wi-Fi signal.

## ACK and idempotency

```json
{
  "requestId": "061a7fb4-22a0-4767-b745-ed291ba1bde7",
  "success": true,
  "code": "ANSWER_ACCEPTED",
  "message": "Answer saved",
  "serverTimestamp": "2026-09-29T09:00:15.031Z",
  "roomCode": "123456"
}
```

The backend sends the ACK after the transaction completes. The MQTT PUBACK only confirms that the broker received the packet; it **does not replace** the application ACK above. A device indicates success only after an application ACK with the same requestId. Do not use the `message` field for logic, since its text may change language.

A `ProcessedMqttMessage` record with a unique requestId stops QoS 1/retries from increasing the statistics or rewriting the answer. When a message that was already processed arrives again, the reply is:

```json
{
  "requestId": "061a7fb4-22a0-4767-b745-ed291ba1bde7",
  "success": true,
  "code": "DUPLICATE_MESSAGE",
  "originalCode": "ANSWER_ACCEPTED",
  "message": "Request already processed",
  "serverTimestamp": "2026-09-29T09:00:15.089Z"
}
```

`success` reflects the original result; a duplicate of a rejected message also has `success: false`. Do not assume that every `DUPLICATE_MESSAGE` is an error or a success. Use `success` together with `originalCode`. Do not reuse one requestId for a different payload/action.

The simulator waits 4 seconds and then retries with an unchanged requestId, for at most 3 sends. After about 12 seconds without an ACK the outcome is unknown; the backend may have saved the answer even though the ACK was lost. After reconnecting, the retained room state restores the current question. A new Confirm has a larger sequence, so an old retry message does not overwrite it. Production firmware should store the pending request and the sequence in NVS so they survive a reset; the web simulator stores the sequence per deviceId/questionId in localStorage.

| `code` | Meaning |
|---|---|
| `JOIN_ACCEPTED` | The device is now linked to a participant |
| `ANSWER_ACCEPTED` | The current answer was saved |
| `STATUS_ACCEPTED` | The device state was updated |
| `INVALID_PAYLOAD` | Invalid JSON, schema, topic or ID |
| `DEVICE_NOT_JOINED` | Has not joined the session |
| `ROOM_NOT_FOUND` | The room was not found |
| `SESSION_NOT_ACTIVE` | The session has ended or does not allow the action |
| `QUESTION_NOT_ACTIVE` | The question is not open yet/already closed, or the questionId does not match |
| `QUESTION_EXPIRED` | The server has reached the deadline |
| `INVALID_ANSWER` | The answer is not a canonical A–D key, or has several letters for a single-answer question |
| `DUPLICATE_MESSAGE` | The requestId was already processed; see the original result |
| `STALE_SEQUENCE` | The sequence is not newer than the current answer |
| `STUDENT_ALREADY_JOINED` | The student code already belongs to another device |
| `DEVICE_ALREADY_JOINED` | The device already belongs to another student code |
| `SERVER_ERROR` | Backend error; check the connection and retry according to the policy |

## Retained RoomState / question

```json
{
  "sessionId": "98fbd83a-2b41-40d9-a37a-5529ad3a6285",
  "roomCode": "123456",
  "status": "QUESTION_ACTIVE",
  "serverTimestamp": "2026-09-29T09:00:10.000Z",
  "questionStartedAt": "2026-09-29T09:00:10.000Z",
  "questionEndsAt": "2026-09-29T09:00:40.000Z",
  "currentQuestionIndex": 0,
  "totalQuestions": 3,
  "currentQuestion": {
    "id": "5d44c3d8-817a-438b-9aa1-ac6f99e6d425",
    "content": "Which property does MQTT QoS 1 have?",
    "optionA": "Never resends a message",
    "optionB": "A message may be received more than once",
    "optionC": "Needs no broker",
    "optionD": "Only supports HTTP",
    "type": "SINGLE",
    "durationSeconds": 30,
    "order": 0
  }
}
```

`currentQuestion.type` is `SINGLE` or `MULTIPLE`. For `MULTIPLE`, each A–D key toggles one letter and the device sends the sorted key; the LEDs show the chosen letters (scrolling in pairs when there are more than two). The explanation (`explanation`) is only shown on the web and is never sent to a device. If the session shuffles questions/options, `content` and `optionA`–`optionD` are already in the order shown for that session.

There is no `correctAnswer` while `QUESTION_ACTIVE`. After a question closes, the backend may supply the correct answer to publish the result. The lobby has `currentQuestion: null`, `currentQuestionIndex: -1`, `questionStartedAt: null` and `questionEndsAt: null`. Do not infer the deadline from the time the client received a retained message, because it may be a message from earlier. Read `questionEndsAt` as an absolute value; the backend always has the right to reject if the device clock is off.

State cycle: `LOBBY → QUESTION_ACTIVE → QUESTION_CLOSED → QUESTION_ACTIVE … → FINISHED`. Both MANUAL and TIMER stop accepting answers when the deadline arrives. MANUAL waits for the teacher to choose the next question; TIMER waits 3 seconds to show the result and then opens the next question or finishes. After a backend restart, the schedule is rebuilt from the deadlines in the database.

## Keypad / LED mapping for the firmware

```text
1      2    3         A
4      5    6         B
7      8    9         C
Clear  0    Confirm   D
```

1. Enter the 6 digits of the roomCode; Confirm moves to the student code. Clear deletes one digit.
2. Enter the numeric student code; Confirm publishes the join. A successful ACK moves to the ready state.
3. A/B/C/D choose the answer without sending it. Clear cancels the choice. Confirm sends the answer for the open question.
4. The choice can be changed and Confirmed again before the deadline, increasing the sequence.
5. The two LED digits can only show two characters at once: `123456 → 12 → 34 → 56 → 12`. An odd-length code gets a trailing blank, not a 0. The simulator scrolls every 700 ms.
6. When joined, the left dot is on; the right dot blinks while waiting for an ACK. With no answer chosen it shows the question number (scrolling if there are more than 2 digits); once chosen, it shows A/B/C/D (B and D are drawn as lowercase letters with 7 segments).
7. Holding Clear for 3 seconds erases the session identity in NVS and returns to roomCode entry; this does not erase the Wi-Fi/MQTT credentials provisioned over BLE.

Each new tab is given its own ID; a reload keeps the tab's ID and localStorage stores the sequence. Enter an old ID in the configuration to simulate that device reconnecting. Two clients that try to use the same clientId may be disconnected by the broker in turn.

## Multi-device testing

Create a session, note the room code, then run:

```bash
pnpm simulate --devices=50 --room=123456
pnpm simulate --devices=50 --room=123456 --duplicates
MQTT_URL=mqtt://localhost:1883 MQTT_SIMULATOR_USERNAME=simulator MQTT_SIMULATOR_PASSWORD=simulator-dev-only pnpm simulate --devices=50 --room=123456 --duplicates --timeout=90 --delay=1200
```

The `pnpm simulate` command loads `.env` through `scripts/with-env.mjs`. The script reads **only** `MQTT_SIMULATOR_USERNAME` / `MQTT_SIMULATOR_PASSWORD` for the device account; it does not use the backend's `MQTT_USERNAME` / `MQTT_PASSWORD`. If unset, the default is `simulator` / `simulator-dev-only`. `MQTT_URL` selects the broker.

The script creates a new identity for each run, subscribes to the ACK/state before joining, waits for the teacher to open a question, adds a random delay of 0–1200 ms, chooses A/B/C/D at random and sends it with QoS 1. Each run answers one question and ends; run it again to test a new round. `--duplicates` resends the join and answer payloads that already received an ACK with the same requestId to check the original result/idempotency. The script uses the same retry mechanism (4 seconds, at most 3 times) for a lost ACK.

The JSON result has the counts connected, joined, answered, accepted, rejected, timeout, duplicateAccepted/Rejected/Unexpected, retries, transport errors, the distribution of ACK codes and the p50/p95/max latency. accepted/rejected count ACKs (duplicates included); joined/answered count devices. The exit code is non-zero when joins/answers are missing, on a timeout, an error ACK or a duplicate with the wrong result. When no question is opened within `--timeout` (default 90 seconds) the run ends with a timeout. There is no branch that writes straight to the database.
