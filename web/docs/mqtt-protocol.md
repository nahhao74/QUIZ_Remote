# Giao thức MQTT ClassPulse v1

Nguồn kiểu dữ liệu và validation dùng chung: `packages/mqtt-contracts/src/index.ts`; kiểu câu hỏi và trạng thái: `packages/shared-types/src/index.ts`. Backend là nơi duy nhất quyết định quyền tham gia, thời gian và đáp án hợp lệ. Simulator và ESP32 không kết nối PostgreSQL, không gửi thống kê trực tiếp tới web giáo viên.

Firmware ESP-IDF hiện thực giao thức này ở [`apps/firmware`](../apps/firmware/README.md). Credential Wi-Fi/MQTT được ghi qua BLE GATT và lưu NVS, không hard-code trong source. Firmware subscribe ACK trước khi gửi join, dùng QoS 1, giữ nguyên request khi retry và lưu pending request/sequence qua reset.

## Broker và danh tính

- MQTT TCP: `mqtt://localhost:1883`; MQTT over WebSocket cho trình duyệt: `ws://localhost:8083/mqtt`.
- Frontend triển khai HTTPS cần endpoint `wss://` có chứng chỉ hợp lệ.
- Trong Docker, backend dùng hostname `emqx`; trình duyệt dùng hostname có thể truy cập từ máy người dùng.
- Tài khoản phát triển cho simulator: `simulator` / `simulator-dev-only`. Đây là credential phát triển công khai, không phải tài khoản quản trị EMQX.
- Anonymous bị tắt. Backend có tài khoản riêng để nhận các topic thiết bị và xuất ACK/trạng thái.
- MQTT `clientId` phải chính xác bằng `deviceId`. Mỗi tab/thiết bị có ID riêng, từ 3 đến 64 ký tự thuộc `[a-zA-Z0-9_-]`.
- ACL simulator chỉ cho publish `quiz/v1/devices/${clientid}/join`, `/answer`, `/status`; subscribe `/ack`, `/command` của chính clientId và topic `/question`, `/state` của phòng. Không được publish ACK, trạng thái phòng, command hoặc topic thiết bị khác. Mặc định từ chối các quyền còn lại.
- ACL dựa trên `${clientid}` cùng một credential chia sẻ chỉ đủ cho môi trường phát triển: người biết mật khẩu có thể tự chọn clientId của thiết bị khác. Production phải provision danh tính riêng cho từng thiết bị và ràng buộc username/chứng chỉ với clientId (mTLS hoặc cơ chế xác thực HTTP/JWT phù hợp), giới hạn quyền đọc theo phòng được cấp. Thay toàn bộ mật khẩu mẫu trước khi triển khai.

Web simulator đọc `VITE_MQTT_WS_URL`, `VITE_MQTT_USERNAME`, `VITE_MQTT_PASSWORD` (cũng hỗ trợ alias `VITE_MQTT_SIMULATOR_USERNAME`, `VITE_MQTT_SIMULATOR_PASSWORD`) tại thời điểm build, hoặc cấu hình trực tiếp trong trang. Mọi biến `VITE_` đều có thể đọc được từ trình duyệt; tuyệt đối không dùng credential quản trị/backend.

## Provision thiết bị cho production

Repo có lệnh provision tài khoản riêng cho từng thiết bị:

```bash
MQTT_DEVICE_PASSWORD='<mật-khẩu-riêng-ít-nhất-12-ký-tự>' pnpm provision --deviceId=device-001
```

Lệnh chạy từ máy quản trị, nạp `.env`, dùng `EMQX_DASHBOARD_USER` / `EMQX_DASHBOARD_PASSWORD` để gọi API quản trị (`EMQX_API_URL`, mặc định `http://127.0.0.1:18083/api/v5`). Credential quản trị không đưa vào frontend. Thiết bị được cấp `username=device-001`, `clientId=device-001`, cùng mật khẩu riêng trong `MQTT_DEVICE_PASSWORD`.

ACL cho tài khoản `device-*` ràng buộc topic với **`${username}` đã xác thực**, thay vì `${clientid}` do client tự chọn. Vì vậy thay clientId không cấp quyền publish/subscribe topic thiết bị khác. Quyền đọc snapshot phòng hiện dùng `rooms/+`; nếu nội dung lớp cần bảo mật, bổ sung authorization động theo phòng. Đặt `MQTT_SIMULATOR_ENABLED=false` để tắt tài khoản phát triển chia sẻ khi dùng thiết bị provision. Dùng TLS cho MQTT/WebSocket và đổi credential mẫu trước khi triển khai.

## Topics

