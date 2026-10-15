# API và Socket.IO

Base URL trong môi trường phát triển: `http://localhost:3000/api`; qua frontend/Nginx: `http://localhost/api`. Swagger UI tại `/api/docs`, JSON OpenAPI tại `/api/docs-json`. Các request có body dùng `Content-Type: application/json`.

Tài liệu bám theo controllers/DTO trong `apps/backend/src`. Hầu hết kiểu response dùng chung nằm trong `packages/shared-types`. Không có REST endpoint dành cho sinh viên để nộp đáp án: join/answer dùng [MQTT](mqtt-protocol.md).

## Xác thực và cookie

Quiz, question, teacher profile và session đều yêu cầu:

```http
Authorization: Bearer <accessToken>
```

Register/login/refresh trả `AuthResponse`:

```json
{
  "accessToken": "<JWT-hạn-15-phút>",
  "teacher": {
    "id": "b1ec2dad-e578-4975-82ea-f0011142218c",
    "email": "teacher@example.com",
    "name": "Giáo viên"
  }
}
```

Refresh token không có trong JSON. Server đặt cookie `refreshToken`: HttpOnly, SameSite=Lax, Path=/api/auth, Max-Age 7 ngày, Secure khi `COOKIE_SECURE=true`. Browser gọi fetch với `credentials: 'include'`; client CLI giữ cookie jar. Refresh và logout đọc cookie, không đọc refresh token trong body/Authorization. Mỗi refresh thành công cấp access token mới và xoay cookie.

| Method / path | Body | Thành công | Lỗi chính |
|---|---|---|---|
| `POST /auth/register` | `{ "email", "password", "name" }` | **201** AuthResponse + cookie | 400 validation/email đã dùng; 409 nếu đụng unique khi ghi đồng thời |
| `POST /auth/login` | `{ "email", "password" }` | **200** AuthResponse + cookie | 400 validation; 401 sai thông tin |
| `POST /auth/refresh` | Không cần; gửi cookie | **200** AuthResponse + cookie mới | 401 thiếu, sai, hết hạn hoặc đã dùng token |
| `POST /auth/logout` | Không cần; gửi cookie nếu có | **200** `{ "success": true }`, xóa cookie | Có thể gọi khi cookie không còn |
| `GET /teachers/me` | — | **200** `{ id, email, name }` | 401 token không hợp lệ |
| `PATCH /teachers/me` | `{ "name": "Tên mới" }` | **200** `{ id, email, name }` | 400 validation; 401 |

Email được trim/lowercase. Đăng ký: email hợp lệ tối đa 254 ký tự; tên sau trim dài 1–100; mật khẩu 8–72 ký tự và không vượt 72 byte UTF-8. Login mật khẩu dài 1–72 ký tự. API hồ sơ hiện chỉ sửa tên, không đổi email/mật khẩu.

Refresh token đã revoke/hết hạn làm các token còn hoạt động cùng family bị revoke. Web gom các request refresh đồng thời thành một request. Logout không thu hồi JWT access token ngay lập tức; token đã phát hành hết hiệu lực sau tối đa 15 phút.

## Quiz và câu hỏi

Mỗi path `:id`/`:questionId` dưới đây phải là UUID. Quiz của người khác hoặc đã xóa mềm trả 404. Danh sách không có pagination/filter; chỉ trả quiz đang hoạt động của giáo viên hiện tại, sắp theo updatedAt giảm dần.

### Request `QuestionInput`

```json
{
  "content": "Những công nghệ không dây nào có sẵn trên ESP32? Chọn tất cả các đáp án đúng.",
  "optionA": "Wi-Fi",
  "optionB": "Bluetooth Low Energy",
  "optionC": "5G",
  "optionD": "LoRa",
  "type": "MULTIPLE",
  "correctAnswer": "AB",
  "explanation": "ESP32 có sẵn Wi-Fi và Bluetooth; 5G và LoRa cần module rời.",
  "knowledge": "Kết nối không dây của ESP32",
  "topic": "Chương 2 – Phần cứng IoT",
  "difficulty": "MEDIUM",
  "durationSeconds": 40,
  "order": 0
}
```

content dài 1–4000 ký tự; mỗi option dài 1–1000; durationSeconds là số nguyên 5–3600; order nguyên 0–1000. Các trường này cùng correctAnswer bắt buộc khi tạo câu.

