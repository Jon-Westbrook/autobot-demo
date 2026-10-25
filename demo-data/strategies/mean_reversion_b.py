"""Mean Reversion B: buy short pullbacks, but only while the longer trend is up."""

SIGNAL_INPUTS = ("ASSET_A", "ASSET_B")
TRADABLE_TARGETS = ("ASSET_A",)
TREND_WINDOW = 200
ZSCORE_WINDOW = 10
ENTRY_Z = -1.5


def target_weights(history):
    closes = history["ASSET_A"]
    if len(closes) < TREND_WINDOW:
        return {}
    trend = sum(closes[-TREND_WINDOW:]) / TREND_WINDOW
    recent = closes[-ZSCORE_WINDOW:]
    mean = sum(recent) / ZSCORE_WINDOW
    spread = (sum((c - mean) ** 2 for c in recent) / (ZSCORE_WINDOW - 1)) ** 0.5 or 1e-9
    z = (closes[-1] - mean) / spread
    return {"ASSET_A": 1.0} if closes[-1] > trend and z < ENTRY_Z else {}
