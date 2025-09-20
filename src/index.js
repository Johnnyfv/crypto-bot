// Telegram crypto converter — Cloudflare Worker
// Commands:
//   /c   <amount> <base> <quote>
//   /cv  <amount> <base> <quote>   (alias of /c)
//   /q   <amount> <base> <quote>   (alias of /c)
//   /help                          (help card)

const nrm = s => String(s ?? "").trim().toLowerCase();
const U   = s => String(s ?? "").trim().toUpperCase();
const now = () => Date.now();
const slog = o => { try { console.log(JSON.stringify(o)); } catch {} };

// Small alias niceties
const ALIAS = { xbt: "btc" };

// -------- number formatting --------
function fmt(n, quote) {
  const x = Number(n), q = nrm(quote);
  if (!isFinite(x)) return String(n);
  if (q === "usdt" || q === "usdc" || q === "dai") {
    if (x >= 1)    return x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (x >= 0.01) return x.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 });
    return x.toFixed(6);
  }
  if (x >= 1) return x.toFixed(6).replace(/\.?0+$/,"");
  return x.toFixed(10).replace(/\.?0+$/,"");
}

// -------- caches & cooldowns --------
const PRICE_CACHE = new Map(); // key -> { t, v }
const TTL = 30_000;
const cd = { binance: 0, kucoin: 0 };
const inCd = k => now() < (cd[k] || 0);
const cool = (k, ms) => { cd[k] = Math.max(cd[k], now() + ms); };
const cget = k => { const e = PRICE_CACHE.get(k); return e && (now() - e.t) < TTL ? e.v : null; };
const cput = (k, v) => PRICE_CACHE.set(k, { t: now(), v });

// -------- price providers (1 BASE in QUOTE) --------
async function binance(base, quote) {
  const symbol = U(base) + U(quote);
  const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`, { headers: { Accept: "application/json" } });
  if (!r.ok) {
    if (r.status === 400 || r.status === 404) { const e = new Error("BINANCE_SYMBOL_MISSING"); e.code = "MISSING"; throw e; }
    throw new Error(`BINANCE_${r.status}`);
  }
  const { price } = await r.json();
  const p = Number(price);
  if (!isFinite(p) || p <= 0) throw new Error("BINANCE_BAD_PRICE");
  return p;
}

async function kucoin(base, quote) {
  const symbol = `${U(base)}-${U(quote)}`;
  const r = await fetch(`https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${symbol}`, { headers: { Accept: "application/json" } });
  if (!r.ok) {
    if (r.status === 400 || r.status === 404) { const e = new Error("KUCOIN_SYMBOL_MISSING"); e.code="MISSING"; throw e; }
    throw new Error(`KUCOIN_${r.status}`);
  }
  const j = await r.json();
  if (j.code !== "200000") throw new Error("KUCOIN_BAD");
  const p = Number(j.data?.price);
  if (!isFinite(p) || p <= 0) throw new Error("KUCOIN_BAD_PRICE");
  return p;
}

async function cc(env, base, quote) {
  const url = `https://min-api.cryptocompare.com/data/price?fsym=${U(base)}&tsyms=${U(quote)}`;
  const headers = { Accept: "application/json" };
  if (env.CRYPTOCOMPARE_KEY) headers.authorization = `Apikey ${env.CRYPTOCOMPARE_KEY}`;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`CC_${r.status}`);
  const j = await r.json();
  const p = Number(j[U(quote)]);
  if (!isFinite(p) || p <= 0) throw new Error("CC_BAD");
  return p;
}

async function coinbase(base, quote) {
  const r = await fetch(`https://api.coinbase.com/v2/exchange-rates?currency=${U(base)}`, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`COINBASE_${r.status}`);
  const j = await r.json();
  const p = Number(j?.data?.rates?.[U(quote)]);
  if (!isFinite(p) || p <= 0) throw new Error("COINBASE_BAD");
  return p;
}

