import type { MouseStatus } from "../mouse-types.ts";
import {
  DUALSENSE_EDGE_PRODUCT_ID,
  DUALSENSE_PRODUCT_ID,
  DUALSENSE_VENDOR_ID,
  buildUsbOutputReport,
  isDualSenseEdge,
  parseUsbInputReport,
  USB_INPUT_REPORT_LENGTH,
  type DualSenseState,
} from "@openmouse/controller-protocol/sony";

/**
 * Sony DualSense / DualSense Edge (PS5 controller) — stage one.
 *
 * OpenMouse is a mouse control panel; a gamepad has no DPI, polling rate, or
 * lift-off distance. This driver's job is narrow: recognise the controller,
 * open its HID connection, and report what it is with a live battery reading
 * and the last-seen stick/button snapshot in the firmware lines. It sets
 * `ui.settingsReady = false` so the mouse settings grid stays hidden, and
 * exposes no setters — nothing here can rebind a button or change a curve.
 *
 * Byte offsets for the underlying report come from
 * `@openmouse/controller-protocol`, which was hardware-verified against a
 * wired DualSense (idle-report parse, plus live lightbar/rumble/trigger
 * writes). Only USB is implemented; Bluetooth is out of scope here too.
 */
export class DualSenseHidClient {
  readonly device: HIDDevice;

  private latestState: DualSenseState | null = null;
  private listening = false;

  private readonly onInputReport = (event: HIDInputReportEvent): void => {
    // WebHID strips the leading report-id byte from `data` and carries it
    // separately as `event.reportId`; the controller-protocol parser expects
    // the report id byte still in place (as a raw HID capture has it), so put
    // it back before decoding.
    const payload = new Uint8Array(
      event.data.buffer.slice(event.data.byteOffset, event.data.byteOffset + event.data.byteLength),
    );
    const bytes = new Uint8Array(payload.length + 1);
    bytes[0] = event.reportId;
    bytes.set(payload, 1);
    if (bytes.length < USB_INPUT_REPORT_LENGTH) return;
    try {
      this.latestState = parseUsbInputReport(bytes, { isEdge: this.isEdge });
    } catch {
      // Malformed or unexpected report id; keep the last good snapshot.
    }
  };

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    return device.vendorId === DUALSENSE_VENDOR_ID
      && (device.productId === DUALSENSE_PRODUCT_ID || device.productId === DUALSENSE_EDGE_PRODUCT_ID);
  }

  get isEdge(): boolean {
    return isDualSenseEdge(this.device.productId);
  }

  /** Part of the shared client contract the control panel calls on every device. */
  getDpiOptions(): number[] {
    return [];
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
    if (!this.listening) {
      this.device.addEventListener("inputreport", this.onInputReport);
      this.listening = true;
    }
  }

  async close(): Promise<void> {
    if (this.listening) {
      this.device.removeEventListener("inputreport", this.onInputReport);
      this.listening = false;
    }
    if (this.device.opened) await this.device.close();
  }

  /** Sets the lightbar color, confirmed on real hardware (see controller-protocol). */
  async setLightbar(color: { r: number; g: number; b: number }): Promise<void> {
    await this.open();
    const report = buildUsbOutputReport({ lightbar: { playerLeds: 0, color } });
    await this.device.sendReport(report[0]!, report.slice(1));
  }

  async readStatus(): Promise<MouseStatus> {
    await this.open();
    // The controller streams input reports continuously once open; give the
    // first one a moment to arrive so a fresh connect doesn't show "Unknown".
    if (!this.latestState) await this.waitForFirstReport();

    const state = this.latestState;
    const name = this.isEdge ? "DualSense Edge Wireless Controller" : "DualSense Wireless Controller";

    return {
      brand: "Sony",
      name,
      ui: {
        family: this.isEdge ? "dualsense-edge" : "dualsense",
        settingsReady: false,
        forceShowBattery: true,
        defaultDisplayName: name,
      },
      batteryPercent: state?.battery.level ?? null,
      batteryState: state ? mapBatteryState(state.battery.state) : "Unknown",
      dpi: 0,
      pollingRateHz: 0,
      activeProfile: null,
      connectionType: "Wired",
      connectionDetail: "USB",
      liftOffDistance: null,
      firmware: state ? this.statusLines(state) : ["Waiting for the controller's first report…"],
    };
  }

  private statusLines(state: DualSenseState): string[] {
    const pressed = Object.entries(state.buttons)
      .filter(([, isPressed]) => isPressed)
      .map(([name]) => name);
    return [
      `Left stick: ${state.leftStickX}, ${state.leftStickY}`,
      `Right stick: ${state.rightStickX}, ${state.rightStickY}`,
      `Triggers: L2 ${state.leftTrigger} / R2 ${state.rightTrigger}`,
      `D-pad: ${state.dpad}`,
      pressed.length > 0 ? `Buttons held: ${pressed.join(", ")}` : "No buttons held",
    ];
  }

  private waitForFirstReport(timeoutMs = 300): Promise<void> {
    return new Promise((resolve) => {
      const started = Date.now();
      const check = (): void => {
        if (this.latestState || Date.now() - started > timeoutMs) {
          resolve();
          return;
        }
        setTimeout(check, 20);
      };
      check();
    });
  }
}

function mapBatteryState(state: DualSenseState["battery"]["state"]): MouseStatus["batteryState"] {
  switch (state) {
    case "charging":
      return "Charging";
    case "full":
      return "Full";
    case "discharging":
      return "Discharging";
    default:
      return "Unknown";
  }
}
