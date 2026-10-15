# Báo cáo kiểm thử ClassPulse MVP

## Nâng cấp 12/10/2026: nhiều đáp án, nhập file, AI, ngân hàng câu hỏi, kỳ thi

Chạy trong container Node 22 (podman) với PostgreSQL 17.6 và EMQX 5.8.8 tạm thời, tách khỏi dữ liệu thật.

| Nhóm | Lệnh / cách kiểm tra | Kết quả |
|---|---|---|
| Shared types (khóa đáp án, trình đọc câu hỏi, trùng lặp, phân tích câu hỏi, mã đề) | `pnpm --filter @classpulse/shared-types test` | **16/16 đạt** |
| MQTT contracts | `pnpm --filter @classpulse/mqtt-contracts test` | **10/10 đạt** |
| Backend unit (Word/PDF/Excel thật, tách chương, kế hoạch tạo câu, kiểm tra chất lượng, trộn đề, schema gửi Gemini/Ollama/Claude, chọn nguồn AI, luồng NDJSON và lỗi của Ollama, tự chuyển sang Ollama khi hết hạn mức) | `pnpm --filter @classpulse/backend test` | **26/26 đạt** |
| Frontend | `pnpm --filter @classpulse/frontend test` | **13/13 đạt** (thêm ghi chú nguồn AI dự phòng, thời gian tác vụ đã chạy) |
| Device simulator | `pnpm --filter @classpulse/device-simulator test` | **7/7 đạt** |
| Firmware logic C | `pnpm test:firmware` | **5/5 nhóm đạt** (thêm nhóm chọn nhiều đáp án) |
| PostgreSQL integration | `pnpm test:integration` | **16/16 đạt** (10 cũ + 6 mới) |
| Migration trên dữ liệu cũ | migrate schema cũ, chèn dữ liệu A–D, chạy migration mới | **Đạt**: giữ nguyên đáp án, xóa enum cũ, không drift schema, CHECK từ chối khóa sai |
| HTTP smoke + API Gemini/Claude giả lập cục bộ | 24 bước: tải giáo trình, tạo câu theo tỷ lệ, duyệt/loại, nhập TXT/Word/Excel/CSV/PDF, nhận dạng AI, đánh giá đề, ngân hàng, lớp, kỳ thi, quyền sở hữu; chạy một lần với SDK `@google/genai` và một lần với SDK Anthropic | **24/24 đạt** với cả hai (chạy trước khi thêm cơ chế tự chuyển sang Ollama; cơ chế này được kiểm bằng unit test với SDK Anthropic thật và máy chủ giả trả 429) |
| AI thật qua Ollama 0.40.3 + `qwen3:4b-instruct`, chỉ CPU (laptop 16 luồng, 14 GB RAM) | 4 tác vụ qua API backend; xem mục bên dưới | **4/4 tác vụ chạy được**; chất lượng không đều, xem bên dưới |
| UI thật (Chromium 147, bản build production) | 10 kịch bản trên giao diện, kiểm tra lỗi console và request lỗi | **10/10 đạt, không lỗi** |
| End-to-end có sẵn với EMQX thật | `scripts/tests/e2e.ts` | **10/10 nhóm đạt** |
| Simulator trình duyệt ↔ EMQX ↔ backend | câu nhiều đáp án chọn C, A → gửi `AC`; câu một đáp án | **Đạt**, chấm đúng cả hai |
| Build | `pnpm build`, image backend/frontend | **Đạt**; image backend migrate database trống và khởi động |

Chưa kiểm thử: lời gọi Gemini và Claude thật (máy kiểm thử không có GEMINI_API_KEY/ANTHROPIC_API_KEY; request, stream, structured output và việc tự chuyển sang Ollama được kiểm bằng API giả lập), Ollama trên GPU, build/flash ESP-IDF và Arduino trên board thật.

### AI thật với Ollama, chỉ CPU

Ollama 0.40.3, `qwen3:4b-instruct` (2,5 GB), `OLLAMA_NUM_CTX=32768`; laptop 16 luồng CPU, 14 GB RAM, driver NVIDIA không hoạt động nên chạy hoàn toàn trên CPU. Mỗi tác vụ được gọi qua API backend giống giao diện, với PostgreSQL tạm thời.

