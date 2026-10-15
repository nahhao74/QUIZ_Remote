# Quick test with the parts you already have

![30-pin ESP32 pinout and test wires](esp32-30pin-minimal-wiring.svg)

This setup only needs a 30-pin ESP32 DevKit, a 4×4 keypad, one green LED, one 330 Ω resistor and two 4-digit LED modules driven by a 74HC595. Each display has five pins `VCC`, `GND`, `DIO`, `SCLK`, `RCLK`. The firmware uses this setup by default through `CP_MINIMAL_BREADBOARD_TEST=1` in `apps/firmware/main/hardware_profile.h`.

## 1. Test the green LED

Unplug USB before connecting wires:

```text
GPIO17 ── 330 Ω ── green LED anode
                       cathode ── GND
```

The long leg of an LED is usually the anode; the flat edge on the casing is usually on the cathode side. The resistor can go before or after the LED. At startup the LED lights for 250 ms as a self-test. In the test sketch, a short 250 ms pulse means Wi-Fi is online and a long 1-second pulse means offline. The full system firmware will use the MQTT state and a two-colour LED once all the parts are available.

GPIO16 is reserved for the red LED but leave it unconnected for this test.

To test the hardware independently of Wi-Fi/MQTT, open the sketch [`ClassPulseHardwareTest.ino`](../../apps/firmware/ClassPulseHardwareTest/ClassPulseHardwareTest.ino) in the Arduino IDE, choose the board **ESP32 Dev Module**, upload it and then open the Serial Monitor at 115200 baud. The sketch needs no external library.

## 2. Test the keypad without separate resistors

The firmware uses the internal pull-down resistors and switches the rows that are not being scanned to high-impedance:

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

The order of the eight wires on a keypad may differ from this table. If you do not have a multimeter yet, try assuming the first four wires are R1–R4 and the last four are C1–C4. If a key returns the wrong position, unplug USB and swap the wire order. While testing, press only one key at a time.

## 3. Test the 74HC595 displays

`SCLK` shifts each bit into the 74HC595; `RCLK` latches the data just shifted out to the LEDs. Both must therefore be connected. The two displays share SCLK/RCLK but have separate DIO lines. Power the modules from **3.3 V** in this direct test.

Test each module on its own first:

| Module pin | DISP1 | DISP2 |
|---|---|---|
| VCC | ESP32 3V3 | ESP32 3V3 |
| GND | ESP32 GND | ESP32 GND |
| SCLK | GPIO18 | GPIO18 |
| RCLK | GPIO19 | GPIO19 |
| DIO | GPIO21 | GPIO22 |

1. Connect DISP1, plug in USB and check `1234`.
2. Unplug USB, remove DISP1, connect DISP2 in the matching column and check `5678`.
3. Unplug USB and connect both modules together. Share SCLK on GPIO18 and RCLK on GPIO19; the two DIO lines stay separate.

The test sketch shows `1234` on DISP1 and `5678` on DISP2. Pressing the keypad prints the character in the Serial Monitor, shows it and turns the green LED on for one second. After 5 seconds without a press, the displays turn off.

To test the connection state, edit the two lines `WIFI_SSID` and `WIFI_PASSWORD` at the top of the sketch. When Wi-Fi is online, a key press makes the green LED blink for 250 ms; when offline, the green LED stays on for one second. This is a temporary convention because there is no red LED yet. The Serial Monitor always prints `Wi-Fi: ONLINE` or `Wi-Fi: OFFLINE` clearly.

## 4. Build and upload with the Arduino IDE

1. Install Arduino IDE 2.x.
2. Open **File → Preferences** and add this URL to **Additional Boards Manager URLs**:

   ```text
   https://espressif.github.io/arduino-esp32/package_esp32_index.json
   ```

3. Open **Tools → Board → Boards Manager**, search for `esp32`, install the package **esp32 by Espressif Systems** and restart the IDE.
4. Open the file `apps/firmware/ClassPulseHardwareTest/ClassPulseHardwareTest.ino`.
5. Choose **Tools → Board → ESP32 Arduino → ESP32 Dev Module**. If the list has exactly **DOIT ESP32 DEVKIT V1**, you can choose that entry.
6. Plug in a data-capable USB cable and choose **Tools → Port → /dev/ttyUSB0** or `/dev/ttyACM0`.
7. Press **Verify** to build. When it reports a successful build, press **Upload**.
8. If the IDE stops at `Connecting...`, hold the **BOOT** button, press Upload and release BOOT when writing starts.
9. Open **Tools → Serial Monitor** and choose **115200 baud**.

On Linux, check the port with:

```bash
ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null
```

If you see the port but the Arduino IDE reports `Permission denied`, add your account to the serial group and log out and in again:

```bash
sudo usermod -aG dialout "$USER"
```

Expected output on the Serial Monitor:

```text
ClassPulse hardware test ready. Press one key at a time.
Key: 1 | Wi-Fi: OFFLINE
Key: A | Wi-Fi: ONLINE
Displays off after 5 seconds.
```

## 5. When you have bought all the parts

Change `CP_MINIMAL_BREADBOARD_TEST` to `0`, then wire it according to [`breadboard-wiring.md`](breadboard-wiring.md). The keypad then goes back to GPIO33/34/35/39 with four 47 kΩ resistors, plus four 1 kΩ row resistors and the red LED. If the displays are powered from 5 V, add a 74AHCT125 level buffer.
