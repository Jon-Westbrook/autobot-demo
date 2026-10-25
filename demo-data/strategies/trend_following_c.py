"""Trend Following C: average three moving-average signals into one position size."""

SIGNAL_INPUTS = ("ASSET_C",)
TRADABLE_TARGETS = ("ASSET_C",)
WINDOWS = (50, 100, 200)


def target_weights(history):
    closes = history["ASSET_C"]
    if len(closes) < max(WINDOWS):
        return {}
    votes = [closes[-1] > sum(closes[-w:]) / w for w in WINDOWS]
    weight = sum(votes) / len(WINDOWS)
    return {"ASSET_C": weight} if weight else {}
