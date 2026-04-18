# orca_adaptor Security Audit Report

**Program:** Orca Whirlpools Adaptor
**Program ID (tested):** `5o35D7VMZpJpN9JQxuhzdGiYQofNfgXQFcuWxihFD8Lc` *(closed after Phase-3 verification; fresh deploy needed for production)*
**Auditor:** Automated review via Claude
**Date:** 2026-04-18 (re-audit, post-remediation)
**Lines of Code:** 911 (`lib.rs`) + 412 (`whirlpool_cpi.rs`) = 1,323 total
**Dependencies:** `anchor-lang 0.31.0`, `anchor-spl 0.31.0`
**Build:** Anchor with `opt-level = "z"`, `lto = "fat"`, `codegen-units = 1`, `strip = true`
**Binary size:** 304,728 bytes

---

## Executive Summary

`orca_adaptor` is a Voltr/Ranger-compatible adaptor that orchestrates Orca Whirlpool operations — swap, concentrated-liquidity position open/close, and liquidity increase/decrease — on behalf of a Voltr strategy. The config PDA (`seeds = ["orca_strategy_config", voltr_vault]`) is both the strategy authority and the owner of all position NFTs, making the adaptor the sole controller of any Whirlpool state it touches.

To our knowledge this is the **first Orca Whirlpools adaptor in the Ranger/Voltr ecosystem**. It was built and verified in three incremental phases (swap → open/close → increase/decrease liquidity), each phase deployed to mainnet, exercised with live transactions against the SOL/USDC 4 bps Whirlpool, then closed and redeployed for the next phase.

This is a **re-audit** performed after the initial audit's remediations were merged. The program now enforces Whirlpool vault/mint cross-checks, strategy-ATA ownership, slippage floors on swap, tick alignment on open_position, admin rotation, and a constrained close_position receiver.

**Findings (post-remediation):**
- **0 Critical**
- **0 High**
- **0 Medium**
- **1 Low** (new — parse_whirlpool owner check)
- **4 Informational** (2 carried from prior audit + 2 new)

All of the prior audit's M-1 and L-1..L-5 findings have been verified fixed in code.

---

## Architecture

### Two-phase initialization

1. **Admin calls `initialize_config`** — creates the config PDA, records admin/keeper/voltr_vault/asset_mint, sets `min_swap_out_bps = 0`, `paused = false`.
2. **Manager calls Voltr's `initialize_strategy`** — Voltr CPIs into the adaptor's `initialize(voltr_vault: Pubkey)` handler, which now validates that `ctx.accounts.strategy.key() == PDA([CONFIG_SEED, voltr_vault])` and `ctx.accounts.vault.key() == voltr_vault`. Voltr then creates its own strategy-init receipt.

### Authority model

| Principal | Powers |
|---|---|
| `config.admin` | `set_admin`, `set_keeper`, `set_paused`, `set_swap_params`. Cannot move funds directly. |
| `config.keeper` | `swap`, `open_position`, `close_position`, `increase_liquidity`, `decrease_liquidity`. |
| `config` PDA (itself) | Signs every Whirlpool CPI via `invoke_signed(seeds = ["orca_strategy_config", voltr_vault, [bump]])`. Owns strategy token ATAs and every Position NFT. |

### Instruction inventory (11 total)

| Instruction | Caller | Purpose |
|---|---|---|
| `initialize_config` | admin (one-time) | Create config PDA. |
| `set_admin` | admin | Rotate admin. |
| `set_keeper` | admin | Rotate keeper. |
| `set_paused` | admin | Emergency pause/unpause. |
| `set_swap_params` | admin | Adjust per-pair slippage floor. |
| `initialize` | Voltr | Strategy-registration hook with PDA check. |
| `deposit` | Voltr | Move vault asset into strategy ATA. |
| `withdraw` | Voltr | Report position value. |
| `swap` | keeper | Swap through any Whirlpool. |
| `open_position` | keeper | Open a 0-liquidity position. |
| `close_position` | keeper | Close a 0-liquidity position. |
| `increase_liquidity` | keeper | Deposit into position. |
| `decrease_liquidity` | keeper | Withdraw from position. |

