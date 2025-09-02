// Telegram Crypto Convert Bot (Webhook) — Cloudflare Workers
// Trigger: /c <amount> <coin1> <coin2>
// Examples: /c 2 btc usd   |   /c 0.5 eth btc

// --------- config / constants ----------
const FIAT = new Set([
  "usd","eur","gbp","jpy","cny","aud","cad","chf","inr","brl","mxn","sek","nok","dkk",
  "pln","zar","hkd","sgd","thb","twd","idr","php","try","ils","nzd","rub","aed","sar",
  "ngn","ars","clp","czk","ron",
]);

const COMMON = {
  // Majors
  btc: "bitcoin", xbt: "bitcoin",
  eth: "ethereum", sol: "solana",
  bnb: "binancecoin", ada: "cardano",
  xrp: "ripple", doge: "dogecoin",
  shib: "shiba-inu", dot: "polkadot",
  matic: "matic-network", avax: "avalanche-2",
  ltc: "litecoin", bch: "bitcoin-cash",
  trx: "tron", ton: "the-open-network",
  link: "chainlink", atom: "cosmos",
  uni: "uniswap", op: "optimism",
  arb: "arbitrum", etc: "ethereum-classic",
  xlm: "stellar", near: "near",
  apt: "aptos", hbar: "hedera-hashgraph",
  icp: "internet-computer", fil: "filecoin",
  egld: "elrond-erd-2", vet: "vechain",
  algo: "algorand", qnt: "quant-network",
  rndr: "render-token", axs: "axie-infinity",
  sand: "the-sandbox", mana: "decentraland",
  enj: "enjincoin", grt: "the-graph",
  chz: "chiliz", gala: "gala",
  flow: "flow", eos: "eos",
  xtz: "tezos", neo: "neo",
  ksm: "kusama", one: "harmony",
  celo: "celo", bat: "basic-attention-token",
  zrx: "0x", omg: "omisego",

  // Layer 2s / newer
  sui: "sui", sei: "sei-network",
  inj: "injective-protocol", dydx: "dydx",
  stx: "blockstack", rune: "thorchain",
  ldo: "lido-dao", frax: "frax",
  crv: "curve-dao-token", cvx: "convex-finance",
  aave: "aave", comp: "compound-governance-token",
  snx: "synthetix-network-token", bal: "balancer",
  mkr: "maker", tusd: "true-usd",

  // Meme / degen favorites
  pepe: "pepe", wojak: "wojak",
  floki: "floki", baby: "babydoge-coin",
  bonk: "bonk", dogelon: "dogelon-mars",
  pitbull: "pitbull", saitama: "saitama-inu",
  akita: "akita-inu", kishu: "kishu-inu",
  cult: "cult-dao", shibx: "shibaverse",

  // Other popular L1 / ecosystem coins
  kas: "kaspa", xno: "nano",
  dash: "dash", zec: "zcash",
  waves: "waves", ftm: "fantom",
  hnt: "helium", theta: "theta-token",
  kava: "kava", icx: "icon",
  iota: "iota", lrc: "loopring",
  sc: "siacoin", hot: "holotoken",
  xvg: "verge", rvn: "ravencoin",
  kda: "kadena", mina: "mina-protocol",
  rose: "oasis-network", xdc: "xdce-crowd-sale",
  btt: "bittorrent", fet: "fetch-ai",
  ocean: "ocean-protocol", ar: "arweave",
  storj: "storj", glmr: "moonbeam",
  skl: "skale", ankr: "ankr",
  ergo: "ergo", ssv: "ssv-network",
  gm: "gm", ngmi: "ngmi",
};

const LIST_TTL_MS = 12 * 60 * 60 * 1000; // 12h cache per isolate
let COIN_LIST = null;
let COIN_LIST_LOADED_AT = 0;

// --------- helpers ---------
function nrm(s) { return (s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

function fmt(num, quote) {
  const x = Number(num);
  const q = nrm(quote);
  if (FIAT.has(q)) {
    if (x >= 1) return x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (x >= 0.01) return x.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 });
    return x.toFixed(8);
  }
  if (x >= 1) return x.toFixed(6).replace(/\.?0+$/,"");
  return x.toFixed(10).replace(/\.?0+$/,"");
}

// Simple retry helper with timeout (for CoinGecko)
async function fetchJsonWithRetry(url, options = {}, { tries = 3, timeoutMs = 6000, label = "fetch" } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(t);
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        console.log(`${label} http ${r.status}`, body.slice(0, 200));
        if (r.status >= 500 || r.status === 429) {
          await new Promise(res => setTimeout(res, 300 * i));
          continue;
        }
        throw new Error(`${label} http ${r.status}`);
      }
      return await r.json();
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      console.log(`${label} attempt ${i} failed:`, String(e));
      await new Promise(res => setTimeout(res, 300 * i));
    }
  }
  throw lastErr || new Error(`${label} failed`);
}

