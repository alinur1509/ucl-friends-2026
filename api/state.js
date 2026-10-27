// Shared tournament state, stored as one private JSON blob in Vercel Blob.
// Every write is read-modify-write with an ETag check (ifMatch), retried on
// conflict, so two friends saving at the same moment never overwrite each other.
import { get, head, put, BlobPreconditionFailedError } from "@vercel/blob";

const PATH = "ucl-2026-27/state.json";
const EMPTY = () => ({ rev: 0, results: {}, ko: {}, cards: {}, cfg: { names: ["", "", "", ""], owner: {}, picks: [], order: [0, 1, 2, 3] }, log: [] });
const CODES = ["PSG","BAY","RMA","LIV","INT","MCI","ARS","BAR","ATM","DOR","ROM","SPO","AVL","POR","MUN","BRU","BET","PSV",
  "FEY","LIL","BOD","NAP","RBL","VIL","FEN","SHK","GAL","SLP","SLO","STU","AEK","LASK","COM","LEN","VIK","SAB"];
const CODE_SET = new Set(CODES);
// League-phase pairings (official draw) — used by the draft rule "you can't take an opponent of your own club".
const PAIRS = `AEK-LASK BRU-AVL DOR-VIL POR-MCI LIL-BET RMA-INT BAR-FEY STU-VIK LIV-ATM PSG-SLO SPO-GAL NAP-ARS
FEN-ROM PSV-SHK COM-RBL BAY-BOD MUN-SAB SLP-LEN LEN-SPO SAB-SLP ARS-LIL ATM-MUN INT-BRU GAL-BAR
RBL-PSV VIK-BAY VIL-NAP FEY-COM LASK-LIV ROM-RMA AVL-FEN SHK-AEK BOD-DOR MCI-PSG BET-POR SLO-STU
FEN-SLP SAB-DOR ROM-SLO POR-PSV LIV-VIL MCI-AEK PSG-BAR NAP-BOD STU-ATM COM-MUN LIL-GAL AVL-VIK
BRU-LEN BAY-ARS INT-SHK RMA-RBL BET-FEY SPO-LASK SHK-SPO GAL-STU ATM-BAY BAR-AVL FEY-INT BOD-LIL
LASK-SLO MUN-ROM VIL-PSG AEK-RMA FEN-LIV DOR-BET POR-NAP PSV-BRU RBL-MCI LEN-COM SLP-ARS VIK-SAB
BOD-LASK GAL-AVL ARS-DOR COM-AEK FEY-POR MCI-NAP RBL-LEN RMA-PSV SLO-BET SAB-BAR SLP-VIL ATM-VIK
BRU-LIV INT-STU SHK-FEN LIL-BAY PSG-ROM SPO-MUN VIK-FEY VIL-SAB AEK-GAL ROM-SPO AVL-PSG BAR-MCI
BAY-SLP MUN-RBL NAP-BRU BET-COM SLO-SHK ARS-RMA DOR-INT LASK-FEN LIV-POR PSV-ATM LEN-BOD STU-LIL
BOD-ATM GAL-FEY AEK-ROM AVL-DOR INT-LIV POR-SLP LIL-SLO RMA-LASK STU-BRU FEN-VIL SAB-NAP COM-PSG
MUN-BAY RBL-SHK LEN-MCI BET-ARS SPO-BAR VIK-PSV ARS-SAB ROM-LIL ATM-FEN DOR-AEK BRU-BOD BAY-BET
BAR-COM SHK-RMA FEY-RBL LASK-POR LIV-LEN MCI-SPO PSG-GAL PSV-STU SLP-AVL NAP-VIK VIL-MUN SLO-INT`;
const OPP = {};
CODES.forEach(c => { OPP[c] = new Set(); });
PAIRS.split(/\s+/).forEach(x => { const [h, a] = x.split("-"); OPP[h].add(a); OPP[a].add(h); });
// Draft rules for the player on turn:
// 1) opponents of clubs they already own are blocked;
// 2) pots go in order: pick from the first pot that has a non-blocked free club;
// 3) if no pot has one, any free club from the lowest pot that still has free clubs.
const POT_OF = c => Math.floor(CODES.indexOf(c) / 9);
function draftOptions(owner, p) {
  const free = CODES.filter(c => ![0, 1, 2, 3].includes(owner[c]));
  const blocked = new Set();
  CODES.forEach(c => { if (owner[c] === p) OPP[c].forEach(o => blocked.add(o)); });
  const open = free.filter(c => !blocked.has(c));
  const fallback = open.length === 0;
  const base = fallback ? free : open;
  const pot = base.length ? Math.min(...base.map(POT_OF)) : -1;
  const allowed = base.filter(c => POT_OF(c) === pot);
  return { free, blocked, allowed, pot, fallback };
}
const MATCH_ID = /^md[1-8]-[A-Z]{3,4}-[A-Z]{3,4}$/;
const KO_IDS = new Set(["F", "SF1", "SF2", "QF1", "QF2", "QF3", "QF4",
  ...Array.from({ length: 8 }, (_, i) => `PO${i + 1}`), ...Array.from({ length: 8 }, (_, i) => `R${i + 1}`)]);

