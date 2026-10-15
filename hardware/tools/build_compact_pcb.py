"""Build the compact 52 x 90 mm board in compact/ from its schematic.

Stages (run in order):  place  ->  route  ->  finish
  place : footprints from the netlist, outline, net classes, Specctra DSN export
  route : Freerouting on the DSN (autorouter, user-authorized for this board only)
  finish: import the session, GND pours on both layers, save

"""
import json
import math
import os
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import pcbnew as pcb

ROOT = Path(__file__).resolve().parents[1]          # hardware/
PRJ = ROOT / 'compact'
BOARD = PRJ / 'quiz_remote.kicad_pcb'
DSN, SES = PRJ / 'route' / 'quiz_remote.dsn', PRJ / 'route' / 'quiz_remote.ses'
PLACED = PRJ / 'route' / 'placed_unrouted.kicad_pcb'   # finish always starts from this, never from a routed board
# folder holding freerouting-*.jar and a jre25/ runtime; only the route stage needs it
FREEROUTING = Path(os.environ.get('FREEROUTING_DIR', ROOT.parent / 'quiz_remote/validation/M12/autorouter_eval/freerouting'))
W, H, OX, OY = 52.0, 90.0, 100.0, 60.0          # board size and page offset, mm
TITLE = 'Quiz remote compact 52x90'
# signal track, clearance, via, drill, power track, power via, power drill (mm)
RULES = (0.2, 0.2, 0.6, 0.3, 0.6, 0.9, 0.45)
TP_FRONT = True                                   # side the test pads go on
POUR_LAYERS = (pcb.F_Cu, pcb.B_Cu)
ROUTE_ARGS = []
UNTENT_VIAS = False                                # True leaves vias open in the solder mask
GERBER_LAYERS = 'F.Cu,B.Cu,F.Mask,B.Mask,F.Paste,B.Paste,F.Silkscreen,B.Silkscreen,Edge.Cuts'
# mounting holes, added after routing in the spots the copper left free: M2 here, the corners are full of keys
HOLE, HOLES = 'MountingHole_2.2mm_M2', [(2.0, 9.75), (49.25, 10.5), (3.5, 78.05), (49.75, 78.05)]
HOLE_COPPER_R = 2.2            # no copper at all within this radius of a hole centre (screw head 3.8 mm), so a screw cannot short anything
HOLE_KEEPOUT_R = 2.1          # courtyard radius: M2 pan head (3.8 mm) plus 0.2 mm; the library's 2.45 mm does not fit between key rows
ZONE_CONN = pcb.ZONE_CONNECTION_THT_THERMAL        # thermals on through-hole pins only
TWEAK = None                                      # optional hook(board, footprints) run before the DSN export
POWER = ['/VBAT_AON', '/VIN_BOOST', '/3V3_SW', '/GND', '/M1_BATTERY_MAIN_SWITCH/VBAT_RAW', '/M3_BOOST_3V3/SW_NODE']
mm = pcb.FromMM
pt = lambda x, y: pcb.VECTOR2I(mm(OX + x), mm(OY + y))

# key matrix: 12.7 mm pitch so the two ESP32 socket rows (25.4 mm apart) fall between key columns
KX = [6.95, 19.65, 32.35, 45.05]
KY = [46.3, 59.0, 71.7, 84.4]
BAND = [52.65, 65.35, 78.05]                      # free strips between key rows (back side)


def layout():
    """ref -> (x, y, rotation, front?)  in board millimetres."""
    P = {}
    for i in range(16):
        r, c = divmod(i, 4)
        P[f'SW{i + 1}'] = (KX[c], KY[r], 0, True)
    P['DS1'], P['DS2'] = (21.0, 10.0, 0, True), (31.0, 10.0, 0, True)
    # ESP32 sockets on the back, pin 1 (USB end) up, pin 15 (antenna end) 4 mm from the bottom edge
    P['J1'], P['J2'] = (13.3, 50.44, 180, False), (38.7, 50.44, 180, False)
    # top edge: battery wires in, main switch
    P['JBAT'], P['SW_MAIN'] = (6.0, 4.5, 0, False), (43.5, 4.4, 0, False)
    # boost converter, left block. The switch node runs down the left edge: L1 -> U1 pin 1 -> DBOOST anode.
    # A fifth item (pad, x, y) picks the rotation that brings that pad closest to the point.
    P.update({'L1': (7.0, 16.5, 0, False, ('2', 2.9, 16.5)), 'U1': (5.0, 23.5, 0, False, ('1', 3.0, 22.0)),
              'DBOOST': (7.0, 29.5, 0, False, ('2', 3.0, 29.5)),
              'CIN1': (15.0, 14.0, 90, False, ('1', 12.0, 16.0)), 'CIN2': (15.0, 19.0, 90, False, ('1', 12.0, 17.0)),
              'RFB1': (14.5, 24.0, 0, False, ('2', 10.0, 24.0)), 'RFB4': (14.5, 26.5, 0, False, ('1', 10.0, 26.5)),
              'COUT1': (15.3, 30.5, 90, False, ('1', 12.0, 29.5)), 'COUT2': (13.5, 38.0, 90, False),
              'CRES': (7.0, 38.0, 0, False)})
    # power gate / wake / hold and digit switches, right block
    P.update({'QPWR': (38, 11.5, 0, False), 'C_GATE': (44, 11.5, 0, False), 'R_GATE': (44, 15, 0, False),
              'QWAKE': (38, 19, 0, False), 'R_WAKE': (44, 18, 0, False), 'R_WAKE_PD': (44, 20.5, 0, False),
              'QHOLD': (38, 25, 0, False), 'R_HOLD': (44, 24, 0, False), 'R_HOLD_PD': (44, 26.5, 0, False),
              'QDIG1': (38, 31, 0, False), 'RGP1': (44, 31, 0, False), 'QDIG2': (38, 36, 0, False), 'RGP2': (44, 36, 0, False)})
    # shift register and segment resistors, centre block under the displays
    P.update({'U2': (29.5, 26, 0, False), 'C_U2': (29.5, 19, 0, False), 'RDATA_PD': (27, 34, 0, False),
              'RCLK_PD': (31, 34, 0, False), 'RLATCH_PD': (27, 36.5, 0, False), 'ROE': (31, 36.5, 0, False)})
    for i, s in enumerate(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'DP']):
        P['RSEG_' + s] = (20.2 if i < 4 else 23.0, 22 + 3.6 * (i % 4), 90, False)
    # keypad drivers in the strips between key rows
    def row(r, s, m):
        P[f'QROW{r}'], P[f'RBASE{r}'], P[f'RBASE_PD{r}'] = (s + 2, m, 0, False), (s + 5.7, m - 1.1, 0, False), (s + 5.7, m + 1.1, 0, False)
        P[f'RROW{r}'] = (KX[3 - r], KY[r], 0, False)      # sits between the four pins of a key in its own row
    def col(c, s, m):
        P[f'QCOL{c}'], P[f'DWAKE{c}'], P[f'RCOL{c}'] = (s + 2, m, 0, False), (s + 6.4, m - 1.0, 0, False), (s + 6.4, m + 1.3, 0, False)
        P[f'RSENSE{c}'] = (KX[c], KY[c], 0, False)
    row(0, 16.0, BAND[0]); row(1, 27.5, BAND[0]); row(2, 16.0, BAND[1]); row(3, 27.5, BAND[1])
    col(1, 15.8, BAND[2]); col(2, 27.0, BAND[2]); col(0, 1.2, BAND[1]); col(3, 41.4, BAND[1])
    P['RSENSE3'] = (44, 40.5, 0, False)                  # the wide 3V3 trace cannot enter the corner key's pin box
    return P


