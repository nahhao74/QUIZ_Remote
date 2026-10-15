# Quiz Remote

A battery-powered handheld answer buzzer built around an ESP32. It has sixteen keys, two 7-segment digits and an ESP-NOW radio, and runs on two AAA cells. No part of the circuit draws power while idle: a key press wakes it, the ESP32 holds its own power while it works, and then it switches the whole board off.

| Front | Back |
|---|---|
| ![Front of the board](compact/exports/pcb-front.png) | ![Back of the board](compact/exports/pcb-back.png) |

## Overview

| | |
|---|---|
| Microcontroller | ESP32 NodeMCU LuaNode32, 30 pins, plugged into sockets so it can be removed for programming |
| Input | 4 × 4 matrix of 6 × 6 mm tactile switches (16 keys) |
| Display | Two 0.36" red 7-segment digits, common anode, driven by one 74HC595 shift register |
| Power | Two AAA cells in an external holder on connector JBAT; MT3608 boost converter to 3.37 V |
| Board | 52 × 90 mm, two layers, four M2 mounting holes |
| Parts cost | About 315,000 VND at prices of 2026-10-03, excluding AAA cells and shipping |

## How it works

1. **Idle.** No part of the circuit has power, including the ESP32, so the current drawn is only leakage.
2. **Key press.** A passive wake network pulls the gate of the power switch low. The switch turns on, the boost converter starts and the 3.37 V rail appears.
3. **Self-hold.** The ESP32 starts and drives `PWR_HOLD` (GPIO13) high, which keeps the power switch on after the key is released.
4. **Shutdown.** When the ESP32 releases `PWR_HOLD`, the power switch turns off and the board goes dark.

## Status

The design has been checked on a computer. It has not been assembled or measured yet.

| Check | Result |
|---|---|
| Schematic ERC | 0 errors |
| PCB DRC, with schematic parity | 0 violations, 0 unconnected items |
| Wake and self-hold simulation | Passes at 3.0 V and 2.4 V. The model has no leakage current, so it says nothing about idle current |

Still to measure: idle current, 3.3 V ripple and droop during radio bursts, boost behaviour at low battery voltage, and battery life.

## Contents

| Path | Contents |
|---|---|
| [`docs/design-document.md`](docs/design-document.md) | Design document: operating principle, calculations per block, ESP32 pin map, BOM with purchase links, test results |
| [`schematic/`](schematic/) | Schematic per sheet, as PDF and PNG. `quiz_remote` is the root sheet; M1 to M6 are the functional blocks |
| [`compact/`](compact/) | 52 × 90 mm board: KiCad project, Gerber files, routing files, board images in `exports/`, `bom.csv` |
| [`tools/`](tools/) | Board build scripts, documentation export, power simulation, Wokwi firmware sample |

## Design process

Work through the steps in order. Each step ends with a condition that must hold before the next one starts.

1. **Requirements and blocks.** Define what the circuit must do and the target current when idle. Split the circuit into blocks (M1 to M6) and draw each block as one KiCad sheet. *Done when* each block has one job and connects to the others through named nets.
2. **Calculations and parts.** Calculate voltage, current, power and timing for each block, and record the formulas and results in the design document. Choose parts that are sold locally and list them in the BOM. *Done when* every value on the schematic has a calculation or a stated reason in the document.
3. **Schematic and ERC.** Assign symbols, footprints and values, then run ERC. *Done when* ERC reports no errors.
4. **Simulation, when needed.** The wake and self-hold circuit is simulated in ngspice. Key scanning and the display are simulated on Wokwi. A simulation checks behaviour only; it does not replace measurement.
5. **Layout.** Place parts and route the board in KiCad, or rebuild it with the scripts below. *Done when* DRC with schematic parity reports no violations and no unconnected items.
6. **Export.** Generate the Gerber files, BOM and images. Update the design document and this README when the design changes.
7. **Assemble and measure.** Measure the assembled board: idle current, 3V3 ripple and droop during radio bursts, shutdown timing and battery life.

## Working with the KiCad project

Open `compact/quiz_remote.kicad_pro` in KiCad 10. The commands below run from the repository root.

```sh
kicad-cli sch erc hardware/compact/quiz_remote.kicad_sch
kicad-cli pcb drc --schematic-parity hardware/compact/quiz_remote.kicad_pcb
```

The schematic sheets in `compact/` are the source of the board. The board can be rebuilt from them with the placement and routing scripts. Routing uses Freerouting 2.4.1, which is not included in the repository:

```sh
python3 hardware/tools/build_compact_pcb.py place
FREEROUTING_DIR=/path/to/freerouting python3 hardware/tools/build_compact_pcb.py route
python3 hardware/tools/build_compact_pcb.py finish
```

The scripts rewrite the board files in `compact/`, so commit your changes first. Freerouting does not give the same result on every run, so a rebuild can leave a few connections open. Check with DRC and run `route` again if needed.

## Simulation and firmware

Power simulation (needs ngspice, which comes with KiCad):

```sh
python3 hardware/tools/sim_wake_hold.py
```

Firmware sample on [wokwi.com](https://wokwi.com): create an ESP32 project, paste `hardware/tools/wokwi_sim/wokwi_sim.ino` into `sketch.ino` and `hardware/tools/wokwi_sim/diagram.json` into `diagram.json`, then start the simulation. Before flashing the real board, change `#define WOKWI 1` to `#define WOKWI 0`.

## Exporting documentation

```sh
python3 hardware/tools/export_docs.py
```

The script writes:

- `schematic/`: one PDF and one PNG per sheet.
- `compact/exports/`: front and back board views, as PDF and PNG.
- `compact/bom.csv`: the bill of materials, grouped by value and footprint.

It needs `kicad-cli`, `pdftoppm` and `pdftotext` (from poppler-utils), and the Pillow package for Python.

## License

MIT. See [LICENSE](../LICENSE).
