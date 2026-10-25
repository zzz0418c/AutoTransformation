# AutoTransformation for Android

A tiny WebView shell around the local AutoTransformation server. No AndroidX,
no Gradle, no third-party libraries. The APK is about 33 KB.

## What it does

- System WebView loads the server URL (default `http://127.0.0.1:8787`).
- Native top bar: `刷新` (reload) and `服务器` (server address).
- Server address is stored in `SharedPreferences`.
- Image upload uses the system photo picker (`ACTION_GET_CONTENT`), so no storage
  permission is needed.
- Downloads (`.ics`, `.md`, `.txt`) are handed to the browser.
- The web app's own top bar is hidden, so there is only one header.

The server still runs on the PC. For USB debugging:

```powershell
adb reverse tcp:8787 tcp:8787
adb install -r ..\dist\AutoTransformation-tablet.apk
adb shell am start -n com.zzz0418c.autotransformation/.MainActivity
```

For Wi-Fi, start the PC server with `HOST=0.0.0.0`, then set the tablet's server
address to `http://<PC-LAN-IP>:8787`.

## Build

Requirements:

- JDK 17
- Android SDK Platform 34 (`android.jar`)
- Android SDK Build Tools 34 (`aapt2`, `d8`, `zipalign`, `apksigner`)
- `ANDROID_HOME` pointing at the SDK

```powershell
powershell -ExecutionPolicy Bypass -File android\build.ps1 -Jdk "C:\path\to\jdk-17"
```

If `JAVA_HOME` is already a valid JDK 17, `-Jdk` can be omitted.

The build uses the standard tools directly:

1. `aapt2 compile` / `aapt2 link`
2. `javac` against `android.jar`
3. `d8` for dex
4. `zipalign`
5. `apksigner` with the standard Android debug keystore

Output: `dist\AutoTransformation-tablet.apk` (ignored by git).

## Layout

- `AndroidManifest.xml` — minSdk 24, targetSdk 34, cleartext HTTP allowed.
- `src/com/zzz0418c/autotransformation/MainActivity.java` — all UI and WebView logic.
- `res/mipmap-*/ic_launcher.png` — launcher icons.
- `build.ps1` — reproducible manual build.

## Notes

- Debug-signed; for sideloading only.
- Tested on vivo iPA2575, Android 16, 3096×2064.
- The WebView DevTools socket is enabled; use `adb forward` + `chrome://inspect`
  for debugging.
