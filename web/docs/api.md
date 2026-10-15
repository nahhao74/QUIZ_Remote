# REST API and Socket.IO

Base URL in development: `http://localhost:3000/api`; through the frontend/Nginx: `http://localhost/api`. Swagger UI is at `/api/docs` and the OpenAPI JSON at `/api/docs-json`. Requests with a body use `Content-Type: application/json`.

This document follows the controllers/DTOs in `apps/backend/src`. Most shared response types live in `packages/shared-types`. There is no REST endpoint for students to submit answers: join/answer use [MQTT](mqtt-protocol.md).

## Authentication and cookies

Quizzes, questions, the teacher profile and sessions all require:

```http
Authorization: Bearer <accessToken>
```

Register/login/refresh return `AuthResponse`:

```json
{
  "accessToken": "<JWT-valid-15-minutes>",
  "teacher": {
    "id": "b1ec2dad-e578-4975-82ea-f0011142218c",
    "email": "teacher@example.com",
    "name": "Teacher"
  }
}
```

The refresh token is not in the JSON. The server sets a `refreshToken` cookie: HttpOnly, SameSite=Lax, Path=/api/auth, Max-Age 7 days, Secure when `COOKIE_SECURE=true`. Browsers call fetch with `credentials: 'include'`; CLI clients keep a cookie jar. Refresh and logout read the cookie, never a refresh token in the body/Authorization. Every successful refresh issues a new access token and rotates the cookie.

| Method / path | Body | Success | Main errors |
|---|---|---|---|
| `POST /auth/register` | `{ "email", "password", "name" }` | **201** AuthResponse + cookie | 400 validation/email already used; 409 on a unique clash in concurrent writes |
| `POST /auth/login` | `{ "email", "password" }` | **200** AuthResponse + cookie | 400 validation; 401 wrong credentials |
| `POST /auth/refresh` | None; send the cookie | **200** AuthResponse + new cookie | 401 missing, wrong, expired or already-used token |
| `POST /auth/logout` | None; send the cookie if present | **200** `{ "success": true }`, clears the cookie | Can be called when the cookie is gone |
| `GET /teachers/me` | — | **200** `{ id, email, name }` | 401 invalid token |
| `PATCH /teachers/me` | `{ "name": "New name" }` | **200** `{ id, email, name }` | 400 validation; 401 |

The email is trimmed and lowercased. Registration: a valid email of at most 254 characters; a name of 1–100 characters after trimming; a password of 8–72 characters that does not exceed 72 UTF-8 bytes. Login passwords are 1–72 characters. The profile API currently only changes the name, not the email or password.

Using a revoked/expired refresh token revokes the other active tokens of the same family. The web app merges concurrent refresh requests into one. Logout does not revoke the JWT access token immediately; an already issued token stops working after at most 15 minutes.

## Quizzes and questions

Every `:id`/`:questionId` path segment below must be a UUID. Another teacher's quiz, or a soft-deleted one, returns 404. The list has no pagination/filter; it only returns the current teacher's active quizzes, sorted by updatedAt descending.

### The `QuestionInput` request

```json
{
  "content": "Which wireless technologies are built into the ESP32? Choose all correct answers.",
  "optionA": "Wi-Fi",
  "optionB": "Bluetooth Low Energy",
  "optionC": "5G",
  "optionD": "LoRa",
  "type": "MULTIPLE",
  "correctAnswer": "AB",
  "explanation": "The ESP32 has Wi-Fi and Bluetooth built in; 5G and LoRa need a separate module.",
  "knowledge": "ESP32 wireless connectivity",
  "topic": "Chapter 2 – IoT hardware",
  "difficulty": "MEDIUM",
  "durationSeconds": 40,
  "order": 0
}
```

`content` is 1–4000 characters; each option is 1–1000; `durationSeconds` is an integer 5–3600; `order` is an integer 0–1000. These fields and `correctAnswer` are required when creating a question.

