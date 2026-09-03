/**
 * BLE protocol for Colmi/Yawell RF03-family smart rings (R02/R03/R06/R10,
 * QRing app rebrands such as the Anko smart ring).
 *
 * Sources (reverse engineering):
 *  - https://github.com/tahnok/colmi_r02_client
 *  - Gadgetbridge YawellRingDeviceSupport / YawellRingPacketHandler (AGPL docs of the wire format)
 *  - https://colmi.puxtril.com/
 *
 * Two channels:
 *  V1 "UART" service — fixed 16-byte packets, last byte = sum of first 15 & 0xFF.
 *  V2 "big data" service — variable length: [0xBC, type, len u16 LE, crc16modbus u16 LE, payload].
 */

import type {
  ActivityBucket,
  BatteryInfo,
  SleepPhase,
  SleepSession,
  SleepStage,
  Spo2Hour,
} from "../types";

// ---------------------------------------------------------------- UUIDs

export const SERVICE_V1 = "6e40fff0-b5a3-f393-e0a9-e50e24dcca9e";
export const CHAR_WRITE = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
export const CHAR_NOTIFY_V1 = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

export const SERVICE_V2 = "de5bf728-d711-4e47-af26-65e3012a5dc7";
export const CHAR_COMMAND_V2 = "de5bf72a-d711-4e47-af26-65e3012a5dc7";
export const CHAR_NOTIFY_V2 = "de5bf729-d711-4e47-af26-65e3012a5dc7";

// ---------------------------------------------------------------- commands

export const CMD = {
  SET_TIME: 0x01,
  BATTERY: 0x03,
  PHONE_NAME: 0x04,
  SYNC_HEART_RATE: 0x15,
  AUTO_HR_PREF: 0x16,
  GOALS: 0x21,
  AUTO_SPO2_PREF: 0x2c,
  SYNC_ACTIVITY: 0x43,
  FIND_DEVICE: 0x50,
  START_REAL_TIME: 0x69,
  STOP_REAL_TIME: 0x6a,
  NOTIFICATION: 0x73,
  BIG_DATA_V2: 0xbc,
} as const;

export const BIG_DATA = {
  SLEEP: 0x27,
  SPO2: 0x2a,
} as const;

export const REALTIME = {
  HEART_RATE: 1,
  SPO2: 3,
} as const;

export const REALTIME_ACTION = {
  START: 1,
  PAUSE: 2,
  CONTINUE: 3,
  STOP: 4,
} as const;

// ---------------------------------------------------------------- helpers

export function hex(data: Uint8Array): string {
  return Array.from(data, (b) => b.toString(16).padStart(2, "0")).join(" ");
}

function byteToBcd(b: number): number {
  return ((Math.floor(b / 10) & 0xf) << 4) | b % 10;
}

function bcdToDecimal(b: number): number {
  return ((b >> 4) & 0xf) * 10 + (b & 0xf);
}

function u16le(lo: number, hi: number): number {
  return (lo & 0xff) | ((hi & 0xff) << 8);
}

/** Local date as "YYYY-MM-DD". */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------- V1 packets

/** Build a 16-byte V1 packet: command byte, up to 14 payload bytes, checksum. */
export function makePacket(command: number, subData?: ArrayLike<number>): Uint8Array {
  const packet = new Uint8Array(16);
  packet[0] = command;
  if (subData) {
    if (subData.length > 14) throw new Error("sub data must be <= 14 bytes");
    packet.set(Array.from(subData), 1);
  }
  let sum = 0;
  for (let i = 0; i < 15; i++) sum += packet[i];
  packet[15] = sum & 0xff;
  return packet;
}

/** Set the ring's clock to local time (ring treats it as its wall clock). */
export function setTimePacket(now = new Date()): Uint8Array {
  return makePacket(CMD.SET_TIME, [
    byteToBcd(now.getFullYear() % 2000),
    byteToBcd(now.getMonth() + 1),
    byteToBcd(now.getDate()),
    byteToBcd(now.getHours()),
    byteToBcd(now.getMinutes()),
    byteToBcd(now.getSeconds()),
    1, // language: english
  ]);
}

export const batteryPacket = (): Uint8Array => makePacket(CMD.BATTERY);

export function parseBattery(p: Uint8Array): BatteryInfo {
  return { level: p[1], charging: p[2] !== 0 };
}

/** Request the per-15-minute activity log for a day (0 = today, 1 = yesterday …). */
export function stepsPacket(dayOffset = 0): Uint8Array {
  return makePacket(CMD.SYNC_ACTIVITY, [dayOffset, 0x0f, 0x00, 0x5f, 0x01]);
}