def tp_slots(fps):
    """Free 1.5 mm test-pad spots on the front: between key rows and beside the displays."""
    slots = [(x, m) for m in BAND for x in [2.5 + 3.0 * i for i in range(16)] if min(abs(x - 13.3), abs(x - 38.7)) > 2.6]
    slots += [(x, y) for y in [3 + 3.2 * i for i in range(12)] for x in (2.5, 5.7, 8.9, 12.1, 39.9, 43.1, 46.3, 49.5)]
    return slots


def check_sockets(fps):
    # socket orientation is what makes the module fit: pin 1 on top, pin 15 near the bottom edge
    for j in ('J1', 'J2'):
        y = {p.GetNumber(): pcb.ToMM(p.GetPosition().y) - OY for p in fps[j].Pads()}
        assert abs(y['1'] - 50.44) < 0.01 and abs(y['15'] - 86.0) < 0.01, (j, y['1'], y['15'])


def place():
    b = pcb.BOARD()
    b.SetCopperLayerCount(2)
    ds = b.GetDesignSettings()
    ds.SetBoardThickness(mm(1.6))
    b.GetTitleBlock().SetTitle(TITLE)
    xml = PRJ / 'route' / 'netlist.xml'
    xml.parent.mkdir(exist_ok=True)
    subprocess.run(['kicad-cli', 'sch', 'export', 'netlist', '--format', 'kicadxml', '-o', str(xml), str(PRJ / 'quiz_remote.kicad_sch')], check=True, capture_output=True)
    root = ET.parse(xml).getroot()
    fps = {}
    for comp in root.findall('components/comp'):
        ref, fp = comp.attrib['ref'], comp.findtext('footprint')
        if not fp:
            continue                                   # BT1: the battery box is off-board
        lib, name = fp.split(':', 1)
        d = PRJ / 'quiz_remote_physical.pretty' if lib == 'quiz_remote_physical' else Path('/usr/share/kicad/footprints') / (lib + '.pretty')
        f = pcb.FootprintLoad(str(d), name)
        assert f, (ref, fp)
        f.SetFPID(pcb.LIB_ID(lib, name)); f.SetReference(ref); f.SetValue(comp.findtext('value'))
        path = pcb.KIID_PATH()
        for u in (comp.find('sheetpath').attrib['tstamps'] + '/' + comp.findtext('tstamps')).split('/'):
            if u:
                path.push_back(pcb.KIID(u))
        f.SetPath(path); f.SetSheetfile(comp.find('sheetpath').attrib['names'])
        f.SetExcludedFromBOM(ref.startswith('TP'))
        f.SetField('Datasheet', comp.findtext('datasheet') or '')
        for fld in comp.findall('fields/field'):
            if fld.text and fld.attrib['name'] not in ('Reference', 'Value', 'Footprint', 'Datasheet'):
                f.SetField(fld.attrib['name'], fld.text); f.GetField(fld.attrib['name']).SetVisible(False)
        f.Reference().SetVisible(False); f.Value().SetVisible(False)
        b.Add(f); fps[ref] = f
    netof, members = {}, {}
    for net in root.findall('nets/net'):
        n = pcb.NETINFO_ITEM(b, net.attrib['name']); b.Add(n)
        for node in net.findall('node'):
            netof[node.attrib['ref'], node.attrib['pin']] = n
            members.setdefault(net.attrib['name'], []).append(node.attrib['ref'])
    for ref, f in fps.items():
        for pad in f.Pads():
            if (ref, pad.GetNumber()) in netof:
                pad.SetNet(netof[ref, pad.GetNumber()])

    def put(ref, x, y, rot, front, aim=None):
        f = fps[ref]
        if not front:
            f.Flip(f.GetPosition(), pcb.FLIP_DIRECTION_LEFT_RIGHT)
        f.SetOrientationDegrees(rot); f.SetPosition(pt(x, y))
        if aim:
            pad, tx, ty = aim
            def miss(r):
                f.SetOrientationDegrees(r)
                q = next(p for p in f.Pads() if p.GetNumber() == pad).GetPosition()
                return (pcb.ToMM(q.x) - OX - tx) ** 2 + (pcb.ToMM(q.y) - OY - ty) ** 2
            f.SetOrientationDegrees(min((rot, rot + 180) if ref != 'U1' else (0, 90, 180, 270), key=miss))
    P = layout()
    for ref, a in P.items():
        put(ref, *a)
    # test pads: each goes to the free front spot nearest the parts on its net
    slots = tp_slots(fps)
    for ref in sorted(r for r in fps if r.startswith('TP')):
        net = fps[ref].Pads()[0].GetNetname()
        near = [P[m][:2] for m in members.get(net, []) if m in P] or [(W / 2, H / 2)]
        cx, cy = sum(p[0] for p in near) / len(near), sum(p[1] for p in near) / len(near)
        s = min(slots, key=lambda q: (q[0] - cx) ** 2 + (q[1] - cy) ** 2)
        slots.remove(s); put(ref, s[0], s[1], 0, TP_FRONT); P[ref] = (*s, 0, TP_FRONT)
    missing = set(fps) - set(P)
    assert not missing, missing
    check_sockets(fps)
    # outline
    for a, c in zip([(0, 0), (W, 0), (W, H), (0, H)], [(W, 0), (W, H), (0, H), (0, 0)]):
        s = pcb.PCB_SHAPE(b); s.SetShape(pcb.SHAPE_T_SEGMENT); s.SetLayer(pcb.Edge_Cuts)
        s.SetStart(pt(*a)); s.SetEnd(pt(*c)); s.SetWidth(mm(0.1)); b.Add(s)
    ns = ds.m_NetSettings
    dflt = ns.GetDefaultNetclass()
    tw, cl, via, drill, ptw, pvia, pdrill = RULES
    dflt.SetTrackWidth(mm(tw)); dflt.SetClearance(mm(cl)); dflt.SetViaDiameter(mm(via)); dflt.SetViaDrill(mm(drill))
    power = pcb.NETCLASS('Power')
    power.SetTrackWidth(mm(ptw)); power.SetClearance(mm(cl)); power.SetViaDiameter(mm(pvia)); power.SetViaDrill(mm(pdrill))
    ns.SetNetclass('Power', power)
    for n in POWER:
        ns.SetNetclassPatternAssignment(n, 'Power')
    b.SynchronizeNetsAndNetClasses(True)
    if TWEAK:
        TWEAK(b, fps)
    assert pcb.ExportSpecctraDSN(b, str(DSN)), 'DSN export failed'
    pcb.SaveBoard(str(PLACED), b)
    pcb.SaveBoard(str(BOARD), b)
    # the project file keeps the same classes for the KiCad GUI
    pro = PRJ / 'quiz_remote.kicad_pro'
    d = json.loads(pro.read_text())
    base = dict(d['net_settings']['classes'][0], track_width=tw, clearance=cl, via_diameter=via, via_drill=drill)
    d['net_settings']['classes'] = [base, dict(base, name='Power', track_width=ptw, via_diameter=pvia, via_drill=pdrill, priority=0)]
    d['net_settings']['netclass_patterns'] = [{'netclass': 'Power', 'pattern': n} for n in POWER]
    pro.write_text(json.dumps(d, indent=2) + '\n')
    print('placed', len(fps), 'footprints; DSN at', DSN)


