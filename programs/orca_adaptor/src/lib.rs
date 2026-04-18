//! orca_adaptor — Voltr/Ranger adaptor for Orca Whirlpools.
//!
//! Phase 1: swap-only. Admin/keeper can direct the strategy to swap its
//! asset into / out of any Whirlpool via a single CPI. Voltr's standard
//! `initialize`/`deposit`/`withdraw` handlers are implemented so the
//! adaptor plugs directly into a Voltr vault.
//!
//! Future phases will add concentrated-liquidity position management
//! (open_position, increase_liquidity, decrease_liquidity, close_position)
//! in the same program.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

mod whirlpool_cpi;

declare_id!("5o35D7VMZpJpN9JQxuhzdGiYQofNfgXQFcuWxihFD8Lc");

pub const CONFIG_SEED: &[u8] = b"orca_strategy_config";

/// Shared L-2/L-5 check for the modify-liquidity ixs: the passed Whirlpool
/// vaults + strategy ATA mints must match the Whirlpool's stored state.
fn validate_modify_liquidity_pool(accounts: &ModifyLiquidityAccounts) -> Result<()> {
    let wp = whirlpool_cpi::parse_whirlpool(&accounts.whirlpool)
        .ok_or(OrcaAdaptorError::InvalidWhirlpool)?;
    require_keys_eq!(
        wp.token_vault_a,
        accounts.token_vault_a.key(),
        OrcaAdaptorError::WhirlpoolVaultMismatch
    );
    require_keys_eq!(
        wp.token_vault_b,
        accounts.token_vault_b.key(),
        OrcaAdaptorError::WhirlpoolVaultMismatch
    );
    require_keys_eq!(
        wp.token_mint_a,
        accounts.token_owner_account_a.mint,
        OrcaAdaptorError::TokenMintMismatch
    );
    require_keys_eq!(
        wp.token_mint_b,
        accounts.token_owner_account_b.mint,
        OrcaAdaptorError::TokenMintMismatch
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

#[program]
pub mod orca_adaptor {
    use super::*;

    /// Create the per-vault config PDA. Run once by the admin before
    /// registering with Voltr.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        args: InitializeConfigArgs,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.keeper = ctx.accounts.admin.key();
        config.voltr_vault = args.voltr_vault;
        config.asset_mint = args.asset_mint;
        config.bump = ctx.bumps.config;
        config.paused = false;
        config.min_swap_out_bps = 0;
        Ok(())
    }

    /// Rotate the admin. Admin only. No timelock — for extra safety pair
    /// this with off-chain multisig / SQDS on the admin key.
    pub fn set_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.admin.key(),
            ctx.accounts.config.admin,
            OrcaAdaptorError::NotAdmin
        );
        let old = ctx.accounts.config.admin;
        ctx.accounts.config.admin = new_admin;
        emit!(AdminSetEvent { old, new: new_admin });
        Ok(())
    }

    /// Rotate the keeper (admin only).
    pub fn set_keeper(ctx: Context<AdminOnly>, new_keeper: Pubkey) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.admin.key(),
            ctx.accounts.config.admin,
            OrcaAdaptorError::NotAdmin
        );
        let old = ctx.accounts.config.keeper;
        ctx.accounts.config.keeper = new_keeper;
        emit!(KeeperSetEvent { old, new: new_keeper });
        Ok(())
    }

    /// Pause/unpause (admin only).
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.admin.key(),
            ctx.accounts.config.admin,
            OrcaAdaptorError::NotAdmin
        );
        ctx.accounts.config.paused = paused;
        emit!(PausedSetEvent { paused });
        Ok(())
    }

    /// Set `min_swap_out_bps` — the minimum out/in ratio enforced on swap
    /// for pegged-pair pools. 0 disables the check. Max 10_000 (100%).
    pub fn set_swap_params(ctx: Context<AdminOnly>, min_swap_out_bps: u16) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.admin.key(),
            ctx.accounts.config.admin,
            OrcaAdaptorError::NotAdmin
        );
        require!(min_swap_out_bps <= 10_000, OrcaAdaptorError::InvalidSlippage);
        ctx.accounts.config.min_swap_out_bps = min_swap_out_bps;
        emit!(SwapParamsSetEvent { min_swap_out_bps });
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Voltr CPI handlers
    // -----------------------------------------------------------------------

    /// Called by Voltr's `initialize_strategy` CPI. Validates that the
    /// `strategy` account Voltr is about to register matches this adaptor's
    /// config PDA for the given vault — otherwise Voltr could wire up a
    /// receipt pointing at an uninitialized account.
    pub fn initialize(ctx: Context<VoltrInitialize>, voltr_vault: Pubkey) -> Result<()> {
        let (expected_config, _) = Pubkey::find_program_address(
            &[CONFIG_SEED, voltr_vault.as_ref()],
            &crate::ID,
        );
        require_keys_eq!(
            ctx.accounts.strategy.key(),
            expected_config,
            OrcaAdaptorError::InvalidStrategyPda
        );
        require_keys_eq!(
            ctx.accounts.vault.key(),
            voltr_vault,
            OrcaAdaptorError::InvalidVoltrVault
        );
        msg!("orca_adaptor strategy registered with Voltr");
        Ok(())
    }

    /// Called by Voltr's `deposit_strategy` CPI. Moves the vault asset from
    /// the vaultStrategyAuth ATA to the config PDA's asset ATA
    /// (remaining_accounts[0]) and returns the position value.
    pub fn deposit<'info>(
        ctx: Context<'_, '_, 'info, 'info, VoltrDeposit<'info>>,
    ) -> Result<()> {
        let config = &ctx.accounts.strategy;
        require!(!config.paused, OrcaAdaptorError::Paused);

        let idle = ctx.accounts.vault_strategy_asset_ata.amount;
        if idle > 0 && !ctx.remaining_accounts.is_empty() {
            let strategy_asset_ata = &ctx.remaining_accounts[0];
            token::transfer(
                CpiContext::new(
                    ctx.accounts.asset_token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault_strategy_asset_ata.to_account_info(),
                        to: strategy_asset_ata.to_account_info(),
                        authority: ctx.accounts.vault_strategy_auth.to_account_info(),
                    },
                ),
                idle,
            )?;
        }

        // Phase 1: position value == asset on hand. Later phases will add the
        // value of any open Whirlpool position to this.
        let position_value = idle;
        anchor_lang::solana_program::program::set_return_data(
            &position_value.to_le_bytes(),
        );
        Ok(())
    }

    /// Called by Voltr's `withdraw_strategy` CPI. Returns the current
    /// position value as the Voltr return data.
    pub fn withdraw(ctx: Context<VoltrWithdraw>) -> Result<()> {
        let idle = ctx.accounts.vault_strategy_asset_ata.amount;
        let position_value = idle;
        anchor_lang::solana_program::program::set_return_data(
            &position_value.to_le_bytes(),
        );
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Swap — Phase 1 primary feature
    // -----------------------------------------------------------------------

    /// Swap the strategy's holdings through any Whirlpool. Keeper only.
    ///
    /// `amount_in` is the exact input amount, denominated in token-A if
    /// `a_to_b`, otherwise token-B. `min_amount_out` enforces slippage on
    /// Whirlpool's side — if the swap would produce less than this, it
    /// reverts inside Whirlpool.
    ///
    /// `sqrt_price_limit` can be passed as 0 to fall back to Whirlpool's
    /// default (no tick limit). Tick arrays must be computed off-chain and
    /// passed in the correct swap direction.
    pub fn swap<'info>(
        ctx: Context<'_, '_, 'info, 'info, SwapAccounts<'info>>,
        amount_in: u64,
        min_amount_out: u64,
        a_to_b: bool,
        sqrt_price_limit: u128,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, OrcaAdaptorError::Paused);
        require!(amount_in > 0, OrcaAdaptorError::ZeroAmount);
        // M-1: require a non-trivial slippage floor. A compromised keeper
        // passing `min_amount_out = 0` with extreme sqrt_price_limit would
        // otherwise accept any fill Whirlpool can produce (sandwich bait).
        require!(min_amount_out > 0, OrcaAdaptorError::NoSlippageFloor);
        // Optional stricter floor for pegged pairs (admin-set).
        if config.min_swap_out_bps > 0 {
            let required = (amount_in as u128)
                .checked_mul(config.min_swap_out_bps as u128)
                .ok_or(OrcaAdaptorError::MathOverflow)?
                .checked_div(10_000)
                .ok_or(OrcaAdaptorError::MathOverflow)? as u64;
            require!(min_amount_out >= required, OrcaAdaptorError::SwapOutBelowFloor);
        }
        require_keys_eq!(
            ctx.accounts.keeper.key(),
            config.keeper,
            OrcaAdaptorError::NotKeeper
        );

        // L-2 + L-5: validate the Whirlpool's advertised token mints and
        // vaults match what the caller passed. Prevents a keeper routing
        // through the wrong pool (MEV vector) or a pool it controls.
        let wp = whirlpool_cpi::parse_whirlpool(&ctx.accounts.whirlpool)
            .ok_or(OrcaAdaptorError::InvalidWhirlpool)?;
        require_keys_eq!(
            wp.token_vault_a,
            ctx.accounts.whirlpool_vault_a.key(),
            OrcaAdaptorError::WhirlpoolVaultMismatch
        );
        require_keys_eq!(
            wp.token_vault_b,
            ctx.accounts.whirlpool_vault_b.key(),
            OrcaAdaptorError::WhirlpoolVaultMismatch
        );
        require_keys_eq!(
            wp.token_mint_a,
            ctx.accounts.strategy_token_a_ata.mint,
            OrcaAdaptorError::TokenMintMismatch
        );
        require_keys_eq!(
            wp.token_mint_b,
            ctx.accounts.strategy_token_b_ata.mint,
            OrcaAdaptorError::TokenMintMismatch
        );

        let voltr_vault = config.voltr_vault;
        let bump = config.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[CONFIG_SEED, voltr_vault.as_ref(), &[bump]]];

        whirlpool_cpi::swap(
            &ctx.accounts.whirlpool_program,
            &ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.config.to_account_info(), // token_authority (PDA)
            &ctx.accounts.whirlpool,
            &ctx.accounts.strategy_token_a_ata.to_account_info(),
            &ctx.accounts.whirlpool_vault_a,
            &ctx.accounts.strategy_token_b_ata.to_account_info(),
            &ctx.accounts.whirlpool_vault_b,
            &ctx.accounts.tick_array_0,
            &ctx.accounts.tick_array_1,
            &ctx.accounts.tick_array_2,
            &ctx.accounts.oracle,
            amount_in,
            min_amount_out,
            sqrt_price_limit,
            /* amount_specified_is_input */ true,
            a_to_b,
            signer_seeds,
        )?;

        emit!(SwapEvent {
            amount_in,
            min_amount_out,
            a_to_b,
            whirlpool: ctx.accounts.whirlpool.key(),
        });
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Position management — Phase 2
    // -----------------------------------------------------------------------

    /// Open a concentrated-liquidity position on a Whirlpool. The Position
    /// NFT is minted to the config PDA's position_token_account, making the
    /// strategy the sole controller of the position.
    ///
    /// `tick_lower_index` and `tick_upper_index` must each be a multiple of
    /// the Whirlpool's `tick_spacing` and satisfy `lower < upper`.
    pub fn open_position(
        ctx: Context<OpenPositionAccounts>,
        tick_lower_index: i32,
        tick_upper_index: i32,
        position_bump: u8,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, OrcaAdaptorError::Paused);
        require_keys_eq!(
            ctx.accounts.keeper.key(),
            config.keeper,
            OrcaAdaptorError::NotKeeper
        );
        require!(
            tick_lower_index < tick_upper_index,
            OrcaAdaptorError::InvalidTickRange
        );

        // I-4: enforce tick-spacing alignment early with a clear error.
        let wp = whirlpool_cpi::parse_whirlpool(&ctx.accounts.whirlpool)
            .ok_or(OrcaAdaptorError::InvalidWhirlpool)?;
        let spacing = wp.tick_spacing as i32;
        require!(
            tick_lower_index.rem_euclid(spacing) == 0,
            OrcaAdaptorError::InvalidTickAlignment
        );
        require!(
            tick_upper_index.rem_euclid(spacing) == 0,
            OrcaAdaptorError::InvalidTickAlignment
        );

        whirlpool_cpi::open_position(
            &ctx.accounts.whirlpool_program,
            &ctx.accounts.funder.to_account_info(),
            &ctx.accounts.config.to_account_info(), // owner = config PDA
            &ctx.accounts.position,
            &ctx.accounts.position_mint.to_account_info(),
            &ctx.accounts.position_token_account,
            &ctx.accounts.whirlpool,
            &ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            &ctx.accounts.rent.to_account_info(),
            &ctx.accounts.associated_token_program.to_account_info(),
            position_bump,
            tick_lower_index,
            tick_upper_index,
        )?;

        emit!(OpenPositionEvent {
            whirlpool: ctx.accounts.whirlpool.key(),
            position: ctx.accounts.position.key(),
            position_mint: ctx.accounts.position_mint.key(),
            tick_lower_index,
            tick_upper_index,
        });
        Ok(())
    }

    /// Close a previously-opened position. Whirlpool requires 0 liquidity
    /// and 0 fees/rewards owed before the position can be closed; call
    /// `decrease_liquidity` + any collect ixs first (Phase 3 / follow-up).
    pub fn close_position(ctx: Context<ClosePositionAccounts>) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, OrcaAdaptorError::Paused);
        require_keys_eq!(
            ctx.accounts.keeper.key(),
            config.keeper,
            OrcaAdaptorError::NotKeeper
        );

        let voltr_vault = config.voltr_vault;
        let bump = config.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[CONFIG_SEED, voltr_vault.as_ref(), &[bump]]];

        whirlpool_cpi::close_position(
            &ctx.accounts.whirlpool_program,
            &ctx.accounts.config.to_account_info(), // position_authority (PDA)
            &ctx.accounts.receiver,
            &ctx.accounts.position,
            &ctx.accounts.position_mint,
            &ctx.accounts.position_token_account,
            &ctx.accounts.token_program.to_account_info(),
            signer_seeds,
        )?;

        emit!(ClosePositionEvent {
            position: ctx.accounts.position.key(),
        });
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Liquidity management — Phase 3
    // -----------------------------------------------------------------------

    /// Add liquidity to an open position. `token_max_a/b` are the maximum
    /// token amounts the caller is willing to spend; Whirlpool computes the
    /// exact amounts needed given current price + tick range.
    pub fn increase_liquidity(
        ctx: Context<ModifyLiquidityAccounts>,
        liquidity_amount: u128,
        token_max_a: u64,
        token_max_b: u64,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, OrcaAdaptorError::Paused);
        require!(liquidity_amount > 0, OrcaAdaptorError::ZeroAmount);
        require_keys_eq!(
            ctx.accounts.keeper.key(),
            config.keeper,
            OrcaAdaptorError::NotKeeper
        );
        validate_modify_liquidity_pool(&ctx.accounts)?;

        let voltr_vault = config.voltr_vault;
        let bump = config.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[CONFIG_SEED, voltr_vault.as_ref(), &[bump]]];

        whirlpool_cpi::increase_liquidity(
            &ctx.accounts.whirlpool_program,
            &ctx.accounts.whirlpool,
            &ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.config.to_account_info(),
            &ctx.accounts.position,
            &ctx.accounts.position_token_account,
            &ctx.accounts.token_owner_account_a.to_account_info(),
            &ctx.accounts.token_owner_account_b.to_account_info(),
            &ctx.accounts.token_vault_a,
            &ctx.accounts.token_vault_b,
            &ctx.accounts.tick_array_lower,
            &ctx.accounts.tick_array_upper,
            liquidity_amount,
            token_max_a,
            token_max_b,
            signer_seeds,
        )?;

        emit!(IncreaseLiquidityEvent {
            position: ctx.accounts.position.key(),
            liquidity_amount,
            token_max_a,
            token_max_b,
        });
        Ok(())
    }

    /// Remove liquidity from an open position. `token_min_a/b` are slippage
    /// floors — Whirlpool reverts if the withdrawn amounts would be below.
    pub fn decrease_liquidity(
        ctx: Context<ModifyLiquidityAccounts>,
        liquidity_amount: u128,
        token_min_a: u64,
        token_min_b: u64,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, OrcaAdaptorError::Paused);
        require!(liquidity_amount > 0, OrcaAdaptorError::ZeroAmount);
        require_keys_eq!(
            ctx.accounts.keeper.key(),
            config.keeper,
            OrcaAdaptorError::NotKeeper
        );
        validate_modify_liquidity_pool(&ctx.accounts)?;

        let voltr_vault = config.voltr_vault;
        let bump = config.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[CONFIG_SEED, voltr_vault.as_ref(), &[bump]]];

        whirlpool_cpi::decrease_liquidity(
            &ctx.accounts.whirlpool_program,
            &ctx.accounts.whirlpool,
            &ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.config.to_account_info(),
            &ctx.accounts.position,
            &ctx.accounts.position_token_account,
            &ctx.accounts.token_owner_account_a.to_account_info(),
            &ctx.accounts.token_owner_account_b.to_account_info(),
            &ctx.accounts.token_vault_a,
            &ctx.accounts.token_vault_b,
            &ctx.accounts.tick_array_lower,
            &ctx.accounts.tick_array_upper,
            liquidity_amount,
            token_min_a,
            token_min_b,
            signer_seeds,
        )?;

        emit!(DecreaseLiquidityEvent {
            position: ctx.accounts.position.key(),
            liquidity_amount,
            token_min_a,
            token_min_b,
        });
        Ok(())
    }
}

