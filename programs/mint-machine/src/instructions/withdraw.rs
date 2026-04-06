use anchor_lang::prelude::*;
use crate::state::MintMachine;
use crate::error::MintMachineError;

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        has_one = authority @ MintMachineError::Unauthorized,
    )]
    pub machine: Account<'info, MintMachine>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Withdraw>) -> Result<()> {
    let machine_info = ctx.accounts.machine.to_account_info();
    let authority_info = ctx.accounts.authority.to_account_info();

    let rent_exempt = Rent::get()?.minimum_balance(machine_info.data_len());
    let balance = machine_info.lamports();

    let withdrawable = balance.saturating_sub(rent_exempt);
    require!(withdrawable > 0, MintMachineError::Unauthorized);

    **machine_info.lamports.borrow_mut() -= withdrawable;
    **authority_info.lamports.borrow_mut() += withdrawable;

    msg!("Withdrew {} lamports to authority", withdrawable);
    Ok(())
}