def route(passes='60'):
    java = FREEROUTING / 'jre25' / 'bin' / 'java'
    jar = next(FREEROUTING.glob('freerouting-*.jar'))
    subprocess.run([str(java), '-Djava.awt.headless=true', '-jar', str(jar), '-de', str(DSN), '-do', str(SES), '-mp', passes,
                    '--gui.enabled=false', *ROUTE_ARGS], check=True, cwd=str(DSN.parent))
    assert SES.exists(), 'Freerouting produced no session file'


def finish():
    b = pcb.LoadBoard(str(PLACED))
    assert pcb.ImportSpecctraSES(b, str(SES)), 'SES import failed'
    pcb.SaveBoard(str(BOARD), b)
    # pours run in a fresh process: pcbnew crashes when the board is reloaded after a session import
    subprocess.run([sys.executable, sys.argv[0], 'pour'], check=True)


def pour():
    b = pcb.LoadBoard(str(BOARD))
    for t in b.GetTracks():
        if not isinstance(t, pcb.PCB_VIA) and t.GetWidth() < mm(RULES[0]):
            t.SetWidth(mm(RULES[0]))
        if isinstance(t, pcb.PCB_VIA) and t.GetWidth(pcb.F_Cu) < mm(RULES[5]):
            t.SetDrill(mm(RULES[3]))                         # the session sometimes pairs a small via with the large drill
    if UNTENT_VIAS:
        for t in b.GetTracks():
            if isinstance(t, pcb.PCB_VIA):
                t.SetFrontTentingMode(pcb.TENTING_MODE_NOT_TENTED); t.SetBackTentingMode(pcb.TENTING_MODE_NOT_TENTED)
    for i, (x, y) in enumerate(HOLES, 1):
        f = pcb.FootprintLoad('/usr/share/kicad/footprints/MountingHole.pretty', HOLE)
        f.SetFPID(pcb.LIB_ID('' if HOLE_KEEPOUT_R else 'MountingHole', HOLE)); f.SetReference(f'H{i}'); f.SetPosition(pt(x, y))   # a changed courtyard is no longer the library part
        f.SetAttributes(pcb.FP_BOARD_ONLY | pcb.FP_EXCLUDE_FROM_BOM | pcb.FP_EXCLUDE_FROM_POS_FILES)
        f.Reference().SetVisible(False); f.Value().SetVisible(False)
        for g in f.GraphicalItems():
            if HOLE_KEEPOUT_R and g.GetLayer() in (pcb.F_CrtYd, pcb.B_CrtYd):
                g.SetEnd(g.GetCenter() + pcb.VECTOR2I(mm(HOLE_KEEPOUT_R), 0))
        b.Add(f)
        k = pcb.ZONE(b); k.SetIsRuleArea(True); k.SetLayerSet(pcb.LSET.AllCuMask()); k.SetZoneName(f'H{i} no copper')
        k.SetDoNotAllowZoneFills(True); k.SetDoNotAllowTracks(True); k.SetDoNotAllowVias(True)
        k.SetDoNotAllowPads(False); k.SetDoNotAllowFootprints(False)
        o = k.Outline(); o.NewOutline()
        for a in range(36):
            o.Append(mm(OX + x + HOLE_COPPER_R * math.cos(a * math.pi / 18)), mm(OY + y + HOLE_COPPER_R * math.sin(a * math.pi / 18)))
        b.Add(k)
    gnd = b.FindNet('/GND')
    for layer in POUR_LAYERS:
        z = pcb.ZONE(b); z.SetLayer(layer); z.SetNet(gnd); z.SetZoneName('GND')
        z.SetLocalClearance(mm(0.3)); z.SetMinThickness(mm(0.25)); z.SetPadConnection(ZONE_CONN)
        z.SetIslandRemovalMode(pcb.ISLAND_REMOVAL_MODE_ALWAYS)
        o = z.Outline(); o.NewOutline()
        for x, y in [(0, 0), (W, 0), (W, H), (0, H)]:
            o.Append(mm(OX + x), mm(OY + y))
        b.Add(z)
    pcb.ZONE_FILLER(b).Fill(b.Zones())
    pcb.SaveBoard(str(BOARD), b)
    print('tracks+vias', len(b.GetTracks()))


