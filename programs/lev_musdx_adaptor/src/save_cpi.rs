//! Save (Solend) CPI helpers.
//!
//! Save is a SPL-style program, not Anchor, so we hand-construct its instructions
//! and invoke them with `invoke_signed`. Tag numbers and account orderings are
//! taken from Solend's public source:
//! https://github.com/solendprotocol/solana-program-library/blob/master/token-lending/program/src/instruction.rs

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    pubkey,
};

pub const SAVE_PROGRAM_ID: Pubkey = pubkey!("So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo");

pub const TAG_INIT_OBLIGATION: u8 = 6;
pub const TAG_REFRESH_RESERVE: u8 = 3;
pub const TAG_REFRESH_OBLIGATION: u8 = 7;
pub const TAG_BORROW_OBLIGATION_LIQUIDITY: u8 = 10;
pub const TAG_REPAY_OBLIGATION_LIQUIDITY: u8 = 11;
pub const TAG_DEPOSIT_RESERVE_LIQUIDITY_AND_OBLIGATION_COLLATERAL: u8 = 14;
pub const TAG_WITHDRAW_OBLIGATION_COLLATERAL_AND_REDEEM_RESERVE_COLLATERAL: u8 = 15;

#[allow(clippy::too_many_arguments)]
pub fn refresh_reserve<'info>(
    save_program: &AccountInfo<'info>,
    reserve: &AccountInfo<'info>,
    reserve_liquidity_pyth_oracle: &AccountInfo<'info>,
    reserve_liquidity_switchboard_oracle: &AccountInfo<'info>,
    clock: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let ix = Instruction {
        program_id: SAVE_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*reserve.key, false),
            AccountMeta::new_readonly(*reserve_liquidity_pyth_oracle.key, false),
            AccountMeta::new_readonly(*reserve_liquidity_switchboard_oracle.key, false),
            AccountMeta::new_readonly(*clock.key, false),
        ],
        data: vec![TAG_REFRESH_RESERVE],
    };
    invoke_signed(&ix, &[save_program.clone(), reserve.clone(), reserve_liquidity_pyth_oracle.clone(), reserve_liquidity_switchboard_oracle.clone(), clock.clone()], signer_seeds).map_err(Into::into)
}

pub fn refresh_obligation<'info>(
    save_program: &AccountInfo<'info>,
    obligation: &AccountInfo<'info>,
    clock: &AccountInfo<'info>,
    extra_reserves: &[AccountInfo<'info>],
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut accounts = vec![AccountMeta::new(*obligation.key, false), AccountMeta::new_readonly(*clock.key, false)];
    for r in extra_reserves { accounts.push(AccountMeta::new_readonly(*r.key, false)); }
    let ix = Instruction { program_id: SAVE_PROGRAM_ID, accounts, data: vec![TAG_REFRESH_OBLIGATION] };
    let mut infos = vec![save_program.clone(), obligation.clone(), clock.clone()];
    for r in extra_reserves { infos.push(r.clone()); }
    invoke_signed(&ix, &infos, signer_seeds).map_err(Into::into)
}

#[allow(clippy::too_many_arguments)]
pub fn init_obligation<'info>(
    save_program: &AccountInfo<'info>, obligation: &AccountInfo<'info>, lending_market: &AccountInfo<'info>,
    obligation_owner: &AccountInfo<'info>, rent: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>, signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let ix = Instruction {
        program_id: SAVE_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*obligation.key, false), AccountMeta::new_readonly(*lending_market.key, false),
            AccountMeta::new_readonly(*obligation_owner.key, true),
            AccountMeta::new_readonly(*rent.key, false), AccountMeta::new_readonly(*token_program.key, false),
        ],
        data: vec![TAG_INIT_OBLIGATION],
    };
    invoke_signed(&ix, &[save_program.clone(), obligation.clone(), lending_market.clone(), obligation_owner.clone(), rent.clone(), token_program.clone()], signer_seeds).map_err(Into::into)
}

