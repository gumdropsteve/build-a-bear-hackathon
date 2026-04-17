//! lev_musdx_adaptor — Voltr/Ranger adaptor for leveraged mUSDX.
//!
//! Executes a leveraged mUSDX loop via Save Finance, Jupiter, and the mUSDX
//! program. The adaptor holds a Save obligation and borrows USDC against mUSDX
//! collateral in configurable leverage steps.
//!
//! Instruction naming:
//! - `initialize`, `deposit`, `withdraw` are Voltr-facing (CPI'd from Voltr vault)
//! - `deposit_collateral`, `withdraw_collateral` are keeper operations
//! - Admin: `initialize_config`, `set_config`, `set_paused`, `propose_admin`,
//!   `accept_admin`, `cancel_pending_admin`, `set_keeper`

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

mod jupiter_cpi;
mod save_cpi;

declare_id!("5k9CgNiSXSRbLG6PaSSJwkriYkg8i9hdyc8gkDBj3jyv");

pub const CONFIG_SEED: &[u8] = b"strategy_config";

pub const ABSOLUTE_MAX_LEVERAGE_BPS: u16 = 1000; // 10x
pub const ABSOLUTE_MAX_SLIPPAGE_BPS: u16 = 500; // 5%

/// 48-hour timelock for admin rotation (L-1 audit remediation).
pub const ADMIN_TIMELOCK_SECONDS: i64 = 48 * 60 * 60;

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

#[program]
pub mod lev_musdx_adaptor {
    use super::*;

    // -----------------------------------------------------------------------
    // Admin instructions
    // -----------------------------------------------------------------------

