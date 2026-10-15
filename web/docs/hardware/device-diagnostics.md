# Diagnosing a single ClassPulse device

Open [`ClassPulseDeviceDiagnostics.ino`](../../apps/firmware/ClassPulseDeviceDiagnostics/ClassPulseDeviceDiagnostics.ino) in the Arduino IDE, choose **ESP32 Dev Module**, build and upload. The sketch needs no external library. Open the Serial Monitor at 115200 baud with any line ending.

| Command | What it checks |
|---|---|
| `l` | The green LED blinks three times |
| `1` | Only display 1 shows `1234` |
| `2` | Only display 2 shows `5678` |
| `b` | Both displays show at the same time |
| `o` | Turns both displays off |
| `k` | Toggles the keypad row and column log |
| `w` | Connects or prints the Wi-Fi state |
| `t` | Tests the display turning off after 5 seconds |
| `p` | Prints the pinout in use |
| `m` | Prints the menu again |

If display 1 does not work but display 2 does, check DIO1/GPIO21. If display 2 does not work, check DIO2/GPIO22. If neither works, check VCC/GND and the two shared lines SCLK/GPIO18 and RCLK/GPIO19.

The keypad prints the character, the row/column numbers and the GPIO. If the character is wrong but the row/column still appear, change the order of the keypad wires after unplugging USB.