### CPI construction

All Whirlpool ixs are hand-constructed Anchor instructions in `whirlpool_cpi.rs`: 8-byte discriminator (`sha256("global:<name>")[..8]`) + little-endian arg encoding. No Orca SDK dependency. CPIs use `invoke_signed` with the config PDA seeds except `open_position`, which uses `invoke` because `position_mint` is a real outer-tx signer.

---

## Findings

### L-1 (Low): `parse_whirlpool` does not verify account owner

**Location:** `whirlpool_cpi.rs:55-68`, used from `lib.rs:245` (swap), `lib.rs:331` (open_position), and `lib.rs:23-47` (`validate_modify_liquidity_pool`).

`parse_whirlpool` checks only that the account's data length is ≥ 245 bytes before reading off field byte offsets. It does not verify `whirlpool.owner == WHIRLPOOL_PROGRAM_ID`. As a result, any account with ≥ 245 bytes of attacker-controlled data can pass the parse step — the adaptor's subsequent checks (`wp.token_vault_a == ctx.accounts.whirlpool_vault_a.key()`, etc.) would succeed against whatever pubkeys the attacker chose to put at those offsets.

**Exploitability:** Not a funds-theft vector. The CPI that follows (`whirlpool_cpi::swap` / `open_position` / etc.) is dispatched to `WHIRLPOOL_PROGRAM_ID` with the same "whirlpool" account as input — Whirlpool then fails its own internal owner/discriminator checks and reverts. A caller can also trigger an in-program `rem_euclid(0)` panic in `open_position` by crafting a fake account with `tick_spacing = 0` at offset 41 (see I-3).

**Impact:** DoS surface (wasted compute, harder error messages) + potential panic via crafted tick_spacing. Because `open_position` is keeper-gated, the only realistic attacker is a compromised keeper key, which would already have more direct destructive options.

**Recommendation:** add an owner check at the top of `parse_whirlpool`:
```rust
if *whirlpool.owner != WHIRLPOOL_PROGRAM_ID {
    return None;
}
```
Alternatively enforce the owner constraint at the Anchor struct level on the `whirlpool` field of every relevant `Accounts` struct:
```rust
#[account(mut, owner = whirlpool_cpi::WHIRLPOOL_PROGRAM_ID)]
pub whirlpool: AccountInfo<'info>,
```

---

### I-1 (Informational): Config PDA squatting (front-run DoS on setup)

**Location:** `lib.rs:59-72` (`initialize_config`).

`initialize_config` is unauthenticated beyond requiring an `admin: Signer`. Any signer can call it with any `voltr_vault` pubkey, creating a config PDA with themselves as admin. Because Anchor's `init` constraint blocks re-initialization, the legitimate vault admin who tries to register later will get an `account already in use` error and cannot recover the PDA.

**Exploitability:** Funds-safe — the squatted config is non-functional: (a) Voltr's `initialize_strategy` has its own manager-authenticated flow that would not register a strategy for an unauthorized caller, and (b) the squatter can't deposit, swap, or open positions because they don't have a Voltr vault wired to their config. Impact is limited to a one-time rent loss (~0.0014 SOL) plus forcing the real admin to use a different vault pubkey.

In practice the legitimate setup runs `init_vault` + `initialize_config` + `add_adaptor` + `initialize_strategy` as one atomic script so the front-run window is narrow.

**Recommendation (optional):** couple the `initialize_config` signer to Voltr's vault — either require that admin be the Voltr vault's `admin` field, or accept the squatting risk as a setup-process operational concern.

---

### I-2 (Informational): Voltr `deposit` / `withdraw` handlers don't verify caller

**Location:** `lib.rs:157-197`.

*(Carried over from prior audit — unchanged.)*

