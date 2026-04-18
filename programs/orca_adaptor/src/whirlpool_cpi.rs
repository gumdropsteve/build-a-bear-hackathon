//! Orca Whirlpool CPI helpers.
//!
//! Whirlpool is an Anchor program, so its instructions are dispatched by an
//! 8-byte Anchor discriminator. We hand-construct the `swap` instruction
//! rather than depending on the Whirlpool crate to keep our build slim.
//!
//! Source of truth:
//!   https://github.com/orca-so/whirlpools/blob/main/programs/whirlpool/src/instructions/swap.rs

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    hash::hash,
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    pubkey,
};

/// Orca Whirlpool program ID on mainnet.
pub const WHIRLPOOL_PROGRAM_ID: Pubkey =
    pubkey!("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");

/// Build the 8-byte Anchor instruction discriminator for `global:<name>`.
fn anchor_disc(name: &str) -> [u8; 8] {
    let mut out = [0u8; 8];
    let full = format!("global:{name}");
    let h = hash(full.as_bytes()).to_bytes();
    out.copy_from_slice(&h[..8]);
    out
}

/// CPI into Whirlpool's `swap` instruction.
///
/// Parameters per Whirlpool's on-chain signature:
/// ```text
/// swap(
///   amount: u64,
///   other_amount_threshold: u64,
///   sqrt_price_limit: u128,
///   amount_specified_is_input: bool,
///   a_to_b: bool,
/// )
/// ```
///
/// `token_authority` must be a PDA of the calling program whose seeds are
/// provided via `signer_seeds`.
#[allow(clippy::too_many_arguments)]
pub fn swap<'info>(
    whirlpool_program: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    token_authority: &AccountInfo<'info>,
    whirlpool: &AccountInfo<'info>,
    token_owner_account_a: &AccountInfo<'info>,
    token_vault_a: &AccountInfo<'info>,
    token_owner_account_b: &AccountInfo<'info>,
    token_vault_b: &AccountInfo<'info>,
    tick_array_0: &AccountInfo<'info>,
    tick_array_1: &AccountInfo<'info>,
    tick_array_2: &AccountInfo<'info>,
    oracle: &AccountInfo<'info>,
    amount: u64,
    other_amount_threshold: u64,
    sqrt_price_limit: u128,
    amount_specified_is_input: bool,
    a_to_b: bool,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(8 + 8 + 8 + 16 + 1 + 1);
    data.extend_from_slice(&anchor_disc("swap"));
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&other_amount_threshold.to_le_bytes());
    data.extend_from_slice(&sqrt_price_limit.to_le_bytes());
    data.push(amount_specified_is_input as u8);
    data.push(a_to_b as u8);

    let ix = Instruction {
        program_id: WHIRLPOOL_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(*token_program.key, false),
            AccountMeta::new_readonly(*token_authority.key, true),
            AccountMeta::new(*whirlpool.key, false),
            AccountMeta::new(*token_owner_account_a.key, false),
            AccountMeta::new(*token_vault_a.key, false),
            AccountMeta::new(*token_owner_account_b.key, false),
            AccountMeta::new(*token_vault_b.key, false),
            AccountMeta::new(*tick_array_0.key, false),
            AccountMeta::new(*tick_array_1.key, false),
            AccountMeta::new(*tick_array_2.key, false),
            // Whirlpool updates the oracle account during swap (TWAP state),
            // so it must be writable.
            AccountMeta::new(*oracle.key, false),
        ],
        data,
    };

    invoke_signed(
        &ix,
        &[
            whirlpool_program.clone(),
            token_program.clone(),
            token_authority.clone(),
            whirlpool.clone(),
            token_owner_account_a.clone(),
            token_vault_a.clone(),
            token_owner_account_b.clone(),
            token_vault_b.clone(),
            tick_array_0.clone(),
            tick_array_1.clone(),
            tick_array_2.clone(),
            oracle.clone(),
        ],
        signer_seeds,
    )
    .map_err(Into::into)
}

