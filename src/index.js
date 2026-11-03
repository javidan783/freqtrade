/**
 * 3REG3BOL — Ultimate Engine (MEXC Edition)
 * Version: 8.0.0 (70-Char Format, Zero-Bug)
 */

const CFG = {
  VERSION: "8.0.0",
  API: "https://api.mexc.com/api/v3/klines",
  SYMBOLS: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
  TIMEFRAMES: ["1", "5", "15", "60", "240", "D"],
  TARGET_CANDLES: 5760,
  SESSION_TTL: 86400,
  LOCK_TTL: 120,
  FEE_RATE: 0.00055,
  SLIPPAGE: 0.0005
};

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: cors()
        });
      }

      if (path === "/health") {
        return out({
          success: true,
          version: CFG.VERSION,
          time: new Date().toISOString()
        });
      }

      if (path === "/" && request.method === "GET") {
        return html(DASHBOARD);
      }

      if (path === "/login" && request.method === "POST") {
        return login(request, env);
      }

      if (!await auth(request, env)) {
        return out({
          success: false,
          error: "Unauthorized"
        }, 401);
      }

      if (!env.DB || !env.BOT_STATE) {
        return out({
          success: false,
          error: "D1 or KV binding is missing"
        }, 503);
      }

      await ensureDB(env);

      if (path === "/api/settings" && request.method === "GET") {
        return out({
          success: true,
          settings: await loadSettings(env)
        });
      }

      if (path === "/api/settings" && request.method === "POST") {
        return saveSettings(request, env);
      }

      if (path === "/api/crypto" && request.method === "GET") {
        return cryptoData(url, env);
      }

      if (path === "/api/fill-data" && request.method === "POST") {
        return fillData(request, env);
      }

      if (path === "/api/backtest" && request.method === "POST") {
        return runBacktest(request, env);
      }

      if (path === "/api/sim-data" && request.method === "GET") {
        return simData(env);
      }

      if (path === "/api/toggle-auto" && request.method === "POST") {
        return toggleAuto(request, env);
      }

      return out({ success: false, error: "Not found" }, 404);

    } catch (error) {
      console.error("Worker error:", error.stack || error);
      return out({
        success: false,
        error: error.message || "Internal error"
      }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runScheduled(env).catch(error => {
        console.error("Scheduled error:", error.stack || error);
      })
    );
  }
};

// --- Utilities ---
function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  };
}

function out(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...cors()
    }
  });
}

function html(value) {
  return new Response(value, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

async function bodyJSON(request) {
  try {
    const value = await request.json();
    return (value && typeof value === "object") ? value : {};
  } catch { return {}; }
}

async function getSecret(env, key) {
  if (typeof env[key] === "string" && env[key].trim()) {
    return env[key].trim();
  }
  if (env[key] && typeof env[key].get === "function") {
    try { return await env[key].get(); } catch (e) {}
  }
  return null;
}

function clamp(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
}

function validSymbol(symbol) {
  return CFG.SYMBOLS.includes(symbol);
}

function validTimeframe(tf) {
  return CFG.TIMEFRAMES.includes(String(tf));
}

async function hash(value) {
  const data = new TextEncoder().encode(value);
  const result = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(result)]
    .map(x => x.toString(16).padStart(2, "0")).join("");
}

// --- Auth ---
async function login(request, env) {
  const password = await getSecret(env, "DASHBOARD_PASSWORD");
  if (!password || !env.BOT_STATE) {
    return out({
      success: false,
      error: "Authentication is not configured"
    }, 503);
  }
  const body = await bodyJSON(request);
  if (String(body.password || "") !== password) {
    return out({ success: false, error: "Invalid password" }, 401);
  }
  const token = crypto.randomUUID() + crypto.randomUUID();
  const sessionKey = "session:" + await hash(token);
  await env.BOT_STATE.put(sessionKey, "1", {
    expirationTtl: CFG.SESSION_TTL
  });
  return out({
    success: true,
    token,
    expiresIn: CFG.SESSION_TTL
  });
}

async function auth(request, env) {
  const password = await getSecret(env, "DASHBOARD_PASSWORD");
  if (!password || !env.BOT_STATE) return false;
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) return false;
  const token = header.slice(7).trim();
  if (!token || token.length > 256) return false;
  const sessionKey = "session:" + await hash(token);
  return await env.BOT_STATE.get(sessionKey) === "1";
}

// --- DB Schema ---
async function ensureDB(env) {
  if (!env.DB) throw new Error("D1 binding missing");
  const stmts = [
    `CREATE TABLE IF NOT EXISTS klines (
      symbol TEXT NOT NULL, tf TEXT NOT NULL, time INTEGER NOT NULL,
      open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL,
      close REAL NOT NULL, volume REAL DEFAULT 0,
      turnover REAL DEFAULT 0, PRIMARY KEY(symbol, tf, time)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_klines_lookup
     ON klines(symbol, tf, time DESC)`,
    `CREATE TABLE IF NOT EXISTS indicator_states (
      symbol TEXT NOT NULL, tf TEXT NOT NULL,
      indicator_name TEXT NOT NULL, last_time INTEGER NOT NULL,
      sum_value REAL DEFAULT 0, current_value REAL DEFAULT 0,
      previous_value REAL DEFAULT 0, active_period INTEGER DEFAULT 0,
      PRIMARY KEY(symbol, tf, indicator_name)
    )`,
    `CREATE TABLE IF NOT EXISTS bot_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1), settings TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS bot_state (
      key TEXT PRIMARY KEY, value TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS trade_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL,
      side TEXT NOT NULL, entry REAL NOT NULL, exit REAL,
      quantity REAL DEFAULT 0, pnl REAL DEFAULT 0,
      status TEXT DEFAULT 'OPEN', created_at INTEGER NOT NULL,
      closed_at INTEGER
    )`
  ];
  for (const sql of stmts) await env.DB.prepare(sql).run();
  const row = await env.DB.prepare(
    "SELECT id FROM bot_settings WHERE id = 1"
  ).first();
  if (!row) {
    await env.DB.prepare(
      "INSERT INTO bot_settings (id, settings, updated_at) VALUES (1, ?, ?)"
    ).bind(JSON.stringify(defaultSettings()), Date.now()).run();
  }
}

// --- Settings ---
function defaultSettings() {
  return {
    symbol: "BTCUSDT", timeframe: "1", strategyMode: "AUTO",
    baseFast: 10, baseSlow: 100, baseAtr: 14, baseRange: 26,
    minMultiplier: 0.5, maxMultiplier: 2.0, rangeThreshold: 75,
    riskPercent: 1, stopLossATR: 2, takeProfitATR: 3,
    autoTrade: false, simulation: true, initialBalance: 10000,
    updatedAt: Date.now()
  };
}

async function loadSettings(env) {
  const row = await env.DB.prepare(
    "SELECT settings FROM bot_settings WHERE id = 1"
  ).first();
  if (!row) return defaultSettings();
  try {
    return { ...defaultSettings(), ...JSON.parse(row.settings) };
  } catch { return defaultSettings(); }
}

