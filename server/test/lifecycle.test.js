/* ============================================================================
   Testy regresji cyklu życia stołów online.
   Każdy test podnosi własny serwer na losowym porcie (izolacja) i steruje nim
   prawdziwymi klientami WebSocket. TTL skracamy przez zmienną środowiskową.
   silnik.js NIE jest tu w żaden sposób modyfikowany ani wywoływany bezpośrednio.
   ========================================================================== */

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { startServer, health, sleep, freshPid, Player } = require('./helpers.js');

const seatByPid = (roster, pid) => roster.seats.find((s) => s && s.pid === pid);
const seatIndexByPid = (roster, pid) => roster.seats.findIndex((s) => s && s.pid === pid);

/* --------------------------------------------------------------- #1 tożsamość */

test('dwóch graczy z identycznym nickiem i różnym pid to dwa odrębne miejsca', async () => {
  const srv = await startServer();
  try {
    const p1 = new Player(srv.port, 'host'); await p1.connect();
    const p2 = new Player(srv.port, 'gosc'); await p2.connect();
    const pid1 = freshPid('a'), pid2 = freshPid('b');

    await p1.hello(pid1, 'Anna', '🦊');
    await p2.hello(pid2, 'Anna', '🐼');

    const created = await (p1.send({ type: 'createTable', seats: 3, bombs: 0 }), p1.waitFor('tableCreated'));
    p2.send({ type: 'joinTable', no: created.no });
    await p2.waitFor('joined');

    const r = await p1.waitRoster((x) => x.seats.filter(Boolean).length === 2);
    const s1 = seatByPid(r, pid1), s2 = seatByPid(r, pid2);
    assert.ok(s1 && s2, 'oba pid mają swoje miejsce');
    assert.notStrictEqual(s1.pid, s2.pid, 'różne pid mimo tego samego nicku');
    assert.strictEqual(s1.name, 'Anna');
    assert.strictEqual(s2.name, 'Anna');
    assert.strictEqual(s1.role, 'host');
    assert.strictEqual(s2.role, 'guest');
  } finally { await srv.stop(); }
});

/* --------------------------------------------------------------- #2 jeden host */

test('jeden pid nie może stworzyć dwóch stołów', async () => {
  const srv = await startServer();
  try {
    const p = new Player(srv.port); await p.connect();
    await p.hello(freshPid(), 'Bez', '🦊');
    p.send({ type: 'createTable', seats: 3, bombs: 0 });
    await p.waitFor('tableCreated');
    p.send({ type: 'createTable', seats: 3, bombs: 0 });
    const fail = await p.waitFor('createFailed');
    assert.match(fail.reason, /już aktywny stół/i);
  } finally { await srv.stop(); }
});

/* --------------------------------------------------------------- #3 host disconnect w lobby */

test('host disconnect w lobby → stół nadal istnieje, miejsce zarezerwowane', async () => {
  const srv = await startServer();                 /* domyślny, długi TTL */
  try {
    const pidH = freshPid('h');
    const p1 = new Player(srv.port, 'host'); await p1.connect();
    await p1.hello(pidH, 'Gospodarz', '🦊');
    p1.send({ type: 'createTable', seats: 3, bombs: 0 });
    const created = await p1.waitFor('tableCreated');

    await p1.drop();                               /* utrata połączenia, NIE świadome wyjście */
    await sleep(80);

    const h = await health(srv.port);
    assert.strictEqual(h.stoly, 1, 'stół przetrwał rozłączenie hosta');

    /* Ten sam pid widzi zarezerwowane miejsce hosta. */
    const p1b = new Player(srv.port, 'host-wraca'); await p1b.connect();
    const w = await p1b.hello(pidH, 'Gospodarz', '🦊');
    assert.ok(w.resume, 'serwer proponuje powrót');
    assert.strictEqual(w.resume.no, created.no);
    assert.strictEqual(w.resume.role, 'host');
  } finally { await srv.stop(); }
});

/* --------------------------------------------------------------- #4/#16 guest disconnect */

