# ClassPulse — lớp học tương tác với thiết bị ESP32

MVP monorepo: giáo viên tạo quiz, mở phòng và trình chiếu; sinh viên dùng keypad 4×4 giả lập để join và xác nhận A/B/C/D qua MQTT. NestJS xác thực dữ liệu, lưu PostgreSQL, trả ACK và cập nhật web qua Socket.IO. Giao diện tiếng Việt; không cần tài khoản sinh viên.

Ngoài luồng cơ bản, hệ thống có:

- **Câu một hoặc nhiều đáp án** — câu nhiều đáp án chấm đúng khi chọn đủ và đúng; keypad bấm A–D để bật/tắt từng phương án.
- **Nhập câu hỏi từ Word, Excel, PDF, TXT/CSV** — nhận dạng đáp án qua dòng "Đáp án", bảng đáp án cuối đề, phương án gạch chân/tô màu trong Word; có file mẫu và nhận dạng bằng AI cho tài liệu khó/PDF scan.
- **Trợ lý AI tạo câu hỏi** (Gemini miễn phí, Ollama chạy cục bộ không giới hạn, hoặc Claude) — tải giáo trình, chọn chương, số câu và tỷ lệ dễ/trung bình/khó; AI đề xuất câu hỏi kèm lời giải và kiến thức kiểm tra, **chờ giáo viên duyệt** mới vào bộ đề.
- **Ngân hàng câu hỏi** — tìm kiếm không dấu trên mọi bộ câu hỏi và phát hiện câu trùng/gần giống.
- **Đánh giá chất lượng đề** — kiểm tra tự động và bằng AI: câu mơ hồ, thiếu dữ kiện, nhiều đáp án có thể đúng, câu trùng nội dung, phương án nhiễu; phân tích kết quả làm bài (độ khó, độ phân biệt, hiệu quả phương án nhiễu, KR-20).
- **Quản lý kỳ thi** — trộn đề và xáo trộn đáp án thành nhiều mã đề, in đề Word, đáp án Excel, mở phiên thi theo lớp, thống kê điểm theo lớp và nhận xét AI.

## Chạy từ máy mới

Yêu cầu: Docker Engine/Desktop có **Compose v2**, RAM đề nghị 4 GB. Node.js **22 LTS** và **pnpm 10.17.1** chỉ cần cho phát triển hoặc chạy lệnh bên ngoài container. Có thể cài pnpm bằng `corepack enable && corepack prepare pnpm@10.17.1 --activate` sau khi cài Node.

```bash
cp .env.example .env
docker compose up --build -d
docker compose exec backend pnpm db:seed
```

Nếu Docker CLI trên máy đang dùng Podman rootless, cài proxy localhost một lần để dùng URL không có số cổng:

```bash
sudo ./scripts/install-localhost-proxy.sh
```

Script tự dùng Apache nếu Apache đang giữ cổng 80; nếu cổng còn trống, script cài socket proxy chỉ lắng nghe loopback. Cả hai cách đều chuyển `http://localhost` sang frontend rootless tại `127.0.0.1:8080`. Docker Engine chạy rootful có thể thay mapping frontend thành `80:80` và không cần proxy này.

Backend tự chạy `prisma migrate deploy` trước khi khởi động. Seed là lệnh riêng, có thể chạy lại mà không ghi đè tài khoản demo hoặc reset tiến độ phòng đang tồn tại. Chờ tất cả dịch vụ healthy bằng `docker compose ps`.

| Địa chỉ | Công dụng |
|---|---|
| http://localhost | Web giáo viên |
| http://localhost/device-simulator | ESP32 giả lập trong trình duyệt |
| http://localhost:3000/api/docs | Swagger UI |
| http://localhost:3000/api/docs-json | OpenAPI JSON |
| http://localhost:3000/api/health | Health API / PostgreSQL / MQTT |
| http://localhost:18083 | Dashboard EMQX |