async function loadCoinList() {
  const now = Date.now();
  if (COIN_LIST && now - COIN_LIST_LOADED_AT < LIST_TTL_MS) return COIN_LIST;
  COIN_LIST = await fetchJsonWithRetry(
    "https://api.coingecko.com/api/v3/coins/list?include_platform=false",
    { headers: { "Accept": "application/json" } },
    { label: "coinList" }
  );
  COIN_LIST_LOADED_AT = now;
  return COIN_LIST;
}

async function symbolToId(sym) {
  const s = nrm(sym);
  if (!s) return null;
  if (COMMON[s]) return COMMON[s];
  const list = await loadCoinList();
  let m = list.filter(c => nrm(c.symbol) === s);
  if (m.length === 0) m = list.filter(c => nrm(c.name) === s);
  if (m.length === 0) return null;
  m.sort((a,b) => (a.name?.length||999) - (b.name?.length||999));
  return m[0].id;
}

async function geckoPrice(ids, vs) {
  const url = new URL("https://api.coingecko.com/api/v3/simple/price");
  url.searchParams.set("ids", ids.join(","));
  url.searchParams.set("vs_currencies", vs.join(","));
  url.searchParams.set("precision", "full");
  return await fetchJsonWithRetry(url.toString(), { headers: { "Accept": "application/json" }}, { label: "geckoPrice" });
}

// --------- idempotency / dedupe + anti-flood ---------
const seenUpdates = new Set();          // update_id
const seenMessages = new Set();         // chat:message_id
const lastReplyHashByChat = new Map();  // chat_id -> { textHash, until }
const lastByChat = new Map();           // chat burst guard
const lastByUser = new Map();           // user burst guard
const cooldownByChat = new Map();       // chat_id -> until ms

function remember(setOrMap, key, ttlMs = 60_000) {
  setOrMap.add ? setOrMap.add(key) : setOrMap.set(key, true);
  setTimeout(() => setOrMap.delete(key), ttlMs);
}

function tooSoon(map, key, windowMs) {
  const now = Date.now();
  const last = map.get(key) || 0;
  if (now - last < windowMs) return true;
  map.set(key, now);
  return false;
}

const inCooldown = id => Date.now() < (cooldownByChat.get(id) || 0);

function sameReplyRecently(chatId, text, ttlMs = 5000) {
  const now = Date.now();
  const prev = lastReplyHashByChat.get(chatId);
  const hash = `${text.length}:${text.slice(0,64)}`;
  if (prev && prev.textHash === hash && now < prev.until) return true;
  lastReplyHashByChat.set(chatId, { textHash: hash, until: now + ttlMs });
  return false;
}

