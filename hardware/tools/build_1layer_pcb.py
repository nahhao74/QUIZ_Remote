"""Build the single-sided board in single-layer/ from its schematic.

Stages (run in order):  place  ->  route  ->  finish     (same machinery as build_compact_pcb.py)

Copper is on the back only. Through-hole parts (keys, displays, ESP32 sockets) sit on the front,
SMD parts on the back. Anything the router puts on F.Cu is a wire jumper between two drilled pads.
Each key's two same-numbered pins are joined inside the switch, so a row runs "through" its keys
and the column lines cross it there without a jumper.
"""
import re
import sys

import pcbnew as pcb

import build_compact_pcb as B

B.PRJ = B.ROOT / 'single-layer'
B.BOARD = B.PRJ / 'quiz_remote.kicad_pcb'
B.DSN, B.SES = B.PRJ / 'route' / 'quiz_remote.dsn', B.PRJ / 'route' / 'quiz_remote.ses'
B.PLACED = B.PRJ / 'route' / 'placed_unrouted.kicad_pcb'
RULES_FILE = B.PRJ / 'route' / 'quiz_remote.rules'
K = 1.25                                             # spread factor: more room between parts means fewer jumpers
B.W, B.H = 60.0 * K, 107.0 * K
B.TITLE = 'Quiz remote single-sided %gx%g' % (B.W, B.H)
B.RULES = (0.3, 0.2, 1.2, 0.6, 0.8, 1.2, 0.6)      # 0.3 mm tracks still pass between 2.54 mm pins; jumper holes 0.6 mm
# Ground and 3V3 reach almost every part; routed thin they leave room for the rest, and the pour carries the ground current.
B.POWER = ['/VBAT_AON', '/VIN_BOOST', '/M1_BATTERY_MAIN_SWITCH/VBAT_RAW', '/M3_BOOST_3V3/SW_NODE']
B.TP_FRONT = False
B.UNTENT_VIAS = True                                 # the vias are jumper holes: they must be solderable
B.GERBER_LAYERS = 'B.Cu,B.Mask,B.Paste,F.Silkscreen,B.Silkscreen,Edge.Cuts'   # F.Cu holds the wire jumpers, never fabricate it
B.HOLE_KEEPOUT_R = None
B.HOLE_COPPER_R = 4.0                                # M3 screw head or a 7 mm washer stays clear of all copper
B.HOLE, B.HOLES = 'MountingHole_3.2mm_M3', [(6.25, 13.25), (66.5, 8.5), (4.75, 129.0), (71.0, 129.75)]
B.POUR_LAYERS = (pcb.B_Cu,)
B.ZONE_CONN = pcb.ZONE_CONNECTION_FULL              # tracks squeeze the thermal spokes on a single layer
B.ROUTE_ARGS = ['-dr', str(RULES_FILE), '--router.fanout.enabled=false']

KX = [11.5, 24.2, 36.9, 49.6]                         # unscaled; layout() multiplies everything by K
KY = [64.0, 76.7, 89.4, 102.1]
J2X, PIN15 = 31.1 * K, 43.56 * K - 35.56               # the sockets keep their real size: 25.4 mm apart, 35.56 mm long
ROWNET = '/M5_KEYPAD_4X4/ROW'