// ===========================================================================
// Account contexts
// ===========================================================================

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeConfigArgs {
    pub voltr_vault: Pubkey,
    pub asset_mint: Pubkey,
}

#[derive(Accounts)]
#[instruction(args: InitializeConfigArgs)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + OrcaStrategyConfig::LEN,
        seeds = [CONFIG_SEED, args.voltr_vault.as_ref()],
        bump,
    )]
    pub config: Box<Account<'info, OrcaStrategyConfig>>,

    pub admin: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED, config.voltr_vault.as_ref()],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, OrcaStrategyConfig>>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct VoltrInitialize<'info> {
    pub payer: Signer<'info>,
    pub manager: Signer<'info>,
    /// CHECK: Voltr vault account (validated by Voltr).
    pub vault: AccountInfo<'info>,
    /// CHECK: Strategy PDA — matches our config_pda seeds.
    pub strategy: AccountInfo<'info>,
    /// CHECK: Strategy init receipt (Voltr).
    #[account(mut)]
    pub strategy_init_receipt: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VoltrDeposit<'info> {
    #[account(
        seeds = [CONFIG_SEED, strategy.voltr_vault.as_ref()],
        bump = strategy.bump,
    )]
    pub strategy: Box<Account<'info, OrcaStrategyConfig>>,

    /// CHECK: Voltr's vaultStrategyAuth PDA (authority of the transfer source).
    pub vault_strategy_auth: AccountInfo<'info>,

    /// Asset ATA owned by vault_strategy_auth.
    #[account(mut)]
    pub vault_strategy_asset_ata: Box<Account<'info, TokenAccount>>,

    /// CHECK: Token program the asset mint uses (Token or Token-2022).
    pub asset_token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct VoltrWithdraw<'info> {
    #[account(
        seeds = [CONFIG_SEED, strategy.voltr_vault.as_ref()],
        bump = strategy.bump,
    )]
    pub strategy: Box<Account<'info, OrcaStrategyConfig>>,

    #[account(mut)]
    pub vault_strategy_asset_ata: Box<Account<'info, TokenAccount>>,
}

