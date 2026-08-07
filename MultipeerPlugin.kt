package pl.tysiac.gra

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.*
import android.Manifest
import android.os.Build

/*
 Łączenie bez sieci — odpowiednik iOS-owego MultipeerConnectivity.

 Nearby Connections łączy telefony bezpośrednio, używając Bluetooth i Wi-Fi Direct.
 Nie potrzeba routera, hotspotu ani internetu, więc działa w samolocie.

 Nazwy metod i zdarzeń są celowo identyczne jak w wersji na iOS, dzięki czemu
 `nearby.js` po stronie JavaScriptu nie musi wiedzieć, na jakim systemie działa.
*/

@CapacitorPlugin(
    name = "Multipeer",
    permissions = [
        Permission(
            alias = "nearby",
            strings = [
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.BLUETOOTH_ADVERTISE,
                Manifest.permission.BLUETOOTH_CONNECT,
                Manifest.permission.BLUETOOTH_SCAN
            ]
        )
    ]
)
class MultipeerPlugin : Plugin() {

    /** Musi być unikalny; Nearby używa go do odsiania obcych aplikacji. */
    private val serviceId = "pl.tysiac.gra"

    /** Gwiazda: jeden gospodarz, reszta dołącza — dokładnie nasz układ. */
    private val strategy = Strategy.P2P_STAR

    private var localName = "Gracz"
    private val discovered = HashMap<String, String>()   // endpointId -> nazwa
    private val connected = HashSet<String>()
    private var pendingCall: PluginCall? = null
    private var pendingMode: String? = null

    private fun client() = Nearby.getConnectionsClient(context)

    // ---------------------------------------------------------------- API

    @PluginMethod
    fun isSupported(call: PluginCall) {
        call.resolve(JSObject().put("supported", true))
    }

    @PluginMethod
    fun startHosting(call: PluginCall) {
        localName = call.getString("displayName") ?: "Gracz"
        pendingCall = call
        pendingMode = "host"
        requestNearbyPermissions(call)
    }

    @PluginMethod
    fun startBrowsing(call: PluginCall) {
        localName = call.getString("displayName") ?: "Gracz"
        pendingCall = call
        pendingMode = "browse"
        requestNearbyPermissions(call)
    }

    @PluginMethod
    fun invite(call: PluginCall) {
        val name = call.getString("peer")
        if (name == null) { call.reject("Brak nazwy gracza"); return }
        val endpoint = discovered.entries.firstOrNull { it.value == name }?.key
        if (endpoint == null) { call.reject("Nie znaleziono tej gry"); return }

        client().requestConnection(localName, endpoint, connectionCallback)
            .addOnSuccessListener { call.resolve(JSObject().put("invited", name)) }
            .addOnFailureListener { e -> call.reject(e.message ?: "Nie udało się połączyć") }
    }

    @PluginMethod
    fun send(call: PluginCall) {
        val text = call.getString("data")
        if (text == null) { call.reject("Brak danych"); return }
        if (connected.isEmpty()) {
            /* Gra i tak powtarza stan co kilka sekund, więc to nie jest błąd krytyczny. */
            call.resolve(JSObject().put("sent", false)); return
        }
        val payload = Payload.fromBytes(text.toByteArray(Charsets.UTF_8))
        client().sendPayload(connected.toList(), payload)
        call.resolve(JSObject().put("sent", true))
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        client().stopAdvertising()
        client().stopDiscovery()
        client().stopAllEndpoints()
        discovered.clear()
        connected.clear()
        call.resolve()
    }

    // -------------------------------------------------------- uprawnienia

    private fun requestNearbyPermissions(call: PluginCall) {
        if (getPermissionState("nearby") != com.getcapacitor.PermissionState.GRANTED) {
            requestPermissionForAlias("nearby", call, "nearbyPermissionCallback")
        } else {
            beginPendingMode()
        }
    }

    @PermissionCallback
    private fun nearbyPermissionCallback(call: PluginCall) {
        if (getPermissionState("nearby") == com.getcapacitor.PermissionState.GRANTED) {
            beginPendingMode()
        } else {
            call.reject("Bez zgody na łączenie z urządzeniami w pobliżu gra nie znajdzie innych graczy")
            pendingCall = null
        }
    }

    private fun beginPendingMode() {
        val call = pendingCall ?: return
        when (pendingMode) {
            "host" -> startAdvertisingNow(call)
            "browse" -> startDiscoveryNow(call)
        }
        pendingCall = null
        pendingMode = null
    }

    // ------------------------------------------------------------ tryby

    private fun startAdvertisingNow(call: PluginCall) {
        val options = AdvertisingOptions.Builder().setStrategy(strategy).build()
        client().startAdvertising(localName, serviceId, connectionCallback, options)
            .addOnSuccessListener {
                call.resolve(JSObject().put("hosting", true).put("name", localName))
            }
            .addOnFailureListener { e ->
                call.reject(e.message ?: "Nie udało się ogłosić gry")
            }
    }

    private fun startDiscoveryNow(call: PluginCall) {
        val options = DiscoveryOptions.Builder().setStrategy(strategy).build()
        client().startDiscovery(serviceId, discoveryCallback, options)
            .addOnSuccessListener { call.resolve(JSObject().put("browsing", true)) }
            .addOnFailureListener { e -> call.reject(e.message ?: "Nie udało się rozpocząć wyszukiwania") }
    }

    // ------------------------------------------------------ nasłuchiwanie

    private val discoveryCallback = object : EndpointDiscoveryCallback() {
        override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
            discovered[endpointId] = info.endpointName
            notifyListeners("peerFound", JSObject().put("name", info.endpointName))
        }

        override fun onEndpointLost(endpointId: String) {
            val name = discovered.remove(endpointId)
            if (name != null) notifyListeners("peerLost", JSObject().put("name", name))
        }
    }

    private val connectionCallback = object : ConnectionLifecycleCallback() {
        override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
            discovered[endpointId] = info.endpointName
            /* Gra jest ogłaszana tylko wtedy, gdy gospodarz sam tego chce, więc przyjmujemy
               połączenie od razu, bez dodatkowego pytania na ekranie. */
            client().acceptConnection(endpointId, payloadCallback)
            notifyListeners("connecting", JSObject().put("name", info.endpointName))
        }

        override fun onConnectionResult(endpointId: String, result: ConnectionResolution) {
            val name = discovered[endpointId] ?: endpointId
            if (result.status.isSuccess) {
                connected.add(endpointId)
                /* Gospodarz przestaje się ogłaszać, gdy komplet już jest przy stole. */
                notifyListeners("connected", JSObject().put("name", name))
            } else {
                notifyListeners("error", JSObject().put("message", "Połączenie odrzucone: $name"))
            }
        }

        override fun onDisconnected(endpointId: String) {
            val name = discovered[endpointId] ?: endpointId
            connected.remove(endpointId)
            notifyListeners("disconnected", JSObject().put("name", name))
        }
    }

    private val payloadCallback = object : PayloadCallback() {
        override fun onPayloadReceived(endpointId: String, payload: Payload) {
            val bytes = payload.asBytes() ?: return
            val text = String(bytes, Charsets.UTF_8)
            val name = discovered[endpointId] ?: endpointId
            notifyListeners("data", JSObject().put("name", name).put("data", text))
        }

        override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {
            /* Wiadomości są krótkie i lecą w jednym kawałku, więc postęp nas nie interesuje. */
        }
    }
}
