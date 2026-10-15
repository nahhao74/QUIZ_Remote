# Quiz Remote / ClassPulse

A wireless classroom quiz system for an IoT course. Each student holds a small battery-powered ESP32 device with a 4×4 keypad and two 7-segment digits. The teacher runs a web app on a laptop. Devices send their answers over Wi-Fi using MQTT, and the teacher sees the results live on the projector.

```text
ESP32 device ──Wi-Fi / MQTT QoS 1──▶ EMQX broker ──▶ NestJS backend ──▶ PostgreSQL
     ▲                                                     │
     └────────────── ACK + room state ◀────────────────────┤
                                                           └─Socket.IO─▶ Teacher web / presentation
```

Everything runs on the local network; only the optional AI assistant needs Internet access.

## Repository layout

| Folder | Contents |
|---|---|
| [`hardware/`](hardware/README.md) | KiCad schematic (blocks M1–M6) and 2-layer PCB, Gerber files, BOM, design document, wake/hold simulation |
| [`firmware/`](firmware/ClassPulseQuizDevice/README.md) | Arduino sketches for the ESP32: the quiz device (`ClassPulseQuizDevice`) and two bring-up tests for the keypad, display and power circuit |
| [`web/`](web/README.md) | Server side in Docker Compose: NestJS backend, EMQX MQTT broker, PostgreSQL, React teacher app and a browser device simulator |

## The device

- ESP32-WROOM-32 module in a socket, so it can be removed for programming.
- 16-key keypad; two 7-segment digits driven by a 74HC595.
- Two AAA cells and an MT3608 boost converter feeding the 3V3 pin at 3.37 V.
- No standby current: a key press switches the board on, the ESP32 holds its own power through GPIO13 and switches the whole board off when it is done.
- Wi-Fi settings can be changed on the device without reflashing: hold `0` for 3 seconds and open the setup page from a phone.

See the [firmware README](firmware/ClassPulseQuizDevice/README.md) for configuration, the key sequence and the LED codes.

## The server

- MQTT topics `quiz/v1/devices/{deviceId}/...` and `quiz/v1/rooms/{roomCode}/...`, QoS 1, retained room state.
- Answers are not lost or counted twice: the device waits for an application ACK with the same `requestId` and resends up to 3 times; the backend stores each `requestId` and rejects stale `sequence` numbers.
- Teacher features: question sets, import from Word/Excel/PDF, live presentation, per-question statistics, class reports and CSV/Excel export.

Tested with 50 simulated devices: every join and answer was accepted, with ACK latency p50 181 ms, p95 371 ms and max 405 ms. Details are in [`web/docs/testing.md`](web/docs/testing.md).

## Quick start

1. Start the server (needs Docker with Compose v2):

   ```bash
   cd web
   cp .env.example .env      # then fill in the <...> values
   docker compose up --build -d
   docker compose exec backend pnpm db:seed
   ```

   Set `MQTT_TCP_BIND_ADDRESS` in `.env` to the laptop's Wi-Fi IP so the devices can reach port 1883.

2. Open http://localhost:8080 and log in with the development account from the seed (see [`web/README.md`](web/README.md)).
3. Open `firmware/ClassPulseQuizDevice/ClassPulseQuizDevice.ino` in the Arduino IDE (board **ESP32 Dev Module**), set `WIFI_SSID`, `WIFI_PASSWORD` and `MQTT_HOST`, and upload.
4. Start a session on the web, enter the 6-digit room code and a 2-digit student code on the device, and answer with keys `1`–`4` (A–D) followed by `#`.

The ESP32 only supports 2.4 GHz Wi-Fi, and the device and the laptop must be on the same network.

## Documentation

- [Hardware design document](hardware/docs/design-document.md)
- [Firmware: configuration and usage](firmware/ClassPulseQuizDevice/README.md)
- [Web: setup and features](web/README.md)
- [Architecture](web/docs/architecture.md) · [MQTT protocol v1](web/docs/mqtt-protocol.md) · [REST API and Socket.IO](web/docs/api.md) · [Test report](web/docs/testing.md)

## License

[MIT](LICENSE)
