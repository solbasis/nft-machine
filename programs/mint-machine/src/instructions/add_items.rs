use anchor_lang::prelude::*;
use crate::state::{MintMachine, ItemData};
use crate::error::MintMachineError;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct AddItemsArgs {
    pub items: Vec<ItemInput>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ItemInput {
    pub name: String,
    pub uri: String,
}

#[derive(Accounts)]
#[instruction(args: AddItemsArgs)]
pub struct AddItems<'info> {
    #[account(
        mut,
        has_one = authority @ MintMachineError::Unauthorized,
        realloc = MintMachine::space_for(machine.items_loaded + args.items.len() as u32),
        realloc::payer = authority,
        realloc::zero = false,
    )]
    pub machine: Account<'info, MintMachine>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<AddItems>, args: AddItemsArgs) -> Result<()> {
    require!(!args.items.is_empty(), MintMachineError::NoItems);

    // Read current counts before any borrows
    let items_loaded = ctx.accounts.machine.items_loaded;
    let total_items  = ctx.accounts.machine.total_items;

    let new_count = items_loaded
        .checked_add(args.items.len() as u32)
        .ok_or(MintMachineError::Overflow)?;
    require!(new_count <= total_items, MintMachineError::ExceedsSupply);

    // Validate all items first
    for item in &args.items {
        require!(item.name.len() <= 64,  MintMachineError::NameTooLong);
        require!(item.uri.len()  <= 200, MintMachineError::UriTooLong);
    }

    // Write items into trailing raw storage — separate from the struct update below
    for (i, item) in args.items.iter().enumerate() {
        let mut name_bytes = [0u8; 64];
        name_bytes[..item.name.len()].copy_from_slice(item.name.as_bytes());

        let mut uri_bytes = [0u8; 200];
        uri_bytes[..item.uri.len()].copy_from_slice(item.uri.as_bytes());

        let idx = items_loaded + i as u32;
        append_item(
            &ctx.accounts.machine.to_account_info(),
            ItemData { name: name_bytes, uri: uri_bytes },
            idx,
        )?;
    }

    // Update struct field — Anchor serialises this at end of instruction
    ctx.accounts.machine.items_loaded = new_count;

    msg!(
        "Added {} items, total loaded: {}/{}",
        args.items.len(), new_count, total_items
    );
    Ok(())
}

/// Write an ItemData at index `idx` into the trailing raw storage of the machine account.
///
/// Storage layout (after Anchor struct bytes end at BASE_LEN - 4):
///   [vec_len: u32 LE][ItemData * n]
///
/// BASE_LEN already includes the 4-byte vec_len prefix, so items start at BASE_LEN.
fn append_item(machine_info: &AccountInfo, item: ItemData, idx: u32) -> Result<()> {
    let mut data = machine_info.try_borrow_mut_data()?;

    let vec_len_offset = MintMachine::BASE_LEN - 4;
    let items_start    = MintMachine::BASE_LEN;

    // Update vec length prefix
    let new_len = idx + 1;
    data[vec_len_offset..vec_len_offset + 4].copy_from_slice(&new_len.to_le_bytes());

    // Write item bytes directly — ItemData is all [u8; N] with no padding
    let item_offset = items_start + (idx as usize) * ItemData::SIZE;
    data[item_offset..item_offset + 64].copy_from_slice(&item.name);
    data[item_offset + 64..item_offset + ItemData::SIZE].copy_from_slice(&item.uri);

    Ok(())
}
