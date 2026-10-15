// ClassPulse quiz device: phan cung M2/M5/M6 tren breadboard, classic ESP32-WROOM.
// Wi-Fi + MQTT toi backend ClassPulse bang esp-mqtt co san trong core ESP32 (khong can thu vien ngoai).
// Luong: ma phong 6 so # -> ma sinh vien 2 so # -> chon 1-4 (= A-D) # -> cho cau tiep -> diem.
// Cau MULTIPLE (web/): moi phim 1-4 bat/tat mot chu, # gui khoa chuan nhu "AC".
// Tu tat nguon qua GPIO13 (M2); # o man hinh Ph vao lai phong cu; giu 0 de mo trang cai dat Wi-Fi.
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

// ======================== CAU HINH CAN SUA ========================
// Wi-Fi/MQTT mac dinh. Trang cai dat (giu phim 0) luu gia tri moi vao NVS va duoc uu tien,
// cho toi khi nap firmware co 3 gia tri mac dinh nay khac di.
constexpr char WIFI_SSID[] = "Loading...";      // ESP32 chi ket noi duoc Wi-Fi 2.4 GHz.
constexpr char WIFI_PASSWORD[] = "";  // Dien mat khau Wi-Fi cua ban truoc khi nap
constexpr char MQTT_HOST[] = "10.246.235.139";      // IP LAN cua may chay ClassPulse, KHONG dung localhost.
constexpr uint32_t MQTT_PORT = 1883;
// Credential phat trien cong khai trong README ClassPulse; trien khai that thi provision rieng.
constexpr char MQTT_USERNAME[] = "simulator";
constexpr char MQTT_PASSWORD[] = "simulator-dev-only";
// false: PCB wiring, AO3401A QDIG1/QDIG2 (LOW = ON).
// true: no AO3401A yet, common anodes wired straight to GPIO17/GPIO4 (HIGH = ON).
constexpr bool DIGIT_DIRECT_GPIO = false; // Bo mach in 0322ccc co QDIG1/QDIG2.
// Bo 0322ccc dang chap WAKE_NODE voi COL3: nhan phim cot 1-3 thi COL3 cung len theo qua DWAKE0-2.
// true: bo qua COL3 khi cung hang co phim khac (A-D van dung khi nhan rieng). Het chap thi dat false.
constexpr bool COL3_FOLLOWS_WAKE = true;
// Nguon 2xAAA + boost: giam dong dinh khi phat Wi-Fi (dat hotspot gan thiet bi).
// Khi chay USB co the tra ve WIFI_POWER_19_5dBm va 240 MHz.
constexpr wifi_power_t WIFI_TX_POWER = WIFI_POWER_8_5dBm;
constexpr uint32_t CPU_MHZ = 80;
constexpr uint32_t WIFI_START_DELAY_MS = 1500; // Cho nguon on dinh truoc xung hieu chuan RF.
// Tu tat nguon (ha GPIO13); 0 = khong tat theo dieu kien do.
constexpr uint32_t OFF_AFTER_RESULT_MS = 60000;   // Hien diem (hoac phien ket thuc) xong.
constexpr uint32_t OFF_IDLE_ENTRY_MS = 180000;    // Dang nhap ma phong/ma SV ma khong nhan phim.
constexpr uint32_t OFF_IDLE_ROOM_MS = 1200000;    // Da vao phong, khong co cau moi va khong nhan phim.
constexpr uint32_t OFF_NO_WIFI_MS = 120000;       // Khong vao duoc Wi-Fi lien tuc.
constexpr uint32_t OFF_HOLD_STAR_MS = 3000;       // Giu * de tat chu dong.
constexpr uint32_t CONFIG_HOLD_ZERO_MS = 3000;    // Giu 0 o man hinh Ph/Id de mo trang cai dat.
constexpr uint32_t CONFIG_TIMEOUT_MS = 300000;    // Trang cai dat tu dong lai sau 5 phut.
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
constexpr uint8_t DIGITS[2] = {17, 4};        // LED trai, LED phai
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
std::string selected, submitted; // Khoa dap an chuan: "A", "AC", ...
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

// Cau hinh luu trong NVS va so lan khoi dong (giu sequence tang dan qua cac lan reset).
Preferences prefs;
std::string wifiSsid, wifiPassword, mqttHost, savedRoom, savedStudent;
uint32_t bootCount = 0;

