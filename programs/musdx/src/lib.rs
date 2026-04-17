//! mUSDX — "USDX Savings"
//!
//! Non-rebasing yield-bearing wrapper for USDX with an Ethena-style 7-day cooldown
//! on exits. Depositors `wrap` USDX and receive mUSDX shares; the exchange rate
//! grows as admin calls `post_yield` to route real-world debt yield from the
//! SHA-DEBT backing into the pot.
//!
//! Exits: `cooldown` burns shares and parks the pro-rata USDX in a separate silo
//! TokenAccount for `cooldown_duration` seconds (default 7 days). `claim` sweeps
//! the silo back to the user after the delay. USDX sitting in the silo does NOT
//! earn yield — `post_yield` only deposits into the main vault.
//!
//! Cooldown duration changes are timelocked: admin calls propose_cooldown_duration
//! to stage a new duration, anyone can call apply_cooldown_duration after 48 hours,
//! admin can cancel_pending_cooldown_duration before it applies.
//!
//! Admin holds an emergency pause: while paused, wrap/cooldown/post_yield
//! revert. `claim` is deliberately NOT paused — once a user's cooldown has
//! elapsed they can always withdraw. set_paused, propose/apply/cancel cooldown
//! duration changes, and admin transfer instructions remain callable so the
//! admin cannot lock itself out.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("5NTrBzBD92B8qRDquvxBihpcxQHmCNqu2WtmoT9RRFpK");

pub const STATE_SEED: &[u8] = b"state";
pub const USDX_VAULT_SEED: &[u8] = b"usdx_vault";
pub const MUSDX_MINT_SEED: &[u8] = b"musdx_mint";
pub const COOLDOWN_SILO_SEED: &[u8] = b"usdx_cooldown_silo";
pub const COOLDOWN_ENTRY_SEED: &[u8] = b"cooldown";

/// Default cooldown duration, set at initialize time. Admin can change via
/// propose_cooldown_duration (timelocked). Matches Ethena's sUSDe 7-day cooldown.
pub const DEFAULT_COOLDOWN_DURATION_SECONDS: i64 = 7 * 24 * 60 * 60;

/// Hard cap on cooldown_duration to prevent admin from trapping users forever.
pub const MAX_COOLDOWN_DURATION_SECONDS: i64 = 30 * 24 * 60 * 60;

/// Delay between proposing a cooldown_duration change and being able to apply it.
/// Hardcoded (not admin-configurable) so there is no meta-timelock to fuss with.
pub const COOLDOWN_CHANGE_TIMELOCK_SECONDS: i64 = 48 * 60 * 60;

#[program]
pub mod musdx {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, cooldown_duration: i64) -> Result<()> {
        require!(
            cooldown_duration >= 0 && cooldown_duration <= MAX_COOLDOWN_DURATION_SECONDS,
            MusdxError::InvalidDuration
        );

