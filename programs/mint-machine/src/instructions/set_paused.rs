use anchor_lang::prelude::*;
use crate::state::MintMachine;
use crate::error::MintMachineError;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SetPausedArgs {
    pub paused: bool,
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(
        mut,
        has_one = authority @ MintMachineError::Unauthorized,
    )]
    pub machine: Account<'info, MintMachine>,

    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<SetPaused>, args: SetPausedArgs) -> Result<()> {
    ctx.accounts.machine.paused = args.paused;
    msg!("Machine paused: {}", args.paused);
    Ok(())
}