| Tác vụ | Token vào / ra | Thời gian | Kết quả |
|---|---|---|---|
| Tạo 6 câu (2 dễ, 2 trung bình, 2 khó, 20% nhiều đáp án) từ giáo trình Word 2 chương | 1.799 / 1.915 | 368 s | 6 câu đúng kiến thức, đáp án đúng, tiếng Việt tự nhiên, tất cả chờ duyệt. Lỗi: viết 3 câu nhiều đáp án thay vì 1, đáp án dồn vào A/B, một câu lộ đáp án. Đã sửa bằng kế hoạch từng câu (độ khó, loại, vị trí đáp án chia đều A–D) trong yêu cầu; chạy lại: 361 s, độ khó 2/2/2, đúng 1 câu nhiều đáp án (ACD), đáp án các câu một lựa chọn C, A, B, D, A. Còn lại: một câu vẫn trích nguyên phương án đúng vào đề bài, một lời giải nhắc chữ cái phương án — giáo viên sửa khi duyệt |
| Nhận dạng đề lộn xộn 3 câu (`a/`, `(A)`, `A-`, bảng đáp án cuối đề) | 743 / 562 | 84 s | Đủ 3 câu, đáp án B, A, BC, câu 3 là câu nhiều đáp án. Có một ghi chú rác ("Câu "), nay được lọc |
| Đánh giá đề cài sẵn lỗi (câu mơ hồ, hai đáp án đúng, sai khóa, nhiễu yếu, hai câu trùng) | 1.382 / 2.609 | 440 s | Bắt đúng câu 1 mơ hồ, câu 4 nhiễu vô lý, câu 4–5 trùng. Bỏ sót câu 2 (8883 cũng là cổng MQTT) và câu 3 sai khóa; còn kết luận sai rằng QoS 2 có 3 bước. Mô hình 4B không đủ tin cậy để kiểm tra kiến thức trong đề — nên dùng Gemini cho chức năng này |
| Phân tích kết quả buổi học 24 sinh viên (dữ liệu giả lập) | 1.438 / 1.375 | 262 s | Nêu đúng KR-20 âm, các câu có phương án nhiễu được chọn nhiều hơn đáp án, câu quá dễ và nhiễu không ai chọn, kèm gợi ý dạy lại; chưa nhận ra 8883 cũng là cổng MQTT hợp lệ |

Bộ nhớ: nạp với ngữ cảnh f16 mô hình chiếm 7,6 GB và đẩy máy vào swap; với `OLLAMA_KV_CACHE_TYPE=q8_0` còn 5,3 GB (đã đặt trong service `ollama` của compose). Khi tiến trình Ollama bị dừng giữa chừng, tác vụ báo "Ollama dừng giữa chừng, thường do máy chủ không đủ RAM…" thay vì lỗi JSON khó hiểu.

---


Ngày kiểm thử ứng dụng: **29/09/2026**; bổ sung firmware và chạy lại unit/build ngày **30/09/2026**. Môi trường thực thi của Codex không có Docker daemon, nên dịch vụ runtime được chạy trực tiếp bằng PostgreSQL 18.6 và EMQX Community 5.8.8. Cấu hình Compose đã được render và kiểm tra bằng Docker Compose CLI v2.39.4; việc build/start toàn bộ container cần được chạy lại trên máy có Docker.

## Kết quả cuối

| Nhóm | Lệnh / cách kiểm tra | Kết quả |
|---|---|---|
| MQTT contracts + thống kê | `pnpm --filter @classpulse/mqtt-contracts test` | **7/7 đạt** |
| Backend unit | `pnpm --filter @classpulse/backend test` | **8/8 đạt** |
| Frontend component/hooks | `pnpm --filter @classpulse/frontend test` | **11/11 đạt** |
| Device simulator logic | `pnpm --filter @classpulse/device-simulator test` | **6/6 đạt** |
| ESP32 firmware logic | `pnpm test:firmware` | **4/4 nhóm đạt** |
| PostgreSQL integration | `pnpm test:integration` với database đã migrate | **9/9 đạt** |
| End-to-end thật | `node --import tsx scripts/tests/e2e.ts` | **10/10 nhóm đạt** |
| Load generator | 50 thiết bị, duplicate bật, delay tối đa 100 ms | **50 join + 50 answer, 0 reject, 0 timeout** |
| Production build | `pnpm build` | **Đạt** |
| Compose schema | `docker compose --env-file .env.example config --quiet` | **Đạt** |
| Kiểm tra UI thật | in-app Chromium trên Vite + API + EMQX + PostgreSQL | **Đạt** |

Tổng unit/component test TypeScript/React: **32/32 đạt**, cộng **4/4 nhóm** logic firmware C. Build production sinh bundle chính khoảng 285 kB và simulator lazy chunk khoảng 436 kB trước gzip; Vite không báo lỗi build.

Test firmware host biên dịch `classpulse_logic.c` với `cc -std=c11 -Wall -Wextra -Werror`, rồi kiểm tra luồng nhập room/student, Xóa/Confirm, chọn A–D, cuộn mã chẵn/lẻ theo cặp, giới hạn sequence và validation deviceId. Phần phụ thuộc ESP-IDF/BLE/Wi-Fi/GPIO cần toolchain và board thật để build/flash.

## Phạm vi integration backend

Bộ `services.integration.test.ts` chạy với PostgreSQL thật và kiểm tra:

