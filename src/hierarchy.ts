import { adb, type AdbOptions } from "./adb.js";

export interface UiElement {
  resource_id: string;
  text: string;
  content_desc: string;
  class: string;
  package: string;
  bounds: { x: number; y: number; width: number; height: number };
  clickable: boolean;
  enabled: boolean;
  scrollable: boolean;
  children: UiElement[];
}

interface RawBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Parse UIAutomator bounds string "[left,top][right,bottom]" into structured bounds.
 */
function parseBounds(boundsStr: string): UiElement["bounds"] {
  const match = boundsStr.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const raw: RawBounds = {
    left: parseInt(match[1], 10),
    top: parseInt(match[2], 10),
    right: parseInt(match[3], 10),
    bottom: parseInt(match[4], 10),
  };
  return {
    x: raw.left,
    y: raw.top,
    width: raw.right - raw.left,
    height: raw.bottom - raw.top,
  };
}

/**
 * Minimal XML parser for UIAutomator dump output.
 * UIAutomator produces a simple, predictable XML structure, so we don't need a full XML library.
 */
function parseUiAutomatorXml(xml: string): UiElement[] {
  const elements: UiElement[] = [];
  const stack: UiElement[] = [];

  // Match self-closing or opening tags for "node" elements
  const tagRegex = /<node\s+([^>]*?)\s*\/?>|<\/node>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(xml)) !== null) {
    const fullMatch = match[0];

    if (fullMatch === "</node>") {
      // Closing tag — pop from stack
      stack.pop();
      continue;
    }

    const attrs = match[1];
    const isSelfClosing = fullMatch.endsWith("/>");

    const element: UiElement = {
      resource_id: extractAttr(attrs, "resource-id"),
      text: extractAttr(attrs, "text"),
      content_desc: extractAttr(attrs, "content-desc"),
      class: extractAttr(attrs, "class"),
      package: extractAttr(attrs, "package"),
      bounds: parseBounds(extractAttr(attrs, "bounds")),
      clickable: extractAttr(attrs, "clickable") === "true",
      enabled: extractAttr(attrs, "enabled") === "true",
      scrollable: extractAttr(attrs, "scrollable") === "true",
      children: [],
    };

    if (stack.length > 0) {
      stack[stack.length - 1].children.push(element);
    } else {
      elements.push(element);
    }

    if (!isSelfClosing) {
      stack.push(element);
    }
  }

  return elements;
}

/**
 * Extract an XML attribute value by name from an attribute string.
 */
function extractAttr(attrs: string, name: string): string {
  const regex = new RegExp(`${name}="([^"]*)"` );
  const match = attrs.match(regex);
  return match ? match[1] : "";
}

/**
 * Dump and parse the UI hierarchy from a device.
 */
export async function getUiHierarchy(opts: AdbOptions = {}): Promise<UiElement[]> {
  const xml = await adb(
    ["exec-out", "uiautomator", "dump", "/dev/tty"],
    { ...opts, timeoutMs: opts.timeoutMs ?? 10_000 },
  );

  // uiautomator dump appends "UI hierchary dumped to: /dev/tty" at the end
  const xmlContent = xml.replace(/UI hierarch?y dumped to:.*$/i, "").trim();

  if (!xmlContent.includes("<hierarchy")) {
    throw new Error(`UIAutomator dump returned unexpected output: ${xmlContent.slice(0, 200)}`);
  }

  return parseUiAutomatorXml(xmlContent);
}

/**
 * Find elements in the hierarchy matching a selector.
 */
export function findElements(
  roots: UiElement[],
  selector: { resource_id?: string; text?: string; content_desc?: string },
): UiElement[] {
  const results: UiElement[] = [];

  function walk(elements: UiElement[]): void {
    for (const el of elements) {
      let match = true;

      if (selector.resource_id !== undefined) {
        // Match by full resource-id or just the ID part after the "/"
        const idPart = el.resource_id.includes("/")
          ? el.resource_id.split("/").pop()!
          : el.resource_id;
        match = match && (el.resource_id === selector.resource_id || idPart === selector.resource_id);
      }
      if (selector.text !== undefined) {
        match = match && el.text === selector.text;
      }
      if (selector.content_desc !== undefined) {
        match = match && el.content_desc === selector.content_desc;
      }

      if (match) {
        results.push(el);
      }

      walk(el.children);
    }
  }

  walk(roots);
  return results;
}

/**
 * Compute the center point of an element's bounds.
 */
export function elementCenter(el: UiElement): { x: number; y: number } {
  return {
    x: Math.round(el.bounds.x + el.bounds.width / 2),
    y: Math.round(el.bounds.y + el.bounds.height / 2),
  };
}

/**
 * Strip common Android class prefixes to shorten class names.
 */
export function shortenClassName(cls: string): string {
  const prefixes = ["android.widget.", "android.view.", "android.webkit."];
  for (const prefix of prefixes) {
    if (cls.startsWith(prefix)) return cls.slice(prefix.length);
  }
  if (cls.startsWith("androidx.")) {
    const lastDot = cls.lastIndexOf(".");
    return lastDot !== -1 ? cls.slice(lastDot + 1) : cls;
  }
  return cls;
}

/**
 * Format the UI hierarchy as a compact indented text tree optimized for LLM consumption.
 */
export function formatCompactTree(roots: UiElement[], maxDepth = 15): string {
  const lines: string[] = [];

  function walk(elements: UiElement[], depth: number): void {
    if (depth > maxDepth) return;
    const indent = "  ".repeat(depth);
    for (const el of elements) {
      const parts: string[] = [shortenClassName(el.class)];

      if (el.text) parts.push(`"${el.text}"`);

      const b = el.bounds;
      parts.push(`[${b.x},${b.y} ${b.width}x${b.height}]`);

      if (el.resource_id) {
        const id = el.resource_id.includes("/")
          ? el.resource_id.split("/").pop()!
          : el.resource_id;
        parts.push(`id:${id}`);
      }

      if (el.content_desc) parts.push(`desc:"${el.content_desc}"`);
      if (el.clickable) parts.push("[clickable]");
      if (el.scrollable) parts.push("[scrollable]");

      lines.push(`${indent}${parts.join(" ")}`);
      walk(el.children, depth + 1);
    }
  }

  walk(roots, 0);
  return lines.join("\n");
}

/**
 * Flatten the hierarchy into a list for easier display, with depth info.
 */
export function flattenHierarchy(
  roots: UiElement[],
  maxDepth = 20,
): Array<UiElement & { depth: number }> {
  const result: Array<UiElement & { depth: number }> = [];

  function walk(elements: UiElement[], depth: number): void {
    if (depth > maxDepth) return;
    for (const el of elements) {
      result.push({ ...el, depth, children: [] });
      walk(el.children, depth + 1);
    }
  }

  walk(roots, 0);
  return result;
}
