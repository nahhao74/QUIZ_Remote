// Diagnostic sketch for the actual M2/M5/M6 schematic, classic ESP32-WROOM.
// Not the four-digit 74HC595 module sketch. No external libraries required.
#include <Arduino.h>
#include <WiFi.h>

constexpr bool KEYPAD_AT_BOOT = false; // Set true AFTER the M5 wiring is complete.
constexpr bool WIFI_AT_BOOT = false;
constexpr char WIFI_SSID[] = "";       // Your 2.4 GHz network, optional.
constexpr char WIFI_PASSWORD[] = "";
constexpr uint16_t ROW_SETTLE_US = 200;
constexpr uint8_t HOLD = 13, OE = 16, CLK = 18, LATCH = 19, DATA = 23;
constexpr uint8_t DIGITS[2] = {17, 4};
// false: PCB wiring, AO3401A QDIG1/QDIG2 (LOW = ON).
// true: no AO3401A yet, common anodes wired straight to GPIO17/GPIO4 (HIGH = ON).
constexpr bool DIGIT_DIRECT_GPIO = true;
constexpr uint8_t DIGIT_ON = DIGIT_DIRECT_GPIO ? HIGH : LOW;
constexpr uint8_t DIGIT_OFF = DIGIT_DIRECT_GPIO ? LOW : HIGH;
constexpr uint8_t ROWS[4] = {25, 26, 27, 22};
constexpr uint8_t COLS[4] = {32, 33, 34, 35};
// Board 0322ccc has WAKE_NODE shorted to COL3: pressing a key in columns 1-3 also raises COL3 through DWAKE0-2.
// true: ignore COL3 when another key in the same row is pressed (A-D still work when pressed alone). Set false once the short is fixed.
constexpr bool COL3_FOLLOWS_WAKE = true;
constexpr char KEYS[4][4] = {
  {'1','2','3','A'}, {'4','5','6','B'},
  {'7','8','9','C'}, {'*','0','#','D'}
};
constexpr uint8_t NUMBERS[10] = {
  0x3f,0x06,0x5b,0x4f,0x66,0x6d,0x7d,0x07,0x7f,0x6f
}; // bit0=A ... bit6=G, bit7=DP; a set bit means illuminated.

uint8_t frame[2] = {0x06, 0x5b}; // 12
bool keypadEnabled = KEYPAD_AT_BOOT;
uint8_t displayDigit = 0;
uint32_t lastDisplayUs = 0, lastScanMs = 0;
char candidate = 0, stableKey = 0;
uint32_t candidateSince = 0, starSince = 0;
bool starDown = false, wifiOnline = false;
bool shutdownPending = false, releasing = false, powerReleased = false;
uint32_t shutdownSince = 0, releasedSince = 0;
bool releaseTimerRunning = false;

void output(uint8_t pin, uint8_t level) {
  pinMode(pin, OUTPUT);
  digitalWrite(pin, level);
}

void blankOutputs() {
  digitalWrite(OE, HIGH);
  for (uint8_t pin : DIGITS) digitalWrite(pin, DIGIT_OFF);
}

void refreshDisplay() {
  if (powerReleased || releasing) return;
  const uint32_t now = micros();
  if (uint32_t(now - lastDisplayUs) < 2000) return;
  lastDisplayUs = now;
  blankOutputs();
  digitalWrite(LATCH, LOW);
  shiftOut(DATA, CLK, MSBFIRST, uint8_t(~frame[displayDigit]));
  digitalWrite(LATCH, HIGH);
  digitalWrite(DIGITS[displayDigit], DIGIT_ON);
  digitalWrite(OE, LOW);
  displayDigit ^= 1;
}

void allRows(uint8_t level) {
  for (uint8_t pin : ROWS) digitalWrite(pin, level);
}

char scanKeypad() {
  char result = 0;
  uint8_t count = 0;
  allRows(HIGH); // All NPNs ON, raw rows LOW.
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

void requestShutdown() {
  if (shutdownPending || powerReleased) return;
  shutdownPending = true;
  shutdownSince = millis();
  Serial.println("[POWER] Powering off in 5 seconds; release the key. A battery-power test needs the USB cable unplugged.");
}

void serviceKeys(uint32_t now) {
  if (!keypadEnabled || shutdownPending || uint32_t(now-lastScanMs) < 5) return;
  lastScanMs = now;
  const char raw = scanKeypad();
  if (raw != candidate) { candidate = raw; candidateSince = now; }
  if (candidate != stableKey && uint32_t(now-candidateSince) >= 35) {
    stableKey = candidate;
    starDown = stableKey == '*';
    if (starDown) starSince = now;
    if (stableKey == char(0x7f)) {
      Serial.println("[KEY] Several keys or an invalid signal; try one key at a time.");
    } else if (stableKey) {
      uint8_t number = 0;
      if (stableKey >= '0' && stableKey <= '9') number = stableKey - '0';
      else if (stableKey >= 'A' && stableKey <= 'D') number = 10 + stableKey - 'A';
      else number = stableKey == '*' ? 14 : 15;
      frame[0] = NUMBERS[number / 10]; frame[1] = NUMBERS[number % 10];
      Serial.printf("[KEY] %c -> %02u\n", stableKey, unsigned(number));
    }
  }
  if (starDown && uint32_t(now-starSince) >= 3000) requestShutdown();
}

void startWifi() {
  if (!WIFI_SSID[0]) {
    Serial.println("[WIFI] Fill in WIFI_SSID/WIFI_PASSWORD in the sketch first.");
    return;
  }
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false); // Diagnostic mode, not optimized for battery life.
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.println("[WIFI] Connecting; watch for resets and measure the supply under load.");
}

