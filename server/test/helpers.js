/* Pomocnicy testów integracyjnych serwera stołów.
   Podnosimy PRAWDZIWY serwer w osobnym procesie na losowym porcie i sterujemy nim
   prawdziwymi klientami WebSocket — dokładnie tak, jak robi to aplikacja. */

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const SERVER = path.join(__dirname, '..', 'server.js');

/** Uruchamia serwer na porcie wybranym przez system (PORT=0) i odczytuje faktyczny port z logu. */
function startServer(env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PORT: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let buf = '';
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/porcie (\d+)/);
      if (m) {
        child.stdout.removeListener('data', onData);
        resolve({
          port: Number(m[1]),
          child,
          stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill('SIGKILL'); })
        });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', () => { /* cisza; odkomentuj do debugowania */ });
    child.on('error', reject);
    setTimeout(() => reject(new Error('serwer nie wystartował w czasie')), 5000);
  });
}

/** GET /zdrowie -> { ok, stoly, gracze } */
function health(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/zdrowie' }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pidSeq = 1;
function freshPid(prefix = 'pid') { return prefix + '-' + (pidSeq++) + '-' + process.pid; }

/** Klient testowy: kolejkuje wiadomości i pozwala czekać na konkretny typ/warunek. */
class Player {
  constructor(port, label) {
    this.port = port;
    this.label = label || 'gracz';
    this.pid = null;
    this.inbox = [];
    this.pending = [];
    this.ws = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket('ws://127.0.0.1:' + this.port);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
        this._deliver(m);
      });
    });
  }

  _deliver(m) {
    for (let i = 0; i < this.pending.length; i++) {
      if (this.pending[i].pred(m)) {
        const w = this.pending.splice(i, 1)[0];
        clearTimeout(w.to);
        w.resolve(m);
        return;
      }
    }
    this.inbox.push(m);
  }

  send(obj) { this.ws.send(JSON.stringify(obj)); }

  /** Czeka na wiadomość spełniającą warunek (typ jako string lub predykat). Zużywa ją. */
  waitFor(pred, timeout = 2500) {
    if (typeof pred === 'string') { const t = pred; pred = (m) => m.type === t; }
    for (let i = 0; i < this.inbox.length; i++) {
      if (pred(this.inbox[i])) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      w.to = setTimeout(() => {
        this.pending = this.pending.filter((x) => x !== w);
        reject(new Error(this.label + ': przekroczono czas oczekiwania na wiadomość'));
      }, timeout);
      this.pending.push(w);
    });
  }

  /** Czeka na kolejny roster spełniający warunek (pomija wcześniejsze). */
  async waitRoster(cond, timeout = 2500) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const r = await this.waitFor('roster', Math.max(50, deadline - Date.now()));
      if (!cond || cond(r)) return r;
    }
    throw new Error(this.label + ': nie doczekał się właściwego rostera');
  }

  async hello(pid, name, avatar) {
    this.pid = pid;
    this.send({ type: 'hello', pid, name: name || 'Gracz', avatar: avatar || '🦊' });
    return this.waitFor('welcome');
  }

  /** Twarde zerwanie połączenia (symulacja utraty sieci) — BEZ świadomego wyjścia. */
  drop() {
    return new Promise((resolve) => {
      if (!this.ws) return resolve();
      this.ws.once('close', () => resolve());
      this.ws.terminate();
    });
  }

  close() { try { this.ws.terminate(); } catch (e) {} }
}

module.exports = { startServer, health, sleep, freshPid, Player };
