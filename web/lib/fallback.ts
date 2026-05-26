// Hardcoded fallback data, kept verbatim from app/page.tsx so the dashboard
// renders identically when every backend is unreachable.

export type IndexCard = {
  title: string;
  value: string;
  code: string;
  delta: string;
  pct: string;
  red: boolean;
};

export type Commodity = {
  name: string;
  value: string;
  delta: string;
  pct: string;
  red: boolean;
};

export type WatchRow = {
  id: string;
  name: string;
  value: string;
  change: string;
  num: string;
};

export type DiscoverRow = {
  name: string;
  ticker: string;
  price: string;
  pct: string;
};

export type DjiPoint = { i: number; green: number; orange: number };

export type Dji = {
  value: string;
  asOf: string;
  points: DjiPoint[];
  selection: { tIso: string; x1: number; x2: number; label: string };
};

export type DashboardData = {
  indices: IndexCard[];
  commodities: Commodity[];
  dji: Dji;
  watchlist: WatchRow[];
  discover: DiscoverRow[];
};

export const FALLBACK_INDICES: IndexCard[] = [
  { title: "DAX PERFORMAE", value: "6,243.28", code: "INX", delta: "+7.43", pct: "0.56%", red: false },
  { title: "S$P 500", value: "24,586.54", code: "INX", delta: "+7.43", pct: "0.56%", red: false },
  { title: "FTSE 100 INDEX", value: "82.965.68", code: "INX", delta: "+7.43", pct: "0.56%", red: false },
  { title: "S$P/TSX Composits", value: "32,053.74", code: "INX", delta: "-7.43", pct: "0.56%", red: true },
  { title: "NIKKEI 200", value: "46,053.78", code: "INX", delta: "+7.43", pct: "0.56%", red: false },
];

export const FALLBACK_COMMODITIES: Commodity[] = [
  { name: "Platinum", value: "55,789.75", delta: "+10.25", pct: "0.85%", red: false },
  { name: "Silver", value: "30,123.50", delta: "+10.25", pct: "0.85%", red: false },
  { name: "Copper", value: "12,345.67", delta: "-10.25", pct: "0.85%", red: true },
  { name: "Palladium", value: "78,910.11", delta: "+10.25", pct: "0.85%", red: false },
  { name: "Rhodium", value: "99,999.99", delta: "+10.25", pct: "0.85%", red: false },
];

export const FALLBACK_WATCHLIST: WatchRow[] = [
  { id: "w-sp500", name: "S&P 500", value: "4.372.75", change: "+10.32", num: "100.2" },
  { id: "w-ftse", name: "FTSE 100", value: "7.500.12", change: "+20.47", num: "75.8" },
  { id: "w-dji", name: "Dow Jones Industrial", value: "34.000.25", change: "+75.05", num: "150.6" },
  { id: "w-rus", name: "Russell 2000", value: "2.080.30", change: "+5.12", num: "80.1" },
];

export const FALLBACK_DISCOVER: DiscoverRow[] = [
  { name: "Bse sensex", ticker: "DSSL", price: "$6.248.80", pct: "0.48%" },
  { name: "Installed building", ticker: "IBP", price: "$1,078.20", pct: "0.48%" },
  { name: "Wondershare", ticker: "ALIF", price: "$68.80", pct: "0.48%" },
  { name: "Hims & heres", ticker: "INDE", price: "84,19.20", pct: "0.48%" },
  { name: "Robinhood market", ticker: "SMW", price: "$96.008", pct: "0.48%" },
  { name: "Similarweb Ltd", ticker: "HUB", price: "$20,490", pct: "0.48%" },
  { name: "Bse sensex", ticker: "HIM", price: "6.248.80", pct: "0.48%" },
  { name: "Hobspot Inc", ticker: "HOD", price: "4,2290", pct: "0.48%" },
];

export const FALLBACK_DJI_POINTS: DjiPoint[] = Array.from({ length: 80 }, (_, i) => {
  const t = i / 79;
  const green =
    25 +
    18 * Math.sin(t * Math.PI * 1.4) +
    8 * Math.sin(t * Math.PI * 4.2) +
    5 * Math.cos(t * Math.PI * 2.7);
  const orange =
    20 +
    14 * Math.sin(t * Math.PI * 1.1 + 0.8) +
    6 * Math.cos(t * Math.PI * 3.5) +
    4 * Math.sin(t * Math.PI * 5.0);
  return { i, green: Math.max(8, green), orange: Math.max(6, orange) };
});

export const FALLBACK_DJI: Dji = {
  value: "44,524.40",
  asOf: "Jun9.40:05 PM UTC.4 - INWEXJX DISCILAIMER",
  points: FALLBACK_DJI_POINTS,
  selection: { tIso: "", x1: 45, x2: 49, label: "Jun 9.10:48PM UTC-4" },
};

export const FALLBACK_DASHBOARD: DashboardData = {
  indices: FALLBACK_INDICES,
  commodities: FALLBACK_COMMODITIES,
  dji: FALLBACK_DJI,
  watchlist: FALLBACK_WATCHLIST,
  discover: FALLBACK_DISCOVER,
};
