import Foundation
import Capacitor
import MultipeerConnectivity

/*
 Łączenie bez sieci.

 Bonjour i WebSocket wymagają wspólnej sieci Wi-Fi, czego w samolocie nie ma.
 MultipeerConnectivity łączy urządzenia bezpośrednio — przez Bluetooth i Wi-Fi
 peer-to-peer — dokładnie tak jak AirDrop. Nie potrzeba routera, hotspotu ani
 internetu, więc działa na wysokości jedenastu kilometrów.

 Wtyczka celowo jest cienka: rozgłasza, wyszukuje, łączy i przesyła tekst.
 Cała logika gry zostaje w JavaScripcie.
*/

@objc(MultipeerPlugin)
public class MultipeerPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "MultipeerPlugin"
    public let jsName = "Multipeer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startHosting",   returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startBrowsing",  returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop",           returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "invite",         returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send",           returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isSupported",    returnType: CAPPluginReturnPromise)
    ]

    /// Musi mieć maksymalnie 15 znaków i zawierać tylko małe litery, cyfry i myślniki.
    private let serviceType = "tysiac-gra"

    private var peerID: MCPeerID?
    private var session: MCSession?
    private var advertiser: MCNearbyServiceAdvertiser?
    private var browser: MCNearbyServiceBrowser?

    /// Znalezione urządzenia, żeby JavaScript mógł się odwoływać do nich po nazwie.
    private var discovered: [String: MCPeerID] = [:]

    // MARK: - Cykl życia

    private func makeSession(displayName: String) {
        stopEverything()
        /// Nazwa widoczna dla innych ograniczona do 63 bajtów — tego wymaga system.
        let safeName = String(displayName.prefix(20))
        let pid = MCPeerID(displayName: safeName.isEmpty ? UIDevice.current.name : safeName)
        peerID = pid
        let s = MCSession(peer: pid, securityIdentity: nil, encryptionPreference: .required)
        s.delegate = self
        session = s
    }

    private func stopEverything() {
        advertiser?.stopAdvertisingPeer()
        advertiser?.delegate = nil
        advertiser = nil
        browser?.stopBrowsingForPeers()
        browser?.delegate = nil
        browser = nil
        session?.disconnect()
        session?.delegate = nil
        session = nil
        discovered.removeAll()
    }

    // MARK: - API dla JavaScriptu

    @objc func isSupported(_ call: CAPPluginCall) {
        call.resolve(["supported": true])
    }

    /// Gospodarz: ogłasza grę, żeby inni ją widzieli.
    @objc func startHosting(_ call: CAPPluginCall) {
        let name = call.getString("displayName") ?? "Gracz"
        DispatchQueue.main.async {
            self.makeSession(displayName: name)
            guard let pid = self.peerID else {
                call.reject("Nie udało się utworzyć sesji")
                return
            }
            let adv = MCNearbyServiceAdvertiser(peer: pid,
                                                discoveryInfo: ["gra": "tysiac"],
                                                serviceType: self.serviceType)
            adv.delegate = self
            adv.startAdvertisingPeer()
            self.advertiser = adv
            call.resolve(["hosting": true, "name": pid.displayName])
        }
    }

    /// Dołączający: szuka gier w pobliżu.
    @objc func startBrowsing(_ call: CAPPluginCall) {
        let name = call.getString("displayName") ?? "Gracz"
        DispatchQueue.main.async {
            self.makeSession(displayName: name)
            guard let pid = self.peerID else {
                call.reject("Nie udało się utworzyć sesji")
                return
            }
            let br = MCNearbyServiceBrowser(peer: pid, serviceType: self.serviceType)
            br.delegate = self
            br.startBrowsingForPeers()
            self.browser = br
            call.resolve(["browsing": true])
        }
    }

    /// Dołącza do wybranej gry z listy.
    @objc func invite(_ call: CAPPluginCall) {
        guard let name = call.getString("peer") else {
            call.reject("Brak nazwy gracza")
            return
        }
        DispatchQueue.main.async {
            guard let peer = self.discovered[name],
                  let session = self.session,
                  let browser = self.browser else {
                call.reject("Nie znaleziono tej gry")
                return
            }
            browser.invitePeer(peer, to: session, withContext: nil, timeout: 20)
            call.resolve(["invited": name])
        }
    }

    /// Wysyła wiadomość do wszystkich połączonych urządzeń.
    @objc func send(_ call: CAPPluginCall) {
        guard let text = call.getString("data") else {
            call.reject("Brak danych")
            return
        }
        guard let session = self.session, !session.connectedPeers.isEmpty else {
            /// Nie jest to błąd krytyczny — gra i tak powtarza stan co kilka sekund.
            call.resolve(["sent": false])
            return
        }
        do {
            try session.send(Data(text.utf8), toPeers: session.connectedPeers, with: .reliable)
            call.resolve(["sent": true])
        } catch {
            call.resolve(["sent": false, "error": error.localizedDescription])
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.stopEverything()
            call.resolve()
        }
    }
}

