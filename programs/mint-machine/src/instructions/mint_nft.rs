use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    program::invoke_signed,
    system_instruction,
};
use anchor_spl::token_2022::Token2022;
use anchor_spl::associated_token::AssociatedToken;
use spl_token_2022::{
    extension::ExtensionType,
    instruction as token_instruction,
    state::Mint,
};
use spl_token_metadata_interface::state::TokenMetadata;
use crate::state::{MintMachine, MintCount, ItemData};
use crate::error::MintMachineError;

/// Merkle proof element.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProofNode {
    pub hash: [u8; 32],
    pub is_right: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct MintNftArgs {
    /// Index within the machine's item list to mint (sequential — use items_minted).
    pub item_index: u32,
    /// Merkle proof for whitelist (empty if not WL phase).
    pub wl_proof: Vec<ProofNode>,
}

#[derive(Accounts)]
#[instruction(args: MintNftArgs)]
pub struct MintNft<'info> {
    #[account(
        mut,
        seeds = [b"machine", machine.authority.as_ref(), machine.machine_id_str().as_bytes()],
        bump = machine.bump,
    )]
    pub machine: Account<'info, MintMachine>,

    /// The fresh mint keypair — must be a new account signed by buyer.
    #[account(mut)]
    pub mint: Signer<'info>,

    /// Token account that will hold the minted NFT (ATA of buyer).
    /// CHECK: Created via CPI below.
    #[account(mut)]
    pub token_account: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = buyer,
        space = MintCount::LEN,
        seeds = [b"count", machine.key().as_ref(), buyer.key().as_ref()],
        bump,
    )]
    pub mint_count: Account<'info, MintCount>,

    /// CHECK: Validated as machine.treasury.
    #[account(mut, constraint = treasury.key() == machine.treasury @ MintMachineError::InvalidTreasury)]
    pub treasury: UncheckedAccount<'info>,

    #[account(mut)]
    pub buyer: Signer<'info>,

    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<MintNft>, args: MintNftArgs) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let machine = &ctx.accounts.machine;

    // --- Guards ---
    require!(!machine.paused, MintMachineError::MachinePaused);
    require!(machine.items_minted < machine.total_items, MintMachineError::SoldOut);
    require!(machine.items_loaded == machine.total_items, MintMachineError::ItemsNotLoaded);
    require!(args.item_index == machine.items_minted, MintMachineError::InvalidItemIndex);

    let is_wl = machine.is_wl_active(now);

    if is_wl {
        // Verify Merkle proof
        let buyer_key = ctx.accounts.buyer.key().to_bytes();
        verify_merkle_proof(
            &args.wl_proof,
            machine.whitelist.as_ref().unwrap().merkle_root,
            buyer_key,
        )?;

        // WL mint limit
        let wl = machine.whitelist.as_ref().unwrap();
        if wl.mint_limit > 0 {
            require!(
                ctx.accounts.mint_count.count < wl.mint_limit,
                MintMachineError::MintLimitReached
            );
        }

        // WL start time
        if wl.start_ts > 0 {
            require!(now >= wl.start_ts, MintMachineError::MintNotStarted);
        }
    } else {
        // Public phase
        if machine.start_ts > 0 {
            require!(now >= machine.start_ts, MintMachineError::MintNotStarted);
        }

        // Public mint limit
        if machine.mint_limit > 0 {
            require!(
                ctx.accounts.mint_count.count < machine.mint_limit,
                MintMachineError::MintLimitReached
            );
        }
    }

    // --- Read item data ---
    let item = read_item(&ctx.accounts.machine.to_account_info(), args.item_index)?;
    let item_name = item.name_str().to_string();
    let item_uri = item.uri_str().to_string();

    // --- Payment ---
    let price = if is_wl {
        machine.whitelist.as_ref().unwrap().price_lamports
    } else {
        machine.price_lamports
    };

    if price > 0 {
        invoke_signed(
            &system_instruction::transfer(
                ctx.accounts.buyer.key,
                ctx.accounts.treasury.key,
                price,
            ),
            &[
                ctx.accounts.buyer.to_account_info(),
                ctx.accounts.treasury.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[],
        )?;
    }

    // --- Create Token-2022 mint with MetadataPointer + TokenMetadata extensions ---
    let machine_id_str = machine.machine_id_str().to_string();
    let machine_key = ctx.accounts.machine.key();
    let authority_key = machine.authority;
    let bump = machine.bump;
    let seeds: &[&[u8]] = &[
        b"machine",
        authority_key.as_ref(),
        machine_id_str.as_bytes(),
        &[bump],
    ];

    // Compute space: base mint + MetadataPointer extension + TokenMetadata extension
    let metadata = TokenMetadata {
        name: item_name.clone(),
        symbol: String::new(), // populated per-collection symbol if desired
        uri: item_uri.clone(),
        additional_metadata: vec![],
        mint: ctx.accounts.mint.key(),
        update_authority: spl_pod::optional_keys::OptionalNonZeroPubkey::try_from(Some(machine_key))
            .map_err(|_| MintMachineError::InvalidMint)?,
    };

    let base_size = ExtensionType::try_calculate_account_len::<Mint>(&[
        ExtensionType::MetadataPointer,
        ExtensionType::TokenMetadata,
    ])
    .map_err(|_| MintMachineError::InvalidMint)?;

    let metadata_size = metadata.tlv_size_of()
        .map_err(|_| MintMachineError::InvalidMint)?;

    let total_size = base_size + metadata_size;
    let lamports = ctx.accounts.rent.minimum_balance(total_size);

    // Allocate mint account
    invoke_signed(
        &system_instruction::create_account(
            ctx.accounts.buyer.key,
            ctx.accounts.mint.key,
            lamports,
            total_size as u64,
            &spl_token_2022::id(),
        ),
        &[
            ctx.accounts.buyer.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[],
    )?;

    // Initialize MetadataPointer extension (points to self)
    invoke_signed(
        &token_instruction::extension::metadata_pointer::initialize(
            &spl_token_2022::id(),
            ctx.accounts.mint.key,
            Some(machine_key),  // update authority
            Some(*ctx.accounts.mint.key), // metadata address = self
        )
        .map_err(|_| MintMachineError::InvalidMint)?,
        &[ctx.accounts.mint.to_account_info()],
        &[],
    )?;

    // Initialize the mint (0 decimals, machine as mint/freeze authority)
    invoke_signed(
        &token_instruction::initialize_mint2(
            &spl_token_2022::id(),
            ctx.accounts.mint.key,
            &machine_key,
            Some(&machine_key),
            0,
        )
        .map_err(|_| MintMachineError::InvalidMint)?,
        &[ctx.accounts.mint.to_account_info()],
        &[],
    )?;

    // Initialize TokenMetadata extension
    invoke_signed(
        &spl_token_metadata_interface::instruction::initialize(
            &spl_token_2022::id(),
            ctx.accounts.mint.key,
            &machine_key,  // update authority
            ctx.accounts.mint.key, // mint
            &machine_key,  // mint authority
            item_name,
            String::new(), // symbol
            item_uri,
        ),
        &[
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.machine.to_account_info(),
        ],
        &[seeds],
    )?;

    // Create ATA for buyer
    let create_ata_ix = spl_associated_token_account::instruction::create_associated_token_account(
        ctx.accounts.buyer.key,
        ctx.accounts.buyer.key,
        ctx.accounts.mint.key,
        &spl_token_2022::id(),
    );
    invoke_signed(
        &create_ata_ix,
        &[
            ctx.accounts.buyer.to_account_info(),
            ctx.accounts.token_account.to_account_info(),
            ctx.accounts.buyer.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.token_2022_program.to_account_info(),
        ],
        &[],
    )?;

    // Mint 1 token to buyer's ATA
    invoke_signed(
        &token_instruction::mint_to(
            &spl_token_2022::id(),
            ctx.accounts.mint.key,
            ctx.accounts.token_account.key,
            &machine_key,
            &[&machine_key],
            1,
        )
        .map_err(|_| MintMachineError::InvalidMint)?,
        &[
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.token_account.to_account_info(),
            ctx.accounts.machine.to_account_info(),
        ],
        &[seeds],
    )?;

    // Remove mint authority (supply = 1, done)
    invoke_signed(
        &token_instruction::set_authority(
            &spl_token_2022::id(),
            ctx.accounts.mint.key,
            None,
            token_instruction::AuthorityType::MintTokens,
            &machine_key,
            &[&machine_key],
        )
        .map_err(|_| MintMachineError::InvalidMint)?,
        &[
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.machine.to_account_info(),
        ],
        &[seeds],
    )?;

    // --- Update counters ---
    let machine = &mut ctx.accounts.machine;
    machine.items_minted = machine.items_minted
        .checked_add(1)
        .ok_or(MintMachineError::Overflow)?;

    let mint_count = &mut ctx.accounts.mint_count;
    if mint_count.machine == Pubkey::default() {
        mint_count.machine = machine.key();
        mint_count.wallet = ctx.accounts.buyer.key();
        mint_count.bump = ctx.bumps.mint_count;
    }
    mint_count.count = mint_count.count
        .checked_add(1)
        .ok_or(MintMachineError::Overflow)?;

    msg!("Minted NFT #{} to {}", machine.items_minted, ctx.accounts.buyer.key());
    Ok(())
}

fn read_item(machine_info: &AccountInfo, idx: u32) -> Result<ItemData> {
    let data = machine_info.try_borrow_data()?;
    let base = MintMachine::BASE_LEN - 4;
    let items_offset = base + 4;
    let item_offset = items_offset + (idx as usize) * ItemData::SIZE;

    require!(
        item_offset + ItemData::SIZE <= data.len(),
        MintMachineError::InvalidItemIndex
    );

    let mut name = [0u8; 64];
    let mut uri = [0u8; 200];
    name.copy_from_slice(&data[item_offset..item_offset + 64]);
    uri.copy_from_slice(&data[item_offset + 64..item_offset + 264]);

    Ok(ItemData { name, uri })
}

fn verify_merkle_proof(proof: &[ProofNode], root: [u8; 32], leaf_data: [u8; 32]) -> Result<()> {
    use sha3::{Digest, Keccak256};

    let mut hash = Keccak256::new();
    hash.update(&leaf_data);
    let mut current: [u8; 32] = hash.finalize().into();

    for node in proof {
        let mut hasher = Keccak256::new();
        if node.is_right {
            hasher.update(&current);
            hasher.update(&node.hash);
        } else {
            hasher.update(&node.hash);
            hasher.update(&current);
        }
        current = hasher.finalize().into();
    }

    require!(current == root, MintMachineError::InvalidMerkleProof);
    Ok(())
}
