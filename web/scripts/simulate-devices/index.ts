import mqtt, { type MqttClient } from 'mqtt';
import { randomInt, randomUUID } from 'node:crypto';
import { topics, type Ack, type AnswerMessage, type JoinMessage, type RoomState } from '@classpulse/mqtt-contracts';
import type { AnswerChoice } from '@classpulse/shared-types';

/** MQTT-only load generator: every join and answer uses the same broker path as hardware. */
const args = new Map(process.argv.slice(2).map(arg => { const [name, ...value] = arg.replace(/^--/, '').split('='); return [name, value.join('=') || 'true']; }));
if (args.has('help')) {
  console.log('pnpm simulate --devices=50 --room=123456 [--duplicates] [--timeout=90] [--delay=1200] [--url=mqtt://localhost:1883]');
  console.log('Credentials: MQTT_SIMULATOR_USERNAME / MQTT_SIMULATOR_PASSWORD. A run joins all devices, waits for an active question, answers it and exits.');
  process.exit(0);
}
const count = Number(args.get('devices') || '50');
const roomCode = args.get('room') || '';
const timeoutMs = Number(args.get('timeout') || '90') * 1000;
const maxDelay = Number(args.get('delay') || '1200');
const duplicates = args.has('duplicates') && args.get('duplicates') !== 'false';
const brokerUrl = args.get('url') || process.env.MQTT_URL || 'mqtt://localhost:1883';
const username = process.env.MQTT_SIMULATOR_USERNAME || 'simulator';
const password = process.env.MQTT_SIMULATOR_PASSWORD || 'simulator-dev-only';
if (!Number.isInteger(count) || count < 1 || count > 100 || !/^\d{6}$/.test(roomCode) || !Number.isFinite(timeoutMs) || timeoutMs < 5000 || !Number.isInteger(maxDelay) || maxDelay < 0 || maxDelay > 30000) {
  console.error('Invalid arguments: devices=1..100, room=6 digits, timeout>=5 seconds, delay=0..30000 ms. Use --help.'); process.exit(1);
}
const runId = randomUUID().slice(0, 8);
const metrics = { devices: count, connected: 0, joined: 0, answered: 0, accepted: 0, rejected: 0, timeout: 0, duplicateAccepted: 0, duplicateRejected: 0, duplicateUnexpected: 0, retries: 0, transportErrors: 0 };
const codes: Record<string, number> = {};
const latencies: number[] = [];
const clients: MqttClient[] = [];
let shuttingDown = false;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function validAck(value: unknown): value is Ack { const ack = value as Ack | null; return !!ack && typeof ack.requestId === 'string' && typeof ack.success === 'boolean' && typeof ack.code === 'string'; }
function validState(value: unknown): value is RoomState { const state = value as RoomState | null; return !!state && state.roomCode === roomCode && typeof state.status === 'string' && typeof state.serverTimestamp === 'string'; }
const start = Date.now();
console.log(`ClassPulse MQTT load test · ${count} devices · room ${roomCode} · duplicates ${duplicates ? 'ON' : 'OFF'}`);
console.log(`Broker ${brokerUrl} · waiting up to ${timeoutMs / 1000}s for the teacher to open a question.`);
async function runDevice(index: number): Promise<void> {
  await sleep(randomInt(0, 350));
  const deviceId = `load-${runId}-${String(index + 1).padStart(3, '0')}`;
  const client = mqtt.connect(brokerUrl, { clientId: deviceId, username, password, clean: true, reconnectPeriod: 1000, connectTimeout: 8000, queueQoSZero: false });
  clients.push(client);
  const awaiting = new Map<string, { resolve: (ack: Ack) => void }>();
  let state: RoomState | null = null;
  let ready = false;
  let transportReported = false;
  client.on('connect', () => {
    client.subscribe([topics.ack(deviceId), topics.state(roomCode), topics.question(roomCode)], { qos: 1 }, (error, grants) => {
      if (error || grants?.some(grant => grant.qos === 128)) { metrics.transportErrors++; return; }
      if (!ready) metrics.connected++;
      ready = true;
    });
  });
  client.on('error', error => { if (!transportReported) { transportReported = true; metrics.transportErrors++; console.error(`${deviceId}: ${error.message}`); } });
  client.on('message', (topic, raw) => {
    let value: unknown; try { value = JSON.parse(raw.toString()); } catch { return; }
    if (topic === topics.ack(deviceId) && validAck(value)) awaiting.get(value.requestId)?.resolve(value);
    else if ((topic === topics.state(roomCode) || topic === topics.question(roomCode)) && validState(value)) {
      if (!state || Date.parse(value.serverTimestamp) >= Date.parse(state.serverTimestamp)) state = value;
    }
  });
  async function request(topic: string, payload: JoinMessage | AnswerMessage, isDuplicate = false): Promise<Ack | null> {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const sentAt = Date.now();
    let attempts = 0;
    return new Promise(resolve => {
      const finish = (ack: Ack | null) => {
        if (settled) return;
        settled = true; clearTimeout(timer); awaiting.delete(payload.requestId);
        if (!ack) metrics.timeout++;
        else {
          codes[ack.code] = (codes[ack.code] || 0) + 1;
          latencies.push(Date.now() - sentAt);
          if (ack.success) metrics.accepted++; else metrics.rejected++;
          if (isDuplicate) {
            if (ack.code !== 'DUPLICATE_MESSAGE') metrics.duplicateUnexpected++;
            else if (ack.success && (ack.originalCode === 'JOIN_ACCEPTED' || ack.originalCode === 'ANSWER_ACCEPTED')) metrics.duplicateAccepted++;
            else metrics.duplicateRejected++;
          }
        }
        resolve(ack);
      };
      awaiting.set(payload.requestId, { resolve: finish });
      const send = () => {
        if (shuttingDown || Date.now() - start > timeoutMs) { finish(null); return; }
        attempts++;
        if (client.connected) client.publish(topic, JSON.stringify(payload), { qos: 1, retain: false }, error => { if (error) metrics.transportErrors++; });
        timer = setTimeout(() => {
          if (attempts < 3 && Date.now() - start < timeoutMs) { metrics.retries++; send(); }
          else finish(null);
        }, Math.min(4000, Math.max(1, timeoutMs - (Date.now() - start))));
      };
      send();
    });
  }
  try {
    while (!ready && Date.now() - start < timeoutMs && !shuttingDown) await sleep(50);
    if (!ready || shuttingDown) { metrics.timeout++; return; }
    const join: JoinMessage = { requestId: randomUUID(), deviceId, roomCode, studentCode: String(index).padStart(2, '0'), clientTimestamp: new Date().toISOString() };
    const ack = await request(topics.join(deviceId), join);
    if (!ack?.success) return;
    metrics.joined++;
    if (duplicates) await request(topics.join(deviceId), join, true);
    // Repeated retained state must never trigger multiple answers for the same run.
    while (!shuttingDown && Date.now() - start < timeoutMs) {
      const current = state as RoomState | null;
      if (current?.status === 'FINISHED') { metrics.rejected++; codes.SESSION_FINISHED_BEFORE_ANSWER = (codes.SESSION_FINISHED_BEFORE_ANSWER || 0) + 1; return; }
      if (current?.status === 'QUESTION_ACTIVE' && current.currentQuestion && current.questionEndsAt && Date.parse(current.questionEndsAt) > Date.now()) {
        const questionId = current.currentQuestion.id;
        const delay = maxDelay ? randomInt(0, maxDelay + 1) : 0;
        await sleep(delay);
        const latest = state as RoomState | null;
        if (latest?.status !== 'QUESTION_ACTIVE' || latest.currentQuestion?.id !== questionId || !latest.questionEndsAt || Date.parse(latest.questionEndsAt) <= Date.now()) continue;
        const answer: AnswerMessage = { requestId: randomUUID(), deviceId, roomCode, questionId, answer: ['A', 'B', 'C', 'D'][randomInt(0, 4)] as AnswerChoice, sequence: 1, clientTimestamp: new Date().toISOString() };
        const answered = await request(topics.answer(deviceId), answer);
        if (answered?.success) metrics.answered++;
        if (duplicates && answered) await request(topics.answer(deviceId), answer, true);
        return;
      }
      await sleep(80);
    }
    metrics.timeout++;
  } finally { client.end(true); }
}
function stop() { shuttingDown = true; clients.forEach(client => client.end(true)); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
async function main() {
const progress = setInterval(() => console.log(`Connected ${metrics.connected}/${count} · joined ${metrics.joined} · answered ${metrics.answered} · rejected ${metrics.rejected} · timeout ${metrics.timeout}`), 5000);
await Promise.all(Array.from({ length: count }, (_, index) => runDevice(index)));
clearInterval(progress); stop();
latencies.sort((a, b) => a - b);
const percentile = (p: number) => latencies.length ? latencies[Math.max(0, Math.ceil(latencies.length * p) - 1)] : null;
console.log(JSON.stringify({ ...metrics, ackCodes: codes, durationSeconds: Math.round((Date.now() - start) / 100) / 10, ackLatencyMs: { p50: percentile(.5), p95: percentile(.95), max: latencies.at(-1) ?? null }, note: 'accepted/rejected count ACKs including deliberate duplicate sends; joined/answered count unique devices. Duplicate ACK success must preserve the original result.' }, null, 2));
process.exitCode = metrics.joined !== count || metrics.answered !== count || metrics.timeout || metrics.rejected || metrics.duplicateRejected || metrics.duplicateUnexpected ? 1 : 0;

}
void main().catch(error => { stop(); console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
