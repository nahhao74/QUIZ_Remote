// ClassPulse quiz device: hardware M2/M5/M6 on a breadboard, classic ESP32-WROOM.
// Wi-Fi + MQTT to the ClassPulse backend using the esp-mqtt bundled with the ESP32 core (no external libraries).
// Flow: 6-digit room code # -> 2-digit student code # -> choose 1-4 (= A-D) # -> wait for next question -> score.
// MULTIPLE questions (web/): keys 1-4 each toggle one letter, # sends the canonical key such as "AC".
// Powers itself off through GPIO13 (M2); # on the Ph screen rejoins the previous room; hold 0 to open the Wi-Fi setup page.
#include <Arduino.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <esp_random.h>
#include <esp_timer.h>
#include <mqtt_client.h>
#include <time.h>
#include <string>

// ======================== SETTINGS TO EDIT ========================
// Default Wi-Fi/MQTT. The setup page (hold key 0) saves new values to NVS and they take priority
// until firmware with different defaults is flashed.
constexpr char WIFI_SSID[] = "Loading...";      // The ESP32 only connects to 2.4 GHz Wi-Fi.
constexpr char WIFI_PASSWORD[] = "";  // Enter your Wi-Fi password before flashing
constexpr char MQTT_HOST[] = "10.246.235.139";      // LAN IP of the machine running ClassPulse; do NOT use localhost.
constexpr uint32_t MQTT_PORT = 1883;
// Development credentials documented in the ClassPulse README; provision separate ones for a real deployment.
constexpr char MQTT_USERNAME[] = "simulator";
constexpr char MQTT_PASSWORD[] = "simulator-dev-only";
// false: PCB wiring, AO3401A QDIG1/QDIG2 (LOW = ON).
// true: no AO3401A yet, common anodes wired straight to GPIO17/GPIO4 (HIGH = ON).
constexpr bool DIGIT_DIRECT_GPIO = false; // Board 0322ccc has QDIG1/QDIG2.
// Board 0322ccc has WAKE_NODE shorted to COL3: pressing a key in columns 1-3 also raises COL3 through DWAKE0-2.
// true: ignore COL3 when another key in the same row is pressed (A-D still work when pressed alone). Set false once the short is fixed.
constexpr bool COL3_FOLLOWS_WAKE = true;
// 2xAAA supply + boost converter: reduce the peak current while Wi-Fi transmits (keep the hotspot close to the device).
// On USB power you can restore WIFI_POWER_19_5dBm and 240 MHz.
constexpr wifi_power_t WIFI_TX_POWER = WIFI_POWER_8_5dBm;
constexpr uint32_t CPU_MHZ = 80;
constexpr uint32_t WIFI_START_DELAY_MS = 1500; // Let the supply settle before the RF calibration burst.
// Automatic power-off (drives GPIO13 low); 0 = never power off on that condition.
constexpr uint32_t OFF_AFTER_RESULT_MS = 60000;   // After the score is shown (or the session has ended).
constexpr uint32_t OFF_IDLE_ENTRY_MS = 180000;    // Entering the room/student code without pressing a key.
constexpr uint32_t OFF_IDLE_ROOM_MS = 1200000;    // In a room, no new question and no key presses.
constexpr uint32_t OFF_NO_WIFI_MS = 120000;       // Unable to join Wi-Fi for the whole period.
constexpr uint32_t OFF_HOLD_STAR_MS = 3000;       // Hold * to power off on purpose.
constexpr uint32_t CONFIG_HOLD_ZERO_MS = 3000;    // Hold 0 on the Ph/Id screen to open the setup page.
constexpr uint32_t CONFIG_TIMEOUT_MS = 300000;    // The setup page closes itself after 5 minutes.
// ================================================================

constexpr size_t ROOM_CODE_LENGTH = 6;
constexpr size_t STUDENT_CODE_LENGTH = 2; // Backend joinSchema: /^\d{2}$/.
constexpr uint32_t ACK_TIMEOUT_MS = 4000;
constexpr uint8_t MAX_SEND_ATTEMPTS = 3;
constexpr uint32_t STATUS_SHOW_MS = 900;
constexpr uint16_t ROW_SETTLE_US = 200;
constexpr uint32_t DEBOUNCE_MS = 35;
constexpr size_t MAX_MESSAGE_BYTES = 16384;

constexpr uint8_t DIGIT_ON = DIGIT_DIRECT_GPIO ? HIGH : LOW;
constexpr uint8_t DIGIT_OFF = DIGIT_DIRECT_GPIO ? LOW : HIGH;
constexpr uint8_t HOLD = 13, OE = 16, CLK = 18, LATCH = 19, DATA = 23;
constexpr uint8_t DIGITS[2] = {17, 4};        // left LED, right LED
constexpr uint8_t ROWS[4] = {25, 26, 27, 22};
constexpr uint8_t COLS[4] = {32, 33, 34, 35};
constexpr char KEYS[4][4] = {
  {'1','2','3','A'}, {'4','5','6','B'},
  {'7','8','9','C'}, {'*','0','#','D'}
};
constexpr uint8_t NUMBERS[10] = {
  0x3f,0x06,0x5b,0x4f,0x66,0x6d,0x7d,0x07,0x7f,0x6f
}; // bit0=A ... bit6=G, bit7=DP; a set bit means illuminated.
constexpr uint8_t DP = 0x80;

enum class Step : uint8_t { Room, Student, Quiz };
enum class Pending : uint8_t { None, Join, Answer };
enum class Mode : uint8_t { Normal, Config, PowerOff };
enum class EventType : uint8_t { Connected, Disconnected, Data };
struct MqttEvent { EventType type; std::string topic, payload; };

