package pl.tysiac.gra;

import android.Manifest;

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

@CapacitorPlugin(
    name = "Multipeer",
    permissions = {
        @Permission(
            alias = "nearby",
            strings = {
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.BLUETOOTH_ADVERTISE,
                Manifest.permission.BLUETOOTH_CONNECT,
                Manifest.permission.BLUETOOTH_SCAN
            }
        )
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
        Payload payload = Payload.fromBytes(text.getBytes(StandardCharsets.UTF_8));
        client().sendPayload(new ArrayList<>(connected), payload);
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

    private void ensurePermissions(PluginCall call) {
        if (getPermissionState("nearby") != PermissionState.GRANTED) {
            requestPermissionForAlias("nearby", call, "nearbyPermissionCallback");
        } else {
            beginPendingMode(call);
        }
    }

    @PermissionCallback
    private void nearbyPermissionCallback(PluginCall call) {
        if (getPermissionState("nearby") == PermissionState.GRANTED) {
            beginPendingMode(call);
        } else {
            call.reject("Bez zgody na łączenie z urządzeniami w pobliżu gra nie znajdzie innych graczy");
        }
    }

    private void beginPendingMode(PluginCall call) {
        if ("host".equals(pendingMode)) {
            startAdvertisingNow(call);
        } else if ("browse".equals(pendingMode)) {
            startDiscoveryNow(call);
        } else {
            call.reject("Nieznany tryb");
        }
        pendingMode = null;
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
