#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";

import { adb, adbRaw, listDevices, getCurrentActivity, resolveDevice, type AdbOptions } from "./adb.js";
import { getUiHierarchy, findElements, elementCenter, flattenHierarchy, formatCompactTree } from "./hierarchy.js";

// ─── Key Code Map ───

const KEY_MAP: Record<string, number> = {
  HOME: 3,
  BACK: 4,
  CALL: 5,
  ENDCALL: 6,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_CENTER: 23,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  CAMERA: 27,
  CLEAR: 28,
  TAB: 61,
  ENTER: 66,
  SPACE: 62,
  DEL: 67, // Backspace
  MENU: 82,
  SEARCH: 84,
  MEDIA_PLAY_PAUSE: 85,
  ESCAPE: 111,
  DELETE: 112, // Forward delete
  APP_SWITCH: 187, // Recent apps
};

// ─── Server Setup ───

const server = new McpServer({
  name: "batdroid",
  version: "0.1.0",
});

// ─── Device Management Tools ───

server.tool(
  "list_devices",
  "List connected Android emulators and physical devices",
  async () => {
    const devices = await listDevices();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(devices, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "get_current_activity",
  "Return the currently focused activity and package name",
  { device_id: z.string().optional().describe("Target device ID (optional if only one device connected)") },
  async ({ device_id }) => {
    const deviceId = await resolveDevice(device_id);
    const activity = await getCurrentActivity({ deviceId });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(activity, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "launch_app",
  "Start an app by package name or specific activity",
  {
    package: z.string().describe("App package name (e.g. com.example.myapp)"),
    activity: z.string().optional().describe("Specific activity to launch (e.g. .MainActivity)"),
    device_id: z.string().optional().describe("Target device ID"),
  },
  async ({ package: pkg, activity, device_id }) => {
    const deviceId = await resolveDevice(device_id);
    const opts: AdbOptions = { deviceId };

    let result: string;
    if (activity) {
      const component = activity.startsWith(".") ? `${pkg}/${pkg}${activity}` : `${pkg}/${activity}`;
      result = await adb(["shell", "am", "start", "-n", component], opts);
    } else {
      result = await adb(["shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"], opts);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: result.trim() || `Launched ${pkg}${activity ? `/${activity}` : ""}`,
        },
      ],
    };
  },
);

// ─── Observation Tools ───

server.tool(
  "screenshot",
  "Capture the current screen as a PNG image",
  {
    device_id: z.string().optional().describe("Target device ID"),
    wait_ms: z.number().optional().describe("Milliseconds to wait before capture for UI to stabilize (default 500)"),
  },
  async ({ device_id, wait_ms }) => {
    const deviceId = await resolveDevice(device_id);
    const delay = wait_ms ?? 500;

    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const pngBuffer = await adbRaw(["exec-out", "screencap", "-p"], { deviceId });

    return {
      content: [
        {
          type: "image" as const,
          data: pngBuffer.toString("base64"),
          mimeType: "image/png",
        },
      ],
    };
  },
);

server.tool(
  "get_ui_hierarchy",
  "Dump and parse the UIAutomator accessibility tree. Elements with Modifier.testTag() appear as resource_id when testTagsAsResourceId is enabled. Returns compact text format by default (optimized for LLMs). Set compact=false for full JSON.",
  {
    device_id: z.string().optional().describe("Target device ID"),
    flat: z.boolean().optional().describe("Return flat list instead of tree (default false, easier to read)"),
    compact: z.boolean().optional().describe("Return compact text format optimized for LLMs (default true). Set false for full JSON."),
    max_depth: z.number().optional().describe("Maximum tree depth to return"),
  },
  async ({ device_id, flat, compact, max_depth }) => {
    const deviceId = await resolveDevice(device_id);
    const hierarchy = await getUiHierarchy({ deviceId });

    const useCompact = compact !== false;

    if (useCompact) {
      return {
        content: [
          {
            type: "text" as const,
            text: formatCompactTree(hierarchy, max_depth),
          },
        ],
      };
    }

    let output: unknown;
    if (flat) {
      output = flattenHierarchy(hierarchy, max_depth);
    } else {
      output = hierarchy;
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(output, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "record_screen",
  "Record the screen for a specified duration, return extracted frames as images",
  {
    duration_seconds: z.number().min(1).max(30).optional().describe("Recording duration in seconds (default 3, max 30)"),
    frame_interval_ms: z.number().optional().describe("Interval between extracted frames in ms (default 500)"),
    device_id: z.string().optional().describe("Target device ID"),
  },
  async ({ duration_seconds, frame_interval_ms, device_id }) => {
    const deviceId = await resolveDevice(device_id);
    const duration = duration_seconds ?? 3;
    const intervalMs = frame_interval_ms ?? 500;
    const fps = 1000 / intervalMs;

    // Create temp directory for frames
    const tmpDir = await mkdtemp(join(tmpdir(), "batdroid-"));
    const remotePath = "/sdcard/batdroid_recording.mp4";
    const localVideoPath = join(tmpDir, "recording.mp4");

    try {
      // Record screen
      await adb(
        ["shell", "screenrecord", "--time-limit", String(duration), remotePath],
        { deviceId, timeoutMs: (duration + 5) * 1000 },
      );

      // Pull video file
      await adb(["pull", remotePath, localVideoPath], { deviceId });

      // Clean up remote file
      await adb(["shell", "rm", remotePath], { deviceId }).catch(() => {});

      // Extract frames with ffmpeg
      // Use -fps_mode vfr + select filter to handle emulator screenrecord's
      // degenerate timestamps (Duration: N/A, zero-duration frames)
      const framePattern = join(tmpDir, "frame_%04d.png");
      const ffmpegResult = await new Promise<{ success: boolean; stderr: string }>((resolve) => {
        execFile(
          "ffmpeg",
          [
            "-i", localVideoPath,
            "-fps_mode", "vfr",
            "-vf", `select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,${intervalMs / 1000})'`,
            "-vsync", "0",
            framePattern,
          ],
          { timeout: 30_000 },
          (err, _stdout, stderr) => {
            resolve({ success: !err, stderr: String(stderr) });
          },
        );
      });

      // Fallback: if select filter produced no frames, just grab all unique frames
      const filesAfterFirst = await readdir(tmpDir);
      const framesAfterFirst = filesAfterFirst.filter((f) => f.startsWith("frame_") && f.endsWith(".png"));

      if (framesAfterFirst.length === 0) {
        await new Promise<void>((resolve) => {
          execFile(
            "ffmpeg",
            ["-i", localVideoPath, "-vsync", "0", framePattern],
            { timeout: 30_000 },
            () => resolve(),
          );
        });
      }

      // Read all frame files
      const files = await readdir(tmpDir);
      const frameFiles = files.filter((f) => f.startsWith("frame_") && f.endsWith(".png")).sort();

      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
        { type: "text" as const, text: `Recorded ${duration}s, extracted ${frameFiles.length} frames at ${intervalMs}ms intervals` },
      ];

      for (const frameFile of frameFiles) {
        const frameData = await readFile(join(tmpDir, frameFile));
        content.push({
          type: "image" as const,
          data: frameData.toString("base64"),
          mimeType: "image/png",
        });
      }

      return { content };
    } finally {
      // Clean up temp directory
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  },
);

// ─── Interaction Tools ───

server.tool(
  "tap_element",
  "Find a UI element by selector (resource_id, text, or content_desc) and tap its center",
  {
    resource_id: z.string().optional().describe("Element resource-id or testTag value"),
    text: z.string().optional().describe("Exact text content of the element"),
    content_desc: z.string().optional().describe("Content description (accessibility label)"),
    index: z.number().optional().describe("Index for disambiguation when multiple elements match (0-based)"),
    device_id: z.string().optional().describe("Target device ID"),
  },
  async ({ resource_id, text, content_desc, index, device_id }) => {
    if (!resource_id && !text && !content_desc) {
      return {
        content: [{ type: "text" as const, text: "Error: at least one of resource_id, text, or content_desc must be provided" }],
        isError: true,
      };
    }

    const deviceId = await resolveDevice(device_id);
    const hierarchy = await getUiHierarchy({ deviceId });

    const selector: { resource_id?: string; text?: string; content_desc?: string } = {};
    if (resource_id) selector.resource_id = resource_id;
    if (text) selector.text = text;
    if (content_desc) selector.content_desc = content_desc;

    const matches = findElements(hierarchy, selector);

    if (matches.length === 0) {
      return {
        content: [{ type: "text" as const, text: `No element found matching ${JSON.stringify(selector)}` }],
        isError: true,
      };
    }

    if (matches.length > 1 && index === undefined) {
      const summaries = matches.map((el, i) =>
        `[${i}] class=${el.class} text="${el.text}" bounds=[${el.bounds.x},${el.bounds.y},${el.bounds.width}x${el.bounds.height}]`
      );
      return {
        content: [{
          type: "text" as const,
          text: `Multiple elements match (${matches.length}). Specify index:\n${summaries.join("\n")}`,
        }],
        isError: true,
      };
    }

    const target = matches[index ?? 0];
    if (!target) {
      return {
        content: [{ type: "text" as const, text: `Index ${index} out of range (${matches.length} matches)` }],
        isError: true,
      };
    }

    const center = elementCenter(target);
    await adb(["shell", "input", "tap", String(center.x), String(center.y)], { deviceId });

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: true,
          element_found: { class: target.class, text: target.text, resource_id: target.resource_id },
          coordinates_tapped: center,
        }, null, 2),
      }],
    };
  },
);