volatile uint8_t frame[2] = {0, 0};
esp_mqtt_client_handle_t mqtt = nullptr;
QueueHandle_t mqttEvents = nullptr;
bool mqttStarted = false, mqttConnected = false, wifiStarted = false, wifiOnline = false;
char deviceId[24];

Step step = Step::Room;
std::string entry, roomCode, studentCode;
std::string sessionStatus, currentQuestionId, lastStateTimestamp;
unsigned questionNumber = 0;
std::string selected, submitted; // Canonical answer key: "A", "AC", ...
bool multipleChoice = false;
uint32_t answerSequence = 0;
int score = -1;

struct {
  Pending kind = Pending::None;
  std::string requestId, topic, payload, choice;
  uint8_t attempts = 0;
  uint32_t sentAt = 0;
} pending;

char overlay[3] = "";
uint32_t overlayUntil = 0, lastScanMs = 0, candidateSince = 0, lastWifiRetryMs = 0;
char candidate = 0, stableKey = 0;
uint32_t stableSince = 0;
bool longPressHandled = false;

// Settings stored in NVS and the boot count (keeps the sequence increasing across resets).
Preferences prefs;
std::string wifiSsid, wifiPassword, mqttHost, savedRoom, savedStudent;
uint32_t bootCount = 0;

// Power: time of the last activity, when the score was shown, when Wi-Fi was lost.
Mode mode = Mode::Normal;
uint32_t lastActivityMs = 0, resultSince = 0, wifiDownSince = 0;
uint32_t powerOffSince = 0, keysReleasedSince = 0;
uint8_t powerOffPhase = 0; // 1: show OF, send offline; 2: wait for key release; 3: GPIO13 driven low.
esp_timer_handle_t displayTimer = nullptr;

// Setup page (SoftAP + captive portal).
WebServer *portal = nullptr;
DNSServer *dns = nullptr;
uint32_t configSince = 0;
std::string scannedSsids;

// ---------------------------- Display ----------------------------
uint8_t glyph(char c) {
  if (c >= '0' && c <= '9') return NUMBERS[c - '0'];
  switch (c) {
    case 'A': return 0x77; case 'b': return 0x7c; case 'C': return 0x39; case 'd': return 0x5e;
    case 'E': return 0x79; case 'F': return 0x71; case 'h': return 0x74; case 'I': return 0x30;
    case 'n': return 0x54; case 'O': return 0x3f; case 'P': return 0x73; case '-': return 0x40;
    default: return 0x00;
  }
}

char answerGlyph(char choice) { return "AbCd"[choice - 'A']; }

void showChars(char left, char right, uint8_t leftDot = 0, uint8_t rightDot = 0) {
  frame[0] = glyph(left) | leftDot;
  frame[1] = glyph(right) | rightDot;
}

void refreshDisplay(void *) { // esp_timer task: keeps multiplexing while Wi-Fi/MQTT work.
  static uint8_t digit = 0;
  digitalWrite(OE, HIGH);
  for (uint8_t pin : DIGITS) digitalWrite(pin, DIGIT_OFF);
  digitalWrite(LATCH, LOW);
  shiftOut(DATA, CLK, MSBFIRST, uint8_t(~frame[digit])); // Segment ON = LOW.
  digitalWrite(LATCH, HIGH);
  digitalWrite(DIGITS[digit], DIGIT_ON);
  digitalWrite(OE, LOW);
  digit ^= 1;
}

void showStatus(const char *code, uint32_t ms = STATUS_SHOW_MS) {
  overlay[0] = code[0]; overlay[1] = code[1];
  overlayUntil = millis() + ms;
}

void showLastTwo(const std::string &text, char emptyLeft, char emptyRight) {
  if (text.empty()) showChars(emptyLeft, emptyRight);
  else if (text.size() == 1) showChars(' ', text[0]);
  else showChars(text[text.size() - 2], text.back());
}

// Keys longer than 2 letters scroll in pairs every 700 ms: "ABD" -> "Ab", "d ".
void showKey(const std::string &key, uint8_t leftDot, uint8_t rightDot, uint32_t now) {
  if (key.size() == 1) { showChars(' ', answerGlyph(key[0]), leftDot, rightDot); return; }
  const size_t start = now / 700 % ((key.size() + 1) / 2) * 2;
  showChars(answerGlyph(key[start]), start + 1 < key.size() ? answerGlyph(key[start + 1]) : ' ',
    leftDot, rightDot);
}

void render() {
  const uint32_t now = millis();
  if (mode == Mode::Config) { showChars('C', 'F', 0, (now / 500) % 2 ? DP : 0); return; }
  if (int32_t(overlayUntil - now) > 0) { showChars(overlay[0], overlay[1]); return; } // E.g. E1 before powering off.
  if (mode == Mode::PowerOff) { showChars('O', 'F'); return; }
  if (step == Step::Room) { showLastTwo(entry, 'P', 'h'); return; }
  if (step == Step::Student) { showLastTwo(entry, 'I', 'd'); return; }
  // In a room: left dot lit; right dot blinks while waiting for the ACK.
  const uint8_t waiting = pending.kind != Pending::None && (now / 250) % 2 ? DP : 0;
  const bool active = sessionStatus == "QUESTION_ACTIVE" && !currentQuestionId.empty();
  if (score >= 0) {
    if (score >= 10) showChars('1', '0', DP);
    else showChars(' ', char('0' + score), DP);
  } else if (active && !selected.empty()) {
    showKey(selected, DP, waiting, now);
  } else if (active && !submitted.empty()) {
    showKey(submitted, DP, DP, now); // Submitted, waiting for the next question.
  } else if (active) {
    const unsigned n = questionNumber % 100;
    showChars(char('0' + n / 10), char('0' + n % 10), DP, waiting);
  } else {
    showChars('-', '-', DP, waiting);
  }
}