- `type`: `SINGLE` (mặc định) hoặc `MULTIPLE`. Câu nhiều đáp án cho phép sinh viên chọn nhiều phương án và chỉ được tính đúng khi chọn **đủ và đúng** tất cả đáp án.
- `correctAnswer` là **khóa chuẩn**: một hoặc nhiều chữ A–D theo thứ tự bảng chữ cái, không lặp (`B`, `AC`, `ABD`). Câu `SINGLE` phải có đúng một chữ; gửi `AB` cho câu một đáp án trả 400. Client cũ gửi `"correctAnswer": "B"` không kèm type vẫn hoạt động như trước.
- Tùy chọn: `explanation` (lời giải, ≤ 4000, hiển thị cho lớp sau khi đóng câu), `knowledge` (kiến thức được kiểm tra, ≤ 300), `topic` (chương/chủ đề, ≤ 200), `difficulty` (`EASY`/`MEDIUM`/`HARD` hoặc null), `origin` (`MANUAL`/`IMPORT`/`AI`, chỉ để hiển thị nguồn). DTO chấp nhận `id` UUID tùy chọn để tương thích dữ liệu editor, nhưng create sinh UUID mới và update không đổi ID theo body. PATCH câu cho phép tập con các trường này.

### Request `QuizInput`

```json
{
  "title": "Nhập môn IoT",
  "description": "Bài kiểm tra nhanh",
  "questions": [
    {
      "content": "MQTT dùng mô hình giao tiếp nào?",
      "optionA": "Publish/subscribe",
      "optionB": "Chỉ peer-to-peer",
      "optionC": "Chỉ request/response",
      "optionD": "Chỉ broadcast UDP",
      "correctAnswer": "A",
      "durationSeconds": 30,
      "order": 0
    }
  ]
}
```

Title dài 1–200 ký tự, bắt buộc khi tạo. Description tùy chọn, tối đa 4000, mặc định chuỗi rỗng. Questions tùy chọn, tối đa 200 phần tử; có thể tạo quiz rỗng nhưng chưa thể tạo session từ quiz đó. PATCH quiz cho phép tập con; nếu gửi `questions`, **toàn bộ danh sách câu hiện tại được thay thế** bằng các bản ghi mới, bản cũ xóa mềm. Không gửi questions thì giữ danh sách cũ.

| Method / path | Body | Thành công |
|---|---|---|
| `GET /quizzes` | — | **200** QuizRecord[] |
| `POST /quizzes` | QuizInput | **201** QuizRecord |
| `GET /quizzes/:id` | — | **200** QuizRecord, gồm questions |
| `PATCH /quizzes/:id` | Partial QuizInput | **200** QuizRecord |
| `DELETE /quizzes/:id` | — | **200** `{ "success": true }`; xóa mềm |
| `POST /quizzes/:id/duplicate` | — | **201** QuizRecord mới; title thêm ` (bản sao)` |
| `POST /quizzes/:id/questions` | QuestionInput | **201** QuestionRecord |
| `PATCH /quizzes/:id/questions/:questionId` | Partial QuestionInput | **200** QuestionRecord |
| `DELETE /quizzes/:id/questions/:questionId` | — | **200** `{ "success": true }`; xóa mềm |

QuizRecord thực tế gồm `id, teacherId, title, description, createdAt, updatedAt, deletedAt, questions`. QuestionRecord gồm `id, quizId, content, optionA, optionB, optionC, optionD, type, correctAnswer, explanation, knowledge, topic, difficulty, origin, durationSeconds, order, deletedAt`. Trường thời gian được serialize ISO-8601; deletedAt của bản đang hoạt động là null. Questions trong quiz sắp theo order tăng dần và không gồm câu đã xóa. Các endpoint trả đáp án đúng của tài liệu quiz cho giáo viên sở hữu để biên soạn; quy tắc che đáp án của phiên học nằm ở SessionSnapshot.

Lỗi chung của nhóm: 400 validation/UUID không đúng; 401 chưa đăng nhập; 404 không thuộc quyền sở hữu/không tồn tại; 409 xung đột unique nếu có.

## Session: tạo, điều khiển và báo cáo

Tạo phiên từ quiz có ít nhất một câu:

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

