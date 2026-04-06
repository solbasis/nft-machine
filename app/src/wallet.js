/**
 * Wallet Standard discovery — no per-wallet adapters needed.
 * Phantom, Solflare, Backpack, etc. all auto-register via window.dispatchEvent.
 */
import { getWallets } from '@wallet-standard/app';

let _wallet = null;
let _account = null;
let _onChangeCallbacks = [];

export function onWalletChange(cb) {
  _onChangeCallbacks.push(cb);
}

function notify() {
  _onChangeCallbacks.forEach(cb => cb({ wallet: _wallet, account: _account }));
}

/** Return all Solana-compatible wallets discovered via Wallet Standard. */
export function getAvailableWallets() {
  const { get } = getWallets();
  return get().filter(w =>
    w.chains.some(c => c.startsWith('solana:'))
  );
}

/** Connect to a specific wallet by name (or first available). */
export async function connect(walletName) {
  const wallets = getAvailableWallets();
  const wallet = walletName
    ? wallets.find(w => w.name === walletName)
    : wallets[0];

  if (!wallet) throw new Error('No Solana wallet found. Install Phantom or Solflare.');

  const connectFeature = wallet.features['standard:connect'];
  if (!connectFeature) throw new Error(`${wallet.name} does not support standard:connect`);

  const { accounts } = await connectFeature.connect();
  if (!accounts.length) throw new Error('No accounts returned from wallet');

  _wallet = wallet;
  _account = accounts[0];
  notify();
  return { wallet: _wallet, account: _account };
}

export async function disconnect() {
  if (_wallet?.features['standard:disconnect']) {
    await _wallet.features['standard:disconnect'].disconnect();
  }
  _wallet = null;
  _account = null;
  notify();
}

export function getAccount() { return _account; }
export function getWallet()  { return _wallet; }

export function getPublicKeyString() {
  return _account?.address ?? null;
}

/** Sign and send a transaction using Wallet Standard signAndSendTransaction. */
export async function signAndSendTransaction(tx, options = {}) {
  if (!_wallet || !_account) throw new Error('Wallet not connected');

  const feature = _wallet.features['solana:signAndSendTransaction'];
  if (!feature) throw new Error('Wallet does not support signAndSendTransaction');

  const { signatures } = await feature.signAndSendTransaction(
    { account: _account, transaction: tx, chain: options.chain ?? 'solana:mainnet' },
    { ...options }
  );
  return signatures[0];
}

/** Sign a transaction (returns signed tx, doesn't send). */
export async function signTransaction(tx) {
  if (!_wallet || !_account) throw new Error('Wallet not connected');

  const feature = _wallet.features['solana:signTransaction'];
  if (!feature) throw new Error('Wallet does not support signTransaction');

  const { signedTransactions } = await feature.signTransaction({ account: _account, transaction: tx });
  return signedTransactions[0];
}

/** Sign a raw message (for auth, etc.). */
export async function signMessage(message) {
  if (!_wallet || !_account) throw new Error('Wallet not connected');

  const feature = _wallet.features['standard:signMessage'] ?? _wallet.features['solana:signMessage'];
  if (!feature) throw new Error('Wallet does not support signMessage');

  const encoded = typeof message === 'string' ? new TextEncoder().encode(message) : message;
  const { signedMessages } = await feature.signMessage({ account: _account, message: encoded });
  return signedMessages[0].signature;
}
