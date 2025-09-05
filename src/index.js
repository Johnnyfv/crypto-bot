// Telegram Converter Bot — Cloudflare Worker
// Commands: /c and /cbot
// Usage: /c <amount> <base> <quote>
// Example: /c 2 btc usdt

// ============= Utils =============
function nrm(s){ return String(s ?? "").toLowerCase().trim(); }
function upper(s){ return String(s ?? "").toUpperCase().trim(); }

// A few handy aliases (not required, but helps users)
const ALIAS = { xbt:"btc", usdt:"usdt", usdc:"usdc", dai:"dai", eth:"eth", btc:"btc", sol:"sol", doge:"doge", shib:"shib" };

function fmt(num, quote){
  const x = Number(num), q = nrm(quote);
  if (!isFinite(x)) return String(num);
  if (q === "usdt" || q === "usdc" || q === "dai") {
    if (x >= 1) return x.toFixed(2);
    if (x >= 0.01) return x.toFixed(4);
    return x.toFixed(6);
  }
  if (x >= 1) return x.toFixed(6).replace(/\.?0+$/,"");
  return x.toFixed(10).replace(/\.?0+$/,"");
}

// ============= Prices (Binance) =============
async function binancePrice(base, quote){
  const symbol = upper(base) + upper(quote);
  const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`, { headers:{Accept:"application/json"} });
  if (!r.ok) throw new Error("binance " + r.status);
  const j = await r.json();
  const p = Number(j.price);
  if (!isFinite(p) || p <= 0) throw new Error("bad price");
  return p;
}

// Small cache (30s)
const CACHE = new Map();
function cacheGet(key, ttl=30_000){ const e=CACHE.get(key); return e && Date.now()-e.t < ttl ? e.v : null; }
function cachePut(key,v){ CACHE.set(key,{t:Date.now(),v}); }

async function getPrice(base, quote){
  base = nrm(ALIAS[base] || base);
  quote = nrm(ALIAS[quote] || quote);
  if (base === quote) return 1;

  const key = `${base}:${quote}`;
  const c = cacheGet(key); if (c) return c;

  // Direct
  try { const p = await binancePrice(base, quote); cachePut(key,p); return p; } catch {}

  // Pivot via USDT
  try {
    const pb = await binancePrice(base, "usdt");
    const pq = await binancePrice(quote, "usdt");
    const rate = pb / pq;
    if (isFinite(rate) && rate > 0) { cachePut(key, rate); return rate; }
  } catch {}

  throw new Error("no price route");
}

// ============= Telegram I/O =============
async function tgSend(env, chatId, text){
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  }).catch(()=>{});
}

function parseCommand(text){
  // Accept /c or /cbot, with optional @BotUsername
  // Returns { cmd, mention, parts } or null
  const parts = text.trim().replace(/\u00A0/g," ").split(/\s+/);
  if (parts.length === 0) return null;
  const rawCmd = parts[0];             // e.g. "/c@CConvertibot"
  if (!rawCmd.startsWith("/")) return null;

  const [cmdOnly, mention] = rawCmd.split("@"); // ["/c", "CConvertibot"]
  const cmdLower = cmdOnly.toLowerCase();

  const ok = cmdLower === "/c" || cmdLower === "/cbot";
  if (!ok) return null;

  return { cmd: cmdLower, mention: (mention || ""), parts };
}

async function handleUpdate(env, update){
  // Only care about text messages (privacy mode + not admin reduces noise, this is extra safety)
  const msg = update.message || update.edited_message;
  if (!msg || typeof msg.text !== "string") return new Response("ok");

  const cmdInfo = parseCommand(msg.text);
  if (!cmdInfo) return new Response("ok"); // not our command

  // If command has @mention, ensure it's for THIS bot (when BOT_USERNAME is set)
  if (cmdInfo.mention && env.BOT_USERNAME && cmdInfo.mention.toLowerCase() !== env.BOT_USERNAME.toLowerCase()) {
    return new Response("ok");
  }

  // Help screen when only the command is typed (no args)
  if (cmdInfo.parts.length < 4) {
    await tgSend(env, msg.chat.id,
`Crypto Convert Bot

Usage:
/c <amount> <base> <quote>
/cbot <amount> <base> <quote>

Examples:
/c 1 btc usdt
/cbot 5 eth btc
/c 10 sol usdc

Notes:
• No commas in the amount
• Works in groups and DMs

Support ❤️ https://cwallet.com/t/1PYNYSIY`);
    return new Response("ok");
  }

  const [, amtStr, base, quote] = cmdInfo.parts;

  // No commas rule for amount
  if (/,/.test(amtStr)) {
    await tgSend(env, msg.chat.id, "Invalid amount (no commas). Try: 1.5 not 1,5");
    return new Response("ok");
  }

  const amt = Number(amtStr);
  if (!isFinite(amt) || amt <= 0) {
    await tgSend(env, msg.chat.id, "Invalid amount.");
    return new Response("ok");
  }

  try {
    const px = await getPrice(base, quote);
    const total = amt * px;
    const reply =
      `${amt} ${upper(base)} ≈ ${fmt(total, quote)} ${upper(quote)}\n` +
      `(1 ${upper(base)} = ${fmt(px, quote)} ${upper(quote)})`;
    await tgSend(env, msg.chat.id, reply);
  } catch (e) {
    // Friendlier errors for common cases
    const b = nrm(base), q = nrm(quote);
    if ((b === "usdt" || b === "usdc" || b === "dai") && (q === "usdt" || q === "usdc" || q === "dai")) {
      await tgSend(env, msg.chat.id, "No route for that stable/stable pair on Binance. Try a different quote.");
    } else {
      await tgSend(env, msg.chat.id, "No price available for that pair right now. Try again or reverse the pair.");
    }
  }

  return new Response("ok");
}

// ============= Worker Entry =============
export default {
  async fetch(request, env) {
    // Enforce Telegram secret (blocks non-Telegram traffic)
    if (request.method === "POST") {
      const given = request.headers.get("x-telegram-bot-api-secret-token");
      if (env.WEBHOOK_SECRET && given !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const update = await request.json().catch(() => ({}));
      return await handleUpdate(env, update);
    }

    return new Response("Converter bot is running.");
  }
};