// --------- Telegram send with 429 backoff ---------
async function tgReply(env, chatId, text) {
  if (inCooldown(chatId)) return new Response("ok");
  if (sameReplyRecently(chatId, text)) return new Response("ok");

  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = { chat_id: chatId, text }; // plain text to avoid markdown errors

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
      cooldownByChat.set(chatId, Date.now() + retrySec * 1000);
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

// --------- main update handler ---------
async function handleTelegramUpdate(env, update) {
  // Pick the message; ignore other update kinds
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return new Response("ok");

  // Idempotency: dedupe by update_id and by (chat,message_id)
  if (typeof update.update_id === "number") {
    if (seenUpdates.has(update.update_id)) return new Response("ok");
    remember(seenUpdates, update.update_id, 60_000);
  }
  const msgKey = `${msg.chat.id}:${msg.message_id}`;
  if (seenMessages.has(msgKey)) return new Response("ok");
  remember(seenMessages, msgKey, 60_000);

  // Early anti-flood
  if (inCooldown(msg.chat.id)) return new Response("ok");
  if (tooSoon(lastByChat, msg.chat.id, 350)) return new Response("ok");
  if (msg.from && tooSoon(lastByUser, msg.from.id, 700)) return new Response("ok");

  // Parse command
  const text = (msg.text || "").trim().replace(/\u00A0/g, " ");
  if (!text.toLowerCase().startsWith("/c")) return new Response("ok");

  const parts = text.split(/\s+/);
  const mention = (parts[0].split("@")[1] || "").toLowerCase();
  if (mention && env.BOT_USERNAME && mention !== env.BOT_USERNAME.toLowerCase()) {
    return new Response("ok"); // addressed to another bot
  }
  if (parts.length < 4) return new Response("ok");

  const amtStr = parts[1];
  if (/,/.test(amtStr)) return new Response("ok"); // no commas
  const amt = Number(amtStr);
  if (!isFinite(amt)) return new Response("ok");

  const baseSym  = parts[2];
  const quoteSym = parts[3];

  try {
    const baseId = await symbolToId(baseSym);
    if (!baseId) return await tgReply(env, msg.chat.id, `Unknown base: ${baseSym}`);

    const base = nrm(baseSym);
const quote = nrm(quoteSym);

// ----- 1) crypto → fiat  (already worked before)
if (!FIAT.has(base) && FIAT.has(quote)) {
  const baseId = await symbolToId(env, baseSym);
  if (!baseId) return await tgReply(env, msg.chat.id, `Unknown base: ${baseSym}`);
  const prices = await geckoPriceCached(env, [baseId], [quote]);
  const p = prices?.[baseId]?.[quote];
  if (p == null) return await tgReply(env, msg.chat.id, "Price unavailable.");
  const total = amt * Number(p);
  const body = `${amt} ${base.toUpperCase()} ≈ ${fmt(total, quote)} ${quote.toUpperCase()}\n(1 ${base.toUpperCase()} = ${fmt(p, quote)} ${quote.toUpperCase()})`;
  return await tgReply(env, msg.chat.id, body);
}

// ----- 2) crypto → crypto  (already worked before)
if (!FIAT.has(base) && !FIAT.has(quote)) {
  const baseId  = await symbolToId(env, baseSym);
  const quoteId = await symbolToId(env, quoteSym);
  if (!baseId)  return await tgReply(env, msg.chat.id, `Unknown base: ${baseSym}`);
  if (!quoteId) return await tgReply(env, msg.chat.id, `Unknown quote: ${quoteSym}`);
  const prices = await geckoPriceCached(env, [baseId, quoteId], ["usd"]);
  const pBase = prices?.[baseId]?.usd;
  const pQuote = prices?.[quoteId]?.usd;
  if (!pBase || !pQuote) return await tgReply(env, msg.chat.id, "Price unavailable.");
  const rate = Number(pBase) / Number(pQuote);
  const total = amt * rate;
  const body = `${amt} ${base.toUpperCase()} ≈ ${fmt(total, quote)} ${quote.toUpperCase()}\n(1 ${base.toUpperCase()} = ${fmt(rate, quote)} ${quote.toUpperCase()})`;
  return await tgReply(env, msg.chat.id, body);
}

// ----- 3) fiat → crypto  ✅ new
if (FIAT.has(base) && !FIAT.has(quote)) {
  const quoteId = await symbolToId(env, quoteSym);
  if (!quoteId) return await tgReply(env, msg.chat.id, `Unknown quote: ${quoteSym}`);
  // price of 1 QUOTE in BASE fiat (e.g., 1 USDC in ARS)
  const prices = await geckoPriceCached(env, [quoteId], [base]);
  const p = prices?.[quoteId]?.[base];
  if (p == null || p <= 0) return await tgReply(env, msg.chat.id, "Price unavailable.");
  const units = amt / Number(p); // how many QUOTE you get for <amt> BASE-fiat
  const body = `${amt} ${base.toUpperCase()} ≈ ${fmt(units, quote)} ${quote.toUpperCase()}\n(1 ${quote.toUpperCase()} = ${fmt(p, base)} ${base.toUpperCase()})`;
  return await tgReply(env, msg.chat.id, body);
}

// ----- 4) fiat → fiat  ✅ new (pivot via USDT so we stay on CoinGecko)
if (FIAT.has(base) && FIAT.has(quote)) {
  // price of 1 USDT in each fiat; rate = quote/base
  const prices = await geckoPriceCached(env, ["tether"], [base, quote]);
  const pBase  = prices?.tether?.[base];   // e.g., 1 USDT = X ARS
  const pQuote = prices?.tether?.[quote];  // e.g., 1 USDT = Y USD
  if (!pBase || !pQuote) return await tgReply(env, msg.chat.id, "Rate unavailable.");
  const rate  = Number(pQuote) / Number(pBase); // 1 BASE = rate QUOTE
  const total = amt * rate;
  const body = `${amt} ${base.toUpperCase()} ≈ ${fmt(total, quote)} ${quote.toUpperCase()}\n(1 ${base.toUpperCase()} = ${fmt(rate, quote)} ${quote.toUpperCase()})`;
  return await tgReply(env, msg.chat.id, body);
}
  } catch (e) {
    console.log("conversion error:", e);
    return await tgReply(env, msg.chat.id, "Price service is busy. Try again.");
  }
}

// --------- worker entry ---------
export default {
  async fetch(request, env) {
    if (!env.TELEGRAM_BOT_TOKEN) {
      return new Response("Missing TELEGRAM_BOT_TOKEN", { status: 500 });
    }
    if (request.method === "POST") {
      // Optional: verify Telegram webhook secret if you set one
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