def layout():
    P = {}
    for i in range(16):
        r, c = divmod(i, 4)
        P[f'SW{i + 1}'] = (KX[c], KY[r], 0, True)
    # ESP32 on the front, right half, antenna end (pin 15) up. J2 carries the display signals and faces the displays.
    P['J2'], P['J1'] = (31.1, 43.56, 180, True), (56.5, 43.56, 180, True)
    P['JBAT'], P['SW_MAIN'] = (5.0, 4.5, 0, True), (18.0, 4.4, 0, True)
    P['DS1'], P['DS2'] = (9.0, 20.0, 0, True), (20.0, 20.0, 0, True)
    P['CRES'] = (24.5, 44.5, 0, True)
    back = {
        # power gate, wake, hold: top of the strip between the two socket rows
        'QPWR': (36.5, 10.5, 0), 'C_GATE': (41.5, 9, 0), 'R_GATE': (41.5, 12, 0),
        'QHOLD': (47, 9, 0), 'R_HOLD': (51.3, 8, 0), 'R_HOLD_PD': (51.3, 10.5, 0),
        'QWAKE': (47, 13.6, 0), 'R_WAKE': (51.3, 13, 0), 'R_WAKE_PD': (51.3, 15.3, 0),
        # boost converter below it; a fourth item (pad, x, y) picks the rotation that brings that pad closest to the point
        'CIN1': (37, 18.5, 0, ('1', 40, 17)), 'CIN2': (37, 23.5, 90), 'L1': (45.5, 22.5, 90, ('2', 45.5, 28)),
        'U1': (45.5, 31.3, 0, ('1', 45.5, 29)), 'DBOOST': (45, 37.3, 0, ('2', 41, 33)),
        'RFB1': (40.3, 30, 0, ('2', 43, 30)), 'RFB4': (40.3, 33, 0, ('1', 43, 33)),
        'COUT1': (38, 42.8, 0, ('1', 41, 41)), 'COUT2': (50.5, 42.8, 0),
        # shift register, segment resistors, digit switches: under the displays
        'U2': (14, 37.5, 0), 'C_U2': (20, 32.5, 0), 'QDIG1': (3.5, 34, 0), 'RGP1': (3.5, 38, 0),
        'QDIG2': (20, 37, 0), 'RGP2': (20, 41, 0),
        'RDATA_PD': (8.5, 43, 0), 'RCLK_PD': (8.5, 46, 0), 'RLATCH_PD': (14, 46, 0), 'ROE': (3.5, 42, 90),
    }
    for i, s in enumerate(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'DP']):
        back['RSEG_' + s] = (3.0 + 3.2 * i, 28.6, 90)
    # keypad drivers in the strip between the sockets and the first key row
    for r in range(4):
        x = 3.5 + 14.5 * r
        back.update({f'QROW{r}': (x, 50.5, 0), f'RBASE{r}': (x + 4, 49.4, 0), f'RBASE_PD{r}': (x + 4, 51.7, 0), f'RROW{r}': (x + 7.6, 50.5, 90)})
    for c in range(4):
        x = KX[c]
        back.update({f'QCOL{c}': (x - 3.2, 56.6, 0), f'DWAKE{c}': (x + 1.6, 55.3, 0), f'RCOL{c}': (x + 1.6, 57.8, 0), f'RSENSE{c}': (x + 5.2, 56.6, 90)})
    for ref, a in back.items():
        P[ref] = (a[0], a[1], a[2], False, *a[3:])
    # spread everything by K, except the block between the socket rows, which moves with the sockets
    for ref, (x, y, *rest) in P.items():
        if 32 < x < 55 and y < 44 and not rest[1]:
            f = lambda px, py: (J2X + px - 31.1, PIN15 + py - 8.0)
        else:
            f = lambda px, py: (px * K, py * K)
        aim = [(rest[2][0], *f(*rest[2][1:]))] if len(rest) > 2 else []
        P[ref] = (*f(x, y), rest[0], rest[1], *aim)
    P['J2'], P['J1'] = (J2X, PIN15 + 35.56, 180, True), (J2X + 25.4, PIN15 + 35.56, 180, True)
    return P


def tp_slots(fps):
    """Free back-side spots for the 1.5 mm test pads: a grid, minus everything already placed and the routing lanes."""
    boxes = []
    for f in fps.values():
        if f.GetPosition().x:                           # placed so far (test pads still sit at the origin)
            bb = f.GetBoundingBox(False)
            boxes.append((pcb.ToMM(bb.GetCenter().x) - B.OX, pcb.ToMM(bb.GetCenter().y) - B.OY, pcb.ToMM(bb.GetWidth()) / 2, pcb.ToMM(bb.GetHeight()) / 2))
    def free(x, y):
        if y < 7 or (y > 60 * K and (x < 8 * K or min(abs(x - k * K) for k in KX) < 4.6)):   # top power lane, row feeders, key pin boxes
            return False
        return all(abs(x - px) > hx + 1.3 or abs(y - py) > hy + 1.3 for px, py, hx, hy in boxes)
    return [(x, y) for x in [2.0 + 2.6 * i for i in range(int(B.W / 2.6))] for y in [2.5 + 2.6 * j for j in range(int(B.H / 2.6))] if free(x, y)]


def check_sockets(fps):
    for j in ('J1', 'J2'):
        y = {p.GetNumber(): pcb.ToMM(p.GetPosition().y) - B.OY for p in fps[j].Pads()}
        assert abs(y['1'] - PIN15 - 35.56) < 0.01 and abs(y['15'] - PIN15) < 0.01, (j, y['1'], y['15'])


def tweak(b, fps):
    for i in range(16):
        fps[f'SW{i + 1}'].SetDuplicatePadNumbersAreJumpers(True)   # KiCad then treats the pin pair as connected


B.layout, B.tp_slots, B.check_sockets, B.TWEAK = layout, tp_slots, check_sockets, tweak


