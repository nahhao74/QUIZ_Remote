# ClassPulse — an interactive classroom with ESP32 devices

MVP monorepo: a teacher creates a quiz, opens a room and presents it; students use a simulated 4×4 keypad to join and confirm A/B/C/D over MQTT. NestJS validates the data, stores it in PostgreSQL, sends the ACK and updates the web through Socket.IO. The interface is in Vietnamese; no student accounts are needed. Button and menu names below are shown as they appear in the interface, followed by an English gloss in parentheses.

Besides the basic flow, the system provides:

- **Single- or multiple-answer questions** — a multiple-answer question is correct only when all the right options, and nothing else, are chosen; on the keypad A–D toggle each option.
- **Importing questions from Word, Excel, PDF, TXT/CSV** — answers are recognised from an "Đáp án" (answer) line, an answer table at the end of the paper, and underlined or coloured options in Word; sample files and AI recognition are available for difficult documents and scanned PDFs.
- **AI assistant for question writing** (free Gemini, unlimited local Ollama, or Claude) — upload course material, choose chapters, the number of questions and the easy/medium/hard ratio; the AI proposes questions with explanations and the knowledge being tested, and **waits for teacher approval** before anything enters a question set.
- **Question bank** — accent-insensitive search across every question set and detection of duplicate or near-duplicate questions.
- **Quality review** — automatic and AI checks: ambiguous questions, missing data, several possibly correct answers, duplicated content, weak distractors; plus analysis of results (difficulty, discrimination, distractor effectiveness, KR-20).
- **Exam management** — shuffle questions and options into several paper codes, print Word papers, Excel answer keys, open exam sessions per class, per-class score statistics and AI commentary.

## Running on a new machine

Requirements: Docker Engine/Desktop with **Compose v2**, 4 GB RAM recommended. Node.js **22 LTS** and **pnpm 10.17.1** are only needed for development or for running commands outside the containers. After installing Node, pnpm can be installed with `corepack enable && corepack prepare pnpm@10.17.1 --activate`.

```bash
cp .env.example .env
docker compose up --build -d
docker compose exec backend pnpm db:seed
```

If the Docker CLI on your machine is really rootless Podman, install the localhost proxy once so you can use a URL without a port number:

```bash
sudo ./scripts/install-localhost-proxy.sh
```

The script uses Apache if Apache already holds port 80; if the port is free it installs a socket proxy that only listens on loopback. Either way `http://localhost` is forwarded to the rootless frontend at `127.0.0.1:8080`. A rootful Docker Engine can change the frontend mapping to `80:80` and does not need this proxy.

The backend runs `prisma migrate deploy` by itself before starting. Seeding is a separate command that can be re-run without overwriting the demo account or resetting the progress of an existing room. Wait until every service is healthy with `docker compose ps`.

| Address | Purpose |
|---|---|
| http://localhost | Teacher web app |
| http://localhost/device-simulator | ESP32 simulator in the browser |
| http://localhost:3000/api/docs | Swagger UI |
| http://localhost:3000/api/docs-json | OpenAPI JSON |
| http://localhost:3000/api/health | Health of the API / PostgreSQL / MQTT |
| http://localhost:18083 | EMQX Dashboard |

**Development** account created by the seed: `demo@classpulse.local` / `Demo@12345`. EMQX Dashboard: `admin` / `Admin-dev-only-123`. Other teachers can register themselves in the web app. Each teacher can only read, edit and control their own data.

### Daily start/stop on a machine that uses Podman

The machine has Compose installed at `.runtime/docker-compose`, and Apache forwards `http://localhost` to the frontend. Run these in the project folder:

```bash
cd /var/www/html
export DOCKER_HOST=unix:///run/user/$(id -u)/podman/podman.sock
./.runtime/docker-compose --profile ollama up -d     # start (drop --profile ollama if you do not use local AI)
./.runtime/docker-compose ps                         # wait about 1 minute; every service must be "healthy"
./.runtime/docker-compose --profile ollama stop      # stop; the data is kept
```

After starting, open http://localhost. After editing the source code, add `--build` to the start command to rebuild the images.

**http://localhost shows 503 (Service Unavailable):**