Tài khoản **phát triển** trong seed: `demo@classpulse.local` / `Demo@12345`. EMQX Dashboard: `admin` / `Admin-dev-only-123`. Có thể tự đăng ký giáo viên khác trong web. Mỗi giáo viên chỉ đọc, sửa và điều khiển dữ liệu của mình.

### Bật/tắt hằng ngày trên máy dùng Podman

Máy cài sẵn Compose tại `.runtime/docker-compose` và Apache chuyển `http://localhost` sang frontend. Chạy trong thư mục dự án:

```bash
cd /var/www/html
export DOCKER_HOST=unix:///run/user/$(id -u)/podman/podman.sock
./.runtime/docker-compose --profile ollama up -d     # bật (bỏ --profile ollama nếu không dùng AI cục bộ)
./.runtime/docker-compose ps                         # đợi khoảng 1 phút, mọi dịch vụ phải "healthy"
./.runtime/docker-compose --profile ollama stop      # tắt, dữ liệu vẫn giữ nguyên
```

Sau khi bật, mở http://localhost. Sau khi sửa mã nguồn, thêm `--build` vào lệnh bật để build lại image.

**http://localhost báo 503 (Service Unavailable):**

- Vừa bật: đợi backend khởi động xong.
- IP Wi-Fi của máy đổi (đổi mạng, khởi động lại router): EMQX chỉ mở cổng MQTT 1883 trên địa chỉ ghi ở `MQTT_TCP_BIND_ADDRESS` trong `.env`. Nếu địa chỉ đó không còn, EMQX không chạy, kéo theo backend và frontend cũng không chạy. Xem IP mới bằng `ip -4 addr show` (ví dụ card Wi-Fi `wlp3s0`), sửa `MQTT_TCP_BIND_ADDRESS=<IP mới>` trong `.env`, chạy lại lệnh bật và cấu hình lại thiết bị ESP32 tới IP mới. Nên đặt IP cố định cho máy trong router.
- Xem lỗi cụ thể: `./.runtime/docker-compose logs --tail 50 backend emqx`.

### Thử một tiết học

1. Đăng nhập web giáo viên. Chọn quiz **Khám phá thế giới công nghệ**, xem trước hoặc sửa nội dung. Khi tạo/sửa quiz, dùng **Nhập từ file** để nạp nhanh câu hỏi từ Word, Excel, PDF hoặc TXT; nút **File mẫu** cho biết đúng định dạng.
2. Chọn **Mở phiên học**, đặt chế độ điều khiển và thời gian. Phòng demo `123456` cũng có sẵn trong lịch sử sau seed.
3. Vào lobby, mở **Trình chiếu** ở một tab riêng; có thể bật fullscreen. Tab này dùng cùng phiên đăng nhập giáo viên.
4. Mở `/device-simulator`. Mỗi tab tạo deviceId riêng; mở thêm tab để mô phỏng nhiều sinh viên.
5. Dùng keypad nhập mã phòng 6 số → **Confirm** → mã sinh viên (ví dụ `20260001`) → **Confirm**. Chờ ACK `JOIN_ACCEPTED`. Mã dài cuộn từng cặp trên đúng hai LED 7 đoạn.
6. Giáo viên chọn **Bắt đầu**. Simulator nhận câu hiện tại từ retained MQTT room state.
7. Bấm A/B/C/D rồi **Confirm** để gửi. **Xóa** hủy lựa chọn chưa gửi. Có thể chọn lại và Confirm trước deadline; chỉ lần hợp lệ có sequence mới nhất được tính.
8. Quan sát số đã trả lời, số còn lại và biểu đồ. Đáp án đúng và lựa chọn của từng sinh viên chỉ hiện khi đóng câu.
9. Dùng **Đóng nhận trả lời**, **Câu tiếp theo**, **Kết thúc**. Chế độ TIMER tự đóng theo deadline server, chờ 3 giây hiển thị kết quả, rồi mở câu kế tiếp.
10. Xem báo cáo cuối phiên và lịch sử. Trong khung **Sinh viên tham gia**, chọn **Xuất CSV** để tải kết quả từng sinh viên và từng câu hỏi. Reload trang giữ nguyên câu, deadline và kết quả từ server.