// Nguon: thoi diem hoat dong gan nhat, luc hien diem, luc mat Wi-Fi.
Mode mode = Mode::Normal;
uint32_t lastActivityMs = 0, resultSince = 0, wifiDownSince = 0;
uint32_t powerOffSince = 0, keysReleasedSince = 0;
uint8_t powerOffPhase = 0; // 1: hien OF, gui offline; 2: cho nha phim; 3: da ha GPIO13.
esp_timer_handle_t displayTimer = nullptr;

// Trang cai dat (SoftAP + captive portal).
WebServer *portal = nullptr;
DNSServer *dns = nullptr;
uint32_t configSince = 0;
std::string scannedSsids;

// ---------------------------- Hien thi ----------------------------
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

// Khoa dai hon 2 chu cuon theo cap moi 700 ms: "ABD" -> "Ab", "d ".
void showKey(const std::string &key, uint8_t leftDot, uint8_t rightDot, uint32_t now) {
  if (key.size() == 1) { showChars(' ', answerGlyph(key[0]), leftDot, rightDot); return; }
  const size_t start = now / 700 % ((key.size() + 1) / 2) * 2;
  showChars(answerGlyph(key[start]), start + 1 < key.size() ? answerGlyph(key[start + 1]) : ' ',
    leftDot, rightDot);
}

void render() {
  const uint32_t now = millis();
  if (mode == Mode::Config) { showChars('C', 'F', 0, (now / 500) % 2 ? DP : 0); return; }
  if (int32_t(overlayUntil - now) > 0) { showChars(overlay[0], overlay[1]); return; } // Vd E1 truoc khi tat.
  if (mode == Mode::PowerOff) { showChars('O', 'F'); return; }
  if (step == Step::Room) { showLastTwo(entry, 'P', 'h'); return; }
  if (step == Step::Student) { showLastTwo(entry, 'I', 'd'); return; }
  // Da vao phong: cham trai sang; cham phai nhap nhay khi dang cho ACK.
  const uint8_t waiting = pending.kind != Pending::None && (now / 250) % 2 ? DP : 0;
  const bool active = sessionStatus == "QUESTION_ACTIVE" && !currentQuestionId.empty();
  if (score >= 0) {
    if (score >= 10) showChars('1', '0', DP);
    else showChars(' ', char('0' + score), DP);
  } else if (active && !selected.empty()) {
    showKey(selected, DP, waiting, now);
  } else if (active && !submitted.empty()) {
    showKey(submitted, DP, DP, now); // Da nop, cho cau tiep theo.
  } else if (active) {
    const unsigned n = questionNumber % 100;
    showChars(char('0' + n / 10), char('0' + n % 10), DP, waiting);
  } else {
    showChars('-', '-', DP, waiting);
  }
}

// ----------------------------- Ban phim -----------------------------
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

// ------------------------- JSON toi gian -------------------------
// Backend gui JSON.stringify (khong co khoang trang), du de doc vai truong phang.
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
  // Retry giu nguyen toan bo payload (requestId, sequence, timestamp) theo giao thuc v1.
  ++pending.attempts;
  pending.sentAt = millis();
  if (!mqttConnected) return;
  esp_mqtt_client_enqueue(mqtt, pending.topic.c_str(), pending.payload.c_str(),
    pending.payload.size(), 1, 0, true);
  Serial.printf("[MQTT] Gui lan %u/%u: %s\n", pending.attempts, MAX_SEND_ATTEMPTS, pending.topic.c_str());
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
  Serial.println(savedRoom.empty() ? "[NHAP] Nhap ma phong 6 so roi nhan #."
    : "[NHAP] Nhap ma phong 6 so roi nhan #, hoac nhan # ngay de vao lai phong cu.");
}

