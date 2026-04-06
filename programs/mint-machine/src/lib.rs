use anchor_lang::prelude::*;

pub mod error;
pub mod state;
pub mod instructions;

use instructions::*;

declare_id!("MintMach1neXXXXXXXXXXXXXXXXXXXXXXXXXXXXX1");

#[program]
pub mod mint_machine {
    use super::*;

    /// Create a new mint machine with config.
    pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
        instructions::initialize::handler(ctx, args)
    }

    /// Load items (name + URI) into the machine in batches.
    pub fn add_items(ctx: Context<AddItems>, args: AddItemsArgs) -> Result<()> {
        instructions::add_items::handler(ctx, args)
    }

    /// Mint a Token-2022 NFT from the machine.
    pub fn mint_nft(ctx: Context<MintNft>, args: MintNftArgs) -> Result<()> {
        instructions::mint_nft::handler(ctx, args)
    }

    /// Withdraw excess lamports from the machine account to authority.
    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        instructions::withdraw::handler(ctx)
    }

    /// Pause or unpause minting.
    pub fn set_paused(ctx: Context<SetPaused>, args: SetPausedArgs) -> Result<()> {
        instructions::set_paused::handler(ctx, args)
    }
}
