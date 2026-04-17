# mUSDX Leveraged Yield Vault

A Ranger Finance vault that runs a leveraged loop on **mUSDX** — the yield-bearing wrapper for [USDX](https://trystable.co), the mortgage-backed stablecoin.

Built by [Stable](https://trystable.co) for the [Ranger Build-a-Bear Hackathon](https://earn.superteam.fun/listing/build-a-bear-hackathon-main-track/).

- **Strategy:** [`STRATEGY.md`](./STRATEGY.md)
- **Audits:** [`audits/`](./audits)
- **Keeper:** [`keeper/index.ts`](./keeper/index.ts)

## What it does

Users deposit **USDX** into the Ranger vault. A keeper wraps USDX to mUSDX and runs a leveraged loop through Save Finance to amplify the ~5% base yield from USDX's mortgage backing:

```
User deposits USDX
        |
        v
Keeper wraps USDX -> mUSDX
        |
        v
Posts mUSDX as Save collateral
        |
        v
Borrows USDC against it
        |
        v
Jupiter swap USDC -> USDX
        |
        v
Wrap USDX -> mUSDX              <-- repeat until target leverage (4x default)
        |
        v
Post more mUSDX as collateral
```

At 4x leverage on 5% base yield: **~11–13% net APY** on USDX deposits.

## Architecture

```
          User
            |
            |  deposit USDX
            v
   +-----------------+
   |  Ranger Vault   |  2udsDEMJzSpcJiGqULC29C9wJufoerY5SAwmUYTMHNFr
   |   (Voltr SDK)   |
   +--------+--------+
            |  CPI
            v
   +-----------------+
   | lev_musdx_      |  5k9CgNiSXSRbLG6PaSSJwkriYkg8i9hdyc8gkDBj3jyv
   | adaptor         |   (first multi-protocol looping adaptor on Ranger)
   +--------+--------+
          / | \
         /  |  \
        v   v   v
     Save  Jupiter  mUSDX Program
    (lend) (swap)  (wrap USDX)
```

### Programs

| Program | Address | Description |
|---------|---------|-------------|
| mUSDX | `5NTrBzBD92B8qRDquvxBihpcxQHmCNqu2WtmoT9RRFpK` | USDX Savings — non-rebasing yield wrapper |
| lev_musdx_adaptor | `5k9CgNiSXSRbLG6PaSSJwkriYkg8i9hdyc8gkDBj3jyv` | Ranger/Voltr adaptor running the leveraged loop |

### Tokens

| Token | Address | Description |
|-------|---------|-------------|
| USDX | `9Gst2E7KovZ9jwecyGqnnhpG1mhHKdyLpJQnZonkCFhA` | Mortgage-backed stablecoin by Stable |
| mUSDX (Staked USDX) | `3RyhjAivYTA1VyXJUG1qXgCLHq4zBvbD9B6bcrcDnKB9` | Yield-bearing USDX wrapper |

### Infrastructure

| Component | Address | Purpose |
|-----------|---------|---------|
| Ranger Vault | `2udsDEMJzSpcJiGqULC29C9wJufoerY5SAwmUYTMHNFr` | Accepts USDX deposits, routes into the adaptor |
| Save Lending Pool | `7JoeENZjr1zGuocJ3d8eHxPzs6xSZKNwxQycHeRDiDCf` | mUSDX collateral + USDC borrow |
| Orca Pool (mUSDX/USDX) | `FVxyfzzoPb6krQbefLZtBAcXLJwUfvaX8ypqsHQPso2o` | Instant mUSDX exit at spread |
| Switchboard feed (mUSDX/USDX) | `DcXQmwQ1bz177STVkLqubbb5ohjTVnJzMB2PTQkWvbmQ` | Oracle for Save reserve pricing |

### On-chain verification

Build-window activity can be verified on Solscan against the addresses above. The mUSDX program and the lev_musdx_adaptor were both deployed and exercised on mainnet during the hackathon window.

## mUSDX Program

mUSDX ("Staked USDX") is a non-rebasing yield-bearing wrapper for USDX, modeled on Ethena's sUSDe. The exchange rate grows as the admin calls `post_yield` to route mortgage yield from USDX's real-world debt backing into the vault.

**Properties:**
- 13 instructions, fully self-contained (no external CPI dependencies)
- 7-day cooldown on exits (Ethena-style)
- 48-hour timelocks on admin changes and cooldown-duration changes (2-step propose/accept)
- Pause does **not** block `claim` — users who already waited can always exit
- All math uses `u128` intermediates with checked arithmetic

**Instructions:**

| Instruction | Description |
|-------------|-------------|
| `initialize` | Create state, mint, vault, silo |
| `wrap` | Deposit USDX, receive mUSDX shares |
| `cooldown` | Burn shares, lock USDX in silo for 7 days |
| `claim` | Withdraw USDX after cooldown |
| `post_yield` | Admin deposits yield into vault (exchange rate grows) |
| `set_paused` | Emergency pause / resume |
| `propose_cooldown_duration` / `apply_cooldown_duration` / `cancel_pending_cooldown_duration` | Timelocked cooldown change |
| `propose_admin` / `accept_admin` / `cancel_pending_admin` | Timelocked admin rotation |
| `create_metadata` | Set Metaplex token metadata (admin, one-time) |

Source: [`programs/musdx/src/lib.rs`](./programs/musdx/src/lib.rs).

## Leveraged mUSDX Adaptor

A Ranger/Voltr-compatible adaptor that orchestrates a multi-protocol leveraged yield loop across Save, Jupiter, and the mUSDX program. To our knowledge it's the first multi-protocol looping strategy adaptor in the Ranger ecosystem.

**Per leverage step (`open_leverage_step`):**
1. Refresh Save oracles + obligation
2. Borrow USDC from Save against mUSDX collateral
3. Jupiter swap USDC → USDX (keeper provides route; adaptor enforces a min-out floor)
4. Wrap USDX → mUSDX via CPI (par rate, no slippage)
5. Deposit mUSDX as additional Save collateral
6. Update cached leverage state

**Per unwind step (`close_leverage_step`):**
1. Withdraw mUSDX collateral from Save
2. Jupiter swap mUSDX → USDC (or mUSDX → USDX → USDC)
3. Repay USDC debt to Save
4. Update leverage state

**Default configuration:**

| Parameter | Value |
|-----------|-------|
| Target leverage | 4x |
| Max leverage | 5x |
| Max slippage | 1% |
| Loop iteration cap | 8 |
| Absolute leverage ceiling | 10x (hardcoded) |
| Hackathon fees | 0% (manager, admin, redemption, issuance) |

Voltr-compatible instructions (`initialize`, `deposit`, `withdraw`) wrap the core logic for seamless Ranger integration. Deposits acknowledge receipt synchronously; the keeper ramps leverage via separate `open_leverage_step` calls, which avoids Solana's 4-level CPI depth limit.

Source: [`programs/lev_musdx_adaptor/src/`](./programs/lev_musdx_adaptor/src).

## Withdrawals

Users can exit two ways:

1. **Vault redemption** (principal + yield) — the keeper unwinds leverage, then the 7-day mUSDX cooldown resolves. Effective wait ≈ **10 days** (7-day cooldown + unwind buffer).
2. **Instant** via the [Orca mUSDX/USDX pool](https://www.orca.so/pools/FVxyfzzoPb6krQbefLZtBAcXLJwUfvaX8ypqsHQPso2o) — pay the spread, skip the wait.

## Yield Math

With USDX's mortgage-backed yield at ~5% APR:

| Leverage | Gross Yield | USDC Borrow Cost (3% APR) | Net Yield |
|----------|-------------|---------------------------|-----------|
| 1x | 5% | 0% | 5% |
| 2x | 10% | 3% | 7% |
| 3x | 15% | 6% | 9% |
| **4x (default)** | **20%** | **9%** | **11%** |
| 5x (max) | 25% | 12% | 13% |

Break-even USDC borrow rate at 4x leverage: **6.67% APR**.

See [`STRATEGY.md`](./STRATEGY.md) for full risk analysis and rebalancing logic.

## Development

### Prerequisites

- Rust + Solana CLI v2.3.x (platform-tools v1.48)
- Anchor CLI v0.31.x
- Node.js v18+ + yarn

### Build

```bash
anchor build -p musdx
anchor build -p lev_musdx_adaptor
```

### Test

```bash
# mUSDX devnet integration (8/8 passing)
npx ts-node scripts/devnet-test-musdx.ts
```

### Deploy

```bash
anchor deploy -p musdx --provider.cluster mainnet
anchor deploy -p lev_musdx_adaptor --provider.cluster mainnet
```

### Run the keeper

The keeper runs both as a CLI (one-shot rebalance) and an HTTP server (webhook + health). See [`render.yaml`](./render.yaml) for a one-click Render deploy and [`.env.example`](./.env.example) for required env vars.

```bash
node dist/keeper/index.js server      # HTTP server
node dist/keeper/index.js rebalance   # one-shot
```

## Dependencies

### On-chain programs
- `anchor-lang = "0.31.0"`
- `anchor-spl = "0.31.0"`

No external protocol SDKs or heavyweight crates on-chain. All protocol interactions (Save, Jupiter) use raw CPI via `invoke_signed`.

### Off-chain / keeper
- `@voltr/vault-sdk` — Ranger vault SDK
- Save Finance (Solend fork) — lending
- Jupiter V6 — swaps
- Switchboard on-demand — oracle
- Supabase — keeper state
- Alchemy — RPC

## Security

- **mUSDX audit:** 0 critical / 0 high / 0 medium / 0 low ([`audits/musdx-audit-report.md`](./audits/musdx-audit-report.md))
- **Adaptor audit:** [`audits/lev-musdx-adaptor-audit-report.md`](./audits/lev-musdx-adaptor-audit-report.md)
- All arithmetic uses checked ops with `u128` intermediates
- PDA-based authority — no EOA can move vault or silo funds
- Cooldown timelocks prevent admin from trapping users
- Adaptor has hardcoded safety ceilings: 10x max leverage, min-out floor on every swap
- Emergency pause on both programs
- Save obligation is owned by the adaptor's config PDA (fully trustless)

## Repo map

```
programs/
  musdx/src/lib.rs               — mUSDX program (~860 lines)
  lev_musdx_adaptor/src/
    lib.rs                        — adaptor (~1600 lines)
    save_cpi.rs                   — Save / Solend CPI helpers
    jupiter_cpi.rs                — Jupiter V6 CPI helper
keeper/
  index.ts                        — keeper (CLI + HTTP webhook + Supabase)
  supabase-migration.sql          — DB schema
scripts/
  full-wire.ts                    — deploys + wires everything
  devnet-test-musdx.ts            — mUSDX devnet tests
  mainnet-init-and-wrap.ts        — mainnet init
  01-init-vault.ts … 04-*.ts      — step-by-step deploy scripts
audits/
  musdx-audit-report.md
  lev-musdx-adaptor-audit-report.md
tests/
  musdx.ts
render.yaml                       — one-click keeper deploy
Anchor.toml, Cargo.toml, package.json
STRATEGY.md                       — strategy thesis + risk management
```

## Team

Built by [Stable](https://trystable.co). Reach out to `winston@trystable.co` for anything.