| Topic | Bên gửi → nhận | QoS | Retain |
|---|---|---:|---|
| `quiz/v1/devices/{deviceId}/join` | Thiết bị → backend | 1 | false |
| `quiz/v1/devices/{deviceId}/answer` | Thiết bị → backend | 1 | false |
| `quiz/v1/devices/{deviceId}/status` | Thiết bị → backend | 1 | false |
| `quiz/v1/devices/{deviceId}/ack` | Backend → thiết bị | 1 | false |
| `quiz/v1/devices/{deviceId}/command` | Backend → thiết bị | 1 | false |
| `quiz/v1/rooms/{roomCode}/question` | Backend → thiết bị | 1 | true |
| `quiz/v1/rooms/{roomCode}/state` | Backend → thiết bị | 1 | true |

`command` gửi kết quả riêng cho thiết bị khi phiên kết thúc. Hai topic phòng mang **cùng cấu trúc `RoomState`** để thiết bị vừa kết nối có đủ snapshot từ retained message. Không retain join/answer/ACK/command để tránh thực thi lại thao tác cũ khi subscribe. Thiết bị bỏ snapshot có `serverTimestamp` cũ hơn snapshot đã nhận.

Khi phiên chuyển sang `FINISHED`, backend publish lên topic command của từng thiết bị:

```json
{"type":"RESULT","roomCode":"123456","score":8,"correct":4,"total":5,"serverTimestamp":"2026-09-29T09:05:00.000Z"}
```

`score` là điểm thang 10, làm tròn số nguyên để hiển thị vừa hai digit. Firmware chỉ nhận kết quả trùng `roomCode` đang tham gia. Sau khi xem điểm, nhấn `*` để xóa trạng thái phiên và nhập mã phòng mới.

Thiết bị phải subscribe topic ACK của mình **trước khi** publish join. Subscribe state/question của phòng khi đã nhập roomCode; chỉ coi đã tham gia sau ACK thành công.

## JSON và trường chung

UTF-8 JSON object, không chấp nhận trường lạ. Trường bắt buộc của mọi message thiết bị:

| Trường | Quy tắc |
|---|---|
| `requestId` | UUID; mới cho mỗi thao tác người dùng, giữ nguyên khi retry cùng thao tác |
| `deviceId` | Trùng ID trong topic và danh tính client được broker cấp phép |
| `roomCode` | Chuỗi đúng 6 chữ số, giữ số 0 ở đầu |
| `clientTimestamp` | ISO-8601 có múi giờ; chỉ dùng để chẩn đoán |

Server dùng thời gian của server/database để xét deadline. Không thể gia hạn bằng việc sửa đồng hồ thiết bị. Topic phải khớp chính xác mẫu và `deviceId` trong payload phải trùng topic; sai khác trả `INVALID_PAYLOAD`.

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

`studentCode` gồm 1–32 ký tự `[A-Za-z0-9_-]`. Backend hỗ trợ mã chữ/số để phần cứng tương lai có thể nhập qua cấu hình; keypad MVP nhập mã **dạng số**. Một thiết bị và một mã sinh viên chỉ ánh xạ tới một participant trong session. Join lại cùng thông tin là an toàn; đổi mã sinh viên trên cùng thiết bị trong session bị từ chối để bảo vệ danh tính đáp án.

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

`answer` là **khóa chuẩn**: một chữ `A`–`D`, hoặc với câu nhiều đáp án (`currentQuestion.type = "MULTIPLE"`) nhiều chữ theo thứ tự bảng chữ cái, không lặp (`AC`, `ABD`). Thiết bị cũ chỉ gửi một chữ vẫn hợp lệ. Khóa sai thứ tự (`CA`), lặp chữ hoặc ký tự khác bị `INVALID_ANSWER`; gửi nhiều chữ cho câu `SINGLE` cũng bị `INVALID_ANSWER`. Câu nhiều đáp án chỉ được tính đúng khi khóa khớp hoàn toàn. `questionId` là UUID. `sequence` là số nguyên 1–2.147.483.647, tăng dần cho mỗi cặp deviceId/questionId. Một lần Confirm mới tạo requestId mới và sequence lớn hơn; retry cùng lần Confirm giữ nguyên **toàn bộ payload**, gồm requestId, sequence và timestamp.

Chỉ nhận khi thiết bị đã join, session đang `QUESTION_ACTIVE`, questionId chính xác và server chưa tới `questionEndsAt`. Đáp án hợp lệ có sequence mới nhất ghi đè đáp án hiện hành; bản ghi chống trùng giữ payload hash và ACK trong database, không lưu toàn bộ nội dung các lần thay đáp án. Message đến đảo thứ tự có sequence thấp hơn không được ghi đè đáp án mới. Khi câu đã đóng, mọi thay đổi mới đều bị từ chối.

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

