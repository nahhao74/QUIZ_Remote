# Chẩn đoán từng thiết bị ClassPulse

Mở [`ClassPulseDeviceDiagnostics.ino`](../../apps/firmware/ClassPulseDeviceDiagnostics/ClassPulseDeviceDiagnostics.ino) trong Arduino IDE, chọn **ESP32 Dev Module**, build và upload. Sketch không cần thư viện ngoài. Mở Serial Monitor ở 115200 baud và đặt line ending tùy ý.

| Lệnh | Kiểm tra |
|---|---|
| `l` | LED xanh chớp ba lần |
| `1` | Chỉ display 1 hiện `1234` |
| `2` | Chỉ display 2 hiện `5678` |
| `b` | Hai display hiện đồng thời |
| `o` | Tắt hai display |
| `k` | Bật/tắt log hàng và cột keypad |
| `w` | Kết nối hoặc in trạng thái Wi-Fi |
| `t` | Kiểm tra tắt display sau 5 giây |
| `p` | In pinout đang dùng |
| `m` | In lại menu |

Nếu display 1 không chạy nhưng display 2 chạy, kiểm tra DIO1/GPIO21. Nếu display 2 không chạy, kiểm tra DIO2/GPIO22. Nếu cả hai không chạy, kiểm tra VCC/GND và hai đường dùng chung SCLK/GPIO18, RCLK/GPIO19.

Keypad in cả ký tự, số hàng/cột và GPIO. Nếu ký tự sai nhưng hàng/cột vẫn xuất hiện, đổi thứ tự dây keypad sau khi rút USB.
