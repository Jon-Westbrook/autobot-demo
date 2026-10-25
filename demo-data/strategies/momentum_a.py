"""Momentum A: hold the strongest assets by trailing return, sized by volatility."""

SIGNAL_INPUTS = ("ASSET_A", "ASSET_B", "ASSET_C", "ASSET_D")
TRADABLE_TARGETS = SIGNAL_INPUTS
LOOKBACK = 126
TOP_N = 2
VOLATILITY_TARGET = 0.15


def target_weights(history):
    """history maps symbol -> list of daily closes, oldest first."""
    scores = {}
    for symbol in TRADABLE_TARGETS:
        closes = history[symbol]
        if len(closes) <= LOOKBACK:
            return {}  # not enough observations yet: no rebalance
        scores[symbol] = closes[-1] / closes[-1 - LOOKBACK] - 1
    leaders = sorted(scores, key=scores.get, reverse=True)[:TOP_N]
    weights = {}
    for symbol in leaders:
        if scores[symbol] <= 0:
            continue  # never buy a falling asset; that slice stays in cash
        weights[symbol] = min(1 / TOP_N, VOLATILITY_TARGET / _volatility(history[symbol]) / TOP_N)
    return weights


def _volatility(closes, window=20):
    returns = [b / a - 1 for a, b in zip(closes[-window - 1:-1], closes[-window:])]
    mean = sum(returns) / len(returns)
    variance = sum((r - mean) ** 2 for r in returns) / (len(returns) - 1)
    return max(variance ** 0.5 * 252 ** 0.5, 1e-6)