    /// Create the strategy config PDA. Called once by the admin.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        args: InitializeConfigArgs,
    ) -> Result<()> {
        require!(
            args.target_leverage_bps > 0 && args.target_leverage_bps <= args.max_leverage_bps,
            LevMusdxError::InvalidLeverage
        );
        require!(
            args.max_leverage_bps <= ABSOLUTE_MAX_LEVERAGE_BPS,
            LevMusdxError::InvalidLeverage
        );
        require!(
            args.max_slippage_bps <= ABSOLUTE_MAX_SLIPPAGE_BPS,
            LevMusdxError::InvalidSlippage
        );
        require!(
            args.loop_iteration_cap > 0 && args.loop_iteration_cap <= 16,
            LevMusdxError::InvalidIterationCap
        );

        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.voltr_vault = args.voltr_vault;
        config.save_obligation = args.save_obligation;
        config.keeper = ctx.accounts.admin.key();
        config.pending_admin = Pubkey::default();
        config.pending_admin_effective_at = 0;
        config.target_leverage_bps = args.target_leverage_bps;
        config.max_leverage_bps = args.max_leverage_bps;
        config.max_slippage_bps = args.max_slippage_bps;
        config.min_swap_price_bps = 9900; // 99% default floor
        config.loop_iteration_cap = args.loop_iteration_cap;
        config.paused = false;
        config.musdx_collateral_amount = 0;
        config.usdc_debt_amount = 0;
        config.current_leverage_bps = 0;
        config.last_refresh_ts = 0;
        config.bump = ctx.bumps.config;

        msg!("Config initialized");
        Ok(())
    }

    /// Update strategy parameters. Admin only.
    pub fn set_config(ctx: Context<SetConfig>, args: SetConfigArgs) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.admin.key(),
            ctx.accounts.config.admin,
            LevMusdxError::NotAdmin
        );

        let config = &mut ctx.accounts.config;

        if let Some(target) = args.target_leverage_bps {
            require!(
                target > 0 && target <= config.max_leverage_bps,
                LevMusdxError::InvalidLeverage
            );
            config.target_leverage_bps = target;
        }
        if let Some(max) = args.max_leverage_bps {
            require!(
                max >= config.target_leverage_bps && max <= ABSOLUTE_MAX_LEVERAGE_BPS,
                LevMusdxError::InvalidLeverage
            );
            config.max_leverage_bps = max;
        }
        if let Some(slip) = args.max_slippage_bps {
            require!(
                slip <= ABSOLUTE_MAX_SLIPPAGE_BPS,
                LevMusdxError::InvalidSlippage
            );
            config.max_slippage_bps = slip;
        }
        if let Some(min_price) = args.min_swap_price_bps {
            require!(min_price <= 10_000, LevMusdxError::InvalidSlippage);
            config.min_swap_price_bps = min_price;
        }
        if let Some(cap) = args.loop_iteration_cap {
            require!(
                cap > 0 && cap <= 16,
                LevMusdxError::InvalidIterationCap
            );
            config.loop_iteration_cap = cap;
        }

        msg!("Config updated");
        Ok(())
    }

    /// Emergency pause / resume. Always callable by admin.
    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.admin.key(),
            ctx.accounts.config.admin,
            LevMusdxError::NotAdmin
        );
        let was_paused = ctx.accounts.config.paused;
        ctx.accounts.config.paused = paused;
        emit!(PauseChangedEvent {
            was_paused,
            is_paused: paused,
        });
        Ok(())
    }

    /// Stage an admin transfer with 48-hour timelock (L-1).
    pub fn propose_admin(ctx: Context<ProposeAdmin>, new_admin: Pubkey) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.admin.key(),
            ctx.accounts.config.admin,
            LevMusdxError::NotAdmin
        );

        let now = Clock::get()?.unix_timestamp;
        let effective_at = now
            .checked_add(ADMIN_TIMELOCK_SECONDS)
            .ok_or(LevMusdxError::MathOverflow)?;

        let config = &mut ctx.accounts.config;
        config.pending_admin = new_admin;
        config.pending_admin_effective_at = effective_at;

        emit!(AdminChangeProposedEvent {
            proposed_admin: new_admin,
            effective_at,
        });
        Ok(())
    }

    /// Accept a pending admin transfer after the 48-hour timelock (L-1).
    /// Must be called by the proposed new admin.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(
            config.pending_admin_effective_at > 0,
            LevMusdxError::NoPendingChange
        );
        require_keys_eq!(
            ctx.accounts.new_admin.key(),
            config.pending_admin,
            LevMusdxError::NotPendingAdmin
        );

        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= config.pending_admin_effective_at,
            LevMusdxError::TimelockNotElapsed
        );

        let old_admin = config.admin;
        config.admin = config.pending_admin;
        config.pending_admin = Pubkey::default();
        config.pending_admin_effective_at = 0;

        emit!(AdminChangedEvent {
            old_admin,
            new_admin: config.admin,
        });
        Ok(())
    }

    /// Cancel a pending admin transfer. Current admin only (L-1).
    pub fn cancel_pending_admin(ctx: Context<CancelPendingAdmin>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.admin.key(),
            ctx.accounts.config.admin,
            LevMusdxError::NotAdmin
        );

        let config = &mut ctx.accounts.config;
        require!(
            config.pending_admin_effective_at > 0,
            LevMusdxError::NoPendingChange
        );

        config.pending_admin = Pubkey::default();
        config.pending_admin_effective_at = 0;

        emit!(AdminChangeCancelledEvent {});
        Ok(())
    }

    /// Admin sets the keeper address (L-2).
    pub fn set_keeper(ctx: Context<SetKeeper>, new_keeper: Pubkey) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.admin.key(),
            ctx.accounts.config.admin,
            LevMusdxError::NotAdmin
        );

        let old_keeper = ctx.accounts.config.keeper;
        ctx.accounts.config.keeper = new_keeper;

        emit!(KeeperChangedEvent {
            old_keeper,
            new_keeper,
        });
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Keeper / strategy operations
    // -----------------------------------------------------------------------

    /// Initialize the Save obligation owned by the config PDA.
    /// Creates the obligation account via CreateAccountWithSeed (Save requires this),
    /// then calls Save's init_obligation CPI.
    pub fn init_save_obligation<'info>(
        ctx: Context<'_, '_, 'info, 'info, InitSaveObligation<'info>>,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.admin.key(),
            ctx.accounts.config.admin,
            LevMusdxError::NotAdmin
        );

        let voltr_vault = ctx.accounts.config.voltr_vault;
        let bump = ctx.accounts.config.bump;
        let signer_seeds: &[&[&[u8]]] =
            &[&[CONFIG_SEED, voltr_vault.as_ref(), &[bump]]];

        // Save requires obligation created with CreateAccountWithSeed.
        // Base = config PDA (obligation owner), seed = lending_market first 32 chars.
        let lending_market_str = ctx.accounts.lending_market.key().to_string();
        let seed = &lending_market_str[..32];

        let obligation_size: u64 = 1300;
        let rent_lamports = Rent::get()?.minimum_balance(obligation_size as usize);

        anchor_lang::solana_program::program::invoke_signed(
            &anchor_lang::solana_program::system_instruction::create_account_with_seed(
                &ctx.accounts.payer.key(),       // funding account
                &ctx.accounts.obligation.key(),  // created account
                &ctx.accounts.config.key(),      // base (signs)
                seed,
                rent_lamports,
                obligation_size,
                &save_cpi::SAVE_PROGRAM_ID,
            ),
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.obligation.to_account_info(),
                ctx.accounts.config.to_account_info(),
            ],
            signer_seeds,
        )?;

        // Now init the obligation via Save CPI (this Save version doesn't use clock)
        save_cpi::init_obligation(
            &ctx.accounts.save_program,
            &ctx.accounts.obligation,
            &ctx.accounts.lending_market,
            &ctx.accounts.config.to_account_info(),
            &ctx.accounts.rent,
            &ctx.accounts.token_program.to_account_info(),
            signer_seeds,
        )?;

        msg!("Save obligation initialized");
        Ok(())
    }

    /// Deposit USDX at 1x — wrap to mUSDX and post as Save collateral.
    pub fn deposit_collateral<'info>(
        ctx: Context<'_, '_, 'info, 'info, DepositCollateral<'info>>,
        usdx_amount: u64,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, LevMusdxError::Paused);
        require!(usdx_amount > 0, LevMusdxError::ZeroAmount);

        let voltr_vault = config.voltr_vault;
        let bump = config.bump;
        let signer_seeds: &[&[&[u8]]] =
            &[&[CONFIG_SEED, voltr_vault.as_ref(), &[bump]]];

        // Snapshot mUSDX balance before wrap
        let musdx_before = ctx.accounts.strategy_musdx_ata.amount;

        // Wrap USDX -> mUSDX via CPI to the mUSDX program
        {
            let cpi_program = ctx.accounts.musdx_program.to_account_info();
            let cpi_accounts = musdx::cpi::accounts::Wrap {
                state: ctx.accounts.musdx_state.to_account_info(),
                usdx_mint: ctx.accounts.usdx_mint.to_account_info(),
                musdx_mint: ctx.accounts.musdx_mint.to_account_info(),
                usdx_vault: ctx.accounts.musdx_usdx_vault.to_account_info(),
                user: ctx.accounts.config.to_account_info(),
                user_usdx_ata: ctx.accounts.strategy_usdx_ata.to_account_info(),
                user_musdx_ata: ctx.accounts.strategy_musdx_ata.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            };
            musdx::cpi::wrap(
                CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds),
                usdx_amount,
            )?;
        }

        // Reload to get the new balance
        ctx.accounts.strategy_musdx_ata.reload()?;
        let musdx_received = ctx
            .accounts
            .strategy_musdx_ata
            .amount
            .checked_sub(musdx_before)
            .ok_or(LevMusdxError::MathOverflow)?;
        require!(musdx_received > 0, LevMusdxError::WrapFailed);

        // Refresh mUSDX reserve
        save_cpi::refresh_reserve(
            &ctx.accounts.save_program,
            &ctx.accounts.musdx_reserve,
            &ctx.accounts.musdx_reserve_pyth_oracle,
            &ctx.accounts.musdx_reserve_switchboard_oracle,
            &ctx.accounts.clock,
            signer_seeds,
        )?;

        // Deposit mUSDX as collateral into Save
        // Save's deployed version: no switchboard oracle, no clock in deposit
        save_cpi::deposit_reserve_liquidity_and_obligation_collateral(
            &ctx.accounts.save_program,
            &ctx.accounts.strategy_musdx_ata.to_account_info(),
            &ctx.accounts.strategy_user_collateral_ata.to_account_info(),
            &ctx.accounts.musdx_reserve,
            &ctx.accounts.musdx_reserve_liquidity_supply,
            &ctx.accounts.musdx_reserve_collateral_mint,
            &ctx.accounts.save_lending_market,
            &ctx.accounts.save_lending_market_authority,
            &ctx.accounts.musdx_reserve_destination_deposit_collateral,
            &ctx.accounts.save_obligation,
            &ctx.accounts.config.to_account_info(),      // obligation_owner
            &ctx.accounts.musdx_reserve_fee_receiver,    // fee_receiver (position 10)
            &ctx.accounts.musdx_reserve_pyth_oracle,     // pyth oracle (position 11)
            &ctx.accounts.config.to_account_info(),      // user_transfer_authority
            &ctx.accounts.token_program.to_account_info(),
            musdx_received,
            signer_seeds,
        )?;

        // Update state
        let config = &mut ctx.accounts.config;
        config.musdx_collateral_amount = config
            .musdx_collateral_amount
            .checked_add(musdx_received)
            .ok_or(LevMusdxError::MathOverflow)?;
        if config.usdc_debt_amount == 0 {
            config.current_leverage_bps = 10_000; // 1x in bps
        }
        config.last_refresh_ts = Clock::get()?.unix_timestamp;

        emit!(DepositCollateralEvent {
            usdx_deposited: usdx_amount,
            musdx_collateral_added: musdx_received,
            total_musdx_collateral: config.musdx_collateral_amount,
        });
        Ok(())
    }

    /// One step of the leverage-up loop: borrow USDC from Save, swap to USDX
    /// via Jupiter, wrap to mUSDX, re-deposit as collateral. Keeper only (L-2).
    pub fn open_leverage_step<'info>(
        ctx: Context<'_, '_, 'info, 'info, OpenLeverageStep<'info>>,
        usdc_borrow_amount: u64,
        jupiter_data: Vec<u8>,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, LevMusdxError::Paused);
        require!(usdc_borrow_amount > 0, LevMusdxError::ZeroAmount);

        // L-2: Validate keeper
        require_keys_eq!(
            ctx.accounts.keeper.key(),
            config.keeper,
            LevMusdxError::NotKeeper
        );

        let voltr_vault = config.voltr_vault;
        let bump = config.bump;
        let min_swap_price_bps = config.min_swap_price_bps;
        let signer_seeds: &[&[&[u8]]] =
            &[&[CONFIG_SEED, voltr_vault.as_ref(), &[bump]]];

        // ---- 1. Refresh USDC reserve ----
        save_cpi::refresh_reserve(
            &ctx.accounts.save_program,
            &ctx.accounts.usdc_reserve,
            &ctx.accounts.usdc_reserve_pyth_oracle,
            &ctx.accounts.usdc_reserve_switchboard_oracle,
            &ctx.accounts.clock,
            signer_seeds,
        )?;

        // Refresh mUSDX reserve
        save_cpi::refresh_reserve(
            &ctx.accounts.save_program,
            &ctx.accounts.musdx_reserve,
            &ctx.accounts.musdx_reserve_pyth_oracle,
            &ctx.accounts.musdx_reserve_switchboard_oracle,
            &ctx.accounts.clock,
            signer_seeds,
        )?;

        // Refresh obligation (with both reserve accounts)
        save_cpi::refresh_obligation(
            &ctx.accounts.save_program,
            &ctx.accounts.save_obligation,
            &ctx.accounts.clock,
            &[
                ctx.accounts.musdx_reserve.to_account_info(),
                ctx.accounts.usdc_reserve.to_account_info(),
            ],
            signer_seeds,
        )?;

        // ---- 2. Borrow USDC ----
        save_cpi::borrow_obligation_liquidity(
            &ctx.accounts.save_program,
            &ctx.accounts.usdc_reserve_liquidity_supply,
            &ctx.accounts.strategy_usdc_ata.to_account_info(),
            &ctx.accounts.usdc_reserve,
            &ctx.accounts.usdc_reserve_fee_receiver,
            &ctx.accounts.save_obligation,
            &ctx.accounts.save_lending_market,
            &ctx.accounts.save_lending_market_authority,
            &ctx.accounts.config.to_account_info(),
            &ctx.accounts.clock,
            &ctx.accounts.token_program.to_account_info(),
            None, // no host fee receiver
            usdc_borrow_amount,
            signer_seeds,
        )?;

        // ---- 3. Swap USDC -> USDX via Jupiter ----
        let usdx_before = ctx.accounts.strategy_usdx_ata.amount;

        // Build route account infos from remaining_accounts
        let route_accounts: Vec<AccountInfo<'info>> = ctx
            .remaining_accounts
            .to_vec();

        jupiter_cpi::invoke_jupiter_swap(
            &ctx.accounts.jupiter_program,
            &route_accounts,
            jupiter_data,
            signer_seeds,
        )?;

        ctx.accounts.strategy_usdx_ata.reload()?;
        let usdx_received = ctx
            .accounts
            .strategy_usdx_ata
            .amount
            .checked_sub(usdx_before)
            .ok_or(LevMusdxError::MathOverflow)?;
        require!(usdx_received > 0, LevMusdxError::SwapFailed);

        // M-1: Enforce minimum swap price floor
        // usdx_received / usdc_borrow_amount >= min_swap_price_bps / 10_000
        // => usdx_received * 10_000 >= usdc_borrow_amount * min_swap_price_bps
        let lhs = (usdx_received as u128)
            .checked_mul(10_000)
            .ok_or(LevMusdxError::MathOverflow)?;
        let rhs = (usdc_borrow_amount as u128)
            .checked_mul(min_swap_price_bps as u128)
            .ok_or(LevMusdxError::MathOverflow)?;
        require!(lhs >= rhs, LevMusdxError::SwapPriceBelowFloor);

        // ---- 4. Wrap USDX -> mUSDX ----
        let musdx_before = ctx.accounts.strategy_musdx_ata.amount;

        {
            let cpi_program = ctx.accounts.musdx_program.to_account_info();
            let cpi_accounts = musdx::cpi::accounts::Wrap {
                state: ctx.accounts.musdx_state.to_account_info(),
                usdx_mint: ctx.accounts.usdx_mint.to_account_info(),
                musdx_mint: ctx.accounts.musdx_mint.to_account_info(),
                usdx_vault: ctx.accounts.musdx_usdx_vault.to_account_info(),
                user: ctx.accounts.config.to_account_info(),
                user_usdx_ata: ctx.accounts.strategy_usdx_ata.to_account_info(),
                user_musdx_ata: ctx.accounts.strategy_musdx_ata.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            };
            musdx::cpi::wrap(
                CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds),
                usdx_received,
            )?;
        }

        ctx.accounts.strategy_musdx_ata.reload()?;
        let musdx_received = ctx
            .accounts
            .strategy_musdx_ata
            .amount
            .checked_sub(musdx_before)
            .ok_or(LevMusdxError::MathOverflow)?;
        require!(musdx_received > 0, LevMusdxError::WrapFailed);

        // ---- 5. Re-deposit mUSDX as collateral ----
        // Refresh mUSDX reserve again before deposit
        save_cpi::refresh_reserve(
            &ctx.accounts.save_program,
            &ctx.accounts.musdx_reserve,
            &ctx.accounts.musdx_reserve_pyth_oracle,
            &ctx.accounts.musdx_reserve_switchboard_oracle,
            &ctx.accounts.clock,
            signer_seeds,
        )?;

        save_cpi::deposit_reserve_liquidity_and_obligation_collateral(
            &ctx.accounts.save_program,
            &ctx.accounts.strategy_musdx_ata.to_account_info(),
            &ctx.accounts.strategy_user_collateral_ata.to_account_info(),
            &ctx.accounts.musdx_reserve,
            &ctx.accounts.musdx_reserve_liquidity_supply,
            &ctx.accounts.musdx_reserve_collateral_mint,
            &ctx.accounts.save_lending_market,
            &ctx.accounts.save_lending_market_authority,
            &ctx.accounts.musdx_reserve_destination_deposit_collateral,
            &ctx.accounts.save_obligation,
            &ctx.accounts.config.to_account_info(),      // obligation_owner
            &ctx.accounts.musdx_reserve_fee_receiver,    // fee_receiver
            &ctx.accounts.musdx_reserve_pyth_oracle,     // pyth oracle
            &ctx.accounts.config.to_account_info(),      // user_transfer_authority
            &ctx.accounts.token_program.to_account_info(),
            musdx_received,
            signer_seeds,
        )?;

        // ---- 6. Update state ----
        let config = &mut ctx.accounts.config;
        config.musdx_collateral_amount = config
            .musdx_collateral_amount
            .checked_add(musdx_received)
            .ok_or(LevMusdxError::MathOverflow)?;
        config.usdc_debt_amount = config
            .usdc_debt_amount
            .checked_add(usdc_borrow_amount)
            .ok_or(LevMusdxError::MathOverflow)?;

        // Recalculate leverage: collateral / (collateral - debt)
        let equity = config
            .musdx_collateral_amount
            .checked_sub(config.usdc_debt_amount)
            .unwrap_or(0);
        if equity > 0 {
            config.current_leverage_bps = ((config.musdx_collateral_amount as u128)
                .checked_mul(10_000)
                .ok_or(LevMusdxError::MathOverflow)?
                .checked_div(equity as u128)
                .ok_or(LevMusdxError::MathOverflow)?) as u16;
        }
        config.last_refresh_ts = Clock::get()?.unix_timestamp;

        emit!(OpenLeverageStepEvent {
            usdc_borrowed: usdc_borrow_amount,
            usdx_received,
            musdx_collateral_added: musdx_received,
            total_musdx_collateral: config.musdx_collateral_amount,
            total_usdc_debt: config.usdc_debt_amount,
            current_leverage_bps: config.current_leverage_bps,
        });
        Ok(())
    }

    /// One step of the deleverage loop: withdraw mUSDX collateral from Save,
    /// unwrap to USDX (instant via cooldown bypass or sell), swap to USDC via
    /// Jupiter, repay USDC debt. Keeper only (L-2).
    pub fn close_leverage_step<'info>(
        ctx: Context<'_, '_, 'info, 'info, CloseLeverageStep<'info>>,
        collateral_withdraw_amount: u64,
        jupiter_data: Vec<u8>,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, LevMusdxError::Paused);
        require!(collateral_withdraw_amount > 0, LevMusdxError::ZeroAmount);

        // L-2: Validate keeper
        require_keys_eq!(
            ctx.accounts.keeper.key(),
            config.keeper,
            LevMusdxError::NotKeeper
        );

        let voltr_vault = config.voltr_vault;
        let bump = config.bump;
        let signer_seeds: &[&[&[u8]]] =
            &[&[CONFIG_SEED, voltr_vault.as_ref(), &[bump]]];

        // ---- 1. Refresh reserves and obligation ----
        save_cpi::refresh_reserve(
            &ctx.accounts.save_program,
            &ctx.accounts.musdx_reserve,
            &ctx.accounts.musdx_reserve_pyth_oracle,
            &ctx.accounts.musdx_reserve_switchboard_oracle,
            &ctx.accounts.clock,
            signer_seeds,
        )?;

        save_cpi::refresh_reserve(
            &ctx.accounts.save_program,
            &ctx.accounts.usdc_reserve,
            &ctx.accounts.usdc_reserve_pyth_oracle,
            &ctx.accounts.usdc_reserve_switchboard_oracle,
            &ctx.accounts.clock,
            signer_seeds,
        )?;

        save_cpi::refresh_obligation(
            &ctx.accounts.save_program,
            &ctx.accounts.save_obligation,
            &ctx.accounts.clock,
            &[
                ctx.accounts.musdx_reserve.to_account_info(),
                ctx.accounts.usdc_reserve.to_account_info(),
            ],
            signer_seeds,
        )?;

        // ---- 2. Withdraw mUSDX collateral from Save ----
        save_cpi::withdraw_obligation_collateral_and_redeem_reserve_collateral(
            &ctx.accounts.save_program,
            &ctx.accounts.musdx_reserve_destination_deposit_collateral,
            &ctx.accounts.strategy_user_collateral_ata.to_account_info(),
            &ctx.accounts.musdx_reserve,
            &ctx.accounts.save_obligation,
            &ctx.accounts.save_lending_market,
            &ctx.accounts.save_lending_market_authority,
            &ctx.accounts.strategy_musdx_ata.to_account_info(),
            &ctx.accounts.musdx_reserve_collateral_mint,
            &ctx.accounts.musdx_reserve_liquidity_supply,
            &ctx.accounts.config.to_account_info(),
            &ctx.accounts.config.to_account_info(),
            &ctx.accounts.clock,
            &ctx.accounts.token_program.to_account_info(),
            collateral_withdraw_amount,
            signer_seeds,
        )?;

        // ---- 3. Swap mUSDX/USDX -> USDC via Jupiter ----
        // The keeper determines the best route; we just forward the swap
        let usdc_before = ctx.accounts.strategy_usdc_ata.amount;

        let route_accounts: Vec<AccountInfo<'info>> = ctx
            .remaining_accounts
            .to_vec();

        jupiter_cpi::invoke_jupiter_swap(
            &ctx.accounts.jupiter_program,
            &route_accounts,
            jupiter_data,
            signer_seeds,
        )?;

        ctx.accounts.strategy_usdc_ata.reload()?;
        let usdc_received = ctx
            .accounts
            .strategy_usdc_ata
            .amount
            .checked_sub(usdc_before)
            .ok_or(LevMusdxError::MathOverflow)?;
        require!(usdc_received > 0, LevMusdxError::SwapFailed);

        // ---- 4. Repay USDC to Save ----
        // Refresh USDC reserve before repay
        save_cpi::refresh_reserve(
            &ctx.accounts.save_program,
            &ctx.accounts.usdc_reserve,
            &ctx.accounts.usdc_reserve_pyth_oracle,
            &ctx.accounts.usdc_reserve_switchboard_oracle,
            &ctx.accounts.clock,
            signer_seeds,
        )?;

        let repay_amount = std::cmp::min(usdc_received, ctx.accounts.config.usdc_debt_amount);

        save_cpi::repay_obligation_liquidity(
            &ctx.accounts.save_program,
            &ctx.accounts.strategy_usdc_ata.to_account_info(),
            &ctx.accounts.usdc_reserve_liquidity_supply,
            &ctx.accounts.usdc_reserve,
            &ctx.accounts.save_obligation,
            &ctx.accounts.save_lending_market,
            &ctx.accounts.config.to_account_info(),
            &ctx.accounts.clock,
            &ctx.accounts.token_program.to_account_info(),
            repay_amount,
            signer_seeds,
        )?;

        // ---- 5. Update state ----
        let config = &mut ctx.accounts.config;
        config.musdx_collateral_amount = config
            .musdx_collateral_amount
            .saturating_sub(collateral_withdraw_amount);
        config.usdc_debt_amount = config
            .usdc_debt_amount
            .saturating_sub(repay_amount);

        // Recalculate leverage
        let equity = config
            .musdx_collateral_amount
            .checked_sub(config.usdc_debt_amount)
            .unwrap_or(0);
        if equity > 0 {
            config.current_leverage_bps = ((config.musdx_collateral_amount as u128)
                .checked_mul(10_000)
                .ok_or(LevMusdxError::MathOverflow)?
                .checked_div(equity as u128)
                .ok_or(LevMusdxError::MathOverflow)?) as u16;
        } else if config.musdx_collateral_amount == 0 {
            config.current_leverage_bps = 0;
        }
        config.last_refresh_ts = Clock::get()?.unix_timestamp;

        emit!(CloseLeverageStepEvent {
            collateral_withdrawn: collateral_withdraw_amount,
            usdc_repaid: repay_amount,
            total_musdx_collateral: config.musdx_collateral_amount,
            total_usdc_debt: config.usdc_debt_amount,
            current_leverage_bps: config.current_leverage_bps,
        });
        Ok(())
    }

    /// Withdraw idle USDX from the strategy back to Voltr vault ATA.
    pub fn withdraw_collateral<'info>(
        ctx: Context<'_, '_, 'info, 'info, WithdrawCollateral<'info>>,
        usdx_amount: u64,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, LevMusdxError::Paused);
        require!(usdx_amount > 0, LevMusdxError::ZeroAmount);
        require_keys_eq!(
            ctx.accounts.admin.key(),
            config.admin,
            LevMusdxError::NotAdmin
        );

        let voltr_vault = config.voltr_vault;
        let bump = config.bump;
        let signer_seeds: &[&[&[u8]]] =
            &[&[CONFIG_SEED, voltr_vault.as_ref(), &[bump]]];

        // Transfer USDX from strategy ATA back to vault ATA
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.strategy_usdx_ata.to_account_info(),
                    to: ctx.accounts.vault_usdx_ata.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer_seeds,
            ),
            usdx_amount,
        )?;

        let config = &mut ctx.accounts.config;
        config.last_refresh_ts = Clock::get()?.unix_timestamp;

        emit!(WithdrawCollateralEvent {
            usdx_withdrawn: usdx_amount,
        });
        Ok(())
    }

    /// Refresh the on-chain position accounting. Permissionless.
    pub fn refresh_position<'info>(
        ctx: Context<'_, '_, 'info, 'info, RefreshPosition<'info>>,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        let voltr_vault = config.voltr_vault;
        let bump = config.bump;
        let signer_seeds: &[&[&[u8]]] =
            &[&[CONFIG_SEED, voltr_vault.as_ref(), &[bump]]];

        // Refresh reserves
        save_cpi::refresh_reserve(
            &ctx.accounts.save_program,
            &ctx.accounts.musdx_reserve,
            &ctx.accounts.musdx_reserve_pyth_oracle,
            &ctx.accounts.musdx_reserve_switchboard_oracle,
            &ctx.accounts.clock,
            signer_seeds,
        )?;

        save_cpi::refresh_reserve(
            &ctx.accounts.save_program,
            &ctx.accounts.usdc_reserve,
            &ctx.accounts.usdc_reserve_pyth_oracle,
            &ctx.accounts.usdc_reserve_switchboard_oracle,
            &ctx.accounts.clock,
            signer_seeds,
        )?;

        // Refresh obligation
        save_cpi::refresh_obligation(
            &ctx.accounts.save_program,
            &ctx.accounts.save_obligation,
            &ctx.accounts.clock,
            &[
                ctx.accounts.musdx_reserve.to_account_info(),
                ctx.accounts.usdc_reserve.to_account_info(),
            ],
            signer_seeds,
        )?;

        let config = &mut ctx.accounts.config;
        config.last_refresh_ts = Clock::get()?.unix_timestamp;

        // Recalculate leverage
        let equity = config
            .musdx_collateral_amount
            .checked_sub(config.usdc_debt_amount)
            .unwrap_or(0);
        if equity > 0 {
            config.current_leverage_bps = ((config.musdx_collateral_amount as u128)
                .checked_mul(10_000)
                .ok_or(LevMusdxError::MathOverflow)?
                .checked_div(equity as u128)
                .ok_or(LevMusdxError::MathOverflow)?) as u16;
        } else if config.musdx_collateral_amount == 0 {
            config.current_leverage_bps = 0;
        }

        emit!(RefreshPositionEvent {
            musdx_collateral: config.musdx_collateral_amount,
            usdc_debt: config.usdc_debt_amount,
            current_leverage_bps: config.current_leverage_bps,
            timestamp: config.last_refresh_ts,
        });
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Voltr-facing instructions
    // -----------------------------------------------------------------------

    /// Called by Voltr's initialize_strategy CPI.
    /// The config PDA must already exist (created via `initialize_config`).
    /// This instruction just validates the strategy account is our config PDA
    /// and returns successfully so Voltr can create the strategy receipt.
    pub fn initialize(ctx: Context<VoltrInitialize>, _voltr_vault: Pubkey) -> Result<()> {
        msg!("Strategy validated via Voltr");
        Ok(())
    }

    /// Called by Voltr's deposit_strategy CPI. Moves USDX from vault's strategy
    /// ATA (owned by vaultStrategyAuth) to config PDA's USDX ATA (remaining_accounts[0]),
    /// then returns position value.
    pub fn deposit<'info>(
        ctx: Context<'_, '_, 'info, 'info, VoltrDeposit<'info>>,
    ) -> Result<()> {
        let config = &ctx.accounts.strategy;
        require!(!config.paused, LevMusdxError::Paused);

        // Transfer USDX from vaultStrategyAuth ATA to config PDA's USDX ATA
        let idle = ctx.accounts.vault_strategy_asset_ata.amount;
        if idle > 0 && !ctx.remaining_accounts.is_empty() {
            let config_usdx_ata = &ctx.remaining_accounts[0];
            token::transfer(
                CpiContext::new(
                    ctx.accounts.asset_token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault_strategy_asset_ata.to_account_info(),
                        to: config_usdx_ata.to_account_info(),
                        authority: ctx.accounts.vault_strategy_auth.to_account_info(),
                    },
                ),
                idle,
            )?;
            msg!("Transferred {} USDX to config PDA ATA", idle);
        }

        let position_value = idle
            .checked_add(config.musdx_collateral_amount)
            .ok_or(LevMusdxError::MathOverflow)?
            .checked_sub(config.usdc_debt_amount)
            .ok_or(LevMusdxError::MathOverflow)?;

        msg!("Deposit acknowledged, position value: {}", position_value);
        anchor_lang::solana_program::program::set_return_data(
            &position_value.to_le_bytes(),
        );
        Ok(())
    }

    /// Called by Voltr's withdraw_strategy CPI. Returns position value.
    pub fn withdraw(ctx: Context<VoltrWithdraw>) -> Result<()> {
        let config = &ctx.accounts.strategy;

        let idle = ctx.accounts.vault_strategy_asset_ata.amount;
        let position_value = idle
            .checked_add(config.musdx_collateral_amount)
            .ok_or(LevMusdxError::MathOverflow)?
            .checked_sub(config.usdc_debt_amount)
            .ok_or(LevMusdxError::MathOverflow)?;

        msg!("Withdraw, position value: {}", position_value);
        anchor_lang::solana_program::program::set_return_data(
            &position_value.to_le_bytes(),
        );
        Ok(())
    }
}

