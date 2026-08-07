/* ============================================================================
   Jeden skrypt konfiguracyjny dla obu systemów.

   `npx cap add` generuje świeże projekty natywne, więc wtyczki, uprawnienia
   i zależności trzeba w nie wpiąć po fakcie. Uruchamiaj z argumentem:

       node scripts/setup.js android
       node scripts/setup.js ios

   Każdy krok jest idempotentny — ponowne uruchomienie niczego nie zdubluje.
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const ROOT = __dirname;

function fail(msg) { console.error(msg); process.exit(1); }


/* ======================= PRZYGOTOWANIE ======================= */
/* Repozytorium jest celowo płaskie — wgranie kilkunastu plików do podfolderów
   z telefonu jest udręką. Tutaj układamy je tak, jak oczekuje tego Capacitor. */

function prepare() {
  const moves = [
    ['index.html',            'www/index.html'],
    ['MultipeerPlugin.kt',    'native-android/MultipeerPlugin.kt'],
    ['MultipeerPlugin.swift', 'native/MultipeerPlugin.swift']
  ];
  moves.forEach(([from, to]) => {
    const src = path.join(ROOT, from);
    const dst = path.join(ROOT, to);
    if (fs.existsSync(dst)) { console.log('Jest już ' + to); return; }
    if (!fs.existsSync(src)) fail('Brak pliku ' + from + ' w repozytorium.');
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    console.log(from + '  ->  ' + to);
  });
  console.log('Struktura projektu gotowa.');
}

/* ======================== ANDROID ======================== */