- Just started: wait for the backend to finish starting.
- The machine's Wi-Fi IP changed (different network, router restart): EMQX only opens MQTT port 1883 on the address in `MQTT_TCP_BIND_ADDRESS` in `.env`. If that address no longer exists EMQX does not start, and the backend and frontend do not start either. Look up the new IP with `ip -4 addr show` (for example the Wi-Fi card `wlp3s0`), set `MQTT_TCP_BIND_ADDRESS=<new IP>` in `.env`, run the start command again and reconfigure the ESP32 devices with the new IP. It is best to give the machine a fixed IP in the router.
- To see the actual error: `./.runtime/docker-compose logs --tail 50 backend emqx`.

### Trying out a lesson

1. Log in to the teacher web app. Choose the quiz **Khám phá thế giới công nghệ** (Exploring the world of technology) and preview or edit it. When creating or editing a quiz, use **Nhập từ file** (Import from file) to load questions quickly from Word, Excel, PDF or TXT; the **File mẫu** (Sample file) button shows the exact format.
2. Choose **Mở phiên học** (Start session), then set the control mode and the time. The demo room `123456` is also available in the history after seeding.
3. In the lobby, open **Trình chiếu** (Presentation) in a separate tab; it can go fullscreen. That tab shares the teacher's login session.
4. Open `/device-simulator`. Each tab creates its own deviceId; open more tabs to simulate several students.
5. On the keypad enter the 6-digit room code → **Confirm** → the student code (for example `20260001`) → **Confirm**. Wait for the `JOIN_ACCEPTED` ACK. Long codes scroll in pairs across the two 7-segment LEDs.
6. The teacher chooses **Bắt đầu** (Start). The simulator receives the current question from the retained MQTT room state.
7. Press A/B/C/D and then **Confirm** to send. **Xóa** (Clear) cancels a choice that has not been sent. A student can choose again and Confirm before the deadline; only the valid submission with the newest sequence counts.
8. Watch the answered count, the remaining count and the chart. The correct answer and each student's choice are only shown after the question is closed.
9. Use **Đóng nhận trả lời** (Close answers), **Câu tiếp theo** (Next question) and **Kết thúc** (End). TIMER mode closes the question by itself at the server deadline, waits 3 seconds to show the result, then opens the next question.
10. Look at the end-of-session report and the history. In the **Sinh viên tham gia** (Participating students) panel choose **Xuất CSV** (Export CSV) to download each student's results per question. Reloading the page keeps the question, the deadline and the results from the server.

### Importing questions from Word, Excel, PDF, TXT

In the page for creating or editing a question set choose **Nhập từ file** (`.docx`, `.xlsx`, `.csv`, `.pdf`, `.txt`, at most 20 MB and 200 questions). Imported questions appear in the editor together with a list of notes; a question with missing options or no answer is marked red and must be fixed before saving. The **File mẫu** button downloads an Excel, Word or TXT template. The importer reads Vietnamese keywords, so the sample below is in Vietnamese (`Tiêu đề` = title, `Mô tả` = description, `Chương` = chapter, `Câu` = question, `Đáp án` = answer, `Giải thích` = explanation, `Độ khó` = difficulty, `Dễ` = easy, `Thời gian` = time limit in seconds, `BẢNG ĐÁP ÁN` = answer table).

```text
Tiêu đề: Kiểm tra nhanh IoT
Mô tả: Ôn tập cuối bài

Chương 1: Giao thức truyền thông

Câu 1: MQTT sử dụng mô hình nào?
A. Publish/subscribe
B. Peer-to-peer
C. Broadcast UDP
D. Chỉ request/response
Đáp án: A
Giải thích: Thiết bị publish lên broker, client subscribe topic để nhận tin.
Độ khó: Dễ
Thời gian: 30

Câu 2: Những công nghệ nào ESP32 hỗ trợ sẵn? (chọn nhiều đáp án)
A. Wi-Fi   B. Bluetooth Low Energy   C. 5G   D. Ethernet quang
Đáp án: A, B

BẢNG ĐÁP ÁN
1A 2AB
```