### Nhập câu hỏi từ Word, Excel, PDF, TXT

Trong trang tạo/sửa bộ câu hỏi, chọn **Nhập từ file** (`.docx`, `.xlsx`, `.csv`, `.pdf`, `.txt`, tối đa 20 MB, 200 câu). Câu nhập vào hiện trong editor kèm danh sách lưu ý; câu thiếu phương án hoặc chưa có đáp án được đánh dấu đỏ và phải sửa trước khi lưu. Nút **File mẫu** tải mẫu Excel, Word hoặc TXT.

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

- Câu bắt đầu bằng `Câu N:`, `Question N`, `QN:` hoặc `N.`; phương án `A.`, `A)`, `(A)` trên từng dòng hoặc chung một dòng; câu dẫn có thể nhiều dòng, kể cả các ý a), b), c).
- Đáp án: dòng `Đáp án: B` / `Đáp án: A, C`, dấu `*` trước phương án, bảng đáp án cuối tài liệu (`1-A, 2-C`, `1A 2C` hoặc bảng hai dòng `Câu | 1 | 2` – `Đáp án | A | C`), mục "Hướng dẫn giải" (`Câu 2: Chọn C vì …`). Trong Word, phương án được gạch chân, tô màu chữ, tô nền hoặc in đậm cũng được nhận là đáp án (có cảnh báo để kiểm tra lại).
- Dòng tùy chọn: `Giải thích:`/`Lời giải:`, `Kiến thức:`, `Chủ đề:`, `Độ khó:` (Dễ/Trung bình/Khó, Nhận biết/Thông hiểu/Vận dụng hoặc nhãn `[NB]`, `[TH]`, `[VD]`), `Loại: nhiều đáp án`, `Thời gian:`. Tiêu đề `Chương …`/`Phần …` hoặc Heading trong Word gán chủ đề cho các câu sau.
- Excel/CSV: mỗi dòng một câu, các cột STT, Câu hỏi, A, B, C, D, Đáp án (chữ hoặc số 1–4, nhiều đáp án như `A, C`), Loại, Thời gian (giây), Độ khó, Chủ đề, Kiến thức kiểm tra, Lời giải.
- PDF cần có lớp chữ. PDF scan, file trình bày phức tạp: dùng **Nhận dạng bằng AI** (cần ANTHROPIC_API_KEY). File `.doc`/`.xls` đời cũ cần lưu lại dạng `.docx`/`.xlsx`.

### Câu hỏi nhiều đáp án

Mỗi câu chọn loại **Một đáp án** (nút tròn) hoặc **Nhiều đáp án** (ô đánh dấu). Màn chiếu và simulator ghi rõ "chọn tất cả phương án đúng". Trên keypad, câu nhiều đáp án dùng A–D để bật/tắt từng chữ, LED hiện các chữ đã chọn (ví dụ `AC`), Confirm để gửi, Xóa để bỏ hết. Sinh viên chỉ được tính đúng khi chọn đủ và đúng mọi đáp án; biểu đồ đếm số sinh viên chọn từng phương án nên tổng có thể vượt 100%. Thiết bị/firmware cũ chỉ gửi một chữ vẫn dùng được với câu một đáp án.

### Trợ lý AI

AI dùng được một trong ba nguồn, cấu hình trong `.env` rồi khởi động lại backend (`docker compose up -d backend`). Không cấu hình gì thì mọi chức năng khác vẫn chạy; các nút AI bị tắt kèm hướng dẫn.