#[allow(clippy::too_many_arguments)]
pub fn deposit_reserve_liquidity_and_obligation_collateral<'info>(
    save_program: &AccountInfo<'info>, source_liquidity: &AccountInfo<'info>, user_collateral: &AccountInfo<'info>,
    reserve: &AccountInfo<'info>, reserve_liquidity_supply: &AccountInfo<'info>, reserve_collateral_mint: &AccountInfo<'info>,
    lending_market: &AccountInfo<'info>, lending_market_authority: &AccountInfo<'info>,
    destination_deposit_collateral: &AccountInfo<'info>, obligation: &AccountInfo<'info>,
    obligation_owner: &AccountInfo<'info>, reserve_fee_receiver: &AccountInfo<'info>,
    reserve_liquidity_pyth_oracle: &AccountInfo<'info>,
    user_transfer_authority: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>, liquidity_amount: u64, signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(9);
    data.push(TAG_DEPOSIT_RESERVE_LIQUIDITY_AND_OBLIGATION_COLLATERAL);
    data.extend_from_slice(&liquidity_amount.to_le_bytes());
    // Account ordering from Save's deployed version (no switchboard, no clock):
    // 0:source_liq, 1:user_coll, 2:reserve, 3:reserve_liq_supply, 4:reserve_coll_mint,
    // 5:lending_market, 6:lending_market_auth, 7:dest_deposit_coll, 8:obligation,
    // 9:obligation_owner(s), 10:fee_receiver, 11:pyth_oracle, 12:user_transfer_auth(s), 13:token_program
    let ix = Instruction {
        program_id: SAVE_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*source_liquidity.key, false), AccountMeta::new(*user_collateral.key, false),
            AccountMeta::new(*reserve.key, false), AccountMeta::new(*reserve_liquidity_supply.key, false),
            AccountMeta::new(*reserve_collateral_mint.key, false), AccountMeta::new_readonly(*lending_market.key, false),
            AccountMeta::new_readonly(*lending_market_authority.key, false), AccountMeta::new(*destination_deposit_collateral.key, false),
            AccountMeta::new(*obligation.key, false), AccountMeta::new_readonly(*obligation_owner.key, true),
            AccountMeta::new(*reserve_fee_receiver.key, false), AccountMeta::new_readonly(*reserve_liquidity_pyth_oracle.key, false),
            AccountMeta::new_readonly(*user_transfer_authority.key, true),
            AccountMeta::new_readonly(*token_program.key, false),
        ],
        data,
    };
    invoke_signed(&ix, &[save_program.clone(), source_liquidity.clone(), user_collateral.clone(), reserve.clone(), reserve_liquidity_supply.clone(), reserve_collateral_mint.clone(), lending_market.clone(), lending_market_authority.clone(), destination_deposit_collateral.clone(), obligation.clone(), obligation_owner.clone(), reserve_fee_receiver.clone(), reserve_liquidity_pyth_oracle.clone(), user_transfer_authority.clone(), token_program.clone()], signer_seeds).map_err(Into::into)
}

#[allow(clippy::too_many_arguments)]
pub fn withdraw_obligation_collateral_and_redeem_reserve_collateral<'info>(
    save_program: &AccountInfo<'info>, source_withdraw_collateral_supply: &AccountInfo<'info>,
    destination_collateral: &AccountInfo<'info>, withdraw_reserve: &AccountInfo<'info>,
    obligation: &AccountInfo<'info>, lending_market: &AccountInfo<'info>,
    lending_market_authority: &AccountInfo<'info>, user_liquidity: &AccountInfo<'info>,
    reserve_collateral_mint: &AccountInfo<'info>, reserve_liquidity_supply: &AccountInfo<'info>,
    obligation_owner: &AccountInfo<'info>, user_transfer_authority: &AccountInfo<'info>,
    clock: &AccountInfo<'info>, token_program: &AccountInfo<'info>, collateral_amount: u64, signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(9);
    data.push(TAG_WITHDRAW_OBLIGATION_COLLATERAL_AND_REDEEM_RESERVE_COLLATERAL);
    data.extend_from_slice(&collateral_amount.to_le_bytes());
    let ix = Instruction {
        program_id: SAVE_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*source_withdraw_collateral_supply.key, false), AccountMeta::new(*destination_collateral.key, false),
            AccountMeta::new(*withdraw_reserve.key, false), AccountMeta::new(*obligation.key, false),
            AccountMeta::new_readonly(*lending_market.key, false), AccountMeta::new_readonly(*lending_market_authority.key, false),
            AccountMeta::new(*user_liquidity.key, false), AccountMeta::new(*reserve_collateral_mint.key, false),
            AccountMeta::new(*reserve_liquidity_supply.key, false), AccountMeta::new_readonly(*obligation_owner.key, true),
            AccountMeta::new_readonly(*user_transfer_authority.key, true), AccountMeta::new_readonly(*clock.key, false),
            AccountMeta::new_readonly(*token_program.key, false),
        ],
        data,
    };
    invoke_signed(&ix, &[save_program.clone(), source_withdraw_collateral_supply.clone(), destination_collateral.clone(), withdraw_reserve.clone(), obligation.clone(), lending_market.clone(), lending_market_authority.clone(), user_liquidity.clone(), reserve_collateral_mint.clone(), reserve_liquidity_supply.clone(), obligation_owner.clone(), user_transfer_authority.clone(), clock.clone(), token_program.clone()], signer_seeds).map_err(Into::into)
}

