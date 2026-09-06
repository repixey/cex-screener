const { createApp, ref, reactive, computed, watch, onMounted, onBeforeUnmount } = Vue;

const STREAM_URL = 'wss://fstream.binance.com/market/ws/!miniTicker@arr';
const QUOTES = ['USDT', 'FDUSD', 'USDC', 'TUSD', 'BTC', 'ETH', 'BNB', 'TRY', 'EUR', 'DAI'];
const MAX_ROWS = 2000;
const HISTORY_LIMIT = 340;
const HISTORY_TTL = 320000;
const FLASH_MS = 950;
const STORAGE_PREFIX = 'screener:';
const MAX_GHOST_ROWS = 300;
const ATR_PERIOD_MS = 60000;
const ATR_WINDOW_PERIODS = 10;

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value)); } catch {}
  }
};

const hashHue = (str) => {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % 360;
};

const iconSources = (sym) => {
  const s = sym.toLowerCase();
  return [
    `https://assets.coincap.io/assets/icons/${s}@2x.png`,
    `https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/32/color/${s}.png`,
    `https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/color/${s}.png`,
    `https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/32/icon/${s}.png`
  ];
};

const iconMap = reactive(new Map());
const ICON_CACHE_KEY = 'iconMap:v1';
const ICON_CACHE_TTL = 24 * 60 * 60 * 1000;

const mcapMap = reactive(new Map());
const MCAP_CACHE_KEY = 'mcapMap:v1';
const MCAP_CACHE_TTL = 5 * 60 * 1000;

const TOKENIZED_STOCK_CATEGORIES = ['bstocks-ecosystem', 'xstocks-ecosystem', 'tokenized-stock'];

const mcapPendingSymbols = reactive(new Set());
const mcapFallbackTried = new Map();
const MCAP_FALLBACK_RETRY_TTL = 30 * 60 * 1000;
const MCAP_FALLBACK_INTERVAL = 2500;
const MCAP_FALLBACK_BATCH = 1;
let mcapFallbackQueueRunning = false;

const loadIconCache = () => {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + ICON_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.ts || !parsed.data || Date.now() - parsed.ts > ICON_CACHE_TTL) return null;
    return parsed.data;
  } catch {
    return null;
  }
};

const saveIconCache = () => {
  try {
    const data = Object.fromEntries(iconMap);
    localStorage.setItem(STORAGE_PREFIX + ICON_CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch {}
};

const loadMcapCache = () => {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + MCAP_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.ts || !parsed.data || Date.now() - parsed.ts > MCAP_CACHE_TTL) return null;
    return parsed.data;
  } catch {
    return null;
  }
};

const saveMcapCache = () => {
  try {
    const data = Object.fromEntries(mcapMap);
    localStorage.setItem(STORAGE_PREFIX + MCAP_CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch {}
};

const setMcapSource = (sym, source, value) => {
  if (!sym || !isFinite(value) || value <= 0) return;
  const entry = mcapMap.get(sym) || {};
  entry[source] = value;
  mcapMap.set(sym, entry);
};

const getAggregatedMcap = (sym) => {
  const entry = mcapMap.get((sym || '').toUpperCase());
  if (!entry) return null;
  const vals = Object.values(entry).filter((v) => isFinite(v) && v > 0);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
};

const fetchCoinGeckoMarketData = async () => {
  for (let page = 1; page <= 4; page++) {
    try {
      const res = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}&sparkline=false`);
      if (!res.ok) break;
      const coins = await res.json();
      if (!Array.isArray(coins) || !coins.length) break;
      for (const c of coins) {
        const sym = (c.symbol || '').toUpperCase();
        if (sym && c.image && !iconMap.has(sym)) iconMap.set(sym, c.image);
        if (sym && c.market_cap) setMcapSource(sym, 'cg', c.market_cap);
      }
      if (coins.length < 250) break;
    } catch (err) {
      console.warn('CoinGecko market data fetch failed:', err);
      break;
    }
    await new Promise((r) => setTimeout(r, 350));
  }
};

const fetchTokenizedStockCategories = async () => {
  for (const categoryId of TOKENIZED_STOCK_CATEGORIES) {
    for (let page = 1; page <= 2; page++) {
      try {
        const res = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=${encodeURIComponent(categoryId)}&order=market_cap_desc&per_page=250&page=${page}&sparkline=false`);
        if (!res.ok) break;
        const coins = await res.json();
        if (!Array.isArray(coins) || !coins.length) break;
        for (const c of coins) {
          const sym = (c.symbol || '').toUpperCase();
          if (sym && c.image && !iconMap.has(sym)) iconMap.set(sym, c.image);
          if (sym && c.market_cap) setMcapSource(sym, 'cg-tokstock', c.market_cap);
        }
        if (coins.length < 250) break;
      } catch (err) {
        console.warn(`CoinGecko category fetch failed (${categoryId}):`, err);
        break;
      }
      await new Promise((r) => setTimeout(r, 350));
    }
    await new Promise((r) => setTimeout(r, 350));
  }
};