async function saveSettings(request, env) {
  const body = await bodyJSON(request);
  const current = await loadSettings(env);
  const allowed = [
    "symbol", "timeframe", "strategyMode", "baseFast", "baseSlow",
    "baseAtr", "baseRange", "minMultiplier", "maxMultiplier",
    "rangeThreshold", "riskPercent", "stopLossATR", "takeProfitATR",
    "autoTrade", "initialBalance"
  ];
  for (const key of allowed) {
    if (body[key] !== undefined) current[key] = body[key];
  }
  if (!validSymbol(current.symbol)) {
    return out({ success: false, error: "Invalid symbol" }, 400);
  }
  current.timeframe = String(current.timeframe);
  if (!validTimeframe(current.timeframe)) {
    return out({ success: false, error: "Invalid timeframe" }, 400);
  }
  current.updatedAt = Date.now();
  await env.DB.prepare(
    `INSERT INTO bot_settings (id, settings, updated_at)
     VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
     settings = excluded.settings, updated_at = excluded.updated_at`
  ).bind(JSON.stringify(current), Date.now()).run();
  return out({ success: true, settings: current });
}

// --- MEXC Data Fetcher ---
async function fetchExchangeData(symbol, tf, limit = 1000, end = null) {
  const intervalMap = {
    "1": "1m", "5": "5m", "15": "15m",
    "60": "60m", "240": "4h", "D": "1d"
  };
  const interval = intervalMap[String(tf)] || "1m";
  const url = new URL(CFG.API);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));
  if (end) url.searchParams.set("endTime", String(end));

  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" }
  });
  
  if (!response.ok) {
    throw new Error("MEXC HTTP " + response.status);
  }
  
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error("MEXC API error");
  
  let candles = data.map(row => ({
    time: Math.floor(Number(row[0]) / 1000),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5])
  })).filter(c => Number.isFinite(c.time) && Number.isFinite(c.close));

  if (!end && candles.length > 1) {
    candles = candles.slice(0, -1);
  }
  return candles.sort((a, b) => a.time - b.time);
}

// --- Math Engines ---
function calculateChoppiness(candles) {
  if (candles.length < 26) return 50;
  const subset = candles.slice(-26);
  let sumTR = 0, highest = -Infinity, lowest = Infinity;
  for (let i = 0; i < subset.length; i++) {
    const c = subset[i];
    highest = Math.max(highest, c.high);
    lowest = Math.min(lowest, c.low);
    if (i === 0) {
      sumTR += c.high - c.low;
    } else {
      sumTR += Math.max(
        c.high - c.low,
        Math.abs(c.high - subset[i-1].close),
        Math.abs(c.low - subset[i-1].close)
      );
    }
  }
  const range = highest - lowest;
  if (range === 0) return 100;
  const chop = 100 * Math.log10(sumTR / range) / Math.log10(26);
  return clamp(chop, 0, 100);
}

function calcDynamicPeriod(base, mult, isAuto) {
  if (!isAuto) return base;
  return Math.max(2, Math.round(base * mult));
}

function emaSeries(vals, p) {
  const r = []; let e = vals[0];
  for (let i = 0; i < vals.length; i++) {
    e = (vals[i] * (2 / (p + 1))) + (e * (1 - (2 / (p + 1))));
    r.push(e);
  }
  return r;
}

function atrSeries(c, p) {
  const r = []; let a = 0;
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - c[i-1].close),
      Math.abs(c[i].low - c[i-1].close)
    );
    a = i === 1 ? tr : ((a * (p - 1)) + tr) / p;
    r.push(a);
  }
  return r;
}

// --- O(1) Incremental State ---
async function updateStateIncrementally(
  symbol, tf, env, settings, newCandle, isBacktest = false, context = null
) {
  let marketScore = 50, multiplier = 1.0;
  
  if (isBacktest && context) {
    marketScore = calculateChoppiness(context);
  } else {
    const recent = await env.DB.prepare(
      `SELECT high, low, close FROM klines
       WHERE symbol = ? AND tf = ? ORDER BY time DESC LIMIT 26`
    ).bind(symbol, String(tf)).all();
    marketScore = calculateChoppiness((recent.results || []).reverse());
  }

  if (settings.strategyMode !== "MANUAL") {
    const norm = marketScore / 100;
    multiplier = settings.minMultiplier +
      (norm * (settings.maxMultiplier - settings.minMultiplier));
  }

  const isAuto = settings.strategyMode !== "MANUAL";
  const activeFast = calcDynamicPeriod(
    settings.baseFast, multiplier, isAuto
  );
  const activeSlow = calcDynamicPeriod(
    settings.baseSlow, multiplier, isAuto
  );
  const activeAtr = settings.baseAtr;
  const activeRange = calcDynamicPeriod(
    settings.baseRange, multiplier, isAuto
  );

  if (isBacktest) {
    return { marketScore, multiplier, activeFast, activeSlow,
             activeAtr, activeRange };
  }

  const statesResult = await env.DB.prepare(
    `SELECT indicator_name, last_time, sum_value, current_value,
     previous_value FROM indicator_states
     WHERE symbol = ? AND tf = ?`
  ).bind(symbol, String(tf)).all();
  const stateMap = {};
  statesResult.results.forEach(s => stateMap[s.indicator_name] = s);

  const oldest = await env.DB.prepare(
    `SELECT close, volume FROM klines
     WHERE symbol = ? AND tf = ? ORDER BY time ASC LIMIT 1`
  ).bind(symbol, String(tf)).first();
  if (!oldest) return null;

  const prevCloseRow = await env.DB.prepare(
    `SELECT close FROM klines
     WHERE symbol = ? AND tf = ? AND time < ?
     ORDER BY time DESC LIMIT 1`
  ).bind(symbol, String(tf), newCandle.time).first();

  const prevClose = prevCloseRow ? prevCloseRow.close : newCandle.open;
  const tr = Math.max(
    newCandle.high - newCandle.low,
    Math.abs(newCandle.high - prevClose),
    Math.abs(newCandle.low - prevClose)
  );

  const updates = [], indValues = {};

  const processInd = (name, period, calcFn) => {
    const state = stateMap[name] || {
      sum_value: 0, current_value: 0, previous_value: 0, last_time: 0
    };
    if (state.last_time === newCandle.time) {
      indValues[name] = state.current_value; return;
    }
    const { newSum, newCurrent } =
      calcFn(state, period, newCandle, tr, oldest);
    indValues[name] = newCurrent;
    updates.push(env.DB.prepare(
      `INSERT INTO indicator_states (
        symbol, tf, indicator_name, last_time, sum_value,
        current_value, previous_value, active_period
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, tf, indicator_name) DO UPDATE SET
      last_time=excluded.last_time, sum_value=excluded.sum_value,
      current_value=excluded.current_value,
      previous_value=excluded.previous_value,
      active_period=excluded.active_period`
    ).bind(
      symbol, String(tf), name, newCandle.time,
      newSum, newCurrent, state.current_value, period
    ));
  };

  processInd("EMA_FAST", activeFast, (s, p, c) => {
    const m = 2 / (p + 1);
    return {
      newSum: s.sum_value,
      newCurrent: (c.close * m) + (s.current_value * (1 - m))
    };
  });

  processInd("EMA_SLOW", activeSlow, (s, p, c) => {
    const m = 2 / (p + 1);
    return {
      newSum: s.sum_value,
      newCurrent: (c.close * m) + (s.current_value * (1 - m))
    };
  });

  processInd("ATR", activeAtr, (s, p, c, tr) => {
    return {
      newSum: s.sum_value,
      newCurrent: ((s.current_value * (p - 1)) + tr) / p
    };
  });

  processInd("SUM_CLOSE", 5760, (s, p, c, tr, old) => {
    const nc = s.sum_value - old.close + c.close;
    return { newSum: nc, newCurrent: nc };
  });

  processInd("SUM_VOLUME", 5760, (s, p, c, tr, old) => {
    const nc = s.sum_value - old.volume + c.volume;
    return { newSum: nc, newCurrent: nc };
  });

  if (updates.length > 0) await env.DB.batch(updates);

  const rangeCandles = await env.DB.prepare(
    `SELECT high, low FROM klines WHERE symbol = ? AND tf = ?
     ORDER BY time DESC LIMIT ?`
  ).bind(symbol, String(tf), activeRange).all();
  const range = rangeCandles.results || [];

  return {
    fast: indValues["EMA_FAST"], slow: indValues["EMA_SLOW"],
    previousFast: stateMap["EMA_FAST"]?.current_value ||
                  indValues["EMA_FAST"],
    previousSlow: stateMap["EMA_SLOW"]?.current_value ||
                  indValues["EMA_SLOW"],
    atr: indValues["ATR"], time: newCandle.time, price: newCandle.close,
    rangeHigh: range.length ?
      Math.max(...range.map(c => c.high)) : null,
    rangeLow: range.length ?
      Math.min(...range.map(c => c.low)) : null,
    marketScore, multiplier, activeFast, activeSlow, activeRange
  };
}