/// CPI into Whirlpool's `open_position` instruction.
///
/// Creates a new Position account + mints a Position NFT to the owner's
/// position_token_account. The position starts with zero liquidity — use
/// `increase_liquidity` to deposit into it (Phase 3).
///
/// `position_mint` is a fresh `Keypair` generated off-chain; the client
/// must sign the tx with it. We just forward the accounts.
///
/// Whirlpool signature:
/// ```text
/// open_position(
///   bumps: OpenPositionBumps { position_bump: u8 },
///   tick_lower_index: i32,
///   tick_upper_index: i32,
/// )
/// ```
#[allow(clippy::too_many_arguments)]
pub fn open_position<'info>(
    whirlpool_program: &AccountInfo<'info>,
    funder: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    position: &AccountInfo<'info>,
    position_mint: &AccountInfo<'info>,
    position_token_account: &AccountInfo<'info>,
    whirlpool: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    rent: &AccountInfo<'info>,
    associated_token_program: &AccountInfo<'info>,
    position_bump: u8,
    tick_lower_index: i32,
    tick_upper_index: i32,
) -> Result<()> {
    let mut data = Vec::with_capacity(8 + 1 + 4 + 4);
    data.extend_from_slice(&anchor_disc("open_position"));
    data.push(position_bump);
    data.extend_from_slice(&tick_lower_index.to_le_bytes());
    data.extend_from_slice(&tick_upper_index.to_le_bytes());

    let ix = Instruction {
        program_id: WHIRLPOOL_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*funder.key, true),
            AccountMeta::new_readonly(*owner.key, false),
            AccountMeta::new(*position.key, false),
            AccountMeta::new(*position_mint.key, true),
            AccountMeta::new(*position_token_account.key, false),
            AccountMeta::new_readonly(*whirlpool.key, false),
            AccountMeta::new_readonly(*token_program.key, false),
            AccountMeta::new_readonly(*system_program.key, false),
            AccountMeta::new_readonly(*rent.key, false),
            AccountMeta::new_readonly(*associated_token_program.key, false),
        ],
        data,
    };

    // No signer_seeds needed — funder and position_mint are real signers on
    // the outer transaction.
    anchor_lang::solana_program::program::invoke(
        &ix,
        &[
            whirlpool_program.clone(),
            funder.clone(),
            owner.clone(),
            position.clone(),
            position_mint.clone(),
            position_token_account.clone(),
            whirlpool.clone(),
            token_program.clone(),
            system_program.clone(),
            rent.clone(),
            associated_token_program.clone(),
        ],
    )
    .map_err(Into::into)
}

/// Shared accounts list for `increase_liquidity` and `decrease_liquidity`.
/// Both use Whirlpool's `ModifyLiquidity` account struct.
#[allow(clippy::too_many_arguments)]
fn modify_liquidity_accounts<'info>(
    whirlpool_program: &AccountInfo<'info>,
    whirlpool: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    position_authority: &AccountInfo<'info>,
    position: &AccountInfo<'info>,
    position_token_account: &AccountInfo<'info>,
    token_owner_account_a: &AccountInfo<'info>,
    token_owner_account_b: &AccountInfo<'info>,
    token_vault_a: &AccountInfo<'info>,
    token_vault_b: &AccountInfo<'info>,
    tick_array_lower: &AccountInfo<'info>,
    tick_array_upper: &AccountInfo<'info>,
) -> (Vec<AccountMeta>, Vec<AccountInfo<'info>>) {
    let metas = vec![
        AccountMeta::new(*whirlpool.key, false),
        AccountMeta::new_readonly(*token_program.key, false),
        AccountMeta::new_readonly(*position_authority.key, true),
        AccountMeta::new(*position.key, false),
        AccountMeta::new_readonly(*position_token_account.key, false),
        AccountMeta::new(*token_owner_account_a.key, false),
        AccountMeta::new(*token_owner_account_b.key, false),
        AccountMeta::new(*token_vault_a.key, false),
        AccountMeta::new(*token_vault_b.key, false),
        AccountMeta::new(*tick_array_lower.key, false),
        AccountMeta::new(*tick_array_upper.key, false),
    ];
    let infos = vec![
        whirlpool_program.clone(),
        whirlpool.clone(),
        token_program.clone(),
        position_authority.clone(),
        position.clone(),
        position_token_account.clone(),
        token_owner_account_a.clone(),
        token_owner_account_b.clone(),
        token_vault_a.clone(),
        token_vault_b.clone(),
        tick_array_lower.clone(),
        tick_array_upper.clone(),
    ];
    (metas, infos)
}