// ----------------------------- Keypad -----------------------------
char scanKeypad() {
  char result = 0;
  uint8_t count = 0;
  for (uint8_t r = 0; r < 4; ++r) {
    digitalWrite(ROWS[r], LOW); // NPN OFF: selected raw row rises to VBAT.
    delayMicroseconds(ROW_SETTLE_US);
    uint8_t pressed = 0;
    for (uint8_t c = 0; c < 4; ++c) {
      if (digitalRead(COLS[c]) == LOW) pressed |= 1 << c;
    }
    digitalWrite(ROWS[r], HIGH);
    if (COL3_FOLLOWS_WAKE && (pressed & 0x07)) pressed &= 0x07; // COL3 only echoes another key in this row.
    for (uint8_t c = 0; c < 4; ++c) {
      if (pressed & (1 << c)) {
        result = KEYS[r][c];
        ++count;
      }
    }
  }
  return count == 1 ? result : (count ? char(0x7f) : char(0));
}

// ------------------------- Minimal JSON -------------------------
// The backend sends JSON.stringify output (no whitespace), which is enough to read a few flat fields.
size_t valueStart(const std::string &json, const char *key, size_t from = 0) {
  const std::string marker = std::string("\"") + key + "\":";
  const size_t pos = json.find(marker, from);
  return pos == std::string::npos ? pos : pos + marker.size();
}

std::string jsonString(const std::string &json, const char *key, size_t from = 0) {
  const size_t pos = valueStart(json, key, from);
  if (pos == std::string::npos || pos >= json.size() || json[pos] != '"') return "";
  size_t end = pos + 1;
  while (end < json.size() && !(json[end] == '"' && json[end - 1] != '\\')) ++end;
  return end < json.size() ? json.substr(pos + 1, end - pos - 1) : "";
}

long jsonInteger(const std::string &json, const char *key) {
  const size_t pos = valueStart(json, key);
  if (pos == std::string::npos || pos >= json.size() || !isdigit(uint8_t(json[pos]))) return -1;
  return strtol(json.c_str() + pos, nullptr, 10);
}

bool jsonTrue(const std::string &json, const char *key) {
  const size_t pos = valueStart(json, key);
  return pos != std::string::npos && json.compare(pos, 4, "true") == 0;
}

// ------------------------------ MQTT ------------------------------
std::string deviceTopic(const char *action) { return std::string("quiz/v1/devices/") + deviceId + "/" + action; }
std::string roomTopic(const char *kind) { return "quiz/v1/rooms/" + roomCode + "/" + kind; }

void postEvent(MqttEvent *event) {
  if (xQueueSend(mqttEvents, &event, 0) != pdTRUE) delete event;
}

void onMqttEvent(void *, esp_event_base_t, int32_t id, void *data) { // Runs in the MQTT task.
  auto *e = static_cast<esp_mqtt_event_handle_t>(data);
  static std::string topic, payload;
  if (id == MQTT_EVENT_CONNECTED) postEvent(new MqttEvent{EventType::Connected, "", ""});
  else if (id == MQTT_EVENT_DISCONNECTED) postEvent(new MqttEvent{EventType::Disconnected, "", ""});
  else if (id == MQTT_EVENT_DATA) {
    if (e->total_data_len > int(MAX_MESSAGE_BYTES)) return;
    if (e->current_data_offset == 0) {
      topic.assign(e->topic, e->topic_len);
      payload.clear();
      payload.reserve(e->total_data_len);
    }
    payload.append(e->data, e->data_len);
    if (e->current_data_offset + e->data_len >= e->total_data_len) {
      postEvent(new MqttEvent{EventType::Data, topic, payload});
    }
  }
}

void subscribeRoom() {
  if (!mqttConnected || roomCode.empty()) return;
  esp_mqtt_client_subscribe(mqtt, roomTopic("state").c_str(), 1);
  esp_mqtt_client_subscribe(mqtt, roomTopic("question").c_str(), 1);
}

void unsubscribeRoom() {
  if (!mqttConnected || roomCode.empty()) return;
  esp_mqtt_client_unsubscribe(mqtt, roomTopic("state").c_str());
  esp_mqtt_client_unsubscribe(mqtt, roomTopic("question").c_str());
}

void sendPending() {
  // A retry keeps the whole payload (requestId, sequence, timestamp) unchanged, per protocol v1.
  ++pending.attempts;
  pending.sentAt = millis();
  if (!mqttConnected) return;
  esp_mqtt_client_enqueue(mqtt, pending.topic.c_str(), pending.payload.c_str(),
    pending.payload.size(), 1, 0, true);
  Serial.printf("[MQTT] Send attempt %u/%u: %s\n", pending.attempts, MAX_SEND_ATTEMPTS, pending.topic.c_str());
}

void clearPending() {
  pending.kind = Pending::None;
  pending.requestId.clear(); pending.topic.clear(); pending.payload.clear(); pending.choice.clear();
  pending.attempts = 0; pending.sentAt = 0;
}