const fetchCoinPaprikaIcons = async () => {
  try {
    const res = await fetch('https://api.coinpaprika.com/v1/coins');
    if (!res.ok) return;
    const coins = await res.json();
    if (!Array.isArray(coins)) return;
    for (const c of coins) {
      if (c.is_active === false) continue;
      const sym = (c.symbol || '').toUpperCase();
      if (sym && c.id && !iconMap.has(sym)) {
        iconMap.set(sym, `https://static.coinpaprika.com/coin/${c.id}/logo.png`);
      }
    }
  } catch (err) {
    console.warn('CoinPaprika icon fetch failed:', err);
  }
};

const fetchCoinPaprikaMarketCaps = async () => {
  try {
    const res = await fetch('https://api.coinpaprika.com/v1/tickers?quotes=USD');
    if (!res.ok) return;
    const tickers = await res.json();
    if (!Array.isArray(tickers)) return;
    for (const t of tickers) {
      const sym = (t.symbol || '').toUpperCase();
      const mc = t.quotes && t.quotes.USD && t.quotes.USD.market_cap;
      if (sym && mc) setMcapSource(sym, 'pp', mc);
    }
  } catch (err) {
    console.warn('CoinPaprika market cap fetch failed:', err);
  }
};

const fetchFallbackMcapForBase = async (base) => {
  try {
    const searchRes = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(base)}`);
    if (!searchRes.ok) return false;
    const searchData = await searchRes.json();
    const coins = Array.isArray(searchData.coins) ? searchData.coins : [];
    const match = coins.find((c) => (c.symbol || '').toUpperCase() === base.toUpperCase()) || coins[0];
    if (!match || !match.id) return false;

    const mcRes = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(match.id)}`);
    if (!mcRes.ok) return false;
    const mcData = await mcRes.json();
    const coin = Array.isArray(mcData) ? mcData[0] : null;
    if (coin && coin.market_cap) {
      setMcapSource(base, 'cg-fallback', coin.market_cap);
      if (coin.image && !iconMap.has(base)) iconMap.set(base, coin.image);
      saveMcapCache();
      return true;
    }
    return false;
  } catch (err) {
    console.warn('Fallback mcap lookup failed for', base, err);
    return false;
  }
};

const refreshMarketCaps = async () => {
  await fetchCoinGeckoMarketData();
  await fetchCoinPaprikaMarketCaps();
  await fetchTokenizedStockCategories();
  if (mcapMap.size) saveMcapCache();
};

const initMarketData = async () => {
  const cachedIcons = loadIconCache();
  if (cachedIcons) for (const [sym, url] of Object.entries(cachedIcons)) iconMap.set(sym, url);

  const cachedMcap = loadMcapCache();
  if (cachedMcap) for (const [sym, entry] of Object.entries(cachedMcap)) mcapMap.set(sym, entry);

  await fetchCoinGeckoMarketData();
  await fetchCoinPaprikaIcons();
  await fetchCoinPaprikaMarketCaps();
  await fetchTokenizedStockCategories();
  if (iconMap.size) saveIconCache();
  if (mcapMap.size) saveMcapCache();
};

initMarketData();

const CoinIcon = {
  props: {
    symbol: { type: String, required: true },
    size: { type: Number, default: 32 }
  },
  data() {
    return { idx: 0, failed: false };
  },
  computed: {
    sources() {
      const dyn = iconMap.get(this.symbol.toUpperCase());
      return dyn ? [dyn, ...iconSources(this.symbol)] : iconSources(this.symbol);
    },
    src() { return this.sources[this.idx]; },
    label() {
      const s = this.symbol;
      return s.length <= 4 ? s : s.slice(0, 3);
    },
    avatarStyle() {
      const style = { width: this.size + 'px', height: this.size + 'px' };
      if (this.failed) {
        const h = hashHue(this.symbol);
        style.background = `linear-gradient(135deg, hsl(${h}, 62%, 48%), hsl(${(h + 50) % 360}, 62%, 32%))`;
      }
      return style;
    },
    labelStyle() {
      const k = this.label.length > 3 ? 0.32 : 0.44;
      return { fontSize: Math.max(9, Math.round(this.size * k)) + 'px' };
    }
  },
  methods: {
    onError() {
      if (this.idx + 1 < this.sources.length) {
        this.idx++;
      } else {
        this.failed = true;
      }
    }
  },
  template: `
    <span class="coin-avatar" :style="avatarStyle">
      <img v-if="!failed" :src="src" :alt="symbol" loading="lazy" decoding="async" @error="onError">
      <span v-else class="coin-avatar-fb" :style="labelStyle">{{ label }}</span>
    </span>
  `
};

