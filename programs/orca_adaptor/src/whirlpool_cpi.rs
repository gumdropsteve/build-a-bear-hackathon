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