// -------- resolver --------
async function priceBaseInQuote(env, baseIn, quoteIn) {
  let base = nrm(ALIAS[baseIn] || baseIn);
  let quote = nrm(ALIAS[quoteIn] || quoteIn);
  if (!base || !quote) throw new Error("BAD_SYMBOL");
  if (base === quote) return 1;

  const key = `px:${base}:${quote}`;
  const cached = cget(key);
  if (cached) return cached;

  const pivot = "usdt";

  // 1) Binance direct
  if (!inCd("binance")) {
    try { const p = await binance(base, quote); cput(key, p); return p; }
    catch (e) { if (!e?.code) cool("binance", 20_000); }
  }

  // 2) Binance pivot via USDT
  if (!inCd("binance") && base !== pivot && quote !== pivot) {
    try {
      const pB = await binance(base, pivot);
      const pQ = await binance(quote, pivot);
      const p = pB / pQ;
      if (isFinite(p) && p > 0) { cput(key, p); return p; }
    } catch (e) { if (!e?.code) cool("binance", 20_000); }
  }

  // 3) KuCoin direct
  if (!inCd("kucoin")) {
    try { const p = await kucoin(base, quote); cput(key, p); return p; }
    catch (e) { if (!e?.code) cool("kucoin", 20_000); }
  }

  // 4) KuCoin pivot
  if (!inCd("kucoin") && base !== pivot && quote !== pivot) {
    try {
      const pB = await kucoin(base, pivot);
      const pQ = await kucoin(quote, pivot);
      const p = pB / pQ;
      if (isFinite(p) && p > 0) { cput(key, p); return p; }
    } catch (e) { if (!e?.code) cool("kucoin", 20_000); }
  }

  // 5) CryptoCompare direct
  try { const p = await cc(env, base, quote); cput(key, p); return p; } catch {}

  // 6) CryptoCompare pivot
  try {
    const pB = await cc(env, base, pivot);
    const pQ = await cc(env, quote, pivot);
    const p = pB / pQ;
    if (isFinite(p) && p > 0) { cput(key, p); return p; }
  } catch {}

  // 7) Coinbase direct
  try { const p = await coinbase(base, quote); cput(key, p); return p; } catch {}

  // 8) Coinbase invert
  try { const inv = await coinbase(quote, base); const p = 1 / inv; if (isFinite(p) && p > 0) { cput(key, p); return p; } } catch {}

  throw new Error("NO_ROUTE");
}

// -------- Telegram I/O --------
const cooldownByChat = new Map();
const lastMsgHash = new Map();
const inCooldown = id => now() < (cooldownByChat.get(id) || 0);

async function tgSend(env, chatId, text) {
  if (inCooldown(chatId)) return new Response("ok");
  // dedupe identical replies per chat for a few seconds
  const h = `${text.length}:${text.slice(0,64)}`;
  const prev = lastMsgHash.get(chatId), t = now();
  if (prev && prev.h === h && t < prev.until) return new Response("ok");
  lastMsgHash.set(chatId, { h, until: t + 5000 });

  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });

  // simple backoff on TG flood
  if (!r.ok) {
    let retrySec = 2;
    const raw = await r.text().catch(() => "");
    try { const j = JSON.parse(raw); if (j?.parameters?.retry_after) retrySec = Math.max(1, +j.parameters.retry_after); } catch {}
    const m = /retry after (\d+)/i.exec(raw); if (m) retrySec = Math.max(retrySec, parseInt(m[1],10));
    if (r.status === 429) cooldownByChat.set(chatId, now() + retrySec * 1000);
  }
  return new Response("ok");
}

function helpText() {
  return [
    "@CConvertibot — a privacy-driven bot that converts crypto in chat.",
    "",
    "How to use:",
    "/c <amount> <base> <quote>",
    "Examples:",
    "/c 1 btc eth",
    "/c 100 xrp usdc",
    "/c 11 sol shib",
    "",
    "Notes:",
    "• No commas; no currency symbols",
    "• You can write: /c 1 btc to eth   (\"to\"/\"in\"/\"->\" are accepted)",
    "• Works in groups and DMs; does not need admin privileges",
    "• With Privacy Mode ON, if multiple bots exist, you may need to “wake” it once using /c@cconvertibot",
    "",
    "Data sources (auto-fallback): Binance, KuCoin, CryptoCompare, Coinbase.",
    "",
    "Support the bot:",
    "https://cwallet.com/t/1PYNYSIY",
    "",
    "Created by @Johnnyfv"
  ].join("\n");
}

// -------- parsing helpers --------
function parseCommandHead(text) {
  const first = (text.split(/\s+/)[0] || "").toLowerCase();
  const [cmd, at] = first.split("@");
  return { cmd, at };
}

function normalizePairTokens(tokens) {
  // silently drop connectors like "to", "in", "->", unicode arrows
  const drop = /^(to|in|->|→|⇒)$/i;
  return tokens.filter(t => !drop.test(t));
}