def place():
    B.place()
    # Tell the router about the link inside each key: split every row net into a chain
    # driver -> key0.left | key0.right -> key1.left | ... so no copper is drawn across a key.
    s = B.DSN.read_text()
    for r in range(4):
        net = f'{ROWNET}{r}'
        m = re.search(r'\(net %s\s*\(pins ([^)]*)\)\s*\)' % re.escape(net), s)
        pins = m.group(1).split()
        sw = lambda c, right: f'SW{4 * r + c + 1}-1' + ('@1' if right else '')
        keep = [p for p in pins if not p.startswith('SW')] + [sw(0, False)]
        blocks = [f'(net {net}\n      (pins {" ".join(keep)})\n    )']
        blocks += [f'(net {net}~{c}\n      (pins {sw(c - 1, True)} {sw(c, False)})\n    )' for c in (1, 2, 3)]
        s = s.replace(m.group(0), '\n    '.join(blocks))
        s = re.sub(r'(\(class [^()]*?)%s(?=[\s)])' % re.escape(net), lambda k: k.group(1) + ' '.join([net] + [f'{net}~{c}' for c in (1, 2, 3)]), s, flags=re.S)
    # Columns: one pad per key is enough, the second one is the same pin inside the switch.
    s = re.sub(r' SW\d+-2@1', '', s)
    # Keepouts: no front wires across the keypad (rows and columns fit on the back there), and no copper
    # right next to the slide switch's mounting holes, whose clearance the router does not know.
    um = lambda x, y: '%d %d' % ((B.OX + x) * 1000, -(B.OY + y) * 1000)
    keep = ['(keepout "" (rect F.Cu %s %s))' % (um(0, B.H), um(B.W, KY[0] * K - 4.5))]
    for pad in (p for p in pcb.LoadBoard(str(B.PLACED)).FindFootprintByReference('SW_MAIN').Pads() if not p.GetNumber()):
        x, y = pcb.ToMM(pad.GetPosition().x) - B.OX, pcb.ToMM(pad.GetPosition().y) - B.OY
        keep += ['(keepout "" (rect %s %s %s))' % (l, um(x - 1.6, y + 1.3), um(x + 1.6, y - 1.3)) for l in ('F.Cu', 'B.Cu')]
    assert '    (via ' in s
    s = s.replace('    (via ', ''.join('    %s\n' % k for k in keep) + '    (via ', 1)
    B.DSN.write_text(s)


RULES = """(rules PCB quiz_remote
  (snap_angle fortyfive_degree)
  (autoroute_settings
    (fanout off) (autoroute on) (postroute on) (vias on)
    (via_costs %d) (plane_via_costs 5) (start_ripup_costs %d) (start_pass_no 1)
    (layer_rule F.Cu (active %s) (preferred_direction horizontal) (preferred_direction_trace_costs 50.0) (against_preferred_direction_trace_costs 50.0))
    (layer_rule B.Cu (active on) (preferred_direction vertical) (preferred_direction_trace_costs 1.0) (against_preferred_direction_trace_costs 1.0))
  )
)
"""


def route(passes='100'):
    RULES_FILE.write_text(RULES % (150, 100, 'on'))    # a layer change is a hand-soldered wire: make it expensive
    B.route(passes)


def finish():
    B.SES.write_text(re.sub(re.escape(ROWNET) + r'(\d)~\d', ROWNET + r'\1', B.SES.read_text()))
    B.finish()


