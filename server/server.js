/* ============================================================================
   Tysiąc — serwer stołów
   ============================================================================
   Serwer nie zna zasad gry. Robi trzy rzeczy:

     • utrzymuje listę stołów,
     • kojarzy dołączających z gospodarzem,
     • przekazuje wiadomości między nimi.

   Rozgrywkę nadal prowadzi telefon gospodarza — dokładnie tak jak przy grze
   przez Bluetooth. Dzięki temu zasady istnieją w jednym miejscu i nie ma ryzyka,
   że gra online zacznie się różnić od offline.

   ----------------------------------------------------------------------------
   Cykl życia stołu (lifecycle):

     • Tożsamością gracza jest trwały, anonimowy identyfikator „pid" zapisany na
       jego urządzeniu. Pseudonim ani gniazdo nie są tożsamością — gniazdo to
       tylko bieżące połączenie.
     • Jeden pid może być gospodarzem najwyżej jednego aktywnego stołu.
     • Stół żyje na serwerze niezależnie od połączeń. Rozłączenie NIE zwalnia
       miejsca — rezerwuje je. Świadome „wyjście" — zwalnia.
     • TTL (15 min) biegnie WYŁĄCZNIE, gdy przy stole nie ma ani jednego
       połączonego człowieka. Boty się nie liczą. Powrót człowieka anuluje TTL.
     • Serwer jest źródłem prawdy o składzie stołu i rozsyła go jako „roster".
   ========================================================================== */

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

/* ---------------------------------------------------------------- stan */

/**
 * numer stołu -> {
 *   no, hostPid, maxSeats, bombs, started,
 *   seats:  [ Seat | null ]   // uporządkowana tablica miejsc dla ludzi
 *   bots:   [ {name, avatar} ]// boty deklarowane przez gospodarza (bez pid, bez połączenia)
 *   gra, numerGracza:Map<pid,nrWpartii>, stany:{[pid]:payload},
 *   ttlTimer, timerGry, spi
 * }
 * Seat = { pid, name, avatar, role:'host'|'guest', connected:bool, socket:socket|null }
 */
const tables = new Map();
const SILNIK = require('./silnik.js');

/** Ile stół żyje BEZ żadnego połączonego człowieka — tyle czasu można wrócić pod tym samym numerem.
    Nadpisywalne przez środowisko, żeby testy nie musiały czekać kwadransa. */
const CZAS_ZYCIA_MS = parseInt(process.env.TABLE_TTL_MS, 10) > 0
  ? parseInt(process.env.TABLE_TTL_MS, 10)
  : 15 * 60 * 1000;

/** gniazdo -> { pid, name, avatar, tableNo, role } */
const clients = new Map();

function newTableNumber() {
  /* Numer zamiast nazwy własnej: nie ma czego moderować, a stół rozpoznaje się
     po tym, kto przy nim siedzi. */
  for (let i = 0; i < 500; i++) {
    const n = 700 + Math.floor(Math.random() * 300);
    if (!tables.has(n)) return n;
  }
  return 700 + tables.size;
}

function send(socket, obj) {
  if (!socket || socket.readyState !== socket.OPEN) return;
  try { socket.send(JSON.stringify(obj)); } catch (e) { /* zerwane łącze */ }
}

/* ----------------------------------------------------- pomocnicy stołu */

function seatIndexOfPid(t, pid) {
  if (!pid) return -1;
  for (let i = 0; i < t.seats.length; i++) {
    const s = t.seats[i];
    if (s && s.pid === pid) return i;
  }
  return -1;
}

function hostSeat(t) {
  return t.seats.find(s => s && s.role === 'host') || null;
}

function hostName(t) {
  const h = hostSeat(t);
  return h ? h.name : '—';
}

/** Ilu PRAWDZIWYCH ludzi jest w tej chwili połączonych przy stole. Boty i puste miejsca
    się nie liczą — to jedyna liczba, która decyduje o TTL. */
function humansOnline(t) {
  let n = 0;
  for (const s of t.seats) if (s && s.pid && s.connected) n++;
  return n;
}

function pidHostsTable(pid) {
  for (const t of tables.values()) if (t.hostPid === pid) return t;
  return null;
}