// ===========================================================================
// Account contexts
// ===========================================================================

#[derive(Accounts)]
#[instruction(args: InitializeConfigArgs)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + LevStrategyConfig::LEN,
        seeds = [CONFIG_SEED, args.voltr_vault.as_ref()],
        bump,
    )]
    pub config: Account<'info, LevStrategyConfig>,

    pub admin: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetConfig<'info> {
    #[account(mut, seeds = [CONFIG_SEED, config.voltr_vault.as_ref()], bump = config.bump)]
    pub config: Account<'info, LevStrategyConfig>,

    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(mut, seeds = [CONFIG_SEED, config.voltr_vault.as_ref()], bump = config.bump)]
    pub config: Account<'info, LevStrategyConfig>,

    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct ProposeAdmin<'info> {
    #[account(mut, seeds = [CONFIG_SEED, config.voltr_vault.as_ref()], bump = config.bump)]
    pub config: Account<'info, LevStrategyConfig>,

    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    #[account(mut, seeds = [CONFIG_SEED, config.voltr_vault.as_ref()], bump = config.bump)]
    pub config: Account<'info, LevStrategyConfig>,

    pub new_admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelPendingAdmin<'info> {
    #[account(mut, seeds = [CONFIG_SEED, config.voltr_vault.as_ref()], bump = config.bump)]
    pub config: Account<'info, LevStrategyConfig>,

    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetKeeper<'info> {
    #[account(mut, seeds = [CONFIG_SEED, config.voltr_vault.as_ref()], bump = config.bump)]
    pub config: Account<'info, LevStrategyConfig>,

    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitSaveObligation<'info> {
    #[account(mut, seeds = [CONFIG_SEED, config.voltr_vault.as_ref()], bump = config.bump)]
    pub config: Account<'info, LevStrategyConfig>,

    pub admin: Signer<'info>,

    /// Payer for obligation account rent.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Save program, validated by address.
    #[account(address = save_cpi::SAVE_PROGRAM_ID)]
    pub save_program: AccountInfo<'info>,

    /// CHECK: Obligation account, created via CreateAccountWithSeed.
    #[account(mut)]
    pub obligation: AccountInfo<'info>,

    /// CHECK: Save lending market.
    pub lending_market: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,

    /// CHECK: Rent sysvar.
    pub rent: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct DepositCollateral<'info> {
    #[account(mut, seeds = [CONFIG_SEED, config.voltr_vault.as_ref()], bump = config.bump)]
    pub config: Account<'info, LevStrategyConfig>,

    pub depositor: Signer<'info>,

    /// Strategy's USDX token account.
    #[account(mut)]
    pub strategy_usdx_ata: Account<'info, TokenAccount>,

    /// Strategy's mUSDX token account.
    #[account(mut)]
    pub strategy_musdx_ata: Account<'info, TokenAccount>,

    /// Strategy's Save collateral token account.
    #[account(mut)]
    pub strategy_user_collateral_ata: Account<'info, TokenAccount>,

    /// USDX mint.
    pub usdx_mint: Account<'info, Mint>,

    /// CHECK: mUSDX program for wrap CPI.
    pub musdx_program: AccountInfo<'info>,

    /// CHECK: mUSDX state account.
    #[account(mut)]
    pub musdx_state: AccountInfo<'info>,

    /// mUSDX mint (mutated during wrap).
    #[account(mut)]
    pub musdx_mint: Account<'info, Mint>,

    /// mUSDX vault for USDX deposits.
    #[account(mut)]
    pub musdx_usdx_vault: Account<'info, TokenAccount>,

    /// CHECK: Save program.
    #[account(address = save_cpi::SAVE_PROGRAM_ID)]
    pub save_program: AccountInfo<'info>,

    /// CHECK: Save obligation account.
    #[account(mut)]
    pub save_obligation: AccountInfo<'info>,

    /// CHECK: Save lending market.
    pub save_lending_market: AccountInfo<'info>,

    /// CHECK: Save lending market authority.
    pub save_lending_market_authority: AccountInfo<'info>,

    /// CHECK: mUSDX reserve account in Save.
    #[account(mut)]
    pub musdx_reserve: AccountInfo<'info>,

    /// CHECK: mUSDX reserve liquidity supply.
    #[account(mut)]
    pub musdx_reserve_liquidity_supply: AccountInfo<'info>,

    /// CHECK: mUSDX reserve collateral mint.
    #[account(mut)]
    pub musdx_reserve_collateral_mint: AccountInfo<'info>,

    /// CHECK: mUSDX reserve destination deposit collateral.
    #[account(mut)]
    pub musdx_reserve_destination_deposit_collateral: AccountInfo<'info>,

    /// CHECK: mUSDX reserve fee receiver.
    #[account(mut)]
    pub musdx_reserve_fee_receiver: AccountInfo<'info>,

    /// CHECK: Pyth oracle for mUSDX reserve.
    pub musdx_reserve_pyth_oracle: AccountInfo<'info>,

    /// CHECK: Switchboard oracle for mUSDX reserve (used in refresh_reserve).
    pub musdx_reserve_switchboard_oracle: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,

    /// CHECK: Clock sysvar (used in refresh_reserve).
    pub clock: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct OpenLeverageStep<'info> {
    #[account(mut, seeds = [CONFIG_SEED, config.voltr_vault.as_ref()], bump = config.bump)]
    pub config: Account<'info, LevStrategyConfig>,

    /// Keeper signer (L-2).
    pub keeper: Signer<'info>,

    /// Strategy's USDX token account.
    #[account(mut)]
    pub strategy_usdx_ata: Account<'info, TokenAccount>,

    /// Strategy's mUSDX token account.
    #[account(mut)]
    pub strategy_musdx_ata: Account<'info, TokenAccount>,

    /// Strategy's USDC token account.
    #[account(mut)]
    pub strategy_usdc_ata: Account<'info, TokenAccount>,

    /// Strategy's Save collateral token account.
    #[account(mut)]
    pub strategy_user_collateral_ata: Account<'info, TokenAccount>,

    /// USDX mint.
    pub usdx_mint: Account<'info, Mint>,

    /// CHECK: mUSDX program.
    pub musdx_program: AccountInfo<'info>,

    /// CHECK: mUSDX state.
    #[account(mut)]
    pub musdx_state: AccountInfo<'info>,

    /// mUSDX mint.
    #[account(mut)]
    pub musdx_mint: Account<'info, Mint>,

    /// mUSDX vault for USDX deposits.
    #[account(mut)]
    pub musdx_usdx_vault: Account<'info, TokenAccount>,

    /// CHECK: Save program.
    #[account(address = save_cpi::SAVE_PROGRAM_ID)]
    pub save_program: AccountInfo<'info>,

    /// CHECK: Save obligation.
    #[account(mut)]
    pub save_obligation: AccountInfo<'info>,

    /// CHECK: Save lending market.
    pub save_lending_market: AccountInfo<'info>,

    /// CHECK: Save lending market authority.
    pub save_lending_market_authority: AccountInfo<'info>,

    /// CHECK: mUSDX reserve.
    #[account(mut)]
    pub musdx_reserve: AccountInfo<'info>,

    /// CHECK: mUSDX reserve liquidity supply.
    #[account(mut)]
    pub musdx_reserve_liquidity_supply: AccountInfo<'info>,

    /// CHECK: mUSDX reserve collateral mint.
    #[account(mut)]
    pub musdx_reserve_collateral_mint: AccountInfo<'info>,

    /// CHECK: mUSDX reserve destination deposit collateral.
    #[account(mut)]
    pub musdx_reserve_destination_deposit_collateral: AccountInfo<'info>,

    /// CHECK: mUSDX reserve fee receiver.
    #[account(mut)]
    pub musdx_reserve_fee_receiver: AccountInfo<'info>,

    /// CHECK: Pyth oracle for mUSDX reserve.
    pub musdx_reserve_pyth_oracle: AccountInfo<'info>,

    /// CHECK: Switchboard oracle for mUSDX reserve.
    pub musdx_reserve_switchboard_oracle: AccountInfo<'info>,

    /// CHECK: USDC reserve.
    #[account(mut)]
    pub usdc_reserve: AccountInfo<'info>,

    /// CHECK: USDC reserve liquidity supply.
    #[account(mut)]
    pub usdc_reserve_liquidity_supply: AccountInfo<'info>,

    /// CHECK: USDC reserve fee receiver.
    #[account(mut)]
    pub usdc_reserve_fee_receiver: AccountInfo<'info>,

    /// CHECK: Pyth oracle for USDC reserve.
    pub usdc_reserve_pyth_oracle: AccountInfo<'info>,

    /// CHECK: Switchboard oracle for USDC reserve.
    pub usdc_reserve_switchboard_oracle: AccountInfo<'info>,

    /// CHECK: Jupiter V6 program.
    #[account(address = jupiter_cpi::JUPITER_V6_PROGRAM_ID)]
    pub jupiter_program: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,

    /// CHECK: Clock sysvar.
    pub clock: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct CloseLeverageStep<'info> {
    #[account(mut, seeds = [CONFIG_SEED, config.voltr_vault.as_ref()], bump = config.bump)]
    pub config: Account<'info, LevStrategyConfig>,

    /// Keeper signer (L-2).
    pub keeper: Signer<'info>,

    /// Strategy's USDX token account.
    #[account(mut)]
    pub strategy_usdx_ata: Account<'info, TokenAccount>,

    /// Strategy's mUSDX token account.
    #[account(mut)]
    pub strategy_musdx_ata: Account<'info, TokenAccount>,

    /// Strategy's USDC token account.
    #[account(mut)]
    pub strategy_usdc_ata: Account<'info, TokenAccount>,

    /// Strategy's Save collateral token account.
    #[account(mut)]
    pub strategy_user_collateral_ata: Account<'info, TokenAccount>,

    /// CHECK: Save program.
    #[account(address = save_cpi::SAVE_PROGRAM_ID)]
    pub save_program: AccountInfo<'info>,

    /// CHECK: Save obligation.
    #[account(mut)]
    pub save_obligation: AccountInfo<'info>,

    /// CHECK: Save lending market.
    pub save_lending_market: AccountInfo<'info>,

    /// CHECK: Save lending market authority.
    pub save_lending_market_authority: AccountInfo<'info>,

    /// CHECK: mUSDX reserve.
    #[account(mut)]
    pub musdx_reserve: AccountInfo<'info>,

    /// CHECK: mUSDX reserve liquidity supply.
    #[account(mut)]
    pub musdx_reserve_liquidity_supply: AccountInfo<'info>,

    /// CHECK: mUSDX reserve collateral mint.
    #[account(mut)]
    pub musdx_reserve_collateral_mint: AccountInfo<'info>,

    /// CHECK: mUSDX reserve destination deposit collateral.
    #[account(mut)]
    pub musdx_reserve_destination_deposit_collateral: AccountInfo<'info>,

    /// CHECK: Pyth oracle for mUSDX reserve.
    pub musdx_reserve_pyth_oracle: AccountInfo<'info>,

    /// CHECK: Switchboard oracle for mUSDX reserve.
    pub musdx_reserve_switchboard_oracle: AccountInfo<'info>,

    /// CHECK: USDC reserve.
    #[account(mut)]
    pub usdc_reserve: AccountInfo<'info>,

    /// CHECK: USDC reserve liquidity supply.
    #[account(mut)]
    pub usdc_reserve_liquidity_supply: AccountInfo<'info>,

    /// CHECK: Pyth oracle for USDC reserve.
    pub usdc_reserve_pyth_oracle: AccountInfo<'info>,

    /// CHECK: Switchboard oracle for USDC reserve.
    pub usdc_reserve_switchboard_oracle: AccountInfo<'info>,

    /// CHECK: Jupiter V6 program.
    #[account(address = jupiter_cpi::JUPITER_V6_PROGRAM_ID)]
    pub jupiter_program: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,

    /// CHECK: Clock sysvar.
    pub clock: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct WithdrawCollateral<'info> {
    #[account(mut, seeds = [CONFIG_SEED, config.voltr_vault.as_ref()], bump = config.bump)]
    pub config: Account<'info, LevStrategyConfig>,

    pub admin: Signer<'info>,

    /// Strategy's USDX token account.
    #[account(mut)]
    pub strategy_usdx_ata: Account<'info, TokenAccount>,

    /// Vault's USDX token account (destination).
    #[account(mut)]
    pub vault_usdx_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RefreshPosition<'info> {
    #[account(mut, seeds = [CONFIG_SEED, config.voltr_vault.as_ref()], bump = config.bump)]
    pub config: Account<'info, LevStrategyConfig>,

    /// CHECK: Save program.
    #[account(address = save_cpi::SAVE_PROGRAM_ID)]
    pub save_program: AccountInfo<'info>,

    /// CHECK: Save obligation.
    #[account(mut)]
    pub save_obligation: AccountInfo<'info>,

    /// CHECK: mUSDX reserve.
    #[account(mut)]
    pub musdx_reserve: AccountInfo<'info>,

    /// CHECK: Pyth oracle for mUSDX reserve.
    pub musdx_reserve_pyth_oracle: AccountInfo<'info>,

    /// CHECK: Switchboard oracle for mUSDX reserve.
    pub musdx_reserve_switchboard_oracle: AccountInfo<'info>,

    /// CHECK: USDC reserve.
    #[account(mut)]
    pub usdc_reserve: AccountInfo<'info>,

    /// CHECK: Pyth oracle for USDC reserve.
    pub usdc_reserve_pyth_oracle: AccountInfo<'info>,

    /// CHECK: Switchboard oracle for USDC reserve.
    pub usdc_reserve_switchboard_oracle: AccountInfo<'info>,

    /// CHECK: Clock sysvar.
    pub clock: AccountInfo<'info>,
}

