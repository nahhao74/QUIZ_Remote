// Keypad M5 -> 2 LED 7 doan M6 (74HC595 + 2 digit), classic ESP32-WROOM.
// Phim 0-9 day vao tu ben phai (bam 1 roi 2 -> "12"); A-D hien A b C d; * xoa ve "--".
// No external libraries required.
#include <Arduino.h>

// false: PCB wiring, AO3401A QDIG1/QDIG2 (LOW = ON).
// true: no AO3401A yet, common anodes wired straight to GPIO17/GPIO4 (HIGH = ON).
constexpr bool DIGIT_DIRECT_GPIO = false; // Bo mach in 0322ccc co QDIG1/QDIG2.
constexpr uint8_t DIGIT_ON = DIGIT_DIRECT_GPIO ? HIGH : LOW;
constexpr uint8_t DIGIT_OFF = DIGIT_DIRECT_GPIO ? LOW : HIGH;

constexpr uint16_t ROW_SETTLE_US = 200;
constexpr uint32_t DEBOUNCE_MS = 35;
constexpr uint8_t HOLD = 13, OE = 16, CLK = 18, LATCH = 19, DATA = 23;
constexpr uint8_t DIGITS[2] = {17, 4};        // LED trai, LED phai
constexpr uint8_t ROWS[4] = {25, 26, 27, 22};
constexpr uint8_t COLS[4] = {32, 33, 34, 35};
// Bo 0322ccc dang chap WAKE_NODE voi COL3: nhan phim cot 1-3 thi COL3 cung len theo qua DWAKE0-2.
// true: bo qua COL3 khi cung hang co phim khac (A-D van dung khi nhan rieng). Het chap thi dat false.
constexpr bool COL3_FOLLOWS_WAKE = true;
constexpr char KEYS[4][4] = {
  {'1','2','3','A'}, {'4','5','6','B'},
  {'7','8','9','C'}, {'*','0','#','D'}
};
// bit0=A ... bit6=G, bit7=DP; a set bit means illuminated.
constexpr uint8_t NUMBERS[10] = {
  0x3f,0x06,0x5b,0x4f,0x66,0x6d,0x7d,0x07,0x7f,0x6f
};
constexpr uint8_t LETTERS[4] = {0x77, 0x7c, 0x39, 0x5e}; // A b C d
constexpr uint8_t BLANK = 0x00, DASH = 0x40;

uint8_t frame[2] = {DASH, DASH};
bool typingNumber = false;
uint8_t displayDigit = 0;
uint32_t lastDisplayUs = 0, lastScanMs = 0;
char candidate = 0, stableKey = 0;
uint32_t candidateSince = 0;

void output(uint8_t pin, uint8_t level) {
  pinMode(pin, OUTPUT);
  digitalWrite(pin, level);
}

void refreshDisplay() {
  const uint32_t now = micros();
  if (uint32_t(now - lastDisplayUs) < 2000) return;
  lastDisplayUs = now;
  digitalWrite(OE, HIGH);
  for (uint8_t pin : DIGITS) digitalWrite(pin, DIGIT_OFF);
  digitalWrite(LATCH, LOW);
  shiftOut(DATA, CLK, MSBFIRST, uint8_t(~frame[displayDigit])); // Segment ON = LOW.
  digitalWrite(LATCH, HIGH);
  digitalWrite(DIGITS[displayDigit], DIGIT_ON);
  digitalWrite(OE, LOW);
  displayDigit ^= 1;
}

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

void onKey(char key) {
  if (key >= '0' && key <= '9') {
    frame[0] = typingNumber ? frame[1] : BLANK;
    frame[1] = NUMBERS[key - '0'];
    typingNumber = true;
  } else if (key >= 'A' && key <= 'D') {
    frame[0] = BLANK;
    frame[1] = LETTERS[key - 'A'];
    typingNumber = false;
  } else if (key == '*') {
    frame[0] = frame[1] = DASH;
    typingNumber = false;
  }
  Serial.printf("[KEY] %c\n", key);
}

void serviceKeys(uint32_t now) {
  if (uint32_t(now - lastScanMs) < 5) return;
  lastScanMs = now;
  const char raw = scanKeypad();
  if (raw != candidate) { candidate = raw; candidateSince = now; }
  if (candidate == stableKey || uint32_t(now - candidateSince) < DEBOUNCE_MS) return;
  stableKey = candidate;
  if (stableKey == char(0x7f)) {
    Serial.println("[KEY] Nhieu phim cung luc; bam tung phim mot.");
  } else if (stableKey) {
    onKey(stableKey);
  }
}

void setup() {
  output(HOLD, HIGH); // FIRST: take over M2 before initializing peripherals.
  output(OE, HIGH);
  for (uint8_t pin : DIGITS) output(pin, DIGIT_OFF);
  output(DATA, LOW); output(CLK, LOW); output(LATCH, LOW);
  for (uint8_t pin : ROWS) output(pin, HIGH); // All NPNs ON, raw rows LOW.
  for (uint8_t pin : COLS) pinMode(pin, INPUT); // External 100k pull-ups!
  Serial.begin(115200);
  Serial.println("\nKeypad -> 2 LED: 0-9 day vao tu phai; A-D hien chu; * xoa");
}

void loop() {
  refreshDisplay();
  serviceKeys(millis());
}
