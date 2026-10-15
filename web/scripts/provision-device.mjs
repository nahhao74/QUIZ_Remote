// Run on an administrator's machine; these credentials never enter frontend assets.
const deviceId = process.argv.find(arg => arg.startsWith('--deviceId='))?.split('=')[1];
if (!deviceId || !/^device-[A-Za-z0-9_-]{1,57}$/.test(deviceId)) throw new Error('Usage: MQTT_DEVICE_PASSWORD=... pnpm provision --deviceId=device-001');
const password = process.env.MQTT_DEVICE_PASSWORD;
const adminPassword = process.env.EMQX_DASHBOARD_PASSWORD;
if (!password || password.length < 12 || !adminPassword) throw new Error('Set MQTT_DEVICE_PASSWORD (12+ chars) and EMQX_DASHBOARD_PASSWORD');
const url = process.env.EMQX_API_URL || 'http://127.0.0.1:18083/api/v5';
async function request(path, body, token) {
  const response = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`EMQX returned ${response.status}; check account permissions or an existing device ID`);
  return response.json();
}
const { token } = await request('/login', { username: process.env.EMQX_DASHBOARD_USER || 'admin', password: adminPassword });
await request('/authentication/password_based%3Abuilt_in_database/users', { user_id: deviceId, password, is_superuser: false }, token);
console.log(`Provisioned ${deviceId}. Use username=${deviceId}, clientId=${deviceId}; password is not printed.`);