test('guest disconnect → miejsce nadal zajęte (oznaczone offline)', async () => {
  const srv = await startServer();
  try {
    const pidH = freshPid('h'), pidG = freshPid('g');
    const p1 = new Player(srv.port, 'host'); await p1.connect(); await p1.hello(pidH, 'Host', '🦊');
    p1.send({ type: 'createTable', seats: 3, bombs: 0 });
    const created = await p1.waitFor('tableCreated');

    const p2 = new Player(srv.port, 'gosc'); await p2.connect(); await p2.hello(pidG, 'Gość', '🐼');
    p2.send({ type: 'joinTable', no: created.no });
    await p2.waitFor('joined');
    await p1.waitRoster((r) => !!seatByPid(r, pidG));

    await p2.drop();

    const r = await p1.waitRoster((x) => { const s = seatByPid(x, pidG); return s && s.connected === false; });
    const s = seatByPid(r, pidG);
    assert.ok(s, 'miejsce gościa nadal istnieje');
    assert.strictEqual(s.connected, false, 'gość oznaczony jako offline');
    const hh = await health(srv.port);
    assert.strictEqual(hh.stoly, 1);
  } finally { await srv.stop(); }
});

/* --------------------------------------------------------------- #5 reconnect hosta */

test('reconnect hosta (ten sam pid) → nadal host', async () => {
  const srv = await startServer();
  try {
    const pidH = freshPid('h');
    const p1 = new Player(srv.port, 'host'); await p1.connect(); await p1.hello(pidH, 'Host', '🦊');
    p1.send({ type: 'createTable', seats: 3, bombs: 0 });
    const created = await p1.waitFor('tableCreated');
    await p1.drop();

    const p1b = new Player(srv.port, 'host2'); await p1b.connect(); await p1b.hello(pidH, 'Host', '🦊');
    p1b.send({ type: 'rejoinTable', no: created.no });
    const rj = await p1b.waitFor('rejoined');
    assert.strictEqual(rj.role, 'host', 'po powrocie nadal host');

    const r = await p1b.waitRoster((x) => { const s = seatByPid(x, pidH); return s && s.connected; });
    assert.strictEqual(seatByPid(r, pidH).role, 'host');
  } finally { await srv.stop(); }
});

/* --------------------------------------------------------------- #5 reconnect gościa na to samo miejsce */

test('reconnect gościa (ten sam pid) → to samo miejsce', async () => {
  const srv = await startServer();
  try {
    const pidH = freshPid('h'), pidG = freshPid('g');
    const p1 = new Player(srv.port, 'host'); await p1.connect(); await p1.hello(pidH, 'Host', '🦊');
    p1.send({ type: 'createTable', seats: 3, bombs: 0 });
    const created = await p1.waitFor('tableCreated');

    const p2 = new Player(srv.port, 'gosc'); await p2.connect(); await p2.hello(pidG, 'Gość', '🐼');
    p2.send({ type: 'joinTable', no: created.no });
    await p2.waitFor('joined');
    const r0 = await p1.waitRoster((r) => !!seatByPid(r, pidG));
    const idx0 = seatIndexByPid(r0, pidG);

    await p2.drop();
    await p1.waitRoster((x) => { const s = seatByPid(x, pidG); return s && s.connected === false; });

    const p2b = new Player(srv.port, 'gosc2'); await p2b.connect();
    const w = await p2b.hello(pidG, 'Gość', '🐼');
    assert.strictEqual(w.resume.role, 'guest');
    p2b.send({ type: 'rejoinTable', no: created.no });
    const rj = await p2b.waitFor('rejoined');
    assert.strictEqual(rj.role, 'guest');

    const r1 = await p1.waitRoster((x) => { const s = seatByPid(x, pidG); return s && s.connected === true; });
    assert.strictEqual(seatIndexByPid(r1, pidG), idx0, 'to samo miejsce co przed rozłączeniem');
  } finally { await srv.stop(); }
});

/* --------------------------------------------------------------- #12 jawne wyjście */

