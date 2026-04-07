/**
 * Anchor program client for mint-machine using @solana/kit.
 * No Metaplex, no web3.js — pure Kit.
 *
 * AFTER DEPLOYING THE PROGRAM:
 *  1. Run `anchor build && anchor keys sync`
 *  2. Replace PROGRAM_ID below with the real address
 *  3. Run `cd app && npm run deploy` to push updated frontend
 */
import {
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  getBase58Decoder,
  createSolanaRpc,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  compileTransaction,
  generateKeyPairSigner,
} from '@solana/kit';
import { getRpcUrl, currentNetwork } from './rpc.js';
import { getPublicKeyString, signTransaction } from './wallet.js';

// ─── Program ID ───────────────────────────────────────────────────────────────
// TODO: replace with real address after `anchor build && anchor keys sync`
export const PROGRAM_ID = address('11111111111111111111111111111112');

// ─── Anchor discriminators ────────────────────────────────────────────────────
// sha256("global:<ix_name>")[0..8]
// These are pre-computed. Verify against target/idl/mint_machine.json after build.
// To recompute: node -e "const c=require('crypto');const h=n=>c.createHash('sha256').update('global:'+n).digest();['initialize','add_items','mint_nft','withdraw','set_paused'].forEach(n=>console.log(n,[...h(n).slice(0,8)]))"
const DISCRIMINATORS = {
  initialize: new Uint8Array([175, 175, 109,  31,  13, 152, 155, 237]),
  add_items:  new Uint8Array([ 77,  53, 106,  49,  58, 110,  87, 113]),
  mint_nft:   new Uint8Array([211,  57,   6, 167,  15, 219,  35,   6]),
  withdraw:   new Uint8Array([183,  18,  70, 156, 148, 109, 161,  34]),
  set_paused: new Uint8Array([ 43,  77,  96, 214, 140,  78, 103, 203]),
};

function getRpc() {
  return createSolanaRpc(getRpcUrl());
}

// ─── PDA derivation ───────────────────────────────────────────────────────────

/** Derive machine PDA: seeds = ["machine", authority, machine_id] */
export async function getMachinePda(authority, machineId) {
  const enc = getAddressEncoder();
  const [pda, bump] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [
      new TextEncoder().encode('machine'),
      enc.encode(address(authority)),
      new TextEncoder().encode(machineId),
    ],
  });
  return { pda, bump };
}

/** Derive mint-count PDA: seeds = ["count", machine, wallet] */
export async function getMintCountPda(machineAddr, wallet) {
  const enc = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [
      new TextEncoder().encode('count'),
      enc.encode(address(machineAddr)),
      enc.encode(address(wallet)),
    ],
  });
  return pda;
}

// ─── Transaction helpers ──────────────────────────────────────────────────────

function getChain() {
  return currentNetwork === 'mainnet' ? 'solana:mainnet' : 'solana:devnet';
}

async function buildAndSend(instructions, extraSigners = []) {
  const rpc = getRpc();
  const feePayer = address(getPublicKeyString());
  const { value: { blockhash, lastValidBlockHeight } } =
    await rpc.getLatestBlockhash().send();

  let tx = createTransactionMessage({ version: 0 });
  tx = setTransactionMessageFeePayer(feePayer, tx);
  tx = setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, tx);
  for (const ix of instructions) {
    tx = appendTransactionMessageInstruction(ix, tx);
  }

  const compiled = compileTransaction(tx);

  // Sign with any extra keypairs (e.g. fresh mint account), then wallet
  let signed = compiled;
  for (const signer of extraSigners) {
    signed = await signer.signTransaction(signed);
  }
  signed = await signTransaction(signed);

  const sig = await rpc.sendTransaction(signed, { encoding: 'base64' }).send();
  await rpc
    .confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, { commitment: 'confirmed' })
    .send();
  return sig;
}

