import { describe, expect, it } from "vitest";
import type { HeartRateLogResult } from "../protocol";
import {
  ActivityParser,
  BigDataAssembler,
  CMD,
  HeartRateLogParser,
  bigDataPacket,
  crc16Modbus,
  hex,
  heartRateLogPacket,
  localDateKey,
  makePacket,
  parseBattery,
  parseHrSettings,
  parseSleep,
  parseSpo2,
  setTimePacket,
  writeHrSettingsPacket,
} from "../protocol";

/** Build a 16-byte notification with a valid trailing checksum. */
function frame(...bytes: number[]): Uint8Array {
  const p = new Uint8Array(16);
  p.set(bytes.slice(0, 15));
  let sum = 0;
  for (let i = 0; i < 15; i++) sum += p[i];
  p[15] = sum & 0xff;
  return p;
}

describe("makePacket", () => {
  it("is always 16 bytes with the command first", () => {
    const p = makePacket(CMD.BATTERY);
    expect(p).toHaveLength(16);
    expect(p[0]).toBe(CMD.BATTERY);
  });

  it("checksums the first 15 bytes modulo 256", () => {
    const p = makePacket(0x01, [0x02, 0x03]);
    expect(p[15]).toBe((0x01 + 0x02 + 0x03) & 0xff);
  });

  it("wraps the checksum rather than overflowing a byte", () => {
    const p = makePacket(0xff, [0xff, 0xff]);
    expect(p[15]).toBe((0xff * 3) & 0xff);
    expect(p[15]).toBeLessThanOrEqual(0xff);
  });

  it("refuses sub-data that would not fit", () => {
    expect(() => makePacket(1, new Array(15).fill(0))).toThrow();
  });
});

describe("setTimePacket", () => {
  it("encodes the date as BCD in the ring's local wall clock", () => {
    // 2026-09-03 14:05:07 local
    const p = setTimePacket(new Date(2026, 8, 3, 14, 5, 7));
    expect(p[0]).toBe(CMD.SET_TIME);
    expect(p[1]).toBe(0x26); // year 26
    expect(p[2]).toBe(0x09); // month
    expect(p[3]).toBe(0x03); // day
    expect(p[4]).toBe(0x14); // hour 14 -> BCD 0x14
    expect(p[5]).toBe(0x05);
    expect(p[6]).toBe(0x07);
    expect(p[7]).toBe(1); // language: english
  });

  it("BCD-encodes values above 9 correctly", () => {
    const p = setTimePacket(new Date(2026, 10, 29, 23, 59, 58));
    expect(p[2]).toBe(0x11); // November
    expect(p[3]).toBe(0x29);
    expect(p[4]).toBe(0x23);
    expect(p[5]).toBe(0x59);
  });
});

describe("heartRateLogPacket", () => {
  it("asks for local midnight expressed as a UTC epoch", () => {
    const p = heartRateLogPacket(new Date(2026, 8, 3, 17, 30));
    const ts = new DataView(p.buffer).getUint32(1, true);
    expect(ts).toBe(Math.floor(Date.UTC(2026, 8, 3) / 1000));
  });
});

describe("battery and heart-rate settings", () => {
  it("parses level and charging flag", () => {
    expect(parseBattery(frame(CMD.BATTERY, 64, 1))).toEqual({
      level: 64,
      charging: true,
    });
    expect(parseBattery(frame(CMD.BATTERY, 100, 0)).charging).toBe(false);
  });

  it("round-trips the logging interval", () => {
    const written = writeHrSettingsPacket(true, 60);
    const parsed = parseHrSettings(frame(written[0], written[1], written[2], written[3]));
    expect(parsed).toEqual({ enabled: true, intervalMinutes: 60 });
  });

  it("encodes disabled logging", () => {
    const p = writeHrSettingsPacket(false, 45);
    expect(parseHrSettings(frame(p[0], p[1], p[2], p[3]))).toEqual({
      enabled: false,
      intervalMinutes: 45,
    });
  });
});

describe("ActivityParser", () => {
  it("reports nodata for an empty day", () => {
    expect(new ActivityParser().parse(frame(CMD.SYNC_ACTIVITY, 0xff))).toBe("nodata");
  });

  it("accumulates buckets until the final index and decodes fields", () => {
    const p = new ActivityParser();
    // header packet
    expect(p.parse(frame(CMD.SYNC_ACTIVITY, 0xf0, 0, 0))).toBeNull();
    // one and only bucket: index 0 of 1 -> p[5] === p[6]-1 terminates
    const out = p.parse(
      frame(
        CMD.SYNC_ACTIVITY,
        0x26, // year 26 (BCD)
        0x09, // month
        0x03, // day
        40, // timeIndex (quarter-hour)
        0, // this index
        1, // total
        0xb8,
        0x0b, // calories 3000 -> /1000 = 3
        0x2c,
        0x01, // steps 300
        0xf4,
        0x01, // distance 500 m
      ),
    );
    expect(out).not.toBeNull();
    expect(out).toEqual([
      { date: "2026-09-03", timeIndex: 40, calories: 3, steps: 300, distanceM: 500 },
    ]);
  });
});