| Nguồn | Chi phí, giới hạn | Cấu hình |
|---|---|---|
| **Google Gemini** (mặc định nếu có khóa) | Miễn phí với hạn mức số yêu cầu/token mỗi phút và mỗi ngày (xem trong AI Studio, đặt lại lúc 0h giờ Thái Bình Dương). Nội dung gửi qua gói miễn phí có thể được Google dùng để cải thiện sản phẩm. | `GEMINI_API_KEY=...` (tạo miễn phí tại aistudio.google.com/apikey), tùy chọn `GEMINI_MODEL` (mặc định `gemini-3.8-flash`) |
| **Ollama** (mô hình chạy trên máy chủ) | Miễn phí, **không giới hạn**, dữ liệu không rời máy chủ. Chất lượng và tốc độ phụ thuộc mô hình và phần cứng; cần GPU để nhanh. Không đọc được PDF dạng ảnh. | `docker compose --profile ollama up -d`, `docker compose exec ollama ollama pull qwen3:4b-instruct`, rồi `OLLAMA_URL=http://ollama:11434` |
| **Anthropic Claude** | Trả phí theo token | `ANTHROPIC_API_KEY=...`, tùy chọn `ANTHROPIC_MODEL` |

**Miễn phí mà không bị chặn vì hết hạn mức:** đặt cả `GEMINI_API_KEY` và `OLLAMA_URL`. Gemini trả lời trước (nhanh, chất lượng tốt); gặp hạn mức theo phút thì tự thử lại sau vài giây đến một phút; nếu vẫn hết hạn mức, quá tải hoặc mất mạng, lời gọi đó chuyển sang Ollama và Gemini được thử lại sau 10 phút. Mỗi tác vụ AI ghi mô hình đã thực sự trả lời (ví dụ `gemini-3.8-flash + qwen3:4b-instruct`). Chỉ có Gemini thì khi hết hạn mức ngày, tác vụ báo lỗi rõ ràng để thử lại sau.

Đặt `AI_PROVIDER=gemini|ollama|anthropic` để chọn nguồn chính khi cấu hình nhiều nguồn. Về Ollama (đo ngày 12/10/2026 trên laptop 16 luồng CPU, 14 GB RAM, không dùng GPU, `qwen3:4b-instruct`):

- **RAM:** với `OLLAMA_NUM_CTX=32768` (mặc định) mô hình chiếm khoảng 5,3 GB nhờ bộ nhớ ngữ cảnh 8-bit mà service `ollama` trong compose đã bật (7,6 GB nếu không bật). Máy ít RAM hơn: đặt `OLLAMA_NUM_CTX=16384`; mỗi lần sẽ đọc được tài liệu ngắn hơn, chương quá dài được báo để chọn ít chương lại.
- **Tốc độ trên CPU** (khoảng 6–7 token/giây): tạo 6 câu từ hai chương ngắn mất khoảng 6 phút, nhận dạng đề 3 câu 1,5 phút, phân tích kết quả một buổi học 4,5 phút, đánh giá đề 6 câu khoảng 7 phút. Tác vụ chạy nền, giao diện hiện thời gian đã chạy. GPU NVIDIA (cần NVIDIA Container Toolkit và cấu hình GPU cho service) nhanh hơn nhiều lần.
- **Chất lượng:** câu hỏi đúng kiến thức, tiếng Việt tự nhiên, nhận dạng đề chính xác; phương án nhiễu và nhận xét kém sâu hơn Gemini — giáo viên vẫn duyệt từng câu trước khi đưa vào đề. Riêng **đánh giá chất lượng đề**, mô hình 4B bỏ sót lỗi kiến thức và có lúc kết luận sai (thử nghiệm: cho rằng QoS 2 có 3 bước), nên dùng Gemini cho chức năng này. `qwen3:8b` hoặc `gemma4:e4b` tốt hơn nhưng cần nhiều RAM và chậm hơn.
- Không đọc được PDF dạng ảnh (scan); tài liệu dài được chia nhỏ theo `OLLAMA_NUM_CTX`.

Menu **Trợ lý AI**:

