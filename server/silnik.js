'use strict';
/* =============================================================================
   SILNIK GRY — wersja serwerowa, niezależna od interfejsu.

   Całą partię prowadzi serwer, a telefony tylko pokazują stan i wysyłają ruchy.
   Dzięki temu wyjście gospodarza nie kończy gry, nikt nie może podejrzeć cudzych
   kart, a rozstrzyganie sporów ma jedno źródło prawdy.

   Silnik jest czystą maszyną stanów: nie zna sieci, nie rysuje, nie usypia.
   `krok()` posuwa grę tak daleko, jak się da bez pytania człowieka, i zatrzymuje
   się na `oczekiwanie`. `wykonaj()` przyjmuje ruch i znów woła `krok()`.
   ============================================================================= */

const KOLORY = ['S', 'H', 'D', 'C'];
const FIGURY = ['9', 'J', 'Q', 'K', '10', 'A'];
const PUNKTY = { '9': 0, 'J': 2, 'Q': 3, 'K': 4, '10': 10, 'A': 11 };
const MELDUNKI = { S: 40, C: 60, D: 80, H: 100 };
const BONUS_ZA_BOMBE = 60;
const META = 1000;

const idx = f => FIGURY.indexOf(f);
const cid = k => k.rank + k.suit;

/* ---------- talia ---------- */

function talia() {
  const t = [];
  for (const s of KOLORY) for (const r of FIGURY) t.push({ rank: r, suit: s });
  return t;
}