#[derive(Accounts)]
pub struct SwapAccounts<'info> {
    #[account(
        seeds = [CONFIG_SEED, config.voltr_vault.as_ref()],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, OrcaStrategyConfig>>,

    pub keeper: Signer<'info>,

    /// Strategy's token-A ATA (owner = config PDA). L-1: ownership enforced.
    #[account(mut, constraint = strategy_token_a_ata.owner == config.key() @ OrcaAdaptorError::StrategyAtaOwnerMismatch)]
    pub strategy_token_a_ata: Box<Account<'info, TokenAccount>>,

    /// Strategy's token-B ATA (owner = config PDA). L-1: ownership enforced.
    #[account(mut, constraint = strategy_token_b_ata.owner == config.key() @ OrcaAdaptorError::StrategyAtaOwnerMismatch)]
    pub strategy_token_b_ata: Box<Account<'info, TokenAccount>>,

    /// CHECK: Whirlpool account.
    #[account(mut)]
    pub whirlpool: AccountInfo<'info>,

    /// CHECK: Whirlpool's token-A vault.
    #[account(mut)]
    pub whirlpool_vault_a: AccountInfo<'info>,

    /// CHECK: Whirlpool's token-B vault.
    #[account(mut)]
    pub whirlpool_vault_b: AccountInfo<'info>,

    /// CHECK: Tick array 0 (current).
    #[account(mut)]
    pub tick_array_0: AccountInfo<'info>,

    /// CHECK: Tick array 1.
    #[account(mut)]
    pub tick_array_1: AccountInfo<'info>,

    /// CHECK: Tick array 2.
    #[account(mut)]
    pub tick_array_2: AccountInfo<'info>,

    /// CHECK: Whirlpool oracle PDA (mutable; newer Whirlpool versions update TWAP state here).
    #[account(mut)]
    pub oracle: AccountInfo<'info>,

    /// CHECK: Orca Whirlpool program.
    #[account(address = whirlpool_cpi::WHIRLPOOL_PROGRAM_ID)]
    pub whirlpool_program: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct OpenPositionAccounts<'info> {
    #[account(
        seeds = [CONFIG_SEED, config.voltr_vault.as_ref()],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, OrcaStrategyConfig>>,

    pub keeper: Signer<'info>,

    /// Funder pays rent for the new Position account and token mint.
    #[account(mut)]
    pub funder: Signer<'info>,

    /// New Keypair generated client-side; the Whirlpool program inits this
    /// account and makes it a 0-decimal NFT mint.
    #[account(mut)]
    pub position_mint: Signer<'info>,

    /// CHECK: Position account — initialized by Whirlpool. PDA seeds:
    /// `[b"position", position_mint.key()]` under the Whirlpool program.
    #[account(mut)]
    pub position: AccountInfo<'info>,

    /// CHECK: ATA(position_mint, config_pda) — receives the single Position
    /// NFT. Whirlpool creates this via the AssociatedToken program.
    #[account(mut)]
    pub position_token_account: AccountInfo<'info>,

    /// CHECK: Whirlpool this position is on.
    pub whirlpool: AccountInfo<'info>,

    /// CHECK: Orca Whirlpool program.
    #[account(address = whirlpool_cpi::WHIRLPOOL_PROGRAM_ID)]
    pub whirlpool_program: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    /// CHECK: Rent sysvar.
    pub rent: AccountInfo<'info>,
    /// CHECK: Associated Token program.
    pub associated_token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct ModifyLiquidityAccounts<'info> {
    #[account(
        seeds = [CONFIG_SEED, config.voltr_vault.as_ref()],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, OrcaStrategyConfig>>,

    pub keeper: Signer<'info>,

    /// CHECK: Whirlpool the position is on.
    #[account(mut)]
    pub whirlpool: AccountInfo<'info>,

    /// CHECK: Position account.
    #[account(mut)]
    pub position: AccountInfo<'info>,

    /// CHECK: ATA holding the position NFT (owner = config PDA); proves
    /// we're authorized to modify the position.
    pub position_token_account: AccountInfo<'info>,

    /// Strategy's token-A ATA (source on increase, dest on decrease).
    /// L-1: ownership enforced.
    #[account(mut, constraint = token_owner_account_a.owner == config.key() @ OrcaAdaptorError::StrategyAtaOwnerMismatch)]
    pub token_owner_account_a: Box<Account<'info, TokenAccount>>,

    /// Strategy's token-B ATA. L-1: ownership enforced.
    #[account(mut, constraint = token_owner_account_b.owner == config.key() @ OrcaAdaptorError::StrategyAtaOwnerMismatch)]
    pub token_owner_account_b: Box<Account<'info, TokenAccount>>,

    /// CHECK: Whirlpool's token-A vault.
    #[account(mut)]
    pub token_vault_a: AccountInfo<'info>,

    /// CHECK: Whirlpool's token-B vault.
    #[account(mut)]
    pub token_vault_b: AccountInfo<'info>,

    /// CHECK: Tick array covering the position's lower tick.
    #[account(mut)]
    pub tick_array_lower: AccountInfo<'info>,

    /// CHECK: Tick array covering the position's upper tick.
    #[account(mut)]
    pub tick_array_upper: AccountInfo<'info>,

    /// CHECK: Orca Whirlpool program.
    #[account(address = whirlpool_cpi::WHIRLPOOL_PROGRAM_ID)]
    pub whirlpool_program: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClosePositionAccounts<'info> {
    #[account(
        seeds = [CONFIG_SEED, config.voltr_vault.as_ref()],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, OrcaStrategyConfig>>,

    pub keeper: Signer<'info>,

    /// Receives the lamports refunded from closing the Position account
    /// and the Position NFT mint. L-4: forced to be the admin so a
    /// compromised keeper can't redirect rent.
    /// CHECK: address-constrained to config.admin.
    #[account(mut, address = config.admin @ OrcaAdaptorError::InvalidReceiver)]
    pub receiver: AccountInfo<'info>,

    /// CHECK: Position account to close.
    #[account(mut)]
    pub position: AccountInfo<'info>,

    /// CHECK: Position NFT mint — burned + closed.
    #[account(mut)]
    pub position_mint: AccountInfo<'info>,

    /// CHECK: ATA holding the single NFT — burned.
    #[account(mut)]
    pub position_token_account: AccountInfo<'info>,

    /// CHECK: Orca Whirlpool program.
    #[account(address = whirlpool_cpi::WHIRLPOOL_PROGRAM_ID)]
    pub whirlpool_program: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
}

