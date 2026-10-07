"""Build the compact 52 x 90 mm board in quiz_remote_compact/ from its schematic.

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

ROOT = Path(__file__).resolve().parents[1]
PRJ = ROOT / 'quiz_remote_compact'
BOARD = PRJ / 'quiz_remote.kicad_pcb'
DSN, SES = PRJ / 'route' / 'quiz_remote.dsn', PRJ / 'route' / 'quiz_remote.ses'
PLACED = PRJ / 'route' / 'placed_unrouted.kicad_pcb'   # finish always starts from this, never from a routed board
# folder holding freerouting-*.jar and a jre25/ runtime; only the route stage needs it
FREEROUTING = Path(os.environ.get('FREEROUTING_DIR', ROOT / 'quiz_remote/validation/M12/autorouter_eval/freerouting'))
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


def main():
    {'place': place, 'route': route, 'finish': finish, 'pour': pour, 'gerber': gerber}[sys.argv[1]](*sys.argv[2:])


if __name__ == '__main__':
    main()