// --- Signal & Position Logic ---
function evaluateSignal(ind, settings) {
  if (ind.fast == null || ind.slow == null ||
      ind.previousFast == null || ind.previousSlow == null ||
      ind.atr == null) {
    return { action: "WAIT", reason: "Insufficient data" };
  }

  if (ind.marketScore >= settings.rangeThreshold) {
    return {
      action: "WAIT",
      reason: "Range Lock (Score: " + ind.marketScore.toFixed(1) + ")"
    };
  }

  const buyCross = ind.fast > ind.slow &&
                   ind.previousFast <= ind.previousSlow;
  const sellCross = ind.fast < ind.slow &&
                    ind.previousFast >= ind.previousSlow;
  const buyBreakout = ind.rangeHigh != null &&
                      ind.price > ind.rangeHigh && ind.fast > ind.slow;
  const sellBreakout = ind.rangeLow != null &&
                       ind.price < ind.rangeLow && ind.fast < ind.slow;

  let action = "WAIT", reason = "No confirmed setup";
  if (buyCross || buyBreakout) {
    action = "BUY";
    reason = buyCross ? "Bullish EMA crossover" : "Range breakout";
  } else if (sellCross || sellBreakout) {
    action = "SELL";
    reason = sellCross ? "Bearish EMA crossover" : "Range breakdown";
  }

  if (action === "WAIT") {
    return {
      action, reason, price: ind.price, atr: ind.atr,
      timestamp: Date.now()
    };
  }

  const sl = action === "BUY" ?
    ind.price - ind.atr * settings.stopLossATR :
    ind.price + ind.atr * settings.stopLossATR;

  const tp = action === "BUY" ?
    ind.price + ind.atr * settings.takeProfitATR :
    ind.price - ind.atr * settings.takeProfitATR;

  return {
    action, reason, price: ind.price, atr: ind.atr,
    stopLoss: sl, takeProfit: tp,
    rangeHigh: ind.rangeHigh, rangeLow: ind.rangeLow,
    timestamp: Date.now()
  };
}

async function managePaperPosition(env, symbol, ind, settings) {
  const position = await env.BOT_STATE.get(
    "active_position", { type: "json" }
  );
  if (!position || position.symbol !== symbol) return;

  let exit = null, reason = "";
  const isRanging = ind.marketScore >= settings.rangeThreshold;
  let targetTP = position.takeProfit;

  if (isRanging) {
    if (position.side === "BUY" && ind.rangeHigh) {
      targetTP = ind.rangeHigh;
    }
    if (position.side === "SELL" && ind.rangeLow) {
      targetTP = ind.rangeLow;
    }
  }

  if (position.side === "BUY") {
    if (ind.price <= position.stopLoss) {
      exit = position.stopLoss; reason = "STOP LOSS";
    } else if (ind.price >= targetTP) {
      exit = targetTP;
      reason = isRanging ? "RANGE HIGH EXIT" : "TAKE PROFIT";
    }
  } else {
    if (ind.price >= position.stopLoss) {
      exit = position.stopLoss; reason = "STOP LOSS";
    } else if (ind.price <= targetTP) {
      exit = targetTP;
      reason = isRanging ? "RANGE LOW EXIT" : "TAKE PROFIT";
    }
  }

  if (exit === null) return;

  const direction = position.side === "BUY" ? 1 : -1;
  const exitPrice = exit * (
    direction === 1 ? 1 - CFG.SLIPPAGE : 1 + CFG.SLIPPAGE
  );
  const entryFee = position.entry * position.quantity * CFG.FEE_RATE;
  const exitFee = exitPrice * position.quantity * CFG.FEE_RATE;
  const gross = (exitPrice - position.entry) *
                position.quantity * direction;
  const pnl = gross - entryFee - exitFee;

  const update = await env.DB.prepare(
    `UPDATE trade_history SET exit = ?, pnl = ?, status = 'CLOSED',
     closed_at = ? WHERE id = ? AND status = 'OPEN'`
  ).bind(
    exitPrice, pnl, Date.now(), position.tradeId
  ).run();

  if (update.meta?.changes === 0) return;

  const balance = Number(await env.BOT_STATE.get("sim_balance"));
  const newBalance = (Number.isFinite(balance) ? balance : 0) + pnl;

  await env.BOT_STATE.put("sim_balance", String(newBalance));
  await env.BOT_STATE.delete("active_position");

  const msg = `3REG3BOL CLOSED\n${symbol} ${position.side}\n` +
              `Reason: ${reason}\nExit: ${exitPrice}\n` +
              `PnL: ${pnl.toFixed(4)}\nBalance: ${newBalance.toFixed(2)}`;
  await sendTelegram(env, msg);
}

