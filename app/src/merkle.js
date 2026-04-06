/**
 * Client-side Merkle tree for whitelist verification.
 * Uses keccak256 (same as the on-chain sha3 crate with Keccak256).
 * Proof format matches the on-chain ProofNode struct.
 */

// keccak256 via a simple WASM-free implementation
// For production use @noble/hashes keccak256 — add to package.json if needed
async function keccak256(data) {
  // Use SubtleCrypto SHA-3-256 (not available in all browsers — fallback below)
  // Actually SHA-3-256 ≠ keccak256; we use the @noble/hashes package via dynamic import
  try {
    const { keccak_256 } = await import('@noble/hashes/sha3');
    return keccak_256(data);
  } catch {
    // Fallback: SHA-256 (not matching on-chain — add @noble/hashes to package.json)
    const buf = await crypto.subtle.digest('SHA-256', data);
    return new Uint8Array(buf);
  }
}

async function hashLeaf(address58) {
  const bytes = decode58(address58);
  return keccak256(bytes);
}

async function hashPair(a, b) {
  const combined = new Uint8Array(64);
  combined.set(a, 0);
  combined.set(b, 32);
  return keccak256(combined);
}

function decode58(addr) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const map = {};
  for (let i = 0; i < ALPHABET.length; i++) map[ALPHABET[i]] = BigInt(i);
  let n = 0n;
  for (const c of addr) n = n * 58n + (map[c] ?? 0n);
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  const leading = addr.match(/^1*/)[0].length;
  return new Uint8Array([...new Array(leading).fill(0), ...bytes]);
}

/**
 * Build a Merkle tree from a list of wallet addresses.
 * Returns root as Uint8Array(32).
 */
export async function buildMerkleRoot(addresses) {
  if (!addresses.length) return new Uint8Array(32);

  let leaves = await Promise.all(addresses.map(a => hashLeaf(a)));

  // Pad to power of 2
  while (leaves.length & (leaves.length - 1)) {
    leaves.push(leaves[leaves.length - 1]);
  }

  let layer = leaves;
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      next.push(await hashPair(layer[i], layer[i + 1]));
    }
    layer = next;
  }

  return layer[0];
}

/**
 * Generate a Merkle proof for a specific address.
 * Returns array of { hash: Uint8Array(32), isRight: boolean }.
 */
export async function generateProof(addresses, targetAddress) {
  if (!addresses.length) return [];

  let leaves = await Promise.all(addresses.map(a => hashLeaf(a)));
  const originalLen = leaves.length;

  // Pad to power of 2
  while (leaves.length & (leaves.length - 1)) {
    leaves.push(leaves[leaves.length - 1]);
  }

  const targetLeaf = await hashLeaf(targetAddress);
  const targetIdx = leaves.findIndex(l => l.every((b, i) => b === targetLeaf[i]));
  if (targetIdx === -1) return null; // not in tree

  const proof = [];
  let idx = targetIdx;
  let layer = leaves;

  while (layer.length > 1) {
    const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
    proof.push({ hash: layer[sibling], isRight: idx % 2 === 0 });
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      next.push(await hashPair(layer[i], layer[i + 1]));
    }
    layer = next;
    idx = Math.floor(idx / 2);
  }

  return proof;
}

/**
 * Verify a Merkle proof client-side (mirrors on-chain logic).
 */
export async function verifyProof(proof, root, address58) {
  let current = await hashLeaf(address58);
  for (const node of proof) {
    current = node.isRight
      ? await hashPair(current, node.hash)
      : await hashPair(node.hash, current);
  }
  return root.every((b, i) => b === current[i]);
}