// ===========================================================================
// State
// ===========================================================================

#[account]
pub struct OrcaStrategyConfig {
    pub admin: Pubkey,
    pub keeper: Pubkey,
    pub voltr_vault: Pubkey,
    pub asset_mint: Pubkey,
    pub bump: u8,
    pub paused: bool,
    /// Minimum `min_amount_out / amount_in` ratio enforced on `swap`, in bps.
    /// 0 = off (admin accepts keeper's floor as-is). 9000 = "min_amount_out
    /// must be >= 90% of amount_in in base units". Only meaningful for
    /// pegged pairs where in/out are comparable 1:1; set 0 for cross-asset
    /// pools (e.g. SOL/USDC) and rely on the keeper's `min_amount_out`.
    pub min_swap_out_bps: u16,
    pub _reserved: [u8; 60],
}

impl OrcaStrategyConfig {
    pub const LEN: usize = 32 + 32 + 32 + 32 + 1 + 1 + 2 + 60;
}

// ===========================================================================
// Events
// ===========================================================================

#[event]
pub struct SwapEvent {
    pub amount_in: u64,
    pub min_amount_out: u64,
    pub a_to_b: bool,
    pub whirlpool: Pubkey,
}

#[event]
pub struct OpenPositionEvent {
    pub whirlpool: Pubkey,
    pub position: Pubkey,
    pub position_mint: Pubkey,
    pub tick_lower_index: i32,
    pub tick_upper_index: i32,
}

