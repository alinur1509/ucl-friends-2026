// Shared tournament state, stored as one private JSON blob in Vercel Blob.
// Every write is read-modify-write with an ETag check (ifMatch), retried on
// conflict, so two friends saving at the same moment never overwrite each other.
import { get, put, BlobPreconditionFailedError } from "@vercel/blob";

const PATH = "ucl-2026-27/state.json";
const EMPTY = () => ({ rev: 0, results: {}, ko: {}, cfg: { names: ["", "", "", ""], owner: {}, picks: [], order: [0, 1, 2, 3] }, log: [] });
const CODES = ["PSG","BAY","RMA","LIV","INT","MCI","ARS","BAR","ATM","DOR","ROM","SPO","AVL","POR","MUN","BRU","BET","PSV",
  "FEY","LIL","BOD","NAP","RBL","VIL","FEN","SHK","GAL","SLP","SLO","STU","AEK","LASK","COM","LEN","VIK","SAB"];
const CODE_SET = new Set(CODES);
const MATCH_ID = /^md[1-8]-[A-Z]{3,4}-[A-Z]{3,4}$/;
const KO_IDS = new Set(["F", "SF1", "SF2", "QF1", "QF2", "QF3", "QF4",
  ...Array.from({ length: 8 }, (_, i) => `PO${i + 1}`), ...Array.from({ length: 8 }, (_, i) => `R${i + 1}`)]);

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
  return s;
}

// Short in-memory cache: many friends polling at once cost one storage read per few seconds.
let cache = null; // {state, etag, at}
const CACHE_MS = 4000;

async function readState() {
  // useCache:false — an overwritten blob can be served stale from Blob's cache for up to 60 s;
  // a stale read here made fresh draft picks "disappear" for a few seconds.
  const r = await get(PATH, { access: "private", useCache: false });
  if (!r || r.statusCode !== 200 || !r.stream) return { state: EMPTY(), etag: null };
  const state = await new Response(r.stream).json();
  return { state: normalize(state), etag: r.blob.etag };
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
      const picks = body.picks;
      if (!Array.isArray(picks) || picks.length !== 36 || new Set(picks).size !== 36 || !picks.every(c => CODE_SET.has(c)))
        throw new UserError("Неверное распределение");
      cfg.picks = [...picks]; cfg.owner = {};
      picks.forEach((c, i) => { cfg.owner[c] = cfg.order[i % 4]; });
      log({ k: "draftRandom" });
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
      if (!cache || (state.rev || 0) >= (cache.state.rev || 0)) cache = { state, etag, at: Date.now() };
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
  for (let attempt = 0; attempt < 6; attempt++) {
    let state;
    try {
      const cur = await readState();
      state = cur.state;
      apply(state, body);
      state.rev = (Number.isInteger(state.rev) ? state.rev : 0) + 1;   // monotonically increasing version
      const res = await put(PATH, JSON.stringify(state), {
        access: "private", contentType: "application/json", addRandomSuffix: false,
        allowOverwrite: cur.etag !== null, ...(cur.etag ? { ifMatch: cur.etag } : {}),
      });
      cache = { state, etag: (res && res.etag) || null, at: Date.now() };
      return json(state);
    } catch (e) {
      if (e instanceof UserError) return json({ error: e.message, state }, e.status);
      const conflict = e instanceof BlobPreconditionFailedError || /already exists|precondition/i.test(String(e && e.message));
      if (conflict) { await new Promise(r => setTimeout(r, 60 + Math.random() * 200)); continue; }
      return json({ error: "Не удалось сохранить: " + e.message }, 500);
    }
  }
  return json({ error: "Слишком много одновременных правок, попробуйте ещё раз" }, 409);
}
