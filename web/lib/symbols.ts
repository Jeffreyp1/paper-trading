// Hardcoded catalog of ~40 popular tickers. Keep simple — no JSON imports.
// Each entry has a name, ticker, and a category bucket used by the browse grid.

export type SymbolEntry = {
  ticker: string;
  name: string;
  category: "Trending" | "Popular" | "Tech" | "Finance";
};

export const SYMBOLS: SymbolEntry[] = [
  // Trending (mix of high-volatility / news names)
  { ticker: "NVDA", name: "NVIDIA Corp.", category: "Trending" },
  { ticker: "TSLA", name: "Tesla, Inc.", category: "Trending" },
  { ticker: "AMD",  name: "Advanced Micro Devices", category: "Trending" },
  { ticker: "PLTR", name: "Palantir Technologies", category: "Trending" },
  { ticker: "COIN", name: "Coinbase Global", category: "Trending" },
  { ticker: "SHOP", name: "Shopify Inc.", category: "Trending" },
  { ticker: "SNOW", name: "Snowflake Inc.", category: "Trending" },
  { ticker: "UBER", name: "Uber Technologies", category: "Trending" },
  { ticker: "ABNB", name: "Airbnb, Inc.", category: "Trending" },
  { ticker: "RBLX", name: "Roblox Corp.", category: "Trending" },

  // Popular (broad megacaps + ETFs)
  { ticker: "AAPL", name: "Apple Inc.", category: "Popular" },
  { ticker: "MSFT", name: "Microsoft Corp.", category: "Popular" },
  { ticker: "GOOGL", name: "Alphabet Inc.", category: "Popular" },
  { ticker: "AMZN", name: "Amazon.com, Inc.", category: "Popular" },
  { ticker: "META", name: "Meta Platforms", category: "Popular" },
  { ticker: "BRK.B", name: "Berkshire Hathaway", category: "Popular" },
  { ticker: "JNJ",  name: "Johnson & Johnson", category: "Popular" },
  { ticker: "V",    name: "Visa Inc.", category: "Popular" },
  { ticker: "WMT",  name: "Walmart Inc.", category: "Popular" },
  { ticker: "DIS",  name: "The Walt Disney Co.", category: "Popular" },

  // Tech
  { ticker: "ORCL", name: "Oracle Corp.", category: "Tech" },
  { ticker: "CRM",  name: "Salesforce, Inc.", category: "Tech" },
  { ticker: "ADBE", name: "Adobe Inc.", category: "Tech" },
  { ticker: "INTC", name: "Intel Corp.", category: "Tech" },
  { ticker: "CSCO", name: "Cisco Systems", category: "Tech" },
  { ticker: "QCOM", name: "Qualcomm Inc.", category: "Tech" },
  { ticker: "IBM",  name: "IBM Corp.", category: "Tech" },
  { ticker: "TXN",  name: "Texas Instruments", category: "Tech" },
  { ticker: "AVGO", name: "Broadcom Inc.", category: "Tech" },
  { ticker: "NFLX", name: "Netflix, Inc.", category: "Tech" },

  // Finance
  { ticker: "JPM",  name: "JPMorgan Chase", category: "Finance" },
  { ticker: "BAC",  name: "Bank of America", category: "Finance" },
  { ticker: "WFC",  name: "Wells Fargo & Co.", category: "Finance" },
  { ticker: "GS",   name: "Goldman Sachs", category: "Finance" },
  { ticker: "MS",   name: "Morgan Stanley", category: "Finance" },
  { ticker: "C",    name: "Citigroup Inc.", category: "Finance" },
  { ticker: "AXP",  name: "American Express", category: "Finance" },
  { ticker: "BLK",  name: "BlackRock, Inc.", category: "Finance" },
  { ticker: "SCHW", name: "Charles Schwab", category: "Finance" },
  { ticker: "MA",   name: "Mastercard Inc.", category: "Finance" },
];

export function findSymbol(ticker: string): SymbolEntry | undefined {
  const t = ticker.toUpperCase();
  return SYMBOLS.find((s) => s.ticker === t);
}

export function searchSymbols(query: string, limit = 8): SymbolEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const ranked = SYMBOLS
    .map((s) => {
      const t = s.ticker.toLowerCase();
      const n = s.name.toLowerCase();
      let score = 0;
      if (t === q) score = 100;
      else if (t.startsWith(q)) score = 80;
      else if (n.startsWith(q)) score = 60;
      else if (t.includes(q)) score = 40;
      else if (n.includes(q)) score = 20;
      return { s, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.s);
  return ranked;
}