- `type`: `SINGLE` (default) or `MULTIPLE`. A multiple-answer question lets the student choose several options and counts as correct only when **every correct option and nothing else** is chosen.
- `correctAnswer` is the **canonical key**: one or more letters A–D in alphabetical order, without repeats (`B`, `AC`, `ABD`). A `SINGLE` question must have exactly one letter; sending `AB` for a single-answer question returns 400. An older client that sends `"correctAnswer": "B"` without a type still works as before.
- Optional: `explanation` (the solution, ≤ 4000, shown to the class after the question closes), `knowledge` (the knowledge tested, ≤ 300), `topic` (chapter/topic, ≤ 200), `difficulty` (`EASY`/`MEDIUM`/`HARD` or null), `origin` (`MANUAL`/`IMPORT`/`AI`, only to show the source). The DTO accepts an optional UUID `id` for compatibility with editor data, but create generates a new UUID and update does not change the ID from the body. PATCH on a question accepts a subset of these fields.

### The `QuizInput` request

```json
{
  "title": "Introduction to IoT",
  "description": "Quick quiz",
  "questions": [
    {
      "content": "Which communication model does MQTT use?",
      "optionA": "Publish/subscribe",
      "optionB": "Peer-to-peer only",
      "optionC": "Request/response only",
      "optionD": "UDP broadcast only",
      "correctAnswer": "A",
      "durationSeconds": 30,
      "order": 0
    }
  ]
}
```

`title` is 1–200 characters and required on creation. `description` is optional, at most 4000, and defaults to an empty string. `questions` is optional, at most 200 items; an empty quiz can be created but no session can be created from it yet. PATCH on a quiz accepts a subset; if `questions` is sent, **the whole current list of questions is replaced** by the new records and the old ones are soft-deleted. If `questions` is not sent the old list is kept.

| Method / path | Body | Success |
|---|---|---|
| `GET /quizzes` | — | **200** QuizRecord[] |
| `POST /quizzes` | QuizInput | **201** QuizRecord |
| `GET /quizzes/:id` | — | **200** QuizRecord, including questions |
| `PATCH /quizzes/:id` | Partial QuizInput | **200** QuizRecord |
| `DELETE /quizzes/:id` | — | **200** `{ "success": true }`; soft delete |
| `POST /quizzes/:id/duplicate` | — | **201** new QuizRecord; the title gets a ` (bản sao)` ("copy") suffix |
| `POST /quizzes/:id/questions` | QuestionInput | **201** QuestionRecord |
| `PATCH /quizzes/:id/questions/:questionId` | Partial QuestionInput | **200** QuestionRecord |
| `DELETE /quizzes/:id/questions/:questionId` | — | **200** `{ "success": true }`; soft delete |

A QuizRecord actually contains `id, teacherId, title, description, createdAt, updatedAt, deletedAt, questions`. A QuestionRecord contains `id, quizId, content, optionA, optionB, optionC, optionD, type, correctAnswer, explanation, knowledge, topic, difficulty, origin, durationSeconds, order, deletedAt`. Time fields are serialised as ISO-8601; `deletedAt` of an active record is null. Questions in a quiz are sorted by `order` ascending and exclude deleted ones. These endpoints return the correct answers of the quiz document to the owning teacher for authoring; the rules that hide answers during a session are in SessionSnapshot.

Common errors for the group: 400 validation/invalid UUID; 401 not logged in; 404 not owned/not found; 409 unique conflict where relevant.

## Sessions: create, control and report

Create a session from a quiz with at least one question:

```json
{
  "quizId": "0ad516d4-e23d-48e1-b8f6-3c067b2f57d1",
  "mode": "MANUAL",
  "durationSeconds": 30,
  "classroomId": "8a1f0d8e-2a2b-4c1e-9a77-3b1d2f6c9e10",
  "shuffleQuestions": true,
  "shuffleOptions": true
}
```