server.tool(
  "tap_coordinates",
  "Tap at raw screen coordinates (x, y)",
  {
    x: z.number().describe("X coordinate"),
    y: z.number().describe("Y coordinate"),
    device_id: z.string().optional().describe("Target device ID"),
  },
  async ({ x, y, device_id }) => {
    const deviceId = await resolveDevice(device_id);
    await adb(["shell", "input", "tap", String(x), String(y)], { deviceId });
    return {
      content: [{ type: "text" as const, text: `Tapped at (${x}, ${y})` }],
    };
  },
);

server.tool(
  "type_text",
  "Type text into the currently focused input field. ASCII only — special characters are escaped automatically.",
  {
    text: z.string().describe("Text to type (ASCII only)"),
    device_id: z.string().optional().describe("Target device ID"),
  },
  async ({ text, device_id }) => {
    const deviceId = await resolveDevice(device_id);

    // Escape special characters for adb shell input text
    const escaped = text.replace(/([&|;<>()$`\\!"'~*?#{}[\] ])/g, "\\$1");
    await adb(["shell", "input", "text", escaped], { deviceId });

    return {
      content: [{ type: "text" as const, text: `Typed: "${text}"` }],
    };
  },
);

server.tool(
  "press_key",
  "Send a key event. Accepts named keys (BACK, HOME, ENTER, TAB, DPAD_UP, etc.) or numeric keycodes.",
  {
    key: z.string().describe("Key name (BACK, HOME, ENTER, TAB, DPAD_UP, DPAD_DOWN, DPAD_LEFT, DPAD_RIGHT, DEL, DELETE, VOLUME_UP, VOLUME_DOWN, POWER, APP_SWITCH, ESCAPE, MENU) or numeric keycode"),
    device_id: z.string().optional().describe("Target device ID"),
  },
  async ({ key, device_id }) => {
    const deviceId = await resolveDevice(device_id);

    const upper = key.toUpperCase();
    let keycode: string;

    if (KEY_MAP[upper] !== undefined) {
      keycode = String(KEY_MAP[upper]);
    } else if (/^\d+$/.test(key)) {
      keycode = key;
    } else {
      // Try with KEYCODE_ prefix
      keycode = `KEYCODE_${upper}`;
    }

    await adb(["shell", "input", "keyevent", keycode], { deviceId });

    return {
      content: [{ type: "text" as const, text: `Pressed key: ${key} (keycode ${keycode})` }],
    };
  },
);

server.tool(
  "swipe",
  "Perform a swipe gesture. Either specify exact coordinates or use direction + distance for convenience.",
  {
    start_x: z.number().optional().describe("Start X coordinate"),
    start_y: z.number().optional().describe("Start Y coordinate"),
    end_x: z.number().optional().describe("End X coordinate"),
    end_y: z.number().optional().describe("End Y coordinate"),
    direction: z.enum(["up", "down", "left", "right"]).optional().describe("Swipe direction (alternative to explicit coordinates)"),
    distance: z.number().optional().describe("Swipe distance in pixels when using direction (default 500)"),
    duration_ms: z.number().optional().describe("Swipe duration in milliseconds (default 300)"),
    device_id: z.string().optional().describe("Target device ID"),
  },
  async ({ start_x, start_y, end_x, end_y, direction, distance, duration_ms, device_id }) => {
    const deviceId = await resolveDevice(device_id);
    const dur = duration_ms ?? 300;
    const dist = distance ?? 500;

    let sx: number, sy: number, ex: number, ey: number;

    if (direction) {
      // Get screen resolution for centering
      const sizeOutput = await adb(["shell", "wm", "size"], { deviceId });
      const sizeMatch = sizeOutput.match(/(\d+)x(\d+)/);
      const screenW = sizeMatch ? parseInt(sizeMatch[1], 10) : 1080;
      const screenH = sizeMatch ? parseInt(sizeMatch[2], 10) : 1920;

      const cx = Math.round(screenW / 2);
      const cy = Math.round(screenH / 2);

      switch (direction) {
        case "up":
          sx = cx; sy = cy + dist / 2; ex = cx; ey = cy - dist / 2;
          break;
        case "down":
          sx = cx; sy = cy - dist / 2; ex = cx; ey = cy + dist / 2;
          break;
        case "left":
          sx = cx + dist / 2; sy = cy; ex = cx - dist / 2; ey = cy;
          break;
        case "right":
          sx = cx - dist / 2; sy = cy; ex = cx + dist / 2; ey = cy;
          break;
      }
    } else if (start_x !== undefined && start_y !== undefined && end_x !== undefined && end_y !== undefined) {
      sx = start_x; sy = start_y; ex = end_x; ey = end_y;
    } else {
      return {
        content: [{ type: "text" as const, text: "Error: provide either direction or all four coordinates (start_x, start_y, end_x, end_y)" }],
        isError: true,
      };
    }

    await adb(
      ["shell", "input", "swipe", String(sx), String(sy), String(ex), String(ey), String(dur)],
      { deviceId },
    );

    return {
      content: [{ type: "text" as const, text: `Swiped from (${sx}, ${sy}) to (${ex}, ${ey}) over ${dur}ms` }],
    };
  },
);

// ─── Configuration Tools ───

server.tool(
  "set_animations",
  "Enable or disable device animations (window, transition, animator duration scales)",
  {
    enabled: z.boolean().describe("true to enable animations (scale 1), false to disable (scale 0)"),
    device_id: z.string().optional().describe("Target device ID"),
  },
  async ({ enabled, device_id }) => {
    const deviceId = await resolveDevice(device_id);
    const scale = enabled ? "1" : "0";
    const opts: AdbOptions = { deviceId };

    const settings = [
      "window_animation_scale",
      "transition_animation_scale",
      "animator_duration_scale",
    ];

    // Read current values
    const previous: Record<string, string> = {};
    for (const setting of settings) {
      const val = await adb(["shell", "settings", "get", "global", setting], opts);
      previous[setting] = val.trim();
    }

    // Set new values
    for (const setting of settings) {
      await adb(["shell", "settings", "put", "global", setting, scale], opts);
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          previous,
          current: Object.fromEntries(settings.map((s) => [s, scale])),
        }, null, 2),
      }],
    };
  },
);

// ─── Start Server ───

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