std::string makeUuid() {
  uint8_t b[16];
  esp_fill_random(b, sizeof(b));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  char out[37];
  snprintf(out, sizeof(out), "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
    b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]);
  return out;
}

std::string isoTimestamp() {
  const time_t now = time(nullptr);
  struct tm utc;
  gmtime_r(&now, &utc);
  char out[25];
  strftime(out, sizeof(out), "%Y-%m-%dT%H:%M:%SZ", &utc);
  return out;
}

void startPending(Pending kind, const char *action, const std::string &fields, const std::string &choice = "") {
  pending.kind = kind;
  pending.requestId = makeUuid();
  pending.topic = deviceTopic(action);
  pending.payload = "{\"requestId\":\"" + pending.requestId + "\",\"deviceId\":\"" + deviceId
    + "\",\"roomCode\":\"" + roomCode + "\",\"clientTimestamp\":\"" + isoTimestamp() + "\"," + fields + "}";
  pending.choice = choice;
  pending.attempts = 0;
  sendPending();
}

void resetToRoomEntry() {
  unsubscribeRoom();
  step = Step::Room;
  entry.clear(); roomCode.clear(); studentCode.clear();
  sessionStatus.clear(); currentQuestionId.clear(); lastStateTimestamp.clear();
  questionNumber = 0; selected.clear(); submitted.clear(); multipleChoice = false;
  answerSequence = 0; score = -1; resultSince = 0;
  clearPending();
  Serial.println(savedRoom.empty() ? "[ENTRY] Enter the 6-digit room code, then press #."
    : "[ENTRY] Enter the 6-digit room code, then press #, or press # right away to rejoin the previous room.");
}

void saveLastRoom() {
  if (roomCode == savedRoom && studentCode == savedStudent) return; // Limits flash writes.
  savedRoom = roomCode;
  savedStudent = studentCode;
  prefs.putString("room", savedRoom.c_str());
  prefs.putString("student", savedStudent.c_str());
}

void handleAck(const std::string &json) {
  if (pending.kind == Pending::None || jsonString(json, "requestId") != pending.requestId) return;
  const bool success = jsonTrue(json, "success");
  const std::string code = jsonString(json, "code");
  const Pending kind = pending.kind;
  const std::string choice = pending.choice;
  Serial.printf("[ACK] %s %s\n", success ? "OK" : "ERROR", code.c_str());
  clearPending();
  if (kind == Pending::Join) {
    if (success) {
      studentCode = entry;
      entry.clear();
      step = Step::Quiz;
      saveLastRoom();
      Serial.printf("[ROOM] Joined room %s with student code %s. Waiting for the teacher to open a question.\n",
        roomCode.c_str(), studentCode.c_str());
    } else if (code == "ROOM_NOT_FOUND" || code == "SESSION_NOT_ACTIVE") {
      showStatus("E3");
      resetToRoomEntry(); // Wrong room code or the room has ended: start over.
    } else {
      showStatus("E3");
    }
  } else if (success) {
    submitted = choice;
    selected.clear();
    Serial.printf("[ANSWER] Submitted %s for question %u. Waiting for the next question.\n", choice.c_str(), questionNumber);
  } else {
    showStatus("E3");
  }
}

void handleRoomState(const std::string &json) {
  if (jsonString(json, "roomCode") != roomCode) return;
  const std::string stamp = jsonString(json, "serverTimestamp");
  if (stamp < lastStateTimestamp) return; // Stale snapshot (ISO timestamps in the same format compare correctly).
  lastStateTimestamp = stamp;
  const std::string status = jsonString(json, "status");
  const size_t question = valueStart(json, "currentQuestion");
  const std::string questionId = question != std::string::npos && json.compare(question, 4, "null") != 0
    ? jsonString(json, "id", question) : "";
  const long index = jsonInteger(json, "currentQuestionIndex");
  questionNumber = index >= 0 ? unsigned(index + 1) : 0;
  // Strings in JSON always escape ", so question text can never match the "type": marker.
  multipleChoice = !questionId.empty() && jsonString(json, "type", question) == "MULTIPLE";
  if (!questionId.empty() && questionId != currentQuestionId) {
    currentQuestionId = questionId;
    selected.clear();
    submitted.clear();
    answerSequence = 0;
    lastActivityMs = millis();
    Serial.printf("[QUESTION] %u: %s\n", questionNumber,
      multipleChoice ? "multiple answers (keys 1-4 toggle each letter)" : "single answer");
  }
  if (status != sessionStatus) {
    sessionStatus = status;
    lastActivityMs = millis();
    if (status == "FINISHED" && step == Step::Quiz && !resultSince) resultSince = millis();
    Serial.printf("[ROOM] %s | question %u/%ld\n", status.c_str(), questionNumber, jsonInteger(json, "totalQuestions"));
  }
}

void handleCommand(const std::string &json) {
  if (jsonString(json, "type") != "RESULT" || jsonString(json, "roomCode") != roomCode) return;
  const long value = jsonInteger(json, "score");
  if (value < 0 || value > 10) return;
  score = int(value);
  selected.clear();
  resultSince = millis();
  Serial.printf("[RESULT] Score %d/10 (correct %ld/%ld). Press * to join another room.\n",
    score, jsonInteger(json, "correct"), jsonInteger(json, "total"));
}