`quizId` is required and must be the UUID of one of the teacher's quizzes. `mode` is optional, `MANUAL`/`TIMER`, default MANUAL. `durationSeconds` is optional, an integer 5–3600; if omitted each question uses its time from the quiz. A session copies the questions, so editing the quiz later does not change a session that was already created. `classroomId` (optional) assigns the session to a class: the report shows full names by device code and adds the scores to the class statistics. `shuffleQuestions`/`shuffleOptions` (default false) shuffle the question order and the A–D positions for this session only; a question whose options depend on position ("All of the above", "Both A and B") keeps its option order, and references such as "answer B" in the explanation are rewritten to the new position.

| Method / path | Body | Success |
|---|---|---|
| `GET /sessions` | — | **200** SessionSnapshot[], history plus the current session; createdAt descending |
| `POST /sessions` | `{ quizId, mode?, durationSeconds?, classroomId?, shuffleQuestions?, shuffleOptions? }` | **201** SessionSnapshot in LOBBY |
| `GET /sessions/:id/analysis` | — | **200** SessionAnalysis: per-question analysis, each student's score, the latest AI analysis |
| `POST /sessions/:id/ai-analysis` | Not needed | **201** AiJob `ANALYZE_SESSION`; 400 if there is no closed question/student yet |
| `GET /sessions/:id` | — | **200** SessionSnapshot |
| `GET /sessions/:id/participants` | — | **200** Participant[] for the state of the current question |
| `GET /sessions/:id/stats` | — | **200** QuestionStats of the current question |
| `GET /sessions/:id/report` | — | **200** SessionSnapshot; available even when the session has not finished |
| `GET /sessions/:id/export.csv` | — | **200** CSV file of the results; `Content-Disposition: attachment` |
| `POST /sessions/:id/start` | Not needed | **201** SessionSnapshot, opens question index 0 from LOBBY |
| `POST /sessions/:id/open` | `{ questionId?: UUID, index?: number }` | **201** SessionSnapshot, opens a question that was never opened |
| `POST /sessions/:id/close` | Not needed | **201** SessionSnapshot, closes the open question |
| `POST /sessions/:id/next` | Not needed | **201** SessionSnapshot, opens the next question or finishes after the last |
| `POST /sessions/:id/finish` | Not needed | **201** SessionSnapshot in FINISHED |
| `PATCH /sessions/:id/settings` | `{ mode?: "MANUAL"|"TIMER", durationSeconds?: number }` | **200** SessionSnapshot |

The control POSTs return **201** by NestJS controller default, not 200/204. Every request checks the teacherId; the roomCode is never used to grant control.

Control rules:

- `start` only works from LOBBY. `next` from LOBBY returns 409; start or open first.
- `open`: `questionId` is the **SessionQuestion ID** within the session; it takes priority when `index` is also given. The index starts at 0; when both are omitted, currentQuestionIndex + 1 is used. An index/questionId outside the session returns 400; a question that was already opened returns 409. There is no endpoint that lists every SessionQuestion ID in advance; you can open by index.
- `next` or `open` while a question is still ACTIVE closes the old question immediately. `next` past the last question finishes the session; `open` out of range returns 400.
- `close` when already CLOSED is idempotent and still succeeds; from LOBBY it returns 409. `finish` when already FINISHED still succeeds. Any other action on FINISHED returns 409.
- The deadline is always set by the server and applies to both MANUAL and TIMER. TIMER waits 3 seconds after closing a question and then calls next/finish; MANUAL waits for the teacher.
- A settings duration applies to questions opened afterwards; it does not extend the running question. Turning on TIMER while CLOSED sets nextQuestionAt = current server time + 3 seconds; switching to MANUAL clears the automatic advance schedule. There is no API to reset the duration override to null.

### SessionSnapshot

