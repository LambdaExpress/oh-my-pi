Control Android devices and Android Virtual Devices through the Android SDK.

- `devices` lists attached device serials and states. `avds` lists configured AVD names.
- Device operations accept `device`; omit it only when exactly one online device exists.
- `start` requires an exact AVD name. `wait` can wait for connection or completed Android boot.
- For app interaction, use `observe` → `click` → `wait`. Reserve screenshots and coordinate input for UI without accessible elements.
- `observe` returns JSON lines: a snapshot header, then elements with refs, text, resource IDs, descriptions, bounds, hierarchy and state flags. Password text is redacted. Truncated output links its full artifact.
- `click.selector` accepts an observed `ref` or a non-empty attribute selector. Attributes combine with AND; strings match exactly except `textContains`. Multiple matching elements are rejected; narrow the selector.
- Refs belong to the latest observation on one device in this session. New observations and device mutations invalidate them. Stale refs fail; observe again instead of guessing another ref.
- `click` refreshes the hierarchy before acting. Disabled or invisible targets are rejected; labels can target a clickable ancestor. A successful click confirms input dispatch, not the expected screen change.
- `wait` with `visible`, `hidden`, `enabled`, or `disabled` requires an attribute `selector`, never a ref. Positive conditions require one matching visible element; `hidden` means no visible matches. Dump failures remain errors.
- To wait for text or checked/focused state, include those attributes in the selector and use `until: "visible"`.
- `stop` applies only to emulators; physical devices cannot be stopped.
- `shell` passes one command to the device shell. Other operations use fixed ADB argument shapes; there is no arbitrary ADB argument escape hatch.
- `logcat` is a finite dump by default. Set `follow: true` only when streaming is required; `timeout` still bounds the call.
- `launch` starts an explicit activity when supplied, otherwise the package launcher.
- `input` supports only tap, swipe, text, and key events. Coordinates and duration are finite numbers.
- `input.text` uses Android key-event injection; Unicode input depends on the device's key map. It does not replace an element's existing text.
- Calls are classified for approval by operation: observation operations are read-tier; device, app, file, emulator, shell, and input mutations are exec-tier.
- `screenshot` runs `exec-out screencap -p`, preserves the exact PNG bytes in a unique temporary `.png` file, and returns the same bytes as `image/png` base64.
- ADB must be available through `PATH`, `ANDROID_SDK_ROOT`, or `ANDROID_HOME`. AVD listing and lifecycle also require the SDK emulator executable; ordinary physical-device operations do not.

Use exact SDK AVD names and device serials. Never guess a serial when multiple devices are online.

```json
{"op":"observe","device":"emulator-5554"}
{"op":"click","device":"emulator-5554","selector":{"resourceId":"com.example.app:id/login"}}
{"op":"wait","device":"emulator-5554","until":"visible","selector":{"text":"Welcome"},"timeout":20}
{"op":"wait","device":"emulator-5554","until":"hidden","selector":{"resourceId":"com.example.app:id/loading"},"timeout":20}
```
