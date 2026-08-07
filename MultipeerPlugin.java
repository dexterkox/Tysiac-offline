package pl.tysiac.gra;

import android.Manifest;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import com.google.android.gms.nearby.Nearby;
import com.google.android.gms.nearby.connection.AdvertisingOptions;
import com.google.android.gms.nearby.connection.ConnectionInfo;
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback;
import com.google.android.gms.nearby.connection.ConnectionResolution;
import com.google.android.gms.nearby.connection.ConnectionsClient;
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo;
import com.google.android.gms.nearby.connection.DiscoveryOptions;
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback;
import com.google.android.gms.nearby.connection.Payload;
import com.google.android.gms.nearby.connection.PayloadCallback;
import com.google.android.gms.nearby.connection.PayloadTransferUpdate;
import com.google.android.gms.nearby.connection.Strategy;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import androidx.annotation.NonNull;

/*
 Łączenie bez sieci — odpowiednik iOS-owego MultipeerConnectivity.

 Nearby Connections łączy telefony bezpośrednio, przez Bluetooth i Wi-Fi Direct.
 Nie potrzeba routera, hotspotu ani internetu, więc działa w samolocie.

 Napisane w Javie, bo projekt generowany przez Capacitora nie ma włączonej
 obsługi Kotlina — dodawanie jej to kolejne miejsca, w których coś może pęknąć.

 Nazwy metod i zdarzeń są takie same jak w wersji na iOS, dzięki czemu kod
 JavaScript nie musi wiedzieć, na jakim systemie działa.
*/

/*
 Uprawnienia rozbite na dwie grupy, bo Android zmienił zasady w wersji 12 i 13:
   • do Androida 11 wykrywanie przez Bluetooth wymaga LOKALIZACJI,
   • od Androida 12 są osobne uprawnienia BLUETOOTH_SCAN / ADVERTISE / CONNECT,
   • od Androida 13 lokalizacja przestaje być potrzebna.
 Prosząc o wszystko naraz, na nowszych systemach pytalibyśmy o lokalizację bez powodu
 i użytkownik utknąłby na odmowie, której nie da się cofnąć.
*/
@CapacitorPlugin(
    name = "Multipeer",
    permissions = {
        @Permission(alias = "bluetooth", strings = {
            Manifest.permission.BLUETOOTH_ADVERTISE,
            Manifest.permission.BLUETOOTH_CONNECT,
            Manifest.permission.BLUETOOTH_SCAN
        }),
        @Permission(alias = "location", strings = {
            Manifest.permission.ACCESS_FINE_LOCATION
        })
    }
)
public class MultipeerPlugin extends Plugin {

    /** Unikalny identyfikator, po którym Nearby odsiewa obce aplikacje. */
    private static final String SERVICE_ID = "pl.tysiac.gra";

    /** Gwiazda: jeden gospodarz, reszta dołącza — dokładnie nasz układ. */
    private static final Strategy STRATEGY = Strategy.P2P_STAR;

    private String localName = "Gracz";
    private final Map<String, String> discovered = new HashMap<>();
    private final Set<String> connected = new HashSet<>();
    private String pendingMode = null;

    private ConnectionsClient client() {
        return Nearby.getConnectionsClient(getContext());
    }

    // ------------------------------------------------------------- API

    @PluginMethod
    public void isSupported(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("supported", true);
        /* Uprawnienia to nie wszystko — Bluetooth bywa po prostu wyłączony, a wtedy lista
           graczy też pozostanie pusta. Aplikacja musi umieć o tym powiedzieć. */
        boolean btOn = false;
        try {
            android.bluetooth.BluetoothManager bm =
                (android.bluetooth.BluetoothManager) getContext()
                    .getSystemService(android.content.Context.BLUETOOTH_SERVICE);
            btOn = (bm != null && bm.getAdapter() != null && bm.getAdapter().isEnabled());
        } catch (Exception ignored) { }
        ret.put("bluetoothOn", btOn);
        call.resolve(ret);
    }

    @PluginMethod
    public void startHosting(PluginCall call) {
        localName = call.getString("displayName", "Gracz");
        pendingMode = "host";
        ensurePermissions(call);
    }

    @PluginMethod
    public void startBrowsing(PluginCall call) {
        localName = call.getString("displayName", "Gracz");
        pendingMode = "browse";
        ensurePermissions(call);
    }

