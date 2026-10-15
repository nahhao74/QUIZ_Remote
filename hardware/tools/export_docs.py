"""Export the documentation pictures and BOM from the compact project.

Writes:
  schematic/<sheet>.pdf and .png   one file per schematic sheet (root sheet is quiz_remote)
  compact/exports/pcb-front|back   board views, PDF and PNG
  single-layer/exports/pcb-front|back
  compact/bom.csv                  bill of materials grouped by value and footprint

Run from the repository root:  python3 hardware/tools/export_docs.py
Needs kicad-cli, poppler-utils (pdftoppm, pdftotext) and Pillow.
"""
import subprocess
from pathlib import Path

from PIL import Image, ImageChops

HW = Path(__file__).resolve().parents[1]
COMPACT = HW / 'compact'
SINGLE = HW / 'single-layer'
SCHEMATIC = COMPACT / 'quiz_remote.kicad_sch'
# (page in the schematic PDF, file name). Page order follows the sheet hierarchy.
SHEETS = [(1, 'quiz_remote'), (2, 'M4_ESP32_SOCKET'), (3, 'M5_KEYPAD_4X4'), (4, 'M1_BATTERY_MAIN_SWITCH'),
          (5, 'M3_BOOST_3V3'), (6, 'M2_POWER_GATE_WAKE_HOLD'), (7, 'M6_DISPLAY_2DIGIT')]


def run(*args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def text_of_page(pdf, page):
    out = subprocess.run(['pdftotext', '-f', str(page), '-l', str(page), str(pdf), '-'], check=True,
                         capture_output=True, text=True)
    return out.stdout


def to_png(pdf, dpi, trim):
    base = pdf.with_suffix('')
    run('pdftoppm', '-png', '-r', str(dpi), '-singlefile', str(pdf), str(base))
    if trim:
        # Cut the white page margin so the board fills the picture.
        img = Image.open(base.with_suffix('.png')).convert('RGB')
        mask = ImageChops.difference(img, Image.new('RGB', img.size, (255, 255, 255))).convert('L')
        box = mask.point(lambda v: 255 if v > 24 else 0).getbbox()
        pad = 40
        img.crop((max(0, box[0] - pad), max(0, box[1] - pad),
                  min(img.width, box[2] + pad), min(img.height, box[3] + pad))).save(base.with_suffix('.png'))


def export_schematic():
    out = HW / 'schematic'
    out.mkdir(exist_ok=True)
    for page, name in SHEETS:
        pdf = out / f'{name}.pdf'
        run('kicad-cli', 'sch', 'export', 'pdf', '--pages', str(page), '-o', str(pdf), str(SCHEMATIC))
        if page > 1:  # the sheet name must be on the page we think it is
            assert name in text_of_page(pdf, 1), f'page {page} is not {name}'
        to_png(pdf, 150, trim=False)


def export_board(board):
    out = board / 'exports'
    out.mkdir(exist_ok=True)
    prj = board / 'quiz_remote.kicad_pcb'
    for side, layers, mirror in [('front', 'F.Cu,F.SilkS,Edge.Cuts', []), ('back', 'B.Cu,B.SilkS,Edge.Cuts', ['--mirror'])]:
        pdf = out / f'pcb-{side}.pdf'
        run('kicad-cli', 'pcb', 'export', 'pdf', '-l', layers, *mirror, '--scale', '0', '--mode-single',
            '-o', str(pdf), str(prj))
        to_png(pdf, 300, trim=True)


def export_bom():
    run('kicad-cli', 'sch', 'export', 'bom', '--fields', 'Reference,Value,Footprint,${QUANTITY},Datasheet',
        '--labels', 'Reference,Value,Footprint,Qty,Datasheet', '--group-by', 'Value,Footprint', '--exclude-dnp',
        '-o', str(COMPACT / 'bom.csv'), str(SCHEMATIC))


if __name__ == '__main__':
    export_schematic()
    export_board(COMPACT)
    export_board(SINGLE)
    export_bom()
    print('done')