1. Tải giáo trình (PDF, Word, TXT, Markdown). Hệ thống tự tách chương theo "Chương/Bài/Phần" hoặc Heading; chọn các chương cần ra đề.
2. Chọn số câu (1–60), tỷ lệ % câu dễ/trung bình/khó (tổng 100%), tỷ lệ câu nhiều đáp án, bộ câu hỏi dự kiến và yêu cầu thêm.
3. AI viết câu hỏi theo lô; mỗi câu có lời giải, kiến thức được kiểm tra, chương và trích dẫn tài liệu làm căn cứ.
4. Tab **Chờ duyệt**: sửa, loại hoặc duyệt từng câu/hàng loạt vào bộ câu hỏi có sẵn hoặc bộ mới. Câu nghi trùng với ngân hàng được cảnh báo. Không câu nào vào bộ đề nếu chưa được duyệt.

Dữ liệu gửi tới dịch vụ AI (trừ Ollama): nội dung các chương đã chọn, file nhờ AI nhận dạng, nội dung câu hỏi khi đánh giá đề, và số liệu tổng hợp khi phân tích kết quả (không kèm tên hay mã sinh viên). Số token của từng tác vụ được lưu trong AiJob.

### Ngân hàng câu hỏi, chất lượng đề và phân tích kết quả

- **Ngân hàng câu hỏi**: tìm kiếm không cần gõ dấu, lọc theo bộ, độ khó, loại câu, chủ đề, nguồn (soạn tay/nhập file/AI). Tab **Câu hỏi trùng lặp** so khớp câu dẫn và phương án (không phụ thuộc thứ tự phương án) với ngưỡng điều chỉnh được, xem hai câu cạnh nhau và xóa câu thừa.
- **Đánh giá chất lượng** (nút trên trang bộ câu hỏi): kiểm tra tự động phương án trùng, "Tất cả các đáp án trên", đáp án dài bất thường, câu phủ định chưa in hoa, câu nhắc tới hình/bảng, câu trùng, phân bố vị trí đáp án; **Đánh giá bằng AI** chỉ ra câu mơ hồ, thiếu dữ kiện, nhiều đáp án có thể đúng, nghi sai đáp án, trùng nội dung, chấm từng phương án nhiễu và gợi ý viết lại.
- **Phân tích kết quả**: báo cáo cuối buổi và trang chất lượng hiển thị tỷ lệ đúng, độ phân biệt (nhóm 27% điểm cao/thấp), tỷ lệ chọn từng phương án, cảnh báo phương án nhiễu không hiệu quả hoặc đáp án nghi sai, độ tin cậy KR-20, phổ điểm và điểm từng sinh viên; **Phân tích bằng AI** tóm tắt điểm mạnh, lỗ hổng kiến thức và đề xuất giảng dạy.

### Kỳ thi, mã đề và thống kê theo lớp

1. **Lớp học**: tạo lớp, nhập danh sách từ Excel (cột Họ và tên; STT dùng làm mã thiết bị 01–99). Sinh viên nhập mã này khi tham gia; báo cáo hiện họ tên.
2. **Kỳ thi**: chọn bộ câu hỏi, số mã đề, bật **Trộn thứ tự câu hỏi** và/hoặc **Xáo trộn đáp án**. Mã đề 101, 102… có thể xem trước, tải đề Word để in và đáp án Excel.
3. **Mở phiên thi** cho từng lớp; hệ thống tự gán mã đề ít dùng nhất (hoặc chọn mã cụ thể). Hộp thoại mở buổi học thường cũng có tùy chọn lớp và trộn câu/đáp án.
4. Tab **Thống kê theo lớp**: điểm trung bình, trung vị, độ lệch chuẩn, tỷ lệ đạt, xếp loại Giỏi/Khá/Trung bình/Yếu/Kém, phổ điểm, tỷ lệ đúng từng câu theo lớp, xuất Excel và nhận xét AI so sánh các lớp. Trang lớp có bảng điểm qua các buổi.

Để debug MQTT: EMQX Dashboard → Connections / Subscriptions / Access Control. Không dùng tài khoản quản trị EMQX trong browser simulator. UI giáo viên chỉ dùng REST + Socket.IO.