```json
{
  "id": "96873534-7d0d-4457-a7d4-2fdc459158a9",
  "quizId": "0ad516d4-e23d-48e1-b8f6-3c067b2f57d1",
  "title": "Introduction to IoT",
  "roomCode": "123456",
  "status": "QUESTION_ACTIVE",
  "mode": "MANUAL",
  "currentQuestionIndex": 0,
  "totalQuestions": 1,
  "currentQuestion": {
    "id": "78bb357f-d1f1-4d7c-855e-c40f0f598c60",
    "content": "Which communication model does MQTT use?",
    "optionA": "Publish/subscribe",
    "optionB": "Peer-to-peer only",
    "optionC": "Request/response only",
    "optionD": "UDP broadcast only",
    "durationSeconds": 30,
    "order": 0
  },
  "questionStartedAt": "2026-09-29T09:00:00.000Z",
  "questionEndsAt": "2026-09-29T09:00:30.000Z",
  "nextQuestionAt": null,
  "serverTime": "2026-09-29T09:00:05.000Z",
  "createdAt": "2026-09-29T08:59:00.000Z",
  "finishedAt": null,
  "participantCount": 1,
  "answerCount": 1,
  "participants": [
    {
      "id": "40e972d0-f20d-437b-aa02-4c0e7ebc56aa",
      "deviceId": "device-001",
      "studentCode": "2026001",
      "joinedAt": "2026-09-29T08:59:30.000Z",
      "answered": true
    }
  ],
  "stats": {
    "total": 1,
    "answered": 1,
    "unanswered": 0,
    "counts": { "A": 1, "B": 0, "C": 0, "D": 0 },
    "percentages": { "A": 100, "B": 0, "C": 0, "D": 0 },
    "correct": 0,
    "incorrect": 0,
    "correctPercentage": 0,
    "incorrectPercentage": 0
  },
  "results": []
}
```

In LOBBY: currentQuestionIndex=-1, currentQuestion=null and the deadlines are null. While ACTIVE, `currentQuestion` has no `correctAnswer` and a participant has no `answer`/`isCorrect`. The A/B/C/D distribution is returned; correct/incorrect has not been published yet, so it is 0. When CLOSED/FINISHED, `currentQuestion` has `correctAnswer` and a participant who answered has `answer`/`isCorrect`. `results` only holds closed questions; each item is `{ question: PublicQuestion, stats: QuestionStats }` with the correct answer.

A snapshot also has `classroomId`, `classroomName`, `examId` and `variantCode` (the paper code when the session was opened from an exam); `currentQuestion.type` tells whether the question is single- or multiple-answer; a participant has `studentName` when the session is assigned to a class. When CLOSED/FINISHED the question also has `explanation`. For a multiple-answer question, `answer` is a key such as `AC`; `counts`/`percentages` count the students who chose each letter (the total can exceed 100 %), while `correct` only counts keys that match exactly.

Percentages use answered as the denominator, are rounded to two decimals and are 0 when answered=0. The report returns the snapshot and the result of each question and creates no extra leaderboard. A snapshot always includes `serverTime` to synchronise countdowns. A question's ID in a snapshot differs from the question's ID in the original quiz.

The `export.csv` endpoint returns one row per student with the room code, quiz title, student code, full name (from the class list if any), device ID, join time, the answer/result for each question, the total number of correct answers and the score out of 10. The CSV uses CRLF, quotes every cell and adds a UTF-8 BOM so Excel shows Vietnamese correctly. Text cells starting with `=`, `+`, `-` or `@` are neutralised against formula injection. Only the teacher who owns the session can download the file.

## Socket.IO for teachers

The `/socket.io/` endpoint is on the same origin as the frontend; the backend on port 3000 also serves it. The default namespace is `/`, with WebSocket and polling support. The MQTT simulator does not use Socket.IO.

```ts
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000', {
  auth: { token: accessToken },
  transports: ['websocket', 'polling'],
});

socket.on('connect', () => {
  socket.emit('session:join', { sessionId }, (ack: {
    success: boolean;
    message?: string;
  }) => {
    if (!ack.success) console.error(ack.message);
  });
});
socket.on('session:update', snapshot => renderSnapshot(snapshot));
```