/** Compute budget instructions — always include on mainnet. */
function computeBudgetIxs(units = 200_000, microLamports = 10_000) {
  const CB = address('ComputeBudget111111111111111111111111111111');

  const limitData = new Uint8Array(5);
  limitData[0] = 2;
  new DataView(limitData.buffer).setUint32(1, units, true);

  const priceData = new Uint8Array(9);
  priceData[0] = 3;
  new DataView(priceData.buffer).setBigUint64(1, BigInt(microLamports), true);

  return [
    { programAddress: CB, accounts: [], data: limitData },
    { programAddress: CB, accounts: [], data: priceData },
  ];
}

// ─── Borsh encoding helpers ───────────────────────────────────────────────────

function concatU8(...parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function encStr(s) {
  const b = new TextEncoder().encode(s);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, b.length, true);
  return concatU8(len, b);
}

function encU8(v)  { return new Uint8Array([v]); }
function encU16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return b; }
function encU32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; }
function encU64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); return b; }
function encI64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(v), true); return b; }
function encKey(a) { return getAddressEncoder().encode(address(a)); }

// ─── Instruction encoders ─────────────────────────────────────────────────────

function encodeInitialize(args) {
  const body = concatU8(
    encStr(args.machineId),
    encStr(args.name),
    encStr(args.collectionUri),
    encU32(args.totalItems),
    encU64(args.priceLamports ?? 0),
    encU16(args.mintLimit ?? 0),
    encI64(args.startTs ?? 0),
    encKey(args.treasury),
    // Option<WhitelistConfigArgs>
    args.whitelist
      ? concatU8(
          encU8(1),
          args.whitelist.merkleRoot,          // [u8;32]
          encU64(args.whitelist.priceLamports ?? 0),
          encU16(args.whitelist.mintLimit ?? 0),
          encI64(args.whitelist.startTs ?? 0),
          encI64(args.whitelist.endTs ?? 0),
        )
      : encU8(0),
  );
  return concatU8(DISCRIMINATORS.initialize, body);
}

function encodeAddItems(items) {
  const body = concatU8(
    encU32(items.length),
    ...items.flatMap(item => [encStr(item.name), encStr(item.uri)]),
  );
  return concatU8(DISCRIMINATORS.add_items, body);
}

function encodeMintNft(machineId, itemIndex, wlProof) {
  const proofBytes = concatU8(
    encU32(wlProof.length),
    ...wlProof.flatMap(node => [node.hash, encU8(node.isRight ? 1 : 0)]),
  );
  const body = concatU8(
    encStr(machineId),
    encU32(itemIndex),
    proofBytes,
  );
  return concatU8(DISCRIMINATORS.mint_nft, body);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Initialize a new mint machine on-chain. */
export async function initializeMachine(args) {
  const { pda } = await getMachinePda(getPublicKeyString(), args.machineId);
  const authority = address(getPublicKeyString());

  const ix = {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: pda,                                           role: 'writable' },
      { address: authority,                                     role: 'writable_signer' },
      { address: address('11111111111111111111111111111111'),   role: 'readonly' },
    ],
    data: encodeInitialize(args),
  };

  return buildAndSend([...computeBudgetIxs(300_000), ix]);
}

/** Add items to the machine in batches. Recommended: max 10 items per call. */
export async function addItemsBatch(machineAddr, items) {
  const authority = address(getPublicKeyString());

  const ix = {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: address(machineAddr), role: 'writable' },
      { address: authority,            role: 'writable_signer' },
      { address: address('11111111111111111111111111111111'), role: 'readonly' },
    ],
    data: encodeAddItems(items),
  };

  return buildAndSend([...computeBudgetIxs(200_000), ix]);
}

