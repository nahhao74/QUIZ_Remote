import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const directory = process.env.EMQX_CONFIG_DIR || '/emqx-config';
const backend = process.env.MQTT_USERNAME || 'backend';
const password = process.env.MQTT_PASSWORD;
const simulator = process.env.MQTT_SIMULATOR_USERNAME || 'simulator';
const simulatorPassword = process.env.MQTT_SIMULATOR_PASSWORD;
const allowSimulator = process.env.MQTT_SIMULATOR_ENABLED !== 'false';
const ownDevice = '${clientid}';
const ownIdentity = '${username}';
for (const name of [backend, simulator]) {
  if (!/^[a-zA-Z0-9_-]{3,64}$/.test(name)) throw new Error('MQTT usernames must be 3–64 alphanumeric, underscore or hyphen characters');
}
if (backend === simulator) throw new Error('Backend and simulator must use different accounts');
if (!password || (allowSimulator && !simulatorPassword)) throw new Error('MQTT passwords are required');
const users = [{ user_id: backend, password, is_superuser: false }];
const rules = [
  `{allow, {username, "${backend}"}, subscribe, ["quiz/v1/devices/+/join", "quiz/v1/devices/+/answer", "quiz/v1/devices/+/status"]}.`,
  `{allow, {username, "${backend}"}, publish, ["quiz/v1/devices/+/ack", "quiz/v1/devices/+/command", "quiz/v1/rooms/+/question", "quiz/v1/rooms/+/state"]}.`,
  `{allow, {username, {re, "^device-[A-Za-z0-9_-]+$"}}, publish, ["quiz/v1/devices/${ownIdentity}/join", "quiz/v1/devices/${ownIdentity}/answer", "quiz/v1/devices/${ownIdentity}/status"]}.`,
  `{allow, {username, {re, "^device-[A-Za-z0-9_-]+$"}}, subscribe, ["quiz/v1/devices/${ownIdentity}/ack", "quiz/v1/devices/${ownIdentity}/command", "quiz/v1/rooms/+/question", "quiz/v1/rooms/+/state"]}.`,
];
if (allowSimulator) {
  users.push({ user_id: simulator, password: simulatorPassword, is_superuser: false });
  rules.push(
    `{allow, {username, "${simulator}"}, publish, ["quiz/v1/devices/${ownDevice}/join", "quiz/v1/devices/${ownDevice}/answer", "quiz/v1/devices/${ownDevice}/status"]}.`,
    `{allow, {username, "${simulator}"}, subscribe, ["quiz/v1/devices/${ownDevice}/ack", "quiz/v1/devices/${ownDevice}/command", "quiz/v1/rooms/+/question", "quiz/v1/rooms/+/state"]}.`,
  );
}
rules.push('{deny, all}.');
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'auth.json'), JSON.stringify(users), { mode: 0o644 });
await writeFile(join(directory, 'acl.conf'), rules.join('\n') + '\n', { mode: 0o644 });
console.log('EMQX authentication and deny-by-default ACL prepared');
