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
served. Tapping an image opens the original (`?full=1`) in a lightbox.

The protocol handler never decodes inside a request: on Android, wry blocks the
WebView's shared request thread until a handler responds, and Tauri IPC uses
that same thread, so a slow decode would stall every `invoke`. Large images
that are not cached yet are rendered without `src`; `src/lib/imageLoader.js`
asks Rust to decode them in the background (`prepare_images`) as they approach
the viewport and fills in `src` on the `image-ready` event.

### Soft keyboard

`AndroidManifest.xml` uses `windowSoftInputMode="adjustPan"`: with the default
`adjustResize`, every frame of the keyboard animation resizes the WebView and
relayouts the whole note (~300 ms per frame on a 12k-line note, i.e. several
seconds to open the search box). The in-note search bar likewise overlays the
content instead of pushing it down.

### Large notes

Lines are plain block boxes on purpose: `content-visibility: auto` looked like a
win for 12k-line notes but made the forced layout that focusing an input
triggers (IME state) churn through thousands of lock/unlock cycles (~10 s per
first focus on Android). YouTube links render as thumbnail facades and only
load the player iframe when tapped — a note with dozens of live players makes
every layout and keyboard interaction crawl.

### Note navigation

`src/lib/noteCache.js` keeps one scroll container per recently opened note
mounted inside the note view (only the active one is visible). Wikilink and
back navigation therefore never rebuild the DOM, and each note keeps its exact
scroll position; history entries store the scroll offset to restore.

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