def jumpers():
    """List the wire jumpers (connected groups of front tracks) and draw them: route/jumpers.svg, seen from the front."""
    b = pcb.LoadBoard(str(B.BOARD))
    xy = lambda v: (pcb.ToMM(v.x) - B.OX, pcb.ToMM(v.y) - B.OY)
    groups = []
    for t in b.GetTracks():
        if isinstance(t, pcb.PCB_VIA) or t.GetLayer() != pcb.F_Cu:
            continue
        g = {'pts': {xy(t.GetStart()), xy(t.GetEnd())}, 'segs': [(xy(t.GetStart()), xy(t.GetEnd()))], 'net': t.GetNetname(), 'len': pcb.ToMM(t.GetLength())}
        for h in [h for h in groups if h['pts'] & g['pts']]:
            groups.remove(h); g['pts'] |= h['pts']; g['segs'] += h['segs']; g['len'] += h['len']
        groups.append(g)
    pads = {xy(p.GetPosition()): f'{f.GetReference()} chân {p.GetNumber()}' for f in b.GetFootprints() for p in f.Pads() if p.HasHole() and p.GetNumber()}
    for g in groups:                                   # a wire ends where only one front segment arrives
        ends = [q for q in g['pts'] if sum(q in s for s in g['segs']) == 1]
        g['ends'] = sorted(ends, key=lambda q: (q[1], q[0]))
    groups.sort(key=lambda g: (g['ends'][0][1], g['ends'][0][0]))
    colors = ['#d62728', '#1f77b4', '#2ca02c', '#9467bd', '#ff7f0e', '#17becf', '#8c564b', '#e377c2']
    S = 8                                              # pixels per mm
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-3 -3 {B.W + 82} {B.H + 6}" width="{(B.W + 82) * S}" height="{(B.H + 6) * S}" font-family="sans-serif">',
         f'<rect x="-3" y="-3" width="{B.W + 82}" height="{B.H + 6}" fill="white"/><rect width="{B.W}" height="{B.H}" fill="#f4f1e6" stroke="black" stroke-width="0.3"/>']
    for f in b.GetFootprints():                        # through-hole parts and their pins, for orientation
        holes = [xy(p.GetPosition()) for p in f.Pads() if p.HasHole()]
        if holes:
            xs, ys = [h[0] for h in holes], [h[1] for h in holes]
            o.append(f'<rect x="{min(xs) - 1.4:.2f}" y="{min(ys) - 1.4:.2f}" width="{max(xs) - min(xs) + 2.8:.2f}" height="{max(ys) - min(ys) + 2.8:.2f}" fill="#e3ded0" stroke="#999" stroke-width="0.15"/>')
            o.append(f'<text x="{sum(xs) / len(xs):.2f}" y="{sum(ys) / len(ys) + 0.8:.2f}" font-size="2" fill="#777" text-anchor="middle">{f.GetReference()}</text>')
            o += [f'<circle cx="{x:.2f}" cy="{y:.2f}" r="0.5" fill="#aaa"/>' for x, y in holes]
    rows = []
    for i, g in enumerate(groups, 1):
        c = colors[i % len(colors)]
        o += [f'<line x1="{a[0]:.2f}" y1="{a[1]:.2f}" x2="{e[0]:.2f}" y2="{e[1]:.2f}" stroke="{c}" stroke-width="0.6" stroke-linecap="round"/>' for a, e in g['segs']]
        for x, y in g['ends']:
            o.append(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="0.9" fill="{c}" stroke="black" stroke-width="0.15"/>')
            o.append(f'<text x="{x:.2f}" y="{y + 0.55:.2f}" font-size="1.5" fill="white" text-anchor="middle" font-weight="bold">{i}</text>')
        name = g['net'].split('/')[-1]
        where = ' → '.join(pads.get(q, 'lỗ dây nhảy') + f' ({q[0]:.0f}, {q[1]:.0f})' for q in g['ends'])
        rows.append((i, c, name, g['len'], where))
        print(f"  {i:>2}  {name:<14} {g['len'] + 6:5.0f} mm   {where}")
    o.append(f'<text x="{B.W + 3}" y="1" font-size="2.4" font-weight="bold">Dây nhảy, nhìn từ mặt linh kiện (mặt trước)</text>')
    o.append(f'<text x="{B.W + 3}" y="4" font-size="1.6">Luồn dây ở mặt trước, hàn hai đầu ở mặt đồng. Chấm tròn có số = đầu dây.</text>')
    o.append(f'<text x="{B.W + 3}" y="6" font-size="1.6">Dây có 3 đầu là dây chia nhánh. Chiều dài cắt đã cộng 6 mm để hàn.</text>')
    for k, (i, c, name, ln, where) in enumerate(rows):
        y = 10 + k * 3.1
        o.append(f'<circle cx="{B.W + 4}" cy="{y - 0.6}" r="1" fill="{c}"/><text x="{B.W + 4}" y="{y}" font-size="1.5" fill="white" text-anchor="middle" font-weight="bold">{i}</text>')
        o.append(f'<text x="{B.W + 6.5}" y="{y}" font-size="1.8">{name} · cắt dây {ln + 6:.0f} mm</text><text x="{B.W + 6.5}" y="{y + 1.4}" font-size="1.2" fill="#555">{where}</text>')
    out = B.PRJ / 'route' / 'jumpers.svg'
    out.write_text('\n'.join(o) + '</svg>\n')
    print(len(groups), 'jumpers, total', round(sum(g['len'] for g in groups)), 'mm;',
          sum(isinstance(t, pcb.PCB_VIA) for t in b.GetTracks()), 'jumper holes; drawing at', out)


if __name__ == '__main__':
    {'place': place, 'route': route, 'finish': finish, 'pour': B.pour, 'jumpers': jumpers, 'gerber': B.gerber, 'solder': B.solder}[sys.argv[1]](*sys.argv[2:])