// ---------------------------------------------------------------------------
// Voltr-facing account contexts
// ---------------------------------------------------------------------------

/// Voltr passes accounts in this order: payer, vault_strategy_auth, strategy, system_program.
/// Voltr creates the strategy account via system_program before CPI-ing into us.
#[derive(Accounts)]
pub struct VoltrInitialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Voltr vault strategy authority (signer from Voltr CPI).
    pub vault_strategy_auth: Signer<'info>,

    /// CHECK: Strategy account = our config PDA (already created via initialize_config).
    pub strategy: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VoltrDeposit<'info> {
    /// Voltr vault strategy authority (signer from Voltr CPI).
    pub vault_strategy_auth: Signer<'info>,

    #[account(seeds = [CONFIG_SEED, strategy.voltr_vault.as_ref()], bump = strategy.bump)]
    pub strategy: Account<'info, LevStrategyConfig>,

    /// Vault asset mint.
    pub vault_asset_mint: Account<'info, Mint>,

    /// Vault strategy asset ATA (holds idle funds deposited by Voltr).
    #[account(mut)]
    pub vault_strategy_asset_ata: Account<'info, TokenAccount>,

    pub asset_token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct VoltrWithdraw<'info> {
    /// Voltr vault strategy authority (signer from Voltr CPI).
    pub vault_strategy_auth: Signer<'info>,

    #[account(seeds = [CONFIG_SEED, strategy.voltr_vault.as_ref()], bump = strategy.bump)]
    pub strategy: Account<'info, LevStrategyConfig>,

    /// Vault asset mint.
    pub vault_asset_mint: Account<'info, Mint>,

    /// Vault strategy asset ATA (holds idle funds).
    #[account(mut)]
    pub vault_strategy_asset_ata: Account<'info, TokenAccount>,

    pub asset_token_program: Program<'info, Token>,
}