void saveLastRoom() {
  if (roomCode == savedRoom && studentCode == savedStudent) return; // Han che ghi flash.
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
  Serial.printf("[ACK] %s %s\n", success ? "OK" : "LOI", code.c_str());
  clearPending();
  if (kind == Pending::Join) {
    if (success) {
      studentCode = entry;
      entry.clear();
      step = Step::Quiz;
      saveLastRoom();
      Serial.printf("[PHONG] Da vao phong %s voi ma SV %s. Cho giao vien mo cau hoi.\n",
        roomCode.c_str(), studentCode.c_str());
    } else if (code == "ROOM_NOT_FOUND" || code == "SESSION_NOT_ACTIVE") {
      showStatus("E3");
      resetToRoomEntry(); // Sai ma phong hoac phong da ket thuc: nhap lai tu dau.
    } else {
      showStatus("E3");
    }
  } else if (success) {
    submitted = choice;
    selected.clear();
    Serial.printf("[TRA LOI] Da nop %s cho cau %u. Cho cau tiep theo.\n", choice.c_str(), questionNumber);
  } else {
    showStatus("E3");
  }
}

void handleRoomState(const std::string &json) {
  if (jsonString(json, "roomCode") != roomCode) return;
  const std::string stamp = jsonString(json, "serverTimestamp");
  if (stamp < lastStateTimestamp) return; // Snapshot cu (ISO cung dinh dang so sanh duoc).
  lastStateTimestamp = stamp;
  const std::string status = jsonString(json, "status");
  const size_t question = valueStart(json, "currentQuestion");
  const std::string questionId = question != std::string::npos && json.compare(question, 4, "null") != 0
    ? jsonString(json, "id", question) : "";
  const long index = jsonInteger(json, "currentQuestionIndex");
  questionNumber = index >= 0 ? unsigned(index + 1) : 0;
  // Chuoi trong JSON luon escape dau ", nen noi dung cau hoi khong khop duoc marker "type":.
  multipleChoice = !questionId.empty() && jsonString(json, "type", question) == "MULTIPLE";
  if (!questionId.empty() && questionId != currentQuestionId) {
    currentQuestionId = questionId;
    selected.clear();
    submitted.clear();
    answerSequence = 0;
    lastActivityMs = millis();
    Serial.printf("[CAU] %u: %s\n", questionNumber,
      multipleChoice ? "nhieu dap an (1-4 bat/tat tung chu)" : "mot dap an");
  }
  if (status != sessionStatus) {
    sessionStatus = status;
    lastActivityMs = millis();
    if (status == "FINISHED" && step == Step::Quiz && !resultSince) resultSince = millis();
    Serial.printf("[PHONG] %s | cau %u/%ld\n", status.c_str(), questionNumber, jsonInteger(json, "totalQuestions"));
  }
}

void handleCommand(const std::string &json) {
  if (jsonString(json, "type") != "RESULT" || jsonString(json, "roomCode") != roomCode) return;
  const long value = jsonInteger(json, "score");
  if (value < 0 || value > 10) return;
  score = int(value);
  selected.clear();
  resultSince = millis();
  Serial.printf("[KET QUA] Diem %d/10 (dung %ld/%ld). Nhan * de vao phong khac.\n",
    score, jsonInteger(json, "correct"), jsonInteger(json, "total"));
}

void handleMqttEvent(const MqttEvent &event) {
  if (event.type == EventType::Connected) {
    mqttConnected = true;
    esp_mqtt_client_subscribe(mqtt, deviceTopic("ack").c_str(), 1);
    esp_mqtt_client_subscribe(mqtt, deviceTopic("command").c_str(), 1);
    subscribeRoom();
    if (pending.kind != Pending::None) sendPending();
    Serial.println("[MQTT] Da ket noi.");
    showStatus("On", 600);
  } else if (event.type == EventType::Disconnected) {
    if (mqttConnected) Serial.println("[MQTT] Mat ket noi; dang tu ket noi lai.");
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
  config.broker.address.hostname = mqttHost.c_str(); // Chuoi toan cuc, song suot chuong trinh.
  config.broker.address.port = MQTT_PORT;
  config.broker.address.transport = MQTT_TRANSPORT_OVER_TCP;
  config.credentials.client_id = deviceId; // ACL: clientId phai trung deviceId.
  config.credentials.username = MQTT_USERNAME;
  config.credentials.authentication.password = MQTT_PASSWORD;
  config.session.keepalive = 30;
  config.network.reconnect_timeout_ms = 3000;
  config.buffer.size = 4096;
  mqtt = esp_mqtt_client_init(&config);
  esp_mqtt_client_register_event(mqtt, MQTT_EVENT_ANY, onMqttEvent, nullptr);
  esp_mqtt_client_start(mqtt);
  mqttStarted = true;
  Serial.printf("[MQTT] Ket noi %s:%lu, deviceId=%s\n", mqttHost.c_str(), (unsigned long)MQTT_PORT, deviceId);
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
    Serial.printf("[WIFI] Dang ket noi %s...\n", wifiSsid.c_str());
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
      Serial.println("[WIFI] Mat ket noi.");
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
    Serial.println("[ACK] Het thoi gian cho server sau 3 lan gui.");
    clearPending();
    showStatus(mqttConnected ? "E3" : "E2");
  }
}