| Event | Direction / payload | Result |
|---|---|---|
| Handshake | Client auth `{ token: accessToken }` | Wrong/missing token: `connect_error`, message `Unauthorized` |
| `session:join` | Client → server `{ sessionId: UUID }` | Callback `{ success: true }`; the server immediately emits `session:update` |
| `session:join` with bad data | Client → server | `{ success: false, message: "Invalid sessionId" }` |
| `session:join` without permission/resource | Client → server | `{ success: false, message: "Session not found or unauthorized" }` |
| `session:update` | Server → client SessionSnapshot | After a join and after a change to participants/answers/state/settings |

The server checks the token again on join, confirms ownership and lets a socket follow only one `session:{id}` room at a time; joining a new session leaves the old session's room. The snapshot is read again after entering the room so no change is missed during the join. An expired token makes the server disconnect; the client refreshes through the cookie, updates `socket.auth.token`, reconnects and emits session:join again.

There is no Socket.IO event for sending answers or controlling the session; teacher actions use REST. There is no per-second countdown broadcast: the browser renders it from the server deadline and refreshes through snapshots. After a reload/reconnect the REST snapshot must be fetched again; the frontend already implements a 5-second polling fallback when the socket is down.

## Errors, validation and limits

DTOs enable whitelist, forbidNonWhitelisted and transform: a field outside the DTO gives 400; JSON numbers must be integers within the limits and a string must not be sent in place of a number. A bad path UUID gives 400. Endpoints without a DTO body (for example start/finish) do not use any body fields to control behaviour.

Errors that go through the exception filter:

```json
{
  "statusCode": 409,
  "message": "Phiên đã kết thúc.",
  "requestId": "8cb6f76d-cf4f-4f88-96bf-e0b9efb471ae",
  "timestamp": "2026-09-29T09:01:00.000Z"
}
```

The `message` text is Vietnamese, as in the interface (here: "The session has ended."). `message` can be a string, a list of validation errors or a health object. The `x-request-id` header is present on the response. The rate-limit/Origin middleware returns `{ statusCode, message }` directly, without timestamp/requestId in the body; the requestId is still in the header.

| Status | Meaning |
|---:|---|
| 400 | Bad DTO/UUID, empty quiz when creating a session, question parameter out of range, email already used |
| 401 | Missing/wrong/expired access or refresh token, wrong login credentials |
| 403 | The Origin of a state-changing request is not allowed |
| 404 | The resource does not exist, was soft-deleted or belongs to another teacher |
| 409 | Invalid state transition, reopening an old question, unique conflict/room code allocation |
| 413 | Uploaded file larger than 20 MB or extracted content too large |
| 429 | Rate limit exceeded (read the Retry-After header, in seconds) or more than 3 unfinished AI tasks |
| 500 | Internal error; the response contains no stack/password/token |
| 503 | Health reports the database or MQTT is not ready; AI endpoints when no AI source is configured |

By default each IP gets 20 login/register requests per minute (the same bucket) and 600 requests per minute for the other endpoints. Adjust through AUTH_RATE_LIMIT/API_RATE_LIMIT. The limiter currently lives in the memory of a single backend. CORS allows the origins in FRONTEND_ORIGIN, or CORS_ORIGIN if FRONTEND_ORIGIN is not set; the list is comma-separated. Requests without an Origin are handled normally subject to the corresponding auth requirements.

## Health

`GET /health` needs no token. When PostgreSQL and MQTT are ready it returns HTTP 200:

```json
{
  "status": "ok",
  "api": "up",
  "database": "up",
  "mqtt": "up",
  "ai": "configured",
  "serverTime": "2026-09-29T09:00:00.000Z"
}
```

If MQTT_DISABLED=true, mqtt is `disabled` and health only requires the database. `ai` is `configured` when Gemini, Ollama or Claude is configured, otherwise `disabled`; AI does not affect the ok/degraded status. On failure it returns HTTP 503 with the common error envelope, whose `message` field is an object like the one above with status=`degraded` and database/mqtt=`down`. Health proves the API is responding, the database accepts `SELECT 1` and the MQTT client is connected; it is not a substitute for an end-to-end test.

