use anchor_lang::prelude::*;

#[error_code]
pub enum MintMachineError {
    #[msg("Machine is paused")]
    MachinePaused,
    #[msg("Machine is sold out")]
    SoldOut,
    #[msg("Items not fully loaded yet")]
    ItemsNotLoaded,
    #[msg("Invalid item index")]
    InvalidItemIndex,
    #[msg("Invalid payment amount")]
    InvalidPayment,
    #[msg("Invalid treasury address")]
    InvalidTreasury,
    #[msg("Mint limit reached for this wallet")]
    MintLimitReached,
    #[msg("Minting not started yet")]
    MintNotStarted,
    #[msg("Whitelist phase: not on allowlist")]
    NotOnWhitelist,
    #[msg("Invalid Merkle proof")]
    InvalidMerkleProof,
    #[msg("Machine ID too long (max 32 bytes)")]
    MachineIdTooLong,
    #[msg("Name too long (max 64 bytes)")]
    NameTooLong,
    #[msg("URI too long (max 200 bytes)")]
    UriTooLong,
    #[msg("No items to add")]
    NoItems,
    #[msg("Would exceed total supply")]
    ExceedsSupply,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid mint account")]
    InvalidMint,
    #[msg("Arithmetic overflow")]
    Overflow,
}