The `deposit` and `withdraw` handlers don't check that the immediate caller is the Voltr program. A direct call would fail because the transfer's `authority` (`vault_strategy_auth`) is a Voltr PDA that only Voltr can sign for — so no funds move. But an added `require_keys_eq!(*ctx.program_id, VOLTR_PROGRAM_ID)` or an `instruction_sysvar`-based check would make the intent explicit. **Accepted — not fixed.**

---

### I-3 (Informational): `open_position` panics on `tick_spacing == 0`

**Location:** `lib.rs:333-341`.

`tick_lower_index.rem_euclid(spacing)` panics in Rust when `spacing == 0`. If an attacker crafts a fake "Whirlpool" account (see L-1) with `tick_spacing = 0` at offset 41, `open_position` will abort with a panic rather than a clean `OrcaAdaptorError::InvalidTickAlignment`. Real Whirlpools always have `tick_spacing > 0`, so this only triggers against a malicious account.

**Recommendation:** guard the modulo:
```rust
require!(spacing > 0, OrcaAdaptorError::InvalidTickAlignment);
```
(one extra line, no new error variant needed). Becomes a non-issue automatically if L-1 is fixed (owner check would reject the fake account first).

---

### I-4 (Informational): `config.asset_mint` is set but never read

**Location:** `lib.rs:66-67, 787-791`.

`initialize_config` writes `args.asset_mint` into `config.asset_mint`, but no other instruction reads it. In particular, `swap` validates strategy-ATA mints against the Whirlpool's tokens but not against the configured `asset_mint`. The field is effectively dead.

**Possible uses if retained:** enforce that one side of every swap/modify involves `asset_mint` so the strategy never strays to assets outside its mandate. Not security-critical; useful for strategy-scope hardening.

**Recommendation:** either (a) wire `asset_mint` into the Whirlpool-validation checks to constrain the strategy's tradable universe, or (b) remove the field in a future ABI-breaking cleanup.

---

### I-5 (Informational): `set_keeper` has no timelock

*(Carried over from prior audit.)*

Keeper rotation is instantaneous. If the admin key is compromised, the keeper can be swapped immediately. **Accepted — operators want fast rotation during incidents.**

---

## Verified remediations (from initial audit)

Each of the following was re-inspected in the current code and confirmed fixed.

| ID | Finding | Status | Location |
|---|---|---|---|
| M-1 | No per-adaptor slippage floor on swap | **FIXED** — `require!(min_amount_out > 0)` + optional `config.min_swap_out_bps` enforced in `swap` | `lib.rs:226-235` |
| L-1 | Strategy token ATAs not ownership-constrained | **FIXED** — `constraint = X.owner == config.key()` on all 4 strategy ATA fields | `lib.rs:606, 610, 716, 720` |
| L-2 | Whirlpool token mints not cross-checked | **FIXED** — `parse_whirlpool` + `require_keys_eq!(wp.token_mint_a, strategy_ata.mint)` in `swap` and modify-liquidity | `lib.rs:257-266, 36-45` |
| L-3 | No admin rotation | **FIXED** (non-timelocked) — `set_admin` ix + `AdminSetEvent` | `lib.rs:76-86` |
| L-4 | `close_position.receiver` unconstrained | **FIXED** — `#[account(mut, address = config.admin)]` | `lib.rs:760` |
| L-5 | Whirlpool vaults not cross-linked | **FIXED** — same `parse_whirlpool` checks vault pubkeys match | `lib.rs:247-256, 26-35` |
| I-1 (old) | Voltr `initialize` is a no-op | **FIXED** — validates strategy PDA + vault arg | `lib.rs:135-152` |
| I-4 (old) | Missing tick alignment check | **FIXED** — `rem_euclid(tick_spacing) == 0` guard on both ticks | `lib.rs:333-341` |
| I-5 (old) | No events on admin state changes | **FIXED** — `AdminSetEvent`, `KeeperSetEvent`, `PausedSetEvent`, `SwapParamsSetEvent` all emitted | `lib.rs:849-869` |