## Các lệnh chính

```bash
# Toàn bộ hệ thống (sau khi copy .env)
docker compose up --build -d

# Migration / seed
docker compose exec backend pnpm db:migrate
docker compose exec backend pnpm db:seed

# Unit + component tests trong môi trường container đã build
docker compose exec backend pnpm test

# PostgreSQL integration tests, tạo dữ liệu kiểm thử riêng và dọn dữ liệu đó
docker compose exec backend pnpm test:integration

# End-to-end HTTP + MQTT + Socket.IO, gồm 50 thiết bị
docker compose exec -e SIMULATOR_MQTT_URL=mqtt://emqx:1883 \
  -e MQTT_SIMULATOR_USERNAME=simulator -e MQTT_SIMULATOR_PASSWORD=simulator-dev-only \
  backend pnpm test:e2e

# Từ máy host, sau pnpm install / pnpm build:
pnpm simulate --devices=50 --room=123456 --duplicates

# Hoặc chạy script trong container, thay room bằng mã phòng đang mở
docker compose exec -e MQTT_URL=mqtt://emqx:1883 \
  -e MQTT_SIMULATOR_USERNAME=simulator -e MQTT_SIMULATOR_PASSWORD=simulator-dev-only \
  backend pnpm simulate --devices=50 --room=123456 --duplicates
```

Thay các credential simulator trong lệnh nếu đã đổi `.env`. Script join, chờ giáo viên mở câu, gửi A–D với độ trễ ngẫu nhiên, rồi in accepted/rejected/timeout/duplicate và độ trễ ACK. `--delay=0` gửi dồn, `--timeout=90` giới hạn thời gian, `--duplicates` gửi lại nguyên request để thử idempotency. Trả exit code khác 0 nếu thiếu thiết bị trả lời, có lỗi/timeout hoặc xử lý duplicate sai. Các lần chạy dùng deviceId và studentCode riêng.

## Phát triển trên host

```bash
cp .env.example .env
pnpm install --frozen-lockfile
docker compose up -d postgres emqx
pnpm build
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Vite chạy http://localhost:5173, proxy `/api` và `/socket.io` sang NestJS port 3000. Lệnh root tự đọc `.env`; biến môi trường đã đặt bên ngoài được giữ ưu tiên. Prisma CLI và backend dùng cùng `DATABASE_URL`. Simulator dùng **MQTT_SIMULATOR_USERNAME/PASSWORD**; không dùng `MQTT_USERNAME/PASSWORD` của backend. Thay VITE vars cần restart Vite hoặc rebuild image frontend.

```bash
pnpm test
pnpm test:integration  # cần PostgreSQL đã migrate
pnpm test:e2e          # cần API và EMQX đang chạy
pnpm build
```

## Cấu trúc

```text
apps/
  backend/                NestJS, Prisma schema/migration/seed, tests; nhập file, AI, ngân hàng câu hỏi, lớp học, kỳ thi
  frontend/               React + Tailwind, teacher/presentation routes
  device-simulator/       React component MQTT + keypad + 2 LED 7 đoạn
  firmware/               ESP-IDF: BLE provisioning, Wi-Fi/MQTT, keypad, 2×74HC595 display
packages/
  shared-types/           Types REST/realtime, khóa đáp án, thống kê, trình đọc câu hỏi, so khớp trùng lặp, phân tích câu hỏi, sinh mã đề
  mqtt-contracts/         Zod validation, topics, payload/ACK v1
scripts/
  simulate-devices/       Node MQTT load generator
  tests/e2e.ts            Kiểm thử HTTP + broker + Socket.IO thật
  provision-device.mjs    Cấp tài khoản MQTT riêng cho thiết bị