Status báo trạng thái thiết bị qua pipeline backend; nó không tự tham gia phòng hoặc cấp quyền trả lời. Simulator hiển thị trạng thái kết nối thực của mqtt.js. Chỉ báo Wi-Fi trên web phản ánh `navigator.onLine`, không đo sóng Wi-Fi ESP32.

## ACK và idempotency

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

Backend ACK sau khi transaction hoàn tất. MQTT PUBACK chỉ xác nhận broker đã nhận gói tin; **không thay thế** ACK ứng dụng nêu trên. Chỉ báo thành công trên thiết bị sau ACK ứng dụng có cùng requestId. Không dùng trường `message` để xử lý logic, vì nội dung có thể đổi ngôn ngữ.

Bản ghi `ProcessedMqttMessage` với requestId unique ngăn QoS 1/retry làm tăng thống kê hoặc ghi lại đáp án. Khi nhận lại message đã xử lý, trả:

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

`success` phản ánh kết quả gốc; duplicate của một message bị từ chối cũng có `success: false`. Không mặc định xem mọi `DUPLICATE_MESSAGE` là lỗi hoặc là thành công. Dùng `success` cùng `originalCode`. Không tái sử dụng một requestId cho payload/thao tác khác.

Simulator đợi 4 giây rồi retry với requestId không đổi, tối đa 3 lần gửi. Sau khoảng 12 giây không có ACK, trạng thái kết quả là chưa biết; backend có thể đã lưu dù ACK bị mất. Khi kết nối lại, retained room state khôi phục câu hiện tại. Một Confirm mới có sequence lớn hơn nên không bị message retry cũ ghi đè. Firmware production nên lưu request đang chờ và sequence trong NVS để không mất chúng khi reset; web simulator lưu sequence theo deviceId/questionId trong localStorage.

| `code` | Ý nghĩa |
|---|---|
| `JOIN_ACCEPTED` | Thiết bị đã được liên kết với participant |
| `ANSWER_ACCEPTED` | Đáp án hiện hành đã lưu |
| `STATUS_ACCEPTED` | Đã cập nhật trạng thái thiết bị |
| `INVALID_PAYLOAD` | JSON, schema, topic hoặc ID không hợp lệ |
| `DEVICE_NOT_JOINED` | Chưa tham gia session |
| `ROOM_NOT_FOUND` | Không tìm thấy phòng |
| `SESSION_NOT_ACTIVE` | Session đã kết thúc hoặc không cho phép thao tác |
| `QUESTION_NOT_ACTIVE` | Câu chưa mở/đã đóng hoặc questionId không khớp |
| `QUESTION_EXPIRED` | Server đã tới deadline |
| `INVALID_ANSWER` | Đáp án không phải khóa chuẩn A–D, hoặc nhiều chữ cho câu một đáp án |
| `DUPLICATE_MESSAGE` | requestId đã xử lý; xem kết quả gốc |
| `STALE_SEQUENCE` | sequence không mới hơn đáp án hiện hành |
| `STUDENT_ALREADY_JOINED` | Mã sinh viên đang thuộc thiết bị khác |
| `DEVICE_ALREADY_JOINED` | Thiết bị đang thuộc mã sinh viên khác |
| `SERVER_ERROR` | Lỗi backend; kiểm tra kết nối và retry theo chính sách |

