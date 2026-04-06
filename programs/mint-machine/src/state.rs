use anchor_lang::prelude::*;

/// Fixed-size item stored in the machine's item list.
/// name: up to 64 bytes (padded with zeros), uri: up to 200 bytes (padded).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct ItemData {
    pub name: [u8; 64],
    pub uri: [u8; 200],
}

impl ItemData {
    pub const SIZE: usize = 64 + 200; // 264 bytes

    pub fn name_str(&self) -> &str {
        let end = self.name.iter().position(|&b| b == 0).unwrap_or(64);
        std::str::from_utf8(&self.name[..end]).unwrap_or("")
    }

    pub fn uri_str(&self) -> &str {
        let end = self.uri.iter().position(|&b| b == 0).unwrap_or(200);
        std::str::from_utf8(&self.uri[..end]).unwrap_or("")
    }
}

/// Per-wallet mint count tracker. PDA seeds: ["count", machine, wallet].
#[account]
pub struct MintCount {
    pub machine: Pubkey,
    pub wallet: Pubkey,
    pub count: u16,
    pub bump: u8,
}

impl MintCount {
    pub const LEN: usize = 8 + 32 + 32 + 2 + 1; // 75 bytes
}

/// Whitelist config (optional phase before public).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct WhitelistConfig {
    /// keccak256 Merkle root of allowed wallets (32 bytes, zeroed = no WL).
    pub merkle_root: [u8; 32],
    /// Price in lamports during WL phase (0 = free).
    pub price_lamports: u64,
    /// Per-wallet mint limit during WL phase (0 = unlimited).
    pub mint_limit: u16,
    /// Unix timestamp when WL phase starts (0 = no restriction).
    pub start_ts: i64,
    /// Unix timestamp when WL phase ends / public begins (0 = manual).
    pub end_ts: i64,
}

/// The main mint machine account. PDA seeds: ["machine", authority, machine_id].
#[account]
pub struct MintMachine {
    /// Authority that can update/withdraw.
    pub authority: Pubkey,
    /// Where mint proceeds go.
    pub treasury: Pubkey,
    /// Human-readable machine ID (≤32 bytes, UTF-8).
    pub machine_id: [u8; 32],
    /// Collection name shown in metadata (≤64 bytes).
    pub name: [u8; 64],
    /// Collection-level metadata URI (≤200 bytes).
    pub collection_uri: [u8; 200],
    /// Total items in this machine.
    pub total_items: u32,
    /// How many items have been loaded via add_items.
    pub items_loaded: u32,
    /// How many have been minted.
    pub items_minted: u32,
    /// Public mint price in lamports (0 = free).
    pub price_lamports: u64,
    /// Per-wallet public mint limit (0 = unlimited).
    pub mint_limit: u16,
    /// Unix timestamp when public minting starts (0 = no restriction).
    pub start_ts: i64,
    /// Whether the machine is paused.
    pub paused: bool,
    /// Optional whitelist phase config.
    pub whitelist: Option<WhitelistConfig>,
    /// PDA bump.
    pub bump: u8,
}

impl MintMachine {
    /// Base account size (without the dynamic items vec — stored via realloc).
    pub const BASE_LEN: usize =
        8           // discriminator
        + 32        // authority
        + 32        // treasury
        + 32        // machine_id
        + 64        // name
        + 200       // collection_uri
        + 4         // total_items
        + 4         // items_loaded
        + 4         // items_minted
        + 8         // price_lamports
        + 2         // mint_limit
        + 8         // start_ts
        + 1         // paused
        + 1         // Option discriminant for whitelist
        + 32 + 8 + 2 + 8 + 8  // WhitelistConfig fields (58 bytes)
        + 1         // bump
        + 4;        // Vec<ItemData> length prefix

    /// Total space needed for N items.
    pub fn space_for(n: u32) -> usize {
        Self::BASE_LEN + (n as usize) * ItemData::SIZE
    }

    pub fn machine_id_str(&self) -> &str {
        let end = self.machine_id.iter().position(|&b| b == 0).unwrap_or(32);
        std::str::from_utf8(&self.machine_id[..end]).unwrap_or("")
    }

    pub fn is_wl_active(&self, now: i64) -> bool {
        if let Some(wl) = &self.whitelist {
            if wl.merkle_root == [0u8; 32] { return false; }
            let started = wl.start_ts == 0 || now >= wl.start_ts;
            let not_ended = wl.end_ts == 0 || now < wl.end_ts;
            started && not_ended
        } else {
            false
        }
    }
}
