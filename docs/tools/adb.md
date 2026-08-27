# adb

> Control one online Android device at a time, transfer files and applications, collect logs and screenshots, send device input, and manage existing Android Virtual Devices (AVDs).

## Source

- Entry, schema, approval policy, execution, result details, and renderer: `packages/coding-agent/src/tools/adb.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/adb.md`
- Registration: `packages/coding-agent/src/tools/index.ts`
- Direct ADB process execution and executable discovery: `packages/coding-agent/src/adb/adb-executor.ts`
- AVD discovery and lifecycle: `packages/coding-agent/src/adb/emulator-manager.ts`

## Availability and prerequisites

`adb` has no enable setting. `AdbTool.createIf()` registers it only when the `adb` executable can be resolved. Resolution uses `PATH`, `ANDROID_SDK_ROOT`, or `ANDROID_HOME`; after changing that environment, refresh the session's tool inventory or start a new session so availability is evaluated again.

The tool has `discoverable` load mode and exclusive concurrency. Under the normal discoverable-tool policy it is mounted through the existing xdev path; explicitly selecting `toolNames: ["adb"]` keeps it as a top-level tool. There is no ADB-specific refresh mechanism.

Requirements depend on the operation:

- All operations require a working Android SDK Platform Tools `adb` executable.
- Device operations require an attached physical device or running emulator that `adb devices` reports as online.
- `avds`, `start`, and emulator lifecycle handling also require the Android SDK `emulator` executable.
- `start` accepts only an exact AVD name that is already configured and returned by `avds`.

The tool does not install the Android SDK or create AVDs.

## Inputs

The schema is a strict discriminated union. Unknown fields are rejected. All non-empty string fields must remain non-empty after trimming; coordinates are non-negative integers; `durationMs` is an integer from `1` through `60000`; and `lines` is an integer from `1` through `10000`.

Two inventory forms and sixteen operational forms make up the complete public schema:

| Form | Required fields | Optional fields | Behavior and defaults |
|---|---|---|---|
| `devices` | `op: "devices"` | None | Runs `adb devices -l` and lists serial, state, model, and product when available. |
| `avds` | `op: "avds"` | None | Lists exact configured AVD names. |
| `status` | `op: "status"` | `device` | Resolves one online device and reports its current device record. |
| `wait` | `op: "wait"`, `until: "connected" \| "booted"` | `device`, `timeout` | Waits for an online connection, or for Android boot completion. |
| `start` | `op: "start"`, `avd` | `waitUntil: "connected" \| "booted"`, `timeout` | Starts or reuses the exact AVD. `waitUntil` defaults to `"booted"`. |
| `stop` | `op: "stop"` | `device` | Stops an emulator. Physical devices are rejected. |
| `shell` | `op: "shell"`, `command` | `device`, `timeout` | Passes one command to `adb shell`. This is the device shell, not a local host shell. |
| `logcat` | `op: "logcat"` | `device`, `lines`, `filter`, `follow`, `timeout` | Finite dump by default: `follow` defaults to `false` and `lines` defaults to `200`. With `follow: true`, `lines` is an optional initial tail and the timeout still bounds streaming. `filter` is one logcat filter expression. |
| `screenshot` | `op: "screenshot"` | `device`, `timeout` | Captures the device display as PNG. |
| `push` | `op: "push"`, `localPath`, `remotePath` | `device`, `timeout` | Copies a host file or path to the device. |
| `pull` | `op: "pull"`, `remotePath`, `localPath` | `device`, `timeout` | Copies a device file or path to the host. |
| `install` | `op: "install"`, `apkPath` | `device`, `timeout` | Installs the specified host APK. |
| `uninstall` | `op: "uninstall"`, `package` | `device`, `timeout` | Uninstalls the exact package name. |
| `launch` | `op: "launch"`, `package` | `device`, `activity`, `timeout` | With `activity`, starts `package/activity`; otherwise invokes the package launcher category. |
| `input/tap` | `op: "input"`, `action: "tap"`, `x`, `y` | `device`, `timeout` | Sends one tap. |
| `input/swipe` | `op: "input"`, `action: "swipe"`, `x1`, `y1`, `x2`, `y2`, `durationMs` | `device`, `timeout` | Sends one bounded-duration swipe. |
| `input/text` | `op: "input"`, `action: "text"`, `text` | `device`, `timeout` | Sends device input text. |
| `input/keyevent` | `op: "input"`, `action: "keyevent"`, `key` | `device`, `timeout` | `key` is a non-empty string or a non-negative integer. |

`device` is always an ADB serial string. It may be omitted only when exactly one online device is available. If zero devices are online, selection fails. If multiple devices are online, selection fails rather than guessing; call `devices` and pass the intended serial. Explicit serials must identify an online device.