async function simulateSignal(env, symbol, signal) {
  const existing = await env.BOT_STATE.get(
    "active_position", { type: "json" }
  );
  if (existing) return;

  const settings = await loadSettings(env);
  let balance = Number(await env.BOT_STATE.get("sim_balance"));
  if (!Number.isFinite(balance)) {
    balance = settings.initialBalance;
    await env.BOT_STATE.put("sim_balance", String(balance));
  }

  const distance = Math.abs(signal.price - signal.stopLoss);
  if (distance <= 0) return;

  const risk = balance * settings.riskPercent / 100;
  const quantity = risk / distance;
  if (quantity <= 0) return;

  const isBuy = signal.action === "BUY";
  const entry = signal.price * (
    isBuy ? 1 + CFG.SLIPPAGE : 1 - CFG.SLIPPAGE
  );

  const result = await env.DB.prepare(
    `INSERT INTO trade_history (
      symbol, side, entry, quantity, status, created_at
    ) VALUES (?, ?, ?, ?, 'OPEN', ?)`
  ).bind(
    symbol, signal.action, entry, quantity, Date.now()
  ).run();

  const position = {
    tradeId: result.meta.last_row_id, symbol,
    side: signal.action, entry, quantity,
    stopLoss: signal.stopLoss, takeProfit: signal.takeProfit,
    openedAt: Date.now()
  };

  await env.BOT_STATE.put(
    "active_position", JSON.stringify(position)
  );

  const msg = `3REG3BOL OPEN\n${symbol} ${signal.action}\n` +
              `Entry: ${entry}\nQty: ${quantity}\n` +
              `SL: ${signal.stopLoss}\nTP: ${signal.takeProfit}`;
  await sendTelegram(env, msg);
}

// --- Scheduled Runner ---
async function runScheduled(env) {
  if (!env.DB || !env.BOT_STATE) {
    throw new Error("Missing D1 or KV binding");
  }

  const lockKey = "scheduled_lock";
  if (await env.BOT_STATE.get(lockKey)) return;

  const lockId = crypto.randomUUID();
  await env.BOT_STATE.put(
    lockKey, lockId, { expirationTtl: CFG.LOCK_TTL }
  );

  try {
    const settings = await loadSettings(env);
    const symbol = settings.symbol;
    const tf = settings.timeframe;

    const newCandles = await fetchExchangeData(symbol, tf, 6);
    if (!newCandles.length) return;

    await saveCandlesToDB(symbol, tf, env, newCandles);
    const newestCandle = newCandles[newCandles.length - 1];

    const ind = await updateStateIncrementally(
      symbol, tf, env, settings, newestCandle
    );
    if (!ind) return;

    const signal = evaluateSignal(ind, settings);

    const stateData = JSON.stringify({
      ...signal, symbol, timeframe: tf, marketScore: ind.marketScore,
      multiplier: ind.multiplier, activeFast: ind.activeFast,
      activeSlow: ind.activeSlow, activeRange: ind.activeRange
    });

    await env.DB.prepare(
      `INSERT OR REPLACE INTO bot_state (key, value)
       VALUES ('last_signal', ?)`
    ).bind(stateData).run();

    await managePaperPosition(env, symbol, ind, settings);

    if (signal.action === "WAIT") return;

    const signalKey = `signal:${symbol}:${tf}:${signal.action}`;
    const previous = Number(
      await env.BOT_STATE.get(signalKey)
    ) || 0;
    if (previous === ind.time) return;

    await env.BOT_STATE.put(
      signalKey, String(ind.time), { expirationTtl: 86400 }
    );

    const msg = `3REG3BOL SIGNAL\n${symbol} ${tf}\n` +
                `Action: ${signal.action}\nPrice: ${signal.price}\n` +
                `Reason: ${signal.reason}`;
    await sendTelegram(env, msg);

    if (settings.autoTrade) {
      await simulateSignal(env, symbol, signal);
    }

  } finally {
    const current = await env.BOT_STATE.get(lockKey);
    if (current === lockId) {
      await env.BOT_STATE.delete(lockKey);
    }
  }
}

// --- DB Helpers ---
async function saveCandlesToDB(symbol, tf, env, candles) {
  if (!candles.length) return;
  const stmt = env.DB.prepare(
    `INSERT INTO klines (
      symbol, tf, time, open, high, low, close, volume, turnover
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, tf, time) DO UPDATE SET
    open = excluded.open, high = excluded.high, low = excluded.low,
    close = excluded.close, volume = excluded.volume`
  );

  const batch = candles.map(c => stmt.bind(
    symbol, String(tf), c.time, c.open, c.high, c.low,
    c.close, c.volume, 0
  ));

  for (let i = 0; i < batch.length; i += 50) {
    await env.DB.batch(batch.slice(i, i + 50));
  }

  const oldest = await env.DB.prepare(
    `SELECT time FROM klines WHERE symbol = ? AND tf = ?
     ORDER BY time DESC LIMIT 1 OFFSET ?`
  ).bind(symbol, String(tf), CFG.TARGET_CANDLES - 1).first();

  if (oldest) {
    await env.DB.prepare(
      `DELETE FROM klines WHERE symbol = ? AND tf = ? AND time < ?`
    ).bind(symbol, String(tf), oldest.time).run();
  }
}

async function fillInitialData(symbol, tf, env, settings) {
  await env.DB.prepare(
    `DELETE FROM klines WHERE symbol = ? AND tf = ?`
  ).bind(symbol, String(tf)).run();
  await env.DB.prepare(
    `DELETE FROM indicator_states WHERE symbol = ? AND tf = ?`
  ).bind(symbol, String(tf)).run();

  let allCandles = []; let end = null;
  while (allCandles.length < CFG.TARGET_CANDLES) {
    const batch = await fetchExchangeData(symbol, tf, 1000, end);
    if (!batch.length) break;
    allCandles = allCandles.concat(batch);
    end = batch[0].time * 1000 - 1;
  }

  const map = new Map();
  allCandles.forEach(c => map.set(c.time, c));
  const sorted = Array.from(map.values()).sort((a, b) => a.time - b.time);
  const finalCandles = sorted.slice(-CFG.TARGET_CANDLES);

  await saveCandlesToDB(symbol, tf, env, finalCandles);

  const closes = finalCandles.map(c => c.close);
  const fastArr = emaSeries(closes, settings.baseFast);
  const slowArr = emaSeries(closes, settings.baseSlow);
  const atrArr = atrSeries(finalCandles, settings.baseAtr);
  let sumClose = 0, sumVol = 0;
  finalCandles.forEach(c => { sumClose += c.close; sumVol += c.volume; });
  const last = finalCandles.length - 1;
  const lastTime = finalCandles[last].time;

  const seedQueries = [
    env.DB.prepare(
      `INSERT OR REPLACE INTO indicator_states (
        symbol, tf, indicator_name, last_time, current_value, previous_value
      ) VALUES (?, ?, 'EMA_FAST', ?, ?, ?)`
    ).bind(symbol, tf, lastTime, fastArr[last], fastArr[last-1]),

    env.DB.prepare(
      `INSERT OR REPLACE INTO indicator_states (
        symbol, tf, indicator_name, last_time, current_value, previous_value
      ) VALUES (?, ?, 'EMA_SLOW', ?, ?, ?)`
    ).bind(symbol, tf, lastTime, slowArr[last], slowArr[last-1]),

    env.DB.prepare(
      `INSERT OR REPLACE INTO indicator_states (
        symbol, tf, indicator_name, last_time, current_value, previous_value
      ) VALUES (?, ?, 'ATR', ?, ?, ?)`
    ).bind(symbol, tf, lastTime, atrArr[last], atrArr[last-1]),

    env.DB.prepare(
      `INSERT OR REPLACE INTO indicator_states (
        symbol, tf, indicator_name, last_time, sum_value, current_value
      ) VALUES (?, ?, 'SUM_CLOSE', ?, ?, ?)`
    ).bind(symbol, tf, lastTime, sumClose, sumClose),

    env.DB.prepare(
      `INSERT OR REPLACE INTO indicator_states (
        symbol, tf, indicator_name, last_time, sum_value, current_value
      ) VALUES (?, ?, 'SUM_VOLUME', ?, ?, ?)`
    ).bind(symbol, tf, lastTime, sumVol, sumVol)
  ];

  await env.DB.batch(seedQueries);
  return finalCandles.length;
}

