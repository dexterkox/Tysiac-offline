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

   Wiadomości są maleńkie (zagrana karta to kilkaset bajtów), więc setka stołów
   zmieści się na najmniejszej maszynie.
   ========================================================================== */

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

/* ---------------------------------------------------------------- stan */

/** numer stołu -> { no, host, hostName, avatar, seats, bombs, guests:Set, started } */
const tables = new Map();
const SILNIK = require('./silnik.js');

/** Ile stół żyje po odejściu wszystkich — tyle czasu można wrócić pod tym samym numerem. */
const CZAS_ZYCIA_MS = 15 * 60 * 1000;

/** gniazdo -> { id, name, avatar, tableNo, role } */
const clients = new Map();

let nextId = 1;

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

function tableSummary(t) {
  return {
    no: t.no,
    host: t.hostName,
    avatar: t.avatar,
    taken: 1 + t.guests.size,
    seats: t.seats,
    bombs: t.bombs > 0,
    started: t.started,
    spi: !!t.spi
  };
}

/** Lista trafia tylko do tych, którzy jej szukają — nie zasypujemy grających. */
/* Każdy gracz dostaje WŁASNY widok stanu — bez cudzych kart i bez zakrytego musika. */
function rozeslijStan(t) {
  if (!t || !t.gra) return;
  const wyslij = (sock) => {
    const cl = sock && clients.get(sock);
    if (!cl) return;
    const numer = t.numerGracza ? t.numerGracza.get(String(cl.id)) : undefined;
    if (numer === undefined) return;
    send(sock, { type: 'stanGry', G: SILNIK.widokDla(t.gra, numer) });
  };
  wyslij(t.host);
  for (const g of t.guests) wyslij(g);
}

function broadcastTableList() {
  const list = [...tables.values()]
    .filter(t => t.spi || (!t.started && 1 + t.guests.size < t.seats))
    .map(tableSummary)
    .sort((a, b) => a.no - b.no);

  for (const [socket, c] of clients) {
    if (c.role === 'browsing') send(socket, { type: 'tables', tables: list });
  }
}

/* Stół nie znika od razu po odejściu graczy. Przez kwadrans czeka pod tym samym numerem,
   pamiętając ostatni stan gry — dzięki temu zminimalizowanie okna albo chwilowa utrata
   zasięgu nie kończą partii. */
function uspijTable(no) {
  const t = tables.get(no);
  if (!t) return;
  if (t.timerZycia) clearTimeout(t.timerZycia);
  t.spi = true;
  t.timerZycia = setTimeout(() => {
    tables.delete(no);
    broadcastTableList();
  }, CZAS_ZYCIA_MS);
  broadcastTableList();
}

function obudzTable(t) {
  if (t.timerZycia) { clearTimeout(t.timerZycia); t.timerZycia = null; }
  t.spi = false;
}

function closeTable(no, reason) {
  const t = tables.get(no);
  if (!t) return;
  for (const g of t.guests) {
    send(g, { type: 'tableClosed', reason: reason || 'Gospodarz opuścił stół.' });
    const c = clients.get(g);
    if (c) { c.tableNo = null; c.role = 'idle'; }
  }
  tables.delete(no);
  broadcastTableList();
}

/* ------------------------------------------------------------ obsługa */