`timeout` is a positive number of seconds. The shared ADB timeout configuration defaults to `180` seconds and has an absolute minimum of `1` second and maximum of `3600` seconds. A positive `tools.maxTimeout` first caps the default or explicitly supplied value; the result is then clamped to `1..3600`. Operations that do not expose a `timeout` field still use that shared default budget internally; supplying the field to those forms is a schema error.

## Connection and boot states

`connected` means that the selected serial is present in the ADB device list in the online `device` state. Entries such as `offline` and `unauthorized` are not selectable online devices.

`booted` first requires the connected state and then waits for Android to report completed boot. Use `connected` only when an online transport is sufficient; commands that depend on Android services should normally wait for `booted`.

`status` and every device operation use the same selection rules. Emulator records additionally carry their exact AVD identity when it can be determined.

## Process and argument boundary

The implementation launches the resolved `adb` or `emulator` executable directly. Each operation constructs a fixed argument vector; there is no arbitrary ADB-argument escape hatch and no local-shell command string.

Paths, package names, activities, coordinates, filters, and input values occupy their defined argument positions. `shell.command` is likewise passed as one argument after `adb shell`; ADB delivers it to the Android device shell. It is therefore capable of device-shell syntax and device-side effects, but it is never evaluated by the host's local shell.

## Approval

The operation determines the base approval tier:

- Read tier: `devices`, `avds`, `status`, `wait`, `logcat`, and `screenshot`.
- Exec tier: `start`, `stop`, `shell`, `push`, `pull`, `install`, `uninstall`, `launch`, and every `input` action.

Malformed input and unknown or missing operations classify as exec rather than falling into the read tier. Approval details identify the operation and the relevant serial, AVD, command, paths, package, activity, input values, and timeout. The shared approval layer then applies global yolo behavior and any per-tool `adb` override; those settings can change whether the classified call prompts, but do not change its schema or execution behavior.

## Outputs and artifacts

Most successful operations return text. Text execution streams recent output to the renderer and uses the shared output limits. When output exceeds the inline spill threshold, the complete text is retained as a session artifact and the result points to `artifact://<id>`; previews retain the bounded tail. A successful command with no stdout returns `(no output)`.

`screenshot` is different:

1. It runs `adb -s <serial> exec-out screencap -p` and requires a valid PNG signature.
2. It writes the exact returned bytes to a unique `omp-adb-screenshot-…​.png` path under the operating-system temporary directory.
3. It returns a text block naming the path and byte count, followed by the same bytes as a base64 image block with MIME type `image/png`.
4. `AdbToolDetails` records `path`, `bytes`, `mimeType: "image/png"`, and, when a valid PNG IHDR is available, `width` and `height`. It also retains the selected `device`, `serial`, and optional AVD name.

Other result details are operation-specific and can include `avd`, `state`, `devices`, `avds`, `localPath`, `remotePath`, `package`, `activity`, and text-output metadata.

## Emulator lifecycle

`start` requires an existing exact AVD name. If that AVD is already running, it is reused; otherwise the emulator process is launched and the operation waits for `waitUntil` (`booted` by default). A successful start deliberately leaves the emulator running for later calls. Stop it explicitly with `stop` when it is no longer needed.

If a newly launched emulator fails or is aborted before reaching the requested state, startup cleans up that newly created process. Failure while reusing an already-running emulator does not tear down that pre-existing instance. `stop` resolves the selected target and rejects physical devices rather than attempting to power them off; it is only an emulator lifecycle operation.

## Errors and recovery

Errors are contextualized with the operation and, where available, the serial, local or remote path, package, and activity. Non-zero exits, timeouts, cancellation, and aborts retain the available output; spilled output is referenced as an artifact.

Common states and recovery:

- **Tool unavailable:** make `adb` resolvable through `PATH`, `ANDROID_SDK_ROOT`, or `ANDROID_HOME`, then refresh tool availability or begin a new session.
- **No online device:** attach and authorize a physical device, or start an existing AVD; use `devices` to confirm the `device` state.
- **Multiple online devices:** call `devices` and retry with an exact `device` serial.
- **`offline` or `unauthorized`:** reconnect the transport or accept the device's authorization prompt, then wait for `connected`.
- **Boot wait times out:** inspect `status` or `devices`, fix the emulator or device boot failure, and retry with an appropriate `timeout`.
- **AVD missing:** call `avds` and use an exact returned name. Create or repair the AVD outside this tool.
- **Emulator executable missing:** repair the SDK environment so `emulator` is resolvable; physical-device operations can still work when `adb` itself is available.
- **Physical-device stop rejected:** select an emulator serial instead. `stop` intentionally cannot stop a real phone or tablet.
- **Screenshot is not PNG:** ensure the target is online and sufficiently booted to serve `screencap`, then retry.
- **Command exits non-zero:** inspect the inline output or linked full-output artifact, correct the device-side state, identifier, permission, or path, and retry.
