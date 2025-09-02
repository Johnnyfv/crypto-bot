// Telegram /c converter — Cloudflare Worker
// Usage: /c <amount> <base> <quote>
// Examples: /c 2 btc usdt  |  /c 1.5 sol eth

// ======================= Utils & Config =======================
function nrm(s) { return String(s ?? "").toLowerCase().trim(); }
function upper(s) { return String(s ?? "").toUpperCase().trim(); }
const now = () => Date.now();

// Small optional alias map (helps with odd tickers / synonyms).
const ALIAS = {
  xbt: "btc",
  wif: "wif",
  pepe: "pepe",
  shib: "shib",
  doge: "doge",
  usdt: "usdt",
  usdc: "usdc",
  dai:  "dai",
};

// Simple number formatting: quote is a symbol (e.g., usdt/usdc/eth)
function fmt(num, quote) {
  const x = Number(num);
  const q = nrm(quote);
  if (!isFinite(x)) return String(num);
  if (q === "usdt" || q === "usdc" || q === "dai") {
    if (x >= 1) return x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (x >= 0.01) return x.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 });
    return x.toFixed(6);
  }
  if (x >= 1) return x.toFixed(6).replace(/\.?0+$/,"");
  return x.toFixed(10).replace(/\.?0+$/,"");
}

// ======================= Anti-flood & Dedupe =======================
const seenUpdates = new Map();          // update_id -> until
const seenMessages = new Map();         // "chat:msg" -> until
const lastByChat = new Map();           // chat_id -> last ts
const lastByUser = new Map();           // user_id -> last ts
const cooldownByChat = new Map();       // chat_id -> until ts
const lastReplyHashByChat = new Map();  // chat_id -> {hash, until}

function mark(map, key, ttlMs) { map.set(key, now() + ttlMs); }
function isMarked(map, key) { return now() < (map.get(key) || 0); }
function tooSoon(map, key, windowMs) {
  const t = now(), last = map.get(key) || 0;
  if (t - last < windowMs) return true;
  map.set(key, t);
  return false;
}
const inCooldown = id => now() < (cooldownByChat.get(id) || 0);
function sameReplyRecently(chatId, text, ttlMs = 5000) {
  const t = now();
  const hash = `${text.length}:${text.slice(0,64)}`;
  const prev = lastReplyHashByChat.get(chatId);
  if (prev && prev.hash === hash && t < prev.until) return true;
  lastReplyHashByChat.set(chatId, { hash, until: t + ttlMs });
  return false;
}

// ======================= Price Providers =======================
// Binance (primary). Rotate hosts, return price of 1 BASE in QUOTE (e.g., BTC/USDT).
async function binancePrice(base, quote) {
  const symbol = (upper(base) + upper(quote));
  const hosts = [
    "https://api.binance.com",
    "https://api1.binance.com",
    "https://api2.binance.com"
  ];
  let lastErr;
  for (const h of hosts) {
    try {
      const r = await fetch(`${h}/api/v3/ticker/price?symbol=${symbol}`, { headers: { "Accept": "application/json" } });
      if (!r.ok) {
        if (r.status === 400 || r.status === 404) {
          const err = new Error(`binance ${symbol} ${r.status}`);
          err.code = "SYMBOL_MISSING";
          throw err;
        }
        lastErr = new Error(`binance host ${h} ${r.status}`);
        continue;
      }
      const j = await r.json();
      const p = Number(j.price);
      if (!isFinite(p) || p <= 0) throw new Error("binance bad price");
      return p;
    } catch (e) {
      lastErr = e;
      continue;
    }
  }
  throw lastErr || new Error("binance failed");
}

// KuCoin Level1 (public, no key). Symbol like BTC-USDT. Returns price of 1 BASE in QUOTE.
async function kucoinPrice(base, quote) {
  const symbol = `${upper(base)}-${upper(quote)}`;
  const r = await fetch(`https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${symbol}`, {
    headers: { "Accept": "application/json" }
  });
  if (!r.ok) {
    if (r.status === 404 || r.status === 400) {
      const err = new Error(`kucoin ${symbol} ${r.status}`);
      err.code = "SYMBOL_MISSING";
      throw err;
    }
    throw new Error(`kucoin ${symbol} ${r.status}`);
  }
  const j = await r.json();
  if (!j || j.code !== "200000" || !j.data) throw new Error("kucoin bad json");
  const p = Number(j.data.price);
  if (!isFinite(p) || p <= 0) throw new Error("kucoin bad price");
  return p;
}