- A question starts with `Câu N:`, `Question N`, `QN:` or `N.`; options are `A.`, `A)` or `(A)`, either one per line or all on one line; the question stem may span several lines, including a), b), c) sub-items.
- Answers: a line `Đáp án: B` / `Đáp án: A, C`, a `*` before an option, an answer table at the end of the document (`1-A, 2-C`, `1A 2C`, or a two-row table `Câu | 1 | 2` – `Đáp án | A | C`), or a "Hướng dẫn giải" (solution guide) section (`Câu 2: Chọn C vì …`). In Word, an underlined, coloured, highlighted or bold option is also recognised as the answer (with a warning so you can double-check).
- Optional lines: `Giải thích:`/`Lời giải:` (explanation), `Kiến thức:` (knowledge tested), `Chủ đề:` (topic), `Độ khó:` (difficulty: Dễ/Trung bình/Khó, i.e. easy/medium/hard, or Nhận biết/Thông hiểu/Vận dụng, or the labels `[NB]`, `[TH]`, `[VD]`), `Loại: nhiều đáp án` (type: multiple answers), `Thời gian:` (time limit). A heading `Chương …`/`Phần …` (chapter/part) or a Word Heading assigns a topic to the following questions.
- Excel/CSV: one question per row, with the columns STT (number), Câu hỏi (question), A, B, C, D, Đáp án (a letter or a number 1–4, several answers such as `A, C`), Loại (type), Thời gian (seconds), Độ khó (difficulty), Chủ đề (topic), Kiến thức kiểm tra (knowledge tested), Lời giải (solution).
- A PDF needs a text layer. For scanned PDFs or complex layouts use **Nhận dạng bằng AI** (Recognise with AI; needs ANTHROPIC_API_KEY). Old `.doc`/`.xls` files must be re-saved as `.docx`/`.xlsx`.

### Multiple-answer questions

Each question is either **Một đáp án** (single answer, radio buttons) or **Nhiều đáp án** (multiple answers, checkboxes). The presentation screen and the simulator state "select every correct option". On the keypad a multiple-answer question uses A–D to toggle each letter, the LEDs show the chosen letters (for example `AC`), Confirm sends and Clear removes everything. A student is only counted correct when every right option, and no other, is chosen; the chart counts the students who picked each option, so the total can exceed 100 %. Older devices/firmware that only send one letter still work with single-answer questions.

### AI assistant

The AI can use one of three sources, configured in `.env` and then applied by restarting the backend (`docker compose up -d backend`). With nothing configured every other feature still works and the AI buttons are disabled with an explanation.

| Source | Cost, limits | Configuration |
|---|---|---|
| **Google Gemini** (default when a key exists) | Free with per-minute and per-day request/token quotas (see AI Studio; reset at midnight Pacific time). Content sent through the free tier may be used by Google to improve its products. | `GEMINI_API_KEY=...` (create one free at aistudio.google.com/apikey), optionally `GEMINI_MODEL` (default `gemini-3.8-flash`) |
| **Ollama** (a model running on the server) | Free and **unlimited**; data never leaves the server. Quality and speed depend on the model and hardware; a GPU is needed to be fast. Cannot read image-only PDFs. | `docker compose --profile ollama up -d`, `docker compose exec ollama ollama pull qwen3:4b-instruct`, then `OLLAMA_URL=http://ollama:11434` |
| **Anthropic Claude** | Paid per token | `ANTHROPIC_API_KEY=...`, optionally `ANTHROPIC_MODEL` |

**Free without being blocked by quotas:** set both `GEMINI_API_KEY` and `OLLAMA_URL`. Gemini answers first (fast, good quality); when it hits a per-minute quota the request is retried after a few seconds to a minute; if it is still over quota, overloaded or offline, that call falls back to Ollama and Gemini is tried again after 10 minutes. Each AI task records the model that actually answered (for example `gemini-3.8-flash + qwen3:4b-instruct`). With Gemini alone, once the daily quota is gone the task fails with a clear error so you can retry later.

Set `AI_PROVIDER=gemini|ollama|anthropic` to choose the primary source when several are configured. About Ollama (measured on 12 Oct 2026 on a laptop with 16 CPU threads, 14 GB RAM, no GPU, `qwen3:4b-instruct`):

- **RAM:** with `OLLAMA_NUM_CTX=32768` (the default) the model takes about 5.3 GB thanks to the 8-bit context cache that the `ollama` service in the compose file enables (7.6 GB without it). On a machine with less RAM set `OLLAMA_NUM_CTX=16384`; each run then reads shorter documents, and a chapter that is too long is reported so you can choose fewer chapters.
- **Speed on CPU** (about 6–7 tokens/second): generating 6 questions from two short chapters takes about 6 minutes, recognising a 3-question paper 1.5 minutes, analysing the results of one lesson 4.5 minutes and reviewing a 6-question paper about 7 minutes. Tasks run in the background and the interface shows the elapsed time. An NVIDIA GPU (needs the NVIDIA Container Toolkit and GPU settings for the service) is many times faster.
- **Quality:** the questions are factually correct, the Vietnamese is natural and paper recognition is accurate; the distractors and commentary are less deep than Gemini's — the teacher still reviews every question before it enters a paper. For the **quality review** specifically, the 4B model misses factual errors and sometimes reaches wrong conclusions (in testing it claimed QoS 2 has 3 steps), so use Gemini for that feature. `qwen3:8b` or `gemma4:e4b` are better but need more RAM and are slower.
- It cannot read image-only (scanned) PDFs; long documents are split according to `OLLAMA_NUM_CTX`.