// -------- update handler --------
async function handleUpdate(env, upd) {
  const msg = upd.message || upd.edited_message;
  if (!msg || typeof msg.text !== "string") return new Response("ok");

  // privacy-friendly base log (no message text)
  const baseLog = {
    user: { id: msg.from?.id, username: msg.from?.username || null },
    chat: { id: msg.chat?.id, type: msg.chat?.type || null },
    msg:  { id: msg.message_id, date: msg.date, len: msg.text?.length || 0 }
  };

  const text  = msg.text.replace(/\u00A0/g, " ").trim();
  const parts = text.split(/\s+/);
  const { cmd, at } = parseCommandHead(text);

  // Respect "@bot" mention if present
  if (at && env.BOT_USERNAME && at !== env.BOT_USERNAME.toLowerCase()) {
    slog({ ...baseLog, event: "ignored_not_our_mention" });
    return new Response("ok");
  }

  // /help
  if (cmd === "/help") {
    slog({ ...baseLog, event: "help" });
    return tgSend(env, msg.chat.id, helpText());
  }

  // Bare triggers (/c, /cv, /q with no args) → short ready message
  if ((cmd === "/c" || cmd === "/cv" || cmd === "/q") && parts.length === 1) {
    slog({ ...baseLog, event: "ready_prompt", cmd });
    return tgSend(env, msg.chat.id, "Ready. Type /help for instructions");
  }

  // Converters
  if (cmd === "/c" || cmd === "/cv" || cmd === "/q") {
    if (parts.length < 2) {
      slog({ ...baseLog, event: "usage_prompt", cmd });
      return tgSend(env, msg.chat.id, helpText());
    }

    // amount
    const amtStr = parts[1];
    if (/,/.test(amtStr)) { slog({ ...baseLog, event: "reject_commas", cmd }); return tgSend(env, msg.chat.id, "No commas in the amount, please."); }
    const amt = Number(amtStr);
    if (!isFinite(amt) || amt <= 0) { slog({ ...baseLog, event: "invalid_amount", cmd }); return tgSend(env, msg.chat.id, "Invalid amount."); }

    // base/quote (with silent connectors allowed)
    const pairTokens = normalizePairTokens(parts.slice(2));
    if (pairTokens.length < 2) {
      slog({ ...baseLog, event: "bad_arity_pair", cmd });
      return tgSend(env, msg.chat.id, "Format: /c <amount> <base> <quote>  (e.g., /c 2 btc usdt)");
    }

    const base = nrm(ALIAS[pairTokens[0]] || pairTokens[0]);
    const quote = nrm(ALIAS[pairTokens[1]] || pairTokens[1]);

    try {
      const px = await priceBaseInQuote(env, base, quote);
      const total = amt * px;
      const body =
        `${fmt(amt, base)} ${U(base)} ≈ ${fmt(total, quote)} ${U(quote)}\n` +
        `(1 ${U(base)} = ${fmt(px, quote)} ${U(quote)})`;

      slog({ ...baseLog, event: "convert_ok", cmd, base, quote }); // no amount/rate in logs
      return tgSend(env, msg.chat.id, body);
    } catch (e) {
      const em = String(e && e.message || e);
      let userMsg = "Price providers are busy. Please try again in a moment.";
      let errCode = "PROVIDER_BUSY";
      if (em.includes("BAD_SYMBOL")) { userMsg = "Unknown symbol. Try common tickers (btc, eth, usdt, sol, etc.)."; errCode = "BAD_SYMBOL"; }
      else if (em.includes("NO_ROUTE")) { userMsg = "No price available for that pair right now. Try again, reverse the pair, or use USDT/USDC as the quote."; errCode = "NO_ROUTE"; }
      slog({ ...baseLog, event: "convert_error", cmd, base, quote, error: errCode });
      return tgSend(env, msg.chat.id, userMsg);
    }
  }

  // Ignore everything else (saves quota; good for Privacy Mode OFF too)
  slog({ ...baseLog, event: "ignored_non_command" });
  return new Response("ok");
}

// -------- worker entry --------
export default {
  async fetch(request, env) {
    if (request.method === "POST") {
      // Optional webhook secret check
      const given = request.headers.get("x-telegram-bot-api-secret-token");
      if (env.WEBHOOK_SECRET && given !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const update = await request.json().catch(() => ({}));
      return handleUpdate(env, update);
    }
    return new Response("OK");
  }
};