quizId bắt buộc là UUID thuộc giáo viên. Mode tùy chọn `MANUAL`/`TIMER`, mặc định MANUAL. durationSeconds tùy chọn, nguyên 5–3600; nếu bỏ qua, từng câu dùng thời gian từ quiz. Session sao chép câu hỏi, nên chỉnh quiz sau đó không thay đổi phiên đã tạo. `classroomId` (tùy chọn) gán phiên cho một lớp: báo cáo hiện họ tên theo mã thiết bị và cộng điểm vào thống kê lớp. `shuffleQuestions`/`shuffleOptions` (mặc định false) trộn thứ tự câu và vị trí A–D cho riêng phiên này; câu có phương án phụ thuộc vị trí ("Tất cả các đáp án trên", "Cả A và B") được giữ nguyên thứ tự phương án, các tham chiếu kiểu "đáp án B" trong lời giải được đổi theo vị trí mới.

| Method / path | Body | Thành công |
|---|---|---|
| `GET /sessions` | — | **200** SessionSnapshot[], gồm lịch sử và phiên hiện tại; createdAt giảm dần |
| `POST /sessions` | `{ quizId, mode?, durationSeconds?, classroomId?, shuffleQuestions?, shuffleOptions? }` | **201** SessionSnapshot ở LOBBY |
| `GET /sessions/:id/analysis` | — | **200** SessionAnalysis: phân tích từng câu, điểm từng sinh viên, lần phân tích AI gần nhất |
| `POST /sessions/:id/ai-analysis` | Không cần | **201** AiJob `ANALYZE_SESSION`; 400 nếu chưa có câu đã đóng/sinh viên |
| `GET /sessions/:id` | — | **200** SessionSnapshot |
| `GET /sessions/:id/participants` | — | **200** Participant[] theo trạng thái câu hiện tại |
| `GET /sessions/:id/stats` | — | **200** QuestionStats của câu hiện tại |
| `GET /sessions/:id/report` | — | **200** SessionSnapshot; truy cập được cả khi phiên chưa kết thúc |
| `GET /sessions/:id/export.csv` | — | **200** tệp CSV kết quả; `Content-Disposition: attachment` |
| `POST /sessions/:id/start` | Không cần | **201** SessionSnapshot, mở câu index 0 từ LOBBY |
| `POST /sessions/:id/open` | `{ questionId?: UUID, index?: number }` | **201** SessionSnapshot, mở một câu chưa từng mở |
| `POST /sessions/:id/close` | Không cần | **201** SessionSnapshot, đóng câu đang mở |
| `POST /sessions/:id/next` | Không cần | **201** SessionSnapshot, mở câu tiếp hoặc finish sau câu cuối |
| `POST /sessions/:id/finish` | Không cần | **201** SessionSnapshot ở FINISHED |
| `PATCH /sessions/:id/settings` | `{ mode?: "MANUAL"|"TIMER", durationSeconds?: number }` | **200** SessionSnapshot |

Các POST điều khiển trả **201** theo mặc định controller NestJS, không phải 200/204. Mỗi request đều kiểm tra teacherId; không dùng roomCode để cấp quyền điều khiển.

Quy tắc điều khiển:

- `start` chỉ từ LOBBY. `next` từ LOBBY trả 409; phải start hoặc open trước.
- `open`: questionId là **SessionQuestion ID** trong phiên; được ưu tiên nếu đồng thời có index. Index bắt đầu từ 0; khi bỏ cả hai, dùng currentQuestionIndex + 1. Index/questionId ngoài phiên trả 400; câu từng mở trả 409. Không có endpoint liệt kê trước toàn bộ SessionQuestion ID; có thể mở bằng index.
- `next` hoặc `open` khi câu còn ACTIVE sẽ đóng câu cũ ngay. `next` vượt câu cuối kết thúc phiên; `open` vượt phạm vi trả 400.
- `close` khi đã CLOSED là idempotent, vẫn thành công; từ LOBBY trả 409. `finish` khi đã FINISHED vẫn thành công. Thao tác khác trên FINISHED trả 409.
- Deadline luôn do server đặt và áp dụng cho cả MANUAL/TIMER. TIMER chờ 3 giây sau đóng câu rồi next/finish; MANUAL chờ thao tác giáo viên.
- Settings duration áp dụng các câu mở sau; không gia hạn câu đang chạy. Bật TIMER khi đang CLOSED đặt nextQuestionAt = server hiện tại + 3 giây; đổi sang MANUAL xóa lịch tự chuyển. Không có API reset override duration về null.