/** Widok składu wysyłany klientom: ludzie na swoich miejscach + boty wypełniające luki. */
function rosterView(t) {
  const seats = [];
  let bi = 0;
  for (let i = 0; i < t.maxSeats; i++) {
    const s = t.seats[i];
    if (s) {
      seats.push({ pid: s.pid, name: s.name, avatar: s.avatar, role: s.role, connected: !!s.connected });
    } else if (bi < t.bots.length) {
      const b = t.bots[bi++];
      seats.push({ bot: true, name: b.name, avatar: b.avatar });
    } else {
      seats.push(null);
    }
  }
  return {
    type: 'roster',
    no: t.no,
    hostPid: t.hostPid,
    started: !!t.started,
    seats
  };
}

/** Rozsyła aktualny skład do wszystkich połączonych ludzi przy stole. Serwer — nie host —
    jest źródłem prawdy, więc nawet gdy gospodarz jest offline, roster nadal jest znany. */
function sendRoster(t) {
  const view = rosterView(t);
  for (const s of t.seats) {
    if (s && s.pid && s.socket) send(s.socket, view);
  }
}

function tableSummary(t) {
  const faces = [];
  let bi = 0;
  for (let i = 0; i < t.maxSeats; i++) {
    const s = t.seats[i];
    if (s) faces.push(s.avatar);
    else if (bi < t.bots.length) faces.push(t.bots[bi++].avatar);
  }
  return {
    no: t.no,
    host: hostName(t),
    avatar: hostSeat(t) ? hostSeat(t).avatar : '🦊',
    faces,
    taken: faces.length,
    seats: t.maxSeats,
    bombs: t.bombs > 0,
    started: t.started,
    spi: !!t.spi
  };
}

function broadcastTableList() {
  const list = [...tables.values()]
    .filter(t => t.spi || (!t.started && tableSummary(t).taken < t.maxSeats))
    .map(tableSummary)
    .sort((a, b) => a.no - b.no);

  for (const [socket, c] of clients) {
    if (c.role === 'browsing') send(socket, { type: 'tables', tables: list });
  }
}

/* ----------------------------------------------------------- TTL / sen */

function clearTTL(t) {
  if (t.ttlTimer) { clearTimeout(t.ttlTimer); t.ttlTimer = null; }
}

function startTTL(t) {
  if (t.ttlTimer) return;               /* już liczy — nie resetujemy odliczania */
  t.ttlTimer = setTimeout(() => {
    t.ttlTimer = null;
    if (t.timerGry) { clearTimeout(t.timerGry); t.timerGry = null; }   /* zatrzymaj tykającą partię z botami */
    tables.delete(t.no);
    broadcastTableList();
  }, CZAS_ZYCIA_MS);
}

/* Stół nie znika po odejściu graczy. Dopóki siedzi przy nim choć jeden połączony człowiek,
   TTL nie biegnie w ogóle. Gdy zniknie ostatni — zaczyna się kwadrans, po którym stół
   przepada. Powrót kogokolwiek przed czasem budzi stół i anuluje odliczanie. */
function recomputeLifecycle(t) {
  if (!tables.has(t.no)) return;
  if (humansOnline(t) === 0) {
    t.spi = true;
    startTTL(t);
  } else {
    t.spi = false;
    clearTTL(t);
  }
  broadcastTableList();
}

function closeTable(no, reason) {
  const t = tables.get(no);
  if (!t) return;
  clearTTL(t);
  if (t.timerGry) { clearTimeout(t.timerGry); t.timerGry = null; }
  for (const s of t.seats) {
    if (s && s.pid && s.socket) {
      send(s.socket, { type: 'tableClosed', reason: reason || 'Stół został zamknięty.' });
      const c = clients.get(s.socket);
      if (c) { c.tableNo = null; c.role = 'idle'; }
    }
  }
  tables.delete(no);
  broadcastTableList();
}

/* -------------------------------------------------- rozsyłanie stanu gry */

/* Każdy gracz dostaje WŁASNY widok stanu — bez cudzych kart i bez zakrytego musika.
   Rozsyła stan, a jeśli gra zatrzymała się na pauzie (karta na stole, pełna lewa),
   po chwili sama ruszy dalej. Dzięki temu widać, co kto zagrał. */
