package com.dailydiary.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

import okhttp3.Headers;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Everything the page needs from the phone to talk to Nextcloud.
 *
 * HTTP lives here rather than in the WebView because WebDAV needs PROPFIND and MKCOL,
 * which neither fetch() across origins nor Capacitor's own HTTP layer will send, and
 * because the app password should never have to live in JavaScript. After Login Flow v2
 * hands it over it is encrypted with a key held in the Android Keystore, and this class
 * adds it to requests for that one server by itself; the page only ever asks for
 * {@code auth: true}.
 *
 * Photos are streamed straight between the network and a file (fromFile / toFile) so a
 * full-resolution picture never crosses the JavaScript bridge as base64.
 */
@CapacitorPlugin(name = "Nextcloud")
public class NextcloudPlugin extends Plugin {
    private static final String PREFS = "nextcloud-account";
    private static final String KEY_ALIAS = "daily-diary-app-password";
    private static final String USER_AGENT = "daily-diary (Android)";
    private static final int MAX_TEXT_BYTES = 8 * 1024 * 1024;

    private OkHttpClient client;
    private final ExecutorService network = Executors.newFixedThreadPool(4);

    @Override
    public void load() {
        client = new OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(90, TimeUnit.SECONDS)
            .writeTimeout(90, TimeUnit.SECONDS)
            .build();
    }

    // ------------------------------------------------------------------ http

    @PluginMethod
    public void request(PluginCall call) {
        network.execute(() -> {
            try {
                call.resolve(perform(call));
            } catch (IOException error) {
                /* Status 0 is "never got an answer": offline, DNS, TLS. The page treats it
                   as offline and keeps what it has. */
                JSObject reply = new JSObject();
                reply.put("status", 0);
                reply.put("headers", new JSObject());
                reply.put("text", "");
                reply.put("error", error.getMessage() == null ? "Network error" : error.getMessage());
                call.resolve(reply);
            } catch (Exception error) {
                call.reject(error.getMessage() == null ? "Request failed" : error.getMessage());
            }
        });
    }

    private JSObject perform(PluginCall call) throws Exception {
        String method = call.getString("method", "GET").toUpperCase();
        String url = call.getString("url", "");
        Uri parsed = Uri.parse(url);
        if (!"https".equals(parsed.getScheme()) && !"http".equals(parsed.getScheme())) {
            throw new IllegalArgumentException("Only web addresses can be requested");
        }

        Request.Builder builder = new Request.Builder().url(url).header("User-Agent", USER_AGENT);
        JSObject headers = call.getObject("headers", new JSObject());
        String contentType = "application/octet-stream";
        for (Iterator<String> keys = headers.keys(); keys.hasNext(); ) {
            String name = keys.next();
            if ("authorization".equalsIgnoreCase(name)) continue;
            String value = headers.getString(name);
            if (value == null) continue;
            if ("content-type".equalsIgnoreCase(name)) contentType = value;
            builder.header(name, value);
        }

        if (call.getBoolean("auth", false)) {
            String authorization = authorizationFor(url);
            if (authorization == null) {
                JSObject reply = new JSObject();
                reply.put("status", 401);
                reply.put("headers", new JSObject());
                reply.put("text", "");
                return reply;
            }
            builder.header("Authorization", authorization);
        }

        RequestBody body = null;
        String fromFile = call.getString("fromFile");
        String text = call.getString("body");
        MediaType type = MediaType.parse(contentType);
        if (fromFile != null) body = RequestBody.create(inFiles(fromFile), type);
        else if (text != null) body = RequestBody.create(text.getBytes(StandardCharsets.UTF_8), type);
        else if ("PUT".equals(method) || "POST".equals(method) || "PROPFIND".equals(method)) body = RequestBody.create(new byte[0], type);
        builder.method(method, body);

        String toFile = call.getString("toFile");
        try (Response response = client.newCall(builder.build()).execute()) {
            JSObject reply = new JSObject();
            reply.put("status", response.code());
            JSObject replyHeaders = new JSObject();
            Headers received = response.headers();
            for (String name : received.names()) replyHeaders.put(name.toLowerCase(), received.get(name));
            reply.put("headers", replyHeaders);

            ResponseBody responseBody = response.body();
            if (toFile != null && response.code() == 200 && responseBody != null) {
                saveTo(responseBody.byteStream(), inFiles(toFile));
                reply.put("text", "");
            } else if (responseBody != null) {
                byte[] bytes = responseBody.source().readByteArray();
                if (bytes.length > MAX_TEXT_BYTES) throw new IOException("The server sent back far more than expected");
                reply.put("text", new String(bytes, StandardCharsets.UTF_8));
            } else {
                reply.put("text", "");
            }
            return reply;
        }
    }