The **Trợ lý AI** (AI assistant) menu:

1. Upload course material (PDF, Word, TXT, Markdown). The system splits it into chapters by "Chương/Bài/Phần" (chapter/lesson/part) or Heading; choose the chapters to write questions from.
2. Choose the number of questions (1–60), the percentage of easy/medium/hard questions (total 100 %), the share of multiple-answer questions, the target question set and any extra instructions.
3. The AI writes questions in batches; each question has an explanation, the knowledge tested, the chapter and a quotation from the material as evidence.
4. In the **Chờ duyệt** (Pending review) tab: edit, reject or approve questions one by one or in bulk into an existing or a new question set. Questions that look like duplicates of the bank are flagged. Nothing enters a question set without approval.

Data sent to the AI service (except Ollama): the content of the chosen chapters, files sent for AI recognition, question text when a paper is reviewed, and aggregated figures when results are analysed (never with student names or codes). The token counts of each task are stored in AiJob.

### Question bank, paper quality and result analysis

- **Question bank**: search without typing accents, filter by set, difficulty, question type, topic and source (written by hand / imported / AI). The **Câu hỏi trùng lặp** (Duplicate questions) tab compares stems and options (independent of option order) with an adjustable threshold, shows two questions side by side and lets you delete the extra one.
- **Quality review** (a button on the question set page): automatic checks for repeated options, "All of the above", unusually long answers, negative questions that are not capitalised, questions that refer to a figure or table, duplicate questions and the distribution of answer positions; **Đánh giá bằng AI** (Review with AI) points out ambiguous questions, missing data, several possibly correct answers, a suspected wrong answer and duplicate content, scores each distractor and suggests rewrites.
- **Result analysis**: the end-of-session report and the quality page show the percentage correct, the discrimination index (top and bottom 27 % of scores), how often each option is chosen, warnings about ineffective distractors or a suspect answer key, KR-20 reliability, the score distribution and each student's score; **Phân tích bằng AI** (Analyse with AI) summarises strengths, knowledge gaps and teaching suggestions.

### Exams, paper codes and per-class statistics

1. **Lớp học** (Classes): create a class and import the list from Excel (a "Họ và tên" full-name column; the STT number is used as the device code 01–99). Students enter this code when they join; reports show their full names.
2. **Kỳ thi** (Exams): choose a question set and the number of paper codes, and turn on **Trộn thứ tự câu hỏi** (Shuffle question order) and/or **Xáo trộn đáp án** (Shuffle options). Paper codes 101, 102… can be previewed, and a Word paper to print and an Excel answer key can be downloaded.
3. **Open an exam session** for each class; the system assigns the least-used paper code (or you choose a specific one). The dialog for opening a normal lesson also has class and question/option shuffle choices.
4. The **Thống kê theo lớp** (Statistics by class) tab: mean, median, standard deviation, pass rate, grading as Giỏi/Khá/Trung bình/Yếu/Kém (excellent/good/average/weak/poor), score distribution, the percentage correct per question for each class, Excel export and AI commentary comparing the classes. The class page has a score table across sessions.

To debug MQTT: EMQX Dashboard → Connections / Subscriptions / Access Control. Do not use the EMQX admin account in the browser simulator. The teacher UI only uses REST + Socket.IO.

## Main commands

```bash
# The whole system (after copying .env)
docker compose up --build -d

# Migration / seed
docker compose exec backend pnpm db:migrate
docker compose exec backend pnpm db:seed

# Unit + component tests in the built container environment
docker compose exec backend pnpm test

# PostgreSQL integration tests; they create their own test data and clean it up
docker compose exec backend pnpm test:integration

# End-to-end HTTP + MQTT + Socket.IO, including 50 devices
docker compose exec -e SIMULATOR_MQTT_URL=mqtt://emqx:1883 \
  -e MQTT_SIMULATOR_USERNAME=simulator -e MQTT_SIMULATOR_PASSWORD=simulator-dev-only \
  backend pnpm test:e2e

# From the host, after pnpm install / pnpm build:
pnpm simulate --devices=50 --room=123456 --duplicates

# Or run the script inside the container, replacing room with the code of the open room
docker compose exec -e MQTT_URL=mqtt://emqx:1883 \
  -e MQTT_SIMULATOR_USERNAME=simulator -e MQTT_SIMULATOR_PASSWORD=simulator-dev-only \
  backend pnpm simulate --devices=50 --room=123456 --duplicates
```

