# Thiết kế phần cứng Quiz Remote

Thư mục này chứa toàn bộ thiết kế mạch: schematic, mạch in, tài liệu tính toán, BOM và các script dựng và xuất file. Chi tiết từng khối nằm trong [tài liệu thiết kế](docs/tai-lieu-thiet-ke-phan-cung.md).

## Cấu trúc

| Đường dẫn | Nội dung |
|---|---|
| `docs/tai-lieu-thiet-ke-phan-cung.md` | Nguyên lý, tính toán từng khối, bảng chân ESP32, BOM, kết quả kiểm tra, việc cần làm trước khi đặt mạch |
| `schematic/` | Sơ đồ nguyên lý từng sheet, PDF và PNG. `quiz_remote` là sheet gốc; M1–M6 là các khối |
| `compact/` | Board chính 52 × 90 mm, 2 lớp: dự án KiCad, Gerber, file đi dây, ảnh mặt trước và sau, `bom.csv` |
| `single-layer/` | Phiên bản 1 lớp 75 × 133,75 mm. Đồng chỉ ở mặt sau; các đường trên mặt trước là dây nối hàn tay |
| `tools/` | Script dựng mạch in, xuất tài liệu, mô phỏng nguồn và chương trình mẫu |

## Quy trình thiết kế

Làm theo thứ tự. Mỗi bước có một điều kiện phải đạt trước khi sang bước sau.

1. **Yêu cầu và chia khối.** Xác định việc mạch phải làm và dòng mục tiêu khi không dùng. Chia mạch thành các khối (M1–M6) và vẽ mỗi khối thành một sheet KiCad. *Điều kiện:* mỗi khối có một nhiệm vụ rõ ràng và nối với khối khác qua tên net cụ thể.
2. **Tính toán và chọn linh kiện.** Tính điện áp, dòng, công suất và thời gian cho từng khối; ghi công thức và kết quả vào tài liệu. Chọn linh kiện có sẵn ở shop trong nước và ghi vào BOM. *Điều kiện:* mỗi giá trị trên schematic có dòng tính toán hoặc lý do trong tài liệu.
3. **Vẽ schematic và kiểm tra ERC.** Gán ký hiệu, footprint và giá trị. *Điều kiện:* ERC không còn lỗi.
4. **Mô phỏng khi cần.** Mạch đánh thức và tự giữ nguồn được mô phỏng bằng ngspice (`tools/sim_wake_hold.py`). Logic quét phím và hiển thị được mô phỏng trên Wokwi. Mô phỏng chỉ kiểm tra hành vi, không thay cho phép đo.
5. **Dựng mạch in.** Đặt linh kiện và đi dây trong KiCad, hoặc dựng bằng script (xem bên dưới). *Điều kiện:* DRC có đối chiếu schematic không còn vi phạm và không còn dây chưa nối.
6. **Xuất file.** Gerber, BOM và ảnh. Cập nhật tài liệu và README khi thiết kế thay đổi.
7. **Đặt mạch, lắp và đo.** Làm theo mục 8 của tài liệu: đo module ESP32 thật, dòng nghỉ, điện áp `3V3_SW`, gợn sóng khi phát sóng và thời gian tắt.

## Làm việc với KiCad

Mở `compact/quiz_remote.kicad_pro` bằng KiCad 10. Các lệnh dưới đây chạy từ thư mục gốc của repo.

```sh
kicad-cli sch erc hardware/compact/quiz_remote.kicad_sch
kicad-cli pcb drc --schematic-parity hardware/compact/quiz_remote.kicad_pcb
```

`compact/` và `single-layer/` mỗi thư mục có một bản sao schematic riêng. Khi sửa schematic, sửa ở một bản rồi chép các file sheet sang bản còn lại trước khi dựng lại mạch in.

Dựng lại mạch compact từ schematic:

```sh
python3 hardware/tools/build_compact_pcb.py place
FREEROUTING_DIR=/duong/dan/freerouting python3 hardware/tools/build_compact_pcb.py route
python3 hardware/tools/build_compact_pcb.py finish
```

Bước `route` cần Freerouting 2.4.1 (file `freerouting-*.jar` và thư mục `jre25/`), không kèm trong repo. Freerouting cho kết quả khác nhau giữa các lần chạy, nên chạy lại DRC sau khi dựng.

## Xuất tài liệu

```sh
python3 hardware/tools/export_docs.py
```

Lệnh tạo PDF và PNG cho từng sheet trong `schematic/`, ảnh mặt trước và sau của hai board trong `exports/`, và `compact/bom.csv`. Cần `kicad-cli`, `pdftoppm` (poppler-utils) và Pillow.

## Trạng thái

Board compact đã qua ERC, DRC và mô phỏng nguồn. Chưa lắp và chưa đo trên mạch thật; các mục đo còn mở nằm ở mục 8 của tài liệu.