test('jawne leaveTable → miejsce zwolnione', async () => {
  const srv = await startServer();
  try {
    const pidH = freshPid('h'), pidG = freshPid('g');
    const p1 = new Player(srv.port, 'host'); await p1.connect(); await p1.hello(pidH, 'Host', '🦊');
    p1.send({ type: 'createTable', seats: 3, bombs: 0 });
    const created = await p1.waitFor('tableCreated');

    const p2 = new Player(srv.port, 'gosc'); await p2.connect(); await p2.hello(pidG, 'Gość', '🐼');
    p2.send({ type: 'joinTable', no: created.no });
    await p2.waitFor('joined');
    await p1.waitRoster((r) => !!seatByPid(r, pidG));

    p2.send({ type: 'leaveTable' });

    const r = await p1.waitRoster((x) => !seatByPid(x, pidG));
    assert.ok(!seatByPid(r, pidG), 'miejsce gościa zwolnione po jawnym wyjściu');

    /* Po jawnym wyjściu ten pid nie ma już rezerwacji. */
    const p2b = new Player(srv.port, 'gosc2'); await p2b.connect();
    const w = await p2b.hello(pidG, 'Gość', '🐼');
    assert.strictEqual(w.resume, null, 'brak rezerwacji po jawnym wyjściu');
  } finally { await srv.stop(); }
});

test('jawne wyjście HOSTA w lobby zamyka cały stół', async () => {
  const srv = await startServer();
  try {
    const pidH = freshPid('h'), pidG = freshPid('g');
    const p1 = new Player(srv.port, 'host'); await p1.connect(); await p1.hello(pidH, 'Host', '🦊');
    p1.send({ type: 'createTable', seats: 3, bombs: 0 });
    const created = await p1.waitFor('tableCreated');

    const p2 = new Player(srv.port, 'gosc'); await p2.connect(); await p2.hello(pidG, 'Gość', '🐼');
    p2.send({ type: 'joinTable', no: created.no });
    await p2.waitFor('joined');

    p1.send({ type: 'leaveTable' });
    const closed = await p2.waitFor('tableClosed');
    assert.match(closed.reason, /zamkn/i);
    await sleep(50);
    const h = await health(srv.port);
    assert.strictEqual(h.stoly, 0, 'stół zniknął po jawnym wyjściu hosta');
  } finally { await srv.stop(); }
});

/* --------------------------------------------------------------- #6/#9 start TTL */

test('ostatni człowiek offline → stół żyje i biegnie TTL', async () => {
  const srv = await startServer({ TABLE_TTL_MS: '600' });
  try {
    const pidH = freshPid('h');
    const p1 = new Player(srv.port, 'host'); await p1.connect(); await p1.hello(pidH, 'Host', '🦊');
    p1.send({ type: 'createTable', seats: 3, bombs: 0 });
    await p1.waitFor('tableCreated');

    await p1.drop();
    await sleep(120);
    const h = await health(srv.port);
    assert.strictEqual(h.stoly, 1, 'tuż po rozłączeniu stół jeszcze żyje (TTL biegnie)');
  } finally { await srv.stop(); }
});

/* --------------------------------------------------------------- #10 powrót anuluje TTL */

test('powrót przed końcem TTL anuluje odliczanie', async () => {
  const srv = await startServer({ TABLE_TTL_MS: '500' });
  try {
    const pidH = freshPid('h');
    const p1 = new Player(srv.port, 'host'); await p1.connect(); await p1.hello(pidH, 'Host', '🦊');
    p1.send({ type: 'createTable', seats: 3, bombs: 0 });
    const created = await p1.waitFor('tableCreated');

    await p1.drop();
    await sleep(150);                                   /* w połowie TTL */
    const p1b = new Player(srv.port, 'host2'); await p1b.connect(); await p1b.hello(pidH, 'Host', '🦊');
    p1b.send({ type: 'rejoinTable', no: created.no });
    await p1b.waitFor('rejoined');

    await sleep(700);                                   /* dużo ponad pierwotny TTL */
    const h = await health(srv.port);
    assert.strictEqual(h.stoly, 1, 'TTL anulowany przez powrót — stół żyje');
  } finally { await srv.stop(); }
});

/* --------------------------------------------------------------- #11 usunięcie po TTL */

test('brak ludzi przez pełny TTL → stół usunięty', async () => {
  const srv = await startServer({ TABLE_TTL_MS: '350' });
  try {
    const pidH = freshPid('h');
    const p1 = new Player(srv.port, 'host'); await p1.connect(); await p1.hello(pidH, 'Host', '🦊');
    p1.send({ type: 'createTable', seats: 3, bombs: 0 });
    const created = await p1.waitFor('tableCreated');

    await p1.drop();
    await sleep(700);
    const h = await health(srv.port);
    assert.strictEqual(h.stoly, 0, 'stół usunięty po TTL');

    const p1b = new Player(srv.port, 'host2'); await p1b.connect();
    const w = await p1b.hello(pidH, 'Host', '🦊');
    assert.strictEqual(w.resume, null, 'brak rezerwacji po wygaśnięciu');
    p1b.send({ type: 'rejoinTable', no: created.no });
    const jf = await p1b.waitFor('joinFailed');
    assert.match(jf.reason, /wygas|nie istnieje|nie istnieje/i);
  } finally { await srv.stop(); }
});