describe("HeartRateLogParser", () => {
  it("returns nodata when the ring has no log", () => {
    expect(new HeartRateLogParser().parse(frame(CMD.SYNC_HEART_RATE, 0xff))).toBe("nodata");
  });

  it("assembles 288 samples and reports the interval", () => {
    const parser = new HeartRateLogParser();
    const size = 24;
    expect(parser.parse(frame(CMD.SYNC_HEART_RATE, 0, size, 5))).toBeNull();

    const epochSeconds = Math.floor(Date.UTC(2026, 8, 3) / 1000);
    const second = new Uint8Array(16);
    second[0] = CMD.SYNC_HEART_RATE;
    second[1] = 1;
    new DataView(second.buffer).setUint32(2, epochSeconds, true);
    for (let i = 0; i < 9; i++) second[6 + i] = 60 + i;
    expect(parser.parse(second)).toBeNull();

    let result: HeartRateLogResult | "nodata" | null = null;
    for (let sub = 2; sub < size; sub++) {
      const p = new Uint8Array(16);
      p[0] = CMD.SYNC_HEART_RATE;
      p[1] = sub;
      for (let i = 0; i < 13; i++) p[2 + i] = 70;
      result = parser.parse(p);
    }
    expect(result).not.toBeNull();
    expect(result).not.toBe("nodata");
    const log = result as HeartRateLogResult;
    expect(log.intervalMinutes).toBe(5);
    expect(log.samples).toHaveLength(288);
    expect(log.timestamp).toBe(epochSeconds * 1000);
    expect(log.samples[0]).toBe(60);
  });
});

describe("big data framing", () => {
  it("computes the MODBUS CRC16 of the empty and known inputs", () => {
    expect(crc16Modbus(new Uint8Array())).toBe(0xffff);
    // "123456789" is the standard MODBUS check vector -> 0x4B37
    expect(crc16Modbus(new TextEncoder().encode("123456789"))).toBe(0x4b37);
  });

  it("builds a header carrying type, little-endian length and CRC", () => {
    const payload = Uint8Array.of(0xff);
    const p = bigDataPacket(0x27, payload);
    const dv = new DataView(p.buffer);
    expect(p[0]).toBe(CMD.BIG_DATA_V2);
    expect(p[1]).toBe(0x27);
    expect(dv.getUint16(2, true)).toBe(1);
    expect(dv.getUint16(4, true)).toBe(crc16Modbus(payload));
    expect(p[6]).toBe(0xff);
  });

  it("reassembles a response split across notifications", () => {
    const full = bigDataPacket(0x27, Uint8Array.of(1, 2, 3, 4, 5, 6));
    const a = new BigDataAssembler();
    expect(a.feed(full.subarray(0, 4))).toBeNull();
    expect(a.feed(full.subarray(4, 9))).toBeNull();
    const done = a.feed(full.subarray(9));
    expect(done).not.toBeNull();
    expect(hex(done!)).toBe(hex(full));
  });

  it("returns a single-notification response immediately", () => {
    const full = bigDataPacket(0x27, Uint8Array.of(9));
    expect(new BigDataAssembler().feed(full)).not.toBeNull();
  });
});

describe("parseSleep", () => {
  it("decodes stages and places a past-midnight bedtime on the previous day", () => {
    const now = new Date(2026, 8, 3, 12, 0, 0);
    // daysAgo=1, dayBytes=8 (4 header + 2 phases), start 1380 (23:00), end 420 (07:00)
    const payload = [
      1, // days ago
      8, // bytes for this day
      1380 & 0xff,
      1380 >> 8,
      420 & 0xff,
      420 >> 8,
      2,
      60, // stage code 2 for 60 min
      3,
      120, // stage code 3 for 120 min
    ];
    const value = new Uint8Array([0x27, 0x00, payload.length + 1, 0x00, 0, 0, 1, ...payload]);
    const sessions = parseSleep(value, now);

    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    // start is before end, i.e. bedtime rolled back a day
    expect(s.start).toBeLessThan(s.end);
    expect(new Date(s.end).getHours()).toBe(7);
    expect(s.phases.length).toBeGreaterThan(0);
    const total = s.phases.reduce((sum, p) => sum + p.minutes, 0);
    expect(total).toBe(180);
  });

  it("returns nothing for an empty payload", () => {
    expect(parseSleep(Uint8Array.of(0x27, 0, 1, 0, 0, 0, 0))).toEqual([]);
  });
});

describe("parseSpo2", () => {
  it("keeps only hours with real readings and anchors them to the right day", () => {
    const now = new Date(2026, 8, 3, 12, 0, 0);
    const hours: number[] = [];
    for (let h = 0; h < 24; h++) {
      // only hour 3 has data
      hours.push(h === 3 ? 95 : 0, h === 3 ? 99 : 0);
    }
    const payload = [0, ...hours];
    const value = new Uint8Array([0x2a, 0x00, payload.length & 0xff, payload.length >> 8, 0, 0, ...payload]);
    const out = parseSpo2(value, now);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ min: 95, max: 99 });
    expect(new Date(out[0].ts).getHours()).toBe(3);
    expect(localDateKey(new Date(out[0].ts))).toBe("2026-09-03");
  });
});

describe("localDateKey", () => {
  it("formats local time, not UTC", () => {
    expect(localDateKey(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
    expect(localDateKey(new Date(2026, 11, 31, 0, 1))).toBe("2026-12-31");
  });
});

describe("hex", () => {
  it("renders lowercase, space-separated, zero-padded bytes", () => {
    expect(hex(Uint8Array.of(0x00, 0x0f, 0xff))).toMatch(/00.0f.ff/);
  });
});