// ------------------------------ Phim ------------------------------
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

// # ngay tai man hinh Ph: vao lai phong va ma SV cua lan vao phong thanh cong gan nhat.
void rejoinSavedRoom() {
  enterRoom(savedRoom);
  entry = savedStudent;
  Serial.printf("[NHAP] Vao lai phong %s voi ma SV %s.\n", roomCode.c_str(), entry.c_str());
  submitStudent(); // Chua co mang thi o lai man hinh Id voi ma cu, nhan # lan nua.
}

void onEntryKey(char key) {
  const size_t limit = step == Step::Room ? ROOM_CODE_LENGTH : STUDENT_CODE_LENGTH;
  if (key >= '0' && key <= '9') {
    if (entry.size() < limit) entry += key;
  } else if (key == '*') {
    if (!entry.empty()) entry.pop_back();
    else if (step == Step::Student) { // * khi trong: quay lai sua ma phong.
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
      Serial.printf("[NHAP] Ma phong %s. Nhap ma sinh vien %u so roi nhan #.\n",
        roomCode.c_str(), unsigned(STUDENT_CODE_LENGTH));
    } else {
      submitStudent();
    }
  }
}

// Backend chi nhan sequence lon hon lan da xac nhan cua cung cau. Cong them so lan khoi dong (NVS)
// de nop lai duoc sau khi ESP32 reset giua cau (pin yeu), thay vi bi STALE_SEQUENCE.
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
  if (key >= '1' && key <= '4') letter = char('A' + (key - '1')); // Tam thay cot A-D chua lap.
  else if (key >= 'A' && key <= 'D') letter = key;
  if (letter) {
    if (!active) return;
    if (!multipleChoice) { selected.assign(1, letter); return; }
    std::string next; // Bat/tat mot chu, giu thu tu A-D nhu backend yeu cau.
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
  if (pending.kind != Pending::None) return; // Dang cho ACK.
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
  if (stableKey == char(0x7f)) Serial.println("[KEY] Nhieu phim cung luc; bam tung phim mot.");
  else if (stableKey) onKey(stableKey);
}

void output(uint8_t pin, uint8_t level) {
  pinMode(pin, OUTPUT);
  digitalWrite(pin, level);
}

// ------------------------------ Nguon ------------------------------
// GPIO13 xuong thap: QHOLD tat, C_GATE nap qua R_GATE, QPWR tat sau khoang 1 s, ca mach mat nguon.
void requestPowerOff(const char *reason) {
  if (mode != Mode::Normal) return;
  Serial.printf("[NGUON] Tat may: %s.\n", reason);
  mode = Mode::PowerOff;
  powerOffPhase = 1;
  powerOffSince = millis();
  if (step == Step::Quiz && mqttConnected) { // statusSchema: bao web thiet bi da roi phong.
    const std::string payload = "{\"requestId\":\"" + makeUuid() + "\",\"deviceId\":\"" + deviceId
      + "\",\"roomCode\":\"" + roomCode + "\",\"clientTimestamp\":\"" + isoTimestamp() + "\",\"online\":false}";
    esp_mqtt_client_enqueue(mqtt, deviceTopic("status").c_str(), payload.c_str(), payload.size(), 1, 0, true);
  }
}