// ===========================================================================
// State
// ===========================================================================

#[account]
pub struct LevStrategyConfig {
    /// Admin pubkey. Can set config, pause, propose admin transfer.
    pub admin: Pubkey,                     // 32
    /// The Voltr vault this strategy belongs to.
    pub voltr_vault: Pubkey,               // 32
    /// Save obligation account owned by the config PDA.
    pub save_obligation: Pubkey,           // 32
    /// Keeper address authorized for leverage operations (L-2).
    pub keeper: Pubkey,                    // 32
    /// Pending admin for timelocked rotation (L-1).
    pub pending_admin: Pubkey,             // 32
    /// Timestamp when pending_admin becomes effective (L-1).
    pub pending_admin_effective_at: i64,   // 8
    /// Target leverage in basis points (e.g. 400 = 4x).
    pub target_leverage_bps: u16,          // 2
    /// Maximum allowed leverage in basis points.
    pub max_leverage_bps: u16,             // 2
    /// Maximum slippage tolerance in basis points.
    pub max_slippage_bps: u16,             // 2
    /// Minimum acceptable swap price in bps (M-1). 9900 = 99%.
    pub min_swap_price_bps: u16,           // 2
    /// Max number of leverage loop iterations per call.
    pub loop_iteration_cap: u8,            // 1
    /// Emergency pause flag.
    pub paused: bool,                      // 1
    /// Tracked mUSDX collateral in the Save obligation.
    pub musdx_collateral_amount: u64,      // 8
    /// Tracked USDC debt in the Save obligation.
    pub usdc_debt_amount: u64,             // 8
    /// Current effective leverage in basis points.
    pub current_leverage_bps: u16,         // 2
    /// Last time position was refreshed.
    pub last_refresh_ts: i64,              // 8
    /// PDA bump seed.
    pub bump: u8,                          // 1
}