function rozeslijIKontynuuj(t) {
  /* Stan bez pauzy i bez oczekiwania jest przelotowy — zaraz zastąpi go następny.
     Wysyłanie go powodowało dwa przerysowania w tej samej chwili. */
  const przelotowy = t.gra && !t.gra.pauza && !t.gra.oczekiwanie && t.gra.phase !== 'gameover';
  if (!przelotowy) rozeslijStan(t);
  if (!t.gra || !t.gra.pauza) return;
  /* Namysł bota krótszy niż podziwianie zagranej karty i pełnej lewy. */
  /* Odkryty musik i rozdane karty trzeba zdążyć obejrzeć — te pauzy są najdłuższe. */
  const ms = (t.gra.pauza === 'musik') ? 2600
           : (t.gra.pauza === 'dary')  ? 2600
           : (t.gra.pauza === 'lewa')  ? 1600
           : (t.gra.pauza === 'mysli') ? 550
           : 900;
  if (t.timerGry) clearTimeout(t.timerGry);
  t.timerGry = setTimeout(() => {
    t.timerGry = null;
    if (!t.gra) return;
    SILNIK.kontynuuj(t.gra, Math.random);
    rozeslijIKontynuuj(t);
  }, ms);
}

function rozeslijStan(t) {
  if (!t || !t.gra) return;
  for (const s of t.seats) {
    if (!s || !s.pid || !s.socket) continue;
    const numer = t.numerGracza ? t.numerGracza.get(s.pid) : undefined;
    if (numer === undefined) continue;
    send(s.socket, { type: 'stanGry', G: SILNIK.widokDla(t.gra, numer) });
  }
}

/* ------------------------------------------------------------ obsługa */

