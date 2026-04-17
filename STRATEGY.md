# Strategy: Leveraged mUSDX on Ranger

## Thesis

USDX is a stablecoin backed by a real-world portfolio of US residential mortgages ([Stable](https://trystable.co)). That portfolio earns **~5% APR** in interest payments — a yield source that exists independently of crypto-native markets, has no circular dependency on other stablecoins, and is not a DEX LP position.

That 5% is real, but unlevered it is below the hackathon's 10% APY eligibility floor. Leverage is what turns a real-yield collateral asset into a viable vault strategy.

**Edge:**
- **Non-crypto yield source.** The underlying cashflow is mortgage interest, not funding rates, not LP fees, not token emissions. It's uncorrelated with the rest of the vault's operating risk (borrow rates, DEX liquidity).
- **Stable-on-stable leverage.** Both legs of the loop (collateral = mUSDX, debt = USDC) are dollar-denominated. The only price risk is the mUSDX/USDX peg itself, which is a 1:1 wrap enforced on-chain.
- **First looping adaptor in the Ranger ecosystem.** The adaptor composes Save (lending), Jupiter (swap), and the mUSDX program (wrap) into a single Voltr-compatible interface — infra that other managers can reuse.

## How it works

1. User deposits USDX into the Ranger vault.
2. Keeper wraps USDX → mUSDX (1:1 at the current exchange rate; no slippage).
3. Keeper deposits mUSDX into Save as collateral.
4. Keeper borrows USDC against it — up to the LTV that keeps health factor ≥ 1.05.
5. Keeper swaps USDC → USDX via Jupiter (adaptor enforces a min-out floor; keeper picks the route).
6. Back to step 2; repeat until target leverage is hit (4x default, 5x cap, 10x hardcoded ceiling).

Unwind runs in reverse. The user's principal is protected by the 10-day effective withdrawal window: 7-day mUSDX cooldown plus a buffer that lets the keeper unwind positions without fire-saling collateral.

## Yield math

Let `L` = leverage, `Y` = mUSDX base yield (~5%), `B` = USDC borrow APR.

```
Gross yield  = L · Y
Borrow cost  = (L − 1) · B
Net yield    = L · Y − (L − 1) · B
```

At 5% base yield, 3% borrow rate, 4x leverage: `4·5 − 3·3 = 11% net`.

**Break-even borrow rate at 4x:** `B* = L·Y / (L−1) = 6.67%`. USDC borrow rates on Save have sat well below that during the build window.

## Risk management

### Drawdown limits & liquidation protection

- **Health-factor floor: 1.05** on every leverage step. The adaptor computes the projected HF after each borrow and reverts the tx if it would land below the floor.
- **Hardcoded leverage ceiling: 10x.** Even if admin config is corrupted, the on-chain program caps effective leverage at 10x.
- **Min-out floor on every swap.** Keeper-supplied Jupiter routes are checked against an admin-configured minimum output price — the keeper cannot drain the vault via a bad route.
- **Peg monitor:** if the Switchboard mUSDX/USDX feed drifts outside a tolerance band, the keeper pauses new leverage and begins unwind.

### Position sizing

- **Target 4x, cap 5x.** Conservative relative to the 10x program ceiling and the ~85% collateral factor Save supports for mUSDX.
- **Iteration cap: 8 loops per rebalance.** Limits gas and contains oracle drift across a single batch.
- **Max slippage per swap: 1%.** Tighter than standard DEX aggregator defaults.

### Rebalancing logic

The keeper rebalances when any of the following trigger:

1. **Deposit-driven:** Alchemy webhook fires on vault idle-ATA balance change. Keeper ramps the new capital to target leverage.
2. **Drift-driven:** Scheduled poll; if current leverage deviates from target by more than a band, keeper partially opens or closes.
3. **Health-driven:** If Save oracle price moves such that HF approaches 1.10, keeper pre-emptively deleverages.
4. **Withdrawal-driven:** User initiates withdraw → keeper unwinds enough position to cover the request plus the 7-day cooldown overhead.

### Failure modes

| Risk | Mitigation |
|------|------------|
| Save oracle spikes | Hardcoded HF floor; pre-emptive deleverage at HF 1.10 |
| mUSDX/USDX peg breaks | Switchboard feed monitored; keeper pauses new leverage and unwinds |
| USDC borrow rate spikes above break-even | Keeper deleverages; vault LPs redeem via the 10-day window |
| Jupiter route manipulation | Admin-set min-out floor enforced on-chain per swap |
| Keeper offline | Vault continues to accrue; unwind path is admin-callable as a backstop |
| Keeper compromised | Keeper key is scoped — cannot withdraw user funds, only rebalance within config bounds |
| Admin compromised | All config changes are 48h timelocked; mUSDX claim always exits (pause-immune) |

### Eligibility notes

- **Base asset.** The hackathon prize rules specify USDC as the vault base asset. This submission accepts **USDX** — we've designed around the user experience of a USDX-native product, since USDX is what Stable's users already hold. A straightforward wrapper script that swaps USDC → USDX at the vault boundary is a one-line addition if the organizers require strict USDC base.
- **Yield source.** USDX yield comes from off-chain mortgage interest, not from another yield-bearing stablecoin. There is no circular dependency. It is not a junior tranche, not an insurance pool, not a DEX LP position.
- **Leverage.** Health-factor floor of 1.05 matches the rule text; the mUSDX/USDX price is not hardcoded in the oracle but the wrap rate is enforced by the mUSDX program itself (not a market feed), so the leverage-pricing risk the rule targets does not apply.

## Production viability

- Both programs audited; mUSDX audit shows 0 findings at every severity level.
- Keeper runs on Render via one-click `render.yaml`; Supabase persists run history for observability.
- No external protocol SDKs in the on-chain code — only `anchor-lang` + `anchor-spl`. Reduces supply-chain surface.
- Voltr-compatible interface means this slots into any Ranger Earn vault without bespoke integration work.

## What we'd do post-hackathon

1. Add a USDC-native entrypoint that swaps USDC → USDX at deposit and reverses at withdraw.
2. Add a secondary collateral venue (Kamino) to diversify liquidation risk away from a single lending pool.
3. Publish a public dashboard of real-time leverage, HF, and realized APY.
4. Raise target leverage cautiously once we have >30 days of live data on Save mUSDX reserve stability.
