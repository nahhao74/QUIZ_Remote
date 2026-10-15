"""SPICE check of the power chain: key press -> wake -> 3V3 -> ESP32 holds -> release -> off.

Uses the libngspice that ships with KiCad (no separate ngspice install needed):
    python3 tools/sim_wake_hold.py

Models are generic (2N3904, 1N4148, level-1 MOSFETs fitted to datasheet typicals), the boost
converter and the ESP32 are behavioural. This checks the principle and the timing margins,
not ripple, RF bursts or part-to-part spread.
"""
import ctypes as C

CIRCUIT = """quiz remote wake / hold / power gate
.param vbat={vbat} trel={trel} tboot={tboot} toff=1.6
Vbat  bat 0 {{vbat}}
Rbat  bat vaon 0.4
* key: one row pulled up by RROW, one column, closed from 0.1 s to trel
Rrow  vaon row 22k
Vkey  kctl 0 PULSE(0 1 0.1 1m 1m {{trel-0.1}} 10)
Skey  row col kctl 0 SW
Rcol  col 0 470k
Dwake col wake D4148
Rwake wake bw 100k
Rwpd  bw 0 1Meg
Qwake gate bw 0 Q3904
* P-MOSFET power switch with its gate RC
Rgate vaon gate 220k
Cgate vaon gate 4.7u
Mpwr  vin gate vaon vaon PAO3401
* boost converter and module, behavioural: 3.37 V out once the input is above 2 V, about 150 mA load
Rload vin 0 20
Bbst  v33x 0 V = V(vin) > 2.0 ? 3.37 : 0
Rbst  v33x v33 1
Cres  v33 0 470u
* ESP32: raises PWR_HOLD tboot after 3V3 appears, drops it at toff
Bboot bt 0 V = V(v33) > 3.0 ? 1 : 0
Rboot bt btd {{tboot/0.693}}
Cboot btd 0 1
Voff  offc 0 PULSE(1 0 {{toff}} 1m 1m 10 20)
Bhold hold 0 V = (V(btd) > 0.5 ? V(v33) : 0) * V(offc)
Rhold hold bh 10k
Rhpd  bh 0 100k
Qhold gate bh 0 Q3904
* column read-back: BSS138 pulls COL_ADC low while a key holds the column high
Rsense v33 coladc 100k
Mcol  coladc col 0 0 NBSS138
.model SW SW(Ron=0.1 Roff=1G Vt=0.5 Vh=0.1)
.model D4148 D(Is=2.52n Rs=0.568 N=1.752 Cjo=4p Tt=20n)
.model Q3904 NPN(Is=6.734f Bf=200 Vaf=74 Ikf=66.78m Ise=6.734f Ne=1.26 Br=0.74 Rb=10 Rc=1 Cjc=3.6p Cje=4.5p Tf=301p)
.model PAO3401 PMOS(Level=1 Vto=-0.9 Kp=4.6 Lambda=0.01)
.model NBSS138 NMOS(Level=1 Vto=1.1 Kp=0.5 Lambda=0.01)
.tran 1m 4 uic
.end
"""


class Vec(C.Structure):
    _fields_ = [('name', C.c_char_p), ('type', C.c_int), ('flags', C.c_short), ('real', C.POINTER(C.c_double)),
                ('comp', C.c_void_p), ('length', C.c_int)]