/**
 * Request the heart-rate log for the day containing `date`.
 * The ring expects local midnight expressed as a UTC epoch (seconds).
 */
export function heartRateLogPacket(date: Date): Uint8Array {
  const ts = Math.floor(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 1000,
  );
  const b = new Uint8Array(5);
  new DataView(b.buffer).setUint32(1, ts, true);
  b[0] = 0; // placeholder; makePacket sets command byte
  const packet = makePacket(CMD.SYNC_HEART_RATE, b.subarray(1));
  return packet;
}

export const readHrSettingsPacket = (): Uint8Array => makePacket(CMD.AUTO_HR_PREF, [0x01]);

export function writeHrSettingsPacket(enabled: boolean, intervalMinutes: number): Uint8Array {
  return makePacket(CMD.AUTO_HR_PREF, [0x02, enabled ? 1 : 2, intervalMinutes]);
}

export function parseHrSettings(p: Uint8Array): { enabled: boolean; intervalMinutes: number } {
  return { enabled: p[2] === 1, intervalMinutes: p[3] };
}

export function realtimeStartPacket(kind: number): Uint8Array {
  return makePacket(CMD.START_REAL_TIME, [kind, REALTIME_ACTION.START]);
}

export function realtimeContinuePacket(kind: number): Uint8Array {
  return makePacket(CMD.START_REAL_TIME, [kind, REALTIME_ACTION.CONTINUE]);
}

export function realtimeStopPacket(kind: number): Uint8Array {
  return makePacket(CMD.STOP_REAL_TIME, [kind, 0, 0]);
}

export interface RealtimeReading {
  kind: number;
  value: number;
  errorCode: number;
}

export function parseRealtimeReading(p: Uint8Array): RealtimeReading {
  return { kind: p[1], errorCode: p[2], value: p[3] };
}

// ---------------------------------------------------------------- multi-packet parsers (V1)

/** Accumulates 0x43 activity packets into 15-minute buckets. */
export class ActivityParser {
  private newCalorieProtocol = false;
  private index = 0;
  private buckets: ActivityBucket[] = [];

  /** Returns the finished list, "nodata", or null while more packets are expected. */
  parse(p: Uint8Array): ActivityBucket[] | "nodata" | null {
    if (this.index === 0 && p[1] === 0xff) return "nodata";
    if (this.index === 0 && p[1] === 0xf0) {
      if (p[3] === 1) this.newCalorieProtocol = true;
      this.index++;
      return null;
    }
    const year = bcdToDecimal(p[1]) + 2000;
    const month = bcdToDecimal(p[2]);
    const day = bcdToDecimal(p[3]);
    let calories = u16le(p[7], p[8]);
    if (this.newCalorieProtocol) calories *= 10;
    this.buckets.push({
      date: `${year}-${`${month}`.padStart(2, "0")}-${`${day}`.padStart(2, "0")}`,
      timeIndex: p[4],
      calories: Math.round(calories / 1000), // device reports small calories
      steps: u16le(p[9], p[10]),
      distanceM: u16le(p[11], p[12]),
    });
    if (p[5] === p[6] - 1) {
      return this.buckets;
    }
    this.index++;
    return null;
  }
}

export interface HeartRateLogResult {
  /** epoch millis of the day start the log belongs to (as reported by ring, UTC-anchored) */
  timestamp: number;
  intervalMinutes: number;
  samples: number[];
}

/** Accumulates 0x15 heart-rate log packets (288 five-minute samples per day). */
export class HeartRateLogParser {
  private size = 0;
  private range = 5;
  private timestamp = 0;
  private raw: number[] = [];
  private received = 0;

  parse(p: Uint8Array): HeartRateLogResult | "nodata" | null {
    const subType = p[1];
    if (subType === 0xff) return "nodata";
    if (subType === 0) {
      this.size = p[2];
      this.range = p[3];
      this.raw = new Array(this.size * 13).fill(0);
      return null;
    }
    if (subType === 1) {
      this.timestamp = new DataView(p.buffer, p.byteOffset).getUint32(2, true) * 1000;
      for (let i = 0; i < 9; i++) this.raw[i] = p[6 + i];
      this.received = 9;
      return null;
    }
    for (let i = 0; i < 13; i++) this.raw[this.received + i] = p[2 + i];
    this.received += 13;
    if (subType === this.size - 1) {
      const samples = this.raw.slice(0, 288);
      while (samples.length < 288) samples.push(0);
      return { timestamp: this.timestamp, intervalMinutes: this.range, samples };
    }
    return null;
  }
}

