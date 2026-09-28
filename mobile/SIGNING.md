# Signing the Android app

Every APK must be signed with the **same key** for its whole life. Android will only
install an update over an app signed by the key that signed it first; with a different key
the only way forward is to uninstall — losing whatever the phone had not yet uploaded.

The key is **not in this repository** and must never be. Keep the keystore and its password
somewhere backed up (a password manager takes both).

## Release builds on GitHub

`.github/workflows/release.yml` builds the APK on every `v*` tag and attaches it to the
release as `daily-diary-<version>-android.apk`. It needs four repository secrets
(Settings ▸ Secrets and variables ▸ Actions ▸ New repository secret):

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | the keystore file, base64-encoded |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | `daily-diary` |
| `ANDROID_KEY_PASSWORD` | the key password (the same as the keystore's here) |

Without them the Android job stops with an error rather than shipping an APK that could
never be updated.

## Building a signed APK locally

```bash
export ANDROID_KEYSTORE_FILE=/path/to/daily-diary-release.jks
export ANDROID_KEYSTORE_PASSWORD=…  ANDROID_KEY_ALIAS=daily-diary  ANDROID_KEY_PASSWORD=…
cd mobile && npm run apk:release
# -> android/app/build/outputs/apk/release/app-release.apk
```

Without those variables `apk:release` produces an unsigned APK, which Android will not
install. `npm run apk` (debug) is always installable, but only over another debug build.

## Making a new key

Only if the old one is truly gone — see the warning at the top.

```bash
keytool -genkeypair -keystore daily-diary-release.jks -storetype PKCS12 \
  -alias daily-diary -keyalg RSA -keysize 4096 -validity 36500
base64 -w0 daily-diary-release.jks   # -> ANDROID_KEYSTORE_BASE64
```