/* --------------------------------------------------------------- #7/#8 boty nie podtrzymują */

test('boty nie podtrzymują stołu — po odejściu człowieka stół wygasa', async () => {
  const srv = await startServer({ TABLE_TTL_MS: '350' });
  try {
    const pidH = freshPid('h');
    const p1 = new Player(srv.port, 'host'); await p1.connect(); await p1.hello(pidH, 'Host', '🦊');
    p1.send({ type: 'createTable', seats: 3, bombs: 0 });
    await p1.waitFor('tableCreated');

    /* Deklarujemy dwa boty i startujemy: 1 człowiek + 2 boty. */
    p1.send({ type: 'syncBots', bots: [{ name: 'Bot A', avatar: '🤖' }, { name: 'Bot B', avatar: '🤖' }] });
    await p1.waitRoster((r) => r.seats.filter((s) => s && s.bot).length === 2);
    p1.send({ type: 'started' });
    await p1.waitFor('stanGry');

    await p1.drop();                                   /* jedyny człowiek znika */
    await sleep(700);                                  /* boty grają, ale nie liczą się jako ludzie */
    const h = await health(srv.port);
    assert.strictEqual(h.stoly, 0, 'stół z samymi botami wygasł mimo trwającej partii');
  } finally { await srv.stop(); }
});

/* --------------------------------------------------------------- #5/#10 gra przeżywa reconnect */

test('rozpoczęta gra przeżywa reconnect gracza (odzyskuje pozycję)', async () => {
  const srv = await startServer();
  try {
    const pidH = freshPid('h'), pidG = freshPid('g');
    const p1 = new Player(srv.port, 'host'); await p1.connect(); await p1.hello(pidH, 'Ala', '🦊');
    p1.send({ type: 'createTable', seats: 2, bombs: 0 });
    const created = await p1.waitFor('tableCreated');

    const p2 = new Player(srv.port, 'gosc'); await p2.connect(); await p2.hello(pidG, 'Ola', '🐼');
    p2.send({ type: 'joinTable', no: created.no });
    await p2.waitFor('joined');
    await p1.waitRoster((r) => r.seats.filter(Boolean).length === 2);

    p1.send({ type: 'started' });
    const stan1 = await p2.waitFor('stanGry');
    assert.ok(stan1.G, 'gość dostał stan gry');
    assert.ok(stan1.G.playerNames.includes('Ala') && stan1.G.playerNames.includes('Ola'));

    await p2.drop();
    await sleep(80);
    const h = await health(srv.port);
    assert.strictEqual(h.stoly, 1, 'partia trwa mimo rozłączenia jednego gracza (host online)');

    const p2b = new Player(srv.port, 'gosc2'); await p2b.connect();
    const w = await p2b.hello(pidG, 'Ola', '🐼');
    assert.ok(w.resume && w.resume.started === true, 'powrót do trwającej partii');
    p2b.send({ type: 'rejoinTable', no: created.no });
    await p2b.waitFor('rejoined');
    const stan2 = await p2b.waitFor('stanGry');
    assert.ok(stan2.G, 'po powrocie gracz znów dostaje swój widok partii');
    assert.ok(stan2.G.playerNames.includes('Ola'), 'ta sama pozycja w partii');
  } finally { await srv.stop(); }
});

/* --------------------------------------------------------------- #17 silnik nietknięty */

test('server/silnik.js pozostaje nietknięty (suma kontrolna bazowa)', () => {
  const BASELINE = 'ab7d213b261f6d6c5a67595c8e0f27f3a111a1286fbbdafaadddd9f711e1d5bb';
  const buf = fs.readFileSync(path.join(__dirname, '..', 'silnik.js'));
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  assert.strictEqual(hash, BASELINE, 'silnik.js został zmieniony — a nie powinien');
});