---

## Non-findings (explicitly checked, no issue)

- **Reentrancy.** Solana's tx model disallows reentry. Whirlpool CPIs unwind before the adaptor's next step. CPI depth is ≤ 3 (adaptor → whirlpool → token_program).
- **Integer overflow.** Only arithmetic in the program is the `min_swap_out_bps` check, which uses `checked_mul` + `checked_div`. All other numeric ops are stored-vs-input comparisons.
- **Position NFT custody.** NFT is minted to `ATA(position_mint, config_pda)`; only the config PDA can spend it via `invoke_signed`. No ix in the program transfers the NFT.
- **PDA seed collision.** `config` uses seeds `["orca_strategy_config", voltr_vault]` (distinct from `lev_musdx_adaptor`'s `"strategy_config"`). No collision with any adaptor in this repo.
- **Signer spoofing.** `config` PDA has no keypair; it can only sign via `invoke_signed` with the correct seeds, which only this program holds. `position_mint` signer is freshly generated per `open_position` call.
- **Pause bypass on admin ixs.** `set_admin` / `set_keeper` / `set_paused` / `set_swap_params` don't check `paused` — this is intentional so admin can unpause from a paused state.
- **Admin keeper overlap.** `initialize_config` sets `keeper = admin` by default. No security concern; admin rotates keeper later via `set_keeper`.
- **Anchor `init` re-init protection.** `initialize_config`'s `init` constraint prevents double-creation of the config PDA.
- **PDA validation on keeper-gated ixs.** Every ix reads `config.voltr_vault` via `seeds = [CONFIG_SEED, config.voltr_vault.as_ref()], bump = config.bump` — Anchor recomputes and validates the PDA on every call.
- **`close_position` zero-liquidity requirement.** Whirlpool enforces internally; adaptor correctly delegates.
- **Oracle mutability.** `SwapAccounts::oracle` is correctly marked `mut` to match newer Whirlpool versions' TWAP update requirement.
- **Deposit vs Withdraw pause symmetry.** `deposit` checks pause; `withdraw` does not. Correct for a yield strategy — users must always be able to redeem even when deposits are halted.
- **Voltr PDA passthrough.** `vault_strategy_auth` is a Voltr PDA; only Voltr's program can sign for it, so even an unauthenticated `deposit` call from a non-Voltr caller reverts at the token-transfer step.
- **Constant-address constraints on the Whirlpool program.** Every `Accounts` struct that holds `whirlpool_program` has `#[account(address = whirlpool_cpi::WHIRLPOOL_PROGRAM_ID)]`, preventing program substitution.

---

## Suggested micro-optimizations (non-security)

- **Keeper check ordering.** In `swap`, the `require_keys_eq!(keeper)` check runs after `!paused`, `amount_in > 0`, `min_amount_out > 0`, and `min_swap_out_bps` math. Moving the keeper check to the top short-circuits unauthorized calls ~500 CU earlier.
- **Hot-path CU cost of `parse_whirlpool`.** Each call re-reads 245 bytes and builds a `WhirlpoolView`. Swap calls it once; modify-liquidity ixs call it once via the helper. Fine for CU budget, but if tight, the helper could be inlined with field-specific reads.
- **Dead field `_reserved: [u8; 60]`.** Reserved for future state. Fine as-is; common Anchor pattern.

---

## Known limitations (not security findings)

1. **Position value is not aware of deployed LP.** Voltr `deposit` / `withdraw` return only `vault_strategy_asset_ata.amount`. For a strategy actively using `increase_liquidity`, Voltr's reported NAV will understate true position value by the token-equivalent of the deposited LP + any accrued fees. A production deployment would walk the Position account (if any) and compute `sqrt_price_x64 * liquidity` math to include LP value in the return.
2. **No fee/reward collection instruction.** Whirlpool positions accrue trading fees and optional reward emissions; neither `collect_fees` nor `collect_reward` is exposed by this adaptor. Positions held across swaps will accumulate uncollected revenue. Not a security issue — just product scope.
3. **Keeper computes tick arrays off-chain.** Whirlpool's swap/modify ixs require the caller to supply the exact 3 (swap) or 2 (modify) tick arrays the ix will touch. The adaptor forwards whatever the keeper passes. A wrong tick array produces an opaque "AccountNotInitialized" revert.
4. **Single token-program support.** `SwapAccounts.token_program` is typed as `Program<'info, Token>` (SPL-Token only); Token-2022 mints are not supported on the swap path. Voltr's `deposit` / `withdraw` handlers use a bare `asset_token_program: AccountInfo` so they are program-agnostic there.

---

## Verification — live mainnet activity (pre-remediation)

Every instruction was exercised on Solana mainnet during the phased build-out. The program was closed after Phase 3 to reclaim rent; a fresh deploy is required to re-verify the post-remediation code.

| Phase | Instruction | Transaction |
|---|---|---|
| 1 | `swap` | `2tRL4cBXvdjXL5kYwHon8GwkxoVpNzz7TAToJ34d9KiBaciwrQTbao5G24Ejnnih1K9FGL4hNZW3pzHbEYBuehyw` |
| 2 | `open_position` | `3a8rmoS398HrvRN7tgguhjQzQ45KaiHwtn3yKYVRvNJwvfLpFkDzcMRxWhfLdmLWJB1xQZ8BStG2dZXZDgwhiCzc` |
| 2 | `close_position` | `5P4pPFNXwpTRTjRa5pkVxyt1rzETjTS8LG1oBgR8UM7Nip38PLXz1Gnt6BnS7yiDHUjDyLUaZbtafUQMKghVsykL` |
| 3 | `swap` (end-to-end) | `4BbJWm9xYJs8prZjoHdHU3rU1koTvYfVS2JeFvJjkmZDQqLqJeQAHV7HozSjPZcGy9AwTSLDSrYSB3Smbvy2vURz` |
| 3 | `open_position` | `5EjM6qwPmLmscf3JyD8CKewHvdHaVpbZyqnaQ8oaU2DZ7fRMdFU3bax1WRtrtAhPKXRygsvFPhd5uJs2SvT94GXp` |
| 3 | `increase_liquidity` | `55jr9MWCdi3GrtX7B4XoKdzM2dKajw1bwCs64NFdFCLNL3WYBgTD1Z1vaV3dkT5xC71c8fpnfzypi3HiKSQuFhnj` |
| 3 | `decrease_liquidity` | `3xJVRMVxpqQA2LmrrJLMW5FKw74Zc1mNdyyGc2n3AdHcqFMKiHk5dPczWUooo4hfn3aMV1qyw5iBS9Mt84jmCoMK` |
| 3 | `close_position` | `5xHKGRWiav653Tym9b6d6zaSXN8RkviEbqmPPDCAanGhAFGrcZVcrZtW2bhNeHGytGkPKi7UcQBb9RDAZkixx6XS` |

Test scripts at `scripts/test-orca-swap.ts`, `scripts/test-orca-open-close.ts`, `scripts/test-orca-liquidity.ts` reproduce each phase against a fresh deploy.

---

## Summary

After the remediation pass, `orca_adaptor` has no Medium or High findings and its access-control, CPI-signing, and token-custody model is tight. The remaining **L-1 (owner check on `parse_whirlpool`)** is a small, easy fix that would close the only in-code attack surface beyond a compromised keeper/admin key. The Informationals are either accepted (I-2, I-5) or cosmetic/scope-dependent (I-1, I-3, I-4). The adaptor is ready for production deployment subject to:

1. Fixing L-1 (2 lines of code).
2. Adding I-3's `spacing > 0` guard (1 line; or automatic if L-1 is fixed).
3. Operator practices: multisig / SQDS on the admin key, monitor `PausedSetEvent` / `KeeperSetEvent` for unauthorized changes, keep an on-call unpause playbook.
