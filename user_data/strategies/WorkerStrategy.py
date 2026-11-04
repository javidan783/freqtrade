
from freqtrade.strategy import IStrategy
from pandas import DataFrame
import talib.abstract as ta
import numpy as np
import math

class WorkerStrategy(IStrategy):
    INTERFACE_VERSION = 3
    timeframe = '1m'
    minimal_roi = {"0": 100}
    stoploss = -0.99
    trailing_stop = False
    process_only_new_candles = True
    startup_candle_count = 200

    baseFast = 10
    baseSlow = 100
    baseAtr = 14
    baseRange = 26
    rangeThreshold = 75
    stopLossATR = 2
    takeProfitATR = 3
    minMultiplier = 0.5
    maxMultiplier = 2.0
    strategyMode = "AUTO"

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe['ema_fast'] = ta.EMA(dataframe, timeperiod=self.baseFast)
        dataframe['ema_slow'] = ta.EMA(dataframe, timeperiod=self.baseSlow)
        dataframe['atr'] = ta.ATR(dataframe, timeperiod=self.baseAtr)

        prev_close = dataframe['close'].shift(1)
        dataframe['tr'] = np.maximum(
            dataframe['high'] - dataframe['low'],
            np.maximum(
                (dataframe['high'] - prev_close).abs(),
                (dataframe['low'] - prev_close).abs()
            )
        ).fillna(dataframe['high'] - dataframe['low'])

        period = 26
        sum_tr = dataframe['tr'].rolling(window=period).sum()
        highest = dataframe['high'].rolling(window=period).max()
        lowest = dataframe['low'].rolling(window=period).min()
        range_ = highest - lowest
        chop = 100 * np.log10(sum_tr / range_.replace(0, np.nan)) / np.log10(period)
        dataframe['choppiness'] = chop.fillna(50)

        norm = dataframe['choppiness'] / 100
        dataframe['multiplier'] = self.minMultiplier + (
            norm * (self.maxMultiplier - self.minMultiplier)
        )

        is_auto = self.strategyMode != "MANUAL"
        if is_auto:
            active_range = np.maximum(2, np.round(self.baseRange * dataframe['multiplier'].values)).astype(int)
        else:
            active_range = np.full(len(dataframe), self.baseRange, dtype=int)

        high_vals = dataframe['high'].values
        low_vals = dataframe['low'].values
        range_high = np.full(len(dataframe), np.nan)
        range_low = np.full(len(dataframe), np.nan)

        for idx in range(len(dataframe)):
            window = active_range[idx]
            if idx >= window:
                range_high[idx] = high_vals[idx - window:idx].max()
                range_low[idx] = low_vals[idx - window:idx].min()

        dataframe['range_high'] = range_high
        dataframe['range_low'] = range_low

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        in_range = dataframe['choppiness'] >= self.rangeThreshold
        buy_cross = (
            (dataframe['ema_fast'] > dataframe['ema_slow']) &
            (dataframe['ema_fast'].shift(1) <= dataframe['ema_slow'].shift(1))
        ).fillna(False)
        buy_breakout = (
            (dataframe['close'] > dataframe['range_high']) &
            (dataframe['ema_fast'] > dataframe['ema_slow'])
        ).fillna(False)
        dataframe.loc[
            (~in_range) & (buy_cross | buy_breakout),
            'enter_long'
        ] = 1
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        in_range = dataframe['choppiness'] >= self.rangeThreshold
        sell_cross = (
            (dataframe['ema_fast'] < dataframe['ema_slow']) &
            (dataframe['ema_fast'].shift(1) >= dataframe['ema_slow'].shift(1))
        ).fillna(False)
        sell_breakout = (
            (dataframe['close'] < dataframe['range_low']) &
            (dataframe['ema_fast'] < dataframe['ema_slow'])
        ).fillna(False)
        dataframe.loc[
            (~in_range) & (sell_cross | sell_breakout),
            'exit_long'
        ] = 1
        return dataframe

    def custom_stoploss(self, pair: str, trade, current_time, current_rate, current_profit, **kwargs) -> float:
        if not self.dp:
            return self.stoploss
        try:
            dataframe, _ = self.dp.get_analyzed_dataframe(pair, self.timeframe)
        except Exception:
            return self.stoploss
        if len(dataframe) < 1:
            return self.stoploss
        last_candle = dataframe.iloc[-1]
        atr = last_candle['atr']
        if atr is None or np.isnan(atr) or current_rate == 0:
            return self.stoploss
        stoploss_price = trade.open_rate - (atr * self.stopLossATR)
        return (stoploss_price - current_rate) / current_rate

    def custom_exit(self, pair: str, trade, current_time, current_rate, current_profit, **kwargs) -> str:
        if not self.dp:
            return None
        try:
            dataframe, _ = self.dp.get_analyzed_dataframe(pair, self.timeframe)
        except Exception:
            return None
        if len(dataframe) < 1:
            return None
        last_candle = dataframe.iloc[-1]
        atr = last_candle['atr']
        if atr is None or np.isnan(atr) or trade.open_rate == 0:
            return None
        takeprofit_price = trade.open_rate + (atr * self.takeProfitATR)
        if current_rate >= takeprofit_price:
            return "TAKE PROFIT (ATR)"
        return None
