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

declare_id!("7yiMutzu66FexVadQSzfDunWiUiPGqC5XLATZiQDyWY5");

pub const CONFIG_SEED: &[u8] = b"orca_strategy_config";

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
        Ok(())
    }

    /// Rotate the keeper (admin only).
    pub fn set_keeper(ctx: Context<AdminOnly>, new_keeper: Pubkey) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.admin.key(),
            ctx.accounts.config.admin,
            OrcaAdaptorError::NotAdmin
        );
        ctx.accounts.config.keeper = new_keeper;
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
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Voltr CPI handlers
    // -----------------------------------------------------------------------

    /// Called by Voltr's `initialize_strategy` CPI.
    pub fn initialize(_ctx: Context<VoltrInitialize>, _voltr_vault: Pubkey) -> Result<()> {
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
        require_keys_eq!(
            ctx.accounts.keeper.key(),
            config.keeper,
            OrcaAdaptorError::NotKeeper
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

    /// Strategy's token-A ATA (owner = config PDA).
    #[account(mut)]
    pub strategy_token_a_ata: Box<Account<'info, TokenAccount>>,

    /// Strategy's token-B ATA (owner = config PDA).
    #[account(mut)]
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
    pub _reserved: [u8; 62],
}

impl OrcaStrategyConfig {
    pub const LEN: usize = 32 + 32 + 32 + 32 + 1 + 1 + 62;
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
}
