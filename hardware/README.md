# Quiz Remote: Hardware

This folder holds everything about the circuit: the design process, the KiCad projects, schematic and board images, the bill of materials, build scripts and simulations. The design document in `docs/` (in Vietnamese) gives the calculations for each block, the ESP32 pin map, the parts list with purchase links and the test results.

## Contents

| Path | Contents |
|---|---|
| `docs/tai-lieu-thiet-ke-phan-cung.md` | Design document: operating principle, calculations per block, ESP32 pin map, BOM with purchase links, test results |
| `schematic/` | Schematic per sheet, as PDF and PNG. `quiz_remote` is the root sheet; M1 to M6 are the functional blocks |
| `compact/` | 52 × 90 mm board: KiCad project, Gerber files, routing files, board images in `exports/`, `bom.csv` |
| `tools/` | Board build scripts, documentation export, power simulation, Wokwi firmware sample |

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