infra/                    Dockerfiles, Nginx, EMQX authentication/ACL
docs/                     Kiến trúc, API, MQTT, kết quả kiểm thử
docker-compose.yml
```

File `index.html` cũ không thuộc ứng dụng ClassPulse; bản sao giữ ở `docs/legacy-index.html`. Ứng dụng chạy từ Vite hoặc container frontend, không mở trực tiếp root HTML bằng file browser.

## Quy tắc dữ liệu

- Session giữ bản sao câu hỏi (`SessionQuestion`), tách khỏi quiz có thể chỉnh sửa. Quiz/câu hỏi dùng soft delete để giữ lịch sử.
- Email unique; active roomCode có partial unique index PostgreSQL; device và studentCode chỉ có một participant trong từng session.
- Một đáp án hiện hành trên `(participantId, questionId)`. Sequence tăng, server timestamp kiểm deadline. Client timestamp chỉ phục vụ chẩn đoán.
- `ProcessedMqttMessage` lưu requestId unique, payload hash, ACK. Advisory lock theo request và row lock theo session bảo vệ gửi trùng và race với đóng câu. Answer và ACK record commit trong cùng transaction.
- Duplicate cùng nội dung trả `DUPLICATE_MESSAGE` kèm `originalCode` và `success` gốc. Dùng lại requestId với nội dung khác bị từ chối.
- Mẫu số phần trăm A–D, đúng/sai là số đã trả lời hợp lệ; không có câu trả lời thì tất cả bằng 0. Số chưa trả lời = số tham gia − số đã trả lời.
- Deadline lưu trong database; bộ quét 250 ms khôi phục sau restart. Cả MANUAL và TIMER đều đóng câu khi hết thời gian; MANUAL đợi giáo viên chọn câu tiếp theo. Sau outage, câu hết hạn được đóng trước, rồi TIMER tiếp tục với thời gian đầy đủ cho câu mới.
- Giáo viên có thể cho sinh viên join giữa phiên; tổng participant trong báo cáo dùng số participant hiện tại/cuối phiên.

## Persistence, vận hành và cấu hình mạng

PostgreSQL, EMQX data/log và cấu hình bootstrap dùng named volumes. `docker compose down` giữ dữ liệu; `docker compose down -v` **xóa dữ liệu**. Kiểm tra restart bằng `docker compose restart backend postgres emqx`, chờ healthy rồi mở lại lịch sử/session. Broker reconnect sẽ được backend publish lại retained state.

Các port PostgreSQL, MQTT và EMQX Dashboard mặc định chỉ bind loopback. Frontend rootless bind `127.0.0.1:8080`; Apache hoặc socket proxy cung cấp cổng 80 để giáo viên mở trực tiếp bằng `http://localhost`. Nếu dùng qua mạng lớp học: đặt `FRONTEND_ORIGIN` theo đúng địa chỉ truy cập và cấu hình virtual host/proxy cho địa chỉ LAN; đổi simulator broker URL trong phần Kết nối hoặc đặt `VITE_MQTT_WS_URL` rồi rebuild. Nginx hỗ trợ `/mqtt` qua cùng host. HTTPS cần `wss://`, reverse proxy TLS và `COOKIE_SECURE=true`. Đặt `TRUST_PROXY=true` cho backend khi sau proxy tin cậy để rate limit theo IP người dùng; không trust proxy không kiểm soát.

Authentication luôn bật, không có chế độ anonymous. `broker-config` sinh file bootstrap/ACL từ `.env`; EMQX đọc bootstrap khi authenticator được tạo lần đầu. **Đổi password trong `.env` không tự đổi tài khoản đã tồn tại trong volume EMQX**: cập nhật qua Dashboard/API và đồng bộ credential ứng dụng. Không xóa volume để xoay khóa nếu cần giữ dữ liệu.

Tài khoản simulator dùng chung chỉ phục vụ môi trường phát triển; clientId có thể tự chọn, không chứng minh danh tính thiết bị. Cho triển khai thật, cấp credential riêng với `pnpm provision --deviceId=device-001` và `MQTT_DEVICE_PASSWORD` riêng, sau đó đặt `MQTT_SIMULATOR_ENABLED=false`, chạy lại broker-config/restart EMQX, và xóa tài khoản simulator cũ qua Dashboard. ACL thiết bị thật gắn topic với `${username}`, nên credential của device-001 không thể gửi topic device-002. Xem [giao thức và provisioning](docs/mqtt-protocol.md).