void handleMqttEvent(const MqttEvent &event) {
  if (event.type == EventType::Connected) {
    mqttConnected = true;
    esp_mqtt_client_subscribe(mqtt, deviceTopic("ack").c_str(), 1);
    esp_mqtt_client_subscribe(mqtt, deviceTopic("command").c_str(), 1);
    subscribeRoom();
    if (pending.kind != Pending::None) sendPending();
    Serial.println("[MQTT] Connected.");
    showStatus("On", 600);
  } else if (event.type == EventType::Disconnected) {
    if (mqttConnected) Serial.println("[MQTT] Disconnected; reconnecting.");
    mqttConnected = false;
  } else if (event.topic == deviceTopic("ack")) {
    handleAck(event.payload);
  } else if (event.topic == deviceTopic("command")) {
    handleCommand(event.payload);
  } else if (!roomCode.empty() && (event.topic == roomTopic("state") || event.topic == roomTopic("question"))) {
    handleRoomState(event.payload);
  }
}

void startMqtt() {
  esp_mqtt_client_config_t config = {};
  config.broker.address.hostname = mqttHost.c_str(); // Global string that lives for the whole program.
  config.broker.address.port = MQTT_PORT;
  config.broker.address.transport = MQTT_TRANSPORT_OVER_TCP;
  config.credentials.client_id = deviceId; // ACL: clientId must equal deviceId.
  config.credentials.username = MQTT_USERNAME;
  config.credentials.authentication.password = MQTT_PASSWORD;
  config.session.keepalive = 30;
  config.network.reconnect_timeout_ms = 3000;
  config.buffer.size = 4096;
  mqtt = esp_mqtt_client_init(&config);
  esp_mqtt_client_register_event(mqtt, MQTT_EVENT_ANY, onMqttEvent, nullptr);
  esp_mqtt_client_start(mqtt);
  mqttStarted = true;
  Serial.printf("[MQTT] Connecting to %s:%lu, deviceId=%s\n", mqttHost.c_str(), (unsigned long)MQTT_PORT, deviceId);
}

void beginWifi() {
  WiFi.begin(wifiSsid.c_str(), wifiPassword.c_str());
  WiFi.setTxPower(WIFI_TX_POWER); // Apply after begin: some core versions reset it on connect.
  lastWifiRetryMs = millis();
}

void serviceWifi() {
  if (!wifiStarted) {
    if (wifiSsid.empty() || millis() < WIFI_START_DELAY_MS) return;
    wifiStarted = true;
    wifiDownSince = millis();
    WiFi.mode(WIFI_STA);
    WiFi.setTxPower(WIFI_TX_POWER);
    beginWifi();
    Serial.printf("[WIFI] Connecting to %s...\n", wifiSsid.c_str());
    return;
  }
  const bool online = WiFi.status() == WL_CONNECTED;
  if (online != wifiOnline) {
    wifiOnline = online;
    if (online) {
      wifiDownSince = 0;
      Serial.printf("[WIFI] OK, IP=%s\n", WiFi.localIP().toString().c_str());
      configTime(0, 0, "pool.ntp.org", "time.google.com");
      if (!mqttStarted && !mqttHost.empty()) startMqtt();
    } else {
      wifiDownSince = millis();
      Serial.println("[WIFI] Disconnected.");
    }
  }
  if (!online && uint32_t(millis() - lastWifiRetryMs) >= 10000) {
    WiFi.disconnect();
    beginWifi();
  }
}

void servicePendingRetry() {
  if (pending.kind == Pending::None || uint32_t(millis() - pending.sentAt) < ACK_TIMEOUT_MS) return;
  if (pending.attempts < MAX_SEND_ATTEMPTS) {
    sendPending();
  } else {
    Serial.println("[ACK] Timed out waiting for the server after 3 attempts.");
    clearPending();
    showStatus(mqttConnected ? "E3" : "E2");
  }
}

// ------------------------------ Keys ------------------------------
void enterRoom(const std::string &code) {
  roomCode = code;
  lastStateTimestamp.clear();
  step = Step::Student;
  subscribeRoom();
}

void submitStudent() {
  if (!wifiOnline) showStatus("E1");
  else if (!mqttConnected) showStatus("E2");
  else startPending(Pending::Join, "join", "\"studentCode\":\"" + entry + "\"");
}

// # right on the Ph screen: rejoin the room and student code of the last successful join.
void rejoinSavedRoom() {
  enterRoom(savedRoom);
  entry = savedStudent;
  Serial.printf("[ENTRY] Rejoining room %s with student code %s.\n", roomCode.c_str(), entry.c_str());
  submitStudent(); // No network yet: stay on the Id screen with the old code and press # again.
}

void onEntryKey(char key) {
  const size_t limit = step == Step::Room ? ROOM_CODE_LENGTH : STUDENT_CODE_LENGTH;
  if (key >= '0' && key <= '9') {
    if (entry.size() < limit) entry += key;
  } else if (key == '*') {
    if (!entry.empty()) entry.pop_back();
    else if (step == Step::Student) { // * when empty: go back and fix the room code.
      entry = roomCode;
      unsubscribeRoom();
      roomCode.clear();
      step = Step::Room;
    }
  } else if (key == '#') {
    if (step == Step::Room && entry.empty() && savedRoom.size() == ROOM_CODE_LENGTH
        && savedStudent.size() == STUDENT_CODE_LENGTH) {
      rejoinSavedRoom();
      return;
    }
    if (entry.size() != limit) { showStatus("E4"); return; }
    if (step == Step::Room) {
      enterRoom(entry);
      entry.clear();
      Serial.printf("[ENTRY] Room code %s. Enter the %u-digit student code, then press #.\n",
        roomCode.c_str(), unsigned(STUDENT_CODE_LENGTH));
    } else {
      submitStudent();
    }
  }
}

