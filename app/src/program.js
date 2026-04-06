/**
 * Anchor program client for mint-machine using @solana/kit codecs.
 * No Metaplex, no web3.js — pure Kit.
 */
import {
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  getBase58Decoder,
  getBase58Encoder,
  createSolanaRpc,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  compileTransaction,
  getSignatureFromTransaction,
} from '@solana/kit';
import {
  getBytesEncoder,
  getStructEncoder,
  getU8Encoder,
  getU16Encoder,
  getU32Encoder,
  getU64Encoder,
  getI64Encoder,
  getBooleanEncoder,
  getUtf8Encoder,
  getOptionEncoder,
  getArrayEncoder,
} from '@solana/codecs';
import { getRpcUrl, currentNetwork } from './rpc.js';
import { getPublicKeyString, signTransaction } from './wallet.js';

// Program ID — update after `anchor deploy`
export const PROGRAM_ID = address('MintMach1neXXXXXXXXXXXXXXXXXXXXXXXXXXXXX1');

// Anchor discriminators (first 8 bytes of sha256("global:<instruction_name>"))
// Pre-computed — run `anchor idl parse` to verify or use Codama-generated client.
const DISCRIMINATORS = {
  initialize: new Uint8Array([175, 175, 109, 31, 13, 152, 155, 237]),
  add_items:  new Uint8Array([77,  53, 106, 49, 58, 110, 87,  113]),
  mint_nft:   new Uint8Array([211, 57, 6,  167, 15, 219, 35,   6]),
  withdraw:   new Uint8Array([183, 18, 70, 156, 148, 109, 161,  34]),
  set_paused: new Uint8Array([43,  77,  96, 214, 140, 78,  103, 203]),
};

function getRpc() {
  return createSolanaRpc(getRpcUrl());
}

/** Derive machine PDA. */
export async function getMachinePda(authority, machineId) {
  const authorityAddr = address(authority);
  const enc = getAddressEncoder();
  const [pda, bump] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [
      new Uint8Array([109, 97, 99, 104, 105, 110, 101]), // "machine"
      enc.encode(authorityAddr),
      new TextEncoder().encode(machineId),
    ],
  });
  return { pda, bump };
}

/** Derive mint-count PDA. */
export async function getMintCountPda(machineAddr, wallet) {
  const enc = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [
      new Uint8Array([99, 111, 117, 110, 116]), // "count"
      enc.encode(address(machineAddr)),
      enc.encode(address(wallet)),
    ],
  });
  return pda;
}

/** Build and send a transaction via the connected wallet. */
async function sendTx(instructions, signers = []) {
  const rpc = getRpc();
  const feePayer = address(getPublicKeyString());
  const { value: { blockhash, lastValidBlockHeight } } = await rpc.getLatestBlockhash().send();

  const chain = currentNetwork === 'mainnet' ? 'solana:mainnet' : 'solana:devnet';

  let tx = createTransactionMessage({ version: 0 });
  tx = setTransactionMessageFeePayer(feePayer, tx);
  tx = setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, tx);
  for (const ix of instructions) {
    tx = appendTransactionMessageInstruction(ix, tx);
  }

  const compiled = compileTransaction(tx);
  const signed = await signTransaction(compiled);
  const sig = await rpc.sendTransaction(signed, { encoding: 'base64' }).send();
  await rpc.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, { commitment: 'confirmed' }).send();
  return sig;
}

/** Compute budget instructions for reliable mainnet landing. */
function computeBudgetIxs(units = 200_000, microLamports = 10_000) {
  // SetComputeUnitLimit (program 11111...) — discriminator 0x02
  const limitData = new Uint8Array(5);
  limitData[0] = 2;
  new DataView(limitData.buffer).setUint32(1, units, true);

  // SetComputeUnitPrice — discriminator 0x03
  const priceData = new Uint8Array(9);
  priceData[0] = 3;
  new DataView(priceData.buffer).setBigUint64(1, BigInt(microLamports), true);

  const COMPUTE_BUDGET_PROGRAM = address('ComputeBudget111111111111111111111111111111');
  return [
    { programAddress: COMPUTE_BUDGET_PROGRAM, accounts: [], data: limitData },
    { programAddress: COMPUTE_BUDGET_PROGRAM, accounts: [], data: priceData },
  ];
}

/**
 * Initialize a new mint machine.
 */