Change the simulator credentials in the commands if you changed `.env`. The script joins, waits for the teacher to open a question, sends A–D with a random delay, then prints accepted/rejected/timeout/duplicate counts and the ACK latency. `--delay=0` sends everything at once, `--timeout=90` limits the time and `--duplicates` resends the exact same request to test idempotency. It returns a non-zero exit code if devices are missing a reply, there are errors/timeouts or duplicates are handled wrongly. Each run uses its own deviceId and studentCode.

## Development on the host

```bash
cp .env.example .env
pnpm install --frozen-lockfile
docker compose up -d postgres emqx
pnpm build
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Vite runs at http://localhost:5173 and proxies `/api` and `/socket.io` to NestJS on port 3000. The root commands read `.env` by themselves; environment variables already set outside keep priority. The Prisma CLI and the backend use the same `DATABASE_URL`. The simulator uses **MQTT_SIMULATOR_USERNAME/PASSWORD**; do not use the backend's `MQTT_USERNAME/PASSWORD`. Changing VITE variables needs a Vite restart or a rebuild of the frontend image.

```bash
pnpm test
pnpm test:integration  # needs a migrated PostgreSQL
pnpm test:e2e          # needs the API and EMQX running
pnpm build
```

## Structure

```text
apps/
  backend/                NestJS, Prisma schema/migration/seed, tests; file import, AI, question bank, classes, exams
  frontend/               React + Tailwind, teacher/presentation routes
  device-simulator/       React component: MQTT + keypad + two 7-segment LEDs
  firmware/               ESP-IDF: BLE provisioning, Wi-Fi/MQTT, keypad, 2×74HC595 display
packages/
  shared-types/           REST/realtime types, answer keys, statistics, question reader, duplicate matching, question analysis, paper code generation
  mqtt-contracts/         Zod validation, topics, payload/ACK v1
scripts/
  simulate-devices/       Node MQTT load generator
  tests/e2e.ts            Real HTTP + broker + Socket.IO test
  provision-device.mjs    Issues a dedicated MQTT account per device
infra/                    Dockerfiles, Nginx, EMQX authentication/ACL
docs/                     Architecture, API, MQTT, test results
docker-compose.yml
```

The old `index.html` is not part of the ClassPulse application; a copy is kept at `docs/legacy-index.html`. The application runs from Vite or the frontend container; do not open the root HTML directly as a file in the browser.

## Data rules

- A session keeps its own copy of the questions (`SessionQuestion`), separate from the quiz, which can still be edited. Quizzes and questions use soft delete to keep the history.
- Email is unique; an active roomCode has a PostgreSQL partial unique index; a device and a studentCode can each have only one participant per session.
- There is one current answer per `(participantId, questionId)`. The sequence increases and the server timestamp is checked against the deadline. The client timestamp is only for diagnostics.
- `ProcessedMqttMessage` stores a unique requestId, the payload hash and the ACK. An advisory lock per request and a row lock per session protect against duplicate sends and races with closing a question. The answer and the ACK record commit in the same transaction.
- A duplicate with identical content returns `DUPLICATE_MESSAGE` with the original `originalCode` and `success`. Reusing a requestId with different content is rejected.
- The denominator for the A–D percentages and correct/incorrect is the number of valid answers; with no answers everything is 0. Unanswered = participants − answered.
- The deadline is stored in the database; a 250 ms sweeper recovers after a restart. Both MANUAL and TIMER close a question when time runs out; MANUAL waits for the teacher to choose the next question. After an outage, expired questions are closed first, then TIMER continues with the full time for the new question.
- The teacher can let students join mid-session; the participant total in the report uses the current/final number of participants.

## Persistence, operation and network settings

PostgreSQL, the EMQX data/logs and the bootstrap configuration use named volumes. `docker compose down` keeps the data; `docker compose down -v` **deletes the data**. Check a restart with `docker compose restart backend postgres emqx`, wait until healthy, then reopen the history/session. When the broker reconnects, the backend republishes the retained state.

The PostgreSQL, MQTT and EMQX Dashboard ports bind to loopback by default. The rootless frontend binds `127.0.0.1:8080`; Apache or a socket proxy provides port 80 so teachers can open `http://localhost` directly. To use it over the classroom network: set `FRONTEND_ORIGIN` to the exact access address and configure a virtual host/proxy for the LAN address; change the simulator broker URL in the connection panel or set `VITE_MQTT_WS_URL` and rebuild. Nginx supports `/mqtt` on the same host. HTTPS needs `wss://`, a TLS reverse proxy and `COOKIE_SECURE=true`. Set `TRUST_PROXY=true` for the backend when it is behind a trusted proxy so rate limiting is per user IP; never trust a proxy you do not control.