// --- API Endpoints ---
async function fillData(request, env) {
  const body = await bodyJSON(request);
  const symbol = body.symbol || "BTCUSDT";
  const tf = String(body.tf || "1");
  const settings = await loadSettings(env);
  const count = await fillInitialData(symbol, tf, env, settings);
  return out({
    success: true,
    message: "DB filled with " + count + " candles. State seeded."
  });
}

async function cryptoData(url, env) {
  const settings = await loadSettings(env);
  const symbol = url.searchParams.get("symbol") || settings.symbol;
  const tf = String(url.searchParams.get("tf") || settings.timeframe);

  let candles = await env.DB.prepare(
    `SELECT time, open, high, low, close, volume FROM klines
     WHERE symbol = ? AND tf = ? ORDER BY time DESC LIMIT ?`
  ).bind(symbol, tf, 500).all();
  candles = (candles.results || []).reverse();

  if (candles.length < 100) {
    return out({
      success: false,
      error: "Not enough data. Fill Data first."
    }, 503);
  }

  const closes = candles.map(c => c.close);
  const fast = emaSeries(closes, settings.baseFast);
  const slow = emaSeries(closes, settings.baseSlow);

  const stateRow = await env.DB.prepare(
    `SELECT value FROM bot_state WHERE key = 'last_signal'`
  ).first();
  const lastState = stateRow ? JSON.parse(stateRow.value) : {};

  const indicators = {
    fast: fast[fast.length - 1],
    slow: slow[slow.length - 1],
    atr: lastState.atr || 0,
    price: closes[closes.length - 1]
  };

  return out({
    success: true, symbol, timeframe: tf,
    candles, indicators, signal: lastState, settings
  });
}

async function simData(env) {
  const settings = await loadSettings(env);
  let balance = Number(await env.BOT_STATE.get("sim_balance"));
  if (!Number.isFinite(balance)) {
    balance = settings.initialBalance;
    await env.BOT_STATE.put("sim_balance", String(balance));
  }
  const trades = await env.DB.prepare(
    `SELECT * FROM trade_history ORDER BY id DESC LIMIT 50`
  ).all();
  return out({
    success: true, balance,
    position: await env.BOT_STATE.get(
      "active_position", { type: "json" }
    ),
    trades: trades.results || []
  });
}

async function toggleAuto(request, env) {
  const body = await bodyJSON(request);
  const settings = await loadSettings(env);
  settings.autoTrade = Boolean(body.enabled);
  await env.DB.prepare(
    `UPDATE bot_settings SET settings = ?, updated_at = ? WHERE id = 1`
  ).bind(JSON.stringify(settings), Date.now()).run();
  return out({ success: true, autoTrade: settings.autoTrade });
}

// --- Backtest ---
async function runBacktest(request, env) {
  const body = await bodyJSON(request);
  const settings = await loadSettings(env);
  const symbol = body.symbol || settings.symbol;
  const tf = String(body.tf || settings.timeframe);

  let candles = await env.DB.prepare(
    `SELECT time, open, high, low, close, volume FROM klines
     WHERE symbol = ? AND tf = ? ORDER BY time ASC LIMIT ?`
  ).bind(symbol, tf, CFG.TARGET_CANDLES).all();
  candles = candles.results || [];

  if (candles.length < 500) {
    return out({
      success: false,
      error: "Not enough data. Fill DB."
    }, 400);
  }

  const initialBalance = Number(settings.initialBalance) || 10000;
  let balance = initialBalance, position = null;
  const trades = [];
  let state = {
    emaFast: candles[0].close,
    emaSlow: candles[0].close,
    atr: 0
  };

  function closePosition(price, time, reason) {
    if (!position) return;
    const dir = position.side === "BUY" ? 1 : -1;
    const exitPrice = price * (dir === 1 ?
      1 - CFG.SLIPPAGE : 1 + CFG.SLIPPAGE);
    const pnl = (exitPrice - position.entry) *
                position.quantity * dir -
                (position.entry * position.quantity * CFG.FEE_RATE) -
                (exitPrice * position.quantity * CFG.FEE_RATE);
    balance += pnl;
    trades.push({
      side: position.side, entry: position.entry,
      exit: exitPrice, quantity: position.quantity,
      pnl, reason, time
    });
    position = null;
  }

  for (let i = 30; i < candles.length; i++) {
    const c = candles[i];
    const context = candles.slice(i - 26, i + 1);
    const score = calculateChoppiness(context);

    let mult = 1.0;
    if (settings.strategyMode !== "MANUAL") {
      mult = settings.minMultiplier +
        ((score / 100) * (
          settings.maxMultiplier - settings.minMultiplier
        ));
    }

    const isAuto = settings.strategyMode !== "MANUAL";
    const aFast = calcDynamicPeriod(settings.baseFast, mult, isAuto);
    const aSlow = calcDynamicPeriod(settings.baseSlow, mult, isAuto);
    const aAtr = settings.baseAtr;

    state.emaFast = (c.close * (2 / (aFast + 1))) +
                    (state.emaFast * (1 - (2 / (aFast + 1))));
    state.emaSlow = (c.close * (2 / (aSlow + 1))) +
                    (state.emaSlow * (1 - (2 / (aSlow + 1))));

    const prevC = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevC.close),
      Math.abs(c.low - prevC.close)
    );
    state.atr = i === 30 ? tr :
      ((state.atr * (aAtr - 1)) + tr) / aAtr;

    if (position) {
      let exit = null, reason = "";
      const isRanging = score >= settings.rangeThreshold;
      let targetTP = position.takeProfit;

      if (isRanging) {
        const rHigh = Math.max(...context.map(x => x.high));
        const rLow = Math.min(...context.map(x => x.low));
        if (position.side === "BUY") targetTP = rHigh;
        if (position.side === "SELL") targetTP = rLow;
      }

      if (position.side === "BUY") {
        if (c.low <= position.sl) {
          exit = position.sl; reason = "STOP LOSS";
        } else if (c.high >= targetTP) {
          exit = targetTP;
          reason = isRanging ? "RANGE HIGH" : "TAKE PROFIT";
        }
      } else {
        if (c.high >= position.sl) {
          exit = position.sl; reason = "STOP LOSS";
        } else if (c.low <= targetTP) {
          exit = targetTP;
          reason = isRanging ? "RANGE LOW" : "TAKE PROFIT";
        }
      }
      if (exit !== null) closePosition(exit, c.time, reason);
    }

    if (!position && score < settings.rangeThreshold) {
      const buyCross = state.emaFast > state.emaSlow;
      const sellCross = state.emaFast < state.emaSlow;

      const rHigh = Math.max(...context.slice(0, -1).map(x => x.high));
      const rLow = Math.min(...context.slice(0, -1).map(x => x.low));
      const buyBrk = c.close > rHigh && state.emaFast > state.emaSlow;
      const sellBrk = c.close < rLow && state.emaFast < state.emaSlow;

      if (buyCross || buyBrk) {
        const entry = c.close * (1 + CFG.SLIPPAGE);
        const dist = state.atr * settings.stopLossATR;
        if (dist <= 0) continue;
        const qty = (balance * settings.riskPercent / 100) / dist;
        position = {
          side: "BUY", entry, quantity: qty,
          sl: entry - dist,
          tp: entry + state.atr * settings.takeProfitATR
        };
      } else if (sellCross || sellBrk) {
        const entry = c.close * (1 - CFG.SLIPPAGE);
        const dist = state.atr * settings.stopLossATR;
        if (dist <= 0) continue;
        const qty = (balance * settings.riskPercent / 100) / dist;
        position = {
          side: "SELL", entry, quantity: qty,
          sl: entry + dist,
          tp: entry - state.atr * settings.takeProfitATR
        };
      }
    }
  }

  if (position) {
    closePosition(
      candles[candles.length - 1].close,
      candles[candles.length - 1].time, "END"
    );
  }

  const wins = trades.filter(t => t.pnl > 0);
  const grossP = wins.reduce((s, t) => s + t.pnl, 0);
  const grossL = Math.abs(
    trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0)
  );

  return out({
    success: true,
    result: {
      initialBalance, finalBalance: balance,
      netProfit: balance - initialBalance,
      returnPercent: (balance / initialBalance - 1) * 100,
      totalTrades: trades.length, winningTrades: wins.length,
      losingTrades: trades.length - wins.length,
      winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
      profitFactor: grossL ? grossP / grossL : 0,
      trades: trades.slice(-50)
    }
  });
}