/// CPI into Whirlpool's `increase_liquidity` instruction.
///
/// Deposits `token_max_a` / `token_max_b` of the two tokens into the
/// position for `liquidity_amount` units of concentrated liquidity.
/// Whirlpool computes the exact tokens taken from max inputs.
#[allow(clippy::too_many_arguments)]
pub fn increase_liquidity<'info>(
    whirlpool_program: &AccountInfo<'info>,
    whirlpool: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    position_authority: &AccountInfo<'info>,
    position: &AccountInfo<'info>,
    position_token_account: &AccountInfo<'info>,
    token_owner_account_a: &AccountInfo<'info>,
    token_owner_account_b: &AccountInfo<'info>,
    token_vault_a: &AccountInfo<'info>,
    token_vault_b: &AccountInfo<'info>,
    tick_array_lower: &AccountInfo<'info>,
    tick_array_upper: &AccountInfo<'info>,
    liquidity_amount: u128,
    token_max_a: u64,
    token_max_b: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(8 + 16 + 8 + 8);
    data.extend_from_slice(&anchor_disc("increase_liquidity"));
    data.extend_from_slice(&liquidity_amount.to_le_bytes());
    data.extend_from_slice(&token_max_a.to_le_bytes());
    data.extend_from_slice(&token_max_b.to_le_bytes());

    let (accounts, infos) = modify_liquidity_accounts(
        whirlpool_program, whirlpool, token_program, position_authority,
        position, position_token_account, token_owner_account_a,
        token_owner_account_b, token_vault_a, token_vault_b,
        tick_array_lower, tick_array_upper,
    );
    let ix = Instruction { program_id: WHIRLPOOL_PROGRAM_ID, accounts, data };
    invoke_signed(&ix, &infos, signer_seeds).map_err(Into::into)
}

/// CPI into Whirlpool's `decrease_liquidity` instruction.
///
/// Removes `liquidity_amount` units from the position and sends the
/// corresponding tokens back to the caller's ATAs. `token_min_a/b` are
/// slippage floors.
#[allow(clippy::too_many_arguments)]
pub fn decrease_liquidity<'info>(
    whirlpool_program: &AccountInfo<'info>,
    whirlpool: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    position_authority: &AccountInfo<'info>,
    position: &AccountInfo<'info>,
    position_token_account: &AccountInfo<'info>,
    token_owner_account_a: &AccountInfo<'info>,
    token_owner_account_b: &AccountInfo<'info>,
    token_vault_a: &AccountInfo<'info>,
    token_vault_b: &AccountInfo<'info>,
    tick_array_lower: &AccountInfo<'info>,
    tick_array_upper: &AccountInfo<'info>,
    liquidity_amount: u128,
    token_min_a: u64,
    token_min_b: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(8 + 16 + 8 + 8);
    data.extend_from_slice(&anchor_disc("decrease_liquidity"));
    data.extend_from_slice(&liquidity_amount.to_le_bytes());
    data.extend_from_slice(&token_min_a.to_le_bytes());
    data.extend_from_slice(&token_min_b.to_le_bytes());

    let (accounts, infos) = modify_liquidity_accounts(
        whirlpool_program, whirlpool, token_program, position_authority,
        position, position_token_account, token_owner_account_a,
        token_owner_account_b, token_vault_a, token_vault_b,
        tick_array_lower, tick_array_upper,
    );
    let ix = Instruction { program_id: WHIRLPOOL_PROGRAM_ID, accounts, data };
    invoke_signed(&ix, &infos, signer_seeds).map_err(Into::into)
}

/// CPI into Whirlpool's `close_position` instruction.
///
/// Burns the Position NFT and closes the Position account. Requires the
/// position to have 0 liquidity; any leftover fees/rewards must be
/// collected and liquidity decreased to 0 first.
///
/// `position_authority` is the authority that can spend the position NFT
/// from `position_token_account`. For our strategy that's the config PDA,
/// which signs via `signer_seeds`.
///
/// Whirlpool signature:
/// ```text
/// close_position()
/// ```
#[allow(clippy::too_many_arguments)]
pub fn close_position<'info>(
    whirlpool_program: &AccountInfo<'info>,
    position_authority: &AccountInfo<'info>,
    receiver: &AccountInfo<'info>,
    position: &AccountInfo<'info>,
    position_mint: &AccountInfo<'info>,
    position_token_account: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let ix = Instruction {
        program_id: WHIRLPOOL_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(*position_authority.key, true),
            AccountMeta::new(*receiver.key, false),
            AccountMeta::new(*position.key, false),
            AccountMeta::new(*position_mint.key, false),
            AccountMeta::new(*position_token_account.key, false),
            AccountMeta::new_readonly(*token_program.key, false),
        ],
        data: anchor_disc("close_position").to_vec(),
    };

    invoke_signed(
        &ix,
        &[
            whirlpool_program.clone(),
            position_authority.clone(),
            receiver.clone(),
            position.clone(),
            position_mint.clone(),
            position_token_account.clone(),
            token_program.clone(),
        ],
        signer_seeds,
    )
    .map_err(Into::into)
}
