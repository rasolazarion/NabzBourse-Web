import express from "express";

const app = express();
const PORT = process.env.PORT || 10000;
const APIS = [
  "https://cdn.tsetmc.com/api",
  "https://cdn10.tsetmc.com/api",
  "http://cdn.tsetmc.com/api"
];
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "https://nabzbourse-web.onrender.com";

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || origin === FRONTEND_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", origin || FRONTEND_ORIGIN);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const cache = new Map();

async function tse(path) {
  let lastError;
  for (const base of APIS) {
    try {
      const response = await fetch(`${base}/${path}`, {
        method: "GET",
        redirect: "follow",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://www.tsetmc.com/",
          "Origin": "https://www.tsetmc.com"
        },
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) throw new Error(`${base} returned HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`تمام نشانی‌های TSETMC ناموفق بودند: ${lastError?.message || "unknown fetch error"}`);
}

function unwrap(data, key) {
  return data?.[key] ?? data?.[key[0].toLowerCase() + key.slice(1)] ?? null;
}
function cached(key, seconds, task) {
  const old = cache.get(key);
  if (old && Date.now() - old.at < seconds * 1000) return Promise.resolve(old.value);
  return task().then(value => {
    cache.set(key, { at: Date.now(), value });
    return value;
  });
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "nabz-bourse-api" }));

app.get("/api/search", async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 40);
  if (!q) return res.status(400).json({ error: "پارامتر q الزامی است" });
  try {
    const rows = await cached(`search:${q}`, 300, async () => {
      const raw = await tse(`Instrument/GetInstrumentSearch/${encodeURIComponent(q)}`);
      const list = unwrap(raw, "instrumentSearch");
      if (!Array.isArray(list)) throw new Error("ساختار پاسخ جست‌وجوی TSETMC ناشناخته است");
      return list.slice(0, 12).map(x => ({
        symbol: x.lVal18AFC || x.lVal30 || q,
        name: x.lVal30 || "",
        insCode: String(x.insCode || ""),
        market: x.flowTitle || ""
      })).filter(x => x.insCode);
    });
    res.json({ source: "TSETMC", results: rows });
  } catch (e) {
    res.status(502).json({ error: "دریافت فهرست نماد از TSETMC ناموفق بود", detail: e.message });
  }
});

app.get("/api/quote/:symbol", async (req, res) => {
  const symbol = String(req.params.symbol || "").trim().slice(0, 40);
  if (!symbol) return res.status(400).json({ error: "نماد نامعتبر است" });
  try {
    const result = await cached(`quote:${symbol}`, 15, async () => {
      const sr = await tse(`Instrument/GetInstrumentSearch/${encodeURIComponent(symbol)}`);
      const matches = unwrap(sr, "instrumentSearch");
      if (!Array.isArray(matches) || !matches.length) throw new Error(`نماد «${symbol}» در TSETMC پیدا نشد`);
      const exact = matches.find(x => x.lVal18AFC === symbol) || matches[0];
      const code = String(exact.insCode || "");
      if (!code) throw new Error("کد معاملاتی نماد در پاسخ TSETMC وجود ندارد");

      const [priceRaw, clientRaw, infoRaw] = await Promise.all([
        tse(`ClosingPrice/GetClosingPriceInfo/${code}`).catch(() => null),
        tse(`ClientType/GetClientType/${code}/1/0`).catch(() => null),
        tse(`Instrument/GetInstrumentInfo/${code}`).catch(() => null)
      ]);
      const p = unwrap(priceRaw || {}, "closingPriceInfo") || {};
      const c = unwrap(clientRaw || {}, "clientType") || {};
      const info = unwrap(infoRaw || {}, "instrumentInfo") || {};

      const buyI = num(c.buy_I_Volume), sellI = num(c.sell_I_Volume);
      const buyN = num(c.buy_N_Volume), sellN = num(c.sell_N_Volume);
      const buyCountI = num(c.buy_CountI), sellCountI = num(c.sell_CountI);
      const last = num(p.pDrCotVal), close = num(p.pClosing), yesterday = num(p.priceYesterday);
      const changePct = (close !== null && yesterday) ? ((close - yesterday) / yesterday) * 100 : null;
      const netReal = (buyI !== null && sellI !== null) ? buyI - sellI : null;
      const buyerPower = (buyI !== null && sellI !== null && buyCountI && sellCountI)
        ? (buyI / buyCountI) / (sellI / sellCountI) : null;

      return {
        source: "TSETMC",
        symbol: exact.lVal18AFC || symbol,
        name: exact.lVal30 || "",
        insCode: code,
        updatedAt: new Date().toISOString(),
        price: {
          last, close, first: num(p.priceFirst), high: num(p.priceMax),
          low: num(p.priceMin), yesterday, changePct,
          marketCap: num(p.qTotCap), volume: num(p.qTotTran5J), value: num(p.qTotCap), trades: num(p.zTotTran),
          averageVolume5d: num(info.qTotTran5JAvg), freeFloat: num(info.kAjCapValCpsIdx)
        },
        clients: {
          buyIndividual: buyI, buyLegal: buyN, sellIndividual: sellI, sellLegal: sellN,
          buyersIndividual: buyCountI, sellersIndividual: sellCountI,
          buyersLegal: num(c.buy_CountN), sellersLegal: num(c.sell_CountN),
          netIndividualVolume: netReal, buyerPower
        }
      };
    });
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: "دریافت اطلاعات نماد از TSETMC ناموفق بود", detail: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Nabz Bourse API listening on ${PORT}`);
});
