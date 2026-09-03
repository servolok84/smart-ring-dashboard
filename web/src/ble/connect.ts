/**
 * Protocol-detecting connector: acquires a device, connects (with patient
 * retries — the ring must be actively advertising), inspects its GATT
 * services, and hands it to the right driver:
 *
 *  - Colmi/Yawell RF03 family  → service 6e40fff0… (RingClient)
 *  - Jring/keeprapid 56ff family (Anko) → service 000056ff… (JringClient)
 */

import { SERVICE_V1, SERVICE_V2 } from "./protocol";
import { RingClient, type RingEvents, type RingLike } from "./ring";
import { BATTERY_SERVICE, JRING_SERVICE, JringClient } from "./jring";

const DEVICE_INFO_SERVICE = "0000180a-0000-1000-8000-00805f9b34fb";
const JRING_SECONDARY = "000057ff-0000-1000-8000-00805f9b34fb";

const OPTIONAL_SERVICES = [
  SERVICE_V1,
  SERVICE_V2,
  JRING_SERVICE,
  JRING_SECONDARY,
  BATTERY_SERVICE,
  DEVICE_INFO_SERVICE,
];

// Advertising-name prefixes across both families.
const NAME_PREFIXES = [
  "Anko",
  "COLMI",
  "Jring",
  "R01",
  "R02",
  "R03",
  "R06",
  "R07",
  "R09",
  "R10",
  "R12",
  "VK-",
  "SMART_RING",
];

function log(events: RingEvents, text: string): void {
  events.onLog?.({ ts: Date.now(), dir: "info", text });
}

const BLUETOOTH_BASE_SUFFIX = "-0000-1000-8000-00805f9b34fb";

/**
 * Different Web Bluetooth implementations report UUIDs differently: Chrome
 * uses full lowercase 128-bit form, Bluefy (iOS) reports short uppercase
 * 16-bit form like "56FF". Normalize everything to the full lowercase form.
 */
function normalizeUuid(uuid: string): string {
  let s = String(uuid).toLowerCase().trim();
  if (s.startsWith("0x")) s = s.slice(2);
  if (/^[0-9a-f]{4}$/.test(s)) return `0000${s}${BLUETOOTH_BASE_SUFFIX}`;
  if (/^[0-9a-f]{8}$/.test(s)) return `${s}${BLUETOOTH_BASE_SUFFIX}`;
  return s;
}

export async function connectRing(
  events: RingEvents,
  device?: BluetoothDevice,
): Promise<RingLike> {
  if (typeof navigator === "undefined" || !("bluetooth" in navigator)) {
    throw new Error(
      "Web Bluetooth is not available. Use Chrome or Edge (not Safari/Firefox), over HTTPS or localhost.",
    );
  }

  const target =
    device ??
    (await navigator.bluetooth.requestDevice({
      filters: NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
      optionalServices: OPTIONAL_SERVICES,
    }));

  log(events, `Connecting to ${target.name ?? "device"}…`);

  // macOS can only connect while the ring is actively advertising, and the
  // ring sleeps within seconds — retry for ~30s so the user can wake it
  // (touch it to the charger) mid-retry.
  let gatt: BluetoothRemoteGATTServer | null = null;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 15 && !gatt; attempt++) {
    try {
      gatt = await target.gatt!.connect();
    } catch (err) {
      lastError = err;
      log(
        events,
        `Connect attempt ${attempt}/15 failed (${err}) — wake the ring (touch it to its charger) while I keep retrying…`,
      );
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!gatt) {
    throw new Error(
      `Could not connect to ${target.name ?? "device"}. The ring is likely asleep or connected to your phone. ` +
        `Turn the phone's Bluetooth off, wake the ring on its charger, then try again right away. (${lastError})`,
    );
  }

  // Identify the protocol from the services the ring actually exposes.
  let serviceUuids: string[] = [];
  try {
    const services = await gatt.getPrimaryServices();
    serviceUuids = services.map((s) => normalizeUuid(s.uuid));
    log(events, `Services: ${serviceUuids.join(", ") || "(none visible)"}`);
  } catch (err) {
    log(events, `Service discovery failed: ${err}`);
  }

  try {
    if (serviceUuids.includes(JRING_SERVICE)) {
      log(events, "Detected Jring/56ff protocol (Anko family)");
      const client = new JringClient(events);
      await client.attach(target, gatt);
      return client;
    }
    if (serviceUuids.includes(SERVICE_V1)) {
      log(events, "Detected Colmi/Yawell protocol");
      const client = new RingClient(events);
      await client.attach(target, gatt);
      return client;
    }
  } catch (err) {
    gatt.disconnect();
    throw err instanceof Error ? err : new Error(String(err));
  }

  gatt.disconnect();
  throw new Error(
    `"${target.name ?? "device"}" doesn't expose a known ring service ` +
      `(found: ${serviceUuids.join(", ") || "none"}). It's probably a different device — or a protocol variant; ` +
      `share the packet log and it can be added.`,
  );
}
