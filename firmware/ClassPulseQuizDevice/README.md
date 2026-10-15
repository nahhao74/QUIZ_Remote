# ClassPulse quiz device (bo mạch in quiz_remote_compact 0322ccc)

Firmware cho ESP32 với keypad M5 (qua NPN/BSS138), hai LED 7 đoạn M6 (74HC595) và chân giữ nguồn GPIO13 của M2. Kết nối Wi-Fi và MQTT tới backend ClassPulse trong thư mục `web/` để vào phòng, trả lời và nhận điểm. Khác với `ClassPulseArduinoPrototype` (module LED 4 số, keypad nối thẳng, cột GPIO16/17).

Không cần cài thư viện: MQTT dùng esp-mqtt, trang cài đặt dùng WebServer/DNSServer, bộ nhớ dùng Preferences, đều có sẵn trong core ESP32 (đã biên dịch với core 3.3.12, board ESP32 Dev Module, chiếm 83 % flash).

## Cấu hình

Sửa phần đầu sketch:

| Hằng số | Giá trị |
|---|---|
| `WIFI_SSID`, `WIFI_PASSWORD` | Mạng Wi-Fi 2,4 GHz mặc định mà ESP32 và máy chạy server cùng vào. Có thể đổi trên thiết bị qua trang cài đặt (bên dưới) |
| `MQTT_HOST` | IP LAN mặc định của máy chạy ClassPulse, không dùng `localhost` |
| `MQTT_USERNAME`, `MQTT_PASSWORD` | Mặc định là tài khoản simulator phát triển trong `.env` |
| `DIGIT_DIRECT_GPIO` | `true` khi chân chung LED nối thẳng GPIO17/GPIO4; `false` khi đã lắp AO3401A |
| `COL3_FOLLOWS_WAKE` | `true` cho bo mạch in 0322ccc đang bị chập WAKE_NODE với COL3 (14/10/2026). Khi nhấn phím cột 1–3, COL3 cũng lên theo qua DWAKE0–2. Firmware bỏ qua COL3 nếu cùng hàng có phím khác, nên A–D vẫn dùng được khi nhấn riêng. Đặt `false` khi đã hết chập và lắp lại DWAKE3 |
| `OFF_AFTER_RESULT_MS`, `OFF_IDLE_ENTRY_MS`, `OFF_IDLE_ROOM_MS`, `OFF_NO_WIFI_MS` | Tự tắt nguồn: 60 s sau khi hiện điểm, 3 phút không nhấn phím ở màn hình `Ph`/`Id`, 20 phút trong phòng không có câu mới và không nhấn phím, 2 phút không vào được Wi-Fi. Đặt `0` để bỏ điều kiện đó |
| `OFF_HOLD_STAR_MS`, `CONFIG_HOLD_ZERO_MS`, `CONFIG_TIMEOUT_MS` | Giữ `*` 3 s để tắt; giữ `0` 3 s ở màn hình `Ph`/`Id` để mở trang cài đặt; trang cài đặt tự thoát sau 5 phút |
| `WIFI_TX_POWER`, `CPU_MHZ`, `WIFI_START_DELAY_MS` | Mặc định 8,5 dBm, 80 MHz, bật Wi-Fi sau 1,5 s để nguồn 2×AAA + boost không sụt khi phát. Với 19,5 dBm/240 MHz, breadboard chạy pin bị reset liên tục khi bật Wi-Fi (13/10/2026). Đặt hotspot gần thiết bị |

Không đưa file có mật khẩu Wi-Fi thật lên repo công khai.

Server phải đang chạy từ thư mục `web/`. Cổng MQTT 1883 phải bind vào đúng IP LAN đó: đặt `MQTT_TCP_BIND_ADDRESS` trong `web/.env`, rồi tạo lại container `emqx` và **khởi động lại `backend`** (`docker compose up -d --force-recreate emqx && docker compose restart backend frontend`). Nếu không khởi động lại, backend kết nối lại broker nhưng có thể không còn subscription nào, thiết bị gửi join sẽ không nhận được ACK (`E3`, đã gặp ngày 14/10/2026). Để `127.0.0.1` thì ESP32 bị từ chối kết nối (`Connection reset by peer` trên Serial). IP đổi mỗi khi laptop đổi mạng.

## Sử dụng