function setupAndroid() {
  
  const PKG_PATH = ['pl', 'tysiac', 'gra'];
  const JAVA_DIR = path.join(ROOT, 'android', 'app', 'src', 'main', 'java', ...PKG_PATH);
  const MANIFEST = path.join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  const GRADLE = path.join(ROOT, 'android', 'app', 'build.gradle');
  const SRC_KT = path.join(ROOT, 'native-android', 'MultipeerPlugin.kt');
  
  
  /* --- 1. plik wtyczki --------------------------------------------------- */
  function copyPlugin() {
    if (!fs.existsSync(JAVA_DIR)) fail('Brak projektu Android — uruchom najpierw "npx cap add android".');
    fs.copyFileSync(SRC_KT, path.join(JAVA_DIR, 'MultipeerPlugin.kt'));
    console.log('Skopiowano MultipeerPlugin.kt');
  }
  
  /* --- 2. rejestracja w MainActivity ------------------------------------- */
  function registerPlugin() {
    const main = path.join(JAVA_DIR, 'MainActivity.java');
    const mainKt = path.join(JAVA_DIR, 'MainActivity.kt');
    const target = fs.existsSync(mainKt) ? mainKt : (fs.existsSync(main) ? main : null);
    if (!target) fail('Nie znaleziono MainActivity.');
  
    let src = fs.readFileSync(target, 'utf8');
    if (src.includes('MultipeerPlugin')) {
      console.log('MainActivity już rejestruje wtyczkę — pomijam.');
      return;
    }
  
    if (target.endsWith('.kt')) {
      src = src.replace(
        /class MainActivity[^{]*\{/,
        (m) => m + '\n    override fun onCreate(savedInstanceState: android.os.Bundle?) {\n'
                 + '        registerPlugin(MultipeerPlugin::class.java)\n'
                 + '        super.onCreate(savedInstanceState)\n    }\n'
      );
    } else {
      /* Wariant w Javie: dopisujemy onCreate z rejestracją. */
      src = src.replace(
        /public class MainActivity extends BridgeActivity \{/,
        'public class MainActivity extends BridgeActivity {\n'
        + '    @Override\n'
        + '    public void onCreate(android.os.Bundle savedInstanceState) {\n'
        + '        registerPlugin(MultipeerPlugin.class);\n'
        + '        super.onCreate(savedInstanceState);\n'
        + '    }\n'
      );
    }
    fs.writeFileSync(target, src, 'utf8');
    console.log('Zarejestrowano wtyczkę w MainActivity');
  }
  
  /* --- 3. uprawnienia ---------------------------------------------------- */
  function patchManifest() {
    if (!fs.existsSync(MANIFEST)) fail('Brak AndroidManifest.xml');
    let xml = fs.readFileSync(MANIFEST, 'utf8');
    if (xml.includes('BLUETOOTH_ADVERTISE')) {
      console.log('Manifest ma już uprawnienia — pomijam.');
      return;
    }
  
    /* Bluetooth i Wi-Fi Direct to sposób, w jaki telefony znajdują się bez sieci.
       Na starszych Androidach wymagana jest do tego lokalizacja — taka jest reguła
       systemu, choć gra nie sprawdza, gdzie jesteś. */
    const perms = `
      <uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />
      <uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />
      <uses-permission android:name="android.permission.BLUETOOTH_ADVERTISE" />
      <uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
      <uses-permission android:name="android.permission.BLUETOOTH_SCAN" />
      <uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
      <uses-permission android:name="android.permission.CHANGE_WIFI_STATE" />
      <uses-permission android:name="android.permission.NEARBY_WIFI_DEVICES" />
      <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" android:maxSdkVersion="32" />
      <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" android:maxSdkVersion="32" />
  `;
    xml = xml.replace('<application', perms + '\n    <application');
    fs.writeFileSync(MANIFEST, xml, 'utf8');
    console.log('Dodano uprawnienia do AndroidManifest');
  }
  
  /* --- 4. biblioteka Nearby --------------------------------------------- */
  function patchGradle() {
    if (!fs.existsSync(GRADLE)) fail('Brak build.gradle');
    let g = fs.readFileSync(GRADLE, 'utf8');
    if (g.includes('play-services-nearby')) {
      console.log('build.gradle ma już bibliotekę Nearby — pomijam.');
      return;
    }
    g = g.replace(
      /dependencies\s*\{/,
      "dependencies {\n    implementation 'com.google.android.gms:play-services-nearby:19.3.0'"
    );
    fs.writeFileSync(GRADLE, g, 'utf8');
    console.log('Dodano bibliotekę Nearby do build.gradle');
  }
  
  
  copyPlugin();
  registerPlugin();
  patchManifest();
  patchGradle();
  console.log('Projekt Android gotowy.');
}

/* ========================== iOS ========================== */

function setupIos() {
  const SRC = path.join(ROOT, 'native', 'MultipeerPlugin.swift');
  const DEST_DIR = path.join(ROOT, 'ios', 'App', 'App');
  if (!fs.existsSync(DEST_DIR)) fail('Brak projektu iOS — uruchom najpierw "npx cap add ios".');
  fs.copyFileSync(SRC, path.join(DEST_DIR, 'MultipeerPlugin.swift'));
  console.log('Skopiowano MultipeerPlugin.swift');

  const PLIST = path.join(DEST_DIR, 'Info.plist');
  if (!fs.existsSync(PLIST)) fail('Brak Info.plist');
  let xml = fs.readFileSync(PLIST, 'utf8');
  if (xml.includes('NSLocalNetworkUsageDescription')) {
    console.log('Info.plist ma już uprawnienia — pomijam.');
  } else {
    const additions = [
      '\t<key>NSLocalNetworkUsageDescription</key>',
      '\t<string>Aplikacja wyszukuje gry innych graczy w pobliżu, żeby móc grać bez internetu. Dane nie opuszczają Waszych telefonów.</string>',
      '\t<key>NSBonjourServices</key>',
      '\t<array>',
      '\t\t<string>_tysiac._tcp</string>',
      '\t\t<string>_tysiac-gra._tcp</string>',
      '\t\t<string>_tysiac-gra._udp</string>',
      '\t</array>',
      '\t<key>UIRequiresFullScreen</key>',
      '\t<true/>',
      ''
    ].join('\n');
    const marker = '</dict>\n</plist>';
    const idx = xml.lastIndexOf(marker);
    if (idx === -1) fail('Nieoczekiwany format Info.plist — przerywam, żeby go nie uszkodzić.');
    xml = xml.slice(0, idx) + additions + xml.slice(idx);
    fs.writeFileSync(PLIST, xml, 'utf8');
    console.log('Dodano uprawnienia sieci lokalnej do Info.plist');
  }
  console.log('Projekt iOS gotowy.');
}

const target = process.argv[2];
if (target === 'prepare') prepare();
else if (target === 'android') setupAndroid();
else if (target === 'ios') setupIos();
else fail('Użycie: node setup.js prepare|android|ios');
