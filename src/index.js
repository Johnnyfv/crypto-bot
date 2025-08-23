// Telegram Crypto Convert Bot (Webhook) — Cloudflare Workers (Free)
// Trigger: /c <amount> <coin1> <coin2>
// Examples: /c 2 btc usd   |   /c 0.5 eth btc

const FIAT = new Set([
  "usd","eur","gbp","jpy","cny","aud","cad","chf","inr","brl","mxn","sek","nok","dkk",
  "pln","zar","hkd","sgd","thb","twd","idr","php","try","ils","nzd","rub","aed","sar",
  "ngn","ars","clp","czk","ron",
]);

const COMMON = {
  btc: "bitcoin", xbt: "bitcoin", eth: "ethereum", sol: "solana",
  ada: "cardano", xrp: "ripple", doge: "dogecoin", dot: "polkadot",
  matic: "matic-network", avax: "avalanche-2", ltc: "litecoin",
  bch: "bitcoin-cash", atom: "cosmos", link: "chainlink", uni: "uniswap",
  arb: "arbitrum", op: "optimism", ton: "the-open-network", xlm: "stellar",
  etc: "ethereum-classic", near: "near", apt: "aptos", ftm: "fantom",
  fil: "filecoin", hnt: "helium",
};

const LIST_TTL_MS = 12 * 60 * 60 * 1000;
let COIN_LIST = null;
let COIN_LIST_LOADED_AT = 0;

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

async function loadCoinList() {
  const now = Date.now();
  if (COIN_LIST && now - COIN_LIST_LOADED_AT < LIST_TTL_MS) return COIN_LIST;
  const resp = await fetch("https://api.coingecko.com/api/v3/coins/list?include_platform=false", {
    headers: { "Accept": "application/json" }
  });
  if (!resp.ok) throw new Error("Failed to load coin list");
  COIN_LIST = await resp.json();
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
  const r = await fetch(url, { headers: { "Accept": "application/json" }});
  if (!r.ok) throw new Error("Price fetch failed");
  return r.json();
}

async function handleTelegramUpdate(env, update) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return new Response("ok");

  const text = msg.text.trim();
  const m = text.match(/^\/c(?:@\w+)?\s+([0-9]*\.?[0-9]+)\s+([a-z0-9]+)\s+([a-z0-9]+)$/i);
  if (!m) return new Response("ok"); // ignore others

  const amt = parseFloat(m[1]);
  const baseSym = m[2];
  const quoteSym = m[3];
  const base = nrm(baseSym);
  const quote = nrm(quoteSym);

  try {
    const baseId = await symbolToId(base);
    if (!baseId) return await tgReply(env, msg.chat.id, `Unknown base asset: *${baseSym}*`);

    if (FIAT.has(quote)) {
      const prices = await geckoPrice([baseId], [quote]);
      const p = prices?.[baseId]?.[quote];
      if (p == null) return await tgReply(env, msg.chat.id, "Price unavailable right now.");
      const total = amt * Number(p);
      const body = `\`${amt}\` ${base.toUpperCase()} ≈ \`${fmt(total, quote)}\` ${quote.toUpperCase()}\n(1 ${base.toUpperCase()} = \`${fmt(p, quote)}\` ${quote.toUpperCase()})`;
      return await tgReply(env, msg.chat.id, body);
    } else {
      const quoteId = await symbolToId(quote);
      if (!quoteId) return await tgReply(env, msg.chat.id, `Unknown quote asset: *${quoteSym}*`);
      const prices = await geckoPrice([baseId, quoteId], ["usd"]);
      const pBase = prices?.[baseId]?.usd;
      const pQuote = prices?.[quoteId]?.usd;
      if (!pBase || !pQuote) return await tgReply(env, msg.chat.id, "Price unavailable right now.");
      const rate = Number(pBase) / Number(pQuote);
      const total = amt * rate;
      const body = `\`${amt}\` ${base.toUpperCase()} ≈ \`${fmt(total, quote)}\` ${quote.toUpperCase()}\n(1 ${base.toUpperCase()} = \`${fmt(rate, quote)}\` ${quote.toUpperCase()})`;
      return await tgReply(env, msg.chat.id, body);
    }
  } catch {
    return await tgReply(env, msg.chat.id, "Error fetching price. Try again.");
  }
}

async function tgReply(env, chatId, text) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = { chat_id: chatId, text, parse_mode: "Markdown" };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  // Log Telegram's response if anything goes wrong
  if (!r.ok) {
    const t = await r.text();
    console.log("sendMessage failed", r.status, t);
  } else {
    const j = await r.json();
    if (!j.ok) console.log("sendMessage JSON not ok", j);
  }
  return new Response("ok");
}


export default {
  async fetch(request, env) {
    if (!env.TELEGRAM_BOT_TOKEN) {
      // Makes it obvious in logs if the secret is missing
      return new Response("Missing TELEGRAM_BOT_TOKEN", { status: 500 });
    }
    if (request.method === "POST") {
      const update = await request.json();
      return await handleTelegramUpdate(env, update);
    }
    return new Response("Telegram /c bot is running.");
  }
};