// The backend only accepts a sequence greater than the last acknowledged one for the same question. Adding the boot count (NVS)
// lets the answer be resubmitted after the ESP32 resets mid-question (weak battery) instead of being rejected with STALE_SEQUENCE.
uint32_t nextSequence() {
  if (answerSequence < 999) ++answerSequence;
  return bootCount * 1000 + answerSequence;
}

void onQuizKey(char key) {
  if (score >= 0 || sessionStatus == "FINISHED") {
    if (key == '*') resetToRoomEntry();
    return;
  }
  const bool active = sessionStatus == "QUESTION_ACTIVE" && !currentQuestionId.empty();
  char letter = 0;
  if (key >= '1' && key <= '4') letter = char('A' + (key - '1')); // Temporary substitute while the A-D column is not wired.
  else if (key >= 'A' && key <= 'D') letter = key;
  if (letter) {
    if (!active) return;
    if (!multipleChoice) { selected.assign(1, letter); return; }
    std::string next; // Toggle one letter, keeping A-D order as the backend requires.
    for (char c = 'A'; c <= 'D'; ++c) {
      const bool on = selected.find(c) != std::string::npos;
      if (c == letter ? !on : on) next += c;
    }
    selected = next;
  } else if (key == '*') {
    selected.clear();
  } else if (key == '#' && !selected.empty()) {
    if (!active) { showStatus("E3"); selected.clear(); return; }
    if (!mqttConnected) { showStatus("E2"); return; }
    startPending(Pending::Answer, "answer", "\"questionId\":\"" + currentQuestionId
      + "\",\"answer\":\"" + selected + "\",\"sequence\":" + std::to_string(nextSequence()), selected);
  }
}

void onKey(char key) {
  Serial.printf("[KEY] %c\n", key);
  lastActivityMs = millis();
  if (pending.kind != Pending::None) return; // Waiting for the ACK.
  if (step == Step::Quiz) onQuizKey(key);
  else onEntryKey(key);
}

void serviceKeys(uint32_t now) {
  if (uint32_t(now - lastScanMs) < 5) return;
  lastScanMs = now;
  const char raw = scanKeypad();
  if (raw != candidate) { candidate = raw; candidateSince = now; }
  if (candidate == stableKey || uint32_t(now - candidateSince) < DEBOUNCE_MS) return;
  stableKey = candidate;
  stableSince = now;
  longPressHandled = false;
  if (mode != Mode::Normal) return;
  if (stableKey == char(0x7f)) Serial.println("[KEY] Several keys at once; press one key at a time.");
  else if (stableKey) onKey(stableKey);
}

void output(uint8_t pin, uint8_t level) {
  pinMode(pin, OUTPUT);
  digitalWrite(pin, level);
}

// ------------------------------ Power ------------------------------
// GPIO13 goes low: QHOLD turns off, C_GATE charges through R_GATE, QPWR turns off after about 1 s and the whole circuit loses power.
void requestPowerOff(const char *reason) {
  if (mode != Mode::Normal) return;
  Serial.printf("[POWER] Powering off: %s.\n", reason);
  mode = Mode::PowerOff;
  powerOffPhase = 1;
  powerOffSince = millis();
  if (step == Step::Quiz && mqttConnected) { // statusSchema: tell the web the device has left the room.
    const std::string payload = "{\"requestId\":\"" + makeUuid() + "\",\"deviceId\":\"" + deviceId
      + "\",\"roomCode\":\"" + roomCode + "\",\"clientTimestamp\":\"" + isoTimestamp() + "\",\"online\":false}";
    esp_mqtt_client_enqueue(mqtt, deviceTopic("status").c_str(), payload.c_str(), payload.size(), 1, 0, true);
  }
}

void servicePowerOff(uint32_t now) {
  if (powerOffPhase == 1) {
    if (uint32_t(now - powerOffSince) < 1500) return; // Show OF and let the offline message go out.
    if (mqttStarted) esp_mqtt_client_stop(mqtt);
    WiFi.disconnect(true);
    WiFi.mode(WIFI_OFF);
    esp_timer_stop(displayTimer);
    digitalWrite(OE, HIGH);
    for (uint8_t pin : DIGITS) digitalWrite(pin, DIGIT_OFF);
    powerOffPhase = 2;
    keysReleasedSince = now;
  } else if (powerOffPhase == 2) {
    // If a key is still held when power drops, its row is selected again through RROW, the WAKE diode opens QPWR and the device switches back on.
    if (scanKeypad()) { keysReleasedSince = now; return; }
    if (uint32_t(now - keysReleasedSince) < 500) return;
    for (uint8_t pin : ROWS) digitalWrite(pin, HIGH); // Deselect every row; stop scanning keys.
    Serial.println("[POWER] GPIO13 low. If USB is still plugged in the ESP32 keeps running and will restart.");
    Serial.flush();
    digitalWrite(HOLD, LOW);
    powerOffPhase = 3;
    powerOffSince = now;
  } else if (uint32_t(now - powerOffSince) > 5000) {
    ESP.restart(); // Still powered (USB): go back to the Ph screen instead of idling.
  }
}

// now is read at the top of loop; since may be written with a later millis() in the same pass (key press, Wi-Fi,
// MQTT message). The signed difference makes since > now mean "not expired yet" instead of wrapping to ~4 billion ms.
bool expired(uint32_t since, uint32_t limit, uint32_t now) {
  return limit && since && int32_t(now - since) >= int32_t(limit);
}

void startConfigPortal();