def gerber():
    """Fabrication files: Gerbers and Excellon drills in <project>/gerber, plus a zip to upload to the board house."""
    import shutil
    out = PRJ / 'gerber'
    shutil.rmtree(out, ignore_errors=True); out.mkdir()
    subprocess.run(['kicad-cli', 'pcb', 'export', 'gerbers', '--layers', GERBER_LAYERS, '--subtract-soldermask', '-o', str(out) + '/', str(BOARD)], check=True, capture_output=True)
    subprocess.run(['kicad-cli', 'pcb', 'export', 'drill', '--format', 'excellon', '--excellon-separate-th', '--generate-map', '--map-format', 'pdf',
                    '-o', str(out) + '/', str(BOARD)], check=True, capture_output=True)
    print(shutil.make_archive(str(PRJ / (PRJ.name + '_gerber')), 'zip', out))


SOLDER_COLORS = {'res': '#c9a66b', 'cer': '#4c6ef5', 'tant': '#f08c00', 'elec': '#1c3d6e', 'diode': '#e03131', 'pmos': '#7048e8',
                 'npn': '#2f9e44', 'nmos': '#0b9fb0', 'ic': '#343a40', 'ind': '#8d5524', 'socket': '#868e96', 'key': '#adb5bd',
                 'disp': '#2b2b2b', 'jbat': '#e8590c', 'swmain': '#5c7cfa'}
SOT23_PINS = {'npn': {'1': 'B', '2': 'E', '3': 'C'}, 'pmos': {'1': 'G', '2': 'S', '3': 'D'}, 'nmos': {'1': 'G', '2': 'S', '3': 'D'}}


def _kind(ref, value, fpid):
    if ref.startswith('H'):
        return 'hole'
    for key, k in (('TestPoint', 'tp'), ('R_', 'res'), ('CP_', 'tant'), ('CRES', 'elec'), ('C_', 'cer'), ('D_', 'diode'), ('L_', 'ind'),
                   ('SOT-23-6', 'ic'), ('SOIC', 'ic'), ('PinSocket', 'socket'), ('JBAT', 'jbat'), ('Display', 'disp'),
                   ('SW_6x6', 'key'), ('SW_SS12', 'swmain')):
        if fpid.startswith(key):
            return k
    assert fpid.startswith('SOT-23'), fpid
    return 'pmos' if 'AO3401' in value else 'npn' if 'MMBT3904' in value else 'nmos'


def _pretty(value, fpid):
    import re
    v = value.strip()
    m = re.fullmatch(r'([\d.]+)\s*([RkM]?)(?:\s*1%)?', v)
    if m:
        out = f"{m.group(1)} {({'R': 'Ω', 'k': 'kΩ', 'M': 'MΩ', '': 'Ω'})[m.group(2)]}"
    else:
        names = {'LBSS138LT1G': 'BSS138', 'MMBT3904-1AM': 'MMBT3904', 'MT3608L': 'MT3608', '74HC595D,118': '74HC595', '3161BS_LOGICAL_CA': '3161BS',
                 'LUA_SOCKET_ROW_A': 'Đế ESP32 hàng A', 'LUA_SOCKET_ROW_B': 'Đế ESP32 hàng B', 'LK2114_BATTERY': 'Đầu nối pin',
                 '6x6_THT_NO': 'Nút 6×6', 'SS-12F23G4': 'Công tắc nguồn'}
        out = names.get(v) or re.sub(r'(\d)\s*([unp])([FH])', lambda k: f"{k.group(1)} {'µ' if k.group(2) == 'u' else k.group(2)}{k.group(3)}", v)
    tag = next((t for t in ('1206', '1210', '3216') if t in fpid), None)
    if tag:
        out += f' ({tag})'
    return out


