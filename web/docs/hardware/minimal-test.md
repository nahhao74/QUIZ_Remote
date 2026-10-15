# Thử nhanh với đúng linh kiện hiện có

![Pinout ESP32 30 chân và dây thử](esp32-30pin-minimal-wiring.svg)

Cấu hình này chỉ cần ESP32 DevKit 30 pin, keypad 4×4, một LED xanh, một điện trở 330 Ω và hai module LED 4 số dùng 74HC595. Mỗi display có năm chân `VCC`, `GND`, `DIO`, `SCLK`, `RCLK`. Firmware đang mặc định dùng cấu hình này qua `CP_MINIMAL_BREADBOARD_TEST=1` trong `apps/firmware/main/hardware_profile.h`.

## 1. Thử LED xanh

Ngắt USB trước khi cắm dây:

```text
GPIO17 ── 330 Ω ── anode LED xanh
                       cathode ── GND
```

Chân dài của LED thường là anode; cạnh bẹt trên vỏ thường nằm phía cathode. Điện trở có thể đặt trước hoặc sau LED. Khi khởi động, LED sáng 250 ms để tự kiểm tra. Với sketch thử, xung ngắn 250 ms nghĩa là Wi-Fi online; xung dài 1 giây nghĩa là offline. Firmware hệ thống đầy đủ sẽ dùng trạng thái MQTT và hai màu LED khi đã có đủ linh kiện.

GPIO16 dành cho LED đỏ nhưng cứ để hở trong lần thử này.

Để kiểm tra phần cứng độc lập với Wi-Fi/MQTT, mở sketch [`ClassPulseHardwareTest.ino`](../../apps/firmware/ClassPulseHardwareTest/ClassPulseHardwareTest.ino) bằng Arduino IDE, chọn board **ESP32 Dev Module**, nạp chương trình rồi mở Serial Monitor ở 115200 baud. Sketch không cần cài thư viện ngoài.

## 2. Thử keypad không cần điện trở rời

Firmware dùng điện trở kéo xuống nội và chuyển các hàng không quét sang high-impedance:

| Keypad | ESP32 |
|---|---|
| R1 | GPIO25 |
| R2 | GPIO26 |
| R3 | GPIO27 |
| R4 | GPIO32 |
| C1 | GPIO13 |
| C2 | GPIO14 |
| C3 | GPIO23 |
| C4 | GPIO33 |

Thứ tự tám dây trên keypad có thể khác bảng. Nếu chưa có đồng hồ đo, thử giả định bốn dây đầu là R1–R4 và bốn dây sau là C1–C4. Nếu phím trả về sai vị trí, ngắt USB rồi đổi lại thứ tự dây. Trong giai đoạn thử chỉ nhấn một phím mỗi lần.

## 3. Thử display 74HC595

`SCLK` dịch từng bit vào 74HC595; `RCLK` chốt dữ liệu vừa dịch ra LED. Vì vậy phải nối cả hai. Hai display dùng chung SCLK/RCLK nhưng có DIO riêng. Cấp module bằng **3,3 V** trong lần thử trực tiếp này.

Thử từng module riêng trước:

| Chân module | DISP1 | DISP2 |
|---|---|---|
| VCC | ESP32 3V3 | ESP32 3V3 |
| GND | ESP32 GND | ESP32 GND |
| SCLK | GPIO18 | GPIO18 |
| RCLK | GPIO19 | GPIO19 |
| DIO | GPIO21 | GPIO22 |

1. Cắm DISP1, cấp USB và kiểm tra `1234`.
2. Ngắt USB, tháo DISP1 rồi cắm DISP2 theo cột tương ứng và kiểm tra `5678`.
3. Ngắt USB, cắm đồng thời hai module. Nối chung SCLK vào GPIO18 và chung RCLK vào GPIO19; hai DIO vẫn đi riêng.

Sketch thử sẽ hiện `1234` trên DISP1 và `5678` trên DISP2. Nhấn keypad sẽ in ký tự trong Serial Monitor, hiển thị ký tự đó và bật LED xanh một giây. Sau 5 giây không nhấn, display tắt.

Để thử trạng thái kết nối, sửa hai dòng `WIFI_SSID` và `WIFI_PASSWORD` ở đầu sketch. Khi Wi-Fi online, nhấn phím làm LED xanh chớp 250 ms; khi offline, LED xanh sáng một giây. Đây là quy ước tạm thời vì hiện chưa có LED đỏ. Serial Monitor luôn in rõ `Wi-Fi: ONLINE` hoặc `Wi-Fi: OFFLINE`.

## 4. Build và nạp bằng Arduino IDE

1. Cài Arduino IDE 2.x.
2. Mở **File → Preferences**, thêm URL sau vào **Additional Boards Manager URLs**:

   ```text
   https://espressif.github.io/arduino-esp32/package_esp32_index.json
   ```

3. Mở **Tools → Board → Boards Manager**, tìm `esp32`, cài gói **esp32 by Espressif Systems**, rồi khởi động lại IDE.
4. Mở file `apps/firmware/ClassPulseHardwareTest/ClassPulseHardwareTest.ino`.
5. Chọn **Tools → Board → ESP32 Arduino → ESP32 Dev Module**. Nếu danh sách có đúng **DOIT ESP32 DEVKIT V1**, có thể chọn mục đó.
6. Cắm cáp USB dữ liệu và chọn **Tools → Port → /dev/ttyUSB0** hoặc `/dev/ttyACM0`.
7. Bấm **Verify** để build. Khi báo build thành công, bấm **Upload**.
8. Nếu IDE dừng ở `Connecting...`, giữ nút **BOOT**, bấm Upload, thả BOOT khi quá trình ghi bắt đầu.
9. Mở **Tools → Serial Monitor**, chọn **115200 baud**.

Trên Linux, kiểm tra cổng bằng:

```bash
ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null
```

Nếu thấy cổng nhưng Arduino IDE báo `Permission denied`, thêm tài khoản hiện tại vào nhóm serial rồi đăng xuất/đăng nhập lại:

```bash
sudo usermod -aG dialout "$USER"
```

Kết quả mong đợi trên Serial Monitor:

```text
ClassPulse hardware test ready. Press one key at a time.
Key: 1 | Wi-Fi: OFFLINE
Key: A | Wi-Fi: ONLINE
Displays off after 5 seconds.
```

## 5. Khi đã mua đủ linh kiện

Đổi `CP_MINIMAL_BREADBOARD_TEST` thành `0`, sau đó đấu theo [`breadboard-wiring.md`](breadboard-wiring.md). Khi đó keypad quay lại GPIO33/34/35/39 với bốn điện trở 47 kΩ, thêm bốn điện trở hàng 1 kΩ và LED đỏ. Nếu cấp display bằng 5 V, thêm bộ đệm mức 74AHCT125.