## Importing questions from a file

Upload uses `multipart/form-data` with a single `file` field, at most 20 MB. The result is a draft for the teacher to check in the editor; nothing is stored until `POST/PATCH /quizzes` is called.

| Method / path | Body | Success |
|---|---|---|
| `POST /imports/questions` | file `.txt`, `.docx`, `.xlsx`, `.csv`, `.pdf` | **201** ImportResult |
| `POST /imports/questions/ai` | file `.docx`, `.pdf` (scanned PDFs included), `.txt` | **201** AiJob `EXTRACT_QUESTIONS`; `result` is an ImportResult |
| `GET /imports/template.xlsx` | — | **200** sample Excel file (an instruction sheet, drop-down lists for type/difficulty) |
| `GET /imports/template.docx` | — | **200** sample Word file |

```json
{
  "title": "iot-question-bank",
  "description": "",
  "sourceName": "iot-question-bank.docx",
  "format": "docx",
  "questions": [{ "content": "…", "optionA": "…", "optionB": "…", "optionC": "…", "optionD": "…", "type": "MULTIPLE", "correctAnswer": "AC", "explanation": "", "knowledge": "", "topic": "Chapter 1", "difficulty": null, "origin": "IMPORT", "durationSeconds": 30, "order": 0 }],
  "warnings": ["Câu 2 (dòng 8): chưa chọn đáp án đúng."]
}
```

The warning text is Vietnamese like the rest of the interface (here: "Question 2 (line 8): no correct answer chosen.").

The text reader (TXT/Word/PDF) recognises the Vietnamese keywords of the interface: `Câu N:`/`Question N`/`N.` for a question, options `A.`/`A)`/`(A)` one per line or all on one line, a line `Đáp án: B` or `Đáp án: A, C` (answer), a `*` before the correct option, an answer table at the end of the document (`1-A, 2-C`, `1A 2C`, or two lines `Câu | 1 | 2` / `Đáp án | A | C`), a "Hướng dẫn giải" (solution guide) section (`Câu 2: Chọn C vì…`), and the optional lines `Giải thích:` (explanation), `Kiến thức:` (knowledge), `Chủ đề:` (topic), `Độ khó:` (difficulty: Dễ/Trung bình/Khó = easy/medium/hard, Nhận biết/Thông hiểu/Vận dụng = recall/understand/apply, or a label such as `[NB]`), `Loại:` (type), `Thời gian:` (time). Word also recognises a correct option that is underlined, coloured, highlighted or bold, chapter headings in Heading styles, and automatically numbered questions. Excel/CSV is read one question per row by column name (STT, Câu hỏi, A–D, Đáp án, Loại, Thời gian, Độ khó, Chủ đề, Kiến thức, Lời giải); the answer can be a letter or a number 1–4. Old `.doc`/`.xls` files return 400 with instructions to re-save in the new format.

## AI assistant

The AI source is chosen through environment variables: Google Gemini (`GEMINI_API_KEY`, default `gemini-3.8-flash`, with a free tier limited per minute/day), local Ollama (`OLLAMA_URL`, default `qwen3:4b-instruct`) or Anthropic Claude (`ANTHROPIC_API_KEY`, default `claude-opus-5-5`); `AI_PROVIDER` chooses when several sources exist. Every task runs in the background and is tracked by an AiJob; a task left unfinished when the backend restarts is marked FAILED. Each teacher can have at most 3 unfinished tasks.

```json
{
  "id": "…", "kind": "GENERATE_QUESTIONS", "status": "RUNNING", "progress": 50,
  "error": null, "result": null, "input": { "questionCount": 20 },
  "documentId": "…", "quizId": null, "sessionId": null, "examId": null,
  "model": "gemini-3.8-flash", "inputTokens": 0, "outputTokens": 0,
  "createdAt": "…", "startedAt": "…", "finishedAt": null
}
```

