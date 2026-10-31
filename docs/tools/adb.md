# adb

> Control one online Android device at a time, transfer files and applications, collect logs and screenshots, send device input, and manage existing Android Virtual Devices (AVDs).

## Source

- Entry, schema, approval policy, execution, result details, and renderer: `packages/coding-agent/src/tools/adb.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/adb.md`
- Registration: `packages/coding-agent/src/tools/index.ts`
- Direct ADB process execution and executable discovery: `packages/coding-agent/src/adb/adb-executor.ts`
- AVD discovery and lifecycle: `packages/coding-agent/src/adb/emulator-manager.ts`
- Hierarchy queries and conservative input targeting: `packages/coding-agent/src/adb/{ui-automation,ui-hit-testing}.ts`

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

The command and emulator lifecycle forms are:

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

The hierarchy forms are:

| Form | Required fields | Optional fields | Behavior |
|---|---|---|---|
| `observe` | `op: "observe"` | `device`, `timeout` | Returns a snapshot header and one JSON line per accessible element. |
| `click` | `op: "click"`, `selector` | `device`, `longClick`, `timeout` | Refreshes the hierarchy, validates one target and its touch point, then issues one tap or long-press command. |
| `wait` for UI | `op: "wait"`, `selector`, `until: "visible" \| "hidden" \| "enabled" \| "disabled"` | `device`, `timeout` | Polls an attribute selector; refs cannot be used for waits. |

`click.selector` accepts either `{ ref }` from the latest observation on that device or a non-empty AND selector over text, resource ID, description, class, package, and state attributes. Strings match exactly except `textContains`. New observations and mutations invalidate refs.

`device` is always an ADB serial string. It may be omitted only when exactly one online device is available. If zero devices are online, selection fails. If multiple devices are online, selection fails rather than guessing; call `devices` and pass the intended serial. Explicit serials must identify an online device.

`timeout` is a positive number of seconds. The shared ADB timeout configuration defaults to `180` seconds and has an absolute minimum of `1` second and maximum of `3600` seconds. A positive `tools.maxTimeout` first caps the default or explicitly supplied value; the result is then clamped to `1..3600`. Operations that do not expose a `timeout` field still use that shared default budget internally; supplying the field to those forms is a schema error.

For `status`, ordinary device commands, and screenshots, device selection, emulator identity lookup, and command execution share one budget. Preflight time reduces the time available to the command. Timeout or cancellation terminates the active ADB client and prevents later stages from starting; process termination and output draining may add a short cleanup delay. The tool does not restart the shared ADB server or stop other devices to recover from a timeout.

## Connection and boot states

`connected` means that the selected serial is present in the ADB device list in the online `device` state. Entries such as `offline` and `unauthorized` are not selectable online devices.

`booted` first requires the connected state and then waits for Android to report completed boot. Use `connected` only when an online transport is sufficient; commands that depend on Android services should normally wait for `booted`.

`status` and every device operation use the same selection rules. Emulator records additionally carry their exact AVD identity when it can be determined.

## Process and argument boundary

The implementation launches the resolved `adb` or `emulator` executable directly. Each operation constructs a fixed argument vector; there is no arbitrary ADB-argument escape hatch and no local-shell command string.

Paths, package names, activities, coordinates, filters, and input values occupy their defined argument positions. `shell.command` is likewise passed as one argument after `adb shell`; ADB delivers it to the Android device shell. It is therefore capable of device-shell syntax and device-side effects, but it is never evaluated by the host's local shell.

Text input encodes ordinary spaces using Android input's `%s` convention and quotes the complete value for the remote POSIX shell. String key events receive the same remote-shell quoting; punctuation cannot introduce another device-shell command.

A process-backed command succeeds only after exit code zero and natural EOF on both output streams within its shared budget. A transfer acknowledgement alone is insufficient. Timeout diagnostics distinguish waiting for the ADB client to exit from waiting for inherited output pipes to close; cleanup never restarts the shared server.

## Input targeting and acknowledgement

`observe` visibility describes the clipped UI hierarchy, not proof that a physical point is unobstructed. Semantic clicks also check the default display's InputDispatcher touchable regions. An input-method window, another covering window, or unknown geometry refuses the action. Overlapping interactive branches in the same window are refused when hierarchy data cannot establish their drawing order. The tool does not dismiss the keyboard, send Back, or guess another point.

Input-denial messages present on command stdout or stderr fail the operation even after exit code zero. Some Android versions discard the injection result and report denial only in `system_server` logs. A quiet command exit does not establish that Android accepted the event or that application state changed.

Completed `click` and all four `input` actions therefore return `details.inputDispatch: "unconfirmed"`. The semantic click payload also exposes `click.inputDispatch`. Result text explains the uncertainty, and the ADB card uses warning presentation rather than a success check. Absence of `isError` means the command completed; it does not certify event acceptance. Raw `shell` retains its command-output contract and supplies no implicit injection acknowledgement.

The event may already have been injected, so an unconfirmed result must not be automatically repeated. Observe or wait for the caller's required UI state. This status does not install a device helper, change Android permissions, or infer acceptance from an unchanged hierarchy or the absence of a log message.

## Approval

The operation determines the base approval tier:

- Read tier: `devices`, `avds`, `status`, `wait`, `logcat`, and `screenshot`.
- Exec tier: `start`, `stop`, `shell`, `push`, `pull`, `install`, `uninstall`, `launch`, and every `input` action.

Malformed input and unknown or missing operations classify as exec rather than falling into the read tier. Approval details identify the operation and the relevant serial, AVD, command, paths, package, activity, input values, and timeout. The shared approval layer then applies global yolo behavior and any per-tool `adb` override; those settings can change whether the classified call prompts, but do not change its schema or execution behavior.

## Outputs and artifacts

Most successful operations return text. Text execution streams recent output to the renderer and uses the shared output limits. When output exceeds the inline spill threshold, the complete text is retained as a session artifact and the result points to `artifact://<id>`; previews retain the bounded tail. A successful command with no stdout returns `(no output)`.

`pull` transfers into a same-volume staging path and publishes only after the transfer succeeds. An existing file remains unchanged on failed or cancelled transfer. Existing-directory pulls preserve basename and recursive-merge behavior, including unrelated destination entries. Publication errors retain their operation and path context.

Finite `logcat` dumps retain at most `lines` recent physical lines in both the result and its artifact. Buffer headers and multiline-message continuations count toward this limit; a terminating newline does not add another line. With `follow: true`, `lines` remains the initial native tail request and does not cap subsequent streamed output.

`screenshot` is different:

1. It runs `adb -s <serial> exec-out screencap -p` and requires successful process completion and both output streams to reach EOF.
2. It validates complete PNG chunks, checksums, image data and end marker, and decodes the image before saving it. A PNG signature or dimensions alone cannot establish a complete screenshot.
3. It writes the exact returned bytes to a unique `omp-adb-screenshot-…​.png` path under the operating-system temporary directory.
4. It returns a text block naming the path and byte count, followed by the same bytes as a base64 image block with MIME type `image/png`.
5. `AdbToolDetails` records `path`, `bytes`, `mimeType: "image/png"`, `width`, and `height`. It also retains the selected `device`, `serial`, and optional AVD name.

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
