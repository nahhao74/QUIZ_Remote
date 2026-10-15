import { useEffect, useRef, useState, type FormEvent } from 'react';
import mqtt, { type MqttClient } from 'mqtt';
import { topics, type Ack, type AnswerMessage, type JoinMessage, type RoomState } from '@classpulse/mqtt-contracts';
import { applyKey, displayFrame, initialKeypad, isRoomState, KEYPAD, nextSequence, type KeypadState } from './logic';
import './simulator.css';

type Connection = 'connecting' | 'online' | 'offline';
type Settings = { deviceId: string; url: string; username: string; password: string };
type Log = { id: string; time: string; text: string; kind: 'success' | 'error' | 'info' };
type Pending = { topic: string; payload: JoinMessage | AnswerMessage; attempts: number; timer?: ReturnType<typeof setTimeout>; started: number };
const env = import.meta.env;
const ACK_TIMEOUT = 4000;
const MAX_ATTEMPTS = 3;
const DIGITS: Record<string, string> = { '0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg', '5': 'acdfg', '6': 'acdefg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg', A: 'abcefg', B: 'cdefg', C: 'adef', D: 'bcdeg', E: 'adefg', F: 'aefg', L: 'def', P: 'abefg', U: 'bcdef', '-': 'g', ' ': '' };
const SEGMENTS = [
  ['a', '16,8 54,8 61,15 54,22 16,22 9,15'], ['b', '57,25 64,18 64,57 57,64 50,57 50,32'],
  ['c', '57,69 64,76 64,115 57,122 50,115 50,76'], ['d', '16,118 54,118 61,125 54,132 16,132 9,125'],
  ['e', '7,69 14,76 14,115 7,122 0,115 0,76'], ['f', '7,18 14,25 14,57 7,64 0,57 0,25'],
  ['g', '16,63 48,63 55,70 48,77 16,77 9,70'],
];
function SegmentDigit({ char, dot }: { char: string; dot: boolean }) {
  const active = DIGITS[char] || DIGITS['-'];
  return <svg className="sim-digit" viewBox="-4 0 90 142" aria-hidden="true">{SEGMENTS.map(([segment, points]) => <polygon key={segment} points={points} className={active.includes(segment) ? 'sim-segment-on' : 'sim-segment-off'} />)}<circle cx="77" cy="125" r="7" className={dot ? 'sim-segment-on' : 'sim-segment-off'} /></svg>;
}
function initialSettings(): Settings {
  // A newly opened tab receives its own identity, even if the opener copied sessionStorage.
  const isReload = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type === 'reload';
  const saved = isReload ? sessionStorage.getItem('classpulse.simulator.deviceId') : null;
  const deviceId = saved || `sim-${crypto.randomUUID().slice(0, 12)}`;
  sessionStorage.setItem('classpulse.simulator.deviceId', deviceId);
  return { deviceId, url: env.VITE_MQTT_WS_URL || 'ws://localhost:8083/mqtt', username: env.VITE_MQTT_USERNAME || env.VITE_MQTT_SIMULATOR_USERNAME || 'simulator', password: env.VITE_MQTT_PASSWORD || env.VITE_MQTT_SIMULATOR_PASSWORD || 'simulator-dev-only' };
}
function isAck(value: unknown): value is Ack {
  if (!value || typeof value !== 'object') return false;
  const a = value as Ack;
  return typeof a.requestId === 'string' && typeof a.success === 'boolean' && typeof a.code === 'string' && typeof a.message === 'string';
}
function stateLabel(state: RoomState | null) {
  return !state ? 'Đang chờ phòng' : ({ LOBBY: 'Chờ giáo viên bắt đầu', QUESTION_ACTIVE: 'Đang nhận câu trả lời', QUESTION_CLOSED: 'Câu hỏi đã đóng', FINISHED: 'Phiên học đã kết thúc' }[state.status]);
}
export function DeviceSimulator() {
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [draft, setDraft] = useState(settings);
  const [keypad, setKeypad] = useState<KeypadState>(initialKeypad);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [state, setState] = useState<RoomState | null>(null);
  const [logs, setLogs] = useState<Log[]>([]);
  const [pending, setPending] = useState(false);
  const [lastAck, setLastAck] = useState<Ack | null>(null);
  const [tick, setTick] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [serverOffset, setServerOffset] = useState(0);
  const clientRef = useRef<MqttClient | null>(null);
  const pendingRef = useRef(new Map<string, Pending>());
  const keypadRef = useRef(keypad);
  const roomRef = useRef(keypad.roomCode);
  keypadRef.current = keypad; roomRef.current = keypad.roomCode;
  function log(text: string, kind: Log['kind'] = 'info') {
    setLogs(old => [{ id: crypto.randomUUID(), time: new Date().toLocaleTimeString('vi-VN'), text, kind }, ...old].slice(0, 12));
  }
  function clearRequests() {
    pendingRef.current.forEach(p => clearTimeout(p.timer)); pendingRef.current.clear(); setPending(false);
  }
  function sendAttempt(request: Pending) {
    const client = clientRef.current;
    request.attempts++;
    if (client?.connected) client.publish(request.topic, JSON.stringify(request.payload), { qos: 1, retain: false }, error => {
      if (error) log(`MQTT: ${error.message}`, 'error');
    });
    request.timer = setTimeout(() => {
      if (!pendingRef.current.has(request.payload.requestId)) return;
      if (request.attempts < MAX_ATTEMPTS) {
        log(`Chưa có ACK · thử lại ${request.attempts + 1}/${MAX_ATTEMPTS} với cùng requestId`);
        sendAttempt(request);
      } else {
        pendingRef.current.delete(request.payload.requestId); setPending(pendingRef.current.size > 0);
        log('Hết thời gian chờ ACK. Chưa xác nhận kết quả; bạn có thể gửi lại khi kết nối ổn định.', 'error');
      }
    }, ACK_TIMEOUT);
  }
  function publishRequest(topic: string, payload: JoinMessage | AnswerMessage) {
    const request: Pending = { topic, payload, attempts: 0, started: Date.now() };
    pendingRef.current.set(payload.requestId, request); setPending(true); sendAttempt(request);
  }
  useEffect(() => {
    let disposed = false;
    setConnection('connecting');
    const client = mqtt.connect(settings.url, { clientId: settings.deviceId, username: settings.username, password: settings.password, clean: true, reconnectPeriod: 2000, connectTimeout: 8000, queueQoSZero: false });
    clientRef.current = client;
    client.on('connect', () => {
      client.subscribe([topics.ack(settings.deviceId), topics.command(settings.deviceId)], { qos: 1 }, error => {
        if (disposed) return;
        if (error) { setConnection('offline'); log(`Không thể đăng ký ACK: ${error.message}`, 'error'); return; }
        const room = roomRef.current;
        if (room) client.subscribe([topics.state(room), topics.question(room)], { qos: 1 });
        setConnection('online'); log(`MQTT đã kết nối · ${settings.deviceId}`, 'success');
      });
    });
    client.on('reconnect', () => { if (!disposed) setConnection('connecting'); });
    client.on('offline', () => { if (!disposed) setConnection('offline'); });
    client.on('close', () => { if (!disposed) setConnection('offline'); });
    client.on('error', error => { if (!disposed) log(`Kết nối broker: ${error.message}`, 'error'); });
    client.on('message', (topic, payload, packet) => {
      if (disposed) return;
      let message: unknown;
      try { message = JSON.parse(payload.toString()); } catch { log('Bỏ qua message không phải JSON.', 'error'); return; }
      if (topic === topics.ack(settings.deviceId) && isAck(message)) {
        const request = pendingRef.current.get(message.requestId);
        if (!request) return;
        clearTimeout(request.timer); pendingRef.current.delete(message.requestId); setPending(pendingRef.current.size > 0);
        setLastAck(message);
        log(`${message.code} · ${message.message} · ${Date.now() - request.started} ms`, message.success ? 'success' : 'error');
        if (message.success && 'studentCode' in request.payload) {
          const { roomCode, studentCode } = request.payload;
          setKeypad({ ...initialKeypad, step: 'ready', roomCode, studentCode });
        }
      } else if ((topic === topics.state(roomRef.current) || topic === topics.question(roomRef.current)) && isRoomState(message)) {
        setState(old => {
          if (old && Date.parse(old.serverTimestamp) > Date.parse(message.serverTimestamp)) return old;
          return message;
        });
        // Retained timestamps can be old. Only use fresh publications to estimate clock skew.
        const delta = Date.parse(message.serverTimestamp) - Date.now();
        if (!packet.retain && Math.abs(delta) < 60000) setServerOffset(delta);
      }
    });
    return () => { disposed = true; clearRequests(); clientRef.current = null; client.end(true); };
  }, [settings]);
  useEffect(() => {
    if (!keypad.roomCode || connection !== 'online') return;
    const client = clientRef.current;
    const subscriptions = [topics.state(keypad.roomCode), topics.question(keypad.roomCode)];
    client?.subscribe(subscriptions, { qos: 1 }, error => { if (error) log(`Không thể nhận trạng thái phòng: ${error.message}`, 'error'); });
    return () => { if (client?.connected) client.unsubscribe(subscriptions); };
  }, [keypad.roomCode, connection]);
  useEffect(() => { const timer = setInterval(() => { setTick(t => t + 1); setNow(Date.now()); }, 700); return () => clearInterval(timer); }, []);
  useEffect(() => { setKeypad(old => ({ ...old, selected: null })); }, [state?.currentQuestion?.id]);
  const remaining = state?.questionEndsAt ? Math.max(0, Math.ceil((Date.parse(state.questionEndsAt) - now - serverOffset) / 1000)) : 0;
  const active = state?.status === 'QUESTION_ACTIVE' && remaining > 0;
  const multiple = state?.currentQuestion?.type === 'MULTIPLE';
  function keyPress(key: string) {
    if (key !== 'Confirm') { setKeypad(current => applyKey(current, key, multiple)); setTick(0); return; }
    if (pending) return;
    if (keypad.step === 'room') {
      if (keypad.entry.length !== 6) { log('Nhập đủ 6 chữ số của mã phòng.', 'error'); return; }
      setKeypad(current => applyKey(current, key)); setTick(0); return;
    }
    if (connection !== 'online') { log('Đợi kết nối MQTT trước khi gửi.', 'error'); return; }
    const base = { requestId: crypto.randomUUID(), deviceId: settings.deviceId, roomCode: keypad.roomCode, clientTimestamp: new Date().toISOString() };
    if (keypad.step === 'student') {
      if (!/^\d{2}$/.test(keypad.entry)) { log('Mã sinh viên phải có đúng 2 chữ số.', 'error'); return; }
      publishRequest(topics.join(settings.deviceId), { ...base, studentCode: keypad.entry });
      log(`Gửi yêu cầu tham gia phòng ${keypad.roomCode} · QoS 1`); return;
    }
    if (!active || !state?.currentQuestion) { log('Phòng chưa mở câu hỏi hoặc đã hết giờ.', 'error'); return; }
    if (!keypad.selected) { log(multiple ? 'Chọn một hoặc nhiều phương án A–D rồi nhấn Confirm.' : 'Chọn A, B, C hoặc D rồi nhấn Confirm.', 'error'); return; }
    const sequence = nextSequence(localStorage, settings.deviceId, state.currentQuestion.id);
    publishRequest(topics.answer(settings.deviceId), { ...base, questionId: state.currentQuestion.id, answer: keypad.selected, sequence });
    log(`Gửi đáp án ${keypad.selected} · sequence ${sequence} · QoS 1`);
  }
  function reconnect(event: FormEvent) {
    event.preventDefault();
    if (!/^[a-zA-Z0-9_-]{3,64}$/.test(draft.deviceId)) { log('deviceId phải có 3–64 ký tự chữ, số, dấu - hoặc _.', 'error'); return; }
    if (!/^wss?:\/\//.test(draft.url)) { log('Broker trên trình duyệt phải dùng ws:// hoặc wss://.', 'error'); return; }
    clearRequests(); setState(null); setLastAck(null); setKeypad(initialKeypad);
    sessionStorage.setItem('classpulse.simulator.deviceId', draft.deviceId); setSettings({ ...draft });
  }
  const display = keypad.step !== 'ready' ? keypad.entry : keypad.selected || (active ? String((state?.currentQuestionIndex ?? 0) + 1).padStart(2, '0') : '--');
  const frame = displayFrame(display, tick);
  const stepText = keypad.step === 'room' ? 'Nhập mã phòng' : keypad.step === 'student' ? 'Nhập mã sinh viên' : keypad.selected ? `Đang chọn đáp án ${keypad.selected.split('').join(', ')}` : active && multiple ? 'Câu nhiều đáp án: chọn các phím A–D' : stateLabel(state);
  return <div className="sim-page">
    <div className="sim-heading"><div><div className="sim-eyebrow">PHÒNG THỰC HÀNH IOT</div><h1>Thiết bị giả lập</h1><p>Trải nghiệm trả lời bằng bàn phím vật lý, ngay trên trình duyệt.</p></div><span className="sim-protocol-tag">ESP32 <span>↔</span> MQTT</span></div>
    <div className="sim-workspace">
      <section className="sim-device-stage" aria-label="Thiết bị ESP32 giả lập">
        <div className="sim-device"><i className="sim-screw sim-screw-tl"/><i className="sim-screw sim-screw-tr"/><i className="sim-screw sim-screw-bl"/><i className="sim-screw sim-screw-br"/>
          <div className="sim-device-brand"><span>class<span>pulse</span></span><small>RESPONSE PAD / 01</small></div>
          <div className="sim-device-status"><span><i className={navigator.onLine ? 'is-on' : ''}/> Wi-Fi</span><span><i className={connection === 'online' ? 'is-on' : connection === 'connecting' ? 'is-wait' : ''}/> MQTT</span><span className="sim-device-model">ESP32 · 4×4</span></div>
          <div className="sim-led-well"><div className="sim-led" role="img" aria-label={`Màn hình hai ký tự: ${frame.trim() || 'trống'}`}><SegmentDigit char={frame[0]} dot={keypad.step === 'ready'}/><SegmentDigit char={frame[1]} dot={pending && tick % 2 === 0}/></div><div className="sim-led-caption">{stepText}</div></div>
          <div className="sim-keypad" aria-label="Bàn phím 4 nhân 4">{KEYPAD.map(key => <button key={key} type="button" className={`sim-key ${'ABCD'.includes(key) ? 'sim-key-choice' : ''} ${key === 'Confirm' ? 'sim-key-confirm' : ''} ${key === 'Xóa' ? 'sim-key-clear' : ''} ${keypad.selected?.includes(key) ? 'is-selected' : ''}`} onClick={() => keyPress(key)} disabled={key === 'Confirm' && pending} aria-pressed={'ABCD'.includes(key) ? !!keypad.selected?.includes(key) : undefined}>{key === 'Xóa' ? <><span>⌫</span><small>Xóa</small></> : key === 'Confirm' ? <><span>↵</span><small>Confirm</small></> : key}</button>)}</div>
          <div className="sim-device-footer"><span><i className={lastAck?.success ? 'is-on' : lastAck ? 'is-error' : ''}/> {pending ? 'ĐANG GỬI' : lastAck?.success ? 'ĐÃ NHẬN ACK' : lastAck ? 'KIỂM TRA ACK' : 'SẴN SÀNG'}</span><span>MQTT v1 · QoS 1</span></div>
        </div><div className="sim-hardware-note"><span>2 LED 7 đoạn</span><i/> <span>2 × 74HC595</span><i/> <span>16 phím vật lý</span></div>
      </section>
      <div className="sim-details">
        <section className="sim-card"><div className="sim-card-title"><h2>Kết nối thiết bị</h2><span className={`sim-badge ${connection}`}>{connection === 'online' ? 'Đã kết nối' : connection === 'connecting' ? 'Đang kết nối' : 'Mất kết nối'}</span></div><form onSubmit={reconnect} className="sim-settings"><label>Device ID<input value={draft.deviceId} onChange={e => setDraft({ ...draft, deviceId: e.target.value })} spellCheck={false}/></label><label>MQTT WebSocket<input value={draft.url} onChange={e => setDraft({ ...draft, url: e.target.value })} spellCheck={false}/></label><div className="sim-form-row"><label>Tên đăng nhập<input value={draft.username} onChange={e => setDraft({ ...draft, username: e.target.value })} autoComplete="off"/></label><label>Mật khẩu<input type="password" value={draft.password} onChange={e => setDraft({ ...draft, password: e.target.value })} autoComplete="off"/></label></div><button className="sim-secondary" type="submit">Áp dụng & kết nối lại <span>↗</span></button></form><p className="sim-fine-print">Mỗi tab mới có một ID riêng. Tài khoản simulator chỉ được gửi lên topic của chính deviceId.</p></section>
        <section className="sim-card"><div className="sim-card-title"><h2>Phiên hiện tại</h2>{keypad.step === 'ready' && <span className="sim-badge online">Đã tham gia</span>}</div><div className="sim-steps"><span className={keypad.step === 'room' ? 'current' : 'done'}>1<span>Mã phòng</span></span><i/><span className={keypad.step === 'student' ? 'current' : keypad.step === 'ready' ? 'done' : ''}>2<span>Mã sinh viên</span></span><i/><span className={keypad.step === 'ready' ? 'current' : ''}>3<span>Trả lời</span></span></div><div className="sim-session-info"><div><span>Mã phòng</span><strong>{keypad.roomCode || '—'}</strong></div><div><span>Mã sinh viên</span><strong>{keypad.studentCode || '—'}</strong></div><div><span>Còn lại</span><strong>{active ? `${remaining}s` : '—'}</strong></div></div><p className="sim-instruction">{keypad.step === 'room' ? 'Nhập mã phòng 6 chữ số trên bàn phím rồi nhấn Confirm.' : keypad.step === 'student' ? 'Nhập đúng 2 chữ số mã sinh viên rồi nhấn Confirm để tham gia.' : multiple ? 'Câu nhiều đáp án: bấm A–D để chọn hoặc bỏ chọn từng phương án, rồi Confirm. Xóa hủy toàn bộ lựa chọn.' : 'Chọn A–D rồi Confirm. Xóa hủy lựa chọn. Bạn có thể đổi đáp án khi câu còn mở.'}</p>{state && <div className="sim-question"><span>{stateLabel(state)}</span>{state.currentQuestion && <p>Câu {state.currentQuestionIndex + 1}{multiple ? ' (nhiều đáp án)' : ''}: {state.currentQuestion.content}</p>}</div>}<button type="button" className="sim-text-button" onClick={() => { clearRequests(); setKeypad(initialKeypad); setState(null); setLastAck(null); }}>Nhập lại mã phòng / sinh viên</button></section>
        <section className="sim-card sim-log-card"><div className="sim-card-title"><h2>Nhật ký giao tiếp</h2><span className="sim-log-live"><i/> LIVE</span></div><div className="sim-logs" aria-live="polite">{logs.length ? logs.map(item => <div key={item.id} className={`sim-log ${item.kind}`}><time>{item.time}</time><p>{item.text}</p></div>) : <p className="sim-empty-log">Đang khởi tạo kết nối MQTT…</p>}</div></section>
      </div>
    </div>
    <div className="sim-help"><strong>Đúng hai ký tự mỗi lần.</strong> Mã dài được cuộn theo từng cặp trên LED. Dấu chấm trái báo đã tham gia; dấu chấm phải nhấp nháy trong lúc chờ ACK.</div>
  </div>;
}
export default DeviceSimulator;