function handle(socket, msg) {
  const me = clients.get(socket);
  if (!me) return;

  switch (msg.type) {

    /* --- kim jestem --- (pid jest obowiązkowy — bez niego nie ma tożsamości) */
    case 'hello': {
      const pid = String(msg.pid || '').slice(0, 64);
      if (!pid) { send(socket, { type: 'helloRejected', reason: 'Brak identyfikatora gracza (pid).' }); break; }
      me.pid = pid;
      me.name = String(msg.name || 'Gracz').slice(0, 7);
      me.avatar = String(msg.avatar || '🦊').slice(0, 8);

      /* Czy ten pid ma gdzieś zarezerwowane miejsce? Jeśli tak — po powrocie (także po
         restarcie aplikacji) można od razu wrócić do tego stołu. */
      let resume = null;
      for (const t of tables.values()) {
        const idx = seatIndexOfPid(t, pid);
        if (idx >= 0) { resume = { no: t.no, role: t.seats[idx].role, started: !!t.started }; break; }
      }
      send(socket, { type: 'welcome', pid, resume });
      break;
    }

    /* --- chcę widzieć listę --- */
    case 'browse': {
      me.role = 'browsing';
      broadcastTableList();
      break;
    }

    /* --- zakładam stół --- */
    case 'createTable': {
      if (!me.pid) { send(socket, { type: 'createFailed', reason: 'Najpierw przedstaw się (pid).' }); break; }
      /* Jeden pid = najwyżej jeden aktywny stół. */
      const istniejacy = pidHostsTable(me.pid);
      if (istniejacy) {
        send(socket, { type: 'createFailed', reason: 'Masz już aktywny stół.', no: istniejacy.no });
        break;
      }
      const no = newTableNumber();
      const maxSeats = Math.min(3, Math.max(2, parseInt(msg.seats, 10) || 3));
      const t = {
        no,
        hostPid: me.pid,
        maxSeats,
        bombs: Math.min(2, Math.max(0, parseInt(msg.bombs, 10) || 0)),
        started: false,
        seats: new Array(maxSeats).fill(null),
        bots: [],
        gra: null,
        numerGracza: null,
        stany: {},
        ttlTimer: null,
        timerGry: null,
        spi: false
      };
      t.seats[0] = { pid: me.pid, name: me.name, avatar: me.avatar, role: 'host', connected: true, socket };
      tables.set(no, t);
      me.role = 'host';
      me.tableNo = no;
      send(socket, { type: 'tableCreated', no, seats: t.maxSeats, bombs: t.bombs });
      sendRoster(t);
      broadcastTableList();
      break;
    }

    /* --- host deklaruje boty przy stole (źródłem prawdy o składzie jest serwer) --- */
    case 'syncBots': {
      const t = tables.get(me.tableNo);
      if (!t || t.hostPid !== me.pid || t.started) break;
      const list = Array.isArray(msg.bots) ? msg.bots : [];
      const humans = t.seats.filter(Boolean).length;
      const maxBots = Math.max(0, t.maxSeats - humans);
      t.bots = list.slice(0, maxBots).map((b, i) => ({
        name: String((b && b.name) || ('Bot ' + i)).slice(0, 7),
        avatar: String((b && b.avatar) || '🤖').slice(0, 8)
      }));
      sendRoster(t);
      broadcastTableList();
      break;
    }

    /* --- siadam przy stole --- */
    case 'joinTable': {
      const t = tables.get(parseInt(msg.no, 10));
      if (!t) { send(socket, { type: 'joinFailed', reason: 'Ten stół już nie istnieje.' }); break; }

      /* Ten pid już tu siedzi (np. równoległa karta) — to powrót, nie nowe miejsce. */
      const istn = seatIndexOfPid(t, me.pid);
      if (istn >= 0) { attachToSeat(socket, t, istn); break; }

      if (t.started) { send(socket, { type: 'joinFailed', reason: 'Gra przy tym stole już trwa.' }); break; }
      const wolne = t.seats.indexOf(null);
      const humans = t.seats.filter(Boolean).length;
      if (wolne < 0 || humans >= t.maxSeats) { send(socket, { type: 'joinFailed', reason: 'Stół jest pełny.' }); break; }

      t.seats[wolne] = { pid: me.pid, name: me.name, avatar: me.avatar, role: 'guest', connected: true, socket };
      /* Boty ustępują ludziom — jeśli człowiek zajął miejsce, zabieramy jednego bota. */
      if (t.seats.filter(Boolean).length + t.bots.length > t.maxSeats) t.bots.pop();
      me.role = 'guest';
      me.tableNo = t.no;
      send(socket, { type: 'joined', no: t.no, host: hostName(t) });
      clearTTL(t); t.spi = false;
      sendRoster(t);
      broadcastTableList();
      break;
    }

    /* --- wracam do stołu, przy którym już siedziałem (ten sam pid) --- */
    case 'rejoinTable': {
      const t = tables.get(parseInt(msg.no, 10));
      if (!t) { send(socket, { type: 'joinFailed', reason: 'Ten stół już wygasł.' }); break; }

      const idx = seatIndexOfPid(t, me.pid);
      if (idx >= 0) { attachToSeat(socket, t, idx); break; }

      /* Miejsce zostało zwolnione (np. świadome wyjście), ale stół żyje — jeśli lobby ma
         wolne miejsce, można usiąść na nowo. */
      if (!t.started) {
        const wolne = t.seats.indexOf(null);
        if (wolne >= 0) {
          t.seats[wolne] = { pid: me.pid, name: me.name, avatar: me.avatar, role: 'guest', connected: true, socket };
          if (t.seats.filter(Boolean).length + t.bots.length > t.maxSeats) t.bots.pop();
          me.role = 'guest'; me.tableNo = t.no;
          send(socket, { type: 'rejoined', no: t.no, role: 'guest', host: hostName(t) });
          clearTTL(t); t.spi = false;
          sendRoster(t);
          broadcastTableList();
          break;
        }
      }
      send(socket, { type: 'joinFailed', reason: 'Twoje miejsce przy tym stole już nie istnieje.' });
      break;
    }

    /* --- świadome wyjście: zwalnia miejsce (inaczej niż utrata połączenia) --- */
    case 'leaveTable': {
      explicitLeave(socket);
      break;
    }

    /* --- ruch gracza; jedyne wejście do partii --- */
    case 'ruch': {
      const t = tables.get(me.tableNo);
      if (!t || !t.gra) break;
      const numer = t.numerGracza ? t.numerGracza.get(me.pid) : undefined;
      if (numer === undefined) { send(socket, { type: 'ruchOdrzucony', why: 'Nie siedzisz przy tym stole.' }); break; }
      const wynik = SILNIK.wykonaj(t.gra, numer, msg.action);
      if (!wynik.ok) { send(socket, { type: 'ruchOdrzucony', why: wynik.why }); break; }
      rozeslijIKontynuuj(t);
      break;
    }

    /* --- gra się zaczyna --- */
    case 'started': {
      const t = tables.get(me.tableNo);
      if (!(t && t.hostPid === me.pid)) break;
      if (t.started) break;
      t.started = true;

      /* Od tego momentu partię prowadzi serwer. Gospodarz staje się zwykłym graczem —
         jego wyjście nie zatrzymuje gry, a każdy dostaje wyłącznie własny widok kart.
         Skład bierzemy z rostera serwera: ludzie na swoich miejscach, boty w lukach. */
      const przyStole = [];
      let bi = 0;
      const botyDeklarowane = (t.bots.length > 0)
        ? t.bots.slice()
        : Array.from({ length: Math.max(0, msg.boty || 0) }, (_, i) => ({ name: 'Bot ' + i, avatar: '🤖' }));
      for (let i = 0; i < t.maxSeats; i++) {
        const s = t.seats[i];
        if (s) {
          przyStole.push({ id: s.pid, name: s.name, avatar: s.avatar, bot: false });
        } else if (bi < botyDeklarowane.length) {
          const b = botyDeklarowane[bi++];
          przyStole.push({ id: 'bot' + i, name: b.name, avatar: b.avatar, bot: true });
        }
      }

      t.gra = SILNIK.nowaGra({ gracze: przyStole, miejsca: przyStole.length, bombLimit: t.bombs });
      /* Silnik zna graczy po numerze w partii, serwer po trwałym pid. */
      t.numerGracza = new Map();
      przyStole.forEach((g, i) => { if (!g.bot) t.numerGracza.set(String(g.id), i); });
      SILNIK.rozdaj(t.gra, Math.random);
      SILNIK.krok(t.gra, Math.random);
      rozeslijIKontynuuj(t);
      broadcastTableList();
      break;
    }

    /* --- przekazanie wiadomości gry (ścieżka zgodności dla trybu host-run) --- */
    case 'relay': {
      const t = tables.get(me.tableNo);
      if (!t) break;
      const jestemHostem = (t.hostPid === me.pid);

      if (jestemHostem) {
        /* Zapamiętujemy ostatni stan wysłany każdemu graczowi, żeby po powrocie móc go
           odtworzyć bez czekania na kolejny ruch. Zapis wiążemy z PID odbiorcy. */
        if (msg.to && msg.payload && msg.payload.type === 'state') {
          const idx = seatIndexOfPid(t, String(msg.to));
          if (idx >= 0) { t.stany = t.stany || {}; t.stany[String(msg.to)] = msg.payload; }
        }
        if (msg.to) {
          const idx = seatIndexOfPid(t, String(msg.to));
          if (idx >= 0 && t.seats[idx].socket) send(t.seats[idx].socket, { type: 'relay', payload: msg.payload });
        } else {
          for (const s of t.seats) {
            if (s && s.pid && s.role !== 'host' && s.socket) send(s.socket, { type: 'relay', payload: msg.payload });
          }
        }
      } else {
        /* Gracz zawsze mówi do gospodarza. */
        const h = hostSeat(t);
        if (h && h.socket) send(h.socket, { type: 'relay', peer: me.pid, payload: msg.payload });
      }
      break;
    }
  }
}