| Method / path | Body | Success |
|---|---|---|
| `GET /ai/status` | — | **200** `{ enabled, provider: "gemini" \| "ollama" \| "anthropic" \| null, model, fallback: { provider, model } \| null }`; `fallback` is Ollama when both a cloud source and `OLLAMA_URL` are configured |
| `GET /ai/jobs?kind=` | — | **200** the most recent AiJob[] |
| `GET /ai/jobs/:id` | — | **200** AiJob (poll every 2 seconds until SUCCEEDED/FAILED) |
| `POST /ai/documents` | file `.pdf`, `.docx`, `.txt`, `.md` | **201** SourceDocument including the chapters it recognised |
| `GET /ai/documents` / `GET /ai/documents/:id` / `DELETE /ai/documents/:id` | — | List / details / soft delete of a document |
| `POST /ai/generate` | GenerateQuestionsRequest | **201** AiJob `GENERATE_QUESTIONS`; `result = { created, counts }` |
| `GET /ai/generated?status=PENDING&jobId=` | — | **200** GeneratedQuestion[] (PENDING/APPROVED/REJECTED) with hints about duplicates in the bank |
| `GET /ai/generated/count` | — | **200** `{ pending }` |
| `PATCH /ai/generated/:id` | the question fields | **200** the edited proposal (only while PENDING) |
| `POST /ai/generated/approve` | `{ ids, quizId? \| newQuizTitle?, durationSeconds? }` | **201** `{ quizId, quizTitle, approved }` |
| `POST /ai/generated/reject` / `reopen` | `{ ids }` | **201** `{ rejected }` / `{ reopened }` |

```json
{
  "documentId": "…", "sectionIndexes": [0, 1], "questionCount": 20,
  "easyPercent": 40, "mediumPercent": 40, "hardPercent": 20,
  "multiplePercent": 10, "instructions": "Prefer real-world examples", "quizId": "…"
}
```

The three difficulty percentages must add up to 100; the number of questions is 1–60; the chosen chapters total at most 500,000 characters. Questions are written in batches of 12 and the number per difficulty level is split exactly; the AI avoids repeating questions already written in the run and those already in `quizId`. Each proposed question has an explanation (`explanation`), the knowledge tested (`knowledge`), a chapter (`topic`) and a quotation from the material (`sourceExcerpt`). **A proposed question enters no question set until approve is called**; approve rechecks the answer and the limit of 200 questions per set. A scanned PDF is stored as a file and sent to the AI as a PDF document (Gemini/Claude; Ollama does not support image-only PDFs).

Data sent to an external AI service (Gemini/Claude; Ollama processes everything on the server): the content of the chosen chapters (question generation), the file to recognise (AI import), the question text (quality review) and aggregated figures without student names/codes (result analysis).

## Question bank

| Method / path | Query | Success |
|---|---|---|
| `GET /bank/questions` | `search, quizId, difficulty (EASY/MEDIUM/HARD/UNSET), type, topic, origin` | **200** `{ total, items: BankQuestion[] (at most 500), topics }` |
| `GET /bank/duplicates` | `threshold` (0.5–0.99, default 0.8), `quizId` | **200** pairs `{ score, stem, options, kind, a, b }` |

Search ignores accents and case; every word of the query must appear in the question, options, topic, knowledge, explanation or set name. Similarity = 0.7 × stem + 0.3 × options (character-trigram comparison, independent of option order). `kind`: `EXACT` (≥ 97 %), `NEAR`, `STEM` (same stem ≥ 90 % but different options). Delete a duplicate with `DELETE /quizzes/:id/questions/:questionId`.

## Quality review and result analysis

| Method / path | Success |
|---|---|
| `GET /quizzes/:id/quality` | **200** QuizQualityReport: automatically detected problems, the distribution of answer positions/difficulty/question type, the latest AI review, the analysis of the results of finished sessions |
| `POST /quizzes/:id/ai-review` | **201** AiJob `REVIEW_QUIZ`; `result` has a score 0–100, comments, each question (OK/REVIEW/FIX), problems by group, a rating of each distractor, rewrite suggestions and groups of duplicate questions |