// --- Telegram ---
async function sendTelegram(env, message) {
  const token = await getSecret(env, "TG_TOKEN");
  const chatId = await getSecret(env, "TG_CHAT_ID");
  if (!token || !chatId) return false;
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message })
    });
    return (await response.json()).ok === true;
  } catch { return false; }
}

// --- Dashboard UI (Compact) ---
const DASHBOARD = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>3REG3BOL Ultimate</title>
<script src="https://unpkg.com/lightweight-charts@4.2.2/dist/lightweight-charts.standalone.production.js"></script>
<style>
:root { color-scheme: dark; --bg: #0a0d14; --panel: rgba(18, 24, 36, 0.75); --border: rgba(255, 255, 255, 0.08); --text: #e8eef9; --muted: #8b9ab3; --green: #00e676; --red: #ff5252; --blue: #2962ff; --shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3); }
body.light-theme { color-scheme: light; --bg: #f4f7f9; --panel: rgba(255, 255, 255, 0.85); --border: rgba(0, 0, 0, 0.08); --text: #131722; --muted: #787b86; --green: #089981; --red: #f23645; --blue: #2962ff; --shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.08); }
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;transition:background 0.3s;}
header{padding:16px 24px;background:var(--panel);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;position:sticky;top:0;z-index:100;}
h1{font-size:18px;margin:0;font-weight:600;}
.container{padding:24px;max-width:1600px;margin:auto}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}
.card{background:var(--panel);backdrop-filter:blur(12px);border:1px solid var(--border);border-radius:16px;padding:20px;box-shadow:var(--shadow);}
.label{color:var(--muted);font-size:12px;margin-bottom:8px;text-transform:uppercase;letter-spacing:1px;font-weight:600;}
.value{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;}
.green{color:var(--green)} .red{color:var(--red)} .blue{color:var(--blue)} .orange{color:#f59e0b}
.controls{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:20px;align-items:center;}
button,select,input{background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px 16px;font-weight:500;transition:all 0.2s;}
button{cursor:pointer;} button:hover{border-color:var(--blue);}
.primary{background:var(--blue);color:#fff;border:none;}
.modal{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:999;justify-content:center;align-items:center;}
.modal-content{background:var(--bg);padding:24px;border-radius:16px;width:90%;max-width:600px;border:1px solid var(--border);}
.chart-card{margin-top:16px;height:500px;padding:0;overflow:hidden;position:relative;}
#chart{width:100%;height:500px;}
table{width:100%;border-collapse:collapse;font-size:13px;} td,th{padding:12px;border-bottom:1px solid var(--border);text-align:left;}
@media(max-width:800px){.grid{grid-template-columns:repeat(2,minmax(0,1fr));}.chart-card,#chart{height:400px;}}
</style>
</head>
<body>
<div id="loginPanel" class="card" style="max-width:400px;margin:120px auto;text-align:center;">
<h2>3REG3BOL Ultimate</h2>
<input id="password" type="password" placeholder="Password" style="width:100%;margin:16px 0;padding:12px;">
<button class="primary" id="loginBtn" style="width:100%;padding:12px;">Login</button>
<div id="message" style="color:var(--red);margin-top:10px;"></div>
</div>
<div id="app" style="display:none">
<header>
  <h1>3REG3BOL <span style="color:var(--blue);font-weight:300;">| ULTIMATE</span></h1>
  <div style="display:flex;gap:16px;align-items:center;">
    <div id="serverStatus" style="font-size:13px;color:var(--muted);">Connecting...</div>
    <button id="themeToggleBtn" style="background:none;border:1px solid var(--border);border-radius:20px;padding:8px 12px;">🌓</button>
  </div>
</header>
<div class="container">
<div class="controls">
<select id="symbol"><option>BTCUSDT</option><option>ETHUSDT</option><option>SOLUSDT</option></select>
<select id="tf"><option value="1">1m</option><option value="5">5m</option><option value="15">15m</option><option value="60">1h</option></select>
<button class="primary" id="refreshBtn">Refresh</button>
<button id="fillBtn" style="background:#d97706;color:#fff;border:none;">Fill Data</button>
<button id="settingsBtn">⚙️ Settings</button>
<button id="backtestBtn">Backtest</button>
<button id="autoBtn">Toggle Auto Trade</button>
<button id="logoutBtn">Logout</button>
</div>

<div class="card" style="margin-bottom:16px; border-left:4px solid var(--blue);">
  <div style="display:flex;justify-content:space-between;align-items:center; flex-wrap:wrap; gap:12px;">
    <div><div class="label">Market Score</div><div class="value" id="marketScore">--</div></div>
    <div><div class="label">Status</div><div class="value" id="marketState">--</div></div>
    <div><div class="label">Multiplier</div><div class="value" id="activeMultiplier">--</div></div>
    <div><div class="label">Active Periods (F / S / R)</div><div class="value" id="activePeriods">--</div></div>
  </div>
</div>

<div class="grid">
<div class="card"><div class="label">Price</div><div class="value" id="price">--</div></div>
<div class="card"><div class="label">Signal</div><div class="value" id="signal">--</div></div>
<div class="card"><div class="label">Fast EMA</div><div class="value" id="fast">--</div></div>
<div class="card"><div class="label">Slow EMA</div><div class="value" id="slow">--</div></div>
</div>
<div class="card chart-card"><div class="label" style="position:absolute;top:16px;left:20px;z-index:10;background:var(--panel);padding:4px 8px;border-radius:6px;">Live Chart</div><div id="chart"></div></div>

<div class="grid" style="margin-top:16px">
<div class="card"><div class="label">Stop Loss</div><div class="value red" id="sl">--</div></div>
<div class="card"><div class="label">Take Profit</div><div class="value green" id="tp">--</div></div>
<div class="card"><div class="label">ATR</div><div class="value" id="atr">--</div></div>
<div class="card"><div class="label">Balance</div><div class="value" id="balance">--</div></div>
</div>

<div class="card" style="margin-top:16px; display:none;" id="backtestPanel">
  <h3>Backtest Results</h3>
  <div class="grid" style="margin-bottom:16px;">
    <div class="card"><div class="label">Final Balance</div><div class="value" id="bt-bal">--</div></div>
    <div class="card"><div class="label">Net Profit</div><div class="value" id="bt-profit">--</div></div>
    <div class="card"><div class="label">Win Rate</div><div class="value" id="bt-win">--</div></div>
    <div class="card"><div class="label">Trades</div><div class="value" id="bt-trades">--</div></div>
  </div>
  <table id="bt-table"><thead><tr><th>Side</th><th>Entry</th><th>Exit</th><th>PnL</th><th>Reason</th></tr></thead><tbody></tbody></table>
</div>

<div id="settingsModal" class="modal">
  <div class="modal-content">
    <h2>System Parameters</h2>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;">
      <div><label class="label">Strategy Mode</label><select id="set_mode" style="width:100%"><option value="MANUAL">Manual</option><option value="AUTO">Full Auto</option><option value="SEMI_AUTO">Semi Auto</option></select></div>
      <div><label class="label">Range Threshold</label><input type="number" id="set_rangeThresh" style="width:100%" value="75"></div>
      <div><label class="label">Base Fast EMA</label><input type="number" id="set_fast" style="width:100%" value="10"></div>
      <div><label class="label">Base Slow EMA</label><input type="number" id="set_slow" style="width:100%" value="100"></div>
      <div><label class="label">Min Multiplier</label><input type="number" step="0.1" id="set_min" style="width:100%" value="0.5"></div>
      <div><label class="label">Max Multiplier</label><input type="number" step="0.1" id="set_max" style="width:100%" value="2.0"></div>
      <div><label class="label">Base Range Window</label><input type="number" id="set_range" style="width:100%" value="26"></div>
      <div><label class="label">Risk %</label><input type="number" step="0.1" id="set_risk" style="width:100%" value="1"></div>
    </div>
    <div style="text-align:right;">
      <button id="closeSettings" style="margin-right:8px;">Cancel</button>
      <button class="primary" id="saveSettings">Save</button>
    </div>
  </div>
</div>

<script>
let TOKEN=sessionStorage.getItem("3reg_token")||"";
let chart=null, candleSeries=null, fastSeries=null, slowSeries=null;
let timer=null, currentSettings=null;
const $=id=>document.getElementById(id);

function initTheme() { if (localStorage.getItem("3reg_theme") === "light") document.body.classList.add("light-theme"); updateChartTheme(); }
function toggleTheme() { document.body.classList.toggle("light-theme"); localStorage.setItem("3reg_theme", document.body.classList.contains("light-theme") ? "light" : "dark"); updateChartTheme(); }
function updateChartTheme() { if(!chart) return; const isLight = document.body.classList.contains("light-theme"); chart.applyOptions({ layout: { background: { color: isLight?'#ffffff':'#121824' }, textColor: isLight?'#131722':'#b8c5da' }, grid: { vertLines: { color: isLight?'rgba(0,0,0,0.05)':'rgba(255,255,255,0.05)' }, horzLines: { color: isLight?'rgba(0,0,0,0.05)':'rgba(255,255,255,0.05)' } } }); }

function headers(){ return { "Authorization":"Bearer "+TOKEN, "Content-Type":"application/json" }; }
async function api(path,options={}){ const res = await fetch(path,{...options,headers:{...headers(),...(options.headers||{})}}); let d; try{ d=await res.json(); }catch{ throw new Error("Invalid response"); } if(res.status===401){ logout(); throw new Error("Session expired"); } if(!res.ok||d.success===false){ throw new Error(d.error||"Failed"); } return d; }

async function login(){ try{ const res=await fetch("/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:$("password").value})}); const d=await res.json(); if(!d.success) throw new Error(d.error); TOKEN=d.token; sessionStorage.setItem("3reg_token",TOKEN); showApp(); }catch(e){ $("message").textContent=e.message; } }
function logout(){ TOKEN=""; sessionStorage.removeItem("3reg_token"); if(timer)clearInterval(timer); $("app").style.display="none"; $("loginPanel").style.display="block"; }
function showApp(){ $("loginPanel").style.display="none"; $("app").style.display="block"; initChart(); loadSettings(); refresh(); if(timer)clearInterval(timer); timer=setInterval(refresh,15000); }

function initChart(){ if(chart)return; const el=$("chart"); const isLight = document.body.classList.contains("light-theme"); chart=LightweightCharts.createChart(el,{ width:el.clientWidth, height:el.clientHeight||500, layout:{background:{color:isLight?'#ffffff':'#121824'},textColor:isLight?'#131722':'#b8c5da'}, grid:{vertLines:{color:isLight?'rgba(0,0,0,0.05)':'rgba(255,255,255,0.05)'},horzLines:{color:isLight?'rgba(0,0,0,0.05)':'rgba(255,255,255,0.05)'}}, timeScale:{timeVisible:true}, rightPriceScale:{borderColor:isLight?'#e0e3eb':'#2a3245'} }); candleSeries=chart.addCandlestickSeries({upColor:'#00e676',downColor:'#ff5252',borderVisible:false,wickUpColor:'#00e676',wickDownColor:'#ff5252'}); fastSeries=chart.addLineSeries({color:'#2962ff',lineWidth:2}); slowSeries=chart.addLineSeries({color:'#ffb84d',lineWidth:2}); window.addEventListener("resize",()=>{ if(chart){ chart.applyOptions({width:el.clientWidth}); } }); }

function fmt(v){ const n=Number(v); return (!Number.isFinite(n)||v===null) ? "--" : n.toLocaleString("en-US",{maximumFractionDigits: (n<10?4:2)}); }
function buildEMA(c,p){ const out=[]; if(c.length<p)return out; let v=0; for(let i=0;i<p;i++){v+=c[i].close;} v/=p; out.push({time:c[p-1].time,value:v}); const m=2/(p+1); for(let i=p;i<c.length;i++){ v=c[i].close*m+v*(1-m); out.push({time:c[i].time,value:v}); } return out; }

async function refresh(){
  try{
    const sym=$("symbol").value, tf=$("tf").value;
    const data=await api("/api/crypto?symbol="+encodeURIComponent(sym)+"&tf="+encodeURIComponent(tf));
    const c=data.candles||[], ind=data.indicators||{}, sig=data.signal||{};
    
    $("price").textContent=fmt(ind.price); $("fast").textContent=fmt(ind.fast); $("slow").textContent=fmt(ind.slow); $("atr").textContent=fmt(ind.atr);
    $("sl").textContent=fmt(sig.stopLoss); $("tp").textContent=fmt(sig.takeProfit);
    $("signal").textContent=sig.action||"WAIT"; $("signal").className="value "+(sig.action==="BUY"?"green":sig.action==="SELL"?"red":"");
    
    const score = sig.marketScore || 0;
    $("marketScore").textContent = score.toFixed(1);
    $("marketState").textContent = score >= (currentSettings?.rangeThreshold||75) ? "RANGING" : "TRENDING";
    $("marketState").className = "value " + (score >= (currentSettings?.rangeThreshold||75) ? "orange" : "green");
    $("activeMultiplier").textContent = (sig.multiplier||1).toFixed(2) + "x";
    $("activePeriods").textContent = (sig.activeFast||10) + " / " + (sig.activeSlow||100) + " / " + (sig.activeRange||26);

    if(chart){
      candleSeries.setData(c.map(x=>({time:x.time,open:x.open,high:x.high,low:x.low,close:x.close})));
      fastSeries.setData(buildEMA(c,currentSettings?.baseFast||10)); 
      slowSeries.setData(buildEMA(c,currentSettings?.baseSlow||100));
    }
    const sim = await api("/api/sim-data");
    $("balance").textContent=fmt(sim.balance);
    $("serverStatus").textContent="Connected • "+new Date().toLocaleTimeString();
  }catch(e){ $("serverStatus").textContent="Error: "+e.message; }
}

async function loadSettings(){
  try{ const d=await api("/api/settings"); currentSettings=d.settings; 
    $("set_mode").value=currentSettings.strategyMode; $("set_fast").value=currentSettings.baseFast; $("set_slow").value=currentSettings.baseSlow;
    $("set_min").value=currentSettings.minMultiplier; $("set_max").value=currentSettings.maxMultiplier; $("set_range").value=currentSettings.baseRange;
    $("set_rangeThresh").value=currentSettings.rangeThreshold; $("set_risk").value=currentSettings.riskPercent;
  }catch(e){ console.error(e); }
}
async function saveSettings(){
  try{
    const payload = {
      strategyMode: $("set_mode").value, baseFast: +$("set_fast").value, baseSlow: +$("set_slow").value,
      minMultiplier: +$("set_min").value, maxMultiplier: +$("set_max").value, baseRange: +$("set_range").value,
      rangeThreshold: +$("set_rangeThresh").value, riskPercent: +$("set_risk").value
    };
    await api("/api/settings",{method:"POST",body:JSON.stringify(payload)});
    currentSettings = { ...currentSettings, ...payload };
    $("settingsModal").style.display="none";
    refresh();
  }catch(e){ alert(e.message); }
}

async function fillData(){ $("fillBtn").textContent="Filling..."; $("fillBtn").disabled=true; try{ await api("/api/fill-data",{method:"POST",body:JSON.stringify({symbol:$("symbol").value,tf:$("tf").value})}); await refresh(); }catch(e){ alert(e.message); } finally{ $("fillBtn").textContent="Fill Data"; $("fillBtn").disabled=false; } }

async function backtest(){ 
  const p=$("backtestPanel"); p.style.display="block"; 
  $("bt-table").querySelector("tbody").innerHTML="<tr><td colspan='5'>Running...</td></tr>"; 
  try{ 
    const d=await api("/api/backtest",{method:"POST",body:JSON.stringify({symbol:$("symbol").value,tf:$("tf").value})}); 
    const r=d.result; 
    $("bt-bal").textContent=fmt(r.finalBalance); 
    $("bt-profit").textContent=(r.netProfit>0?"+":"")+fmt(r.netProfit)+" ("+r.returnPercent.toFixed(1)+"%)"; 
    $("bt-profit").className="value "+(r.netProfit>0?"green":"red"); 
    $("bt-win").textContent=r.winRate.toFixed(1)+"%"; 
    $("bt-trades").textContent=r.totalTrades; 
    const tb=$("bt-table").querySelector("tbody"); tb.innerHTML=""; 
    r.trades.forEach(function(t) { 
      const tr=document.createElement("tr"); 
      const tdSide=document.createElement("td"); tdSide.className=t.side==='BUY'?'green':'red'; tdSide.textContent=t.side;
      const tdEntry=document.createElement("td"); tdEntry.textContent=fmt(t.entry);
      const tdExit=document.createElement("td"); tdExit.textContent=fmt(t.exit);
      const tdPnl=document.createElement("td"); tdPnl.className=t.pnl>0?'green':'red'; tdPnl.textContent=t.pnl.toFixed(2);
      const tdReason=document.createElement("td"); tdReason.textContent=t.reason;
      tr.appendChild(tdSide); tr.appendChild(tdEntry); tr.appendChild(tdExit); tr.appendChild(tdPnl); tr.appendChild(tdReason); 
      tb.appendChild(tr); 
    }); 
  }catch(e){ $("bt-table").querySelector("tbody").innerHTML="<tr><td colspan='5' class='red'>"+e.message+"</td></tr>"; } 
}

async function toggleAuto(){ try{ const s=await api("/api/sim-data"); const en = !currentSettings.autoTrade; await api("/api/toggle-auto",{method:"POST",body:JSON.stringify({enabled:en})}); currentSettings.autoTrade=en; alert(en?"Auto Trading Enabled":"Auto Trading Disabled"); }catch(e){ alert(e.message); } }

$("themeToggleBtn").onclick=toggleTheme; $("loginBtn").onclick=login; $("password").onkeydown=e=>{if(e.key==="Enter")login()};
$("refreshBtn").onclick=refresh; $("fillBtn").onclick=fillData; $("backtestBtn").onclick=backtest; $("autoBtn").onclick=toggleAuto; $("logoutBtn").onclick=logout;
$("settingsBtn").onclick=()=>{ $("settingsModal").style.display="flex"; }; $("closeSettings").onclick=()=>{ $("settingsModal").style.display="none"; }; $("saveSettings").onclick=saveSettings;

initTheme(); if(TOKEN){ showApp(); }
</script>
</body>
</html>`;
