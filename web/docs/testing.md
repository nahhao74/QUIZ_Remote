# ClassPulse MVP test report

## Upgrade of 12 Oct 2026: multiple answers, file import, AI, question bank, exams

Run in a Node 22 container (podman) with a temporary PostgreSQL 17.6 and EMQX 5.8.8, separate from the real data.

| Group | Command / how it was checked | Result |
|---|---|---|
| Shared types (answer keys, question reader, duplicates, question analysis, paper codes) | `pnpm --filter @classpulse/shared-types test` | **16/16 passed** |
| MQTT contracts | `pnpm --filter @classpulse/mqtt-contracts test` | **10/10 passed** |
| Backend unit (real Word/PDF/Excel, chapter splitting, the question-generation plan, quality checks, paper shuffling, the schema sent to Gemini/Ollama/Claude, AI source selection, Ollama's NDJSON stream and errors, automatic fallback to Ollama on quota exhaustion) | `pnpm --filter @classpulse/backend test` | **26/26 passed** |
| Frontend | `pnpm --filter @classpulse/frontend test` | **13/13 passed** (added the note about the fallback AI source and the elapsed task time) |
| Device simulator | `pnpm --filter @classpulse/device-simulator test` | **7/7 passed** |
| Firmware C logic | `pnpm test:firmware` | **5/5 groups passed** (added the multiple-answer selection group) |
| PostgreSQL integration | `pnpm test:integration` | **16/16 passed** (10 old + 6 new) |
| Migration on old data | migrate the old schema, insert A–D data, run the new migration | **Passed**: answers kept, the old enum dropped, no schema drift, CHECK rejects a wrong key |
| HTTP smoke + local fake Gemini/Claude API | 24 steps: upload course material, generate questions by ratio, approve/reject, import TXT/Word/Excel/CSV/PDF, AI recognition, paper review, bank, classes, exams, ownership; run once with the `@google/genai` SDK and once with the Anthropic SDK | **24/24 passed** with both (run before the automatic fallback to Ollama was added; that mechanism is covered by a unit test with the real Anthropic SDK and a fake server returning 429) |
| Real AI through Ollama 0.40.3 + `qwen3:4b-instruct`, CPU only (16-thread laptop, 14 GB RAM) | 4 tasks through the backend API; see the section below | **4/4 tasks ran**; quality is uneven, see below |
| Real UI (Chromium 147, production build) | 10 scenarios on the interface, checking console errors and failed requests | **10/10 passed, no errors** |
| Existing end-to-end with a real EMQX | `scripts/tests/e2e.ts` | **10/10 groups passed** |
| Browser simulator ↔ EMQX ↔ backend | a multiple-answer question choosing C, A → sends `AC`; a single-answer question | **Passed**, both graded correctly |
| Build | `pnpm build`, backend/frontend images | **Passed**; the backend image migrates an empty database and starts |

Not tested: real Gemini and Claude calls (the test machine has no GEMINI_API_KEY/ANTHROPIC_API_KEY; the request, stream, structured output and automatic fallback to Ollama were tested with fake APIs), Ollama on a GPU, and building/flashing ESP-IDF and Arduino on a real board.

### Real AI with Ollama, CPU only

Ollama 0.40.3, `qwen3:4b-instruct` (2.5 GB), `OLLAMA_NUM_CTX=32768`; a 16-thread CPU laptop with 14 GB RAM; the NVIDIA driver was not working so everything ran on the CPU. Each task was called through the backend API just like the interface does, with a temporary PostgreSQL.

| Task | Tokens in / out | Time | Result |
|---|---|---|---|
| Generate 6 questions (2 easy, 2 medium, 2 hard, 20 % multiple-answer) from a 2-chapter Word course document | 1,799 / 1,915 | 368 s | 6 questions with correct knowledge and answers, natural Vietnamese, all waiting for review. Problems: it wrote 3 multiple-answer questions instead of 1, the answers clustered on A/B, and one question gave its answer away. Fixed with a per-question plan (difficulty, type, correct-answer position spread evenly over A–D) in the request; rerun: 361 s, difficulty 2/2/2, exactly 1 multiple-answer question (ACD), single-choice answers C, A, B, D, A. Remaining: one question still quotes the correct option verbatim in the stem and one explanation mentions an option letter — the teacher fixes these on review |
| Recognise a messy 3-question paper (`a/`, `(A)`, `A-`, an answer table at the end) | 743 / 562 | 84 s | All 3 questions, answers B, A, BC, question 3 is a multiple-answer question. There was one junk note ("Câu "), which is now filtered out |
| Review a paper with planted errors (an ambiguous question, two correct answers, a wrong key, a weak distractor, two duplicate questions) | 1,382 / 2,609 | 440 s | Caught the ambiguous question 1, the absurd distractor in question 4 and the duplicates 4–5. Missed question 2 (8883 is also an MQTT port) and the wrong key in question 3; it also wrongly concluded that QoS 2 has 3 steps. The 4B model is not reliable enough to check the knowledge in a paper — use Gemini for this feature |
| Analyse the results of a lesson with 24 students (simulated data) | 1,438 / 1,375 | 262 s | Correctly reported a negative KR-20, questions where a distractor was chosen more than the answer, a question that was too easy and a distractor nobody chose, with suggestions for reteaching; it did not realise 8883 is also a valid MQTT port |

Memory: loaded with an f16 context the model takes 7.6 GB and pushes the machine into swap; with `OLLAMA_KV_CACHE_TYPE=q8_0` it takes 5.3 GB (set in the `ollama` service of the compose file). When the Ollama process is killed midway, the task reports "Ollama stopped midway, usually because the server does not have enough RAM…" instead of a confusing JSON error.

---

Application test date: **29 Sep 2026**; firmware was added and the unit tests/build were rerun on **30 Sep 2026**. The Codex execution environment has no Docker daemon, so the runtime services were run directly as PostgreSQL 18.6 and EMQX Community 5.8.8. The Compose configuration was rendered and checked with Docker Compose CLI v2.39.4; building/starting all the containers has to be run again on a machine with Docker.

## Final results

| Group | Command / how it was checked | Result |
|---|---|---|
| MQTT contracts + statistics | `pnpm --filter @classpulse/mqtt-contracts test` | **7/7 passed** |
| Backend unit | `pnpm --filter @classpulse/backend test` | **8/8 passed** |
| Frontend components/hooks | `pnpm --filter @classpulse/frontend test` | **11/11 passed** |
| Device simulator logic | `pnpm --filter @classpulse/device-simulator test` | **6/6 passed** |
| ESP32 firmware logic | `pnpm test:firmware` | **4/4 groups passed** |
| PostgreSQL integration | `pnpm test:integration` with a migrated database | **9/9 passed** |
| Real end-to-end | `node --import tsx scripts/tests/e2e.ts` | **10/10 groups passed** |
| Load generator | 50 devices, duplicates on, maximum delay 100 ms | **50 joins + 50 answers, 0 rejected, 0 timeouts** |
| Production build | `pnpm build` | **Passed** |
| Compose schema | `docker compose --env-file .env.example config --quiet` | **Passed** |
| Real UI check | in-app Chromium on Vite + API + EMQX + PostgreSQL | **Passed** |

Total TypeScript/React unit/component tests: **32/32 passed**, plus **4/4 groups** of C firmware logic. The production build produces a main bundle of about 285 kB and a lazy simulator chunk of about 436 kB before gzip; Vite reports no build errors.

The host firmware test compiles `classpulse_logic.c` with `cc -std=c11 -Wall -Wextra -Werror`, then checks the room/student entry flow, Clear/Confirm, choosing A–D, scrolling even/odd codes in pairs, the sequence limit and deviceId validation. The parts that depend on ESP-IDF/BLE/Wi-Fi/GPIO need the toolchain and a real board to build/flash.

## Backend integration scope

The `services.integration.test.ts` suite runs against a real PostgreSQL and checks:

- registration, login, JWT verification, refresh rotation and replay detection;
- another teacher cannot read/edit a quiz or control a session;
- a session keeps its question snapshot after the original quiz is edited/deleted;
- a valid join, a non-existent room, a duplicate studentCode/deviceId;
- receiving every A/B/C/D, counting only the answer with the newest sequence;
- rejecting a wrong answer, a device that has not joined, a wrong questionId and a deadline overrun;
- two simultaneous QoS 1 deliveries write only once; a requestId reused with a different payload is rejected;
- 50 devices writing almost at the same time lose no answers;
- a snapshot after a reload keeps the deadline; the timer is recovered after a logic restart and advances/finishes by itself.

The tests create their own teacher/quiz/session/device with UUIDs and then delete exactly that test data. The seed/demo data is not reset.

## End-to-end scope

The script `scripts/tests/e2e.ts` uses the running REST API, MQTT TCP through EMQX, PostgreSQL and a real Socket.IO. Ten groups passed:

1. Register/login/profile, the refresh cookie rotating and logout revoking the refresh token.
2. Ownership of quizzes/sessions and a snapshot that does not change when the quiz is edited.
3. Socket.IO authentication, letting the owner join the room and rejecting another teacher.
4. A failing/successful room join, a topic–deviceId mismatch and a duplicate join.
5. Safe 0 statistics, a hidden correctAnswer, the retained question and the server deadline.
6. Changing A/B/C/D, a duplicate request, a stale sequence, an invalid answer/question/device.
7. 50 MQTT devices join and answer almost at the same time, with realtime reaching 51/51 when the main test device is added.
8. Close locks new answers and publishes correct/wrong; manual next and finish.
9. TIMER closes by itself, waits to show the result, opens the next question and finishes without a browser.
10. Logout makes the old refresh cookie unusable.

## Independent load generator result

The command was run against a real room that was `QUESTION_ACTIVE`:

```bash
node --import tsx scripts/simulate-devices/index.ts \
  --devices=50 --room=123456 --duplicates --delay=100
```

Result:

```json
{
  "devices": 50,
  "connected": 50,
  "joined": 50,
  "answered": 50,
  "accepted": 200,
  "rejected": 0,
  "timeout": 0,
  "duplicateAccepted": 100,
  "duplicateRejected": 0,
  "duplicateUnexpected": 0,
  "retries": 0,
  "transportErrors": 0,
  "ackCodes": {
    "JOIN_ACCEPTED": 50,
    "ANSWER_ACCEPTED": 50,
    "DUPLICATE_MESSAGE": 100
  },
  "durationSeconds": 1.3,
  "ackLatencyMs": { "p50": 181, "p95": 371, "max": 405 }
}
```

`accepted=200` consists of 50 joins, 50 answers and 100 duplicate ACKs with `success=true` and the right `originalCode`. The database/realtime still show only 50 new participants and 50 new answers from this run.

## Broker and ACL checks

A direct test against EMQX 5.8.8 confirmed:

- an anonymous connection is refused;
- the simulator may subscribe to its own clientId's ACK;
- the simulator's subscription to another device's ACK is refused;
- the simulator cannot publish a forged ACK;
- the backend connects with its own credential, subscribes to the device topics and publishes the retained room state;
- browser MQTT over WebSocket connects at `/mqtt` and receives a QoS 1 ACK.

## Browser UI check

The demo flow was operated directly:

- log in as `demo@classpulse.local` and load the dashboard from the API;
- open room `123456` and change the next question's duration to 120 seconds;
- the simulator shows the 4×4 keypad and the two 7-segment LEDs correctly;
- enter the roomCode and studentCode `20260001`, and receive `JOIN_ACCEPTED` in 51 ms;
- the teacher sees the participant in realtime and starts the question; the simulator receives the retained question/deadline;
- choose B, Clear, choose A and then Confirm; receive `ANSWER_ACCEPTED` in 50 ms;
- the dashboard changes 0/1 to 1/1 without exposing an individual's choice while the question is open;
- reloading the presentation still keeps the question and the server countdown;
- after the 50-device load, control/presentation show 51/51;
- close publishes answer A, the A/B/C/D distribution and correct/wrong; the presentation updates in realtime.

## Points not verified in this environment

`docker compose up --build` could not be run because the test host has no Docker daemon. It was verified that Compose renders all 5 services (`postgres`, `broker-config`, `emqx`, `backend`, `frontend`), the volumes, the healthchecks and the ports; the Dockerfiles/Compose still need a smoke run on a target machine that has Docker. The environment also has no ESP-IDF or ESP32 board, so the firmware has not been through `idf.py build`, flashing or electrical measurement on real hardware; only the standalone logic was compiled and run on the host.

After cloning on the target machine, the shortest acceptance criterion is:

```bash
cp .env.example .env
docker compose up --build -d
docker compose exec backend pnpm db:seed
docker compose ps
curl -f http://localhost:3000/api/health
```

Then run `pnpm test:e2e` as described in the README and try one simulator tab through `http://localhost/device-simulator`.
