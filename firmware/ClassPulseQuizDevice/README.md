# ClassPulse quiz device (PCB quiz_remote_compact 0322ccc)

Firmware for the ESP32 with the M5 keypad (through NPN/BSS138), the two 7-segment LEDs of M6 (74HC595) and the GPIO13 power-hold pin of M2. It connects over Wi-Fi and MQTT to the ClassPulse backend in the `web/` folder so a student can join a room, answer questions and receive a score. This differs from `ClassPulseArduinoPrototype`, which used a 4-digit LED module, a keypad wired straight to the pins and columns on GPIO16/17.

No extra libraries are needed: MQTT uses esp-mqtt, the setup page uses WebServer/DNSServer and storage uses Preferences, all bundled with the ESP32 core (compiled with core 3.3.12, board ESP32 Dev Module, using 83 % of flash).

## Configuration

Edit the top of the sketch:

| Constant | Value |
|---|---|
| `WIFI_SSID`, `WIFI_PASSWORD` | Default 2.4 GHz Wi-Fi network that both the ESP32 and the server machine join. It can be changed on the device through the setup page (below) |
| `MQTT_HOST` | Default LAN IP of the machine running ClassPulse; do not use `localhost` |
| `MQTT_USERNAME`, `MQTT_PASSWORD` | Default to the development simulator account from `.env` |
| `DIGIT_DIRECT_GPIO` | `true` when the LED common pins are wired straight to GPIO17/GPIO4; `false` once the AO3401A transistors are fitted |
| `COL3_FOLLOWS_WAKE` | `true` for board 0322ccc, where WAKE_NODE is shorted to COL3 (14 Oct 2026). When a key in columns 1–3 is pressed, COL3 also rises through DWAKE0–2. The firmware ignores COL3 when another key in the same row is pressed, so A–D still work when pressed alone. Set `false` once the short is fixed and DWAKE3 is refitted |
| `OFF_AFTER_RESULT_MS`, `OFF_IDLE_ENTRY_MS`, `OFF_IDLE_ROOM_MS`, `OFF_NO_WIFI_MS` | Automatic power-off: 60 s after the score is shown, 3 minutes without a key press on the `Ph`/`Id` screen, 20 minutes in a room with no new question and no key press, 2 minutes without Wi-Fi. Set `0` to disable a condition |
| `OFF_HOLD_STAR_MS`, `CONFIG_HOLD_ZERO_MS`, `CONFIG_TIMEOUT_MS` | Hold `*` for 3 s to power off; hold `0` for 3 s on the `Ph`/`Id` screen to open the setup page; the setup page closes itself after 5 minutes |
| `WIFI_TX_POWER`, `CPU_MHZ`, `WIFI_START_DELAY_MS` | Default 8.5 dBm, 80 MHz and Wi-Fi started after 1.5 s so the 2×AAA + boost supply does not sag while transmitting. With 19.5 dBm/240 MHz the battery-powered breadboard reset continuously when Wi-Fi started (13 Oct 2026). Keep the hotspot close to the device |

Do not commit a file containing your real Wi-Fi password to a public repository.

The server must be running from the `web/` folder. MQTT port 1883 has to be bound to that LAN IP: set `MQTT_TCP_BIND_ADDRESS` in `web/.env`, recreate the `emqx` container and **restart `backend`** (`docker compose up -d --force-recreate emqx && docker compose restart backend frontend`). Without the restart the backend reconnects to the broker but may have no subscriptions left, so a device that sends a join never gets an ACK (`E3`, seen on 14 Oct 2026). If the bind address stays `127.0.0.1`, the ESP32 is refused (`Connection reset by peer` on Serial). The IP changes whenever the laptop switches networks.

## Usage

1. The teacher creates a quiz and opens a session on the web, then reads out the 6-digit room code.
2. The LEDs show `Ph`: enter the room code and press `#`.
3. The LEDs show `Id`: enter the **2-digit** student code and press `#`. The right dot blinks while waiting for the server; once the device has joined, the left dot lights up.
4. When the teacher opens a question the LEDs show its number (`01`, `02`…). Press `1`–`4` to choose A–D (keys `A`–`D` also work once the A–D column is fitted) and press `#` to submit. For a multiple-answer question each key toggles one letter; the LEDs show the chosen letters and scroll in pairs when there are more than two.
5. When the server accepts the answer the LEDs show the chosen letter with the right dot lit, while waiting for the next question. You can change the choice and press `#` again before the question closes.
6. When the session ends the LEDs show the score out of 10. Press `*` to go back to room entry; if nothing is pressed the device powers off after 60 s.
7. To switch back on after the device powered off, or lost power mid-lesson: on the `Ph` screen press `#` right away (without typing digits) to rejoin the room with the student code of the last successful join. An answer resubmitted after a restart is still accepted, because the sequence number includes the boot count stored in NVS.

While entering digits `*` deletes the last one; on the student-code step, `*` with an empty field goes back to fix the room code.

## Powering off

Press any key to switch on. The firmware drives GPIO13 high as soon as it boots to hold power through block M2, and only lowers it when powering off: hold `*` for 3 s, or when one of the automatic conditions in the configuration table is met. The LEDs show `OF` (or `E1` if it is switching off because there is no Wi-Fi), the device reports `online=false` to the server if it is in a room, waits until every key is released and then lowers GPIO13; about 1 s later the whole circuit loses power. If USB is still plugged in the ESP32 stays powered, and the firmware restarts itself back to the `Ph` screen after 5 s.

## Changing Wi-Fi without reflashing

1. On the `Ph` or `Id` screen hold key `0` for 3 s. The LEDs show `CF` and the right dot blinks.
2. On a phone join the Wi-Fi `ClassPulse-XXXX` (the last 4 characters of the device ID, no password). The setup page opens by itself; if it does not, open `http://192.168.4.1`.
3. Choose the 2.4 GHz Wi-Fi name (a list of scanned networks is offered), enter the password (leave it empty to keep the old one) and the IP of the machine running the web (`hostname -I`), then press **Save and restart**.

The values saved in NVS replace `WIFI_SSID`, `WIFI_PASSWORD` and `MQTT_HOST` until firmware with different values for those three is flashed (the firmware compares a hash of them) or **Use the settings written in the firmware** is pressed. Press `*` to leave without saving. The setup page has no password and is only available while someone holds key `0` on the device; it closes itself after 5 minutes.

| LED | Meaning |
|---|---|
| `88` | Just started (all segments test) |
| `On` | MQTT connected |
| `E1` | No Wi-Fi yet |
| `E2` | MQTT not connected, or timed out after a disconnect |
| `E3` | Server rejected the request or sent no ACK; see the error code on Serial at 115200 |
| `E4` | Not enough digits entered, or `#` pressed on `Ph` when no room has ever been joined |
| `CF` | The Wi-Fi setup page is open |
| `OF` | Powering off |

## Current limitations

- The server opens the next question: the teacher presses **Next question** (MANUAL mode) or the server moves on by itself when time runs out (TIMER). Pressing `#` only submits the answer; the device never advances on its own.
- With `COL3_FOLLOWS_WAKE = true`, pressing an A–D key together with another key in the same row registers only the other key.
- The backend only accepts a student code of exactly 2 digits (`joinSchema` in `packages/mqtt-contracts`).
- The circuit cannot measure the battery voltage (GPIO36/39 are unused), so the device does not warn about a weak battery.
- All devices share the MQTT account `simulator`; a real deployment should issue one account per device (`scripts/provision-device.mjs` in `web/`).
- 14 Oct 2026: a full test round was run on the PCB with the web over a phone hotspot.