def solder():
    """Assembly guide: route/solder_front|back .svg and .png. The back view is mirrored (x -> W - x), as the board looks when flipped like a page."""
    import html
    import math
    import re
    import shutil
    import textwrap
    from collections import Counter
    S, M, TOP = 16.0, 24.0, 70.0                           # px per mm, side margin, title height
    b = pcb.LoadBoard(str(BOARD))
    rel = lambda bb: (pcb.ToMM(bb.GetLeft()) - OX, pcb.ToMM(bb.GetTop()) - OY, pcb.ToMM(bb.GetRight()) - OX, pcb.ToMM(bb.GetBottom()) - OY)
    parts, holes = {}, []
    for f in b.GetFootprints():
        ref, fpid = f.GetReference(), f.GetFPIDAsString().split(':')[-1]
        k = _kind(ref, f.GetValue(), fpid)
        if k == 'hole':
            holes.append((pcb.ToMM(f.GetPosition().x) - OX, pcb.ToMM(f.GetPosition().y) - OY, pcb.ToMM(f.Pads()[0].GetDrillSizeX()) / 2))
            continue
        pads = [{'num': q.GetNumber(), 'net': q.GetNetname(), 'r': rel(q.GetBoundingBox()), 'tht': q.HasHole(),
                 'round': q.GetShape() in (pcb.PAD_SHAPE_CIRCLE, pcb.PAD_SHAPE_OVAL), 'drill': pcb.ToMM(q.GetDrillSizeX()), 'npth': not q.GetNumber()}
                for q in f.Pads()]
        fab = [g.GetBoundingBox() for g in f.GraphicalItems() if g.Type() == pcb.PCB_SHAPE_T and g.GetLayer() in (pcb.F_Fab, pcb.B_Fab)]   # shapes only: fab text would inflate the body
        body = None
        if fab:
            bb = fab[0]
            for o in fab[1:]:
                bb.Merge(o)
            body = rel(bb)
        if not body or body[2] - body[0] < 0.5 or body[3] - body[1] < 0.5:
            body = (min(p['r'][0] for p in pads), min(p['r'][1] for p in pads), max(p['r'][2] for p in pads), max(p['r'][3] for p in pads))
        parts[ref] = {'ref': ref, 'kind': k, 'value': _pretty(f.GetValue(), fpid), 'side': 'B' if f.IsFlipped() else 'F', 'pads': pads, 'body': body,
                      'tht': any(p['tht'] for p in pads)}
    pad = lambda ref, num: next(p for p in parts[ref]['pads'] if p['num'] == num)
    center = lambda r: ((r[0] + r[2]) / 2, (r[1] + r[3]) / 2)
    marks = []                                              # (ref, role, pad) of every polarity marker drawn, checked at the end

    def render(back):
        side = 'B' if back else 'F'
        fx = (lambda x: W - x) if back else (lambda x: x)
        R = lambda r: (M + fx(r[2] if back else r[0]) * S, TOP + r[1] * S, M + fx(r[0] if back else r[2]) * S, TOP + r[3] * S)   # mm rect -> px rect
        P = lambda x, y: (M + fx(x) * S, TOP + y * S)
        els, obstacles, anchors = [], [], []
        esc = lambda t: html.escape(t, quote=False)

        def rect(r, fill, stroke='#222', sw=1.0, rx=3.0, op=1.0, dash=''):
            els.append(f'<rect x="{r[0]:.1f}" y="{r[1]:.1f}" width="{r[2] - r[0]:.1f}" height="{r[3] - r[1]:.1f}" rx="{rx}" fill="{fill}" stroke="{stroke}" '
                       f'stroke-width="{sw}" opacity="{op}"' + (f' stroke-dasharray="{dash}"' if dash else '') + '/>')

        def text(x, y, t, size=10, fill='#111', bold=False, anchor='middle', halo=True):
            els.append(f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" fill="{fill}" text-anchor="{anchor}" font-weight="{"700" if bold else "400"}"'
                       + (' stroke="white" stroke-width="3" paint-order="stroke" stroke-linejoin="round"' if halo else '') + f'>{esc(t)}</text>')

        def draw_pad(p, tag=False):
            r = R(p['r'])
            if p['npth']:
                els.append(f'<circle cx="{(r[0] + r[2]) / 2:.1f}" cy="{(r[1] + r[3]) / 2:.1f}" r="{p["drill"] * S / 2:.1f}" fill="white" stroke="#777" stroke-width="1" stroke-dasharray="3 2"/>')
                return
            if p['round']:
                rect(r, '#e0b84a', '#8a6d1b', 0.8, rx=min(r[2] - r[0], r[3] - r[1]) / 2)
            else:
                rect(r, '#e0b84a', '#8a6d1b', 0.8, rx=1.5)
            if p['tht']:
                els.append(f'<circle cx="{(r[0] + r[2]) / 2:.1f}" cy="{(r[1] + r[3]) / 2:.1f}" r="{p["drill"] * S / 2:.1f}" fill="white" stroke="#8a6d1b" stroke-width="0.8"/>')

        # board, screw holes
        rect((M, TOP, M + W * S, TOP + H * S), '#e9f3e6', '#1b4d2b', 3, rx=4)
        for x, y, d in holes:
            cx, cy = P(x, y)
            els.append(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{HOLE_COPPER_R * S:.1f}" fill="none" stroke="#999" stroke-width="1" stroke-dasharray="4 3"/>')
            els.append(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{d * S:.1f}" fill="white" stroke="#444" stroke-width="1.5"/>')
            obstacles.append((cx - d * S, cy - d * S, cx + d * S, cy + d * S))
        if UNTENT_VIAS:                                     # single-sided board: every via is an open hole for a jumper wire
            for t in b.GetTracks():
                if isinstance(t, pcb.PCB_VIA):
                    cx, cy = P(pcb.ToMM(t.GetPosition().x) - OX, pcb.ToMM(t.GetPosition().y) - OY); rr = pcb.ToMM(t.GetWidth(pcb.F_Cu)) * S / 2
                    els.append(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{rr:.1f}" fill="#e0b84a" stroke="#8a6d1b" stroke-width="0.8"/><circle cx="{cx:.1f}" cy="{cy:.1f}" r="{pcb.ToMM(t.GetDrillValue()) * S / 2:.1f}" fill="white" stroke="#8a6d1b" stroke-width="0.6"/>')
                    obstacles.append((cx - rr, cy - rr, cx + rr, cy + rr))
        # parts visible in this view: bodies of parts on this side, bare pads of through-hole parts on the other side
        vis = [p for p in parts.values() if p['side'] == side or (p['tht'] and p['kind'] != 'tp')]
        for p in sorted(vis, key=lambda p: p['kind'] in ('tp',)):
            k, r_body = p['kind'], R(p['body'])
            mine = p['side'] == side
            if k == 'tp':
                for q in p['pads']:
                    r = R(q['r']); rect(r, '#ced4da', '#868e96', 0.8, rx=(r[2] - r[0]) / 2); obstacles.append(r)
                continue
            if mine and k in ('res', 'cer', 'tant', 'diode', 'ind', 'ic', 'pmos', 'npn', 'nmos'):
                for q in p['pads']:
                    draw_pad(q)
                rect(r_body, SOLDER_COLORS[k], '#222', 1.0, rx=3, op=0.92)
                obstacles.append((min([R(q['r'])[0] for q in p['pads']] + [r_body[0]]), min([R(q['r'])[1] for q in p['pads']] + [r_body[1]]),
                                  max([R(q['r'])[2] for q in p['pads']] + [r_body[2]]), max([R(q['r'])[3] for q in p['pads']] + [r_body[3]])))
                anchors.append(p)
            elif mine and k in ('key', 'disp', 'elec', 'socket', 'jbat', 'swmain'):   # through-hole parts mounted on this side, seen from above
                if k == 'key':
                    rect(r_body, '#dee2e6', '#495057', 1.2, rx=4)
                    cx, cy = center(r_body)
                    els.append(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{1.9 * S:.1f}" fill="#495057" stroke="#212529" stroke-width="1.5"/>')
                    text(cx, cy + 4, p['ref'].replace('SW', ''), 13, '#f8f9fa', True, halo=False)
                elif k == 'disp':
                    rect(r_body, SOLDER_COLORS[k], '#000', 1.5, rx=3)
                    cx, cy = center(r_body)
                    text(cx, cy + 14, '8', 44, '#ff6b6b', True, halo=False)
                    anchors.append(p)
                elif k == 'elec':
                    cx, cy = center(r_body); rad = min(r_body[2] - r_body[0], r_body[3] - r_body[1]) / 2
                    els.append(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{rad:.1f}" fill="{SOLDER_COLORS[k]}" stroke="#000" stroke-width="1.5"/>')
                    c1, c2 = center(R(pad(p['ref'], '1')['r'])), center(R(pad(p['ref'], '2')['r']))
                    ux, uy = c2[0] - c1[0], c2[1] - c1[1]; n = (ux * ux + uy * uy) ** 0.5; ux, uy = ux / n, uy / n
                    base = math.atan2(uy, ux)
                    pts = [(cx + rad * math.cos(base + math.radians(a)), cy + rad * math.sin(base + math.radians(a))) for a in range(-63, 64, 7)]
                    els.append('<polygon points="' + ' '.join(f'{x:.1f},{y:.1f}' for x, y in pts) + '" fill="#f1f3f5" stroke="#000" stroke-width="1"/>')
                    text(cx + 0.78 * rad * ux, cy + 0.78 * rad * uy + 5, '−', 16, '#111', True, halo=False)
                    anchors.append(p)
                elif k == 'socket':
                    rect(r_body, '#adb5bd', '#343a40', 1.2, rx=2)
                    anchors.append(p)
                elif k in ('jbat', 'swmain'):
                    rect(r_body, SOLDER_COLORS[k], '#222', 1.2, rx=3, op=0.9)
                    anchors.append(p)
                obstacles.append(r_body)
                for q in p['pads']:
                    draw_pad(q)
            elif p['tht']:                                  # back view: only the pads to solder
                for q in p['pads']:
                    draw_pad(q)
                if k not in ('key',):
                    anchors.append(p)
            for q in (p['pads'] if p['tht'] else []):
                obstacles.append(R(q['r']))

        # markers
        for p in parts.values():
            k, ref = p['kind'], p['ref']
            if not (p['side'] == side or (p['tht'] and k != 'tp')):
                continue
            def dot(q, label=None, color='#d6336c'):
                cx, cy = center(R(q['r']))
                els.append(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="4.5" fill="{color}" stroke="white" stroke-width="1.2"/>')
                if label:
                    text(cx, cy - 8, label, 10, color, True)
            def sym(q, s, color):
                cx, cy = center(R(q['r']))
                text(cx, cy + 5, s, 16, color, True)
            if k == 'diode' and p['side'] == side:           # band on the cathode end, K = pad 1
                q1, q2 = pad(ref, '1'), pad(ref, '2'); marks.append((ref, 'K', q1))
                c1, c2 = center(R(q1['r'])), center(R(q2['r'])); bx = R(p['body'])
                if abs(c1[0] - c2[0]) > abs(c1[1] - c2[1]):
                    sx = 1 if c1[0] > c2[0] else -1; x = (bx[2] - 6) if sx > 0 else (bx[0] + 6)
                    rect((x - 4, bx[1] + 1, x + 4, bx[3] - 1), '#f8f9fa', '#222', 0.8, rx=1)
                else:
                    sy = 1 if c1[1] > c2[1] else -1; y = (bx[3] - 6) if sy > 0 else (bx[1] + 6)
                    rect((bx[0] + 1, y - 4, bx[2] - 1, y + 4), '#f8f9fa', '#222', 0.8, rx=1)
                sym(q1, 'K', '#a61e1e'); sym(q2, 'A', '#1c7ed6')
            elif k == 'tant' and p['side'] == side:          # tantalum: the stripe marks the PLUS end, pad 1
                q1, q2 = pad(ref, '1'), pad(ref, '2'); marks.append((ref, 'plus', q1))
                c1, c2 = center(R(q1['r'])), center(R(q2['r'])); bx = R(p['body'])
                sx = 1 if c1[0] > c2[0] else -1; x = (bx[2] - 8) if sx > 0 else (bx[0] + 8)
                rect((x - 5, bx[1] + 1, x + 5, bx[3] - 1), '#fff3bf', '#222', 0.8, rx=1)
                sym(q1, '+', '#c92a2a'); sym(q2, '−', '#1864ab')
            elif k == 'elec':                               # electrolytic: stripe marks the MINUS end; + is pad 1 (long leg)
                q1, q2 = pad(ref, '1'), pad(ref, '2'); marks.append((ref, 'plus', q1))
                sym(q1, '+', '#c92a2a'); sym(q2, '−', '#1864ab')
            elif k == 'jbat':
                q1, q2 = pad(ref, '1'), pad(ref, '2'); marks.append((ref, 'plus', q1))
                sym(q1, '+', '#c92a2a'); sym(q2, '−', '#1864ab')
            elif k in ('ic',) and p['side'] == side:
                dot(pad(ref, '1'), '1')
            elif k in SOT23_PINS and p['side'] == side:
                for q in p['pads']:
                    cx, cy = center(R(q['r']))
                    text(cx, cy + 3.5, SOT23_PINS[k][q['num']], 9, '#111', True)
            elif k == 'disp':
                dot(pad(ref, '1'), '1', '#ff922b'); dot(pad(ref, '7'), 'DP', '#ffd43b')
            elif k == 'socket':
                other = parts['J2' if ref == 'J1' else 'J1']
                out = -1 if center(R(p['body']))[0] < center(R(other['body']))[0] else 1    # label on the outer side of the pair
                for num, lab in (('1', '1 USB'), ('15', '15 anten')):
                    q = pad(ref, num); cx, cy = center(R(q['r']))
                    els.append(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="4.5" fill="#d6336c" stroke="white" stroke-width="1.2"/>')
                    text(cx + out * 11, cy + 4, lab if p['side'] == side else num, 10, '#a61e4d', True, 'end' if out < 0 else 'start')
        # labels, greedily placed next to their part without covering other parts or labels
        taken, labels, lines_of = list(obstacles), [], {}
        W_PX = M * 2 + W * S
        for p in sorted(anchors, key=lambda p: (not p['tht'], p['body'][1], p['body'][0])):   # through-hole parts first: their labels must stay close
            bx = R(p['body'])
            if p['kind'] in ('socket',):
                bx = (min(R(q['r'])[0] for q in p['pads']), min(R(q['r'])[1] for q in p['pads']), max(R(q['r'])[2] for q in p['pads']), max(R(q['r'])[3] for q in p['pads']))
            sub = p['ref'] if p['side'] == side or not p['tht'] else f"{p['ref']} (lắp mặt {'sau' if p['side'] == 'B' else 'trước'})"
            lines = [(p['value'], 10.5, True, '#111'), (sub, 8.5, False, '#555')]
            w = max(len(t) * s * (0.6 if b_ else 0.54) for t, s, b_, c in lines) + 2
            h = sum(s * 1.2 for t, s, b_, c in lines)
            cx, cy = (bx[0] + bx[2]) / 2, (bx[1] + bx[3]) / 2
            best = None
            for gap in (3, 9, 18, 30, 46):
                for lx, ly in ((cx - w / 2, bx[1] - gap - h), (cx - w / 2, bx[3] + gap), (bx[0] - gap - w, cy - h / 2), (bx[2] + gap, cy - h / 2),
                               (bx[0] - gap - w, bx[1] - gap - h), (bx[2] + gap, bx[1] - gap - h), (bx[0] - gap - w, bx[3] + gap), (bx[2] + gap, bx[3] + gap)):
                    r = (lx, ly, lx + w, ly + h)
                    if r[0] < 2 or r[2] > W_PX - 2 or r[1] < TOP - 4 or r[3] > TOP + H * S + 10:
                        continue
                    ov = sum(max(0, min(r[2], t[2]) - max(r[0], t[0])) * max(0, min(r[3], t[3]) - max(r[1], t[1])) for t in taken)
                    if best is None or ov < best[0] or (ov == best[0] and gap < best[3]):
                        best = (ov, r, gap, gap)
                    if ov == 0:
                        break
                if best and best[0] == 0:
                    break
            _, r, gap, _g = best
            taken.append(r); labels.append((p, r, gap)); lines_of[p['ref']] = lines
        for p, r, gap in labels:
            bx = R(p['body'])
            if gap > 9:
                els.append(f'<line x1="{(bx[0] + bx[2]) / 2:.1f}" y1="{(bx[1] + bx[3]) / 2:.1f}" x2="{(r[0] + r[2]) / 2:.1f}" y2="{(r[1] + r[3]) / 2:.1f}" stroke="#495057" stroke-width="0.8"/>')
        for p, r, gap in labels:
            y = r[1]
            for t, s, b_, c in lines_of[p['ref']]:
                y += s * 1.15
                text((r[0] + r[2]) / 2, y, t, s, c, b_)
                y += s * 0.05
        return els

    # legends -----------------------------------------------------------------------------------------------------------------
    smd = [p for p in parts.values() if p['side'] == 'B' and not p['tht'] and p['kind'] != 'tp']
    cnt = Counter(p['kind'] for p in smd)
    names = lambda ks: ', '.join(sorted(p['ref'] for p in smd if p['kind'] in ks))
    by_val = lambda k: Counter(p['value'] for p in smd if p['kind'] == k)
    smd_legend = [
        ('res', f"Điện trở {cnt['res']} con, KHÔNG phân cực. Giá trị in trên hình; chữ in trên linh kiện rất nhỏ, hãy chia túi theo giá trị hoặc đo bằng đồng hồ."),
        ('cer', f"Tụ gốm {cnt['cer']} con, KHÔNG phân cực (22 µF cỡ 1210, 100 nF cỡ 0805)."),
        ('tant', "Tụ tantan C_GATE 4,7 µF: có cực. Vạch vàng trên thân = đầu DƯƠNG (+), hàn về phía dấu +."),
        ('diode', "Diode: vạch trắng trên thân = đầu K (cực âm), hàn về phía chữ K. DWAKE0–3 loại 1N4148W, DBOOST loại SS34 (to, cỡ SMC)."),
        ('pmos', f"AO3401A (P-MOSFET) {cnt['pmos']} con: {names(['pmos'])}. Chân G/S/D ghi trên pad."),
        ('npn', f"MMBT3904 (NPN) {cnt['npn']} con: {names(['npn'])}. Chân B/E/C ghi trên pad."),
        ('nmos', f"BSS138 (N-MOSFET) {cnt['nmos']} con: {names(['nmos'])}. Chân G/S/D ghi trên pad. Ba loại SOT-23 này giống hệt nhau, đừng để lẫn túi."),
        ('ic', "IC (U1 MT3608, U2 74HC595): chấm hồng = chân 1, khớp với chấm hoặc vết lõm trên thân IC."),
        ('ind', "Cuộn cảm L1 22 µH: không phân cực."),
    ]
    tht_legend = {
        'key': "Nút nhấn 6×6, 16 cái, đánh số 1–16 theo thứ tự SW1…SW16, đủ 4 chân.",
        'disp': "LED 7 thanh 3161BS dương chung (DS1, DS2). Chấm cam = chân 1, chấm vàng = chân DP (dấu chấm thập phân). Đặt LED sao cho chân DP khớp chấm vàng; chưa kiểm tra bằng linh kiện thật.",
        'socket': "Hai hàng đế cái cho module ESP32 (J1, J2). Chấm hồng = chân 1 (đầu USB của module) và chân 15 (đầu anten).",
        'jbat': "Đầu nối pin JBAT: + (dây đỏ của hộp pin) và − (dây đen). Cắm sai cực có thể làm hỏng mạch.",
        'swmain': "Công tắc trượt nguồn SW_MAIN.",
        'elec': "Tụ hoá CRES 470 µF 16 V: có cực. Vạch trắng trên thân = chân ÂM (−). Chân dài = dương (+). Dấu + ở pad 1.",
    }
    kind_name = {'key': 'nút nhấn', 'disp': 'LED 7 thanh', 'socket': 'đế ESP32', 'jbat': 'đầu pin', 'swmain': 'công tắc nguồn', 'elec': 'tụ hoá'}
    side_kinds = {sd: [k for k in tht_legend if any(p['kind'] == k and p['side'] == sd for p in parts.values())] for sd in 'FB'}
    back_notes = ["Thứ tự hàn gợi ý: 1) điện trở, tụ gốm  2) diode, transistor  3) IC, cuộn cảm, tụ 22 µF  4) linh kiện xuyên lỗ.",
                  "Chấm tròn xám nhỏ và vòng tròn nhỏ không có linh kiện là pad đo, để trống. Vòng nét đứt quanh lỗ vít là vùng không có đồng."]
    sw_text = {'front': "MẶT TRƯỚC. Linh kiện lắp ở mặt này: " + (', '.join(kind_name[k] for k in side_kinds['F']) or 'không có') + ". Cắm từ mặt này, hàn chân ở mặt đối diện.",
               'back': "MẶT SAU, nhìn từ phía sau (lật board như lật trang sách, trái-phải đã đảo). Lắp ở mặt này: linh kiện dán"
                       + ''.join(', ' + kind_name[k] for k in side_kinds['B']) + (". Linh kiện xuyên lỗ lắp ở mặt sau cắm từ mặt này, hàn chân ở mặt trước." if side_kinds['B'] else "."),}
    has_jumpers = (PRJ / 'route' / 'jumpers.png').exists()
    out = PRJ / 'route'
    chrome = shutil.which('google-chrome')
    for back in (False, True):
        els = render(back)
        legend = (smd_legend if back else []) + [(k, tht_legend[k]) for k in side_kinds['B' if back else 'F']]
        notes = back_notes if back else []
        if UNTENT_VIAS and not back:
            notes = ['Vòng vàng nhỏ không có linh kiện là lỗ dây nhảy: luồn dây qua lỗ ở mặt này, hàn ở mặt sau (xem route/jumpers.png).']
        if has_jumpers and back:
            notes = notes + ['Board 1 lớp: vòng vàng nhỏ không có linh kiện là lỗ dây nhảy, để trống lúc hàn linh kiện. Sau đó nối dây theo hình route/jumpers.png.']
        width = M * 2 + W * S
        y0 = TOP + H * S + 28
        wrap = textwrap.wrap
        cols = max(40, int((width - 60) / 6.6))
        rows = []
        for key, t in legend:
            for i, ln in enumerate(wrap(t, cols)):
                rows.append((key if i == 0 else None, ln))
        for t in notes:
            for i, ln in enumerate(wrap(t, cols + 6)):
                rows.append(('note' if i == 0 else None, ln))
        height = y0 + 20 * len(rows) + 24
        svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width:.0f}" height="{height:.0f}" viewBox="0 0 {width:.0f} {height:.0f}" font-family="DejaVu Sans, Arial, sans-serif">',
               f'<rect width="100%" height="100%" fill="white"/>',
               f'<text x="{M}" y="26" font-size="19" font-weight="700" fill="#111">Sơ đồ hàn · board {W:g} × {H:g} mm · {"mặt sau" if back else "mặt trước"}</text>']
        for i, ln in enumerate(wrap(sw_text['back' if back else 'front'], int(width / 6.4))):
            svg.append(f'<text x="{M}" y="{46 + i * 15}" font-size="12" fill="#444">{html.escape(ln)}</text>')
        svg += els
        for i, (key, ln) in enumerate(rows):
            y = y0 + 20 * i
            if key in SOLDER_COLORS:
                svg.append(f'<rect x="{M}" y="{y - 11}" width="14" height="14" rx="2" fill="{SOLDER_COLORS[key]}" stroke="#222" stroke-width="0.8"/>')
            elif key == 'note':
                svg.append(f'<text x="{M}" y="{y}" font-size="12" fill="#c92a2a">•</text>')
            svg.append(f'<text x="{M + 24}" y="{y}" font-size="12" fill="#222">{html.escape(ln)}</text>')
        svg.append('</svg>')
        name = out / ('solder_back' if back else 'solder_front')
        name.with_suffix('.svg').write_text('\n'.join(svg))
        if chrome:
            subprocess.run([chrome, '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
                            f'--window-size={width:.0f},{height:.0f}', f'--screenshot={name}.png', f'file://{name}.svg'], check=True, capture_output=True)
        print(name.with_suffix('.png'))
    # every polarity marker must sit on the pad the schematic says it is
    want = {'C_GATE': '/VBAT_AON', 'CRES': '/3V3_SW', 'DBOOST': '/3V3_SW', 'JBAT': '/M1_BATTERY_MAIN_SWITCH/VBAT_RAW'} | {f'DWAKE{i}': '/WAKE_NODE' for i in range(4)}
    seen = {(r, q['net']) for r, role, q in marks}
    for ref, net in want.items():
        assert (ref, net) in seen, f'{ref}: polarity marker is not on the {net} pad'


def main():
    {'place': place, 'route': route, 'finish': finish, 'pour': pour, 'gerber': gerber, 'solder': solder}[sys.argv[1]](*sys.argv[2:])


if __name__ == '__main__':
    main()