#[event]
pub struct ClosePositionEvent {
    pub position: Pubkey,
}

#[event]
pub struct IncreaseLiquidityEvent {
    pub position: Pubkey,
    pub liquidity_amount: u128,
    pub token_max_a: u64,
    pub token_max_b: u64,
}

#[event]
pub struct DecreaseLiquidityEvent {
    pub position: Pubkey,
    pub liquidity_amount: u128,
    pub token_min_a: u64,
    pub token_min_b: u64,
}

#[event]
pub struct AdminSetEvent {
    pub old: Pubkey,
    pub new: Pubkey,
}

#[event]
pub struct KeeperSetEvent {
    pub old: Pubkey,
    pub new: Pubkey,
}

#[event]
pub struct PausedSetEvent {
    pub paused: bool,
}

#[event]
pub struct SwapParamsSetEvent {
    pub min_swap_out_bps: u16,
}

// ===========================================================================
// Errors
// ===========================================================================

#[error_code]
pub enum OrcaAdaptorError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Signer is not the admin")]
    NotAdmin,
    #[msg("Signer is not the keeper")]
    NotKeeper,
    #[msg("Program is paused")]
    Paused,
    #[msg("tick_lower_index must be < tick_upper_index")]
    InvalidTickRange,
    #[msg("Tick index is not a multiple of the pool's tick_spacing")]
    InvalidTickAlignment,
    #[msg("min_amount_out must be greater than zero (no slippage floor)")]
    NoSlippageFloor,
    #[msg("Provided min_amount_out is below the config's min_swap_out_bps floor")]
    SwapOutBelowFloor,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Invalid slippage parameter (must be <= 10000 bps)")]
    InvalidSlippage,
    #[msg("Whirlpool account data could not be parsed")]
    InvalidWhirlpool,
    #[msg("Whirlpool vault does not match the Whirlpool's stored vault")]
    WhirlpoolVaultMismatch,
    #[msg("Token mint of a passed ATA does not match the Whirlpool's token")]
    TokenMintMismatch,
    #[msg("Strategy ATA is not owned by the config PDA")]
    StrategyAtaOwnerMismatch,
    #[msg("Receiver must be the admin")]
    InvalidReceiver,
    #[msg("Strategy PDA does not match the voltr_vault seed")]
    InvalidStrategyPda,
    #[msg("voltr_vault arg does not match the passed vault account")]
    InvalidVoltrVault,
}