Authentication is always on; there is no anonymous mode. `broker-config` generates the bootstrap/ACL files from `.env`; EMQX reads the bootstrap when the authenticator is first created. **Changing a password in `.env` does not change an account that already exists in the EMQX volume**: update it through the Dashboard/API and keep the application credentials in sync. Do not delete the volume to rotate keys if you need to keep the data.

The shared simulator account is for development only; the clientId can be chosen freely and does not prove a device's identity. For a real deployment issue dedicated credentials with `pnpm provision --deviceId=device-001` and a separate `MQTT_DEVICE_PASSWORD`, then set `MQTT_SIMULATOR_ENABLED=false`, re-run broker-config/restart EMQX, and delete the old simulator account through the Dashboard. The ACL of real devices ties the topics to `${username}`, so the credentials of device-001 cannot publish to device-002's topics. See the [protocol and provisioning](docs/mqtt-protocol.md).

## Reference ESP32 firmware

`apps/firmware` adds the path for a real device following the BLE, Wi-Fi and MQTT lessons: provisioning over encrypted BLE GATT, Wi-Fi STA connection, MQTT QoS 1 publish/subscribe, ACK/retry/idempotency, pending state and sequence kept in NVS, debounced keypad scanning and control of two four-digit LED modules driven by 74HC595s. See [pinout, build, flash and provisioning](apps/firmware/README.md) and the [breadboard wiring and BOM](docs/hardware/breadboard-wiring.md). The pure C logic can run on the host with `pnpm test:firmware`.

The [course alignment](docs/course-alignment.md) document describes how the IoT, BLE, Wi-Fi, web server, database and MQTT topics map onto the source code.

## MVP scope and known limitations

- ESP-IDF firmware and a reference pinout exist, but they have not been built, flashed or measured electrically on a real board in this environment. Before classroom use, verify on the hardware whether the LEDs are common cathode or anode, the resistors, the digit order, the GPIOs and keypad noise.
- Only **one backend instance** is deployed. The rate limit lives in RAM and realtime uses the default Socket.IO adapter. Scaling to several instances needs a Redis adapter, a distributed limiter, an event publishing/outbox mechanism and a clear subscriber-consumer design.
- It stores the final answer, the metadata/hash and the ACK of each message; it does not store the full history of every change of answer. There is no leaderboard, public screen sharing or password reset by email in this scope.
- Questions are text only: images in Word/PDF are not imported and Word formulas keep only their text. Every question has exactly four options A–D (options E/F are ignored on import). A multiple-answer question is graded all-or-nothing, with no partial credit.
- Devices follow one shared question on the presentation screen, so paper codes change the order of questions/options per class or session, not between students in the same room; the Word paper is for paper-based exams.
- AI through Gemini/Claude needs Internet and an API key; free Gemini has per-minute/day quotas. Ollama is unlimited but depends on the hardware, and a small model writes less accurate questions. Content proposed by the AI must be checked by the teacher before approval. A running AI task is marked failed if the backend restarts.
- An access token stays valid for up to 15 minutes after logout; refresh tokens are revoked and the token lives only in the web app's memory. Production needs HTTPS/WSS, dedicated credentials, secret rotation, backups and suitable network restrictions. Never commit a real `.env` to git.
- When the connection is lost, the UI shows the state and reloads the snapshot on reconnect. An answer sent late from offline after the deadline is not accepted.
- Docker Compose was verified with PostgreSQL, EMQX, the backend and the frontend; see the [test results](docs/testing.md).

Details: [Architecture](docs/architecture.md) · [Course alignment](docs/course-alignment.md) · [MQTT v1](docs/mqtt-protocol.md) · [REST/Socket.IO](docs/api.md).