1. Giáo viên tạo quiz và mở phiên học trên web, lấy mã phòng 6 số.
2. LED hiện `Ph`: nhập mã phòng, nhấn `#`.
3. LED hiện `Id`: nhập mã sinh viên **2 chữ số**, nhấn `#`. Chấm phải nhấp nháy trong lúc chờ server; vào phòng thành công thì chấm trái sáng.
4. Khi giáo viên mở câu, LED hiện số thứ tự câu (`01`, `02`…). Nhấn `1`–`4` để chọn A–D (phím `A`–`D` cũng dùng được khi cột A–D đã lắp), nhấn `#` để nộp. Với câu nhiều đáp án, mỗi phím bật/tắt một chữ; LED hiện các chữ đã chọn, quá hai chữ thì cuộn theo cặp.
5. Server nhận đáp án: LED hiện chữ đã chọn kèm chấm phải, chờ câu tiếp theo. Có thể chọn lại và nhấn `#` lần nữa trước khi câu đóng.
6. Phiên kết thúc: LED hiện điểm thang 10. Nhấn `*` để quay lại nhập mã phòng; không làm gì thì 60 s sau máy tự tắt.
7. Bật lại sau khi máy tắt hoặc mất nguồn giữa giờ: ở màn hình `Ph`, nhấn `#` ngay (không nhập số) để vào lại phòng và mã sinh viên của lần vào phòng thành công gần nhất. Đáp án nộp lại sau khi khởi động lại vẫn được nhận, vì sequence cộng thêm số lần khởi động lưu trong NVS.

Khi nhập, `*` xóa chữ số cuối; ở bước mã sinh viên, `*` lúc ô trống quay lại sửa mã phòng.

## Tắt máy

Nhấn một phím bất kỳ để bật. Firmware kéo GPIO13 lên ngay khi khởi động để giữ nguồn qua khối M2 và chỉ hạ xuống khi tắt máy: giữ `*` 3 s, hoặc khi gặp một trong các điều kiện tự tắt ở bảng cấu hình. LED hiện `OF` (hoặc `E1` nếu tắt vì không có Wi-Fi), máy báo `online=false` lên server nếu đang ở trong phòng, chờ nhả hết phím rồi hạ GPIO13; khoảng 1 s sau toàn mạch mất nguồn. Còn cắm USB thì ESP32 vẫn có điện, firmware tự khởi động lại về màn hình `Ph` sau 5 s.

## Đổi Wi-Fi không cần nạp lại

1. Ở màn hình `Ph` hoặc `Id`, giữ phím `0` 3 s. LED hiện `CF`, chấm phải nhấp nháy.
2. Điện thoại vào Wi-Fi `ClassPulse-XXXX` (4 ký tự cuối mã thiết bị, không mật khẩu). Trang cài đặt tự mở; nếu không, mở `http://192.168.4.1`.
3. Chọn tên Wi-Fi 2,4 GHz (có danh sách mạng quét được), nhập mật khẩu (để trống thì giữ mật khẩu cũ) và IP máy chạy web (`hostname -I`), bấm **Lưu và khởi động lại**.

Giá trị lưu trong NVS được dùng thay cho `WIFI_SSID`, `WIFI_PASSWORD`, `MQTT_HOST`, cho tới khi nạp firmware có ba giá trị này khác đi (firmware so một mã băm của chúng) hoặc bấm **Dùng lại cài đặt ghi trong firmware**. Nhấn `*` để thoát không lưu. Trang cài đặt không có mật khẩu và chỉ mở khi có người giữ phím `0` trên máy, tự đóng sau 5 phút.

| LED | Ý nghĩa |
|---|---|
| `88` | Vừa khởi động (thử đủ thanh) |
| `On` | MQTT đã kết nối |
| `E1` | Chưa có Wi-Fi |
| `E2` | Chưa kết nối MQTT hoặc hết thời gian chờ khi mất kết nối |
| `E3` | Server từ chối hoặc không trả ACK; xem mã lỗi trên Serial 115200 |
| `E4` | Nhập chưa đủ số chữ số, hoặc nhấn `#` ở `Ph` khi chưa từng vào phòng nào |
| `CF` | Đang mở trang cài đặt Wi-Fi |
| `OF` | Đang tắt máy |

## Giới hạn hiện tại

- Câu tiếp theo do server mở: giáo viên bấm **Câu tiếp theo** (chế độ MANUAL) hoặc server tự chuyển sau khi hết giờ (TIMER). Nhấn `#` chỉ nộp đáp án, thiết bị không tự chuyển câu.
- Với `COL3_FOLLOWS_WAKE = true`, nhấn cùng lúc một phím A–D và một phím khác cùng hàng sẽ chỉ nhận phím kia.
- Backend chỉ nhận mã sinh viên đúng 2 chữ số (`joinSchema` trong `packages/mqtt-contracts`).
- Mạch không đo được điện áp pin (GPIO36/39 để trống), nên thiết bị không báo pin yếu.
- Các thiết bị dùng chung tài khoản MQTT `simulator`; triển khai thật nên cấp tài khoản riêng cho từng thiết bị (`scripts/provision-device.mjs` trong `web/`).
- 14/10/2026: đã chạy trọn một bài kiểm tra trên bo mạch in với web qua hotspot. Tự tắt nguồn, vào lại phòng nhanh và trang cài đặt mới biên dịch, chưa thử trên phần cứng.