// ---------------------------------------------------------------- V2 big data

export function crc16Modbus(data: Uint8Array): number {
  let crc = 0xffff;
  for (const b of data) {
    crc ^= b & 0xff;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}

export function bigDataPacket(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(6 + payload.length);
  const dv = new DataView(out.buffer);
  out[0] = CMD.BIG_DATA_V2;
  out[1] = type;
  dv.setUint16(2, payload.length, true);
  dv.setUint16(4, crc16Modbus(payload), true);
  out.set(payload, 6);
  return out;
}

export const sleepRequestPacket = (): Uint8Array => bigDataPacket(BIG_DATA.SLEEP, Uint8Array.of(0xff));
export const spo2RequestPacket = (): Uint8Array => bigDataPacket(BIG_DATA.SPO2, Uint8Array.of(0xff));

/** Reassembles a big-data response that may arrive split across notifications. */
export class BigDataAssembler {
  private buffer: Uint8Array | null = null;

  /** Feed one notification; returns the complete packet or null if more is needed. */
  feed(value: Uint8Array): Uint8Array | null {
    let data = value;
    if (this.buffer) {
      const merged = new Uint8Array(this.buffer.length + value.length);
      merged.set(this.buffer);
      merged.set(value, this.buffer.length);
      data = merged;
    }
    // Reject frames that aren't big-data responses at all...
    if (data.length > 0 && data[0] !== CMD.BIG_DATA_V2) {
      this.buffer = null;
      return null;
    }
    // ...but keep a fragment too short to even hold the header, rather than
    // dropping it: the length field lives at bytes 2-3, so with fewer than 6
    // bytes we cannot yet know how much more is coming.
    if (data.length < 6) {
      this.buffer = data;
      return null;
    }
    const payloadLen = u16le(data[2], data[3]);
    if (data.length < payloadLen + 6) {
      this.buffer = data;
      return null;
    }
    this.buffer = null;
    return data;
  }

  reset(): void {
    this.buffer = null;
  }
}

const SLEEP_STAGE_BY_CODE: Record<number, SleepStage> = {
  2: "light",
  3: "deep",
  4: "rem",
  5: "awake",
};

/**
 * Parse a complete big-data sleep response into sessions.
 * `now` is injected for testability; day offsets are relative to it.
 */
export function parseSleep(value: Uint8Array, now = new Date()): SleepSession[] {
  const payloadLen = u16le(value[2], value[3]);
  if (payloadLen < 2) return [];
  const sessions: SleepSession[] = [];
  const daysInPacket = value[6];
  let index = 7;
  for (let d = 0; d < daysInPacket; d++) {
    if (index + 6 > value.length) break;
    const daysAgo = value[index++];
    const dayBytes = value[index++];
    const sleepStartMin = u16le(value[index], value[index + 1]);
    index += 2;
    const sleepEndMin = u16le(value[index], value[index + 1]);
    index += 2;

    const dayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo);
    const start =
      dayMidnight.getTime() +
      (sleepStartMin > sleepEndMin ? sleepStartMin - 1440 : sleepStartMin) * 60_000;
    const end = dayMidnight.getTime() + sleepEndMin * 60_000;

    const phases: SleepPhase[] = [];
    let cursor = start;
    for (let j = 4; j < dayBytes; j += 2) {
      const stageCode = value[index];
      const minutes = value[index + 1];
      index += 2;
      const stage = SLEEP_STAGE_BY_CODE[stageCode];
      if (minutes > 0 && stage) {
        phases.push({ stage, start: cursor, minutes });
        cursor += minutes * 60_000;
      }
    }
    sessions.push({ start, end, phases, syncedAt: Date.now() });
  }
  return sessions;
}

/** Parse a complete big-data SpO2 response into hourly min/max samples. */
export function parseSpo2(value: Uint8Array, now = new Date()): Spo2Hour[] {
  const length = u16le(value[2], value[3]);
  const out: Spo2Hour[] = [];
  let index = 6;
  let daysAgo = -1;
  while (daysAgo !== 0 && index - 6 < length) {
    daysAgo = value[index++];
    const dayMidnight = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - daysAgo,
    ).getTime();
    for (let hour = 0; hour <= 23; hour++) {
      const min = value[index++];
      const max = value[index++];
      if (min > 0 && max > 0) {
        out.push({ ts: dayMidnight + hour * 3_600_000, min, max });
      }
      if (index - 6 >= length) break;
    }
  }
  return out;
}