const KO_MATCH = /^ko:(PO[1-8]|R[1-8]|QF[1-4]|SF[12]|F):[12]$/;
const CARD_TYPES = new Set(["Y", "YR", "R"]);   // yellow, second yellow (sending-off), straight red

class UserError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const goal = v => (Number.isInteger(v) && v >= 0 && v <= 99 ? v : null);
const isPerm = o => Array.isArray(o) && o.length === 4 && [0, 1, 2, 3].every(i => o.includes(i));

function normalize(state) {
  const s = { ...EMPTY(), ...state };
  s.cfg = { ...EMPTY().cfg, ...(state.cfg || {}) };
  if (!Array.isArray(s.cfg.picks)) s.cfg.picks = [];
  if (!isPerm(s.cfg.order)) s.cfg.order = [0, 1, 2, 3];
  if (!s.cards || typeof s.cards !== "object" || Array.isArray(s.cards)) s.cards = {};
  return s;
}

// Short in-memory cache: many friends polling at once cost one storage read per few seconds.
let cache = null; // {state, etag, at}
const CACHE_MS = 4000;
// Newest version this instance knows for sure (it wrote it itself), with the etag returned by put().
// Blob storage can keep answering with the previous version for a moment after an overwrite;
// when that happens we continue from this copy instead of the stale read.
let latest = null; // {state, etag}
const revOf = s => (s && Number.isInteger(s.rev) ? s.rev : 0);