### SessionSnapshot

```json
{
  "id": "96873534-7d0d-4457-a7d4-2fdc459158a9",
  "quizId": "0ad516d4-e23d-48e1-b8f6-3c067b2f57d1",
  "title": "Nhập môn IoT",
  "roomCode": "123456",
  "status": "QUESTION_ACTIVE",
  "mode": "MANUAL",
  "currentQuestionIndex": 0,
  "totalQuestions": 1,
  "currentQuestion": {
    "id": "78bb357f-d1f1-4d7c-855e-c40f0f598c60",
    "content": "MQTT dùng mô hình giao tiếp nào?",
    "optionA": "Publish/subscribe",
    "optionB": "Chỉ peer-to-peer",
    "optionC": "Chỉ request/response",
    "optionD": "Chỉ broadcast UDP",
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

Trong LOBBY: currentQuestionIndex=-1, currentQuestion=null, các deadline=null. Trong ACTIVE, currentQuestion không có correctAnswer và participant không có answer/isCorrect. Phân phối A/B/C/D được trả; đúng/sai chưa công bố nên bằng 0. Khi CLOSED/FINISHED, currentQuestion có correctAnswer và participant đã trả lời có answer/isCorrect. `results` chỉ chứa câu đã đóng, mỗi phần tử `{ question: PublicQuestion, stats: QuestionStats }` có đáp án đúng.

Snapshot còn có `classroomId`, `classroomName`, `examId`, `variantCode` (mã đề khi phiên mở từ kỳ thi); `currentQuestion.type` cho biết câu một hay nhiều đáp án; participant có `studentName` khi phiên gán lớp. Khi CLOSED/FINISHED, câu hỏi có thêm `explanation`. Với câu nhiều đáp án, `answer` là khóa như `AC`; `counts`/`percentages` đếm số sinh viên đã chọn từng chữ (tổng có thể vượt 100%), còn `correct` chỉ đếm khóa khớp hoàn toàn.

Các phần trăm dùng answered làm mẫu số, làm tròn hai chữ số, bằng 0 khi answered=0. Report trả snapshot và kết quả từng câu, không tạo thêm leaderboard. Snapshot luôn gồm serverTime để đồng bộ countdown. ID của câu trong snapshot khác ID câu trong quiz gốc.

Endpoint `export.csv` trả một dòng cho mỗi sinh viên, gồm mã phòng, tên quiz, mã sinh viên, họ tên (theo danh sách lớp nếu có), device ID, thời điểm tham gia, đáp án/kết quả của từng câu, tổng số câu đúng và điểm thang 10. CSV dùng CRLF, bao mọi ô bằng dấu nháy kép và thêm UTF-8 BOM để Excel hiển thị đúng tiếng Việt. Ô văn bản bắt đầu bằng `=`, `+`, `-` hoặc `@` được vô hiệu hóa công thức. Chỉ giáo viên sở hữu phiên mới có thể tải tệp.

## Socket.IO cho giáo viên

Endpoint `/socket.io/` trên cùng origin frontend; backend port 3000 cũng cung cấp endpoint này. Namespace mặc định `/`, hỗ trợ WebSocket và polling. MQTT simulator không dùng Socket.IO.

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

| Sự kiện | Hướng / payload | Kết quả |
|---|---|---|
| Handshake | Client auth `{ token: accessToken }` | Sai/thiếu token: `connect_error`, message `Unauthorized` |
| `session:join` | Client → server `{ sessionId: UUID }` | Callback `{ success: true }`; server phát ngay `session:update` |
| `session:join` sai dữ liệu | Client → server | `{ success: false, message: "Invalid sessionId" }` |
| `session:join` không có quyền/tài nguyên | Client → server | `{ success: false, message: "Session not found or unauthorized" }` |
| `session:update` | Server → client SessionSnapshot | Sau join và sau thay đổi participant/answer/trạng thái/settings |

Server kiểm tra token lại khi join, xác nhận quyền sở hữu và chỉ cho socket theo dõi một room `session:{id}` tại một thời điểm; join phiên mới sẽ rời room phiên cũ. Snapshot được đọc lại sau khi vào room để tránh bỏ lỡ thay đổi lúc join. Token hết hạn khiến server disconnect; client refresh qua cookie, cập nhật `socket.auth.token`, reconnect rồi emit session:join lại.

Không có event Socket.IO để gửi answer hoặc điều khiển session; thao tác giáo viên dùng REST. Không có broadcast countdown từng giây: browser tự hiển thị từ deadline server và làm mới qua snapshot. Reload/reconnect phải lấy lại REST snapshot; frontend đã triển khai fallback polling 5 giây khi Socket mất kết nối.

## Lỗi, validation và giới hạn

DTO bật whitelist, forbidNonWhitelisted và transform: trường ngoài DTO bị 400; số JSON phải là số nguyên trong giới hạn, không gửi chuỗi thay số. Path UUID sai bị 400. Các endpoint không nhận DTO body (ví dụ start/finish) không dùng các trường body để điều khiển hành vi.

Lỗi qua exception filter:

```json
{
  "statusCode": 409,
  "message": "Phiên đã kết thúc.",
  "requestId": "8cb6f76d-cf4f-4f88-96bf-e0b9efb471ae",
  "timestamp": "2026-09-29T09:01:00.000Z"
}
```

message có thể là chuỗi, danh sách lỗi validation hoặc object health. Header `x-request-id` có trên response. Middleware rate limit/Origin trả trực tiếp `{ statusCode, message }`, không có timestamp/requestId trong body; requestId vẫn ở header.

| Status | Ý nghĩa |
|---:|---|
| 400 | DTO/UUID sai, quiz rỗng khi tạo session, tham số câu ngoài phạm vi, email đã dùng |
| 401 | Thiếu/sai/hết hạn access hoặc refresh token, sai thông tin đăng nhập |
| 403 | Origin của request thay đổi không được phép |
| 404 | Tài nguyên không tồn tại, đã xóa mềm hoặc thuộc giáo viên khác |
| 409 | Chuyển trạng thái không hợp lệ, mở lại câu cũ, xung đột unique/cấp mã phòng |
| 413 | File tải lên vượt 20 MB hoặc nội dung giải nén quá lớn |
| 429 | Vượt rate limit (đọc header Retry-After, giây) hoặc đang có quá 3 tác vụ AI chưa xong |
| 500 | Lỗi nội bộ; response không chứa stack/password/token |
| 503 | Health báo database hoặc MQTT chưa sẵn sàng; endpoint AI khi chưa cấu hình nguồn AI |

Mặc định mỗi IP có 20 login/register request/phút (cùng bucket) và 600 request/phút cho các endpoint khác. Điều chỉnh qua AUTH_RATE_LIMIT/API_RATE_LIMIT. Limiter hiện nằm trong bộ nhớ một backend. CORS cho origin trong FRONTEND_ORIGIN, hoặc CORS_ORIGIN nếu chưa đặt FRONTEND_ORIGIN; danh sách ngăn cách dấu phẩy. Request không có Origin được xử lý bình thường với yêu cầu auth tương ứng.

## Health

`GET /health` không cần token. Khi PostgreSQL và MQTT sẵn sàng, HTTP 200:

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

Nếu MQTT_DISABLED=true, mqtt là `disabled` và health chỉ yêu cầu database. `ai` là `configured` khi đã cấu hình Gemini, Ollama hoặc Claude, ngược lại `disabled`; AI không ảnh hưởng trạng thái ok/degraded. Khi lỗi, HTTP 503 với envelope lỗi chung, trường `message` là object tương tự trên có status=`degraded`, database/mqtt=`down`. Health chứng minh API đang đáp ứng, database nhận `SELECT 1` và client MQTT đang connected; không thay cho kiểm thử end-to-end.

## Nhập câu hỏi từ file

Upload dùng `multipart/form-data` với một trường `file`, tối đa 20 MB. Kết quả là bản nháp để giáo viên kiểm tra trong editor; không có gì được lưu cho tới khi gọi `POST/PATCH /quizzes`.

| Method / path | Body | Thành công |
|---|---|---|
| `POST /imports/questions` | file `.txt`, `.docx`, `.xlsx`, `.csv`, `.pdf` | **201** ImportResult |
| `POST /imports/questions/ai` | file `.docx`, `.pdf` (kể cả PDF scan), `.txt` | **201** AiJob `EXTRACT_QUESTIONS`; `result` là ImportResult |
| `GET /imports/template.xlsx` | — | **200** file Excel mẫu (sheet hướng dẫn, danh sách chọn Loại/Độ khó) |
| `GET /imports/template.docx` | — | **200** file Word mẫu |

```json
{
  "title": "ngan-hang-iot",
  "description": "",
  "sourceName": "ngan-hang-iot.docx",
  "format": "docx",
  "questions": [{ "content": "…", "optionA": "…", "optionB": "…", "optionC": "…", "optionD": "…", "type": "MULTIPLE", "correctAnswer": "AC", "explanation": "", "knowledge": "", "topic": "Chương 1", "difficulty": null, "origin": "IMPORT", "durationSeconds": 30, "order": 0 }],
  "warnings": ["Câu 2 (dòng 8): chưa chọn đáp án đúng."]
}
```

Trình đọc văn bản (TXT/Word/PDF) nhận: `Câu N:`/`Question N`/`N.`, phương án `A.`/`A)`/`(A)` trên từng dòng hoặc cùng một dòng, dòng `Đáp án: B` hoặc `Đáp án: A, C`, dấu `*` trước phương án đúng, bảng đáp án cuối tài liệu (`1-A, 2-C`, `1A 2C`, hoặc hai dòng `Câu | 1 | 2` / `Đáp án | A | C`), phần "Hướng dẫn giải" (`Câu 2: Chọn C vì…`), và các dòng tùy chọn `Giải thích:`, `Kiến thức:`, `Chủ đề:`, `Độ khó:` (Dễ/Trung bình/Khó, Nhận biết/Thông hiểu/Vận dụng, nhãn `[NB]`), `Loại:`, `Thời gian:`. Word còn nhận phương án đúng được gạch chân, tô màu chữ, tô nền hoặc in đậm, tiêu đề chương theo style Heading và câu đánh số tự động. Excel/CSV đọc mỗi dòng một câu theo tên cột (STT, Câu hỏi, A–D, Đáp án, Loại, Thời gian, Độ khó, Chủ đề, Kiến thức, Lời giải); đáp án có thể là chữ hoặc số 1–4. `.doc`/`.xls` đời cũ trả 400 kèm hướng dẫn lưu lại dạng mới.

## Trợ lý AI

Nguồn AI chọn qua biến môi trường: Google Gemini (`GEMINI_API_KEY`, mặc định `gemini-3.8-flash`, có gói miễn phí giới hạn theo phút/ngày), Ollama cục bộ (`OLLAMA_URL`, mặc định `qwen3:4b-instruct`) hoặc Anthropic Claude (`ANTHROPIC_API_KEY`, mặc định `claude-opus-5-5`); `AI_PROVIDER` chọn khi có nhiều nguồn. Mọi tác vụ chạy nền và được theo dõi bằng AiJob; tác vụ còn dở khi backend khởi động lại được đánh dấu FAILED. Mỗi giáo viên có tối đa 3 tác vụ chưa xong.

```json
{
  "id": "…", "kind": "GENERATE_QUESTIONS", "status": "RUNNING", "progress": 50,
  "error": null, "result": null, "input": { "questionCount": 20 },
  "documentId": "…", "quizId": null, "sessionId": null, "examId": null,
  "model": "gemini-3.8-flash", "inputTokens": 0, "outputTokens": 0,
  "createdAt": "…", "startedAt": "…", "finishedAt": null
}
```

| Method / path | Body | Thành công |
|---|---|---|
| `GET /ai/status` | — | **200** `{ enabled, provider: "gemini" \| "ollama" \| "anthropic" \| null, model, fallback: { provider, model } \| null }`; `fallback` là Ollama khi cấu hình cả nguồn đám mây lẫn `OLLAMA_URL` |
| `GET /ai/jobs?kind=` | — | **200** AiJob[] gần nhất |
| `GET /ai/jobs/:id` | — | **200** AiJob (poll 2 giây/lần tới SUCCEEDED/FAILED) |
| `POST /ai/documents` | file `.pdf`, `.docx`, `.txt`, `.md` | **201** SourceDocument gồm các chương nhận diện được |
| `GET /ai/documents` / `GET /ai/documents/:id` / `DELETE /ai/documents/:id` | — | Danh sách / chi tiết / xóa mềm tài liệu |
| `POST /ai/generate` | GenerateQuestionsRequest | **201** AiJob `GENERATE_QUESTIONS`; `result = { created, counts }` |
| `GET /ai/generated?status=PENDING&jobId=` | — | **200** GeneratedQuestion[] (PENDING/APPROVED/REJECTED) kèm gợi ý trùng với ngân hàng |
| `GET /ai/generated/count` | — | **200** `{ pending }` |
| `PATCH /ai/generated/:id` | các trường câu hỏi | **200** câu đề xuất đã sửa (chỉ khi PENDING) |
| `POST /ai/generated/approve` | `{ ids, quizId? \| newQuizTitle?, durationSeconds? }` | **201** `{ quizId, quizTitle, approved }` |
| `POST /ai/generated/reject` / `reopen` | `{ ids }` | **201** `{ rejected }` / `{ reopened }` |

```json
{
  "documentId": "…", "sectionIndexes": [0, 1], "questionCount": 20,
  "easyPercent": 40, "mediumPercent": 40, "hardPercent": 20,
  "multiplePercent": 10, "instructions": "Ưu tiên ví dụ thực tế", "quizId": "…"
}
```

Tổng ba tỷ lệ độ khó phải bằng 100; số câu 1–60; các chương chọn tối đa 500.000 ký tự. Câu hỏi được viết theo lô 12 câu, số câu mỗi mức độ được chia chính xác; AI tránh lặp lại câu đã viết trong lượt và câu sẵn có của `quizId`. Mỗi câu đề xuất có lời giải (`explanation`), kiến thức kiểm tra (`knowledge`), chương (`topic`) và trích dẫn tài liệu (`sourceExcerpt`). **Câu đề xuất không vào bộ câu hỏi nào cho tới khi gọi approve**; approve kiểm tra lại đáp án và giới hạn 200 câu/bộ. PDF scan được lưu nguyên file và gửi cho AI dưới dạng tài liệu PDF (Gemini/Claude; Ollama không hỗ trợ PDF dạng ảnh).

Dữ liệu gửi tới dịch vụ AI bên ngoài (Gemini/Claude; Ollama xử lý ngay trên máy chủ): nội dung các chương đã chọn (tạo câu hỏi), file cần nhận dạng (nhập bằng AI), nội dung câu hỏi (đánh giá chất lượng) và số liệu tổng hợp không kèm tên/mã sinh viên (phân tích kết quả).

## Ngân hàng câu hỏi

| Method / path | Query | Thành công |
|---|---|---|
| `GET /bank/questions` | `search, quizId, difficulty (EASY/MEDIUM/HARD/UNSET), type, topic, origin` | **200** `{ total, items: BankQuestion[] (tối đa 500), topics }` |
| `GET /bank/duplicates` | `threshold` (0.5–0.99, mặc định 0.8), `quizId` | **200** cặp `{ score, stem, options, kind, a, b }` |

Tìm kiếm không phân biệt dấu/hoa thường; mọi từ của truy vấn phải xuất hiện trong câu hỏi, phương án, chủ đề, kiến thức, lời giải hoặc tên bộ. Độ giống = 0,7 × câu dẫn + 0,3 × phương án (so sánh trigram ký tự, không phụ thuộc thứ tự phương án). `kind`: `EXACT` (≥ 97%), `NEAR`, `STEM` (cùng câu dẫn ≥ 90% nhưng khác phương án). Xóa câu trùng bằng `DELETE /quizzes/:id/questions/:questionId`.

## Chất lượng đề và phân tích kết quả

| Method / path | Thành công |
|---|---|
| `GET /quizzes/:id/quality` | **200** QuizQualityReport: lỗi phát hiện tự động, phân bố vị trí đáp án/độ khó/loại câu, lần đánh giá AI gần nhất, phân tích kết quả các phiên đã kết thúc |
| `POST /quizzes/:id/ai-review` | **201** AiJob `REVIEW_QUIZ`; `result` gồm điểm 0–100, nhận xét, từng câu (OK/REVIEW/FIX), lỗi theo nhóm, đánh giá từng phương án nhiễu, gợi ý viết lại, nhóm câu trùng |

Kiểm tra tự động (không cần AI): phương án trùng nhau, "Tất cả các đáp án trên"/"Cả A và B", đáp án đúng dài bất thường, câu phủ định chưa in hoa, câu nhiều đáp án chưa ghi rõ yêu cầu, câu nhắc tới hình/bảng (thiết bị chỉ hiển thị chữ), câu quá ngắn, câu trùng trong đề, đáp án tập trung một vị trí. AI bổ sung: câu mơ hồ, thiếu dữ kiện, nhiều đáp án có thể đúng, nghi sai đáp án, trùng nội dung theo ý nghĩa, phương án nhiễu yếu/lộ đáp án, lỗi chính tả.

Phân tích kết quả (lý thuyết trắc nghiệm cổ điển): tỷ lệ đúng p, độ phân biệt D (nhóm 27% điểm cao trừ 27% điểm thấp), tương quan điểm–câu, tỷ lệ chọn từng phương án ở mỗi nhóm, cảnh báo nhiễu không hiệu quả (< 5% chọn), nhiễu hút nhóm giỏi, nhiễu được chọn nhiều hơn đáp án đúng, độ tin cậy KR-20 và phổ điểm thang 10. Báo cáo của bộ câu hỏi gộp các phiên đã kết thúc dùng đúng các câu hiện tại (khớp theo ID hoặc nội dung) và quy đổi đáp án qua mọi lần xáo trộn, nên sửa đáp án sai sẽ chấm lại các phiên cũ trong báo cáo.

## Lớp học

| Method / path | Body | Thành công |
|---|---|---|
| `GET /classes` / `POST /classes` | `{ name, description? }` | Danh sách / **201** Classroom |
| `GET /classes/:id` / `PATCH` / `DELETE` | `{ name?, description? }` | Classroom gồm students / xóa mềm |
| `POST /classes/:id/students` | `{ students: [{ code: "01", name, externalId? }], replace? }` | **201** Classroom (upsert theo mã, `replace` thay toàn bộ) |
| `PATCH` / `DELETE /classes/:id/students/:studentId` | các trường sinh viên | Classroom |
| `POST /classes/:id/students/import` | file `.xlsx`/`.csv` | **201** `{ students, warnings }` để xem trước, chưa lưu |
| `GET /classes/:id/report` | — | **200** ClassReport: các phiên đã kết thúc, điểm từng sinh viên từng buổi, điểm trung bình |
| `GET /classes/:id/report.xlsx` | — | **200** bảng điểm Excel |

`code` là mã hai chữ số 01–99 sinh viên nhập trên keypad khi tham gia. File danh sách cần cột "Họ và tên"; "STT" được dùng làm mã thiết bị, thiếu/trùng thì tự cấp mã kế tiếp.

## Kỳ thi

| Method / path | Body | Thành công |
|---|---|---|
| `GET /exams` / `POST /exams` | `{ quizId, title, description?, variantCount (1–24), shuffleQuestions, shuffleOptions, durationSeconds? }` | Danh sách / **201** Exam |
| `GET /exams/:id` / `DELETE /exams/:id` | — | Exam gồm mã đề và các phiên / xóa mềm |
| `GET /exams/:id/variants/:code` | — | **200** đề theo mã: thứ tự câu, phương án, đáp án, câu gốc tương ứng |
| `GET /exams/:id/papers.docx?code=` | — | **200** đề in (Word), một mã hoặc tất cả mã, mỗi mã một trang mới |
| `GET /exams/:id/answer-key.xlsx` | — | **200** đáp án mọi mã đề và bảng đối chiếu câu gốc |
| `POST /exams/:id/sessions` | `{ classroomId?, variantCode?, mode?, durationSeconds? }` | **201** SessionSnapshot; bỏ trống variantCode để dùng mã đề ít dùng nhất |
| `GET /exams/:id/report` / `report.xlsx` | — | Thống kê theo lớp (điểm TB, trung vị, độ lệch chuẩn, tỷ lệ đạt, xếp loại), tỷ lệ đúng từng câu theo lớp / bảng điểm Excel |
| `POST /exams/:id/ai-analysis` | — | **201** AiJob `ANALYZE_EXAM` (nhận xét chung và so sánh giữa các lớp) |

Tạo kỳ thi sao chép câu hỏi của bộ tại thời điểm đó, nên sửa bộ câu hỏi sau này không đổi các mã đề. Mã đề đánh số 101, 102… và được sinh lại y hệt từ seed (ID kỳ thi + mã đề). Xếp loại: Giỏi ≥ 8, Khá 6,5–7,9, Trung bình 5–6,4, Yếu 3,5–4,9, Kém < 3,5.