export async function initializeMachine(args) {
  const { pda } = await getMachinePda(getPublicKeyString(), args.machineId);
  const authority = address(getPublicKeyString());

  // Encode args using Anchor Borsh layout
  const enc = encoderFor('initialize', args);

  const ix = {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: pda, role: 'writable' },
      { address: authority, role: 'writable_signer' },
      { address: address('11111111111111111111111111111111'), role: 'readonly' },
    ],
    data: enc,
  };

  return sendTx([...computeBudgetIxs(300_000), ix]);
}

/**
 * Add items to the machine in batches (max 10 per tx recommended).
 */
export async function addItemsBatch(machineAddr, items) {
  const authority = address(getPublicKeyString());

  const enc = encodeAddItems(items);

  const ix = {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: address(machineAddr), role: 'writable' },
      { address: authority, role: 'writable_signer' },
      { address: address('11111111111111111111111111111111'), role: 'readonly' },
    ],
    data: enc,
  };

  return sendTx([...computeBudgetIxs(200_000), ix]);
}

/**
 * Mint a single NFT from the machine.
 */
export async function mintNft(machineAddr, mintKeypair, wlProof = []) {
  const buyer = address(getPublicKeyString());
  const mintAddr = address(mintKeypair.address);
  const machineAcc = await fetchMachine(machineAddr);

  // Derive ATA
  const TOKEN_2022 = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  const ATA_PROG = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bv');
  const [tokenAccount] = await getProgramDerivedAddress({
    programAddress: ATA_PROG,
    seeds: [
      getAddressEncoder().encode(buyer),
      getAddressEncoder().encode(TOKEN_2022),
      getAddressEncoder().encode(mintAddr),
    ],
  });

  const [mintCountPda] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [
      new TextEncoder().encode('count'),
      getAddressEncoder().encode(address(machineAddr)),
      getAddressEncoder().encode(buyer),
    ],
  });

  const enc = encodeMintNft(machineAcc.itemsMinted, wlProof);

  const ix = {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: address(machineAddr), role: 'writable' },
      { address: mintAddr, role: 'writable_signer' },
      { address: tokenAccount, role: 'writable' },
      { address: mintCountPda, role: 'writable' },
      { address: address(machineAcc.treasury), role: 'writable' },
      { address: buyer, role: 'writable_signer' },
      { address: TOKEN_2022, role: 'readonly' },
      { address: ATA_PROG, role: 'readonly' },
      { address: address('11111111111111111111111111111111'), role: 'readonly' },
      { address: address('SysvarRent111111111111111111111111111111111'), role: 'readonly' },
    ],
    data: enc,
  };

  // mintKeypair must co-sign (fresh keypair from client)
  return sendTxWithExtraSigners([...computeBudgetIxs(400_000), ix], [mintKeypair]);
}

async function sendTxWithExtraSigners(instructions, extraSigners) {
  const rpc = getRpc();
  const feePayer = address(getPublicKeyString());
  const { value: { blockhash, lastValidBlockHeight } } = await rpc.getLatestBlockhash().send();

  let tx = createTransactionMessage({ version: 0 });
  tx = setTransactionMessageFeePayer(feePayer, tx);
  tx = setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, tx);
  for (const ix of instructions) {
    tx = appendTransactionMessageInstruction(ix, tx);
  }

  const compiled = compileTransaction(tx);

  // Sign with extra signers first, then wallet
  let signed = compiled;
  for (const kp of extraSigners) {
    signed = await kp.sign(signed);
  }
  signed = await signTransaction(signed);

  const sig = await rpc.sendTransaction(signed, { encoding: 'base64' }).send();
  await rpc.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, { commitment: 'confirmed' }).send();
  return sig;
}

/** Fetch MintMachine account data. */
export async function fetchMachine(machineAddr) {
  const rpc = getRpc();
  const { value } = await rpc.getAccountInfo(address(machineAddr), { encoding: 'base64' }).send();
  if (!value) throw new Error('Machine account not found');

  const raw = Buffer.from(value.data[0], 'base64');
  return decodeMachine(raw);
}

// ─── Encoding helpers ─────────────────────────────────────────────────────────

function writeStr(buf, offset, str, maxLen) {
  const bytes = new TextEncoder().encode(str);
  const len = Math.min(bytes.length, maxLen);
  new DataView(buf).setUint32(offset, len, true);
  new Uint8Array(buf, offset + 4, len).set(bytes.subarray(0, len));
  return offset + 4 + len;
}

