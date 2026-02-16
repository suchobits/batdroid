import { execFile } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 15_000;

export interface AdbDevice {
  id: string;
  type: "emulator" | "device";
  model: string;
  status: string;
}

export interface AdbOptions {
  deviceId?: string;
  timeoutMs?: number;
}

/**
 * Run an ADB command and return stdout as a string.
 */
export function adb(
  args: string[],
  opts: AdbOptions = {},
): Promise<string> {
  const fullArgs = opts.deviceId ? ["-s", opts.deviceId, ...args] : args;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    execFile("adb", fullArgs, { timeout, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`adb ${fullArgs.join(" ")} failed: ${stderr || err.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Run an ADB command and return stdout as a Buffer (for binary data like screenshots).
 */
export function adbRaw(
  args: string[],
  opts: AdbOptions = {},
): Promise<Buffer> {
  const fullArgs = opts.deviceId ? ["-s", opts.deviceId, ...args] : args;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    execFile(
      "adb",
      fullArgs,
      { timeout, maxBuffer: 50 * 1024 * 1024, encoding: "buffer" },
      (err, stdout, stderr) => {
        if (err) {
          const stderrStr = stderr instanceof Buffer ? stderr.toString() : String(stderr);
          reject(new Error(`adb ${fullArgs.join(" ")} failed: ${stderrStr || err.message}`));
        } else {
          resolve(stdout as Buffer);
        }
      },
    );
  });
}

/**
 * Parse `adb devices -l` output into structured device list.
 */
export async function listDevices(): Promise<AdbDevice[]> {
  const output = await adb(["devices", "-l"]);
  const lines = output.trim().split("\n").slice(1); // skip header

  return lines
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      const id = parts[0];
      const status = parts[1];

      const modelMatch = line.match(/model:(\S+)/);
      const model = modelMatch ? modelMatch[1] : "unknown";

      const type = id.startsWith("emulator-") ? "emulator" : "device";

      return { id, type, model, status } as AdbDevice;
    });
}

/**
 * Get the currently focused activity.
 * Tries multiple sources to support all Android versions (including API 36+).
 */
export async function getCurrentActivity(
  opts: AdbOptions = {},
): Promise<{ package: string; activity: string }> {
  // Strategy 1: dumpsys window — works on most Android versions
  try {
    const windowOutput = await adb(["shell", "dumpsys", "window", "windows"], opts);

    const focusMatch = windowOutput.match(/mCurrentFocus=.*?\s+(\S+)\/(\S+)/);
    if (focusMatch) {
      return { package: focusMatch[1], activity: focusMatch[2] };
    }

    const appMatch = windowOutput.match(/mFocusedApp=.*?\s+(\S+)\/(\S+)/);
    if (appMatch) {
      return { package: appMatch[1], activity: appMatch[2] };
    }
  } catch {
    // Fall through to next strategy
  }

  // Strategy 2: dumpsys activity activities — works on API 36+ (Android 16)
  // Parses topResumedActivity or mResumedActivity lines
  try {
    const activityOutput = await adb(["shell", "dumpsys", "activity", "activities"], opts);

    // topResumedActivity=ActivityRecord{... com.example.app/.MainActivity ...}
    const topMatch = activityOutput.match(/topResumedActivity=ActivityRecord\{[^}]*\s+(\S+)\/(\S+)/);
    if (topMatch) {
      return { package: topMatch[1], activity: topMatch[2] };
    }

    // mResumedActivity=ActivityRecord{... com.example.app/.MainActivity ...}
    const resumedMatch = activityOutput.match(/mResumedActivity=ActivityRecord\{[^}]*\s+(\S+)\/(\S+)/);
    if (resumedMatch) {
      return { package: resumedMatch[1], activity: resumedMatch[2] };
    }

    // ResumedActivity: ActivityRecord{... com.example.app/.MainActivity ...}
    const altMatch = activityOutput.match(/ResumedActivity:\s+ActivityRecord\{[^}]*\s+(\S+)\/(\S+)/);
    if (altMatch) {
      return { package: altMatch[1], activity: altMatch[2] };
    }
  } catch {
    // Fall through
  }

  // Strategy 3: dumpsys window displays — some versions put focus info here
  try {
    const displayOutput = await adb(["shell", "dumpsys", "window", "displays"], opts);

    const focusedApp = displayOutput.match(/focusedApp=.*?(\S+)\/(\S+)/);
    if (focusedApp) {
      return { package: focusedApp[1], activity: focusedApp[2] };
    }
  } catch {
    // Fall through
  }

  throw new Error(
    "Could not determine current activity. Tried: dumpsys window windows, dumpsys activity activities, dumpsys window displays",
  );
}

/**
 * Resolve device ID — if none provided and only one device, use it.
 * If multiple devices and none specified, throw.
 */
export async function resolveDevice(deviceId?: string): Promise<string | undefined> {
  if (deviceId) return deviceId;

  const devices = await listDevices();
  const online = devices.filter((d) => d.status === "device");

  if (online.length === 0) {
    throw new Error("No connected devices found. Start an emulator or connect a device.");
  }
  if (online.length === 1) {
    return online[0].id;
  }
  // Multiple devices — ADB will fail without -s, let caller know
  throw new Error(
    `Multiple devices connected (${online.map((d) => d.id).join(", ")}). Specify device_id.`,
  );
}
