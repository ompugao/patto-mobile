# patto-mobile

Tauri 2 + React viewer/editor for [patto](https://github.com/ompugao/patto) notes (desktop and Android).

## Development

```sh
npm install
npm run tauri dev          # desktop (Linux/macOS/Windows)
cd src-tauri && cargo test # Rust unit tests (renderer, image proxy)
```

### Images

Local images referenced from notes are served by a custom `pimg://` URI scheme
implemented in `src-tauri/src/image_proxy.rs`: anything larger than 1600 px on
its long edge is downscaled once, cached under the app cache dir
(`~/.cache/com.sifi.patto-mobile/img` on Linux) and streamed from there.
No image bytes cross the IPC bridge. Only files under the opened workspace are
served.

## Android

Toolchain is declared in `mise.toml` (Java 17, `ANDROID_HOME`, `NDK_HOME`).
With [mise](https://mise.jdx.dev) activated in your shell, from the project dir:

1. Install the SDK pieces once (Android Studio → SDK Manager, or `sdkmanager`):
   `platforms;android-36`, `build-tools;36.0.0`, `platform-tools`, `emulator`,
   `ndk;30.0.16248370` (or edit `NDK_HOME` in `mise.toml`), and a system image
   such as `system-images;android-36;google_apis;x86_64` for an emulator.
2. `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`
3. `avdmanager create avd -n patto -k "system-images;android-36;google_apis;x86_64"`
   (or plug in a phone with USB debugging; `adb devices` must list it)
4. `npm run tauri android dev`  — or `npm run tauri android build --debug --target aarch64`
