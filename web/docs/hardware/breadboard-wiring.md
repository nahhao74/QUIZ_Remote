# ClassPulse pad — sơ đồ breadboard ESP32 30 pin

![Pinout ESP32 và dây nối](esp32-30pin-minimal-wiring.svg)

Ảnh cận cảnh xác nhận hai module có năm chân `VCC`, `GND`, `DIO`, `SCLK`, `RCLK`, tức loại LED bốn số dùng 74HC595. `SCLK` đưa từng bit vào thanh ghi dịch; `RCLK` chốt dữ liệu ra các ngõ LED. Cả hai tín hiệu đều bắt buộc.

Nếu hiện chỉ có một điện trở 330 Ω và một LED xanh, dùng [cấu hình thử tối giản](minimal-test.md). Firmware đang bật sẵn `CP_MINIMAL_BREADBOARD_TEST=1`.

## Kết nối display

Hai module dùng chung clock và latch nhưng có data riêng:

| Chân module | Display 1 | Display 2 |
|---|---|---|
| VCC | 3V3 | 3V3 |
| GND | GND | GND |
| SCLK | GPIO18 | GPIO18 |
| RCLK | GPIO19 | GPIO19 |
| DIO | GPIO21 | GPIO22 |

Nối theo chữ in trên PCB, không dựa vào vị trí chân trong ảnh. Với breadboard hiện tại, cấp display bằng 3V3 để mức logic ESP32 phù hợp trực tiếp. Nếu bản PCB cần cấp display bằng 5 V để sáng hơn, dùng bộ đệm 74AHCT125 cho bốn đường `SCLK`, `RCLK`, `DIO1`, `DIO2`.

## Keypad 4×4

Profile thử dùng pull-down nội:

| Keypad | ESP32 |
|---|---|
| R1–R4 | GPIO25, GPIO26, GPIO27, GPIO32 |
| C1–C4 | GPIO13, GPIO14, GPIO23, GPIO33 |

Khi chuyển `CP_MINIMAL_BREADBOARD_TEST` thành `0`, cột dùng GPIO33/34/35/39 và mỗi cột cần điện trở 47 kΩ xuống GND; mỗi hàng có điện trở nối tiếp 1 kΩ. Thứ tự tám dây keypad clone không bảo đảm giống nhau, nên đo thông mạch hoặc thử từng phím rồi sửa thứ tự dây.

## LED trạng thái

Trong lần thử hiện tại:

```text
GPIO17 → 330 Ω → anode LED xanh
cathode LED → GND
```

Sketch thử dùng xung xanh 250 ms cho Wi-Fi online và một giây cho offline. Khi có đủ linh kiện, mạch hoàn chỉnh dùng GPIO16 cho LED đỏ và GPIO17 cho LED xanh, mỗi LED nối tiếp 1 kΩ.

## Chế độ hoạt động

- Hai module được quét multiplex liên tục; vì vậy code refresh display khoảng mỗi 1 ms.
- Nhấn keypad cập nhật nội dung và LED trạng thái.
- Sau 5 giây không nhấn, chuỗi 74HC595 được chốt về trạng thái tắt display.
- Firmware hệ thống dùng Wi-Fi modem-sleep và automatic light-sleep để giữ kết nối MQTT.

## Trình tự thử

1. Chỉ cắm ESP32 và LED xanh; nạp sketch, kiểm tra LED chớp lúc boot.
2. Rút USB, cắm display 1 và kiểm tra `1234`.
3. Rút USB, thay bằng display 2 và kiểm tra `5678`.
4. Rút USB, cắm đồng thời hai display với SCLK/RCLK dùng chung.
5. Rút USB, cắm keypad sau cùng và chỉ nhấn một phím mỗi lần.

## Tài liệu tham khảo

- [Thư viện và pin mapping module 74HC595](https://github.com/DIYables/DIYables_4Digit7Segment_74HC595)
- [SN74HC595 datasheet](https://www.ti.com/lit/ds/symlink/sn74hc595.pdf)
- [ESP32 sleep modes](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/system/sleep_modes.html)
- [ESP32 hardware design guidelines](https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32/schematic-checklist.html)