#[allow(clippy::too_many_arguments)]
pub fn borrow_obligation_liquidity<'info>(
    save_program: &AccountInfo<'info>, source_liquidity: &AccountInfo<'info>, destination_liquidity: &AccountInfo<'info>,
    borrow_reserve: &AccountInfo<'info>, borrow_reserve_fee_receiver: &AccountInfo<'info>,
    obligation: &AccountInfo<'info>, lending_market: &AccountInfo<'info>, lending_market_authority: &AccountInfo<'info>,
    obligation_owner: &AccountInfo<'info>, clock: &AccountInfo<'info>, token_program: &AccountInfo<'info>,
    host_fee_receiver: Option<&AccountInfo<'info>>, liquidity_amount: u64, signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(9);
    data.push(TAG_BORROW_OBLIGATION_LIQUIDITY);
    data.extend_from_slice(&liquidity_amount.to_le_bytes());
    let mut accounts = vec![
        AccountMeta::new(*source_liquidity.key, false), AccountMeta::new(*destination_liquidity.key, false),
        AccountMeta::new(*borrow_reserve.key, false), AccountMeta::new(*borrow_reserve_fee_receiver.key, false),
        AccountMeta::new(*obligation.key, false), AccountMeta::new_readonly(*lending_market.key, false),
        AccountMeta::new_readonly(*lending_market_authority.key, false), AccountMeta::new_readonly(*obligation_owner.key, true),
        AccountMeta::new_readonly(*clock.key, false), AccountMeta::new_readonly(*token_program.key, false),
    ];
    let mut infos = vec![save_program.clone(), source_liquidity.clone(), destination_liquidity.clone(), borrow_reserve.clone(), borrow_reserve_fee_receiver.clone(), obligation.clone(), lending_market.clone(), lending_market_authority.clone(), obligation_owner.clone(), clock.clone(), token_program.clone()];
    if let Some(host) = host_fee_receiver { accounts.push(AccountMeta::new(*host.key, false)); infos.push(host.clone()); }
    let ix = Instruction { program_id: SAVE_PROGRAM_ID, accounts, data };
    invoke_signed(&ix, &infos, signer_seeds).map_err(Into::into)
}

#[allow(clippy::too_many_arguments)]
pub fn repay_obligation_liquidity<'info>(
    save_program: &AccountInfo<'info>, source_liquidity: &AccountInfo<'info>, destination_liquidity: &AccountInfo<'info>,
    repay_reserve: &AccountInfo<'info>, obligation: &AccountInfo<'info>, lending_market: &AccountInfo<'info>,
    user_transfer_authority: &AccountInfo<'info>, clock: &AccountInfo<'info>, token_program: &AccountInfo<'info>,
    liquidity_amount: u64, signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(9);
    data.push(TAG_REPAY_OBLIGATION_LIQUIDITY);
    data.extend_from_slice(&liquidity_amount.to_le_bytes());
    let ix = Instruction {
        program_id: SAVE_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*source_liquidity.key, false), AccountMeta::new(*destination_liquidity.key, false),
            AccountMeta::new(*repay_reserve.key, false), AccountMeta::new(*obligation.key, false),
            AccountMeta::new_readonly(*lending_market.key, false), AccountMeta::new_readonly(*user_transfer_authority.key, true),
            AccountMeta::new_readonly(*clock.key, false), AccountMeta::new_readonly(*token_program.key, false),
        ],
        data,
    };
    invoke_signed(&ix, &[save_program.clone(), source_liquidity.clone(), destination_liquidity.clone(), repay_reserve.clone(), obligation.clone(), lending_market.clone(), user_transfer_authority.clone(), clock.clone(), token_program.clone()], signer_seeds).map_err(Into::into)
}