function handle(socket, msg) {
  const me = clients.get(socket);
  if (!me) return;

  switch (msg.type) {

    /* --- kim jestem --- */
    case 'hello': {
      me.name = String(msg.name || 'Gracz').slice(0, 7);
      me.avatar = String(msg.avatar || '🦊').slice(0, 8);
      send(socket, { type: 'welcome', id: me.id });
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
      const no = newTableNumber();
      const t = {
        no,
        host: socket,
        hostName: me.name,
        avatar: me.avatar,
        seats: Math.min(3, Math.max(2, parseInt(msg.seats, 10) || 3)),
        bombs: Math.min(2, Math.max(0, parseInt(msg.bombs, 10) || 0)),
        guests: new Set(),
        started: false
      };
      tables.set(no, t);
      me.role = 'host';
      me.tableNo = no;
      send(socket, { type: 'tableCreated', no, seats: t.seats, bombs: t.bombs });
      broadcastTableList();
      break;
    }

    /* --- siadam przy stole --- */
    case 'joinTable': {
      const t = tables.get(parseInt(msg.no, 10));
      if (!t) { send(socket, { type: 'joinFailed', reason: 'Ten stół już nie istnieje.' }); break; }
      if (t.started) { send(socket, { type: 'joinFailed', reason: 'Gra przy tym stole już trwa.' }); break; }
      if (1 + t.guests.size >= t.seats) { send(socket, { type: 'joinFailed', reason: 'Stół jest pełny.' }); break; }

      t.guests.add(socket);
      me.role = 'guest';
      me.tableNo = t.no;
      send(socket, { type: 'joined', no: t.no, host: t.hostName });
      /* Gospodarz dowiaduje się o nowym graczu tak samo jak przez Bluetooth. */
      send(t.host, { type: 'peerJoined', peer: String(me.id), name: me.name, avatar: me.avatar });
      broadcastTableList();
      break;
    }

    /* --- wracam do stołu, przy którym już siedziałem --- */
    case 'rejoinTable': {
      const t = tables.get(parseInt(msg.no, 10));
      if (!t) { send(socket, { type: 'joinFailed', reason: 'Ten stół już wygasł.' }); break; }
      obudzTable(t);

      const bylGospodarzem = (t.hostName === me.name);
      if (bylGospodarzem) {
        t.host = socket;
        me.role = 'host'; me.tableNo = t.no;
        send(socket, { type: 'rejoined', no: t.no, role: 'host' });
        if (t.gra && t.numerGracza) {
          if (!t.numerGracza.has(String(me.id))) {
            const stary = [...t.numerGracza.entries()]
              .find(([id, nr]) => t.gra.playerNames[nr] === me.name);
            if (stary) { t.numerGracza.delete(stary[0]); t.numerGracza.set(String(me.id), stary[1]); }
          }
          const nr = t.numerGracza.get(String(me.id));
          if (nr !== undefined) send(socket, { type: 'stanGry', G: SILNIK.widokDla(t.gra, nr) });
        }
      } else {
        t.guests.add(socket);
        me.role = 'guest'; me.tableNo = t.no;
        send(socket, { type: 'rejoined', no: t.no, role: 'guest', host: t.hostName });
        send(t.host, { type: 'peerJoined', peer: String(me.id), name: me.name, avatar: me.avatar, wraca: true });
        /* Ostatni znany stan, żeby gracz od razu zobaczył stół zamiast pustego ekranu. */
        if (t.gra) {
          /* Po powrocie gracz odzyskuje swoje miejsce, choć ma nowe połączenie. */
          if (t.numerGracza && !t.numerGracza.has(String(me.id))) {
            const stary = [...t.numerGracza.entries()]
              .find(([id, nr]) => t.gra.playerNames[nr] === me.name);
            if (stary) { t.numerGracza.delete(stary[0]); t.numerGracza.set(String(me.id), stary[1]); }
          }
          const nr = t.numerGracza && t.numerGracza.get(String(me.id));
          if (nr !== undefined) send(socket, { type: 'stanGry', G: SILNIK.widokDla(t.gra, nr) });
        } else {
          const zapis = t.stany && t.stany[me.name];
          if (zapis) send(socket, { type: 'relay', payload: zapis });
        }
      }
      broadcastTableList();
      break;
    }

    /* --- wstaję od stołu --- */
    case 'leaveTable': {
      leave(socket);
      break;
    }

    /* --- gra się zaczyna --- */
    /* --- ruch gracza; jedyne wejście do partii --- */
    case 'ruch': {
      const t = tables.get(me.tableNo);
      if (!t || !t.gra) break;
      const numer = t.numerGracza ? t.numerGracza.get(String(me.id)) : undefined;
      if (numer === undefined) { send(socket, { type: 'ruchOdrzucony', why: 'Nie siedzisz przy tym stole.' }); break; }
      const wynik = SILNIK.wykonaj(t.gra, numer, msg.action);
      if (!wynik.ok) { send(socket, { type: 'ruchOdrzucony', why: wynik.why }); break; }
      rozeslijStan(t);
      break;
    }

    case 'started': {
      const t = tables.get(me.tableNo);
      if (!(t && t.host === socket)) break;
      t.started = true;

      /* Od tego momentu partię prowadzi serwer. Gospodarz staje się zwykłym graczem —
         jego wyjście nie zatrzymuje gry, a każdy dostaje wyłącznie własny widok kart. */
      const przyStole = [{ id: me.id, name: me.name, avatar: me.avatar, bot: false }];
      for (const g of t.guests) {
        const cg = clients.get(g);
        if (cg) przyStole.push({ id: cg.id, name: cg.name, avatar: cg.avatar, bot: false });
      }
      const boty = Math.max(0, msg.boty || 0);
      for (let i = 0; i < boty && przyStole.length < t.seats; i++) {
        przyStole.push({ id: 'bot' + i, name: 'Bot ' + i, avatar: '🤖', bot: true });
      }

      t.gra = SILNIK.nowaGra({ gracze: przyStole, miejsca: przyStole.length, bombLimit: t.bombs });
      /* Silnik zna graczy po numerze w partii, serwer po identyfikatorze połączenia. */
      t.numerGracza = new Map();
      przyStole.forEach((g, i) => { if (!g.bot) t.numerGracza.set(String(g.id), i); });
      SILNIK.rozdaj(t.gra, Math.random);
      SILNIK.krok(t.gra, Math.random);
      rozeslijStan(t);
      broadcastTableList();
      break;
    }

    /* --- przekazanie wiadomości gry --- */
    case 'relay': {
      const t = tables.get(me.tableNo);
      if (!t) break;

      if (t.host === socket) {
        /* Zapamiętujemy ostatni stan wysłany każdemu graczowi, żeby po powrocie móc go
           odtworzyć bez czekania na kolejny ruch. */
        if (msg.to && msg.payload && msg.payload.type === 'state') {
          /* Zapis wiążemy z PSEUDONIMEM, nie z identyfikatorem połączenia — po powrocie
             gracz dostaje nowe połączenie i nowy identyfikator, więc zapis po nim
             byłby nie do odnalezienia. */
          const odbiorca = [...clients.values()].find(x => String(x.id) === String(msg.to));
          if (odbiorca && odbiorca.name) {
            t.stany = t.stany || {};
            t.stany[odbiorca.name] = msg.payload;
          }
        }
        /* Gospodarz do konkretnego gracza albo do wszystkich. Adresowanie jest istotne:
           każdy ma widzieć wyłącznie swoje karty. */
        if (msg.to) {
          for (const g of t.guests) {
            const c = clients.get(g);
            if (c && String(c.id) === String(msg.to)) send(g, { type: 'relay', payload: msg.payload });
          }
        } else {
          for (const g of t.guests) send(g, { type: 'relay', payload: msg.payload });
        }
      } else {
        /* Gracz zawsze mówi do gospodarza. */
        send(t.host, { type: 'relay', peer: String(me.id), payload: msg.payload });
      }
      break;
    }
  }
}

