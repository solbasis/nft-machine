use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    program::{invoke, invoke_signed},
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
use spl_pod::optional_keys::OptionalNonZeroPubkey;
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
    /// Machine ID string — must match what was passed to initialize.
    /// Used to verify the machine PDA in the accounts constraint.
    pub machine_id: String,
    /// Sequential item index to mint (must equal machine.items_minted).
    pub item_index: u32,
    /// Merkle proof for whitelist (empty if not in WL phase).
    pub wl_proof: Vec<ProofNode>,
}

#[derive(Accounts)]
#[instruction(args: MintNftArgs)]
pub struct MintNft<'info> {
    #[account(
        mut,
        seeds = [b"machine", machine.authority.as_ref(), args.machine_id.as_bytes()],
        bump = machine.bump,
    )]
    pub machine: Account<'info, MintMachine>,

    /// Fresh keypair — must be a brand-new account, signed by buyer.
    #[account(mut)]
    pub mint: Signer<'info>,

    /// Buyer's ATA for the new mint (created in this instruction).
    /// CHECK: Created via CPI to the associated token program.
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

    /// CHECK: Validated against machine.treasury in the constraint below.
    #[account(
        mut,
        constraint = treasury.key() == machine.treasury @ MintMachineError::InvalidTreasury
    )]
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

    // ── Guards ───────────────────────────────────────────────────────────────
    {
        let machine = &ctx.accounts.machine;
        require!(!machine.paused,                                   MintMachineError::MachinePaused);
        require!(machine.items_minted < machine.total_items,        MintMachineError::SoldOut);
        require!(machine.items_loaded == machine.total_items,       MintMachineError::ItemsNotLoaded);
        require!(args.item_index == machine.items_minted,           MintMachineError::InvalidItemIndex);

        let is_wl = machine.is_wl_active(now);

        if is_wl {
            let wl = &machine.whitelist;

            // Verify Merkle proof
            let buyer_bytes = ctx.accounts.buyer.key().to_bytes();
            verify_merkle_proof(&args.wl_proof, wl.merkle_root, buyer_bytes)?;

            // WL start time
            if wl.start_ts > 0 {
                require!(now >= wl.start_ts, MintMachineError::MintNotStarted);
            }

            // WL per-wallet limit
            if wl.mint_limit > 0 {
                require!(
                    ctx.accounts.mint_count.count < wl.mint_limit,
                    MintMachineError::MintLimitReached
                );
            }
        } else {
            // Public phase
            if machine.start_ts > 0 {
                require!(now >= machine.start_ts, MintMachineError::MintNotStarted);
            }
            if machine.mint_limit > 0 {
                require!(
                    ctx.accounts.mint_count.count < machine.mint_limit,
                    MintMachineError::MintLimitReached
                );
            }
        }
    }

    // ── Read item metadata from raw trailing storage ──────────────────────────
    let item = read_item(&ctx.accounts.machine.to_account_info(), args.item_index)?;
    let item_name = item.name_str().to_string();
    let item_uri  = item.uri_str().to_string();
    let name_len  = item_name.len();
    let uri_len   = item_uri.len();

    // ── Payment ───────────────────────────────────────────────────────────────
    let is_wl = ctx.accounts.machine.is_wl_active(now);
    let price = if is_wl {
        ctx.accounts.machine.whitelist.price_lamports
    } else {
        ctx.accounts.machine.price_lamports
    };

    if price > 0 {
        invoke(
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
        )?;
    }

    // ── Collect PDA signing seeds ─────────────────────────────────────────────
    let machine_key  = ctx.accounts.machine.key();
    let authority_key = ctx.accounts.machine.authority;
    let bump         = ctx.accounts.machine.bump;
    let machine_id_bytes = args.machine_id.as_bytes();
    let bump_slice   = &[bump];
    let seeds: &[&[u8]] = &[b"machine", authority_key.as_ref(), machine_id_bytes, bump_slice];
    let signer_seeds = &[seeds];

    // ── Compute Token-2022 mint account size ──────────────────────────────────
    // Base mint + MetadataPointer extension
    let base_size = ExtensionType::try_calculate_account_len::<Mint>(&[
        ExtensionType::MetadataPointer,
    ])
    .map_err(|_| MintMachineError::InvalidMint)?;

    // TokenMetadata TLV:  type(2) + len(2) + update_authority(32) + mint(32)
    //                     + name_len(4) + name + symbol_len(4) + "" + uri_len(4) + uri
    //                     + additional_metadata_len(4) (empty vec)
    let metadata_tlv_size = 4 + 32 + 32 + (4 + name_len) + (4 + 0) + (4 + uri_len) + 4;
    let total_size = base_size + metadata_tlv_size;
    let lamports   = ctx.accounts.rent.minimum_balance(total_size);

    // ── Create mint account ───────────────────────────────────────────────────
    invoke(
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
    )?;

    // ── Initialize MetadataPointer extension (self-referential) ───────────────
    invoke(
        &token_instruction::extension::metadata_pointer::initialize(
            &spl_token_2022::id(),
            ctx.accounts.mint.key,
            Some(machine_key),           // update authority = machine PDA
            Some(*ctx.accounts.mint.key), // metadata stored in mint itself
        )
        .map_err(|_| MintMachineError::InvalidMint)?,
        &[ctx.accounts.mint.to_account_info()],
    )?;

    // ── Initialize mint (0 decimals, machine PDA as mint + freeze authority) ──
    invoke(
        &token_instruction::initialize_mint2(
            &spl_token_2022::id(),
            ctx.accounts.mint.key,
            &machine_key,
            Some(&machine_key),
            0,
        )
        .map_err(|_| MintMachineError::InvalidMint)?,
        &[ctx.accounts.mint.to_account_info()],
    )?;

    // ── Initialize TokenMetadata extension ────────────────────────────────────
    // machine PDA must sign as mint_authority
    invoke_signed(
        &spl_token_metadata_interface::instruction::initialize(
            &spl_token_2022::id(),
            ctx.accounts.mint.key,    // metadata (= mint itself)
            &machine_key,             // update authority
            ctx.accounts.mint.key,    // mint
            &machine_key,             // mint authority (signs via PDA)
            item_name,
            String::new(),            // symbol
            item_uri,
        ),
        &[
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.machine.to_account_info(),
        ],
        signer_seeds,
    )?;

    // ── Create buyer's ATA ────────────────────────────────────────────────────
    invoke(
        &spl_associated_token_account::instruction::create_associated_token_account(
            ctx.accounts.buyer.key,
            ctx.accounts.buyer.key,
            ctx.accounts.mint.key,
            &spl_token_2022::id(),
        ),
        &[
            ctx.accounts.buyer.to_account_info(),
            ctx.accounts.token_account.to_account_info(),
            ctx.accounts.buyer.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.token_2022_program.to_account_info(),
        ],
    )?;

    // ── Mint 1 token → buyer's ATA ────────────────────────────────────────────
    invoke_signed(
        &token_instruction::mint_to(
            &spl_token_2022::id(),
            ctx.accounts.mint.key,
            ctx.accounts.token_account.key,
            &machine_key,
            &[],  // multisigs empty — PDA signing via invoke_signed
            1,
        )
        .map_err(|_| MintMachineError::InvalidMint)?,
        &[
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.token_account.to_account_info(),
            ctx.accounts.machine.to_account_info(),
        ],
        signer_seeds,
    )?;

    // ── Remove mint authority (supply = 1, immutable) ─────────────────────────
    invoke_signed(
        &token_instruction::set_authority(
            &spl_token_2022::id(),
            ctx.accounts.mint.key,
            None,
            token_instruction::AuthorityType::MintTokens,
            &machine_key,
            &[],
        )
        .map_err(|_| MintMachineError::InvalidMint)?,
        &[
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.machine.to_account_info(),
        ],
        signer_seeds,
    )?;

    // ── Update counters ───────────────────────────────────────────────────────
    let machine = &mut ctx.accounts.machine;
    machine.items_minted = machine.items_minted
        .checked_add(1)
        .ok_or(MintMachineError::Overflow)?;

    let mint_count = &mut ctx.accounts.mint_count;
    if mint_count.machine == Pubkey::default() {
        mint_count.machine = machine.key();
        mint_count.wallet  = ctx.accounts.buyer.key();
        mint_count.bump    = ctx.bumps.mint_count;
    }
    mint_count.count = mint_count.count
        .checked_add(1)
        .ok_or(MintMachineError::Overflow)?;

    msg!(
        "Minted NFT #{} to {}",
        machine.items_minted, ctx.accounts.buyer.key()
    );
    Ok(())
}