    @PluginMethod
    public void invite(final PluginCall call) {
        String name = call.getString("peer");
        if (name == null) {
            call.reject("Brak nazwy gracza");
            return;
        }
        String endpoint = null;
        for (Map.Entry<String, String> e : discovered.entrySet()) {
            if (e.getValue().equals(name)) { endpoint = e.getKey(); break; }
        }
        if (endpoint == null) {
            call.reject("Nie znaleziono tej gry");
            return;
        }
        final String peerName = name;
        client().requestConnection(localName, endpoint, connectionCallback)
            .addOnSuccessListener(unused -> {
                JSObject ret = new JSObject();
                ret.put("invited", peerName);
                call.resolve(ret);
            })
            .addOnFailureListener(e -> call.reject(msg(e, "Nie udało się połączyć")));
    }

    @PluginMethod
    public void send(PluginCall call) {
        String text = call.getString("data");
        if (text == null) {
            call.reject("Brak danych");
            return;
        }
        JSObject ret = new JSObject();
        if (connected.isEmpty()) {
            /* Gra i tak powtarza stan co kilka sekund, więc to nie jest błąd krytyczny. */
            ret.put("sent", false);
            call.resolve(ret);
            return;
        }

        /* Karty każdego gracza wysyłamy wyłącznie do niego. Bez adresowania stan całej gry
           trafiałby na wszystkie urządzenia i dałoby się podejrzeć cudzą rękę. */
        String peer = call.getString("peer");
        List<String> targets = new ArrayList<>();
        if (peer != null) {
            for (Map.Entry<String, String> e : discovered.entrySet()) {
                if (e.getValue().equals(peer) && connected.contains(e.getKey())) {
                    targets.add(e.getKey());
                }
            }
            if (targets.isEmpty()) {
                ret.put("sent", false);
                call.resolve(ret);
                return;
            }
        } else {
            targets.addAll(connected);
        }

        Payload payload = Payload.fromBytes(text.getBytes(StandardCharsets.UTF_8));
        client().sendPayload(targets, payload);
        ret.put("sent", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        client().stopAdvertising();
        client().stopDiscovery();
        client().stopAllEndpoints();
        discovered.clear();
        connected.clear();
        call.resolve();
    }

    // ----------------------------------------------------- uprawnienia

    /** Które grupy uprawnień są w ogóle potrzebne na tej wersji Androida. */
    private List<String> requiredAliases() {
        List<String> out = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            out.add("bluetooth");
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            out.add("location");
        }
        return out;
    }

    private List<String> missingAliases() {
        List<String> missing = new ArrayList<>();
        for (String alias : requiredAliases()) {
            if (getPermissionState(alias) != PermissionState.GRANTED) missing.add(alias);
        }
        return missing;
    }