function leave(socket) {
  const me = clients.get(socket);
  if (!me) return;

  if (me.role === 'host' && me.tableNo) {
    const t = tables.get(me.tableNo);
    if (t && t.started) {
      /* Rozpoczęta partia czeka na powrót gospodarza — nie kasujemy jej od razu. */
      for (const g of t.guests) send(g, { type: 'hostAway', no: t.no });
      uspijTable(me.tableNo);
    } else {
      closeTable(me.tableNo, 'Gospodarz opuścił stół.');
    }
  } else if (me.role === 'guest' && me.tableNo) {
    const t = tables.get(me.tableNo);
    if (t) {
      t.guests.delete(socket);
      send(t.host, { type: 'peerLeft', peer: String(me.id), name: me.name });
      broadcastTableList();
    }
  }
  me.tableNo = null;
  me.role = 'idle';
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
  clients.set(socket, { id: nextId++, name: 'Gracz', avatar: '🦊', tableNo: null, role: 'idle' });

  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || typeof msg.type !== 'string') return;
    try { handle(socket, msg); } catch (e) { console.error('Błąd obsługi:', e.message); }
  });

  socket.on('close', () => { leave(socket); clients.delete(socket); });
  socket.on('error', () => { leave(socket); clients.delete(socket); });

  /* Utrzymanie łącza: pośrednicy lubią zamykać ciche połączenia. */
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
});

setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) { socket.terminate(); continue; }
    socket.isAlive = false;
    try { socket.ping(); } catch (e) {}
  }
}, 25000);

server.listen(PORT, () => {
  console.log('Serwer stołów Tysiąca nasłuchuje na porcie ' + PORT);
});