const normTag = t => String(t || "").replace(/^W\//, "").replace(/"/g, "");

// Content comes from get(useCache:false); the etag used for ifMatch comes from head(), as in the
// Vercel docs — the etag reported by get() did not match on put() and every save was rejected.
// If the content we got is not the version head() reports, the read is stale: `fresh` is false
// and the caller waits instead of writing on top of old data.
async function readState() {
  const [h, r] = await Promise.all([
    head(PATH).catch(e => (e && /not.?found/i.test(e.name + " " + e.message) ? null : Promise.reject(e))),
    get(PATH, { access: "private", useCache: false }),
  ]);
  if (!h || !r || r.statusCode !== 200 || !r.stream) return { state: EMPTY(), etag: null, fresh: !h, dbg: "empty" };
  const state = normalize(await new Response(r.stream).json());
  const fresh = normTag(h.etag) === normTag(r.blob.etag);
  const dbg = `head=${h.etag} get=${r.blob.etag}`;
  if (latest && normTag(latest.etag) === normTag(h.etag)) return { state: structuredClone(latest.state), etag: h.etag, fresh: true, dbg };
  return { state, etag: h.etag, fresh, dbg };
}

function apply(state, body) {
  const t = new Date().toISOString();
  const cfg = state.cfg;
  const log = e => { state.log = [{ t, ...e }, ...(state.log || [])].slice(0, 80); };
  const countOf = p => Object.values(cfg.owner).filter(v => v === p).length;
  switch (body.op) {
    case "match": {
      if (!MATCH_ID.test(body.id)) throw new UserError("Неизвестный матч");
      const h = goal(body.h), a = goal(body.a);
      if (h === null && a === null) { delete state.results[body.id]; log({ k: "match-del", id: body.id }); }
      else if (h !== null && a !== null) { state.results[body.id] = { h, a }; log({ k: "match", id: body.id, h, a }); }
      else throw new UserError("Нужно заполнить обе клетки счёта");
      return;
    }
    case "ko": {
      if (!KO_IDS.has(body.id)) throw new UserError("Неизвестная пара плей-офф");
      const d = body.doc || {};
      if (!CODE_SET.has(d.a) || !CODE_SET.has(d.b)) throw new UserError("Неизвестные команды");
      const leg = l => ({ hi: goal(l && l.hi), lo: goal(l && l.lo) });
      state.ko[body.id] = { a: d.a, b: d.b, l1: leg(d.l1), l2: leg(d.l2), pen: d.pen === "hi" || d.pen === "lo" ? d.pen : null };
      log({ k: "ko", id: body.id, a: d.a, b: d.b });
      return;
    }
    case "name": {
      if (![0, 1, 2, 3].includes(body.i)) throw new UserError("Неизвестный участник");
      cfg.names[body.i] = String(body.name || "").trim().slice(0, 24);
      return;
    }
    // ---- draft: picks in turn, order[0] → order[1] → order[2] → order[3] → order[0] …
    case "pick": {
      const n = cfg.picks.length;
      if (body.n !== n) throw new UserError("Пока вы выбирали, кто-то уже сделал ход — страница обновится", 409);
      if (n >= 36) throw new UserError("Жеребьёвка уже завершена", 409);
      if (!CODE_SET.has(body.code)) throw new UserError("Неизвестная команда");
      if ([0, 1, 2, 3].includes(cfg.owner[body.code])) throw new UserError("Эту команду уже забрали", 409);
      const p = cfg.order[n % 4];
      if (countOf(p) >= 9) throw new UserError("У этого участника уже 9 команд", 409);
      const opt = draftOptions(cfg.owner, p);
      if (!opt.allowed.includes(body.code)) {
        if (!opt.fallback && opt.blocked.has(body.code)) {
          const mine = CODES.filter(c => cfg.owner[c] === p && OPP[c].has(body.code));
          throw new UserError(`Нельзя: эта команда играет с вашей (${mine.join(", ")}). Выберите другую`, 409);
        }
        throw new UserError(`Сейчас выбор из корзины ${opt.pot + 1}`, 409);
      }
      cfg.picks.push(body.code); cfg.owner[body.code] = p;
      log({ k: "pick", code: body.code, p, n: n + 1 });
      return;
    }
    case "undo": {
      const n = cfg.picks.length;
      if (body.n !== n || n === 0) throw new UserError("Нечего отменять или ход уже изменился — страница обновится", 409);
      const code = cfg.picks.pop(); cfg.owner[code] = -1;
      log({ k: "undo", code, n });
      return;
    }
    case "draftReset": {
      const code = process.env.DRAFT_RESET_CODE;
      if (!code) throw new UserError("Код сброса не настроен на сервере", 409);
      if (String(body.code || "").trim() !== code) throw new UserError("Неверный код сброса", 403);
      cfg.owner = {}; cfg.picks = [];
      log({ k: "draftReset" });
      return;
    }
    case "order": {
      if (!isPerm(body.order)) throw new UserError("Неверный порядок");
      if (cfg.picks.length) throw new UserError("Порядок можно менять только до первого выбора", 409);
      cfg.order = body.order;
      return;
    }
    case "draftRandom": {
      if (cfg.picks.length) throw new UserError("Раздать случайно можно только до первого выбора", 409);
      const picks = body.picks;
      if (!Array.isArray(picks) || picks.length !== 36 || new Set(picks).size !== 36 || !picks.every(c => CODE_SET.has(c)))
        throw new UserError("Неверное распределение");
      const owner = {};
      picks.forEach((c, i) => {
        const p = cfg.order[i % 4], opt = draftOptions(owner, p);
        if (!opt.allowed.includes(c)) throw new UserError("Случайная раздача нарушает правила жеребьёвки — попробуйте ещё раз");
        owner[c] = p;
      });
      cfg.picks = [...picks]; cfg.owner = owner;
      log({ k: "draftRandom" });
      return;
    }
    // ---- discipline: one document per card
    case "card": {
      const c = body.card || {};
      if (!CODE_SET.has(c.team)) throw new UserError("Неизвестная команда");
      if (!(MATCH_ID.test(c.match) || KO_MATCH.test(c.match))) throw new UserError("Неизвестный матч");
      if (!CARD_TYPES.has(c.type)) throw new UserError("Неизвестный тип карточки");
      const pl = String(c.pl || "").trim().replace(/\s+/g, " ").slice(0, 40);
      if (!pl) throw new UserError("Впишите имя игрока");
      const games = c.type === "R" ? Math.min(10, Math.max(1, Number.isInteger(c.games) ? c.games : 1)) : 1;
      if (Object.keys(state.cards).length >= 2000) throw new UserError("Слишком много карточек", 409);
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      state.cards[id] = { team: c.team, pl, match: c.match, type: c.type, games, t };
      log({ k: "card", team: c.team, pl, match: c.match, type: c.type });
      return;
    }
    case "cardDel": {
      const c = state.cards[body.id];
      if (!c) throw new UserError("Карточка уже удалена", 409);
      delete state.cards[body.id];
      log({ k: "cardDel", team: c.team, pl: c.pl, type: c.type });
      return;
    }
    default: throw new UserError("Неизвестное действие");
  }
}

export async function GET() {
  try {
    if (!cache || Date.now() - cache.at > CACHE_MS) {
      const { state, etag } = await readState();
      // never let this instance's cache go backwards
      if (!cache || revOf(state) >= revOf(cache.state)) cache = { state, etag, at: Date.now() };
      else cache.at = Date.now();
    }
    return json(cache.state);
  } catch (e) {
    return json({ error: "Не удалось прочитать данные: " + e.message }, 500);
  }
}

export async function POST(request) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Неверный запрос" }, 400); }
  let lastErr = "";
  const waits = [150, 300, 600, 1000, 1500, 2000, 2500, 3000];   // ~11 s in total
  for (let attempt = 0; attempt <= waits.length; attempt++) {
    let state;
    try {
      const cur = await readState();
      state = cur.state;
      lastErr = cur.dbg;
      if (!cur.fresh) {   // storage still serves an older copy — wait for it rather than overwrite newer data
        if (attempt < waits.length) { await new Promise(r => setTimeout(r, waits[attempt])); continue; }
        break;
      }
      apply(state, body);
      state.rev = (Number.isInteger(state.rev) ? state.rev : 0) + 1;   // monotonically increasing version
      const res = await put(PATH, JSON.stringify(state), {
        access: "private", contentType: "application/json", addRandomSuffix: false,
        allowOverwrite: cur.etag !== null, ...(cur.etag ? { ifMatch: cur.etag } : {}),
      });
      const etag = (res && res.etag) || null;
      latest = { state: structuredClone(state), etag };
      cache = { state, etag, at: Date.now() };
      return json(state);
    } catch (e) {
      if (e instanceof UserError) return json({ error: e.message, state }, e.status);
      const conflict = e instanceof BlobPreconditionFailedError || /already exists|precondition/i.test(String(e && e.message));
      lastErr = `${e && e.name}: ${e && e.message} (${lastErr})`;
      if (conflict && attempt < waits.length) { latest = null; await new Promise(r => setTimeout(r, waits[attempt] + Math.random() * 150)); continue; }
      if (conflict) break;
      return json({ error: "Не удалось сохранить: " + e.message }, 500);
    }
  }
  console.error("save gave up after retries:", body && body.op, lastErr);
  return json({ error: "Сервер не смог сохранить — попробуйте ещё раз через пару секунд", detail: lastErr }, 409);
}