function potasuj(t, rand) {
  const a = t.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function porzadkuj(reka) {
  const kolejnosc = { S: 0, C: 1, D: 2, H: 3 };
  return reka.slice().sort((a, b) =>
    kolejnosc[a.suit] - kolejnosc[b.suit] || idx(b.rank) - idx(a.rank));
}

/* ---------- reguły wykładania kart ---------- */

function zwyciezcaLewy(lewa, kolorWyjscia, atu) {
  let best = 0;
  for (let i = 1; i < lewa.length; i++) {
    const cur = lewa[best].card, cand = lewa[i].card;
    const curA = atu && cur.suit === atu, candA = atu && cand.suit === atu;
    if (candA && !curA) { best = i; continue; }
    if (candA && curA) { if (idx(cand.rank) > idx(cur.rank)) best = i; continue; }
    if (!candA && curA) continue;
    if (cand.suit === kolorWyjscia && cur.suit === kolorWyjscia) {
      if (idx(cand.rank) > idx(cur.rank)) best = i;
    }
  }
  return best;
}

/* Obowiązek koloru jest silniejszy niż atu; w obrębie koloru trzeba przebić, jeśli można.
   Bez koloru trzeba zagrać atu, a mając wybór — przebić. */
function dozwolone(stan, miejsce) {
  const reka = stan.hands[miejsce];
  if (stan.trick.length === 0) return reka.slice();
  const kolor = stan.trick[0].card.suit;
  const atu = stan.trump;

  const bije = (karta) => {
    const sym = [...stan.trick, { seat: miejsce, card: karta }];
    return zwyciezcaLewy(sym, kolor, atu) === sym.length - 1;
  };

  const wKolorze = reka.filter(k => k.suit === kolor);
  if (wKolorze.length) {
    const mocne = wKolorze.filter(bije);
    return mocne.length ? mocne : wKolorze;
  }
  if (atu) {
    const atuty = reka.filter(k => k.suit === atu);
    if (atuty.length) {
      const mocne = atuty.filter(bije);
      return mocne.length ? mocne : atuty;
    }
  }
  return reka.slice();
}

/* ---------- meldunki ---------- */

function meldunekMozliwy(stan, miejsce, karta) {
  if (karta.rank !== 'K' && karta.rank !== 'Q') return 0;
  if (stan.trick.length !== 0) return 0;              /* tylko przy wyjściu */
  const para = karta.rank === 'K' ? 'Q' : 'K';
  const ma = stan.hands[miejsce].some(k => k.suit === karta.suit && k.rank === para);
  if (!ma) return 0;
  if ((stan.meldLog || []).some(m => m.suit === karta.suit)) return 0;  /* raz na kolor */
  return MELDUNKI[karta.suit];
}

function maJakikolwiekMeldunek(reka) {
  return KOLORY.some(s =>
    reka.some(k => k.suit === s && k.rank === 'K') &&
    reka.some(k => k.suit === s && k.rank === 'Q'));
}

function sumaMeldunkow(reka) {
  return KOLORY.reduce((s, kolor) => {
    const ma = reka.some(k => k.suit === kolor && k.rank === 'K') &&
               reka.some(k => k.suit === kolor && k.rank === 'Q');
    return s + (ma ? MELDUNKI[kolor] : 0);
  }, 0);
}

function maksymalnaOdzywka(reka) {
  return 120 + sumaMeldunkow(reka);
}

/* ---------- nowa partia ---------- */

function nowaGra(opcje) {
  const gracze = opcje.gracze;                 /* [{id, name, avatar, bot}] */
  const miejsca = opcje.miejsca || gracze.length;
  return {
    wersja: 1,
    mode: 'network',
    playerCount: gracze.length,
    playerNames: gracze.map(g => g.name),
    playerAvatars: gracze.map(g => g.avatar),
    playerControllers: gracze.map(g => g.bot ? 'bot' : 'remote'),
    graczeId: gracze.map(g => g.id),
    seats: miejsca,
    scores: Array(gracze.length).fill(0),
    dealer: 0,
    bombLimit: opcje.bombLimit || 0,
    bombsEnabled: (opcje.bombLimit || 0) > 0,
    bombsUsed: {},
    phase: 'menu',
    message: '',
    winner: null,
    oczekiwanie: null,
    zdarzenia: []
  };
}

/* ---------- rozdanie ---------- */

function rozdaj(stan, rand) {
  const n = stan.seats;
  const deck = potasuj(talia(), rand);
  stan.activePlayers = Array.from({ length: n }, (_, k) => (stan.dealer + 1 + k) % stan.playerCount);

  if (n === 2) {
    stan.hands = [porzadkuj(deck.slice(0, 10)), porzadkuj(deck.slice(10, 20))];
    stan.musikPair = [deck.slice(20, 22), deck.slice(22, 24)];
    stan.musik = [];
  } else {
    stan.hands = [porzadkuj(deck.slice(0, 7)), porzadkuj(deck.slice(7, 14)), porzadkuj(deck.slice(14, 21))];
    stan.musik = deck.slice(21, 24);
    stan.musikPair = null;
  }

  stan.trick = [];
  stan.leader = 0;
  stan.tricksPlayed = 0;
  stan.trickPoints = Array(n).fill(0);
  stan.meldPoints = Array(n).fill(0);
  stan.meldLog = [];
  stan.history = [];
  stan.trump = null;
  stan.bidder = null;
  stan.bidAmount = 0;
  stan.exchange = null;
  stan.chosenMusik = null;
  stan.musikCards = null;
  stan.leftoverCards = [];
  stan.receivedCards = {};
  stan.musikPokazany = false;
  stan.daryPokazane = false;
  stan.summaryRows = null;
  stan.bombOffer = null;
  stan.phase = 'bidding';
  stan.rozdanieNr = (stan.rozdanieNr || 0) + 1;
  stan.message = 'Rozdano karty.';
  stan.bidding = {
    current: 100,
    lastBidder: 0,
    turn: (n === 2) ? 1 : 1,
    passed: Array(n).fill(false),
    log: []
  };
  return stan;
}

/* ---------- boty ---------- */

function silaReki(reka) {
  let s = reka.reduce((a, k) => a + PUNKTY[k.rank], 0);
  s += sumaMeldunkow(reka) * 0.6;
  const dlugosci = {};
  reka.forEach(k => dlugosci[k.suit] = (dlugosci[k.suit] || 0) + 1);
  Object.values(dlugosci).forEach(d => { if (d >= 4) s += 8; });
  return s;
}

function botOdzywka(stan, miejsce) {
  const reka = stan.hands[miejsce];
  const max = maksymalnaOdzywka(reka);
  const prog = Math.round(silaReki(reka) * 1.35);
  const nast = stan.bidding.current + 10;
  if (nast > max || nast > prog) return { type: 'pass' };
  return { type: 'bid', amount: nast };
}

function botKarta(stan, miejsce) {
  const mozliwe = dozwolone(stan, miejsce);
  /* Meldunek przy wyjściu jest zawsze opłacalny. */
  if (stan.trick.length === 0) {
    const zMeldunkiem = mozliwe.filter(k => meldunekMozliwy(stan, miejsce, k) > 0);
    if (zMeldunkiem.length) {
      zMeldunkiem.sort((a, b) => MELDUNKI[b.suit] - MELDUNKI[a.suit]);
      return zMeldunkiem[0];
    }
  }
  /* Bierzemy lewę, jeśli możemy; inaczej zrzucamy najtańszą kartę. */
  const kolor = stan.trick.length ? stan.trick[0].card.suit : null;
  const wygrywajace = mozliwe.filter(k => {
    if (!stan.trick.length) return false;
    const sym = [...stan.trick, { seat: miejsce, card: k }];
    return zwyciezcaLewy(sym, kolor, stan.trump) === sym.length - 1;
  });
  const pula = wygrywajace.length ? wygrywajace : mozliwe;
  if (wygrywajace.length) {
    pula.sort((a, b) => PUNKTY[a.rank] - PUNKTY[b.rank]);
    return pula[0];
  }
  pula.sort((a, b) => PUNKTY[a.rank] - PUNKTY[b.rank]);
  return pula[0];
}

/* ---------- punktacja ---------- */

function zaokr10(x) { return Math.round(x / 10) * 10; }

function podliczRozdanie(stan) {
  const n = stan.seats;
  const wiersze = [];
  for (let miejsce = 0; miejsce < n; miejsce++) {
    const rid = stan.activePlayers[miejsce];
    const lewy = stan.trickPoints[miejsce];
    const meld = stan.meldPoints[miejsce];
    const razem = lewy + meld;
    let delta, opis = '';
    if (miejsce === stan.bidder) {
      if (razem >= stan.bidAmount) { delta = stan.bidAmount; opis = 'kontrakt ' + stan.bidAmount + ' wykonany'; }
      else { delta = -stan.bidAmount; opis = 'kontrakt ' + stan.bidAmount + ' niewykonany'; }
    } else {
      delta = zaokr10(razem);
    }
    stan.scores[rid] += delta;
    /* Nazwy pól muszą zgadzać się z tym, czego oczekuje tabela na ekranie — inaczej
       gracz widzi „undefined" zamiast wyników. */
    wiersze.push({
      seat: miejsce, rid,
      name: stan.playerNames[rid],
      bidder: (miejsce === stan.bidder),
      tricks: lewy,
      melds: meld,
      total: razem,
      delta, note: opis,
      score: stan.scores[rid]
    });
  }
  stan.summaryRows = wiersze;
  return wiersze;
}

function sprawdzKoniec(stan) {
  const nad = stan.scores.map((s, i) => ({ i, s })).filter(x => x.s >= META);
  if (!nad.length) return false;
  let zwyciezca;
  if (nad.length === 1) zwyciezca = nad[0].i;
  else {
    const grajacyRid = (stan.bidder !== null && stan.bidder !== undefined)
      ? stan.activePlayers[stan.bidder] : null;
    const g = nad.find(x => x.i === grajacyRid);
    if (g) zwyciezca = g.i;
    else {
      const max = Math.max(...nad.map(x => x.s));
      const remis = nad.filter(x => x.s === max);
      zwyciezca = remis.length === 1 ? remis[0].i : null;
    }
  }
  stan.winner = zwyciezca;
  stan.phase = 'gameover';
  return true;
}

/* ---------- maszyna stanów ---------- */

/* Kogo podświetlić na ekranie. Zawsze wskazujemy kogoś: gracza na ruchu, bota w trakcie
   namysłu, a gdy lewa leży na stole — tego, kto ją bierze. Bez tego w czasie pauz
   podświetlenie gasło i wyglądało, jakby gra na nikogo nie czekała. */
function ustawPodswietlenie(stan) {
  if (stan.phase === 'summary' || stan.phase === 'gameover' || stan.phase === 'menu') {
    stan.podswietl = null; return;
  }
  if (stan.myslacy !== null && stan.myslacy !== undefined) { stan.podswietl = stan.myslacy; return; }
  if (stan.phase === 'bidding' && stan.bidding) { stan.podswietl = stan.bidding.turn; return; }
  if (stan.phase === 'musikpick' || stan.phase === 'musikreveal' || stan.phase === 'exchange' ||
      stan.phase === 'giftreveal' || stan.phase === 'declare' ||
      stan.phase === 'bombchance') { stan.podswietl = stan.bidder; return; }
  if (stan.phase === 'play') {
    const trick = stan.trick || [];
    if (trick.length && trick.length === stan.seats) {
      /* Pełna lewa: świeci ten, kto ją bierze. */
      const kolor = trick[0].card.suit;
      stan.podswietl = trick[zwyciezcaLewy(trick, kolor, stan.trump)].seat;
      return;
    }
    stan.podswietl = (stan.leader + trick.length) % stan.seats;
    return;
  }
  stan.podswietl = null;
}

function czekajNa(stan, miejsce, typ, dodatki) {
  stan.oczekiwanie = Object.assign({ seat: miejsce, typ }, dodatki || {});
  ustawPodswietlenie(stan);
}

function botem(stan, miejsce) {
  const rid = stan.activePlayers[miejsce];
  return stan.playerControllers[rid] === 'bot';
}

/* Posuwa grę tak daleko, jak się da bez udziału człowieka. */
/* Po pauzie serwer wywołuje kontynuuj(), żeby gra ruszyła dalej. */
function kontynuuj(stan, rand) {
  if (stan.pauza === 'lewa') {
    stan.pauza = null;
    rozstrzygnijLewe(stan);
  } else if (stan.pauza === 'mysli') {
    /* Koniec namysłu — bot kładzie kartę, a ta zostaje chwilę widoczna. */
    const miejsce = stan.myslacy;
    stan.pauza = null; stan.myslacy = null;
    if (miejsce !== null && miejsce !== undefined && stan.phase === 'play') {
      zagraj(stan, miejsce, botKarta(stan, miejsce));
      stan.pauza = 'karta';
      ustawPodswietlenie(stan);
      return stan;
    }
  } else {
    stan.pauza = null;
  }
  return krok(stan, rand);
}

function krok(stan, rand) {
  rand = rand || Math.random;
  let bezpiecznik = 0;
  stan.pauza = null;
  stan.myslacy = null;

  while (bezpiecznik++ < 500) {
    stan.oczekiwanie = null;

    if (stan.phase === 'gameover') return stan;

    /* --- licytacja --- */
    if (stan.phase === 'bidding') {
      const b = stan.bidding;
      const zostali = b.passed.map((p, i) => p ? null : i).filter(i => i !== null);
      if (zostali.length <= 1) {
        stan.bidder = b.lastBidder;
        stan.bidAmount = b.current;
        stan.phase = (stan.seats === 2) ? 'musikpick' : 'musikreveal';
        stan.message = stan.playerNames[stan.activePlayers[stan.bidder]] + ' wygrał licytację.';
        continue;
      }
      if (b.passed[b.turn]) { b.turn = (b.turn + 1) % stan.seats; continue; }
      if (botem(stan, b.turn)) {
        zastosujOdzywke(stan, b.turn, botOdzywka(stan, b.turn));
        continue;
      }
      czekajNa(stan, b.turn, 'odzywka', { current: b.current, max: maksymalnaOdzywka(stan.hands[b.turn]) });
      return stan;
    }

    /* --- musik przy grze we dwoje: wybór jednej z dwóch kupek --- */
    if (stan.phase === 'musikpick') {
      if (botem(stan, stan.bidder)) { wezMusik(stan, Math.floor(rand() * 2)); continue; }
      czekajNa(stan, stan.bidder, 'musik');
      return stan;
    }

    /* --- musik przy trójce: odkryty dla WSZYSTKICH --- */
    if (stan.phase === 'musikreveal') {
      if (!stan.musikPokazany) {
        /* Karty trafiają do ręki grającego, ale zostają chwilę widoczne na stole —
           inaczej nikt nie zdążyłby zobaczyć, co było w musiku. */
        stan.hands[stan.bidder] = porzadkuj(stan.hands[stan.bidder].concat(stan.musik));
        stan.musikCards = stan.musik.slice();
        stan.musikPokazany = true;
        stan.message = stan.playerNames[stan.activePlayers[stan.bidder]] + ' bierze musik.';
        stan.pauza = 'musik';
        ustawPodswietlenie(stan);
        return stan;
      }
      stan.phase = 'exchange';
      stan.exchange = { step: 'select', selected: [], assigned: {} };
      continue;
    }

    /* --- pokazanie kart oddanych przeciwnikom --- */
    if (stan.phase === 'giftreveal') {
      if (!stan.daryPokazane) {
        stan.daryPokazane = true;
        stan.pauza = 'dary';
        ustawPodswietlenie(stan);
        return stan;
      }
      stan.phase = 'bombchance';
      continue;
    }

    /* --- oddawanie kart --- */
    if (stan.phase === 'exchange') {
      if (botem(stan, stan.bidder)) { botOddajeKarty(stan); continue; }
      czekajNa(stan, stan.bidder, 'wymiana');
      return stan;
    }

    /* --- bomba po obejrzeniu pełnej ręki --- */
    if (stan.phase === 'bombchance') {
      const rid = stan.activePlayers[stan.bidder];
      const zostalo = stan.bombLimit - (stan.bombsUsed[rid] || 0);
      if (!stan.bombsEnabled || zostalo <= 0) { stan.phase = 'declare'; continue; }
      if (botem(stan, stan.bidder)) {
        const slaba = silaReki(stan.hands[stan.bidder]) < 45 && stan.bidAmount >= 120;
        if (slaba && rand() < 0.5) { rzucBombe(stan); return stan; }
        stan.phase = 'declare'; continue;
      }
      czekajNa(stan, stan.bidder, 'bomba', { amount: stan.bidAmount, left: zostalo });
      return stan;
    }

    /* --- deklaracja ostatecznego kontraktu --- */
    if (stan.phase === 'declare') {
      if (botem(stan, stan.bidder)) { zadeklaruj(stan, stan.bidAmount); continue; }
      czekajNa(stan, stan.bidder, 'kontrakt', {
        min: stan.bidAmount,
        max: Math.max(stan.bidAmount, maksymalnaOdzywka(stan.hands[stan.bidder]))
      });
      return stan;
    }

    /* --- rozgrywka --- */
    if (stan.phase === 'play') {
      const naRuchu = (stan.leader + stan.trick.length) % stan.seats;

      /* Pełna lewa zostaje CHWILĘ na stole, zanim ją zbierzemy. Bez tej pauzy gracz nigdy
         nie zobaczyłby ani swojej karty, ani karty przeciwnika — lewa rozwiązywała się
         w tej samej chwili, w której padła ostatnia karta. */
      if (stan.trick.length === stan.seats) {
        stan.pauza = 'lewa';
        ustawPodswietlenie(stan);
        return stan;
      }

      if (botem(stan, naRuchu)) {
        /* Najpierw pokazujemy, że to kolej bota — inaczej jego awatar nigdy się nie podświetli,
           bo stan trafiał do telefonów dopiero PO zagraniu karty. */
        stan.pauza = 'mysli';
        stan.myslacy = naRuchu;
        ustawPodswietlenie(stan);
        return stan;
      }

      czekajNa(stan, naRuchu, 'karta', { legal: dozwolone(stan, naRuchu).map(cid) });
      return stan;   /* czekajNa już ustawiło podświetlenie */
    }

    /* --- podsumowanie --- */
    if (stan.phase === 'summary') {
      czekajNa(stan, null, 'potwierdzenie');
      ustawPodswietlenie(stan);
      return stan;
    }

    ustawPodswietlenie(stan);
    return stan;
  }
  return stan;
}

/* ---------- czynności ---------- */

function zastosujOdzywke(stan, miejsce, akcja) {
  const b = stan.bidding;
  const nazwa = stan.playerNames[stan.activePlayers[miejsce]];
  if (akcja.type === 'pass') {
    b.passed[miejsce] = true;
    b.log.push(nazwa + ': pas');
  } else {
    b.current = akcja.amount;
    b.lastBidder = miejsce;
    b.log.push(nazwa + ': ' + akcja.amount);
  }
  b.turn = (miejsce + 1) % stan.seats;
}

function wezMusik(stan, ktory) {
  stan.chosenMusik = ktory;
  stan.musikCards = stan.musikPair[ktory].slice();
  stan.hands[stan.bidder] = porzadkuj(stan.hands[stan.bidder].concat(stan.musikCards));
  stan.leftoverCards = stan.musikPair[1 - ktory].slice();
  stan.phase = 'exchange';
  stan.exchange = { step: 'select', selected: [], assigned: {} };
  stan.message = 'Musik ' + (ktory + 1) + ' odkryty.';
}

function botOddajeKarty(stan) {
  const reka = stan.hands[stan.bidder].slice()
    .sort((a, b) => PUNKTY[a.rank] - PUNKTY[b.rank] || idx(a.rank) - idx(b.rank));
  const dwie = [reka[0], reka[1]];
  if (stan.seats === 2) {
    stan.leftoverCards = (stan.leftoverCards || []).concat(dwie);
    dwie.forEach(k => { stan.hands[stan.bidder] = stan.hands[stan.bidder].filter(x => cid(x) !== cid(k)); });
  } else {
    const inni = [];
    for (let i = 0; i < stan.seats; i++) if (i !== stan.bidder) inni.push(i);
    dwie.forEach((k, i) => {
      stan.hands[stan.bidder] = stan.hands[stan.bidder].filter(x => cid(x) !== cid(k));
      stan.hands[inni[i]] = porzadkuj(stan.hands[inni[i]].concat([k]));
      stan.receivedCards[inni[i]] = k;
    });
  }
  stan.exchange = null;
  /* Przy trójce każdy przeciwnik dostał kartę — pokazujemy mu ją, zanim gra ruszy dalej. */
  stan.phase = (stan.seats === 3) ? 'giftreveal' : 'bombchance';
}

function rzucBombe(stan) {
  const rid = stan.activePlayers[stan.bidder];
  stan.bombsUsed[rid] = (stan.bombsUsed[rid] || 0) + 1;
  const wiersze = [];
  for (let m = 0; m < stan.seats; m++) {
    const r = stan.activePlayers[m];
    const delta = (m === stan.bidder) ? 0 : BONUS_ZA_BOMBE;
    stan.scores[r] += delta;
    wiersze.push({
      seat: m, rid: r,
      name: stan.playerNames[r],
      bidder: (m === stan.bidder),
      tricks: 0, melds: 0, total: 0,
      delta, note: (m === stan.bidder ? 'bomba' : ''),
      score: stan.scores[r]
    });
  }
  stan.summaryRows = wiersze;
  stan.message = '💣 ' + stan.playerNames[rid] + ' rzuca bombę.';
  stan.phase = 'summary';
}

function zadeklaruj(stan, kwota) {
  stan.bidAmount = kwota;
  stan.phase = 'play';
  stan.leader = stan.bidder;
  stan.message = '';
}

function zagraj(stan, miejsce, karta) {
  const legalne = dozwolone(stan, miejsce);
  const wybrana = legalne.find(k => cid(k) === cid(karta));
  if (!wybrana) return false;

  const meld = meldunekMozliwy(stan, miejsce, wybrana);
  if (meld > 0) {
    stan.meldPoints[miejsce] += meld;
    stan.meldLog.push({ suit: wybrana.suit, seat: miejsce, value: meld });
    stan.trump = wybrana.suit;
    stan.message = stan.playerNames[stan.activePlayers[miejsce]] + ' melduje (+' + meld + ').';
  }

  stan.hands[miejsce] = stan.hands[miejsce].filter(k => cid(k) !== cid(wybrana));
  stan.trick.push({ seat: miejsce, card: wybrana });
  return true;
}

function rozstrzygnijLewe(stan) {
  const kolor = stan.trick[0].card.suit;
  const w = zwyciezcaLewy(stan.trick, kolor, stan.trump);
  const miejsce = stan.trick[w].seat;
  const pkt = stan.trick.reduce((s, t) => s + PUNKTY[t.card.rank], 0);
  stan.trickPoints[miejsce] += pkt;
  /* Panel „Ostatnie lewy" potrzebuje wiedzieć, KTO zagrał którą kartę, żeby wyróżnić
     zwycięską. Zapis samych kart wywracał rysowanie ekranu po pierwszej lewie. */
  stan.history.push({
    winner: miejsce,
    cards: stan.trick.map(t => ({ seat: t.seat, card: t.card })),
    no: stan.tricksPlayed + 1
  });
  stan.trick = [];
  stan.leader = miejsce;
  stan.tricksPlayed++;
  stan.message = stan.playerNames[stan.activePlayers[miejsce]] + ' bierze lewę (+' + pkt + ').';

  const wszystkie = (stan.seats === 2) ? 10 : 8;
  if (stan.tricksPlayed === wszystkie) {
    if (stan.leftoverCards && stan.leftoverCards.length) {
      stan.trickPoints[miejsce] += stan.leftoverCards.reduce((s, k) => s + PUNKTY[k.rank], 0);
      stan.leftoverCards = [];
    }
    podliczRozdanie(stan);
    stan.phase = 'summary';
    if (sprawdzKoniec(stan)) stan.phase = 'gameover';
  }
}

/* ---------- wejście z zewnątrz ---------- */

/* Zwraca {ok} albo {ok:false, why}. Ruchy nie na kolei są odrzucane — to jedyne
   miejsce, w którym gra przyjmuje cokolwiek od gracza. */
function wykonaj(stan, rid, akcja, rand) {
  const o = stan.oczekiwanie;
  if (!o) return { ok: false, why: 'Gra nie czeka teraz na ruch.' };

  if (o.typ === 'potwierdzenie') {
    if (stan.phase !== 'summary') return { ok: false, why: 'Nie ma czego potwierdzać.' };
    /* Potwierdzają wszyscy gracze naraz, a rozdać wolno tylko RAZ. Bez tego drugie
       potwierdzenie rozdawało karty po raz drugi i gra rozjeżdżała się między telefonami. */
    if (akcja && akcja.rozdanie !== undefined && akcja.rozdanie !== stan.rozdanieNr) {
      return { ok: true };
    }
    rozdaj(stan, rand || Math.random);
    krok(stan, rand);
    return { ok: true };
  }

  const miejsce = stan.activePlayers.indexOf(rid);
  if (miejsce !== o.seat) return { ok: false, why: 'To nie Twoja kolej.' };

  switch (o.typ) {
    case 'odzywka': {
      if (akcja.type === 'bid') {
        const max = maksymalnaOdzywka(stan.hands[miejsce]);
        if (akcja.amount <= stan.bidding.current || akcja.amount % 10 !== 0 || akcja.amount > max) {
          return { ok: false, why: 'Niedozwolona odzywka.' };
        }
      } else if (akcja.type !== 'pass') return { ok: false, why: 'Nieznana odzywka.' };
      zastosujOdzywke(stan, miejsce, akcja);
      break;
    }
    case 'musik': {
      const k = (akcja.musik === 1) ? 1 : 0;
      wezMusik(stan, k);
      break;
    }
    case 'wymiana': {
      const wynik = przyjmijWymiane(stan, akcja);
      if (!wynik.ok) return wynik;
      break;
    }
    case 'bomba': {
      if (akcja.bomb) { rzucBombe(stan); }
      else stan.phase = 'declare';
      break;
    }
    case 'kontrakt': {
      const kwota = akcja.amount;
      /* Górny limit nie może spaść PONIŻEJ wylicytowanej kwoty. Odkładając karty można
         rozbić meldunek, przez co ręka „traci" zdolność licytacyjną — a wtedy grający
         nie mógłby zadeklarować nawet tego, co sam wylicytował, i gra stawała. */
      const max = Math.max(stan.bidAmount, maksymalnaOdzywka(stan.hands[miejsce]));
      if (kwota < stan.bidAmount || kwota % 10 !== 0 || kwota > max) {
        return { ok: false, why: 'Niedozwolony kontrakt.' };
      }
      zadeklaruj(stan, kwota);
      break;
    }
    case 'karta': {
      if (!zagraj(stan, miejsce, akcja.card)) return { ok: false, why: 'Nie wolno zagrać tej karty.' };
      break;
    }
    default: return { ok: false, why: 'Nieznany ruch.' };
  }

  krok(stan, rand);
  return { ok: true };
}

/* Oddanie kart: przy trójce po jednej dla każdego przeciwnika, przy dwójce dwie na spód. */
function przyjmijWymiane(stan, akcja) {
  const dwie = akcja.cards || [];
  if (dwie.length !== 2) return { ok: false, why: 'Wybierz dokładnie dwie karty.' };
  const reka = stan.hands[stan.bidder];
  const znalezione = dwie.map(k => reka.find(x => cid(x) === cid(k)));
  if (znalezione.some(k => !k)) return { ok: false, why: 'Nie masz tych kart.' };

  if (stan.seats === 2) {
    stan.leftoverCards = (stan.leftoverCards || []).concat(znalezione);
    znalezione.forEach(k => { stan.hands[stan.bidder] = stan.hands[stan.bidder].filter(x => cid(x) !== cid(k)); });
  } else {
    const inni = [];
    for (let i = 0; i < stan.seats; i++) if (i !== stan.bidder) inni.push(i);
    const przydzial = akcja.assign || {};
    const cele = znalezione.map((k, i) => {
      const wskazany = przydzial[cid(k)];
      return (wskazany === undefined) ? inni[i] : wskazany;
    });
    if (new Set(cele).size !== 2) return { ok: false, why: 'Każdy przeciwnik dostaje jedną kartę.' };
    znalezione.forEach((k, i) => {
      stan.hands[stan.bidder] = stan.hands[stan.bidder].filter(x => cid(x) !== cid(k));
      stan.hands[cele[i]] = porzadkuj(stan.hands[cele[i]].concat([k]));
      stan.receivedCards[cele[i]] = k;
    });
  }
  stan.exchange = null;
  stan.phase = (stan.seats === 3) ? 'giftreveal' : 'bombchance';
  return { ok: true };
}

/* ---------- widok dla jednego gracza ---------- */

/* Każdy dostaje wyłącznie swoje karty. Serwer nigdy nie wysyła pełnego stanu,
   więc podglądanie cudzej ręki jest niemożliwe nawet przy podmienionym kliencie. */
function widokDla(stan, rid) {
  const w = JSON.parse(JSON.stringify(stan));
  const moje = stan.activePlayers ? stan.activePlayers.indexOf(rid) : -1;

  if (w.hands) {
    w.handCounts = w.hands.map(h => h.length);
    w.hands = w.hands.map((h, i) => (i === moje) ? h : []);
  }
  /* Musik jest zakryty do chwili odkrycia. Wcześniej wysyłamy wyłącznie liczbę kart,
     bo inaczej podmieniony klient mógłby go podejrzeć przed licytacją. */
  const odkryty = (w.phase === 'musikreveal' || w.phase === 'exchange' || w.phase === 'giftreveal' ||
                   w.phase === 'play' || w.phase === 'summary' || w.phase === 'bombchance' ||
                   w.phase === 'declare');
  /* Wybrany musik pokazujemy na stole — gracz musi zobaczyć, co dostał, zanim odłoży karty. */
  if (w.phase === 'exchange' && stan.musikCards) w.musikCards = stan.musikCards.slice();
  if (!odkryty) {
    w.musik = (stan.musik || []).map(() => null);
    w.musikCards = null;
  }
  /* Przy grze we dwoje obie kupki są zakryte aż do wyboru. */
  if (w.musikPair) {
    w.musikPair = (w.phase === 'musikpick')
      ? w.musikPair.map(para => para.map(() => null))
      : null;
  }
  if (w.receivedCards) {
    const moja = {};
    if (w.receivedCards[moje]) moja[moje] = w.receivedCards[moje];
    w.receivedCards = moja;
  }
  if (w.oczekiwanie && w.oczekiwanie.seat !== moje) {
    w.oczekiwanie = { seat: w.oczekiwanie.seat, typ: w.oczekiwanie.typ };
  }
  /* Odłożone karty leżą zakryte do końca rozdania — wysyłamy tylko ich LICZBĘ, żeby dało
     się je narysować, ale nikt nie poznał wartości przed czasem. */
  /* Stosik pokazujemy dopiero, gdy grający NAPRAWDĘ odłożył karty. Nieotwarta kupka trafia
     do puli już przy wyborze musika, więc wcześniej stosik pojawiałby się bez powodu. */
  const poOdlozeniu = (w.phase === 'giftreveal' || w.phase === 'bombchance' || w.phase === 'declare' ||
                       w.phase === 'play' || w.phase === 'summary' || w.phase === 'gameover');
  w.odlozoneIle = poOdlozeniu ? (stan.leftoverCards || []).length : 0;
  delete w.leftoverCards;

  w.focusSeat = moje;
  w.mojRid = rid;
  return w;
}

module.exports = {
  KOLORY, FIGURY, PUNKTY, MELDUNKI, BONUS_ZA_BOMBE, META,
  talia, potasuj, porzadkuj, zwyciezcaLewy, dozwolone,
  meldunekMozliwy, maJakikolwiekMeldunek, sumaMeldunkow, maksymalnaOdzywka,
  silaReki, zaokr10, podliczRozdanie, sprawdzKoniec,
  nowaGra, rozdaj, krok, kontynuuj, wykonaj, widokDla, cid
};