Automatic checks (no AI needed): identical options, "All of the above"/"Both A and B", an unusually long correct answer, negative questions that are not capitalised, multiple-answer questions that do not say so, questions that refer to a figure/table (the device only shows text), very short questions, duplicate questions in the paper, answers concentrated in one position. The AI adds: ambiguous questions, missing data, several possibly correct answers, a suspected wrong answer, duplicate content by meaning, weak distractors/giveaway options and spelling errors.

Result analysis (classical test theory): the proportion correct p, the discrimination D (top 27 % of scores minus bottom 27 %), the item–score correlation, how often each option is chosen in each group, warnings about ineffective distractors (< 5 % choose it), distractors that attract the strong group, a distractor chosen more than the correct answer, the KR-20 reliability and the score distribution on a 10-point scale. The report for a question set merges the finished sessions that used exactly the current questions (matched by ID or content) and maps answers back through every shuffle, so fixing a wrong answer key regrades the old sessions in the report.

## Classes

| Method / path | Body | Success |
|---|---|---|
| `GET /classes` / `POST /classes` | `{ name, description? }` | List / **201** Classroom |
| `GET /classes/:id` / `PATCH` / `DELETE` | `{ name?, description? }` | Classroom with students / soft delete |
| `POST /classes/:id/students` | `{ students: [{ code: "01", name, externalId? }], replace? }` | **201** Classroom (upsert by code, `replace` replaces everything) |
| `PATCH` / `DELETE /classes/:id/students/:studentId` | the student fields | Classroom |
| `POST /classes/:id/students/import` | file `.xlsx`/`.csv` | **201** `{ students, warnings }` for a preview; not saved yet |
| `GET /classes/:id/report` | — | **200** ClassReport: finished sessions, each student's score per session, the average score |
| `GET /classes/:id/report.xlsx` | — | **200** Excel score sheet |

`code` is the two-digit code 01–99 that a student enters on the keypad to join. The list file needs a "Họ và tên" (full name) column; "STT" (number) is used as the device code, and a missing/duplicate one is given the next free code automatically.

## Exams

| Method / path | Body | Success |
|---|---|---|
| `GET /exams` / `POST /exams` | `{ quizId, title, description?, variantCount (1–24), shuffleQuestions, shuffleOptions, durationSeconds? }` | List / **201** Exam |
| `GET /exams/:id` / `DELETE /exams/:id` | — | Exam with its paper codes and sessions / soft delete |
| `GET /exams/:id/variants/:code` | — | **200** the paper for a code: question order, options, answers and the corresponding original questions |
| `GET /exams/:id/papers.docx?code=` | — | **200** a printable paper (Word), for one code or all codes, each code starting on a new page |
| `GET /exams/:id/answer-key.xlsx` | — | **200** the answers for every paper code and a table mapping to the original questions |
| `POST /exams/:id/sessions` | `{ classroomId?, variantCode?, mode?, durationSeconds? }` | **201** SessionSnapshot; leave variantCode empty to use the least-used paper code |
| `GET /exams/:id/report` / `report.xlsx` | — | Per-class statistics (mean, median, standard deviation, pass rate, grading) and the percentage correct per question per class / Excel score sheet |
| `POST /exams/:id/ai-analysis` | — | **201** AiJob `ANALYZE_EXAM` (overall commentary and a comparison between classes) |

Creating an exam copies the questions of the set at that moment, so editing the question set later does not change the paper codes. Paper codes are numbered 101, 102… and are regenerated identically from the seed (exam ID + paper code). Grading: excellent (Giỏi) ≥ 8, good (Khá) 6.5–7.9, average (Trung bình) 5–6.4, weak (Yếu) 3.5–4.9, poor (Kém) < 3.5.