def run(vbat=3.0, trel=0.3, tboot=0.3):
    ng = C.CDLL('libngspice.so.0')
    cb = lambda *t: C.CFUNCTYPE(*t)(lambda *a: 0)
    keep = [cb(C.c_int, C.c_char_p, C.c_int, C.c_void_p), cb(C.c_int, C.c_char_p, C.c_int, C.c_void_p),
            cb(C.c_int, C.c_int, C.c_bool, C.c_bool, C.c_int, C.c_void_p), cb(C.c_int, C.c_void_p, C.c_int, C.c_int, C.c_void_p),
            cb(C.c_int, C.c_void_p, C.c_int, C.c_void_p), cb(C.c_int, C.c_bool, C.c_int, C.c_void_p)]
    ng.ngSpice_Init(*keep, None)
    lines = CIRCUIT.format(vbat=vbat, trel=trel, tboot=tboot).splitlines()
    arr = (C.c_char_p * (len(lines) + 1))(*[l.encode() for l in lines], None)
    assert ng.ngSpice_Circ(arr) == 0, 'netlist rejected'
    assert ng.ngSpice_Command(b'run') == 0, 'simulation failed'
    ng.ngGet_Vec_Info.restype = C.POINTER(Vec)
    def vec(name):
        v = ng.ngGet_Vec_Info(name.encode()).contents
        return [v.real[i] for i in range(v.length)]
    return {n: vec(n) for n in ('time', 'gate', 'vin', 'v33', 'hold', 'coladc', 'col', 'vaon')} | {'ibat': vec('vbat#branch')}


def report(vbat, trel, tboot):
    r = run(vbat, trel, tboot)
    t = r['time']
    at = lambda name, when: r[name][min(range(len(t)), key=lambda i: abs(t[i] - when))]
    first = lambda name, pred, start=0.0: next((t[i] for i in range(len(t)) if t[i] >= start and pred(r[name][i])), None)
    on = first('v33', lambda v: v > 3.0)
    off = first('v33', lambda v: v < 1.0, 1.6)
    held = min(r['v33'][i] for i in range(len(t)) if on and on + 0.01 < t[i] < 1.6)
    print(f"pin {vbat:.1f} V, nha phim sau {int((trel - 0.1) * 1000)} ms, ESP32 khoi dong {int(tboot * 1000)} ms:")
    print(f"   dong nghi truoc khi bam      : {abs(at('ibat', 0.05)) * 1e6:.2f} uA")
    print(f"   3V3 len sau khi bam          : {(on - 0.1) * 1000:.0f} ms" if on else '   3V3 KHONG len')
    print(f"   COL_ADC luc dang giu phim    : {at('coladc', (0.1 + trel) / 2 + 0.01):.2f} V   (thap = co phim)")
    print(f"   3V3 thap nhat khi dang chay  : {held:.2f} V   ({'GIU DUOC' if held > 3.0 else 'MAT NGUON'})")
    vgs = min(r['vaon'][i] - r['gate'][i] for i in range(len(t)) if on and on + 0.01 < t[i] < 1.6)
    print(f"   |VGS| nho nhat cua QPWR      : {vgs:.2f} V   (nguong mo cua AO3401A toi da 1.3 V)")
    print(f"   3V3 tat sau khi nha PWR_HOLD : {(off - 1.6) * 1000:.0f} ms" if off else '   3V3 KHONG tat')
    print(f"   dong nghi sau khi tat        : {abs(at('ibat', 3.95)) * 1e6:.2f} uA")
    return held > 3.0 and off is not None


if __name__ == '__main__':
    import multiprocessing as mp      # libngspice keeps global state: one fresh process per case
    cases = [(3.0, 0.3, 0.3), (3.0, 0.15, 0.3), (2.4, 0.15, 0.3), (2.4, 0.15, 0.6)]
    with mp.get_context('spawn').Pool(1, maxtasksperchild=1) as pool:
        ok = [pool.apply(report, c) for c in cases]
        print('--- truong hop co y lam hong: ESP32 khoi dong qua cham (1.5 s) sau mot lan bam nhanh')
        limit = pool.apply(report, (2.4, 0.15, 1.5))
    print('KET QUA:', 'tat ca truong hop deu giu duoc nguon va tat duoc' if all(ok) else 'co truong hop HONG, xem tren')
    print('         truong hop khoi dong 1.5 s:', 'van giu duoc' if limit else 'mat nguon nhu du doan (mo phong bat duoc loi)')