function encoderFor(ixName, args) {
  const disc = DISCRIMINATORS[ixName];
  const parts = [disc];

  if (ixName === 'initialize') {
    parts.push(encodeInitialize(args));
  }

  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function encodeInitialize(args) {
  // machine_id (string), name (string), collection_uri (string),
  // total_items (u32), price_lamports (u64), mint_limit (u16),
  // start_ts (i64), treasury (Pubkey[32]), whitelist (Option<WL>)
  const buf = [];

  const pushStr = (s) => {
    const b = new TextEncoder().encode(s);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, b.length, true);
    buf.push(len, b);
  };
  const pushU16 = (v) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); buf.push(b); };
  const pushU32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); buf.push(b); };
  const pushU64 = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); buf.push(b); };
  const pushI64 = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(v), true); buf.push(b); };
  const pushKey = (addr) => { buf.push(getAddressEncoder().encode(address(addr))); };

  pushStr(args.machineId);
  pushStr(args.name);
  pushStr(args.collectionUri);
  pushU32(args.totalItems);
  pushU64(args.priceLamports ?? 0);
  pushU16(args.mintLimit ?? 0);
  pushI64(args.startTs ?? 0);
  pushKey(args.treasury);

  // Option<WhitelistConfig>
  if (args.whitelist) {
    buf.push(new Uint8Array([1]));
    buf.push(args.whitelist.merkleRoot); // [u8;32]
    pushU64(args.whitelist.priceLamports ?? 0);
    pushU16(args.whitelist.mintLimit ?? 0);
    pushI64(args.whitelist.startTs ?? 0);
    pushI64(args.whitelist.endTs ?? 0);
  } else {
    buf.push(new Uint8Array([0]));
  }

  const disc = DISCRIMINATORS['initialize'];
  const body = concatBuffers(buf);
  const out = new Uint8Array(disc.length + body.length);
  out.set(disc, 0);
  out.set(body, disc.length);
  return out;
}

function encodeAddItems(items) {
  const buf = [];
  const pushStr = (s) => {
    const b = new TextEncoder().encode(s);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, b.length, true);
    buf.push(len, b);
  };
  const pushU32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); buf.push(b); };

  pushU32(items.length);
  for (const item of items) {
    pushStr(item.name);
    pushStr(item.uri);
  }

  const disc = DISCRIMINATORS['add_items'];
  const body = concatBuffers(buf);
  const out = new Uint8Array(disc.length + body.length);
  out.set(disc, 0);
  out.set(body, disc.length);
  return out;
}

function encodeMintNft(itemIndex, wlProof) {
  const buf = [];
  const pushU32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); buf.push(b); };

  pushU32(itemIndex);
  pushU32(wlProof.length);
  for (const node of wlProof) {
    buf.push(node.hash);
    buf.push(new Uint8Array([node.isRight ? 1 : 0]));
  }

  const disc = DISCRIMINATORS['mint_nft'];
  const body = concatBuffers(buf);
  const out = new Uint8Array(disc.length + body.length);
  out.set(disc, 0);
  out.set(body, disc.length);
  return out;
}

function concatBuffers(parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Minimal MintMachine decoder for reading key fields. */
function decodeMachine(raw) {
  const view = new DataView(raw.buffer, raw.byteOffset);
  let off = 8; // skip discriminator

  const readKey = () => {
    const b = raw.slice(off, off + 32);
    off += 32;
    return getBase58Decoder().decode(b);
  };
  const readU32 = () => { const v = view.getUint32(off, true); off += 4; return v; };
  const readU64 = () => { const v = view.getBigUint64(off, true); off += 8; return Number(v); };
  const readI64 = () => { const v = view.getBigInt64(off, true); off += 8; return Number(v); };
  const readU16 = () => { const v = view.getUint16(off, true); off += 2; return v; };
  const readBool = () => { const v = raw[off] !== 0; off += 1; return v; };
  const readFixed = (len) => { const b = raw.slice(off, off + len); off += len; return b; };

  const authority = readKey();
  const treasury = readKey();
  off += 32; // machine_id
  off += 64; // name
  off += 200; // collection_uri
  const totalItems = readU32();
  const itemsLoaded = readU32();
  const itemsMinted = readU32();
  const priceLamports = readU64();
  const mintLimit = readU16();
  const startTs = readI64();
  const paused = readBool();

  return { authority, treasury, totalItems, itemsLoaded, itemsMinted, priceLamports, mintLimit, startTs, paused };
}
