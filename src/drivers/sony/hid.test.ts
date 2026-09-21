import assert from "node:assert/strict";
import test from "node:test";

import { DualSenseHidClient } from "./hid.ts";
import { DUALSENSE_EDGE_PRODUCT_ID, DUALSENSE_PRODUCT_ID, DUALSENSE_VENDOR_ID } from "@openmouse/controller-protocol/sony";

// Real idle USB input report captured from a wired DualSense (see
// controller-protocol's src/sony/dualsense.test.ts for how this was verified
// against live hardware): centered sticks, no buttons held, charging at 55%.
const IDLE_REPORT_HEX =
  "01808085770000f30800000016fb839d07000200f6fffdfd4920ea04f73136160d8019643380000000fa09090000000000c34a3616150800a1d19e485a9aaa5a";

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  return bytes;
}

function fakeDualSense(productId: number = DUALSENSE_PRODUCT_ID) {
  let inputListener: ((event: HIDInputReportEvent) => void) | null = null;
  const sent: Array<{ reportId: number; data: Uint8Array }> = [];
  let opened = false;
  const device = {
    vendorId: DUALSENSE_VENDOR_ID,
    productId,
    productName: "DualSense Wireless Controller",
    get opened() {
      return opened;
    },
    collections: [{ usagePage: 0x01, usage: 0x05, children: [], inputReports: [], outputReports: [], featureReports: [] }],
    open: async () => void (opened = true),
    close: async () => void (opened = false),
    sendReport: async (reportId: number, data: Uint8Array) => {
      sent.push({ reportId, data: new Uint8Array(data) });
    },
    addEventListener: (type: string, listener: (event: HIDInputReportEvent) => void) => {
      if (type === "inputreport") inputListener = listener;
    },
    removeEventListener: (type: string, listener: (event: HIDInputReportEvent) => void) => {
      if (type === "inputreport" && inputListener === listener) inputListener = null;
    },
  } as unknown as HIDDevice;

  const emitIdleReport = () => {
    // WebHID strips the report-id byte out of `data` and carries it
    // separately as `reportId` — mimic that here rather than handing back
    // the raw capture wholesale (a real bug: the driver originally assumed
    // `data` still had the id byte at index 0, so every live report was
    // silently dropped).
    const bytes = fromHex(IDLE_REPORT_HEX);
    const payload = bytes.slice(1);
    inputListener?.({ data: new DataView(payload.buffer), reportId: bytes[0] } as HIDInputReportEvent);
  };

  return { device, sent, emitIdleReport };
}

test("isSupported accepts the DualSense and DualSense Edge product ids only", () => {
  assert.equal(DualSenseHidClient.isSupported(fakeDualSense(DUALSENSE_PRODUCT_ID).device), true);
  assert.equal(DualSenseHidClient.isSupported(fakeDualSense(DUALSENSE_EDGE_PRODUCT_ID).device), true);
  assert.equal(DualSenseHidClient.isSupported(fakeDualSense(0x0001).device), false);
  assert.equal(DualSenseHidClient.isSupported({ vendorId: 0x1234, productId: DUALSENSE_PRODUCT_ID } as HIDDevice), false);
});

test("isEdge reflects the product id", () => {
  assert.equal(new DualSenseHidClient(fakeDualSense(DUALSENSE_PRODUCT_ID).device).isEdge, false);
  assert.equal(new DualSenseHidClient(fakeDualSense(DUALSENSE_EDGE_PRODUCT_ID).device).isEdge, true);
});

test("readStatus hides the mouse settings grid and reports no DPI options", async () => {
  const { device } = fakeDualSense();
  const client = new DualSenseHidClient(device);
  const status = await client.readStatus();

  assert.equal(status.brand, "Sony");
  assert.equal(status.ui?.settingsReady, false);
  assert.equal(client.getDpiOptions().length, 0);
  assert.equal(status.dpi, 0);
});

test("readStatus reflects a live input report's battery and firmware lines", async () => {
  const { device, emitIdleReport } = fakeDualSense();
  const client = new DualSenseHidClient(device);
  await client.open();
  emitIdleReport();

  const status = await client.readStatus();
  assert.equal(status.batteryState, "Charging");
  assert.equal(status.batteryPercent, 55);
  assert.ok(status.firmware.some((line) => line.includes("No buttons held")));
});

test("setLightbar sends a report starting with the output report id", async () => {
  const { device, sent } = fakeDualSense();
  const client = new DualSenseHidClient(device);
  await client.setLightbar({ r: 0, g: 255, b: 0 });

  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.reportId, 0x02);
});
