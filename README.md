# batdroid

An MCP server for controlling Android devices and emulators via ADB. Lets LLMs take screenshots, inspect UI hierarchies, tap elements, type text, and more.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [ADB](https://developer.android.com/tools/adb) on your `PATH`
- An Android emulator or physical device connected via ADB
- [ffmpeg](https://ffmpeg.org/) (only needed for `record_screen`)

## Install

```bash
npm install
npm run build
```

## Usage

batdroid communicates over stdio using the [Model Context Protocol](https://modelcontextprotocol.io). Add it to your MCP client config:

```json
{
  "mcpServers": {
    "batdroid": {
      "command": "node",
      "args": ["/absolute/path/to/batdroid/dist/server.js"]
    }
  }
}
```

## Tools

### Device management

| Tool | Description |
|------|-------------|
| `list_devices` | List connected emulators and physical devices |
| `get_current_activity` | Return the currently focused activity and package name |
| `launch_app` | Start an app by package name or specific activity |

### Observation

| Tool | Description |
|------|-------------|
| `screenshot` | Capture the current screen as a PNG image |
| `get_ui_hierarchy` | Dump the UIAutomator accessibility tree (compact text by default, JSON optional) |
| `record_screen` | Record screen for a duration and return extracted frames |

### Interaction

| Tool | Description |
|------|-------------|
| `tap_element` | Find a UI element by selector and tap its center |
| `tap_coordinates` | Tap at raw screen coordinates |
| `type_text` | Type text into the currently focused input field |
| `press_key` | Send a key event (BACK, HOME, ENTER, etc.) |
| `swipe` | Swipe by direction or exact coordinates |

### Configuration

| Tool | Description |
|------|-------------|
| `set_animations` | Enable or disable device animations |

## Compact UI hierarchy

`get_ui_hierarchy` returns a compact text format by default, reducing token usage by 70-85% compared to full JSON. Example output:

```
FrameLayout [0,0 1080x1920]
  LinearLayout [0,0 1080x1920]
    TextView "Hello World" [0,50 1080x100] id:greeting
    Button "Submit" [0,150 1080x80] id:submit_btn [clickable]
    ScrollView [0,230 1080x400] [scrollable]
```

Pass `compact: false` to get the full JSON tree, or combine with `flat: true` for a flat JSON list.

## License

MIT