## Firmware ESP32 tham chiếu

`apps/firmware` bổ sung đường chạy cho thiết bị thật theo các bài BLE, Wi-Fi và MQTT: provision bằng BLE GATT đã mã hóa, kết nối Wi-Fi STA, publish/subscribe MQTT QoS 1, ACK/retry/idempotency, lưu pending/sequence trong NVS, quét keypad có debounce và điều khiển hai module LED bốn số dùng 74HC595. Xem [pinout, build, flash và provision](apps/firmware/README.md), cùng [sơ đồ breadboard và BOM](docs/hardware/breadboard-wiring.md). Logic thuần C chạy được trên host bằng `pnpm test:firmware`.

Tài liệu [đối chiếu bài giảng](docs/course-alignment.md) mô tả cách các lớp IoT, BLE, Wi-Fi, web server, database và MQTT ánh xạ vào mã nguồn.

## Phạm vi MVP và giới hạn đã biết

- Có firmware ESP-IDF và pinout tham chiếu, nhưng chưa build/flash và đo điện trên board thật trong môi trường này. Cần xác minh loại LED common cathode/anode, điện trở, thứ tự digit, GPIO và nhiễu keypad trên phần cứng trước khi sử dụng trong lớp.
- Triển khai **một backend instance**. Rate limit nằm trong RAM, realtime dùng Socket.IO adapter mặc định. Muốn scale nhiều instance cần Redis adapter, limiter phân tán, cơ chế phát sự kiện/outbox và thiết kế subscriber consumer rõ ràng.
- Lưu đáp án cuối, metadata/hash và ACK từng message; chưa lưu toàn bộ lịch sử nội dung các lần thay đáp án. Không có bảng xếp hạng, chia sẻ màn hình công khai hoặc reset mật khẩu qua email trong phạm vi này.
- Câu hỏi chỉ gồm chữ: hình ảnh trong Word/PDF không được nhập, công thức Word chỉ lấy phần chữ. Mỗi câu có đúng bốn phương án A–D (phương án E/F bị bỏ qua khi nhập). Câu nhiều đáp án chấm đúng-tất-cả, chưa có điểm thành phần.
- Thiết bị theo một câu chung trên màn chiếu, nên mã đề đổi thứ tự câu/đáp án theo từng lớp hoặc buổi chứ không khác nhau giữa các sinh viên trong cùng phòng; đề Word dùng cho thi giấy.
- AI qua Gemini/Claude cần Internet và khóa API; Gemini miễn phí có hạn mức theo phút/ngày. Ollama không giới hạn nhưng phụ thuộc phần cứng, mô hình nhỏ cho câu hỏi kém chính xác hơn. Nội dung AI đề xuất phải được giáo viên kiểm tra trước khi duyệt. Tác vụ AI đang chạy bị đánh dấu thất bại nếu backend khởi động lại.
- Access token tồn tại tối đa 15 phút sau logout; refresh token bị thu hồi, token chỉ ở memory của web. Production cần HTTPS/WSS, credential riêng, xoay secret, backup, giới hạn mạng phù hợp. Không đưa `.env` thật vào git.
- Khi mất kết nối, UI hiển thị trạng thái và tải lại snapshot khi reconnect. Không chấp nhận đáp án offline gửi lại sau deadline.
- Docker Compose đã được xác minh với PostgreSQL, EMQX, backend và frontend; xem [kết quả kiểm thử](docs/testing.md).

Chi tiết: [Kiến trúc](docs/architecture.md) · [Đối chiếu bài giảng](docs/course-alignment.md) · [MQTT v1](docs/mqtt-protocol.md) · [REST/Socket.IO](docs/api.md).