- đăng ký, đăng nhập, xác minh JWT, refresh rotation và phát hiện replay;
- giáo viên khác không đọc/sửa quiz hoặc điều khiển session;
- session giữ snapshot câu hỏi sau khi quiz gốc được sửa/xóa;
- join hợp lệ, phòng không tồn tại, trùng studentCode/deviceId;
- nhận đủ A/B/C/D, chỉ tính answer có sequence mới nhất;
- từ chối answer sai, thiết bị chưa join, questionId sai, quá deadline;
- hai delivery QoS 1 đồng thời chỉ ghi một lần; requestId dùng lại với payload khác bị từ chối;
- 50 thiết bị ghi gần đồng thời không mất answer;
- snapshot sau reload giữ deadline; timer được phục hồi sau restart logic và tự next/finish.

Tests tạo teacher/quiz/session/device riêng bằng UUID rồi xóa đúng dữ liệu test. Dữ liệu seed/demo không được reset.

## Phạm vi end-to-end

Script `scripts/tests/e2e.ts` dùng REST API đang chạy, MQTT TCP qua EMQX, PostgreSQL, và Socket.IO thật. Mười nhóm đã đạt:

1. Register/login/profile, refresh cookie xoay và logout thu hồi refresh.
2. Quyền sở hữu quiz/session và snapshot không đổi khi sửa quiz.
3. Socket.IO xác thực, cho chủ sở hữu join room và từ chối giáo viên khác.
4. Join phòng lỗi/thành công, topic-deviceId mismatch và duplicate join.
5. Thống kê 0 an toàn, correctAnswer bị ẩn, retained question và deadline server.
6. Đổi A/B/C/D, duplicate request, stale sequence, answer/question/device không hợp lệ.
7. 50 MQTT device join và answer gần đồng thời, realtime đạt đủ 51/51 khi cộng thiết bị kiểm thử chính.
8. Close khóa answer mới, công bố correct/wrong; manual next và finish.
9. TIMER tự close, chờ kết quả, mở câu sau và finish không cần browser.
10. Logout làm refresh cookie cũ không dùng lại được.

## Kết quả load generator độc lập

Lệnh đã chạy trên phòng thật đang `QUESTION_ACTIVE`:

```bash
node --import tsx scripts/simulate-devices/index.ts \
  --devices=50 --room=123456 --duplicates --delay=100
```

Kết quả:

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

`accepted=200` gồm 50 join, 50 answer và 100 duplicate ACK có `success=true`/`originalCode` đúng. Database/realtime vẫn chỉ có 50 participant và 50 answer mới từ lần chạy này.

## Kiểm tra broker và ACL

Kiểm tra trực tiếp với EMQX 5.8.8 đã xác nhận:

- kết nối anonymous bị từ chối;
- simulator subscribe ACK của chính clientId được phép;
- simulator subscribe ACK của device khác bị từ chối;
- simulator không thể publish giả ACK;
- backend kết nối bằng credential riêng, subscribe các topic thiết bị và publish retained room state;
- browser MQTT over WebSocket kết nối được tại `/mqtt` và nhận ACK QoS 1.

## Kiểm tra UI bằng trình duyệt

Luồng demo đã thao tác trực tiếp:

- đăng nhập `demo@classpulse.local` và tải dashboard từ API;
- mở phòng `123456`, đổi thời lượng câu tiếp theo thành 120 giây;
- simulator hiển thị đúng keypad 4×4 và hai LED 7 đoạn;
- nhập roomCode, studentCode `20260001`, nhận `JOIN_ACCEPTED` trong 51 ms;
- giáo viên thấy participant realtime, start câu; simulator nhận retained question/deadline;
- chọn B, Xóa, chọn A rồi Confirm; nhận `ANSWER_ACCEPTED` trong 50 ms;
- dashboard chuyển 0/1 thành 1/1 mà không lộ lựa chọn cá nhân khi câu còn mở;
- presentation reload vẫn giữ câu và countdown server;
- sau load 50 device, control/presentation hiển thị 51/51;
- close công bố đáp án A, phân phối A/B/C/D và đúng/sai; presentation cập nhật realtime.

## Điểm chưa xác minh trong môi trường này

Chưa thể chạy `docker compose up --build` vì host kiểm thử không có Docker daemon. Đã xác minh Compose render đủ 5 service (`postgres`, `broker-config`, `emqx`, `backend`, `frontend`), volume, healthcheck và port; Dockerfiles/Compose vẫn cần một smoke run trên máy đích có Docker. Môi trường cũng không có ESP-IDF hoặc board ESP32, nên firmware chưa được `idf.py build`, flash hay đo điện trên phần cứng thật; chỉ phần logic độc lập đã được biên dịch và chạy trên host.

Sau khi clone trên máy đích, tiêu chí chấp nhận ngắn nhất là:

```bash
cp .env.example .env
docker compose up --build -d
docker compose exec backend pnpm db:seed
docker compose ps
curl -f http://localhost:3000/api/health
```

Sau đó chạy `pnpm test:e2e` theo README và thử một tab simulator qua `http://localhost/device-simulator`.