void serviceShutdown(uint32_t now) {
  if (!shutdownPending || powerReleased) return;
  if (!releasing && uint32_t(now-shutdownSince) >= 5000) {
    releasing = true;
    blankOutputs();
    WiFi.mode(WIFI_OFF);
    allRows(LOW); // All raw rows HIGH: detect any held wake key.
    Serial.println("[POWER] Waiting for all keys to be released, then driving GPIO13 low.");
    return; // Allow columns to settle before checking release.
  }
  if (!releasing) return;
  bool released = true;
  if (keypadEnabled) for (uint8_t pin : COLS) {
    if (digitalRead(pin) == LOW) released = false;
  }
  if (!released) { releaseTimerRunning = false; return; }
  if (!releaseTimerRunning) { releasedSince = now; releaseTimerRunning = true; }
  if (uint32_t(now-releasedSince) < 500) return;
  Serial.println("[POWER] GPIO13 LOW. If USB is still plugged in the ESP32 stays powered.");
  Serial.flush();
  digitalWrite(HOLD, LOW);
  powerReleased = true; // Never reassert HOLD until an actual reboot.
}

void menu() {
  Serial.println("PCB M2/M5/M6: 1=8 left; 2=8 right; 3=88; 4=12; 0=blank");
  Serial.println("s=step through segments A..G,DP on both digits; k=keypad on/off");
  Serial.println("w=WiFi; x=power off after 5s; *=hold 3s to request power off; m=menu");
}

void command(char ch) {
  switch (ch) {
    case '0': frame[0]=frame[1]=0; break;
    case '1': frame[0]=0x7f; frame[1]=0; break;
    case '2': frame[0]=0; frame[1]=0x7f; break;
    case '3': frame[0]=frame[1]=0x7f; break;
    case '4': frame[0]=NUMBERS[1]; frame[1]=NUMBERS[2]; break;
    case 's': {
      static uint8_t segment = 0;
      frame[0]=frame[1]=uint8_t(1U << segment);
      if (segment == 7) Serial.println("[SEG] DP");
      else Serial.printf("[SEG] %c\n", "ABCDEFG"[segment]);
      segment = (segment + 1) & 7U;
      break;
    }
    case 'k':
      keypadEnabled = !keypadEnabled;
      candidate = stableKey = 0; starDown = false;
      Serial.printf("[KEYPAD] %s\n", keypadEnabled ? "ON" : "OFF");
      break;
    case 'w': startWifi(); break;
    case 'x': requestShutdown(); break;
    case 'm': menu(); break;
    default: break;
  }
}

void setup() {
  output(HOLD, HIGH); // FIRST: take over M2 before initializing peripherals.
  output(OE, HIGH);
  for (uint8_t pin : DIGITS) output(pin, DIGIT_OFF);
  output(DATA, LOW); output(CLK, LOW); output(LATCH, LOW);
  for (uint8_t pin : ROWS) output(pin, HIGH);
  for (uint8_t pin : COLS) pinMode(pin, INPUT); // External 100k pull-ups!
  shiftOut(DATA, CLK, MSBFIRST, 0xff);
  digitalWrite(LATCH, HIGH);
  Serial.begin(115200);
  Serial.println("\nPCB breadboard test: HOLD13, ROW25/26/27/22, COL32/33/34/35");
  menu();
  if (WIFI_AT_BOOT) startWifi();
}

void loop() {
  if (powerReleased) return;
  refreshDisplay();
  const uint32_t now = millis();
  while (Serial.available()) {
    const char ch = char(Serial.read());
    if (!shutdownPending) command(ch);
  }
  serviceKeys(now);
  serviceShutdown(now);
  if (!shutdownPending) {
    const bool online = WiFi.status() == WL_CONNECTED;
    if (online != wifiOnline) {
      wifiOnline = online;
      Serial.println(online ? "[WIFI] ONLINE" : "[WIFI] OFFLINE");
    }
  }
}
