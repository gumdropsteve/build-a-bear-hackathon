//! Jupiter V6 CPI helper.
//!
//! Jupiter swaps are NOT type-constructed inside an Anchor program. Instead:
//!   1. The off-chain keeper queries Jupiter's quote API for a route
//!   2. The keeper asks Jupiter's swap API for the raw `instruction_data` (u8 blob)
//!      and the full list of route accounts
//!   3. The keeper passes both through to our adaptor as the swap args +
//!      `remaining_accounts`
//!   4. Our adaptor forwards them as a raw Instruction to the Jupiter program
//!
//! The adaptor does not decode or validate the route — it trusts the keeper to
//! pass a route that meets the slippage bound. Jupiter itself enforces the
//! minimum-out check from the route data, so a mis-quoted route reverts at the
//! Jupiter layer, not ours.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    pubkey,
};

/// Jupiter V6 Aggregator program ID.
pub const JUPITER_V6_PROGRAM_ID: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

/// Forward a pre-built Jupiter swap instruction via CPI.
///
/// Jupiter's swap instruction requires the user_transfer_authority (our
/// config PDA) to be marked is_signer in the inner AccountMeta. The outer
/// transaction can't mark a PDA as signer (PDAs have no keypair), so we
/// override the bit here; `invoke_signed` authorizes via seeds.
pub fn invoke_jupiter_swap<'info>(
    jupiter_program: &AccountInfo<'info>,
    signer_pda: &Pubkey,
    route_accounts: &[AccountInfo<'info>],
    instruction_data: Vec<u8>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let account_metas: Vec<AccountMeta> = route_accounts
        .iter()
        .map(|acc| {
            let is_signer = acc.is_signer || acc.key == signer_pda;
            if acc.is_writable {
                AccountMeta::new(*acc.key, is_signer)
            } else {
                AccountMeta::new_readonly(*acc.key, is_signer)
            }
        })
        .collect();

    let ix = Instruction {
        program_id: JUPITER_V6_PROGRAM_ID,
        accounts: account_metas,
        data: instruction_data,
    };

    let mut account_infos: Vec<AccountInfo<'info>> = Vec::with_capacity(route_accounts.len() + 1);
    account_infos.push(jupiter_program.clone());
    for acc in route_accounts {
        account_infos.push(acc.clone());
    }

    invoke_signed(&ix, &account_infos, signer_seeds).map_err(Into::into)
}