/** Podpięcie istniejącego (zarezerwowanego) miejsca do nowego połączenia — powrót gracza. */
function attachToSeat(socket, t, idx) {
  const me = clients.get(socket);
  const seat = t.seats[idx];
  if (!me || !seat) return;

  seat.connected = true;
  seat.socket = socket;
  if (me.name) seat.name = me.name;
  if (me.avatar) seat.avatar = me.avatar;

  me.role = seat.role;
  me.tableNo = t.no;

  clearTTL(t); t.spi = false;

  send(socket, { type: 'rejoined', no: t.no, role: seat.role, host: hostName(t) });

  if (t.gra && t.numerGracza) {
    const nr = t.numerGracza.get(seat.pid);
    if (nr !== undefined) send(socket, { type: 'stanGry', G: SILNIK.widokDla(t.gra, nr) });
  } else if (t.stany && t.stany[seat.pid]) {
    send(socket, { type: 'relay', payload: t.stany[seat.pid] });
  }

  sendRoster(t);
  broadcastTableList();
}

/* Świadome wyjście — ZWALNIA miejsce. Host wychodzący z lobby zamyka cały stół. */
function explicitLeave(socket) {
  const me = clients.get(socket);
  if (!me) return;
  const t = me.tableNo ? tables.get(me.tableNo) : null;

  if (t) {
    if (t.hostPid === me.pid && !t.started) {
      /* Świadome wyjście gospodarza z lobby = koniec stołu dla wszystkich. */
      closeTable(t.no, 'Gospodarz zamknął stół.');
      me.tableNo = null; me.role = 'idle';
      return;
    }
    const idx = seatIndexOfPid(t, me.pid);
    if (idx >= 0) {
      t.seats[idx] = null;
      if (t.numerGracza) t.numerGracza.delete(me.pid);
      sendRoster(t);
      recomputeLifecycle(t);
    }
  }
  me.tableNo = null;
  me.role = 'idle';
}