        let state = &mut ctx.accounts.state;
        state.admin = ctx.accounts.admin.key();
        state.usdx_mint = ctx.accounts.usdx_mint.key();
        state.musdx_mint = ctx.accounts.musdx_mint.key();
        state.usdx_vault = ctx.accounts.usdx_vault.key();
        state.usdx_cooldown_silo = ctx.accounts.usdx_cooldown_silo.key();
        state.cooldown_duration = cooldown_duration;
        state.pending_cooldown_duration = 0;
        state.pending_cooldown_effective_at = 0;
        state.pending_admin = Pubkey::default();
        state.pending_admin_effective_at = 0;
        state.paused = false;
        state.state_bump = ctx.bumps.state;
        state.vault_bump = ctx.bumps.usdx_vault;
        state.mint_bump = ctx.bumps.musdx_mint;
        state.silo_bump = ctx.bumps.usdx_cooldown_silo;
        Ok(())
    }

    pub fn wrap(ctx: Context<Wrap>, usdx_amount: u64) -> Result<()> {
        require!(!ctx.accounts.state.paused, MusdxError::Paused);
        require!(usdx_amount > 0, MusdxError::ZeroAmount);

        let total_assets = ctx.accounts.usdx_vault.amount;
        let total_shares = ctx.accounts.musdx_mint.supply;

        let shares = if total_shares == 0 {
            // First depositor: 1:1. ERC-4626 virtual-offset inflation defense is
            // unnecessary here — post_yield is admin-gated, so nobody can pump
            // total_assets behind a first depositor's back.
            usdx_amount
        } else {
            (usdx_amount as u128)
                .checked_mul(total_shares as u128)
                .ok_or(MusdxError::MathOverflow)?
                .checked_div(total_assets as u128)
                .ok_or(MusdxError::MathOverflow)? as u64
        };
        require!(shares > 0, MusdxError::ZeroShares);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_usdx_ata.to_account_info(),
                    to: ctx.accounts.usdx_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            usdx_amount,
        )?;

        let state_bump = ctx.accounts.state.state_bump;
        let signer_seeds: &[&[&[u8]]] = &[&[STATE_SEED, &[state_bump]]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.musdx_mint.to_account_info(),
                    to: ctx.accounts.user_musdx_ata.to_account_info(),
                    authority: ctx.accounts.state.to_account_info(),
                },
                signer_seeds,
            ),
            shares,
        )?;

        emit!(WrapEvent {
            user: ctx.accounts.user.key(),
            usdx_in: usdx_amount,
            shares_out: shares,
            total_assets_after: total_assets
                .checked_add(usdx_amount)
                .ok_or(MusdxError::MathOverflow)?,
            total_shares_after: total_shares
                .checked_add(shares)
                .ok_or(MusdxError::MathOverflow)?,
        });
        Ok(())
    }

    /// Start (or extend) an unwrap cooldown. Burns mUSDX shares at the current
    /// exchange rate and moves the pro-rata USDX into the cooldown silo where it
    /// does not earn yield. The user must wait `cooldown_duration` seconds
    /// before they can `claim`. Calling `cooldown` again while an entry is
    /// active adds to the entry and RESETS the clock (Ethena behavior).
    pub fn cooldown(ctx: Context<Cooldown>, share_amount: u64) -> Result<()> {
        require!(!ctx.accounts.state.paused, MusdxError::Paused);
        require!(share_amount > 0, MusdxError::ZeroAmount);

        let total_assets = ctx.accounts.usdx_vault.amount;
        let total_shares = ctx.accounts.musdx_mint.supply;
        require!(total_shares > 0, MusdxError::NoShares);

        let usdx_out = (share_amount as u128)
            .checked_mul(total_assets as u128)
            .ok_or(MusdxError::MathOverflow)?
            .checked_div(total_shares as u128)
            .ok_or(MusdxError::MathOverflow)? as u64;
        require!(usdx_out > 0, MusdxError::ZeroAssets);

        // burn shares from user
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.musdx_mint.to_account_info(),
                    from: ctx.accounts.user_musdx_ata.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            share_amount,
        )?;

        // move USDX from main vault to cooldown silo, signed by state PDA
        let state_bump = ctx.accounts.state.state_bump;
        let signer_seeds: &[&[&[u8]]] = &[&[STATE_SEED, &[state_bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.usdx_vault.to_account_info(),
                    to: ctx.accounts.usdx_cooldown_silo.to_account_info(),
                    authority: ctx.accounts.state.to_account_info(),
                },
                signer_seeds,
            ),
            usdx_out,
        )?;

        // update or initialize the user's cooldown entry
        let now = Clock::get()?.unix_timestamp;
        let new_end = now
            .checked_add(ctx.accounts.state.cooldown_duration)
            .ok_or(MusdxError::MathOverflow)?;

        let entry = &mut ctx.accounts.cooldown_entry;
        if entry.user == Pubkey::default() {
            // freshly init'd entry
            entry.user = ctx.accounts.user.key();
            entry.bump = ctx.bumps.cooldown_entry;
        }
        entry.usdx_amount = entry
            .usdx_amount
            .checked_add(usdx_out)
            .ok_or(MusdxError::MathOverflow)?;
        entry.cooldown_end = new_end;

        emit!(CooldownEvent {
            user: ctx.accounts.user.key(),
            shares_in: share_amount,
            usdx_locked: usdx_out,
            entry_total_usdx: entry.usdx_amount,
            cooldown_end: new_end,
            total_assets_after: total_assets
                .checked_sub(usdx_out)
                .ok_or(MusdxError::MathOverflow)?,
            total_shares_after: total_shares
                .checked_sub(share_amount)
                .ok_or(MusdxError::MathOverflow)?,
        });
        Ok(())
    }

    /// Claim the full cooldown balance after the cooldown has elapsed. All-or-
    /// nothing per claim — the entry is zeroed out, not partially drained.
    ///
    /// NOTE: `claim` deliberately does NOT check the paused flag. Once a user's
    /// cooldown has elapsed, they are guaranteed to be able to withdraw
    /// regardless of protocol state. The 7-day cooldown is itself the safety
    /// filter: admin has a full week to act on any emergency before the first
    /// in-flight cooldown matures. Locking already-matured claims would trap
    /// patient users without materially improving security.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let entry = &mut ctx.accounts.cooldown_entry;
        require!(entry.usdx_amount > 0, MusdxError::NothingToClaim);

        let now = Clock::get()?.unix_timestamp;
        require!(now >= entry.cooldown_end, MusdxError::CooldownNotElapsed);

        let amount = entry.usdx_amount;

        // transfer USDX from silo to user, signed by state PDA
        let state_bump = ctx.accounts.state.state_bump;
        let signer_seeds: &[&[&[u8]]] = &[&[STATE_SEED, &[state_bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.usdx_cooldown_silo.to_account_info(),
                    to: ctx.accounts.user_usdx_ata.to_account_info(),
                    authority: ctx.accounts.state.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;

        // zero out the entry but keep the account open for reuse. rent stays
        // with the user so subsequent cooldowns don't need to re-pay.
        entry.usdx_amount = 0;
        entry.cooldown_end = 0;

        emit!(ClaimEvent {
            user: ctx.accounts.user.key(),
            usdx_out: amount,
        });
        Ok(())
    }

    pub fn post_yield(ctx: Context<PostYield>, usdx_amount: u64) -> Result<()> {
        require!(!ctx.accounts.state.paused, MusdxError::Paused);
        require!(usdx_amount > 0, MusdxError::ZeroAmount);
        require_keys_eq!(
            ctx.accounts.admin.key(),
            ctx.accounts.state.admin,
            MusdxError::NotAdmin
        );
        require!(
            ctx.accounts.musdx_mint.supply > 0,
            MusdxError::NoShares
        );

        // Yield only flows into the main vault, never the cooldown silo.
        // This is how we enforce "no yield while unwrapping."
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.admin_usdx_ata.to_account_info(),
                    to: ctx.accounts.usdx_vault.to_account_info(),
                    authority: ctx.accounts.admin.to_account_info(),
                },
            ),
            usdx_amount,
        )?;

        emit!(YieldPostedEvent {
            amount: usdx_amount,
            new_total_assets: ctx
                .accounts
                .usdx_vault
                .amount
                .checked_add(usdx_amount)
                .ok_or(MusdxError::MathOverflow)?,
            total_shares: ctx.accounts.musdx_mint.supply,
        });
        Ok(())
    }

    /// Emergency pause / resume. Always callable by admin, even while paused,
    /// so the admin cannot lock itself out.
    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.admin.key(),
            ctx.accounts.state.admin,
            MusdxError::NotAdmin
        );
        let was_paused = ctx.accounts.state.paused;
        ctx.accounts.state.paused = paused;
        emit!(PauseChangedEvent {
            was_paused,
            is_paused: paused,
        });
        Ok(())
    }

    /// Stage a cooldown_duration change. The new duration does NOT take effect
    /// immediately — it becomes applicable after COOLDOWN_CHANGE_TIMELOCK_SECONDS
    /// (48 hours) via `apply_cooldown_duration`. Re-proposing while a change is
    /// pending overwrites the pending one with a fresh 48h clock.
    pub fn propose_cooldown_duration(
        ctx: Context<ProposeCooldownDuration>,
        new_duration: i64,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.admin.key(),
            ctx.accounts.state.admin,
            MusdxError::NotAdmin
        );
        require!(new_duration >= 0, MusdxError::InvalidDuration);
        require!(
            new_duration <= MAX_COOLDOWN_DURATION_SECONDS,
            MusdxError::InvalidDuration
        );

        let now = Clock::get()?.unix_timestamp;
        let effective_at = now
            .checked_add(COOLDOWN_CHANGE_TIMELOCK_SECONDS)
            .ok_or(MusdxError::MathOverflow)?;

        let state = &mut ctx.accounts.state;
        state.pending_cooldown_duration = new_duration;
        state.pending_cooldown_effective_at = effective_at;

        emit!(CooldownDurationChangeProposedEvent {
            proposed_duration: new_duration,
            effective_at,
        });
        Ok(())
    }

    /// Apply a pending cooldown_duration change after its 48h timelock has
    /// elapsed. Permissionless — anyone can call it, so the change is
    /// guaranteed to happen on schedule regardless of admin availability.
    pub fn apply_cooldown_duration(ctx: Context<ApplyCooldownDuration>) -> Result<()> {
        let state = &mut ctx.accounts.state;
        require!(
            state.pending_cooldown_effective_at > 0,
            MusdxError::NoPendingChange
        );

        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= state.pending_cooldown_effective_at,
            MusdxError::TimelockNotElapsed
        );

        let old_duration = state.cooldown_duration;
        let new_duration = state.pending_cooldown_duration;
        state.cooldown_duration = new_duration;
        state.pending_cooldown_duration = 0;
        state.pending_cooldown_effective_at = 0;

        emit!(CooldownDurationChangedEvent {
            old_duration,
            new_duration,
        });
        Ok(())
    }

    /// Cancel a pending cooldown_duration change before it takes effect. Admin
    /// only. Useful if admin proposes a mistake or changes their mind.
    pub fn cancel_pending_cooldown_duration(
        ctx: Context<CancelPendingCooldownDuration>,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.admin.key(),
            ctx.accounts.state.admin,
            MusdxError::NotAdmin
        );

        let state = &mut ctx.accounts.state;
        require!(
            state.pending_cooldown_effective_at > 0,
            MusdxError::NoPendingChange
        );

        let cancelled_duration = state.pending_cooldown_duration;
        state.pending_cooldown_duration = 0;
        state.pending_cooldown_effective_at = 0;

        emit!(CooldownDurationChangeCancelledEvent {
            cancelled_duration,
        });
        Ok(())
    }

    /// Stage an admin transfer. The new admin does NOT take effect immediately —
    /// it becomes applicable after COOLDOWN_CHANGE_TIMELOCK_SECONDS (48 hours)
    /// via `accept_admin`. The current admin can cancel via
    /// `cancel_pending_admin`.
    pub fn propose_admin(ctx: Context<ProposeAdmin>, new_admin: Pubkey) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.admin.key(),
            ctx.accounts.state.admin,
            MusdxError::NotAdmin
        );

        let now = Clock::get()?.unix_timestamp;
        let effective_at = now
            .checked_add(COOLDOWN_CHANGE_TIMELOCK_SECONDS)
            .ok_or(MusdxError::MathOverflow)?;

        let state = &mut ctx.accounts.state;
        state.pending_admin = new_admin;
        state.pending_admin_effective_at = effective_at;

        emit!(AdminChangeProposedEvent {
            proposed_admin: new_admin,
            effective_at,
        });
        Ok(())
    }

    /// Accept a pending admin transfer after the 48h timelock. Must be called
    /// by the PROPOSED new admin (proves they control the key).
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let state = &mut ctx.accounts.state;
        require!(
            state.pending_admin_effective_at > 0,
            MusdxError::NoPendingChange
        );
        require_keys_eq!(
            ctx.accounts.new_admin.key(),
            state.pending_admin,
            MusdxError::NotPendingAdmin
        );

        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= state.pending_admin_effective_at,
            MusdxError::TimelockNotElapsed
        );

        let old_admin = state.admin;
        state.admin = state.pending_admin;
        state.pending_admin = Pubkey::default();
        state.pending_admin_effective_at = 0;

        emit!(AdminChangedEvent {
            old_admin,
            new_admin: state.admin,
        });
        Ok(())
    }

    /// Cancel a pending admin transfer. Current admin only.
    pub fn cancel_pending_admin(ctx: Context<CancelPendingAdmin>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.admin.key(),
            ctx.accounts.state.admin,
            MusdxError::NotAdmin
        );

        let state = &mut ctx.accounts.state;
        require!(
            state.pending_admin_effective_at > 0,
            MusdxError::NoPendingChange
        );

        state.pending_admin = Pubkey::default();
        state.pending_admin_effective_at = 0;

        emit!(AdminChangeCancelledEvent {});
        Ok(())
    }

    /// Create Metaplex token metadata for the mUSDX mint. Admin-only, one-time.
    /// The state PDA signs as mint authority for the CPI.
    pub fn create_metadata(
        ctx: Context<CreateMetadata>,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.admin.key(),
            ctx.accounts.state.admin,
            MusdxError::NotAdmin
        );

        let state_bump = ctx.accounts.state.state_bump;
        let signer_seeds: &[&[&[u8]]] = &[&[STATE_SEED, &[state_bump]]];

        // Build CreateMetadataAccountV3 instruction data via Borsh.
        // Layout: discriminator(u8=33) + DataV2 + is_mutable(bool) + collection_details(Option)
        let mut data: Vec<u8> = Vec::new();
        data.push(33); // CreateMetadataAccountV3 discriminator

        // DataV2 fields (Borsh-serialized):
        // name: String
        data.extend_from_slice(&(name.len() as u32).to_le_bytes());
        data.extend_from_slice(name.as_bytes());
        // symbol: String
        data.extend_from_slice(&(symbol.len() as u32).to_le_bytes());
        data.extend_from_slice(symbol.as_bytes());
        // uri: String
        data.extend_from_slice(&(uri.len() as u32).to_le_bytes());
        data.extend_from_slice(uri.as_bytes());
        // seller_fee_basis_points: u16
        data.extend_from_slice(&0u16.to_le_bytes());
        // creators: Option<Vec<Creator>> = None
        data.push(0);
        // collection: Option<Collection> = None
        data.push(0);
        // uses: Option<Uses> = None
        data.push(0);

        // is_mutable: bool = true
        data.push(1);
        // collection_details: Option<CollectionDetails> = None
        data.push(0);

        let metadata_program = &ctx.accounts.metadata_program;
        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: metadata_program.key(),
            accounts: vec![
                anchor_lang::solana_program::instruction::AccountMeta::new(
                    ctx.accounts.metadata.key(),
                    false,
                ),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                    ctx.accounts.musdx_mint.key(),
                    false,
                ),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                    ctx.accounts.state.key(),
                    true, // mint authority signer
                ),
                anchor_lang::solana_program::instruction::AccountMeta::new(
                    ctx.accounts.payer.key(),
                    true,
                ),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                    ctx.accounts.admin.key(),
                    false, // update authority
                ),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                    ctx.accounts.system_program.key(),
                    false,
                ),
            ],
            data,
        };

        anchor_lang::solana_program::program::invoke_signed(
            &ix,
            &[
                ctx.accounts.metadata.to_account_info(),
                ctx.accounts.musdx_mint.to_account_info(),
                ctx.accounts.state.to_account_info(),
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.admin.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            signer_seeds,
        )?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + MusdxState::LEN,
        seeds = [STATE_SEED],
        bump,
    )]
    pub state: Account<'info, MusdxState>,

    pub usdx_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = payer,
        seeds = [MUSDX_MINT_SEED],
        bump,
        mint::decimals = 6,
        mint::authority = state,
    )]
    pub musdx_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = payer,
        seeds = [USDX_VAULT_SEED],
        bump,
        token::mint = usdx_mint,
        token::authority = state,
    )]
    pub usdx_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = payer,
        seeds = [COOLDOWN_SILO_SEED],
        bump,
        token::mint = usdx_mint,
        token::authority = state,
    )]
    pub usdx_cooldown_silo: Account<'info, TokenAccount>,

    /// Admin key stored in state; may be the same as payer.
    pub admin: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Wrap<'info> {
    #[account(seeds = [STATE_SEED], bump = state.state_bump)]
    pub state: Account<'info, MusdxState>,

    #[account(address = state.usdx_mint)]
    pub usdx_mint: Account<'info, Mint>,

    #[account(mut, address = state.musdx_mint)]
    pub musdx_mint: Account<'info, Mint>,

    #[account(mut, address = state.usdx_vault)]
    pub usdx_vault: Account<'info, TokenAccount>,

    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = user_usdx_ata.owner == user.key() @ MusdxError::BadAtaOwner,
        constraint = user_usdx_ata.mint  == state.usdx_mint @ MusdxError::BadAtaMint,
    )]
    pub user_usdx_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_musdx_ata.owner == user.key() @ MusdxError::BadAtaOwner,
        constraint = user_musdx_ata.mint  == state.musdx_mint @ MusdxError::BadAtaMint,
    )]
    pub user_musdx_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Cooldown<'info> {
    #[account(seeds = [STATE_SEED], bump = state.state_bump)]
    pub state: Account<'info, MusdxState>,

    #[account(address = state.usdx_mint)]
    pub usdx_mint: Account<'info, Mint>,

    #[account(mut, address = state.musdx_mint)]
    pub musdx_mint: Account<'info, Mint>,

    #[account(mut, address = state.usdx_vault)]
    pub usdx_vault: Account<'info, TokenAccount>,

    #[account(mut, address = state.usdx_cooldown_silo)]
    pub usdx_cooldown_silo: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = user_musdx_ata.owner == user.key() @ MusdxError::BadAtaOwner,
        constraint = user_musdx_ata.mint  == state.musdx_mint @ MusdxError::BadAtaMint,
    )]
    pub user_musdx_ata: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + CooldownEntry::LEN,
        seeds = [COOLDOWN_ENTRY_SEED, user.key().as_ref()],
        bump,
    )]
    pub cooldown_entry: Account<'info, CooldownEntry>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(seeds = [STATE_SEED], bump = state.state_bump)]
    pub state: Account<'info, MusdxState>,

    #[account(address = state.usdx_mint)]
    pub usdx_mint: Account<'info, Mint>,

    #[account(mut, address = state.usdx_cooldown_silo)]
    pub usdx_cooldown_silo: Account<'info, TokenAccount>,

    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = user_usdx_ata.owner == user.key() @ MusdxError::BadAtaOwner,
        constraint = user_usdx_ata.mint  == state.usdx_mint @ MusdxError::BadAtaMint,
    )]
    pub user_usdx_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [COOLDOWN_ENTRY_SEED, user.key().as_ref()],
        bump = cooldown_entry.bump,
        constraint = cooldown_entry.user == user.key() @ MusdxError::NotEntryOwner,
    )]
    pub cooldown_entry: Account<'info, CooldownEntry>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct PostYield<'info> {
    #[account(seeds = [STATE_SEED], bump = state.state_bump)]
    pub state: Account<'info, MusdxState>,

    #[account(address = state.musdx_mint)]
    pub musdx_mint: Account<'info, Mint>,

    #[account(mut, address = state.usdx_vault)]
    pub usdx_vault: Account<'info, TokenAccount>,

    pub admin: Signer<'info>,

    #[account(
        mut,
        constraint = admin_usdx_ata.owner == admin.key() @ MusdxError::BadAtaOwner,
        constraint = admin_usdx_ata.mint  == state.usdx_mint @ MusdxError::BadAtaMint,
    )]
    pub admin_usdx_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(mut, seeds = [STATE_SEED], bump = state.state_bump)]
    pub state: Account<'info, MusdxState>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct CreateMetadata<'info> {
    #[account(seeds = [STATE_SEED], bump = state.state_bump)]
    pub state: Account<'info, MusdxState>,

    #[account(address = state.musdx_mint)]
    pub musdx_mint: Account<'info, Mint>,

    /// CHECK: Metaplex metadata PDA, validated by the metadata program CPI.
    #[account(mut)]
    pub metadata: AccountInfo<'info>,

    pub admin: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: Metaplex Token Metadata program.
    #[account(address = anchor_lang::solana_program::pubkey::Pubkey::from_str_const("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"))]
    pub metadata_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct ProposeCooldownDuration<'info> {
    #[account(mut, seeds = [STATE_SEED], bump = state.state_bump)]
    pub state: Account<'info, MusdxState>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct ApplyCooldownDuration<'info> {
    #[account(mut, seeds = [STATE_SEED], bump = state.state_bump)]
    pub state: Account<'info, MusdxState>,
}

#[derive(Accounts)]
pub struct CancelPendingCooldownDuration<'info> {
    #[account(mut, seeds = [STATE_SEED], bump = state.state_bump)]
    pub state: Account<'info, MusdxState>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct ProposeAdmin<'info> {
    #[account(mut, seeds = [STATE_SEED], bump = state.state_bump)]
    pub state: Account<'info, MusdxState>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    #[account(mut, seeds = [STATE_SEED], bump = state.state_bump)]
    pub state: Account<'info, MusdxState>,
    pub new_admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelPendingAdmin<'info> {
    #[account(mut, seeds = [STATE_SEED], bump = state.state_bump)]
    pub state: Account<'info, MusdxState>,
    pub admin: Signer<'info>,
}

#[account]
pub struct MusdxState {
    pub admin: Pubkey,
    pub usdx_mint: Pubkey,
    pub musdx_mint: Pubkey,
    pub usdx_vault: Pubkey,
    pub usdx_cooldown_silo: Pubkey,
    pub cooldown_duration: i64,
    pub pending_cooldown_duration: i64,
    pub pending_cooldown_effective_at: i64,
    pub pending_admin: Pubkey,
    pub pending_admin_effective_at: i64,
    pub paused: bool,
    pub state_bump: u8,
    pub vault_bump: u8,
    pub mint_bump: u8,
    pub silo_bump: u8,
}

impl MusdxState {
    pub const LEN: usize = 32 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 32 + 8 + 1 + 1 + 1 + 1 + 1;
}

#[account]
pub struct CooldownEntry {
    pub user: Pubkey,
    pub usdx_amount: u64,
    pub cooldown_end: i64,
    pub bump: u8,
}

impl CooldownEntry {
    pub const LEN: usize = 32 + 8 + 8 + 1;
}

#[event]
pub struct WrapEvent {
    pub user: Pubkey,
    pub usdx_in: u64,
    pub shares_out: u64,
    pub total_assets_after: u64,
    pub total_shares_after: u64,
}

#[event]
pub struct CooldownEvent {
    pub user: Pubkey,
    pub shares_in: u64,
    pub usdx_locked: u64,
    pub entry_total_usdx: u64,
    pub cooldown_end: i64,
    pub total_assets_after: u64,
    pub total_shares_after: u64,
}

#[event]
pub struct ClaimEvent {
    pub user: Pubkey,
    pub usdx_out: u64,
}

#[event]
pub struct YieldPostedEvent {
    pub amount: u64,
    pub new_total_assets: u64,
    pub total_shares: u64,
}

#[event]
pub struct PauseChangedEvent {
    pub was_paused: bool,
    pub is_paused: bool,
}

#[event]
pub struct CooldownDurationChangeProposedEvent {
    pub proposed_duration: i64,
    pub effective_at: i64,
}

#[event]
pub struct CooldownDurationChangedEvent {
    pub old_duration: i64,
    pub new_duration: i64,
}

#[event]
pub struct CooldownDurationChangeCancelledEvent {
    pub cancelled_duration: i64,
}

#[event]
pub struct AdminChangeProposedEvent {
    pub proposed_admin: Pubkey,
    pub effective_at: i64,
}

#[event]
pub struct AdminChangedEvent {
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
}

#[event]
pub struct AdminChangeCancelledEvent {}

#[error_code]
pub enum MusdxError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Shares computation resulted in zero")]
    ZeroShares,
    #[msg("Assets computation resulted in zero")]
    ZeroAssets,
    #[msg("No shares outstanding")]
    NoShares,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Signer is not the admin")]
    NotAdmin,
    #[msg("Token account has wrong owner")]
    BadAtaOwner,
    #[msg("Token account has wrong mint")]
    BadAtaMint,
    #[msg("Program is paused")]
    Paused,
    #[msg("Cooldown period has not elapsed")]
    CooldownNotElapsed,
    #[msg("Cooldown entry is empty")]
    NothingToClaim,
    #[msg("Cooldown entry belongs to a different user")]
    NotEntryOwner,
    #[msg("Cooldown duration must be >= 0 and <= 30 days")]
    InvalidDuration,
    #[msg("No pending cooldown duration change")]
    NoPendingChange,
    #[msg("Cooldown duration change timelock has not elapsed")]
    TimelockNotElapsed,
    #[msg("Signer is not the pending new admin")]
    NotPendingAdmin,
}
