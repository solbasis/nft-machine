use anchor_lang::prelude::*;
use crate::state::{MintMachine, WhitelistConfig};
use crate::error::MintMachineError;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct InitializeArgs {
    pub machine_id: String,
    pub name: String,
    pub collection_uri: String,
    pub total_items: u32,
    pub price_lamports: u64,
    pub mint_limit: u16,
    pub start_ts: i64,
    pub treasury: Pubkey,
    /// If None, whitelist is disabled (zeroed merkle_root stored).
    pub whitelist: Option<WhitelistConfigArgs>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct WhitelistConfigArgs {
    pub merkle_root: [u8; 32],
    pub price_lamports: u64,
    pub mint_limit: u16,
    pub start_ts: i64,
    pub end_ts: i64,
}

#[derive(Accounts)]
#[instruction(args: InitializeArgs)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = MintMachine::space_for(0),
        seeds = [b"machine", authority.key().as_ref(), args.machine_id.as_bytes()],
        bump,
    )]
    pub machine: Account<'info, MintMachine>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
    require!(args.machine_id.len() <= 32, MintMachineError::MachineIdTooLong);
    require!(args.name.len() <= 64, MintMachineError::NameTooLong);
    require!(args.collection_uri.len() <= 200, MintMachineError::UriTooLong);

    let machine = &mut ctx.accounts.machine;

    machine.authority = ctx.accounts.authority.key();
    machine.treasury = args.treasury;
    machine.bump = ctx.bumps.machine;
    machine.total_items = args.total_items;
    machine.items_loaded = 0;
    machine.items_minted = 0;
    machine.price_lamports = args.price_lamports;
    machine.mint_limit = args.mint_limit;
    machine.start_ts = args.start_ts;
    machine.paused = false;

    let mut id_bytes = [0u8; 32];
    id_bytes[..args.machine_id.len()].copy_from_slice(args.machine_id.as_bytes());
    machine.machine_id = id_bytes;

    let mut name_bytes = [0u8; 64];
    name_bytes[..args.name.len()].copy_from_slice(args.name.as_bytes());
    machine.name = name_bytes;

    let mut uri_bytes = [0u8; 200];
    uri_bytes[..args.collection_uri.len()].copy_from_slice(args.collection_uri.as_bytes());
    machine.collection_uri = uri_bytes;

    // WhitelistConfig is always stored — None args → zeroed struct (= disabled).
    machine.whitelist = if let Some(wl) = args.whitelist {
        WhitelistConfig {
            merkle_root: wl.merkle_root,
            price_lamports: wl.price_lamports,
            mint_limit: wl.mint_limit,
            start_ts: wl.start_ts,
            end_ts: wl.end_ts,
        }
    } else {
        WhitelistConfig::default()
    };

    msg!("MintMachine initialized: {} ({} items)", args.machine_id, args.total_items);
    Ok(())
}
