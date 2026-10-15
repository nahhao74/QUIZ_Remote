/** Runs against the real HTTP API, PostgreSQL behind it, EMQX and Socket.IO. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connect, type MqttClient } from 'mqtt';
import { io, type Socket } from 'socket.io-client';
import { topics, type Ack, type ResultCommand, type RoomState } from '@classpulse/mqtt-contracts';
import type { AuthResponse, Quiz, SessionSnapshot } from '@classpulse/shared-types';

const base = process.env.API_URL || 'http://127.0.0.1:3000/api';
const mqttUrl = process.env.SIMULATOR_MQTT_URL || 'mqtt://127.0.0.1:1883';
const username = process.env.MQTT_SIMULATOR_USERNAME || 'simulator';
const password = process.env.MQTT_SIMULATOR_PASSWORD || 'simulator-dev-only';
const clients: MqttClient[] = [];
const sockets: Socket[] = [];
const createdSessions: string[] = [];
let passed = 0;
let token = '';
let cookie = '';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function check(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log(`✓ ${name}`); }
async function api<T = any>(path: string, options: { method?: string; body?: unknown; auth?: string; cookies?: string; expected?: number; captureCookie?: boolean } = {}): Promise<T> {
  const response = await fetch(base + path, { method: options.method || 'GET', headers: { 'Content-Type': 'application/json', ...(options.auth ?? token ? { Authorization: `Bearer ${options.auth ?? token}` } : {}), ...(options.cookies ? { Cookie: options.cookies } : {}) }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const data = await response.json();
  assert.equal(response.status, options.expected ?? (options.method === 'POST' && !path.startsWith('/auth/') ? 201 : 200), `${path}: ${JSON.stringify(data)}`);
  if (options.captureCookie) cookie = response.headers.get('set-cookie')!.split(';')[0];
  return data;
}
async function device(id = `e2e-${randomUUID().slice(0, 16)}`) {
  const client = connect(mqttUrl, { clientId: id, username, password, reconnectPeriod: 0, connectTimeout: 5000 });
  clients.push(client);
  await new Promise<void>((resolve, reject) => { client.once('connect', () => resolve()); client.once('error', reject); });
  client.on('error', () => {});
  await client.subscribeAsync(topics.ack(id), { qos: 1 });
  const send = async (action: 'join'|'answer'|'status', body: Record<string, unknown>): Promise<Ack> => {
    const request = { requestId: randomUUID(), deviceId: id, clientTimestamp: new Date().toISOString(), ...body };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error(`ACK timeout ${id}/${action}`)); }, 20000);
      const listener = (topic: string, payload: Buffer) => { if (topic !== topics.ack(id)) return; const ack = JSON.parse(payload.toString()) as Ack; if (ack.requestId === request.requestId) { cleanup(); resolve(ack); } };
      const cleanup = () => { clearTimeout(timeout); client.off('message', listener); };
      client.on('message', listener);
      client.publish(topics[action](id), JSON.stringify(request), { qos: 1 }, error => { if (error) { cleanup(); reject(error); } });
    });
  };
  return { id, client, send };
}
async function until<T>(fn: () => Promise<T>, predicate: (value: T) => boolean, ms = 12000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await fn(); if (predicate(value)) return value; await wait(250); }
  throw new Error('Timed out waiting for server state');
}
async function createSession(quizId: string, mode = 'MANUAL', durationSeconds = 120) { const session = await api<SessionSnapshot>('/sessions', { method: 'POST', body: { quizId, mode, durationSeconds } }); createdSessions.push(session.id); return session; }
async function main() {
  const run = randomUUID().slice(0, 8);
  const credentials = { name: 'Kiểm thử tích hợp', email: `e2e-${run}@example.test`, password: 'Integration123!' };
  let otherToken = '';
  await check('Registration, login, profile, rotating refresh cookie', async () => {
    const registered = await api<AuthResponse>('/auth/register', { method: 'POST', body: credentials, expected: 201, captureCookie: true });
    assert.equal(registered.teacher.email, credentials.email);
    const login = await api<AuthResponse>('/auth/login', { method: 'POST', body: { email: credentials.email, password: credentials.password }, captureCookie: true });
    token = login.accessToken;
    const oldCookie = cookie;
    const refreshed = await api<AuthResponse>('/auth/refresh', { method: 'POST', cookies: cookie, captureCookie: true });
    assert.notEqual(cookie, oldCookie); token = refreshed.accessToken;
    assert.equal((await api('/teachers/me')).name, credentials.name);
    await api('/auth/login', { method: 'POST', body: { email: credentials.email, password: 'incorrect' }, expected: 401 });
    const other = await api<AuthResponse>('/auth/register', { method: 'POST', body: { ...credentials, email: `other-${run}@example.test` }, expected: 201 });
    otherToken = other.accessToken;
  });
  const questions = Array.from({ length: 2 }, (_, order) => ({ content: `Câu ${order + 1}: 2 + 2 bằng bao nhiêu?`, optionA: '4', optionB: '5', optionC: '6', optionD: '7', correctAnswer: 'A', durationSeconds: 120, order }));
  const quiz = await api<Quiz>('/quizzes', { method: 'POST', body: { title: `E2E ${run}`, description: 'Generated integration fixture', questions } });
  let session = await createSession(quiz.id);
  await check('Quiz/session ownership and quiz snapshots', async () => {
    await api(`/quizzes/${quiz.id}`, { auth: otherToken, expected: 404 });
    await api(`/sessions/${session.id}`, { auth: otherToken, expected: 404 });
    await api(`/quizzes/${quiz.id}`, { method: 'PATCH', body: { title: 'Edited after session creation' } });
    assert.equal((await api<SessionSnapshot>(`/sessions/${session.id}`)).title, `E2E ${run}`);
  });
  const updates: SessionSnapshot[] = [];
  await check('Socket.IO authenticates, authorizes session and sends snapshot', async () => {
    const socket = io(base.replace(/\/api$/, ''), { auth: { token }, transports: ['websocket'] }); sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    socket.on('session:update', s => updates.push(s));
    const response = await socket.timeout(5000).emitWithAck('session:join', { sessionId: session.id }); assert.equal(response.success, true);
    const other = io(base.replace(/\/api$/, ''), { auth: { token: otherToken }, transports: ['websocket'] }); sockets.push(other);
    await new Promise<void>((resolve, reject) => { other.once('connect', resolve); other.once('connect_error', reject); });
    const denied = await other.timeout(5000).emitWithAck('session:join', { sessionId: session.id }); assert.equal(denied.success, false);
  });
  const d = await device();
  await check('Missing room, topic identity validation, successful join and duplicate join', async () => {
    assert.equal((await d.send('join', { roomCode: '000000', studentCode: '01' })).code, 'ROOM_NOT_FOUND');
    assert.equal((await d.send('join', { deviceId: 'different-device', roomCode: session.roomCode, studentCode: '01' })).code, 'INVALID_PAYLOAD');
    const body = { roomCode: session.roomCode, studentCode: '01', requestId: randomUUID(), clientTimestamp: new Date().toISOString() };
    assert.equal((await d.send('join', body)).code, 'JOIN_ACCEPTED');
    assert.equal((await d.send('join', body)).code, 'DUPLICATE_MESSAGE');
    assert.equal((await api<SessionSnapshot>(`/sessions/${session.id}`)).participantCount, 1);
  });
  session = await api(`/sessions/${session.id}/start`, { method: 'POST' });
  let qid = session.currentQuestion!.id;
  await check('Zero stats, hidden answer, retained MQTT question and server deadlines', async () => {
    assert.equal(session.stats.correctPercentage, 0); assert.equal(session.stats.percentages.A, 0);
    assert.equal(session.currentQuestion!.correctAnswer, undefined);
    const state = await new Promise<RoomState>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('No retained room question')), 5000);
      const listener = (topic: string, buffer: Buffer) => { if (topic === topics.question(session.roomCode)) { clearTimeout(timeout); d.client.off('message', listener); resolve(JSON.parse(buffer.toString())); } };
      d.client.on('message', listener); void d.client.subscribeAsync(topics.question(session.roomCode), { qos: 1 });
    });
    assert.equal(state.currentQuestion?.correctAnswer, undefined); assert.equal(state.currentQuestion?.id, qid);
    assert.equal((await api<SessionSnapshot>(`/sessions/${session.id}`)).questionEndsAt, session.questionEndsAt);
  });
  await check('A/B/C/D confirmed changes, deduplication, sequence and input guards', async () => {
    for (const [i, answer] of ['A', 'B', 'C', 'D'].entries()) assert.equal((await d.send('answer', { roomCode: session.roomCode, questionId: qid, answer, sequence: i + 1 })).code, 'ANSWER_ACCEPTED');
    const body = { roomCode: session.roomCode, questionId: qid, answer: 'A', sequence: 5, requestId: randomUUID(), clientTimestamp: new Date().toISOString() };
    assert.equal((await d.send('answer', body)).code, 'ANSWER_ACCEPTED');
    const duplicate = await d.send('answer', body); assert.equal(duplicate.code, 'DUPLICATE_MESSAGE'); assert.equal(duplicate.success, true);
    assert.equal((await d.send('answer', { ...body, requestId: randomUUID(), sequence: 2 })).code, 'STALE_SEQUENCE');
    assert.equal((await d.send('answer', { ...body, requestId: randomUUID(), answer: 'E' })).code, 'INVALID_ANSWER');
    assert.equal((await d.send('answer', { ...body, requestId: randomUUID(), questionId: randomUUID() })).code, 'QUESTION_NOT_ACTIVE');
    const unjoined = await device(); assert.equal((await unjoined.send('answer', { roomCode: session.roomCode, questionId: qid, answer: 'A', sequence: 1 })).code, 'DEVICE_NOT_JOINED');
    const snapshot = await api<SessionSnapshot>(`/sessions/${session.id}`); assert.equal(snapshot.answerCount, 1); assert.equal(snapshot.participants[0].answer, undefined);
  });
  await check('50 MQTT devices join and confirm nearly simultaneously', async () => {
    const devices = await Promise.all(Array.from({ length: 50 }, () => device()));
    const joins = await Promise.all(devices.map((item, i) => item.send('join', { roomCode: session.roomCode, studentCode: String(i + 2).padStart(2, '0') })));
    assert(joins.every(ack => ack.code === 'JOIN_ACCEPTED'), JSON.stringify(joins.filter(ack => !ack.success)));
    const answers = await Promise.all(devices.map((item, i) => item.send('answer', { roomCode: session.roomCode, questionId: qid, answer: ['A', 'B', 'C', 'D'][i % 4], sequence: 1 })));
    assert(answers.every(ack => ack.code === 'ANSWER_ACCEPTED'), JSON.stringify(answers.filter(ack => !ack.success)));
    const snapshot = await until(() => api<SessionSnapshot>(`/sessions/${session.id}`), s => s.answerCount === 51);
    assert.equal(snapshot.participantCount, 51); assert.equal(snapshot.stats.unanswered, 0);
    assert.deepEqual(snapshot.stats.counts, { A: 14, B: 13, C: 12, D: 12 });
    await until(async () => updates, list => list.some(s => s.answerCount === 51));
    assert(updates.filter(s => s.status === 'QUESTION_ACTIVE').every(s => !s.currentQuestion?.correctAnswer && s.participants.every(p => p.answer === undefined)));
  });
  await check('Closing locks answers, reveals correct statistics; manual next and finish', async () => {
    const closed = await api<SessionSnapshot>(`/sessions/${session.id}/close`, { method: 'POST' });
    assert.equal(closed.currentQuestion?.correctAnswer, 'A'); assert.equal(closed.stats.correct, 14); assert.equal(closed.stats.incorrect, 37);
    assert.equal((await d.send('answer', { roomCode: session.roomCode, questionId: qid, answer: 'B', sequence: 6 })).code, 'SESSION_NOT_ACTIVE');
    const next = await api<SessionSnapshot>(`/sessions/${session.id}/next`, { method: 'POST' }); assert.notEqual(next.currentQuestion?.id, qid); assert.equal(next.answerCount, 0);
    await d.client.subscribeAsync(topics.command(d.id), { qos: 1 });
    const resultCommand = new Promise<ResultCommand>((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error('Result command timeout')); }, 10000);
      const listener = (topic: string, payload: Buffer) => { if (topic === topics.command(d.id)) { cleanup(); resolve(JSON.parse(payload.toString())); } };
      const cleanup = () => { clearTimeout(timeout); d.client.off('message', listener); };
      d.client.on('message', listener);
    });
    const finished = await api<SessionSnapshot>(`/sessions/${session.id}/finish`, { method: 'POST' }); assert.equal(finished.status, 'FINISHED'); assert.equal(finished.results.length, 2);
    assert.deepEqual({ ...(await resultCommand), serverTimestamp: '<checked>' }, { type: 'RESULT', roomCode: session.roomCode, score: 5, correct: 1, total: 2, serverTimestamp: '<checked>' });
  });
  await check('Server timer auto-closes, advances and finishes without any browser', async () => {
    const timer = await createSession(quiz.id, 'TIMER', 5);
    const start = await api<SessionSnapshot>(`/sessions/${timer.id}/start`, { method: 'POST' });
    const after = await until(() => api<SessionSnapshot>(`/sessions/${timer.id}`), s => s.status === 'QUESTION_CLOSED', 7000);
    assert.equal(after.questionEndsAt, start.questionEndsAt);
    const next = await until(() => api<SessionSnapshot>(`/sessions/${timer.id}`), s => s.currentQuestionIndex === 1, 5000);
    assert.equal(next.status, 'QUESTION_ACTIVE');
    await until(() => api<SessionSnapshot>(`/sessions/${timer.id}`), s => s.status === 'FINISHED', 10000);
  });
  await check('Logout invalidates refresh cookie', async () => {
    await api('/auth/logout', { method: 'POST', cookies: cookie });
    await api('/auth/refresh', { method: 'POST', cookies: cookie, expected: 401 });
  });
}
main().then(() => console.log(`\n${passed} end-to-end checks passed against real API / PostgreSQL / EMQX / Socket.IO.`)).catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  sockets.forEach(s => s.disconnect());
  await Promise.allSettled(clients.map(c => c.endAsync(true)));
  if (process.exitCode) await Promise.allSettled(createdSessions.map(id => api(`/sessions/${id}/finish`, { method: 'POST' })));
});