void servicePowerOff(uint32_t now) {
  if (powerOffPhase == 1) {
    if (uint32_t(now - powerOffSince) < 1500) return; // Hien OF va cho ban tin offline di.
    if (mqttStarted) esp_mqtt_client_stop(mqtt);
    WiFi.disconnect(true);
    WiFi.mode(WIFI_OFF);
    esp_timer_stop(displayTimer);
    digitalWrite(OE, HIGH);
    for (uint8_t pin : DIGITS) digitalWrite(pin, DIGIT_OFF);
    powerOffPhase = 2;
    keysReleasedSince = now;
  } else if (powerOffPhase == 2) {
    // Con giu phim luc mat nguon thi hang duoc chon lai qua RROW, diode WAKE mo QPWR va may bat lai.
    if (scanKeypad()) { keysReleasedSince = now; return; }
    if (uint32_t(now - keysReleasedSince) < 500) return;
    for (uint8_t pin : ROWS) digitalWrite(pin, HIGH); // Bo chon moi hang, khong quet phim nua.
    Serial.println("[NGUON] Ha GPIO13. Con cam USB thi ESP32 van chay va se khoi dong lai.");
    Serial.flush();
    digitalWrite(HOLD, LOW);
    powerOffPhase = 3;
    powerOffSince = now;
  } else if (uint32_t(now - powerOffSince) > 5000) {
    ESP.restart(); // Van con nguon (USB): quay lai man hinh Ph thay vi dung im.
  }
}

// now lay o dau loop; since co the duoc ghi bang millis() muon hon trong cung vong (nhan phim, Wi-Fi,
// ban tin MQTT). Hieu so co dau de since > now la "chua het gio", khong tran thanh ~4 ty ms.
bool expired(uint32_t since, uint32_t limit, uint32_t now) {
  return limit && since && int32_t(now - since) >= int32_t(limit);
}

void startConfigPortal();

void servicePower(uint32_t now) {
  if (!longPressHandled && stableKey == '*' && OFF_HOLD_STAR_MS && uint32_t(now - stableSince) >= OFF_HOLD_STAR_MS) {
    longPressHandled = true;
    requestPowerOff("giu phim *");
  } else if (!longPressHandled && stableKey == '0' && step != Step::Quiz
      && uint32_t(now - stableSince) >= CONFIG_HOLD_ZERO_MS) {
    longPressHandled = true;
    startConfigPortal();
  } else if (pending.kind != Pending::None) {
    return; // Dang cho ACK.
  } else if (expired(resultSince, OFF_AFTER_RESULT_MS, now)) {
    requestPowerOff("da hien diem");
  } else if (wifiStarted && !wifiOnline && expired(wifiDownSince, OFF_NO_WIFI_MS, now)) {
    showStatus("E1", 1500);
    requestPowerOff("khong vao duoc Wi-Fi");
  } else if (step != Step::Quiz && expired(lastActivityMs, OFF_IDLE_ENTRY_MS, now)) {
    requestPowerOff("khong nhan phim");
  } else if (step == Step::Quiz && expired(lastActivityMs, OFF_IDLE_ROOM_MS, now)) {
    requestPowerOff("khong co cau hoi moi");
  }
}

// --------------------------- Trang cai dat ---------------------------
// FNV-1a cua 3 gia tri mac dinh: sua chung trong code roi nap lai thi bo cau hinh NVS cu.
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
  Serial.println("[CAU HINH] Dung Wi-Fi/server da luu tu trang cai dat.");
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
  std::string page = R"HTML(<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>ClassPulse</title>
<style>body{font-family:sans-serif;max-width:420px;margin:24px auto;padding:0 16px}
label{display:block;margin-top:14px;font-weight:bold}input{width:100%;padding:8px;font-size:16px;box-sizing:border-box}
button{margin-top:18px;padding:10px 16px;font-size:16px}small{color:#555}</style></head><body>
<h2>Cài đặt thiết bị ClassPulse</h2><p><small>Mã thiết bị: )HTML";
  page += deviceId;
  page += R"HTML(</small></p><form method="post" action="/save">
<label>Tên Wi-Fi (2,4 GHz)</label><input name="ssid" list="nets" required maxlength="32" value=")HTML";
  page += htmlEscape(wifiSsid);
  page += R"HTML("><datalist id="nets">)HTML" + scannedSsids + R"HTML(</datalist>
<label>Mật khẩu Wi-Fi</label><input name="pass" type="password" maxlength="63" placeholder="Để trống: giữ mật khẩu cũ">
<label>IP máy chạy web ClassPulse</label><input name="host" required maxlength="63" value=")HTML";
  page += htmlEscape(mqttHost);
  page += R"HTML("><small>Xem bằng lệnh hostname -I trên máy chạy web.</small><br>
<button type="submit">Lưu và khởi động lại</button></form>
<form method="post" action="/reset"><button type="submit">Dùng lại cài đặt ghi trong firmware</button></form>
<p><small>Thoát không lưu: nhấn phím * trên thiết bị.</small></p></body></html>)HTML";
  portal->send(200, "text/html; charset=utf-8", page.c_str());
}