// MARK: - Wyszukiwanie

extension MultipeerPlugin: MCNearbyServiceBrowserDelegate {
    public func browser(_ browser: MCNearbyServiceBrowser,
                        foundPeer peerID: MCPeerID,
                        withDiscoveryInfo info: [String: String]?) {
        discovered[peerID.displayName] = peerID
        notifyListeners("peerFound", data: ["name": peerID.displayName])
    }

    public func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) {
        discovered.removeValue(forKey: peerID.displayName)
        notifyListeners("peerLost", data: ["name": peerID.displayName])
    }

    public func browser(_ browser: MCNearbyServiceBrowser,
                        didNotStartBrowsingForPeers error: Error) {
        notifyListeners("error", data: ["message": error.localizedDescription])
    }
}

// MARK: - Ogłaszanie

extension MultipeerPlugin: MCNearbyServiceAdvertiserDelegate {
    public func advertiser(_ advertiser: MCNearbyServiceAdvertiser,
                           didReceiveInvitationFromPeer peerID: MCPeerID,
                           withContext context: Data?,
                           invitationHandler: @escaping (Bool, MCSession?) -> Void) {
        /// Gra jest ogłaszana tylko wtedy, gdy gospodarz sam tego chce, więc
        /// zaproszenia przyjmujemy od razu — bez dodatkowego pytania na ekranie.
        invitationHandler(true, session)
    }

    public func advertiser(_ advertiser: MCNearbyServiceAdvertiser,
                           didNotStartAdvertisingPeer error: Error) {
        notifyListeners("error", data: ["message": error.localizedDescription])
    }
}

// MARK: - Sesja

extension MultipeerPlugin: MCSessionDelegate {
    public func session(_ session: MCSession, peer peerID: MCPeerID, didChange state: MCSessionState) {
        switch state {
        case .connected:
            notifyListeners("connected", data: ["name": peerID.displayName])
        case .notConnected:
            notifyListeners("disconnected", data: ["name": peerID.displayName])
        case .connecting:
            notifyListeners("connecting", data: ["name": peerID.displayName])
        @unknown default:
            break
        }
    }

    public func session(_ session: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) {
        let text = String(decoding: data, as: UTF8.self)
        notifyListeners("data", data: ["name": peerID.displayName, "data": text])
    }

    public func session(_ session: MCSession, didReceive stream: InputStream,
                        withName streamName: String, fromPeer peerID: MCPeerID) {}
    public func session(_ session: MCSession, didStartReceivingResourceWithName resourceName: String,
                        fromPeer peerID: MCPeerID, with progress: Progress) {}
    public func session(_ session: MCSession, didFinishReceivingResourceWithName resourceName: String,
                        fromPeer peerID: MCPeerID, at localURL: URL?, withError error: Error?) {}
}