/* Utrata połączenia — REZERWUJE miejsce. Miejsce zostaje, gracz oznaczony jako offline.
   Jeśli zniknął ostatni połączony człowiek, zaczyna biec TTL. */
function onDisconnect(socket) {
  const me = clients.get(socket);
  if (!me) return;
  const t = me.tableNo ? tables.get(me.tableNo) : null;
  if (t) {
    const idx = seatIndexOfPid(t, me.pid);
    if (idx >= 0 && t.seats[idx]) {
      t.seats[idx].connected = false;
      t.seats[idx].socket = null;
      sendRoster(t);
      recomputeLifecycle(t);
    }
  }
}

/* -------------------------------------------------------------- serwer */

const server = http.createServer((req, res) => {
  /* Prosty sygnał życia — przydaje się do monitoringu i budzenia usługi. */
  if (req.url === '/zdrowie') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, stoly: tables.size, gracze: clients.size }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Serwer stołów Tysiąca działa.');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (socket) => {
  clients.set(socket, { pid: null, name: 'Gracz', avatar: '🦊', tableNo: null, role: 'idle' });

  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || typeof msg.type !== 'string') return;
    try { handle(socket, msg); } catch (e) { console.error('Błąd obsługi:', e.message); }
  });

  socket.on('close', () => { onDisconnect(socket); clients.delete(socket); });
  socket.on('error', () => { onDisconnect(socket); clients.delete(socket); });

  /* Utrzymanie łącza: pośrednicy lubią zamykać ciche połączenia. */
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
});

const pingTimer = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) { socket.terminate(); continue; }
    socket.isAlive = false;
    try { socket.ping(); } catch (e) {}
  }
}, 25000);

/* Uruchamiamy nasłuch tylko przy bezpośrednim wywołaniu (`node server.js`). Gdy plik jest
   wymagany jako moduł (test), nie zajmujemy portu — testy wołają start() same.
   PORT=0 pozwala systemowi wybrać wolny port; logujemy ten faktyczny, żeby testy mogły go
   odczytać ze standardowego wyjścia. */
function start(port, cb) {
  return server.listen(port === undefined ? PORT : port, () => {
    const p = server.address().port;
    console.log('Serwer stołów Tysiąca nasłuchuje na porcie ' + p);
    if (typeof cb === 'function') cb(p);
  });
}

if (require.main === module) {
  start();
}

/* Eksport na potrzeby testów — pozwala podnieść serwer na losowym porcie i zamknąć go
   czysto. */
module.exports = { server, wss, tables, clients, start, closeAll };

function closeAll() {
  clearInterval(pingTimer);
  for (const t of tables.values()) { clearTTL(t); if (t.timerGry) clearTimeout(t.timerGry); }
  tables.clear();
  for (const s of wss.clients) { try { s.terminate(); } catch (e) {} }
  try { wss.close(); } catch (e) {}
  try { server.close(); } catch (e) {}
}
