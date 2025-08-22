import os
import re
import logging
from typing import Dict, List, Optional

import aiohttp
from cachetools import TTLCache
from telegram import Update
from telegram.constants import ParseMode
from telegram.ext import ApplicationBuilder, ContextTypes, MessageHandler, filters

BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
COINGECKO_API = "https://api.coingecko.com/api/v3"
USER_AGENT = "CryptoConvertBot/1.0 (+https://t.me/)"

symbol_cache = TTLCache(maxsize=5000, ttl=60 * 60 * 12)  # 12 hours
price_cache = TTLCache(maxsize=5000, ttl=60)             # 60 seconds

COMMON_IDS = {
    "btc": "bitcoin", "xbt": "bitcoin", "eth": "ethereum", "sol": "solana",
    "ada": "cardano", "xrp": "ripple", "doge": "dogecoin", "dot": "polkadot",
    "matic": "matic-network", "avax": "avalanche-2", "ltc": "litecoin",
    "bch": "bitcoin-cash", "atom": "cosmos", "link": "chainlink", "uni": "uniswap",
    "arb": "arbitrum", "op": "optimism", "ton": "the-open-network", "xlm": "stellar",
    "etc": "ethereum-classic", "near": "near", "apt": "aptos", "ftm": "fantom",
    "fil": "filecoin", "hnt": "helium",
}

FIAT_WHITELIST = {
    "usd","eur","gbp","jpy","cny","aud","cad","chf","inr","brl","mxn","sek","nok",
    "dkk","pln","zar","hkd","sgd","thb","twd","idr","php","try","ils","nzd","rub",
    "aed","sar","ngn","ars","clp","czk","ron",
}

TRIGGER_PATTERN = re.compile(r"^/c\s+([0-9]*\.?[0-9]+)\s+([a-z0-9]+)\s+([a-z0-9]+)$", re.IGNORECASE)

def nrm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())

async def fetch_json(session: aiohttp.ClientSession, url: str, params: dict = None):
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    async with session.get(url, params=params, headers=headers, timeout=aiohttp.ClientTimeout(total=12)) as resp:
        if resp.status != 200:
            text = await resp.text()
            raise RuntimeError(f"HTTP {resp.status}: {text[:200]}")
        return await resp.json()

async def symbol_to_id(session: aiohttp.ClientSession, symbol: str) -> Optional[str]:
    key = nrm(symbol)
    if not key:
        return None
    if key in COMMON_IDS:
        return COMMON_IDS[key]
    if key in symbol_cache:
        return symbol_cache[key]

    coins = await fetch_json(session, f"{COINGECKO_API}/coins/list", params={"include_platform": "false"})
    matches = [c for c in coins if nrm(c.get("symbol","")) == key]
    if not matches:
        matches = [c for c in coins if nrm(c.get("name","")) == key]
    chosen = None
    if matches:
        matches.sort(key=lambda c: (len(c.get("name","")), c.get("id","")))
        chosen = matches[0]["id"]
    symbol_cache[key] = chosen
    return chosen

async def get_prices(session: aiohttp.ClientSession, ids: List[str], vs: List[str]) -> Dict[str, Dict[str, float]]:
    cache_key = f"{','.join(sorted(ids))}|{','.join(sorted(vs))}"
    if cache_key in price_cache:
        return price_cache[cache_key]
    data = await fetch_json(session, f"{COINGECKO_API}/simple/price", {
        "ids": ",".join(ids),
        "vs_currencies": ",".join(vs),
        "precision": "full",
    })
    price_cache[cache_key] = data
    return data

def fmt(x: float, quote: str) -> str:
    q = nrm(quote)
    if q in FIAT_WHITELIST:
        if x >= 1: return f"{x:,.2f}"
        if x >= 0.01: return f"{x:,.4f}"
        return f"{x:.8f}"
    else:
        if x >= 1: return f"{x:.6f}".rstrip("0").rstrip(".")
        return f"{x:.10f}".rstrip("0").rstrip(".")

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = (update.message.text or "").strip()
    m = TRIGGER_PATTERN.match(text)
    if not m:
        return

    amt = float(m.group(1))
    base = nrm(m.group(2))
    quote = nrm(m.group(3))

    async with aiohttp.ClientSession() as session:
        quote_is_fiat = quote in FIAT_WHITELIST

        base_id = await symbol_to_id(session, base)
        if not base_id:
            await update.message.reply_text(f"Unknown base asset: *{m.group(2)}*", parse_mode=ParseMode.MARKDOWN)
            return

        if quote_is_fiat:
            prices = await get_prices(session, [base_id], [quote])
            p = prices.get(base_id, {}).get(quote)
            if p is None:
                await update.message.reply_text("Price unavailable right now.")
                return
            total = amt * float(p)
            msg = f"`{amt}` {base.upper()} ≈ `{fmt(total, quote)}` {quote.upper()}  \n(1 {base.upper()} = `{fmt(float(p), quote)}` {quote.upper()})"
            await update.message.reply_text(msg, parse_mode=ParseMode.MARKDOWN)
        else:
            quote_id = await symbol_to_id(session, quote)
            if not quote_id:
                await update.message.reply_text(f"Unknown quote asset: *{m.group(3)}*", parse_mode=ParseMode.MARKDOWN)
                return
            prices = await get_prices(session, [base_id, quote_id], ["usd"])
            p_base = prices.get(base_id, {}).get("usd")
            p_quote = prices.get(quote_id, {}).get("usd")
            if not p_base or not p_quote or p_quote == 0:
                await update.message.reply_text("Price unavailable right now.")
                return
            rate = float(p_base) / float(p_quote)
            total = amt * rate
            msg = (
                f"`{amt}` {base.upper()} ≈ `{fmt(total, quote)}` {quote.upper()}  \n"
                f"(1 {base.upper()} = `{fmt(rate, quote)}` {quote.upper()})"
            )
            await update.message.reply_text(msg, parse_mode=ParseMode.MARKDOWN)

def main():
    if not BOT_TOKEN:
        raise SystemExit("Set TELEGRAM_BOT_TOKEN env var before running.")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    app = ApplicationBuilder().token(BOT_TOKEN).build()
    app.add_handler(MessageHandler(filters.TEXT, handle_message))
    app.run_polling(close_loop=False)

if __name__ == "__main__":
    main()