void handlePortalSave() {
  const std::string ssid = portal->arg("ssid").c_str();
  const std::string pass = portal->arg("pass").c_str();
  const std::string host = portal->arg("host").c_str();
  const bool valid = !ssid.empty() && ssid.size() <= 32 && (pass.empty() || (pass.size() >= 8 && pass.size() <= 63))
    && !host.empty() && host.size() <= 63 && host.find_first_of(" /:") == std::string::npos;
  if (!valid) {
    sendPortalMessage(400, "Dữ liệu không hợp lệ: tên Wi-Fi 1–32 ký tự, mật khẩu 8–63 ký tự, IP không có dấu cách. "
      "<a href=\"/\">Quay lại</a>");
    return;
  }
  prefs.putString("ssid", ssid.c_str());
  prefs.putString("pass", pass.empty() ? wifiPassword.c_str() : pass.c_str());
  prefs.putString("host", host.c_str());
  prefs.putUInt("defaults", defaultsHash());
  Serial.printf("[CAU HINH] Da luu Wi-Fi %s, server %s. Khoi dong lai.\n", ssid.c_str(), host.c_str());
  sendPortalMessage(200, "Đã lưu. Thiết bị khởi động lại và kết nối Wi-Fi mới.");
  delay(1500);
  ESP.restart();
}

void handlePortalReset() {
  clearSavedNetwork();
  Serial.println("[CAU HINH] Xoa cai dat da luu, dung gia tri trong firmware. Khoi dong lai.");
  sendPortalMessage(200, "Đã xóa cài đặt đã lưu. Thiết bị dùng Wi-Fi ghi trong firmware và khởi động lại.");
  delay(1500);
  ESP.restart();
}

// Giu 0 o man hinh Ph/Id: ESP32 phat Wi-Fi mo "ClassPulse-XXXX", dien thoai vao se bat trang cai dat.
void startConfigPortal() {
  mode = Mode::Config;
  configSince = millis();
  entry.clear();
  if (mqttStarted) esp_mqtt_client_stop(mqtt);
  mqttConnected = false;
  WiFi.disconnect(true);
  WiFi.mode(WIFI_AP_STA);
  const int found = WiFi.scanNetworks(); // Vai giay; LED van quet nho esp_timer.
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
  portal->onNotFound([] { // Dien thoai kiem tra mang (generate_204...) -> chuyen ve trang cai dat.
    portal->sendHeader("Location", "http://192.168.4.1/", true);
    portal->send(302, "text/plain", "");
  });
  portal->begin();
  Serial.printf("[CAU HINH] Dien thoai vao Wi-Fi %s (khong mat khau), mo http://192.168.4.1\n", apName);
}

void serviceConfig(uint32_t now) {
  dns->processNextRequest();
  portal->handleClient();
  if (stableKey == '*' || uint32_t(now - configSince) >= CONFIG_TIMEOUT_MS) {
    Serial.println("[CAU HINH] Thoat khong luu, khoi dong lai.");
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
  Serial.printf("[NGUON] Lan khoi dong %lu. Giu * 3 s de tat; giu 0 3 s o man hinh Ph/Id de cai dat Wi-Fi.\n",
    (unsigned long)bootCount);
  Serial.println("LED: Ph=nhap ma phong, Id=nhap ma SV, On=MQTT OK, E1=Wi-Fi, E2=MQTT, E3=server tu choi, E4=sai so chu so, CF=cai dat, OF=tat");
  if (wifiSsid.empty() || mqttHost.empty()) Serial.println("[CAU HINH] Chua co Wi-Fi/MQTT_HOST: giu phim 0 de cai dat.");
  lastActivityMs = max<uint32_t>(millis(), 1);
  resetToRoomEntry();
}

void loop() {
  const uint32_t now = millis();
  if (mode == Mode::PowerOff) { render(); servicePowerOff(now); return; } // Khong quet phim nua.
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
