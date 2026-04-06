# nft-machine

100% Solana Skills-compliant NFT deployer. No Metaplex. Token-2022 native.

## Stack
| Layer | Tech |
|---|---|
| NFT Standard | Token-2022 (MetadataPointer + TokenMetadata extensions) |
| Program | Anchor 0.31.1 + anchor-spl 0.31.1 |
| Client SDK | `@solana/kit` v2 |
| Wallet | Wallet Standard (`@wallet-standard/app`) — auto-discovers Phantom, Solflare, Backpack |
| Storage | Arweave via `@irys/web-upload-solana` |
| Whitelist | Keccak256 Merkle tree (on-chain: sha3 crate) |
| Frontend | Vanilla JS + Vite 5 |

## Program instructions
| Instruction | Description |
|---|---|
| `initialize` | Create MintMachine PDA with config |
| `add_items` | Load metadata URIs in batches (realloc) |
| `mint_nft` | Mint Token-2022 NFT, handle payment + Merkle WL |
| `withdraw` | Withdraw revenue to authority |
| `set_paused` | Pause/unpause minting |

## PDA seeds
- Machine: `["machine", authority, machine_id]`
- MintCount: `["count", machine, buyer]`

## Dev
```bash
# Build program
cd nft-machine && anchor build

# Deploy to devnet
anchor deploy --provider.cluster devnet

# Update PROGRAM_ID in app/src/program.js after first deploy

# Frontend
cd app && npm install && npm run dev
```

## After deploy
1. Run `anchor build` to get IDL at `target/idl/mint_machine.json`
2. Update `PROGRAM_ID` in `app/src/program.js`
3. Update `Anchor.toml` with real program ID
4. (Optional) Run Codama codegen for fully type-safe client: `npx @codama/cli generate --idl target/idl/mint_machine.json`

## Skill compliance
- ✅ `@solana/kit` — all RPC, transaction building
- ✅ Wallet Standard — `getWallets()` / `autoDiscover()` pattern
- ✅ Token-2022 — MetadataPointer + TokenMetadata extensions
- ✅ Anchor 0.31.1 — program framework
- ✅ `vite-plugin-node-polyfills` — correct Vite 5 polyfill approach
- ✅ Priority fees — `SetComputeUnitPrice` on all transactions
- ✅ No Metaplex, no web3.js v1