impl LevStrategyConfig {
    /// 32*5 + 8 + 2*4 + 1 + 1 + 8 + 8 + 2 + 8 + 1 = 205
    pub const LEN: usize = 205;
}

// ===========================================================================
// Instruction args
// ===========================================================================

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct InitializeConfigArgs {
    pub voltr_vault: Pubkey,
    pub save_obligation: Pubkey,
    pub target_leverage_bps: u16,
    pub max_leverage_bps: u16,
    pub max_slippage_bps: u16,
    pub loop_iteration_cap: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SetConfigArgs {
    pub target_leverage_bps: Option<u16>,
    pub max_leverage_bps: Option<u16>,
    pub max_slippage_bps: Option<u16>,
    /// M-1: Minimum swap price floor in bps.
    pub min_swap_price_bps: Option<u16>,
    pub loop_iteration_cap: Option<u8>,
}

// ===========================================================================
// Events
// ===========================================================================

#[event]
pub struct PauseChangedEvent {
    pub was_paused: bool,
    pub is_paused: bool,
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

#[event]
pub struct KeeperChangedEvent {
    pub old_keeper: Pubkey,
    pub new_keeper: Pubkey,
}

#[event]
pub struct DepositCollateralEvent {
    pub usdx_deposited: u64,
    pub musdx_collateral_added: u64,
    pub total_musdx_collateral: u64,
}

#[event]
pub struct OpenLeverageStepEvent {
    pub usdc_borrowed: u64,
    pub usdx_received: u64,
    pub musdx_collateral_added: u64,
    pub total_musdx_collateral: u64,
    pub total_usdc_debt: u64,
    pub current_leverage_bps: u16,
}

#[event]
pub struct CloseLeverageStepEvent {
    pub collateral_withdrawn: u64,
    pub usdc_repaid: u64,
    pub total_musdx_collateral: u64,
    pub total_usdc_debt: u64,
    pub current_leverage_bps: u16,
}

#[event]
pub struct WithdrawCollateralEvent {
    pub usdx_withdrawn: u64,
}

#[event]
pub struct RefreshPositionEvent {
    pub musdx_collateral: u64,
    pub usdc_debt: u64,
    pub current_leverage_bps: u16,
    pub timestamp: i64,
}

// ===========================================================================
// Errors
// ===========================================================================

#[error_code]
pub enum LevMusdxError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Signer is not the admin")]
    NotAdmin,
    #[msg("Signer is not the keeper")]
    NotKeeper,
    #[msg("Program is paused")]
    Paused,
    #[msg("Invalid leverage parameter")]
    InvalidLeverage,
    #[msg("Invalid slippage parameter")]
    InvalidSlippage,
    #[msg("Invalid iteration cap")]
    InvalidIterationCap,
    #[msg("Wrap returned zero mUSDX")]
    WrapFailed,
    #[msg("Swap returned zero output")]
    SwapFailed,
    #[msg("Swap price below minimum floor")]
    SwapPriceBelowFloor,
    #[msg("No pending admin or config change")]
    NoPendingChange,
    #[msg("Signer is not the pending new admin")]
    NotPendingAdmin,
    #[msg("Timelock has not elapsed")]
    TimelockNotElapsed,
}
