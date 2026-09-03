/**
 * Web Bluetooth client for Colmi/Yawell RF03-family rings.
 *
 * Requires Chrome or Edge (desktop/Android) over HTTPS or localhost.
 */

import type {
  ActivityBucket,
  BatteryInfo,
  LogEntry,
  RealtimeKind,
  SleepSession,
  Spo2Hour,
  VitalSample,
} from "../types";
import {
  ActivityParser,
  BIG_DATA,
  BigDataAssembler,
  CMD,
  CHAR_COMMAND_V2,
  CHAR_NOTIFY_V1,
  CHAR_NOTIFY_V2,
  CHAR_WRITE,
  HeartRateLogParser,
  type HeartRateLogResult,
  REALTIME,
  SERVICE_V1,
  SERVICE_V2,
  batteryPacket,
  heartRateLogPacket,
  hex,
  makePacket,
  parseBattery,
  parseHrSettings,
  parseRealtimeReading,
  readHrSettingsPacket,
  realtimeContinuePacket,
  realtimeStartPacket,
  realtimeStopPacket,
  parseSleep,
  parseSpo2,
  setTimePacket,
  sleepRequestPacket,
  spo2RequestPacket,
  stepsPacket,
  writeHrSettingsPacket,
} from "./protocol";

export interface RingEvents {
  onLog?: (entry: LogEntry) => void;
  onDisconnect?: () => void;
  onRealtimeReading?: (kind: RealtimeKind, value: number) => void;
}

/** Common surface for the real BLE clients and the demo client. */
export interface RingLike {
  readonly name: string;
  readonly connected: boolean;
  disconnect(): void;
  setTime(): Promise<void>;
  getBattery(): Promise<BatteryInfo>;
  ensureHrLogging(intervalMinutes?: number): Promise<void>;
  /** Enable/disable the ring's own background SpO2 monitoring, when supported. */
  setAutoSpo2?(enabled: boolean): Promise<void>;
  /** Spot HRV / stress / blood-pressure readings, on rings that report them. */
  getVitals?(): Promise<VitalSample[]>;
  getActivity(dayOffset: number): Promise<ActivityBucket[]>;
  getHeartRateLog(date: Date): Promise<HeartRateLogResult | null>;
  getSleep(): Promise<SleepSession[]>;
  getSpo2(): Promise<Spo2Hour[]>;
  startRealtime(kind: RealtimeKind): Promise<void>;
  stopRealtime(): Promise<void>;
}

interface Pending {
  resolve: (value: Uint8Array[]) => void;
  reject: (err: Error) => void;
  packets: Uint8Array[];
  /** return true when the collected packets form a complete response */
  isDone: (packet: Uint8Array, packets: Uint8Array[]) => boolean;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 15_000;

export class RingClient implements RingLike {
  private device: BluetoothDevice | null = null;
  private writeChar: BluetoothRemoteGATTCharacteristic | null = null;
  private commandCharV2: BluetoothRemoteGATTCharacteristic | null = null;
  private pendingByCommand = new Map<number, Pending>();
  private bigData = new BigDataAssembler();
  private pendingBigData: Pending | null = null;
  private realtimeKind: number | null = null;
  private realtimeTimer: ReturnType<typeof setInterval> | null = null;
  private events: RingEvents;

  constructor(events: RingEvents = {}) {
    this.events = events;
  }

  get name(): string {
    return this.device?.name ?? "ring";
  }

  get connected(): boolean {
    return this.device?.gatt?.connected ?? false;
  }

  static get supported(): boolean {
    return typeof navigator !== "undefined" && "bluetooth" in navigator;
  }

  private log(dir: LogEntry["dir"], text: string): void {
    this.events.onLog?.({ ts: Date.now(), dir, text });
  }

  /** Devices the user has already granted to this site (Chrome's permission list). */
  static async grantedDevices(): Promise<BluetoothDevice[]> {
    if (!RingClient.supported || typeof navigator.bluetooth.getDevices !== "function") {
      return [];
    }
    try {
      return await navigator.bluetooth.getDevices();
    } catch {
      return [];
    }
  }