void servicePower(uint32_t now) {
  if (!longPressHandled && stableKey == '*' && OFF_HOLD_STAR_MS && uint32_t(now - stableSince) >= OFF_HOLD_STAR_MS) {
    longPressHandled = true;
    requestPowerOff("held *");
  } else if (!longPressHandled && stableKey == '0' && step != Step::Quiz
      && uint32_t(now - stableSince) >= CONFIG_HOLD_ZERO_MS) {
    longPressHandled = true;
    startConfigPortal();
  } else if (pending.kind != Pending::None) {
    return; // Waiting for the ACK.
  } else if (expired(resultSince, OFF_AFTER_RESULT_MS, now)) {
    requestPowerOff("score shown");
  } else if (wifiStarted && !wifiOnline && expired(wifiDownSince, OFF_NO_WIFI_MS, now)) {
    showStatus("E1", 1500);
    requestPowerOff("no Wi-Fi");
  } else if (step != Step::Quiz && expired(lastActivityMs, OFF_IDLE_ENTRY_MS, now)) {
    requestPowerOff("no key presses");
  } else if (step == Step::Quiz && expired(lastActivityMs, OFF_IDLE_ROOM_MS, now)) {
    requestPowerOff("no new question");
  }
}

// --------------------------- Setup page ---------------------------
// FNV-1a hash of the 3 default values: if they are edited in the code and reflashed, the old NVS settings are discarded.
uint32_t defaultsHash() {
  uint32_t h = 2166136261u;
  for (const char *text : {WIFI_SSID, WIFI_PASSWORD, MQTT_HOST}) {
    for (const char *c = text;; ++c) {
      h = (h ^ uint8_t(*c)) * 16777619u;
      if (!*c) break;
    }
  }
  return h;
}

void clearSavedNetwork() {
  prefs.remove("ssid"); prefs.remove("pass"); prefs.remove("host"); prefs.remove("defaults");
}

void loadSettings() {
  prefs.begin("classpulse", false);
  bootCount = prefs.getUInt("boot", 0) + 1;
  prefs.putUInt("boot", bootCount);
  savedRoom = prefs.getString("room", "").c_str();
  savedStudent = prefs.getString("student", "").c_str();
  wifiSsid = WIFI_SSID; wifiPassword = WIFI_PASSWORD; mqttHost = MQTT_HOST;
  if (!prefs.isKey("ssid")) return;
  if (prefs.getUInt("defaults", 0) != defaultsHash()) { clearSavedNetwork(); return; }
  wifiSsid = prefs.getString("ssid", "").c_str();
  wifiPassword = prefs.getString("pass", "").c_str();
  mqttHost = prefs.getString("host", "").c_str();
  Serial.println("[CONFIG] Using the Wi-Fi/server saved from the setup page.");
}

std::string htmlEscape(const std::string &text) {
  std::string out;
  for (char c : text) {
    if (c == '&') out += "&amp;";
    else if (c == '<') out += "&lt;";
    else if (c == '>') out += "&gt;";
    else if (c == '"') out += "&quot;";
    else out += c;
  }
  return out;
}

void sendPortalMessage(int code, const char *message) {
  std::string page = "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width\">"
    "<body style=\"font-family:sans-serif;max-width:420px;margin:24px auto;padding:0 16px\"><p>";
  page += message;
  page += "</p>";
  portal->send(code, "text/html; charset=utf-8", page.c_str());
}

void handlePortalPage() {
  std::string page = R"HTML(<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>ClassPulse</title>
<style>body{font-family:sans-serif;max-width:420px;margin:24px auto;padding:0 16px}
label{display:block;margin-top:14px;font-weight:bold}input{width:100%;padding:8px;font-size:16px;box-sizing:border-box}
button{margin-top:18px;padding:10px 16px;font-size:16px}small{color:#555}</style></head><body>
<h2>ClassPulse device setup</h2><p><small>Device ID: )HTML";
  page += deviceId;
  page += R"HTML(</small></p><form method="post" action="/save">
<label>Wi-Fi name (2.4 GHz)</label><input name="ssid" list="nets" required maxlength="32" value=")HTML";
  page += htmlEscape(wifiSsid);
  page += R"HTML("><datalist id="nets">)HTML" + scannedSsids + R"HTML(</datalist>
<label>Wi-Fi password</label><input name="pass" type="password" maxlength="63" placeholder="Leave empty to keep the old password">
<label>IP of the machine running the ClassPulse web</label><input name="host" required maxlength="63" value=")HTML";
  page += htmlEscape(mqttHost);
  page += R"HTML("><small>Find it with hostname -I on the machine running the web.</small><br>
<button type="submit">Save and restart</button></form>
<form method="post" action="/reset"><button type="submit">Use the settings written in the firmware</button></form>
<p><small>Exit without saving: press * on the device.</small></p></body></html>)HTML";
  portal->send(200, "text/html; charset=utf-8", page.c_str());
}

void handlePortalSave() {
  const std::string ssid = portal->arg("ssid").c_str();
  const std::string pass = portal->arg("pass").c_str();
  const std::string host = portal->arg("host").c_str();
  const bool valid = !ssid.empty() && ssid.size() <= 32 && (pass.empty() || (pass.size() >= 8 && pass.size() <= 63))
    && !host.empty() && host.size() <= 63 && host.find_first_of(" /:") == std::string::npos;
  if (!valid) {
    sendPortalMessage(400, "Invalid input: Wi-Fi name 1–32 characters, password 8–63 characters, IP without spaces. "
      "<a href=\"/\">Back</a>");
    return;
  }
  prefs.putString("ssid", ssid.c_str());
  prefs.putString("pass", pass.empty() ? wifiPassword.c_str() : pass.c_str());
  prefs.putString("host", host.c_str());
  prefs.putUInt("defaults", defaultsHash());
  Serial.printf("[CONFIG] Saved Wi-Fi %s, server %s. Restarting.\n", ssid.c_str(), host.c_str());
  sendPortalMessage(200, "Saved. The device restarts and connects to the new Wi-Fi.");
  delay(1500);
  ESP.restart();
}