    /** Pozwala aplikacji pokazać listę kontrolną, zamiast po cichu nie znajdować graczy. */
    @PluginMethod
    public void checkNearbyPermissions(PluginCall call) {
        List<String> missing = missingAliases();
        JSObject ret = new JSObject();
        ret.put("granted", missing.isEmpty());
        JSArray arr = new JSArray();
        for (String m : missing) arr.put(m);
        ret.put("missing", arr);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestNearbyPermissions(PluginCall call) {
        List<String> missing = missingAliases();
        if (missing.isEmpty()) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        /* Prosimy o jedną brakującą grupę; po odpowiedzi sprawdzamy, czy zostały kolejne. */
        requestPermissionForAlias(missing.get(0), call, "permissionStepCallback");
    }

    @PermissionCallback
    private void permissionStepCallback(PluginCall call) {
        List<String> missing = missingAliases();
        if (!missing.isEmpty()) {
            requestPermissionForAlias(missing.get(0), call, "permissionStepCallback");
            return;
        }
        JSObject ret = new JSObject();
        ret.put("granted", true);
        call.resolve(ret);
    }

    private void ensurePermissions(PluginCall call) {
        if (missingAliases().isEmpty()) {
            beginPendingMode(call);
        } else {
            requestPermissionForAlias(missingAliases().get(0), call, "nearbyPermissionCallback");
        }
    }

    @PermissionCallback
    private void nearbyPermissionCallback(PluginCall call) {
        List<String> missing = missingAliases();
        if (missing.isEmpty()) {
            beginPendingMode(call);
        } else if (!missing.equals(requiredAliases())) {
            /* Część już przyznana — pytamy o kolejną grupę. */
            requestPermissionForAlias(missing.get(0), call, "nearbyPermissionCallback");
        } else {
            call.reject("Bez zgody na łączenie z urządzeniami w pobliżu gra nie znajdzie innych graczy");
        }
    }

    // ----------------------------------------------------------- tryby

    private void startAdvertisingNow(final PluginCall call) {
        AdvertisingOptions options = new AdvertisingOptions.Builder().setStrategy(STRATEGY).build();
        client().startAdvertising(localName, SERVICE_ID, connectionCallback, options)
            .addOnSuccessListener(unused -> {
                JSObject ret = new JSObject();
                ret.put("hosting", true);
                ret.put("name", localName);
                call.resolve(ret);
            })
            .addOnFailureListener(e -> call.reject(msg(e, "Nie udało się ogłosić gry")));
    }

    private void startDiscoveryNow(final PluginCall call) {
        DiscoveryOptions options = new DiscoveryOptions.Builder().setStrategy(STRATEGY).build();
        client().startDiscovery(SERVICE_ID, discoveryCallback, options)
            .addOnSuccessListener(unused -> {
                JSObject ret = new JSObject();
                ret.put("browsing", true);
                call.resolve(ret);
            })
            .addOnFailureListener(e -> call.reject(msg(e, "Nie udało się rozpocząć wyszukiwania")));
    }

    private String msg(Exception e, String fallback) {
        return (e != null && e.getMessage() != null) ? e.getMessage() : fallback;
    }

    private void emit(String event, String key, String value) {
        JSObject data = new JSObject();
        data.put(key, value);
        notifyListeners(event, data);
    }

    // --------------------------------------------------- nasłuchiwanie

    private final EndpointDiscoveryCallback discoveryCallback = new EndpointDiscoveryCallback() {
        @Override
        public void onEndpointFound(@NonNull String endpointId, @NonNull DiscoveredEndpointInfo info) {
            discovered.put(endpointId, info.getEndpointName());
            emit("peerFound", "name", info.getEndpointName());
        }

        @Override
        public void onEndpointLost(@NonNull String endpointId) {
            String name = discovered.remove(endpointId);
            if (name != null) emit("peerLost", "name", name);
        }
    };

    private final ConnectionLifecycleCallback connectionCallback = new ConnectionLifecycleCallback() {
        @Override
        public void onConnectionInitiated(@NonNull String endpointId, @NonNull ConnectionInfo info) {
            discovered.put(endpointId, info.getEndpointName());
            /* Gra jest ogłaszana tylko wtedy, gdy gospodarz sam tego chce, więc przyjmujemy
               połączenie od razu, bez dodatkowego pytania na ekranie. */
            client().acceptConnection(endpointId, payloadCallback);
            emit("connecting", "name", info.getEndpointName());
        }

        @Override
        public void onConnectionResult(@NonNull String endpointId, @NonNull ConnectionResolution result) {
            String name = discovered.containsKey(endpointId) ? discovered.get(endpointId) : endpointId;
            if (result.getStatus().isSuccess()) {
                connected.add(endpointId);
                emit("connected", "name", name);
            } else {
                emit("error", "message", "Połączenie odrzucone: " + name);
            }
        }

        @Override
        public void onDisconnected(@NonNull String endpointId) {
            String name = discovered.containsKey(endpointId) ? discovered.get(endpointId) : endpointId;
            connected.remove(endpointId);
            emit("disconnected", "name", name);
        }
    };

    private final PayloadCallback payloadCallback = new PayloadCallback() {
        @Override
        public void onPayloadReceived(@NonNull String endpointId, @NonNull Payload payload) {
            byte[] bytes = payload.asBytes();
            if (bytes == null) return;
            String text = new String(bytes, StandardCharsets.UTF_8);
            String name = discovered.containsKey(endpointId) ? discovered.get(endpointId) : endpointId;
            JSObject data = new JSObject();
            data.put("name", name);
            data.put("data", text);
            notifyListeners("data", data);
        }

        @Override
        public void onPayloadTransferUpdate(@NonNull String endpointId, @NonNull PayloadTransferUpdate update) {
            /* Wiadomości są krótkie i lecą w jednym kawałku, więc postęp nas nie interesuje. */
        }
    };
}