const MiniChart = {
  props: {
    data: { type: Array, default: () => [] }
  },
  computed: {
    points() {
      if (!this.data || this.data.length < 2) return '';
      const width = 180, height = 60, padding = 6;
      const prices = this.data.map(d => d.p);
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      const range = (max - min) || 1;
      return this.data.map((d, i) => {
        const x = padding + (i / (this.data.length - 1)) * (width - 2 * padding);
        const y = padding + (1 - (d.p - min) / range) * (height - 2 * padding);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
    },
    strokeColor() {
      if (this.data.length < 2) return '#626B80';
      const first = this.data[0].p;
      const last = this.data[this.data.length - 1].p;
      return last >= first ? '#17D68C' : '#FF5470';
    }
  },
  template: `
    <svg :width="180" :height="60" viewBox="0 0 180 60" xmlns="http://www.w3.org/2000/svg">
      <rect width="180" height="60" fill="#0B0E14" rx="4" />
      <polyline :points="points" fill="none" :stroke="strokeColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
    </svg>
  `
};

createApp({
  components: { 'coin-icon': CoinIcon, 'mini-chart': MiniChart },
  setup() {
    const marketData = new Map();
    const vol24hMap = new Map();
    const favs = reactive(new Set(store.get('favs', [])));
    const blockedSymbols = reactive(new Set(store.get('blockedSymbols', [])));
    const visitedSymbols = reactive(new Set(store.get('visitedSymbols', [])));
    const uiTick = ref(0);
    const totalPairs = ref(0);
    const ups = ref(0);
    const latencyMs = ref(null);
    const connectionStatus = ref('connecting');
    const statusText = ref('Connecting');
    const uptimeSec = ref(0);

    const isPaused = ref(false);

    const searchQuery = ref(store.get('search', ''));
    const selectedQuote = ref(store.get('quote', 'USDT'));

    const minPrice = ref(null);
    const maxPrice = ref(null);
    const minVol1m = ref(null);
    const maxVol1m = ref(null);
    const minChg1m = ref(null);
    const maxChg1m = ref(null);
    const minChg5m = ref(null);
    const maxChg5m = ref(null);
    const minVol24h = ref(null);
    const maxVol24h = ref(null);
    const minMcap = ref(null);
    const maxMcap = ref(null);

    const fireThreshold = ref(store.get('fireThreshold', ''));
    const firedSymbols = new Set();
    const fireActive = computed(() => parseNum(fireThreshold.value) !== null && parseNum(fireThreshold.value) > 0);
    let audioCtx = null;

    const onlyFavs = ref(store.get('onlyFavs', false));
    const sortKey = ref(store.get('sortKey', 'vol1m'));
    if (sortKey.value === 'tps') sortKey.value = 'mcap';
    const sortDir = ref(store.get('sortDir', -1));
    const searchEl = ref(null);

    const showBlocklistModal = ref(false);

    /* Активный (выбранный на графике) символ */
    const activeSymbol = ref('BTCUSDT');

    const alertedChg1m = reactive(new Set());
    const alertedChg5m = reactive(new Set());
    const originalTitle = document.title;
    let titleFlashInterval = null;

    const previewRow = ref(null);
    const previewX = ref(0);
    const previewY = ref(0);
    let previewTimer = null;

    const filterMemory = new Map();

    let ws = null;
    let reconnectDelay = 1000;
    let lastMsgAt = 0;
    let entryCount = 0;
    let latencySum = 0;
    let latencyN = 0;
    let connectedAt = 0;
    const timers = [];

    const fetchVolume24h = async () => {
      try {
        const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr');
        if (!res.ok) return;
        const tickers = await res.json();
        for (const t of tickers) {
          const quoteVol = parseFloat(t.quoteVolume);
          if (isFinite(quoteVol) && quoteVol >= 0) {
            vol24hMap.set(t.symbol, quoteVol);
          }
        }
      } catch (err) {
        console.warn('Failed to fetch 24h volume data:', err);
      }
    };

    const splitSymbol = (sym, quote) => {
      if (quote !== 'ALL') {
        return sym.endsWith(quote) ? { base: sym.slice(0, -quote.length), quote } : { base: sym, quote: '' };
      }
      for (const q of QUOTES) {
        if (sym.endsWith(q)) return { base: sym.slice(0, -q.length), quote: q };
      }
      return { base: sym, quote: '' };
    };

    const pctChange = (now, then) =>
      (then !== null && isFinite(then) && then !== 0) ? (now - then) / then * 100 : null;

    const windowMetrics = (entry, ms, now) => {
      const target = now - ms;
      let refPoint = null;
      let ticks = 0;
      for (let i = entry.history.length - 1; i >= 0; i--) {
        const h = entry.history[i];
        if (h.t >= target) {
          refPoint = h;
          ticks++;
        } else break;
      }
      return {
        price: refPoint ? refPoint.p : null,
        ticks,
        volDelta: refPoint ? Math.max(0, entry.vol - refPoint.v) : 0
      };
    };

    const fmtPrice = (p) => {
      if (p === null || p === undefined || !isFinite(p)) return '—';
      if (p === 0) return '0';
      const abs = Math.abs(p);
      if (abs >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (abs >= 1) return p.toFixed(4);
      if (abs >= 0.01) return p.toFixed(6);
      const exp = Math.floor(Math.log10(abs));
      const sigDigits = 4;
      const decimals = Math.min(18, Math.max(6, -exp - 1 + sigDigits));
      return p.toFixed(decimals);
    };

    const fmtVol = (v) => {
      if (!v || v <= 0) return '—';
      if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
      if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
      if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
      return v.toFixed(0);
    };

    const fmtMCap = (v) => {
      if (!v || v <= 0) return '—';
      if (v >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
      if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
      if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
      if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
      return '$' + v.toFixed(0);
    };

    const fmtChg = (pct) => {
      if (pct === null || !isFinite(pct)) return { text: '—', cls: 'flat' };
      const cls = pct > 0.005 ? 'up' : pct < -0.005 ? 'down' : 'flat';
      return { text: (pct > 0 ? '+' : '') + pct.toFixed(2) + '%', cls };
    };

    const fmtUptime = computed(() => {
      const s = uptimeSec.value;
      const pad = (n) => String(n).padStart(2, '0');
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
    });

    const applyTick = (sym, price, quoteVol, eventTime) => {
      if (!sym || !isFinite(price)) return;
      let e = marketData.get(sym);
      const now = Date.now();
      if (!e) {
        e = { 
          sym, price, vol: 0, lastP: null, dir: 0, flashAt: 0, ticks: [], history: [],
          atrReturns: [], minuteStartPrice: price, minuteStartTs: Math.floor(eventTime / ATR_PERIOD_MS)
        };
        marketData.set(sym, e);
      } else {
        const currentPeriod = Math.floor(eventTime / ATR_PERIOD_MS);
        if (currentPeriod > e.minuteStartTs) {
          const prevClose = e.price;
          if (e.minuteStartPrice > 0 && isFinite(e.minuteStartPrice) && isFinite(prevClose)) {
            const pct = ((prevClose - e.minuteStartPrice) / e.minuteStartPrice) * 100;
            e.atrReturns.push(Math.abs(pct));
            if (e.atrReturns.length > ATR_WINDOW_PERIODS) e.atrReturns.shift();
          }
          e.minuteStartPrice = price;
          e.minuteStartTs = currentPeriod;
        }
      }

      if (e.lastP !== null && price !== e.lastP) {
        e.dir = price > e.lastP ? 1 : -1;
        e.flashAt = now;
        e.ticks.push(e.dir);
        if (e.ticks.length > 16) e.ticks.shift();
      }
      e.history.push({ t: eventTime, p: price, v: quoteVol });
      if (e.history.length > HISTORY_LIMIT) e.history.shift();
      const cutoff = now - HISTORY_TTL;
      while (e.history.length && e.history[0].t < cutoff) e.history.shift();
      if (isFinite(quoteVol) && quoteVol > 0) e.vol = quoteVol;
      e.price = price;
      e.lastP = price;
    };

    const handleMessage = (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch { return; }
      if (!Array.isArray(data)) return;
      const now = Date.now();
      let lag = 0;
      for (const d of data) {
        const t = d.E || now;
        const l = now - t;
        if (l >= 0 && l < 60000) lag += l;
        applyTick(d.s, parseFloat(d.c), parseFloat(d.q), t);
      }
      entryCount += data.length;
      if (data.length) {
        latencySum += lag / data.length;
        latencyN++;
      }
      lastMsgAt = now;
    };

    const scheduleReconnect = () => {
      const delay = reconnectDelay + Math.random() * 500;
      reconnectDelay = Math.min(reconnectDelay * 1.6, 15000);
      setTimeout(connect, delay);
    };

    const connect = () => {
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
      connectionStatus.value = 'connecting';
      statusText.value = 'Connecting';
      try {
        ws = new WebSocket(STREAM_URL);
      } catch {
        scheduleReconnect();
        return;
      }
      ws.onopen = () => {
        connectionStatus.value = 'live';
        statusText.value = 'Live';
        reconnectDelay = 1000;
        connectedAt = Date.now();
        uptimeSec.value = 0;
        for (const [sym, e] of marketData) {
          e.atrReturns = [];
          e.minuteStartPrice = e.price;
          e.minuteStartTs = Math.floor(Date.now() / ATR_PERIOD_MS);
        }
      };
      ws.onmessage = handleMessage;
      ws.onerror = () => {
        connectionStatus.value = 'bad';
        statusText.value = 'Error';
      };
      ws.onclose = () => {
        connectionStatus.value = 'bad';
        statusText.value = 'Reconnecting';
        scheduleReconnect();
      };
    };

    const baseFilteredRows = computed(() => {
      uiTick.value;
      const quote = selectedQuote.value;
      const search = searchQuery.value.trim().toUpperCase();
      const now = Date.now();
      const rows = [];
      for (const [sym, e] of marketData) {
        if (e.lastP === null) continue;
        if (blockedSymbols.has(sym)) continue;
        if (quote !== 'ALL' && !sym.endsWith(quote)) continue;
        if (onlyFavs.value && !favs.has(sym)) continue;
        if (search && !sym.includes(search)) continue;

        const { base, quote: q } = splitSymbol(sym, quote);
        if (!base) continue;

        const m1m = windowMetrics(e, 60000, now);
        const m5m = windowMetrics(e, 300000, now);
        const chg1m = pctChange(e.price, m1m.price);
        const chg5m = pctChange(e.price, m5m.price);
        const vol24h = vol24hMap.get(sym) || 0;

        const history = e.history.slice(-60).map(h => ({ t: h.t, p: h.p }));

        const atr1m = e.atrReturns.length > 0 ? e.atrReturns.reduce((a, b) => a + b, 0) / e.atrReturns.length : null;

        const fireThr = parseNum(fireThreshold.value);
        const isFire = fireThr !== null && fireThr > 0 && chg1m !== null && Math.abs(chg1m) >= fireThr;

        rows.push({
          sym,
          base,
          quote: q,
          price: e.price,
          chg1m,
          chg5m,
          mcap: getAggregatedMcap(base),
          mcapPending: mcapPendingSymbols.has(base),
          vol1m: m1m.volDelta,
          vol24h,
          ticks: e.ticks.slice(),
          flashCls: e.dir !== 0 && now - e.flashAt < FLASH_MS ? (e.dir === 1 ? 'flash-up' : 'flash-down') : '',
          c1m: fmtChg(chg1m),
          c5m: fmtChg(chg5m),
          atr1m,
          isFire,
          history
        });
      }
      return rows;
    });

    const applySort = (rows) => {
      rows.sort((a, b) => (favs.has(b.sym) ? 1 : 0) - (favs.has(a.sym) ? 1 : 0));
      const dir = sortDir.value;
      const key = sortKey.value;
      if (key === 'symbol') {
        rows.sort((a, b) => dir * a.sym.localeCompare(b.sym));
      } else {
        const val = (r) => {
          switch (key) {
            case 'price': return r.price;
            case 'chg1m': return r.chg1m ?? -Infinity;
            case 'chg5m': return r.chg5m ?? -Infinity;
            case 'mcap': return r.mcap ?? -Infinity;
            case 'vol24h': return r.vol24h;
            case 'atr1m': return r.atr1m ?? -Infinity;
            default: return r.vol1m;
          }
        };
        rows.sort((a, b) => dir * (val(a) - val(b)));
      }
      return rows;
    };

    const parseNum = (val) => {
      if (val === null || val === '' || val === undefined) return null;
      const parsed = parseFloat(String(val).replace(',', '.'));
      return isFinite(parsed) ? parsed : null;
    };

    const filteredRows = computed(() => {
      const minP = parseNum(minPrice.value);
      const maxP = parseNum(maxPrice.value);
      const minV1m = parseNum(minVol1m.value);
      const maxV1m = parseNum(maxVol1m.value);
      const minC1m = parseNum(minChg1m.value);
      const maxC1m = parseNum(maxChg1m.value);
      const minC5m = parseNum(minChg5m.value);
      const maxC5m = parseNum(maxChg5m.value);
      const minV24 = parseNum(minVol24h.value);
      const maxV24 = parseNum(maxVol24h.value);
      const minMcRaw = parseNum(minMcap.value);
      const maxMcRaw = parseNum(maxMcap.value);
      const minMc = minMcRaw !== null ? minMcRaw * 1e6 : null;
      const maxMc = maxMcRaw !== null ? maxMcRaw * 1e6 : null;

      const rows = baseFilteredRows.value.filter(r => {
        if (minP !== null && r.price < minP) return false;
        if (maxP !== null && r.price > maxP) return false;
        if (minV1m !== null && r.vol1m < minV1m) return false;
        if (maxV1m !== null && r.vol1m > maxV1m) return false;
        if (minC1m !== null && (r.chg1m === null || Math.abs(r.chg1m) < minC1m)) return false;
        if (maxC1m !== null && (r.chg1m === null || Math.abs(r.chg1m) > maxC1m)) return false;
        if (minC5m !== null && (r.chg5m === null || Math.abs(r.chg5m) < minC5m)) return false;
        if (maxC5m !== null && (r.chg5m === null || Math.abs(r.chg5m) > maxC5m)) return false;
        if (minV24 !== null && r.vol24h < minV24) return false;
        if (maxV24 !== null && r.vol24h > maxV24) return false;
        if (minMc !== null && (r.mcap === null || r.mcap < minMc)) return false;
        if (maxMc !== null && (r.mcap === null || r.mcap > maxMc)) return false;
        return true;
      });

      return applySort(rows);
    });

    const displayedRows = computed(() => {
      uiTick.value;
      const now = Date.now();
      const matched = filteredRows.value;
      const matchedSyms = new Set(matched.map(r => r.sym));
      const baseMap = new Map(baseFilteredRows.value.map(r => [r.sym, r]));

      for (const row of matched) {
        const mem = filterMemory.get(row.sym) || {};
        mem.lastMatchAt = now;
        filterMemory.set(row.sym, mem);
      }

      for (const sym of Array.from(filterMemory.keys())) {
        if (!baseMap.has(sym)) filterMemory.delete(sym);
      }

      let ghostRows = [];
      for (const [sym, mem] of filterMemory) {
        if (!matchedSyms.has(sym)) {
          const row = baseMap.get(sym);
          if (row) ghostRows.push({ ...row, isGhost: true, flashCls: '', lastMatchAt: mem.lastMatchAt });
        }
      }
      if (ghostRows.length > MAX_GHOST_ROWS) {
        ghostRows.sort((a, b) => b.lastMatchAt - a.lastMatchAt);
        ghostRows = ghostRows.slice(0, MAX_GHOST_ROWS);
      }
      ghostRows = applySort(ghostRows);

      return matched.concat(ghostRows).slice(0, MAX_ROWS + MAX_GHOST_ROWS);
    });

    const leader = computed(() => {
      uiTick.value;
      let best = null;
      for (const r of filteredRows.value) {
        if (r.mcap && (!best || r.mcap > best.mcap)) best = r;
      }
      return best;
    });

    const hasFilters = computed(() => {
      const hasPrice = parseNum(minPrice.value) !== null || parseNum(maxPrice.value) !== null;
      const hasVol1m = parseNum(minVol1m.value) !== null || parseNum(maxVol1m.value) !== null;
      const hasChg1m = parseNum(minChg1m.value) !== null || parseNum(maxChg1m.value) !== null;
      const hasChg5m = parseNum(minChg5m.value) !== null || parseNum(maxChg5m.value) !== null;
      const hasVol24h = parseNum(minVol24h.value) !== null || parseNum(maxVol24h.value) !== null;
      const hasMcap = parseNum(minMcap.value) !== null || parseNum(maxMcap.value) !== null;

      return !!(searchQuery.value.trim() || hasPrice || hasVol1m || hasChg1m || hasChg5m || hasVol24h || hasMcap || onlyFavs.value);
    });

    const resetFilters = () => {
      searchQuery.value = '';
      minPrice.value = null;
      maxPrice.value = null;
      minVol1m.value = null;
      maxVol1m.value = null;
      minChg1m.value = null;
      maxChg1m.value = null;
      minChg5m.value = null;
      maxChg5m.value = null;
      minVol24h.value = null;
      maxVol24h.value = null;
      minMcap.value = null;
      maxMcap.value = null;
      onlyFavs.value = false;
    };

    const sortBy = (key) => {
      if (sortKey.value === key) {
        sortDir.value *= -1;
      } else {
        sortKey.value = key;
        sortDir.value = key === 'symbol' ? 1 : -1;
      }
    };

    const getSortIcon = (key) => {
      if (sortKey.value !== key) return 'bi bi-arrow-down-up opacity-25';
      return sortDir.value === 1 ? 'bi bi-caret-up-fill' : 'bi bi-caret-down-fill';
    };

    const toggleFav = (sym) => {
      if (favs.has(sym)) favs.delete(sym);
      else favs.add(sym);
      store.set('favs', [...favs]);
    };

    const isFav = (sym) => favs.has(sym);

    const isVisited = (sym) => visitedSymbols.has(sym);
    const markVisited = (sym) => {
      if (!visitedSymbols.has(sym)) {
        visitedSymbols.add(sym);
        store.set('visitedSymbols', [...visitedSymbols]);
      }
    };

    /* Клик по паре: открыть её на графике слева */
    const selectToken = (row) => {
      activeSymbol.value = row.sym;
      markVisited(row.sym);
      if (window.ChartAPI) window.ChartAPI.load(row.sym);
    };

    const isBlocked = (sym) => blockedSymbols.has(sym);
    const toggleBlock = (sym) => {
      if (blockedSymbols.has(sym)) {
        blockedSymbols.delete(sym);
      } else {
        blockedSymbols.add(sym);
        filterMemory.delete(sym);
      }
      store.set('blockedSymbols', [...blockedSymbols]);
    };
    const openBlocklistModal = () => { showBlocklistModal.value = true; };
    const closeBlocklistModal = () => { showBlocklistModal.value = false; };
    const blockedList = computed(() => Array.from(blockedSymbols));

    const showPreview = (event, row) => {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        const width = 190, height = 70;
        let x = event.clientX + 15;
        let y = event.clientY + 15;
        if (x + width > window.innerWidth - 10) x = event.clientX - width - 15;
        if (y + height > window.innerHeight - 10) y = event.clientY - height - 15;
        previewX.value = x;
        previewY.value = y;
        previewRow.value = row;
      }, 150);
    };

    const hidePreview = () => {
      clearTimeout(previewTimer);
      previewRow.value = null;
    };

    const showNotification = (title, body) => {
      if (Notification.permission === 'granted') {
        new Notification(title, { body });
      }
    };

    const flashTitle = (symbol) => {
      if (titleFlashInterval) clearInterval(titleFlashInterval);
      let count = 0;
      const maxFlashes = 6;
      titleFlashInterval = setInterval(() => {
        document.title = count % 2 === 0 ? `⚡ Alert: ${symbol}` : originalTitle;
        count++;
        if (count >= maxFlashes) {
          clearInterval(titleFlashInterval);
          document.title = originalTitle;
        }
      }, 300);
    };

    const ensureAudioCtx = () => {
      if (!audioCtx) {
        try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
      }
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      return audioCtx;
    };

    const playFireAlert = () => {
      const ctx = ensureAudioCtx();
      if (!ctx) return;
      const now0 = ctx.currentTime;
      const playTone = (freq, start, dur, peak) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(freq, now0 + start);
        gain.gain.setValueAtTime(0.0001, now0 + start);
        gain.gain.exponentialRampToValueAtTime(peak, now0 + start + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, now0 + start + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now0 + start);
        osc.stop(now0 + start + dur + 0.02);
      };
      playTone(1046.5, 0, 0.11, 0.30);
      playTone(1567.98, 0.09, 0.16, 0.28);
    };

    const checkFireAlerts = () => {
      const thr = parseNum(fireThreshold.value);
      if (thr === null || thr <= 0) {
        if (firedSymbols.size) firedSymbols.clear();
        return;
      }
      const rows = filteredRows.value;
      const currentlyFiring = new Set();
      let newlyFired = false;
      for (const r of rows) {
        if (!r.isFire) continue;
        currentlyFiring.add(r.sym);
        if (!firedSymbols.has(r.sym)) newlyFired = true;
      }
      firedSymbols.clear();
      for (const sym of currentlyFiring) firedSymbols.add(sym);
      if (newlyFired) playFireAlert();
    };

    const checkAlerts = () => {
      if (!hasFilters.value) return;
      const minC1m = parseNum(minChg1m.value);
      const minC5m = parseNum(minChg5m.value);
      if (minC1m === null && minC5m === null) return;

      const now = Date.now();
      for (const [sym, e] of marketData) {
        if (e.lastP === null) continue;
        if (blockedSymbols.has(sym)) continue;
        const m1m = windowMetrics(e, 60000, now);
        const chg1m = pctChange(e.price, m1m.price);
        const m5m = windowMetrics(e, 300000, now);
        const chg5m = pctChange(e.price, m5m.price);

        if (minC1m !== null) {
          if (chg1m !== null && Math.abs(chg1m) >= minC1m) {
            if (!alertedChg1m.has(sym)) {
              alertedChg1m.add(sym);
              showNotification('Alert: ' + sym, `1m change: ${chg1m.toFixed(2)}%`);
              flashTitle(sym);
            }
          } else {
            alertedChg1m.delete(sym);
          }
        }

        if (minC5m !== null) {
          if (chg5m !== null && Math.abs(chg5m) >= minC5m) {
            if (!alertedChg5m.has(sym)) {
              alertedChg5m.add(sym);
              showNotification('Alert: ' + sym, `5m change: ${chg5m.toFixed(2)}%`);
              flashTitle(sym);
            }
          } else {
            alertedChg5m.delete(sym);
          }
        }
      }
    };

    const processMcapFallbackQueue = async () => {
      if (mcapFallbackQueueRunning) return;
      mcapFallbackQueueRunning = true;
      try {
        const now = Date.now();
        const seen = new Set();
        const candidates = [];
        for (const r of baseFilteredRows.value) {
          if (r.mcap !== null) continue;
          if (seen.has(r.base)) continue;
          seen.add(r.base);
          const lastTried = mcapFallbackTried.get(r.base);
          if (lastTried && now - lastTried < MCAP_FALLBACK_RETRY_TTL) continue;
          candidates.push(r.base);
        }
        const batch = candidates.slice(0, MCAP_FALLBACK_BATCH);
        for (const base of batch) {
          mcapFallbackTried.set(base, now);
          mcapPendingSymbols.add(base);
          try {
            await fetchFallbackMcapForBase(base);
          } finally {
            mcapPendingSymbols.delete(base);
          }
        }
      } finally {
        mcapFallbackQueueRunning = false;
      }
    };

    watch([minChg1m, maxChg1m, minChg5m, maxChg5m], () => {
      alertedChg1m.clear();
      alertedChg5m.clear();
    });

    watch(fireThreshold, v => {
      store.set('fireThreshold', v);
      firedSymbols.clear();
    });

    watch(selectedQuote, v => store.set('quote', v));
    watch(onlyFavs, v => store.set('onlyFavs', v));
    watch(searchQuery, v => store.set('search', v));
    watch([sortKey, sortDir], ([k, d]) => {
      store.set('sortKey', k);
      store.set('sortDir', d);
    });

    watch([minPrice, maxPrice, minVol1m, maxVol1m, minChg1m, maxChg1m, minChg5m, maxChg5m, minVol24h, maxVol24h, minMcap, maxMcap], () => {
      filterMemory.clear();
    });

    const onKeydown = (e) => {
      const tag = document.activeElement ? document.activeElement.tagName : '';
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) {
        e.preventDefault();
        if (searchEl.value) searchEl.value.focus();
      }
    };

    const onVisibility = () => {
      if (!document.hidden && connectionStatus.value === 'bad') connect();
    };

    const unlockAudio = () => { ensureAudioCtx(); };

    onMounted(() => {
      /* Синхронизация активного символа при смене символа вручную через поле ввода графика */
      window.onChartSymbolChanged = (sym) => { activeSymbol.value = sym; };

      connect();
      fetchVolume24h();
      timers.push(setInterval(fetchVolume24h, 300000));
      timers.push(setInterval(refreshMarketCaps, MCAP_CACHE_TTL));
      timers.push(setInterval(processMcapFallbackQueue, MCAP_FALLBACK_INTERVAL));
      timers.push(setInterval(() => { if (!isPaused.value) uiTick.value++; }, 300));
      timers.push(setInterval(() => {
        const rate = entryCount;
        entryCount = 0;
        const avgLatency = latencyN > 0 ? Math.max(0, Math.round(latencySum / latencyN)) : null;
        latencySum = 0;
        latencyN = 0;
        if (connectionStatus.value === 'live') {
          uptimeSec.value = Math.round((Date.now() - connectedAt) / 1000);
          if (Date.now() - lastMsgAt > 15000) {
            connectionStatus.value = 'bad';
            statusText.value = 'Stalled';
            try { ws.close(); } catch {}
          }
        }
        if (isPaused.value) return;
        ups.value = rate;
        if (avgLatency !== null) latencyMs.value = avgLatency;
        totalPairs.value = marketData.size;
      }, 1000));
      timers.push(setInterval(checkAlerts, 2000));
      timers.push(setInterval(checkFireAlerts, 400));
      document.addEventListener('click', unlockAudio, { once: true });
      document.addEventListener('keydown', unlockAudio, { once: true });
      timers.push(setInterval(() => {
        if (isPaused.value) return;
        const stale = Date.now() - 15 * 60 * 1000;
        for (const [sym, e] of marketData) {
          const last = e.history.length ? e.history[e.history.length - 1].t : 0;
          if (last && last < stale && !favs.has(sym) && !blockedSymbols.has(sym)) marketData.delete(sym);
        }
      }, 30000));
      window.addEventListener('keydown', onKeydown);
      document.addEventListener('visibilitychange', onVisibility);
    });

    onBeforeUnmount(() => {
      timers.forEach(clearInterval);
      window.removeEventListener('keydown', onKeydown);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('click', unlockAudio);
      document.removeEventListener('keydown', unlockAudio);
      if (ws) {
        try { ws.close(); } catch {}
      }
    });

    return {
      quotes: QUOTES,
      connectionStatus, statusText, latencyMs, fmtUptime,
      totalPairs, ups, leader, isPaused,
      searchQuery, searchEl, minPrice, maxPrice, minVol1m, maxVol1m, minChg1m, maxChg1m, minChg5m, maxChg5m, minVol24h, maxVol24h, minMcap, maxMcap, fireThreshold, fireActive, selectedQuote, onlyFavs,
      sortKey, sortDir, hasFilters, resetFilters,
      filteredRows, displayedRows,
      sortBy, getSortIcon, toggleFav, isFav,
      fmtPrice, fmtVol, fmtMCap, selectToken,
      showPreview, hidePreview, previewRow, previewX, previewY,
      isBlocked, toggleBlock, blockedList, openBlocklistModal, closeBlocklistModal, showBlocklistModal,
      isVisited, activeSymbol
    };
  }
}).mount('#app');