// CryptoCompare (fallback). Returns price of 1 BASE in QUOTE.
async function ccPrice(env, base, quote) {
  const url = `https://min-api.cryptocompare.com/data/price?fsym=${upper(base)}&tsyms=${upper(quote)}`;
  const headers = { "Accept": "application/json" };
  if (env.CRYPTOCOMPARE_KEY) headers["authorization"] = `Apikey ${env.CRYPTOCOMPARE_KEY}`;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`cc ${r.status}`);
  const j = await r.json();
  const p = Number(j[upper(quote)]);
  if (!isFinite(p) || p <= 0) throw new Error("cc bad price");
  return p;
}

// Tiny in-memory cache & Binance cooldown
const PRICE_CACHE = new Map(); // key -> { t, v }
const PRICE_TTL_MS = 30_000;
let BINANCE_COOLDOWN_UNTIL = 0;
const inBinanceCooldown = () => now() < BINANCE_COOLDOWN_UNTIL;
const coolBinance = ms => { BINANCE_COOLDOWN_UNTIL = Math.max(BINANCE_COOLDOWN_UNTIL, now() + ms); };
function cacheGet(key) { const e = PRICE_CACHE.get(key); return e && (now() - e.t) < PRICE_TTL_MS ? e.v : null; }
function cachePut(key, v) { PRICE_CACHE.set(key, { t: now(), v }); }

// Core: get price of 1 BASE in QUOTE, trying direct, then pivot via USDT, then fallbacks.
async function getPriceBaseQuote(env, base, quote) {
  base = nrm(ALIAS[base] || base);
  quote = nrm(ALIAS[quote] || quote);

  const key = `px:${base}:${quote}`;
  const c = cacheGet(key);
  if (c) return c;

  // 1) Binance direct (rotating hosts) unless cooling
  if (!inBinanceCooldown()) {
    try {
      const p = await binancePrice(base, quote);
      cachePut(key, p); return p;
    } catch (e) {
      if (!(e && e.code === "SYMBOL_MISSING")) coolBinance(20_000);
    }
  }

  // 2) Binance pivot via USDT
  const pivot = "usdt";
  if (base !== pivot && quote !== pivot && !inBinanceCooldown()) {
    try {
      const pBase = await binancePrice(base, pivot);
      const pQuote = await binancePrice(quote, pivot);
      if (isFinite(pBase) && isFinite(pQuote) && pBase > 0 && pQuote > 0) {
        const rate = pBase / pQuote;
        cachePut(key, rate); return rate;
      }
    } catch (e) {
      if (!(e && e.code === "SYMBOL_MISSING")) coolBinance(20_000);
    }
  }

  // 2.5) KuCoin direct
  try {
    const p = await kucoinPrice(base, quote);
    cachePut(key, p); return p;
  } catch {}

  // 2.6) KuCoin pivot via USDT
  try {
    if (base !== pivot && quote !== pivot) {
      const pBase = await kucoinPrice(base, pivot);
      const pQuote = await kucoinPrice(quote, pivot);
      if (isFinite(pBase) && isFinite(pQuote) && pBase > 0 && pQuote > 0) {
        const rate = pBase / pQuote;
        cachePut(key, rate); return rate;
      }
    }
  } catch {}

  // 3) CryptoCompare direct
  try {
    const p = await ccPrice(env, base, quote);
    cachePut(key, p); return p;
  } catch {}

  // 4) CryptoCompare pivot via USDT
  try {
    const pBase = await ccPrice(env, base, pivot);
    const pQuote = await ccPrice(env, quote, pivot);
    const rate = pBase / pQuote;
    if (isFinite(rate) && rate > 0) { cachePut(key, rate); return rate; }
  } catch {}

  throw new Error("no price route");
}