void handlePortalReset() {
  clearSavedNetwork();
  Serial.println("[CONFIG] Cleared saved settings, using the firmware values. Restarting.");
  sendPortalMessage(200, "Saved settings cleared. The device restarts using the Wi-Fi written in the firmware.");
  delay(1500);
  ESP.restart();
}

// Hold 0 on the Ph/Id screen: the ESP32 broadcasts an open Wi-Fi "ClassPulse-XXXX" and a phone that joins gets the setup page.
void startConfigPortal() {
  mode = Mode::Config;
  configSince = millis();
  entry.clear();
  if (mqttStarted) esp_mqtt_client_stop(mqtt);
  mqttConnected = false;
  WiFi.disconnect(true);
  WiFi.mode(WIFI_AP_STA);
  const int found = WiFi.scanNetworks(); // Takes a few seconds; the LEDs keep scanning thanks to esp_timer.
  scannedSsids.clear();
  for (int i = 0; i < found; ++i) {
    const std::string option = "<option value=\"" + htmlEscape(WiFi.SSID(i).c_str()) + "\">";
    if (WiFi.SSID(i).length() && scannedSsids.find(option) == std::string::npos) scannedSsids += option;
  }
  WiFi.scanDelete();
  char apName[20];
  snprintf(apName, sizeof(apName), "ClassPulse-%s", deviceId + strlen(deviceId) - 4);
  WiFi.softAP(apName);
  WiFi.setTxPower(WIFI_TX_POWER);
  dns = new DNSServer();
  dns->start(53, "*", WiFi.softAPIP());
  portal = new WebServer(80);
  portal->on("/", HTTP_GET, handlePortalPage);
  portal->on("/save", HTTP_POST, handlePortalSave);
  portal->on("/reset", HTTP_POST, handlePortalReset);
  portal->onNotFound([] { // Phones probing connectivity (generate_204...) are redirected to the setup page.
    portal->sendHeader("Location", "http://192.168.4.1/", true);
    portal->send(302, "text/plain", "");
  });
  portal->begin();
  Serial.printf("[CONFIG] Join Wi-Fi %s on your phone (no password) and open http://192.168.4.1\n", apName);
}

void serviceConfig(uint32_t now) {
  dns->processNextRequest();
  portal->handleClient();
  if (stableKey == '*' || uint32_t(now - configSince) >= CONFIG_TIMEOUT_MS) {
    Serial.println("[CONFIG] Exited without saving, restarting.");
    ESP.restart();
  }
}

void setup() {
  output(HOLD, HIGH); // FIRST: take over M2 before initializing peripherals.
  output(OE, HIGH);
  for (uint8_t pin : DIGITS) output(pin, DIGIT_OFF);
  output(DATA, LOW); output(CLK, LOW); output(LATCH, LOW);
  for (uint8_t pin : ROWS) output(pin, HIGH); // All NPNs ON, raw rows LOW.
  for (uint8_t pin : COLS) pinMode(pin, INPUT); // External 100k pull-ups!
  setCpuFrequencyMhz(CPU_MHZ);
  Serial.begin(115200);

  const esp_timer_create_args_t timerArgs = {.callback = refreshDisplay, .name = "display"};
  esp_timer_create(&timerArgs, &displayTimer);
  esp_timer_start_periodic(displayTimer, 2000);
  showStatus("88", 500);

  const uint64_t mac = ESP.getEfuseMac();
  snprintf(deviceId, sizeof(deviceId), "device-%04X%08lX", unsigned(mac >> 32 & 0xffff), (unsigned long)(mac & 0xffffffff));
  mqttEvents = xQueueCreate(16, sizeof(MqttEvent *));

  Serial.printf("\nClassPulse quiz device | deviceId=%s\n", deviceId);
  loadSettings();
  Serial.printf("[POWER] Boot count %lu. Hold * for 3 s to power off; hold 0 for 3 s on the Ph/Id screen to set up Wi-Fi.\n",
    (unsigned long)bootCount);
  Serial.println("LED: Ph=enter room code, Id=enter student code, On=MQTT OK, E1=Wi-Fi, E2=MQTT, E3=server rejected, E4=wrong digit count, CF=setup, OF=power off");
  if (wifiSsid.empty() || mqttHost.empty()) Serial.println("[CONFIG] No Wi-Fi/MQTT_HOST yet: hold key 0 to set up.");
  lastActivityMs = max<uint32_t>(millis(), 1);
  resetToRoomEntry();
}

void loop() {
  const uint32_t now = millis();
  if (mode == Mode::PowerOff) { render(); servicePowerOff(now); return; } // No more key scanning.
  serviceKeys(now);
  if (mode == Mode::Config) { serviceConfig(now); render(); return; }
  MqttEvent *event = nullptr;
  while (xQueueReceive(mqttEvents, &event, 0) == pdTRUE) {
    handleMqttEvent(*event);
    delete event;
  }
  serviceWifi();
  servicePendingRetry();
  servicePower(now);
  render();
}