  /** Attach to an already-connected GATT server (see the connectRing factory). */
  async attach(device: BluetoothDevice, gatt: BluetoothRemoteGATTServer): Promise<void> {
    this.device = device;
    device.addEventListener("gattserverdisconnected", () => {
      this.log("info", "Ring disconnected");
      this.failAllPending(new Error("disconnected"));
      this.events.onDisconnect?.();
    });

    const serviceV1 = await gatt.getPrimaryService(SERVICE_V1);
    this.writeChar = await serviceV1.getCharacteristic(CHAR_WRITE);
    const notifyV1 = await serviceV1.getCharacteristic(CHAR_NOTIFY_V1);
    await notifyV1.startNotifications();
    notifyV1.addEventListener("characteristicvaluechanged", (e) => {
      const dv = (e.target as BluetoothRemoteGATTCharacteristic).value!;
      this.handleNotifyV1(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
    });

    // The big-data service is absent on some older firmwares; sleep/SpO2
    // history simply won't be available there.
    try {
      const serviceV2 = await gatt.getPrimaryService(SERVICE_V2);
      this.commandCharV2 = await serviceV2.getCharacteristic(CHAR_COMMAND_V2);
      const notifyV2 = await serviceV2.getCharacteristic(CHAR_NOTIFY_V2);
      await notifyV2.startNotifications();
      notifyV2.addEventListener("characteristicvaluechanged", (e) => {
        const dv = (e.target as BluetoothRemoteGATTCharacteristic).value!;
        this.handleNotifyV2(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
      });
      this.log("info", "Big-data service available (sleep + SpO2 history)");
    } catch {
      this.commandCharV2 = null;
      this.log("info", "Big-data service not found — sleep/SpO2 history unavailable");
    }
    this.log("info", `Connected to ${this.name}`);
  }

  disconnect(): void {
    this.stopRealtime().catch(() => {});
    this.device?.gatt?.disconnect();
  }

  // ------------------------------------------------------------ notifications

  private handleNotifyV1(value: Uint8Array): void {
    this.log("rx", hex(value));
    const command = value[0];

    if (command === CMD.START_REAL_TIME && this.realtimeKind !== null) {
      const reading = parseRealtimeReading(value);
      if (reading.errorCode === 0 && reading.value > 0) {
        this.events.onRealtimeReading?.(
          reading.kind === REALTIME.SPO2 ? "spo2" : "heartRate",
          reading.value,
        );
      }
      return;
    }

    const pending = this.pendingByCommand.get(command);
    if (!pending) return;
    pending.packets.push(value);
    if (pending.isDone(value, pending.packets)) {
      clearTimeout(pending.timer);
      this.pendingByCommand.delete(command);
      pending.resolve(pending.packets);
    }
  }

  private handleNotifyV2(value: Uint8Array): void {
    this.log("rx", `[v2] ${hex(value)}`);
    const complete = this.bigData.feed(value);
    if (!complete || !this.pendingBigData) return;
    const pending = this.pendingBigData;
    this.pendingBigData = null;
    clearTimeout(pending.timer);
    pending.resolve([complete]);
  }

  private failAllPending(err: Error): void {
    for (const pending of this.pendingByCommand.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingByCommand.clear();
    if (this.pendingBigData) {
      clearTimeout(this.pendingBigData.timer);
      this.pendingBigData.reject(err);
      this.pendingBigData = null;
    }
    this.bigData.reset();
  }

  // ------------------------------------------------------------ request plumbing

  private async write(packet: Uint8Array): Promise<void> {
    if (!this.writeChar) throw new Error("not connected");
    this.log("tx", hex(packet));
    await this.writeChar.writeValueWithoutResponse(packet.buffer as ArrayBuffer);
  }

  private request(
    packet: Uint8Array,
    command: number,
    isDone: Pending["isDone"],
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Uint8Array[]> {
    return new Promise<Uint8Array[]>((resolve, reject) => {
      if (this.pendingByCommand.has(command)) {
        reject(new Error(`request 0x${command.toString(16)} already in flight`));
        return;
      }
      const timer = setTimeout(() => {
        this.pendingByCommand.delete(command);
        reject(new Error(`request 0x${command.toString(16)} timed out`));
      }, timeoutMs);
      this.pendingByCommand.set(command, { resolve, reject, packets: [], isDone, timer });
      this.write(packet).catch((err) => {
        clearTimeout(timer);
        this.pendingByCommand.delete(command);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private requestBigData(packet: Uint8Array, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Uint8Array> {
    if (!this.commandCharV2) {
      return Promise.reject(new Error("big-data service unavailable on this ring"));
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      if (this.pendingBigData) {
        reject(new Error("big-data request already in flight"));
        return;
      }
      const timer = setTimeout(() => {
        this.pendingBigData = null;
        this.bigData.reset();
        reject(new Error("big-data request timed out"));
      }, timeoutMs);
      this.pendingBigData = {
        resolve: (packets) => resolve(packets[0]),
        reject,
        packets: [],
        isDone: () => true,
        timer,
      };
      this.log("tx", `[v2] ${hex(packet)}`);
      this.commandCharV2!.writeValueWithoutResponse(packet.buffer as ArrayBuffer).catch((err) => {
        clearTimeout(timer);
        this.pendingBigData = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  // ------------------------------------------------------------ API

  async setTime(): Promise<void> {
    await this.request(setTimePacket(), CMD.SET_TIME, () => true);
    this.log("info", "Ring clock synced to phone time");
  }

  async getBattery(): Promise<BatteryInfo> {
    const [packet] = await this.request(batteryPacket(), CMD.BATTERY, () => true);
    return parseBattery(packet);
  }

  /** Make sure periodic heart-rate logging is on so history accumulates. */
  async ensureHrLogging(intervalMinutes = 5): Promise<void> {
    const [packet] = await this.request(readHrSettingsPacket(), CMD.AUTO_HR_PREF, () => true);
    const settings = parseHrSettings(packet);
    this.log("info", `HR logging: enabled=${settings.enabled} interval=${settings.intervalMinutes}m`);
    if (!settings.enabled || settings.intervalMinutes !== intervalMinutes) {
      await this.request(
        writeHrSettingsPacket(true, intervalMinutes),
        CMD.AUTO_HR_PREF,
        () => true,
      );
      this.log("info", `HR logging enabled at ${intervalMinutes} minute interval`);
    }
  }

  /** All-day SpO2 monitoring preference (0x2c). */
  async setAutoSpo2(enabled: boolean): Promise<void> {
    await this.request(
      makePacket(CMD.AUTO_SPO2_PREF, [0x02, enabled ? 1 : 0]),
      CMD.AUTO_SPO2_PREF,
      () => true,
    );
    this.log("info", `All-day SpO2 monitoring ${enabled ? "enabled" : "disabled"}`);
  }

  async getActivity(dayOffset: number): Promise<ActivityBucket[]> {
    const parser = new ActivityParser();
    let result: ActivityBucket[] | "nodata" | null = null;
    await this.request(stepsPacket(dayOffset), CMD.SYNC_ACTIVITY, (packet) => {
      result = parser.parse(packet);
      return result !== null;
    });
    return result === "nodata" || result === null ? [] : result;
  }

  async getHeartRateLog(date: Date): Promise<HeartRateLogResult | null> {
    const parser = new HeartRateLogParser();
    let result: HeartRateLogResult | "nodata" | null = null;
    await this.request(heartRateLogPacket(date), CMD.SYNC_HEART_RATE, (packet) => {
      result = parser.parse(packet);
      return result !== null;
    });
    return result === "nodata" ? null : (result as HeartRateLogResult | null);
  }

  async getSleep(): Promise<SleepSession[]> {
    const packet = await this.requestBigData(sleepRequestPacket());
    if (packet[1] !== BIG_DATA.SLEEP) throw new Error("unexpected big-data type in sleep response");
    return parseSleep(packet);
  }

  async getSpo2(): Promise<Spo2Hour[]> {
    const packet = await this.requestBigData(spo2RequestPacket());
    if (packet[1] !== BIG_DATA.SPO2) throw new Error("unexpected big-data type in SpO2 response");
    return parseSpo2(packet);
  }

  async startRealtime(kind: RealtimeKind): Promise<void> {
    await this.stopRealtime();
    const code = kind === "spo2" ? REALTIME.SPO2 : REALTIME.HEART_RATE;
    this.realtimeKind = code;
    await this.write(realtimeStartPacket(code));
    // Keep the sensor session alive; the ring stops on its own otherwise.
    this.realtimeTimer = setInterval(() => {
      this.write(realtimeContinuePacket(code)).catch(() => {});
    }, 5_000);
  }

  async stopRealtime(): Promise<void> {
    if (this.realtimeTimer) {
      clearInterval(this.realtimeTimer);
      this.realtimeTimer = null;
    }
    if (this.realtimeKind !== null) {
      const code = this.realtimeKind;
      this.realtimeKind = null;
      await this.write(realtimeStopPacket(code)).catch(() => {});
    }
  }
}