// ======================= Telegram I/O =======================
async function tgReply(env, chatId, text) {
  if (inCooldown(chatId)) return new Response("ok");
  if (sameReplyRecently(chatId, text)) return new Response("ok");

  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = { chat_id: chatId, text };

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    const raw = await r.text().catch(() => "");
    let retrySec = 2;
    try {
      const err = JSON.parse(raw);
      if (err?.parameters?.retry_after) retrySec = Math.max(1, +err.parameters.retry_after);
    } catch {}
    const m = /retry after (\d+)/i.exec(raw);
    if (m) retrySec = Math.max(retrySec, parseInt(m[1], 10));

    if (r.status === 429) {
      cooldownByChat.set(chatId, now() + retrySec * 1000);
      console.log("sendMessage 429; cooling chat", chatId, "for", retrySec, "s");
      return new Response("ok");
    }
    console.log("sendMessage failed", r.status, raw.slice(0, 300));
  } else {
    const j = await r.json().catch(() => null);
    if (!j?.ok) console.log("sendMessage JSON not ok", j);
  }
  return new Response("ok");
}

// ======================= Update Handler =======================
async function handleTelegramUpdate(env, update) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return new Response("ok");

  // Idempotency / dedupe (60s window)
  if (typeof update.update_id === "number") {
    if (isMarked(seenUpdates, update.update_id)) return new Response("ok");
    mark(seenUpdates, update.update_id, 60_000);
  }
  const msgKey = `${msg.chat.id}:${msg.message_id}`;
  if (isMarked(seenMessages, msgKey)) return new Response("ok");
  mark(seenMessages, msgKey, 60_000);

  // Anti-flood
  if (inCooldown(msg.chat.id)) return new Response("ok");
  if (tooSoon(lastByChat, msg.chat.id, 350)) return new Response("ok");
  if (msg.from && tooSoon(lastByUser, msg.from.id, 700)) return new Response("ok");

  // Parse command
  const raw = msg.text.trim().replace(/\u00A0/g, " ");
  const parts = raw.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  // Accept /c or /c@YourBot
  if (!cmd.startsWith("/c")) return new Response("ok");
  const mention = (cmd.split("@")[1] || "").toLowerCase();
  if (mention && env.BOT_USERNAME && mention !== env.BOT_USERNAME.toLowerCase()) {
    return new Response("ok");
  }

  // Help if not enough args
  if (parts.length < 4) {
    return await tgReply(
      env,
      msg.chat.id,
      "Usage:\n\n/c <amount> <base coin> <quote coin>\n\nExamples:\n/c 1 btc usdt\n/c 5 eth btc\n/c 10 sol usdc\n\nNotes:\n• No commas in the amount\n• Works in groups and DMs"
    );
  }

  // No-commas rule + amount parse
  const amtStr = parts[1];
  if (/,/.test(amtStr)) return new Response("ok");
  const amt = Number(amtStr);
  if (!isFinite(amt) || amt <= 0) {
    return await tgReply(env, msg.chat.id, "Invalid amount.");
  }

  // Symbols (apply aliases)
  const base = nrm(ALIAS[parts[2]] || parts[2]);
  const quote = nrm(ALIAS[parts[3]] || parts[3]);

  try {
    // price of 1 BASE in QUOTE
    const px = await getPriceBaseQuote(env, base, quote);
    const total = amt * px;

    const body =
      `${amt} ${upper(base)} ≈ ${fmt(total, quote)} ${upper(quote)}\n` +
      `(1 ${upper(base)} = ${fmt(px, quote)} ${upper(quote)})`;

    return await tgReply(env, msg.chat.id, body);
  } catch (e) {
    console.log("conversion error:", String(e));
    return await tgReply(env, msg.chat.id, "Price service is busy. Try again.");
  }
}

// ======================= Worker Entry =======================
export default {
  async fetch(request, env) {
    if (!env.TELEGRAM_BOT_TOKEN) {
      return new Response("Missing TELEGRAM_BOT_TOKEN", { status: 500 });
    }

    if (request.method === "POST") {
      // Optional webhook secret check
      const given = request.headers.get("x-telegram-bot-api-secret-token");
      if (env.WEBHOOK_SECRET && given !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const update = await request.json();
      return await handleTelegramUpdate(env, update);
    }

    return new Response("Telegram /c bot is running.");
  }
};