## Retained RoomState / câu hỏi

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
    "content": "MQTT QoS 1 có đặc điểm nào?",
    "optionA": "Không gửi lại message",
    "optionB": "Có thể nhận message nhiều lần",
    "optionC": "Không cần broker",
    "optionD": "Chỉ hỗ trợ HTTP",
    "type": "SINGLE",
    "durationSeconds": 30,
    "order": 0
  }
}
```

`currentQuestion.type` là `SINGLE` hoặc `MULTIPLE`. Với `MULTIPLE`, mỗi phím A–D bật/tắt một chữ và thiết bị gửi khóa đã sắp xếp; LED hiển thị các chữ đã chọn (cuộn theo cặp khi nhiều hơn hai). Lời giải (`explanation`) chỉ hiển thị trên web, không bao giờ gửi xuống thiết bị. Nếu phiên trộn câu/đáp án, `content` và `optionA`–`optionD` đã là thứ tự hiển thị của phiên đó.

Không có `correctAnswer` khi `QUESTION_ACTIVE`. Sau khi đóng câu, backend có thể cung cấp đáp án đúng để công bố kết quả. Lobby có `currentQuestion: null`, `currentQuestionIndex: -1`, `questionStartedAt: null`, `questionEndsAt: null`. Không suy ra deadline bằng lúc client nhận message retained, vì đó có thể là bản tin từ trước. Đọc tuyệt đối `questionEndsAt`; backend luôn có quyền từ chối nếu đồng hồ thiết bị lệch.

Chu trình trạng thái: `LOBBY → QUESTION_ACTIVE → QUESTION_CLOSED → QUESTION_ACTIVE … → FINISHED`. Cả MANUAL và TIMER đều đóng nhận đáp án khi deadline tới. MANUAL chờ giáo viên chọn câu tiếp; TIMER chờ 3 giây để xem kết quả rồi mở câu tiếp hoặc kết thúc. Sau restart backend, lịch chạy được dựng lại từ deadline trong database.

## Ánh xạ keypad / LED cho firmware

```text
1    2    3       A
4    5    6       B
7    8    9       C
Xóa  0    Confirm D
```

1. Nhập 6 số roomCode; Confirm chuyển sang mã sinh viên. Xóa xóa một số.
2. Nhập mã sinh viên dạng số; Confirm publish join. ACK thành công chuyển trạng thái sẵn sàng.
3. A/B/C/D chọn đáp án; chưa gửi. Xóa hủy lựa chọn. Confirm gửi answer cho câu đang mở.
4. Cho phép thay đổi và Confirm lại trước deadline, tăng sequence.
5. Hai chữ số LED chỉ hiển thị đồng thời hai ký tự: `123456 → 12 → 34 → 56 → 12`. Mã lẻ được thêm khoảng trắng ở cuối, không thêm số 0. Simulator cuộn mỗi 700 ms.
6. Ở trạng thái đã join, dấu chấm trái bật; dấu chấm phải nhấp nháy khi chờ ACK. Chưa chọn đáp án thì hiển thị số thứ tự câu (cuộn nếu quá 2 số); khi chọn, hiển thị A/B/C/D (B, D biểu diễn kiểu chữ thường bằng 7 đoạn).
7. Giữ Xóa 3 giây để xóa danh tính phiên trong NVS và quay lại bước nhập roomCode; thao tác này không xóa credential Wi-Fi/MQTT đã provision qua BLE.

Mỗi tab mới được cấp ID riêng; reload giữ ID của tab và localStorage lưu sequence. Nhập lại ID cũ bằng cấu hình để mô phỏng reconnect thiết bị đó. Hai client cố dùng cùng clientId có thể bị broker ngắt kết nối luân phiên.

## Kiểm thử nhiều thiết bị

Tạo session, ghi lại mã phòng, rồi chạy:

```bash
pnpm simulate --devices=50 --room=123456
pnpm simulate --devices=50 --room=123456 --duplicates
MQTT_URL=mqtt://localhost:1883 MQTT_SIMULATOR_USERNAME=simulator MQTT_SIMULATOR_PASSWORD=simulator-dev-only pnpm simulate --devices=50 --room=123456 --duplicates --timeout=90 --delay=1200
```

Lệnh `pnpm simulate` nạp `.env` qua `scripts/with-env.mjs`. Script **chỉ** đọc `MQTT_SIMULATOR_USERNAME` / `MQTT_SIMULATOR_PASSWORD` cho tài khoản thiết bị; không dùng `MQTT_USERNAME` / `MQTT_PASSWORD` của backend. Nếu chưa đặt, mặc định là `simulator` / `simulator-dev-only`. `MQTT_URL` chọn broker.

Script tạo danh tính mới cho mỗi lần chạy, subscribe ACK/state trước khi join, đợi giáo viên mở câu hỏi, thêm độ trễ ngẫu nhiên 0–1200 ms, chọn A/B/C/D ngẫu nhiên rồi gửi QoS 1. Mỗi lần chạy trả lời một câu và kết thúc; chạy lại để kiểm thử một lượt mới. `--duplicates` gửi lại payload join và answer đã nhận ACK với cùng requestId để kiểm tra kết quả gốc/idempotency. Script dùng cùng cơ chế retry 4 giây/tối đa 3 lần cho ACK bị mất.

Kết quả JSON có số connected, joined, answered, accepted, rejected, timeout, duplicateAccepted/Rejected/Unexpected, retries, lỗi transport, phân phối ACK code và độ trễ p50/p95/max. accepted/rejected đếm ACK (kể cả duplicate); joined/answered đếm số thiết bị. Exit code khác 0 khi thiếu join/answer, timeout, ACK lỗi hoặc duplicate sai kết quả. Khi chưa mở câu trong `--timeout` (mặc định 90 giây), run kết thúc với timeout. Không có nhánh ghi thẳng database.
