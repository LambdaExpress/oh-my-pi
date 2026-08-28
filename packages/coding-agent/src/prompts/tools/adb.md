Control Android devices and Android Virtual Devices through the Android SDK.

- `devices` lists attached device serials and states. `avds` lists configured AVD names.
- Device operations accept `device`; omit it only when exactly one online device exists.
- `start` requires an exact AVD name. `wait` can wait for connection or completed Android boot.
- `stop` applies only to emulators; physical devices cannot be stopped.
- `shell` passes one command to the device shell. Other operations use fixed ADB argument shapes; there is no arbitrary ADB argument escape hatch.
- `logcat` is a finite dump by default. Set `follow: true` only when streaming is required; `timeout` still bounds the call.
- `launch` starts an explicit activity when supplied, otherwise the package launcher.
- `input` supports only tap, swipe, text, and key events. Coordinates and duration are finite numbers.
- Calls are classified for approval by operation: observation operations are read-tier; device, app, file, emulator, shell, and input mutations are exec-tier.
- `screenshot` runs `exec-out screencap -p`, preserves the exact PNG bytes in a unique temporary `.png` file, and returns the same bytes as `image/png` base64.
- ADB must be available through `PATH`, `ANDROID_SDK_ROOT`, or `ANDROID_HOME`. AVD listing and lifecycle also require the SDK emulator executable; ordinary physical-device operations do not.

Use exact SDK AVD names and device serials. Never guess a serial when multiple devices are online.
