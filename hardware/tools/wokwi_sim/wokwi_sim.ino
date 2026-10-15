// Quiz remote: quet phim 4x4, hien so phim (01..16) tren 2 LED 7 thanh, tu tat sau 10 s.
// Chan GPIO giong schematic. Khac biet duy nhat giua Wokwi va board that la cuc tinh chan chon so:
// board that dung P-MOSFET (LOW = sang), Wokwi noi thang vao anode chung (HIGH = sang).
#define WOKWI 1          // doi thanh 0 khi nap vao board that

const int HOLD = 13, DATA = 23, CLK = 18, LATCH = 19, OE = 16;
const int ROW[4] = {25, 26, 27, 22};   // LOW = chon hang
const int COL[4] = {32, 33, 34, 35};   // doc LOW = co phim
const int DIG[2] = {17, 4};            // DS1 (chuc), DS2 (don vi)
const int DIG_ON = WOKWI ? HIGH : LOW;
const int SETTLE_US = 200;             // cho hang/cot on dinh; board that co the can tang
const unsigned long IDLE_MS = 10000;
// bit0..bit6 = thanh A..G (QA..QG), 1 = sang; khi xuat ra thi dao lai vi thanh sang o muc LOW
const byte SEG[10] = {0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F};

int shown = 0;
unsigned long lastKey = 0;

void setup() {
  pinMode(HOLD, OUTPUT);
  digitalWrite(HOLD, HIGH);            // viec dau tien: tu giu nguon
  for (int i = 0; i < 4; i++) { pinMode(ROW[i], OUTPUT); digitalWrite(ROW[i], HIGH); pinMode(COL[i], INPUT); }
  for (int i = 0; i < 2; i++) { pinMode(DIG[i], OUTPUT); digitalWrite(DIG[i], !DIG_ON); }
  pinMode(DATA, OUTPUT); pinMode(CLK, OUTPUT); pinMode(LATCH, OUTPUT);
  pinMode(OE, OUTPUT); digitalWrite(OE, LOW);
  Serial.begin(115200);
}

int scan() {                           // tra ve 0..15, hoac -1 neu khong co phim
  int hit = -1;
  for (int r = 0; r < 4; r++) {
    digitalWrite(ROW[r], LOW);
    delayMicroseconds(SETTLE_US);
    for (int c = 0; c < 4; c++) if (digitalRead(COL[c]) == LOW) hit = r * 4 + c;
    digitalWrite(ROW[r], HIGH);
  }
  return hit;
}

void show(int d, int n) {
  digitalWrite(DIG[0], !DIG_ON); digitalWrite(DIG[1], !DIG_ON);
  digitalWrite(LATCH, LOW);
  shiftOut(DATA, CLK, MSBFIRST, (byte)~SEG[n]);
  digitalWrite(LATCH, HIGH);
  digitalWrite(DIG[d], DIG_ON);
  delay(2);
}

void loop() {
  int k = scan();
  if (k >= 0) {
    if (shown != k + 1) Serial.printf("phim %d\n", k + 1);
    shown = k + 1;
    lastKey = millis();
  }
  if (shown) { show(0, shown / 10); show(1, shown % 10); }
  if (millis() - lastKey > IDLE_MS) {  // het gio: tat hien thi, nha PWR_HOLD, ngu
    digitalWrite(OE, HIGH);
    digitalWrite(DIG[0], !DIG_ON); digitalWrite(DIG[1], !DIG_ON);
    Serial.println("tat nguon");
    Serial.flush();
    digitalWrite(HOLD, LOW);
    if (WOKWI) {                       // Wokwi khong co mach danh thuc: gia lap "bam phim -> co nguon lai"
      while (scan() < 0) delay(20);
      digitalWrite(HOLD, HIGH);
      digitalWrite(OE, LOW);
      shown = 0;
      lastKey = millis();
      return;
    }
    esp_deep_sleep_start();          // tranh tu chot lai khi nguon dang sut
  }
}