/// Read ItemData at `idx` from the machine account's raw trailing storage.
fn read_item(machine_info: &AccountInfo, idx: u32) -> Result<ItemData> {
    let data = machine_info.try_borrow_data()?;

    let items_start = MintMachine::BASE_LEN;
    let item_offset = items_start + (idx as usize) * ItemData::SIZE;

    require!(
        item_offset + ItemData::SIZE <= data.len(),
        MintMachineError::InvalidItemIndex
    );

    let mut name = [0u8; 64];
    let mut uri  = [0u8; 200];
    name.copy_from_slice(&data[item_offset..item_offset + 64]);
    uri.copy_from_slice(&data[item_offset + 64..item_offset + ItemData::SIZE]);

    Ok(ItemData { name, uri })
}

/// Verify a keccak256 Merkle proof. Mirrors the client-side logic in merkle.js.
fn verify_merkle_proof(proof: &[ProofNode], root: [u8; 32], leaf_data: [u8; 32]) -> Result<()> {
    use sha3::{Digest, Keccak256};

    let mut current: [u8; 32] = Keccak256::digest(leaf_data).into();

    for node in proof {
        let combined = if node.is_right {
            let mut b = [0u8; 64];
            b[..32].copy_from_slice(&current);
            b[32..].copy_from_slice(&node.hash);
            b
        } else {
            let mut b = [0u8; 64];
            b[..32].copy_from_slice(&node.hash);
            b[32..].copy_from_slice(&current);
            b
        };
        current = Keccak256::digest(combined).into();
    }

    require!(current == root, MintMachineError::InvalidMerkleProof);
    Ok(())
}
