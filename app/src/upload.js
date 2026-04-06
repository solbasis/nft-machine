/**
 * Arweave upload via @irys/web-upload-solana.
 * Uses the Wallet Standard-connected wallet's provider.
 */
import { WebUploader } from '@irys/web-upload';
import { WebSolana } from '@irys/web-upload-solana';
import { getWallet, getAccount } from './wallet.js';
import { currentNetwork } from './rpc.js';

const BATCH_SIZE = 10;
const STORAGE_KEY = 'nft-machine-upload-state';

function saveState(s) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {} }
function loadState() { try { const s = localStorage.getItem(STORAGE_KEY); return s ? JSON.parse(s) : null; } catch { return null; } }
export function clearState() { try { localStorage.removeItem(STORAGE_KEY); } catch {} }
export function getResumeState() { return loadState(); }

let _irys = null;

/** Get or create Irys uploader. Uses the Wallet Standard wallet provider. */
async function getIrys() {
  if (_irys) return _irys;

  const wallet = getWallet();
  const account = getAccount();
  if (!wallet || !account) throw new Error('Wallet not connected');

  // Irys needs a signer interface. We wrap the Wallet Standard signTransaction.
  // @irys/web-upload-solana accepts a wallet adapter-compatible object.
  const walletAdapter = {
    publicKey: { toBytes: () => decode58(account.address), toBase58: () => account.address, toString: () => account.address },
    signMessage: async (msg) => {
      const feature = wallet.features['standard:signMessage'] ?? wallet.features['solana:signMessage'];
      if (!feature) throw new Error('Wallet does not support signMessage');
      const { signedMessages } = await feature.signMessage({ account, message: msg });
      return signedMessages[0].signature;
    },
    signTransaction: async (tx) => {
      const feature = wallet.features['solana:signTransaction'];
      if (!feature) throw new Error('Wallet does not support signTransaction');
      const { signedTransactions } = await feature.signTransaction({ account, transaction: tx });
      return signedTransactions[0];
    },
  };

  const network = currentNetwork === 'mainnet' ? 'mainnet-beta' : 'devnet';
  _irys = await WebUploader(WebSolana).withProvider(walletAdapter).withRpc(network).build();
  return _irys;
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

/** Upload a single file, returns URI. */
export async function uploadFile(data, filename, contentType) {
  const irys = await getIrys();
  const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
  const receipt = await irys.upload(bytes, { tags: [{ name: 'Content-Type', value: contentType }, { name: 'filename', value: filename }] });
  return `https://gateway.irys.xyz/${receipt.id}`;
}

function bareFilename(path) {
  return path.includes('/') ? path.split('/').pop() : path;
}

function resolveImageUri(imageURIs, rawRef) {
  if (!rawRef) return '';
  if (imageURIs[rawRef]) return imageURIs[rawRef];
  const bare = bareFilename(rawRef);
  return imageURIs[bare] || '';
}

function getMime(ext) {
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext] ?? 'image/png';
}

/** Upload a full collection (images + metadata). Returns { imageURIs, metadataURIs }. */
export async function uploadCollection(collectionData, onProgress, onLog) {
  const { images, metadata } = collectionData;
  const imageEntries = Object.entries(images).sort((a, b) => a[0].localeCompare(b[0]));
  const metaEntries  = Object.entries(metadata).sort((a, b) => a[0].localeCompare(b[0]));
  const totalFiles   = imageEntries.length + metaEntries.length;

  let state = loadState();
  let imageURIs = {};
  let metadataURIs = {};

  if (state && state.totalFiles === totalFiles) {
    imageURIs    = state.imageURIs    || {};
    metadataURIs = state.metadataURIs || {};
    const done = Object.keys(imageURIs).length + Object.keys(metadataURIs).length;
    if (done > 0) onLog('Resuming — ' + done + ' files already uploaded', 'ok');
  }

  const irys = await getIrys();

  // Phase 1: Images
  const imgTodo = imageEntries.filter(([p]) => !imageURIs[bareFilename(p)]);
  if (imgTodo.length > 0) onLog('Uploading ' + imgTodo.length + ' images…', 'info');

  for (let i = 0; i < imgTodo.length; i += BATCH_SIZE) {
    const batch = imgTodo.slice(i, i + BATCH_SIZE);
    for (const [path, entry] of batch) {
      const fn = bareFilename(path);
      const ext = fn.split('.').pop().toLowerCase();
      const mime = getMime(ext);
      try {
        const buf = await entry.async('uint8array');
        const receipt = await irys.upload(buf, { tags: [{ name: 'Content-Type', value: mime }, { name: 'filename', value: fn }] });
        imageURIs[fn] = `https://gateway.irys.xyz/${receipt.id}`;
      } catch (e) {
        onLog('  Failed ' + fn + ': ' + e.message, 'err');
      }
    }
    onProgress(
      Object.keys(imageURIs).length + Object.keys(metadataURIs).length,
      totalFiles,
      'Images: ' + Object.keys(imageURIs).length + '/' + imageEntries.length
    );
    saveState({ totalFiles, imageURIs, metadataURIs });
  }
  if (imageEntries.length > 0) onLog('✓ ' + Object.keys(imageURIs).length + ' images uploaded', 'ok');

  // Phase 2: Metadata — patch image URIs
  const metaTodo = metaEntries.filter(([p]) => !metadataURIs[bareFilename(p)]);
  if (metaTodo.length > 0) onLog('Uploading ' + metaTodo.length + ' metadata files…', 'info');

  for (let i = 0; i < metaTodo.length; i += BATCH_SIZE) {
    const batch = metaTodo.slice(i, i + BATCH_SIZE);
    for (const [path, entry] of batch) {
      const fn = bareFilename(path);
      try {
        const text = await entry.async('text');
        const metaObj = JSON.parse(text);

        const resolvedImg = resolveImageUri(imageURIs, metaObj.image);
        if (resolvedImg) {
          metaObj.image = resolvedImg;
          if (metaObj.properties?.files?.[0]) metaObj.properties.files[0].uri = resolvedImg;
        } else if (metaObj.image) {
          onLog('  Warning: no URI found for image ref "' + metaObj.image + '" in ' + fn, 'warn');
        }

        const body = new TextEncoder().encode(JSON.stringify(metaObj, null, 2));
        const receipt = await irys.upload(body, { tags: [{ name: 'Content-Type', value: 'application/json' }, { name: 'filename', value: fn }] });
        metadataURIs[fn] = `https://gateway.irys.xyz/${receipt.id}`;
      } catch (e) {
        onLog('  Failed ' + fn + ': ' + e.message, 'err');
      }
    }
    onProgress(
      Object.keys(imageURIs).length + Object.keys(metadataURIs).length,
      totalFiles,
      'Metadata: ' + Object.keys(metadataURIs).length + '/' + metaEntries.length
    );
    saveState({ totalFiles, imageURIs, metadataURIs });
  }
  if (metaEntries.length > 0) onLog('✓ ' + Object.keys(metadataURIs).length + ' metadata uploaded', 'ok');

  clearState();
  return { imageURIs, metadataURIs };
}

/** Fund Irys node if balance is low. Returns current balance in SOL. */
export async function checkIrysBalance() {
  const irys = await getIrys();
  const balance = await irys.getLoadedBalance();
  return Number(balance) / 1e9; // convert lamports to SOL
}

export async function fundIrys(solAmount) {
  const irys = await getIrys();
  const lamports = BigInt(Math.floor(solAmount * 1e9));
  await irys.fund(lamports);
}