    /** A path under the app's own files folder, and nowhere else. */
    private File inFiles(String relative) throws IOException {
        File base = getContext().getFilesDir().getCanonicalFile();
        File target = new File(base, relative).getCanonicalFile();
        if (!target.getPath().startsWith(base.getPath() + File.separator)) {
            throw new IOException("That file is outside the app's folder");
        }
        return target;
    }

    /** Written beside the target and renamed into place, so a dropped connection never
     *  leaves half a photo where a whole one is expected. */
    private void saveTo(InputStream in, File target) throws IOException {
        File parent = target.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) throw new IOException("Could not make " + parent.getName());
        File partial = new File(parent, "." + target.getName() + ".part");
        try (InputStream source = in; OutputStream out = Files.newOutputStream(partial.toPath())) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = source.read(buffer)) != -1) out.write(buffer, 0, read);
        }
        if (!partial.renameTo(target)) {
            //noinspection ResultOfMethodCallIgnored
            partial.delete();
            throw new IOException("Could not save " + target.getName());
        }
    }

    // ------------------------------------------------------------------ the account

    @PluginMethod
    public void saveAccount(PluginCall call) {
        String server = trimSlash(call.getString("server", ""));
        String user = call.getString("user", "");
        String loginName = call.getString("loginName", user);
        String password = call.getString("password", "");
        if (server.isEmpty() || user.isEmpty() || password.isEmpty()) {
            call.reject("The account is incomplete");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] sealed = cipher.doFinal(password.getBytes(StandardCharsets.UTF_8));
            prefs().edit()
                .putString("server", server)
                .putString("user", user)
                .putString("loginName", loginName)
                .putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                .putString("password", Base64.encodeToString(sealed, Base64.NO_WRAP))
                .apply();
            call.resolve();
        } catch (Exception error) {
            call.reject("The login could not be stored securely on this phone");
        }
    }

    /** Who is signed in — never the password. */
    @PluginMethod
    public void account(PluginCall call) {
        SharedPreferences prefs = prefs();
        JSObject reply = new JSObject();
        if (prefs.contains("password")) {
            reply.put("server", prefs.getString("server", ""));
            reply.put("user", prefs.getString("user", ""));
            reply.put("loginName", prefs.getString("loginName", ""));
        }
        call.resolve(reply);
    }

    @PluginMethod
    public void clearAccount(PluginCall call) {
        prefs().edit().clear().apply();
        try {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            store.deleteEntry(KEY_ALIAS);
        } catch (Exception ignored) {
            // Nothing stored, or already gone.
        }
        call.resolve();
    }

    /** Basic auth with the stored app password, but only for the server it was issued by —
     *  a link in an entry pointing somewhere else never gets it. */
    private String authorizationFor(String url) {
        SharedPreferences prefs = prefs();
        String server = prefs.getString("server", "");
        if (server.isEmpty() || !(url.equals(server) || url.startsWith(server + "/"))) return null;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            byte[] iv = Base64.decode(prefs.getString("iv", ""), Base64.NO_WRAP);
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
            byte[] open = cipher.doFinal(Base64.decode(prefs.getString("password", ""), Base64.NO_WRAP));
            String pair = prefs.getString("loginName", prefs.getString("user", "")) + ":" + new String(open, StandardCharsets.UTF_8);
            return "Basic " + Base64.encodeToString(pair.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
        } catch (Exception error) {
            return null;
        }
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) store.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return generator.generateKey();
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String trimSlash(String value) {
        String out = value == null ? "" : value.trim();
        while (out.endsWith("/")) out = out.substring(0, out.length() - 1);
        return out;
    }

    // ------------------------------------------------------------------ the browser

    /** Login Flow v2 and "Open in Nextcloud" both happen in the phone's own browser, where
     *  the person's password manager and two-factor app already are. */
    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url", "");
        Uri uri = Uri.parse(url);
        if (!"https".equals(uri.getScheme()) && !"http".equals(uri.getScheme())) {
            call.reject("Only web links can be opened");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("No browser is installed to open that");
        }
    }
}
