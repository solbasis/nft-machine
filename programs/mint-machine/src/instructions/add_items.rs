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

    let machine = &mut ctx.accounts.machine;
    let new_count = machine.items_loaded
        .checked_add(args.items.len() as u32)
        .ok_or(MintMachineError::Overflow)?;

    require!(new_count <= machine.total_items, MintMachineError::ExceedsSupply);

    for item in &args.items {
        require!(item.name.len() <= 64, MintMachineError::NameTooLong);
        require!(item.uri.len() <= 200, MintMachineError::UriTooLong);

        let mut name_bytes = [0u8; 64];
        name_bytes[..item.name.len()].copy_from_slice(item.name.as_bytes());

        let mut uri_bytes = [0u8; 200];
        uri_bytes[..item.uri.len()].copy_from_slice(item.uri.as_bytes());

        // Append to the machine's item list stored in trailing account data.
        // We use a raw data append approach via account_info loader.
        append_item(
            &ctx.accounts.machine.to_account_info(),
            ItemData { name: name_bytes, uri: uri_bytes },
            machine.items_loaded,
        )?;

        machine.items_loaded = machine.items_loaded
            .checked_add(1)
            .ok_or(MintMachineError::Overflow)?;
    }

    msg!("Added {} items, total loaded: {}/{}", args.items.len(), machine.items_loaded, machine.total_items);
    Ok(())
}

/// Write an ItemData at index `idx` into the trailing data of `machine_info`.
/// Layout after MintMachine::BASE_LEN - 4 bytes (vec length prefix is part of base):
///   [vec_len: u32][ItemData * n]
fn append_item(machine_info: &AccountInfo, item: ItemData, idx: u32) -> Result<()> {
    let mut data = machine_info.try_borrow_mut_data()?;
    let base = MintMachine::BASE_LEN - 4; // offset to vec length prefix
    let vec_len_offset = base;
    let items_offset = vec_len_offset + 4;

    // Update vec length
    let new_len = idx + 1;
    data[vec_len_offset..vec_len_offset + 4].copy_from_slice(&new_len.to_le_bytes());

    // Write item
    let item_offset = items_offset + (idx as usize) * ItemData::SIZE;
    let bytes = bytemuck_item(&item);
    data[item_offset..item_offset + ItemData::SIZE].copy_from_slice(bytes);

    Ok(())
}

fn bytemuck_item(item: &ItemData) -> &[u8] {
    // Safe: ItemData is Copy + no padding (u8 arrays)
    unsafe {
        std::slice::from_raw_parts(
            item as *const ItemData as *const u8,
            ItemData::SIZE,
        )
    }
}