/** Mint a single NFT from the machine. Generates a fresh mint keypair internally. */
export async function mintNft(machineAddr, machineId, wlProof = []) {
  const buyer = address(getPublicKeyString());

  // Generate fresh mint keypair — must be a brand-new account
  const mintSigner = await generateKeyPairSigner();
  const mintAddr   = mintSigner.address;

  // Fetch machine state to get items_minted
  const machineData = await fetchMachine(machineAddr);

  // Derive buyer's ATA
  const TOKEN_2022 = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  const ATA_PROG   = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bv');

  const enc = getAddressEncoder();
  const [tokenAccount] = await getProgramDerivedAddress({
    programAddress: ATA_PROG,
    seeds: [
      enc.encode(buyer),
      enc.encode(TOKEN_2022),
      enc.encode(mintAddr),
    ],
  });

  const mintCountPda = await getMintCountPda(machineAddr, buyer);

  const ix = {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: address(machineAddr),                                  role: 'writable' },
      { address: mintAddr,                                              role: 'writable_signer' },
      { address: tokenAccount,                                          role: 'writable' },
      { address: mintCountPda,                                          role: 'writable' },
      { address: address(machineData.treasury),                        role: 'writable' },
      { address: buyer,                                                  role: 'writable_signer' },
      { address: TOKEN_2022,                                            role: 'readonly' },
      { address: ATA_PROG,                                              role: 'readonly' },
      { address: address('11111111111111111111111111111111'),           role: 'readonly' },
      { address: address('SysvarRent111111111111111111111111111111111'), role: 'readonly' },
    ],
    data: encodeMintNft(machineId, machineData.itemsMinted, wlProof),
  };

  // mintSigner co-signs (fresh mint keypair), wallet signs as buyer
  return buildAndSend([...computeBudgetIxs(400_000), ix], [mintSigner]);
}

/** Fetch and decode MintMachine account. */
export async function fetchMachine(machineAddr) {
  const rpc = getRpc();
  const { value } = await rpc
    .getAccountInfo(address(machineAddr), { encoding: 'base64' })
    .send();
  if (!value) throw new Error('Machine account not found: ' + machineAddr);

  const raw = Buffer.from(value.data[0], 'base64');
  return decodeMachine(raw);
}

// ─── Decoder ─────────────────────────────────────────────────────────────────

function decodeMachine(raw) {
  const view = new DataView(raw.buffer, raw.byteOffset);
  let off = 8; // skip discriminator

  const dec = getBase58Decoder();
  const readKey  = () => { const b = raw.slice(off, off + 32); off += 32; return dec.decode(b); };
  const readU16  = () => { const v = view.getUint16(off, true); off += 2; return v; };
  const readU32  = () => { const v = view.getUint32(off, true); off += 4; return v; };
  const readU64  = () => { const v = view.getBigUint64(off, true); off += 8; return Number(v); };
  const readI64  = () => { const v = view.getBigInt64(off, true);  off += 8; return Number(v); };
  const readBool = () => { const v = raw[off] !== 0; off += 1; return v; };
  const skip     = (n) => { off += n; };

  const authority      = readKey();
  const treasury       = readKey();
  skip(32);              // machine_id
  skip(64);              // name
  skip(200);             // collection_uri
  const totalItems     = readU32();
  const itemsLoaded    = readU32();
  const itemsMinted    = readU32();
  const priceLamports  = readU64();
  const mintLimit      = readU16();
  const startTs        = readI64();
  const paused         = readBool();
  // whitelist: always 58 bytes (WhitelistConfig::SIZE)
  const merkleRoot     = raw.slice(off, off + 32); off += 32;
  const wlPrice        = readU64();
  const wlMintLimit    = readU16();
  const wlStartTs      = readI64();
  const wlEndTs        = readI64();
  const bump           = raw[off];

  const hasWhitelist = merkleRoot.some(b => b !== 0);

  return {
    authority, treasury, totalItems, itemsLoaded, itemsMinted,
    priceLamports, mintLimit, startTs, paused, bump,
    whitelist: hasWhitelist
      ? { merkleRoot, priceLamports: wlPrice, mintLimit: wlMintLimit, startTs: wlStartTs, endTs: wlEndTs }
      : null,
  };
}
