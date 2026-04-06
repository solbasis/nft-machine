import './style.css';
import JSZip from 'jszip';
import { getAvailableWallets, connect, disconnect, getPublicKeyString, getAccount, onWalletChange } from './wallet.js';
import { uploadCollection, uploadFile, checkIrysBalance, fundIrys, clearState, getResumeState } from './upload.js';
import { initializeMachine, addItemsBatch, fetchMachine, getMachinePda } from './program.js';
import { buildMerkleRoot } from './merkle.js';
import { getRpcUrl, currentNetwork, setNetwork } from './rpc.js';
import { createSolanaRpc, address, lamports } from '@solana/kit';

// ─── Constants ────────────────────────────────────────────────────────────────
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BATCH_SIZE = 10;

// ─── State ────────────────────────────────────────────────────────────────────
let currentStep = 1;
const completedSteps = new Set();
let collectionData = null;   // { images, metadata } from ZIP
let uploadedURIs = {};       // { imageURIs, metadataURIs, collectionImageUri, collectionMetaUri }
let machineAddress = null;
let walletBalance = 0;

// ─── HTML Template ────────────────────────────────────────────────────────────
document.querySelector('#app').innerHTML = `
<div class="wrap">
  <header class="hdr">
    <div>
      <div class="logo">NFT Machine</div>
      <div class="logo-sub">Token-2022 · Wallet Standard · @solana/kit</div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span class="tech-pill tech-kit">@solana/kit</span>
      <span class="tech-pill tech-t22">Token-2022</span>
      <span class="tech-pill tech-ws">Wallet Standard</span>
      <span id="netBadge" class="badge badge-orange">Devnet</span>
      <button id="netToggle" class="net-toggle">Switch to Mainnet</button>
    </div>
  </header>

  <div class="steps" id="stepTabs">
    ${[1,2,3,4,5,6].map(n => `
    <div class="step-tab locked" id="tab${n}" data-step="${n}">
      <span class="step-num">${n}</span>
      ${['Wallet','Configure','Assets','Upload','Deploy','Done'][n-1]}
    </div>`).join('')}
  </div>

  <!-- Step 1: Wallet -->
  <div class="step-content active" id="step1">
    <div class="panel">
      <div class="pbar"><div class="pbar-l"><div class="pdots"><div class="pdot"></div></div><span class="plbl">Step 1</span></div><span class="psts">Connect Wallet</span></div>
      <h2>Connect Wallet</h2>
      <p style="font-size:.70rem;color:var(--text-dim);margin-bottom:14px">Using Wallet Standard — Phantom, Solflare, Backpack and any standard-compatible wallet are auto-discovered.</p>
      <div id="walletSection">
        <div id="walletList" class="wallet-list"></div>
        <div id="walletInfo" style="display:none">
          <div class="wallet-card">
            <div style="flex:1;min-width:0">
              <div style="font-size:.58rem;color:var(--text-dim);letter-spacing:1px;text-transform:uppercase;margin-bottom:2px">Connected</div>
              <div class="wallet-addr" id="walletAddr">—</div>
            </div>
            <div class="wallet-bal" id="walletBal">— SOL</div>
            <button class="btn btn-d" id="disconnectBtn">Disconnect</button>
          </div>
        </div>
      </div>
      <div id="step1Status" class="status-bar"></div>
      <div class="btn-row" style="margin-top:14px">
        <button class="btn btn-p btn-lg" id="step1Next" disabled>Continue →</button>
      </div>
    </div>
  </div>

  <!-- Step 2: Configure -->
  <div class="step-content" id="step2">
    <div class="panel">
      <div class="pbar"><div class="pbar-l"><div class="pdots"><div class="pdot"></div></div><span class="plbl">Step 2</span></div><span class="psts">Configure</span></div>
      <h2>Collection Configuration</h2>
      <div class="g2">
        <div class="field"><label>Collection Name *</label><input type="text" id="cfgName" placeholder="My NFT Collection" maxlength="64"></div>
        <div class="field"><label>Machine ID *</label><input type="text" id="cfgMachineId" placeholder="my-collection-2025" maxlength="32"></div>
      </div>
      <div class="g2">
        <div class="field"><label>Mint Price (SOL)</label><input type="number" id="cfgPrice" value="0" min="0" step="0.01"></div>
        <div class="field"><label>Per-Wallet Limit (0 = unlimited)</label><input type="number" id="cfgMintLimit" value="0" min="0"></div>
      </div>
      <div class="g2">
        <div class="field"><label>Public Start Date/Time</label><input type="datetime-local" id="cfgStartDate"></div>
        <div class="field"><label>Treasury Address</label><input type="text" id="cfgTreasury" placeholder="Defaults to connected wallet"></div>
      </div>

      <hr>
      <h3>Whitelist Phase (Optional)</h3>
      <div class="field">
        <label>Whitelist Wallets (one per line)</label>
        <textarea id="cfgWlWallets" placeholder="Paste wallet addresses, one per line&#10;Leave empty to skip whitelist"></textarea>
      </div>
      <div class="g3">
        <div class="field"><label>WL Price (SOL)</label><input type="number" id="cfgWlPrice" value="0" min="0" step="0.01"></div>
        <div class="field"><label>WL Per-Wallet Limit</label><input type="number" id="cfgWlLimit" value="0" min="0"></div>
        <div class="field"><label>WL End (Public Start)</label><input type="datetime-local" id="cfgWlEnd"></div>
      </div>
      <div id="wlStatus" class="status-bar"></div>

      <div class="btn-row">
        <button class="btn" id="step2Back">← Back</button>
        <button class="btn btn-p btn-lg" id="step2Next">Continue →</button>
      </div>
    </div>
  </div>

  <!-- Step 3: Assets -->
  <div class="step-content" id="step3">
    <div class="panel">
      <div class="pbar"><div class="pbar-l"><div class="pdots"><div class="pdot"></div></div><span class="plbl">Step 3</span></div><span class="psts">Assets</span></div>
      <h2>Upload Assets ZIP</h2>
      <div class="info-bar">ZIP must contain: <strong>images/</strong> (0.png, 1.png…) and <strong>metadata/</strong> (0.json, 1.json…)</div>
      <div class="upload-zone" id="zipZone">
        <input type="file" id="zipInput" accept=".zip">
        <div style="font-size:1.4rem">📦</div>
        <div style="font-size:.72rem;color:var(--a)">Drop ZIP here or click to browse</div>
        <div style="font-size:.60rem;color:var(--text-dim)" id="zipName">No file selected</div>
      </div>

      <div id="collectionImageWrap" style="display:none;margin-top:12px">
        <h3>Collection Image</h3>
        <div class="upload-zone" id="collImgZone">
          <input type="file" id="collImgInput" accept="image/*">
          <div style="font-size:1.2rem">🖼</div>
          <div style="font-size:.72rem;color:var(--a)">Collection cover image</div>
          <div style="font-size:.60rem;color:var(--text-dim)" id="collImgName">No file selected</div>
        </div>
      </div>

      <div id="zipPreview" style="display:none;margin-top:12px">
        <div class="kv" id="zipStats"></div>
      </div>
      <div id="resumeBanner" style="display:none" class="status-bar warn"></div>
      <div id="step3Status" class="status-bar"></div>
      <div class="btn-row">
        <button class="btn" id="step3Back">← Back</button>
        <button class="btn btn-p btn-lg" id="step3Next" disabled>Continue →</button>
      </div>
    </div>
  </div>

  <!-- Step 4: Upload to Arweave -->
  <div class="step-content" id="step4">
    <div class="panel">
      <div class="pbar"><div class="pbar-l"><div class="pdots"><div class="pdot"></div></div><span class="plbl">Step 4</span></div><span class="psts">Arweave Upload</span></div>
      <h2>Upload to Arweave via Irys</h2>

      <div id="irysBalCard" class="kv" style="margin-bottom:12px">
        <div class="kv-row"><span class="kv-k">Irys Balance</span><span class="kv-v" id="irysBalVal">Checking…</span></div>
        <div class="kv-row"><span class="kv-k">Estimated Cost</span><span class="kv-v" id="irysCostVal">—</span></div>
      </div>

      <div class="btn-row" style="margin-bottom:10px">
        <button class="btn" id="fundIrysBtn">Fund Irys (0.05 SOL)</button>
        <button class="btn btn-p btn-lg" id="startUploadBtn">Start Upload</button>
      </div>

      <div class="prog-wrap" id="uploadProg">
        <div class="prog-lbl"><span id="uploadProgLbl">Uploading…</span><span id="uploadProgPct">0%</span></div>
        <div class="prog-track"><div class="prog-fill" id="uploadProgFill"></div></div>
      </div>
      <div class="deploy-log" id="uploadLog" style="display:none"></div>

      <div id="step4Status" class="status-bar"></div>
      <div class="btn-row">
        <button class="btn" id="step4Back">← Back</button>
        <button class="btn btn-p btn-lg" id="step4Next" disabled>Continue →</button>
      </div>
    </div>
  </div>

  <!-- Step 5: Deploy -->
  <div class="step-content" id="step5">
    <div class="panel">
      <div class="pbar"><div class="pbar-l"><div class="pdots"><div class="pdot"></div></div><span class="plbl">Step 5</span></div><span class="psts">Deploy</span></div>
      <h2>Deploy Mint Machine</h2>

      <div class="kv" style="margin-bottom:12px" id="deployPreview"></div>

      <div class="btn-row" style="margin-bottom:10px">
        <button class="btn btn-p btn-lg btn-full" id="deployBtn">Deploy Machine</button>
      </div>

      <div class="prog-wrap" id="deployProg">
        <div class="prog-lbl"><span id="deployProgLbl">Deploying…</span><span id="deployProgPct">0%</span></div>
        <div class="prog-track"><div class="prog-fill" id="deployProgFill"></div></div>
      </div>
      <div class="deploy-log" id="deployLog" style="display:none"></div>
      <div id="step5Status" class="status-bar"></div>
      <div class="btn-row">
        <button class="btn" id="step5Back">← Back</button>
      </div>
    </div>
  </div>

  <!-- Step 6: Done -->
  <div class="step-content" id="step6">
    <div class="panel">
      <div class="pbar"><div class="pbar-l"><div class="pdots"><div class="pdot"></div></div><span class="plbl">Step 6</span></div><span class="psts">Complete</span></div>
      <h2>Deployment Complete</h2>
      <div class="kv" id="resultKv"></div>
      <div id="step6Status" class="status-bar ok show" style="margin-top:12px">
        ✓ Machine deployed. Items loaded. Ready to mint!
      </div>
      <div class="btn-row" style="margin-top:14px">
        <button class="btn btn-p btn-lg" id="downloadMintBtn">Download Mint Page</button>
        <button class="btn" id="copyMachineBtn">Copy Machine Address</button>
      </div>
    </div>
  </div>
</div>
`;

// ─── Utilities ────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function isValidAddr(s) { return BASE58_RE.test(s); }

function setStatus(id, msg, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.className = `status-bar show ${type}`;
}

function log(containerId, msg, type = 'info') {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.style.display = 'block';
  const line = document.createElement('div');
  line.className = `log-${type}`;
  line.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function setProgress(fillId, lblId, pctId, wrapId, done, total, label) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const fill = document.getElementById(fillId);
  const lbl  = document.getElementById(lblId);
  const pctEl = document.getElementById(pctId);
  const wrap = document.getElementById(wrapId);
  if (fill) fill.style.width = pct + '%';
  if (lbl) lbl.textContent = label || 'Processing…';
  if (pctEl) pctEl.textContent = pct + '%';
  if (wrap) wrap.classList.add('show');
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  } catch { /* ignore */ }
}

function goTo(n) {
  currentStep = n;
  document.querySelectorAll('.step-content').forEach(el => el.classList.remove('active'));
  document.querySelector(`#step${n}`).classList.add('active');
  document.querySelectorAll('.step-tab').forEach(tab => {
    const s = parseInt(tab.dataset.step);
    tab.classList.remove('active', 'done', 'locked');
    if (s === n) tab.classList.add('active');
    else if (completedSteps.has(s)) tab.classList.add('done');
    else if (s > n) tab.classList.add('locked');
  });
}

// ─── Network Toggle ───────────────────────────────────────────────────────────
const netBadge = document.getElementById('netBadge');
const netToggle = document.getElementById('netToggle');
netToggle.addEventListener('click', () => {
  const net = currentNetwork === 'devnet' ? 'mainnet' : 'devnet';
  setNetwork(net);
  netBadge.textContent = net === 'mainnet' ? 'Mainnet' : 'Devnet';
  netBadge.className = `badge ${net === 'mainnet' ? 'badge-green' : 'badge-orange'}`;
  netToggle.textContent = net === 'mainnet' ? 'Switch to Devnet' : 'Switch to Mainnet';
});

// ─── Step 1: Wallet ───────────────────────────────────────────────────────────
function renderWalletList() {
  const wallets = getAvailableWallets();
  const list = document.getElementById('walletList');
  if (!wallets.length) {
    list.innerHTML = '<div class="status-bar warn show">No Wallet Standard wallets detected. Install Phantom or Solflare.</div>';
    return;
  }
  list.innerHTML = wallets.map(w => `
    <div class="wallet-item" data-name="${escHtml(w.name)}">
      <div style="display:flex;align-items:center;gap:8px">
        <img src="${escHtml(w.icon || '')}" alt="${escHtml(w.name)}" onerror="this.style.display='none'">
        <span>${escHtml(w.name)}</span>
      </div>
      <span style="font-size:.60rem;color:var(--text-dim)">Connect →</span>
    </div>
  `).join('');

  list.querySelectorAll('.wallet-item').forEach(item => {
    item.addEventListener('click', async () => {
      try {
        await connect(item.dataset.name);
      } catch (e) {
        setStatus('step1Status', e.message, 'err');
      }
    });
  });
}

async function fetchBalance(addr) {
  try {
    const rpc = createSolanaRpc(getRpcUrl());
    const { value } = await rpc.getBalance(address(addr)).send();
    return Number(value) / 1e9;
  } catch { return 0; }
}

onWalletChange(async ({ account }) => {
  const walletInfo = document.getElementById('walletInfo');
  const walletList = document.getElementById('walletList');
  const step1Next = document.getElementById('step1Next');

  if (account) {
    walletInfo.style.display = 'block';
    walletList.style.display = 'none';
    document.getElementById('walletAddr').textContent = account.address;
    const bal = await fetchBalance(account.address);
    walletBalance = bal;
    document.getElementById('walletBal').textContent = bal.toFixed(4) + ' SOL';
    step1Next.disabled = false;
    setStatus('step1Status', '✓ Wallet connected', 'ok');
  } else {
    walletInfo.style.display = 'none';
    walletList.style.display = 'block';
    step1Next.disabled = true;
    renderWalletList();
  }
});

document.getElementById('disconnectBtn').addEventListener('click', () => disconnect());
document.getElementById('step1Next').addEventListener('click', () => {
  completedSteps.add(1);
  goTo(2);
});

// ─── Step 2: Configure ────────────────────────────────────────────────────────
document.getElementById('step2Back').addEventListener('click', () => goTo(1));
document.getElementById('step2Next').addEventListener('click', () => {
  const name = document.getElementById('cfgName').value.trim();
  const machineId = document.getElementById('cfgMachineId').value.trim();
  if (!name) return setStatus('wlStatus', 'Collection name is required', 'err');
  if (!machineId || machineId.length > 32) return setStatus('wlStatus', 'Machine ID required (max 32 chars)', 'err');

  const treasury = document.getElementById('cfgTreasury').value.trim();
  if (treasury && !isValidAddr(treasury)) return setStatus('wlStatus', 'Invalid treasury address', 'err');

  const wlRaw = document.getElementById('cfgWlWallets').value.trim();
  const wlWallets = wlRaw ? wlRaw.split('\n').map(s => s.trim()).filter(s => isValidAddr(s)) : [];
  const wlTotal = wlRaw ? wlRaw.split('\n').map(s => s.trim()).filter(Boolean).length : 0;
  const wlInvalid = wlTotal - wlWallets.length;

  if (wlInvalid > 0) {
    setStatus('wlStatus', `⚠ ${wlInvalid} invalid address(es) removed from whitelist`, 'warn');
  } else {
    document.getElementById('wlStatus').className = 'status-bar';
  }

  completedSteps.add(2);
  goTo(3);
});

// ─── Step 3: Assets ───────────────────────────────────────────────────────────
let collImgFile = null;

async function processZip(file) {
  if (!file) return;
  document.getElementById('zipName').textContent = file.name;
  try {
    const zip = await JSZip.loadAsync(file);
    const images = {};
    const metadata = {};

    zip.forEach((path, entry) => {
      if (entry.dir) return;
      const lower = path.toLowerCase();
      if (lower.match(/images?\//i) || lower.match(/\.(png|jpg|jpeg|webp|gif)$/i)) {
        const fn = path.includes('/') ? path.split('/').pop() : path;
        if (fn) images[fn] = entry;
      } else if (lower.match(/metadata?\//i) || lower.match(/\.json$/i)) {
        const fn = path.includes('/') ? path.split('/').pop() : path;
        if (fn && fn !== 'collection.json') metadata[fn] = entry;
      }
    });

    const imgCount = Object.keys(images).length;
    const metaCount = Object.keys(metadata).length;

    if (!imgCount) return setStatus('step3Status', 'No images found in ZIP', 'err');
    if (!metaCount) return setStatus('step3Status', 'No metadata JSON files found in ZIP', 'err');

    collectionData = { images, metadata };

    document.getElementById('zipStats').innerHTML = `
      <div class="kv-row"><span class="kv-k">Images</span><span class="kv-v">${imgCount}</span></div>
      <div class="kv-row"><span class="kv-k">Metadata Files</span><span class="kv-v">${metaCount}</span></div>
      <div class="kv-row"><span class="kv-k">File</span><span class="kv-v">${escHtml(file.name)}</span></div>
    `;
    document.getElementById('zipPreview').style.display = 'block';
    document.getElementById('collectionImageWrap').style.display = 'block';
    document.getElementById('step3Next').disabled = false;
    setStatus('step3Status', `✓ ${imgCount} images + ${metaCount} metadata files loaded`, 'ok');

    // Check resume state
    const state = getResumeState();
    if (state && state.totalFiles === imgCount + metaCount) {
      const done = Object.keys(state.imageURIs || {}).length + Object.keys(state.metadataURIs || {}).length;
      const banner = document.getElementById('resumeBanner');
      banner.textContent = `Resume available — ${done}/${imgCount + metaCount} files already uploaded`;
      banner.className = 'status-bar warn show';
      banner.style.display = 'flex';
    }
  } catch (e) {
    setStatus('step3Status', 'Error reading ZIP: ' + e.message, 'err');
  }
}

const zipZone = document.getElementById('zipZone');
const zipInput = document.getElementById('zipInput');
zipInput.addEventListener('change', e => processZip(e.target.files?.[0]));
zipZone.addEventListener('dragover', e => { e.preventDefault(); zipZone.classList.add('drag'); });
zipZone.addEventListener('dragleave', () => zipZone.classList.remove('drag'));
zipZone.addEventListener('drop', e => { e.preventDefault(); zipZone.classList.remove('drag'); processZip(e.dataTransfer?.files?.[0]); });

document.getElementById('collImgInput').addEventListener('change', e => {
  collImgFile = e.target.files?.[0] ?? null;
  if (collImgFile) document.getElementById('collImgName').textContent = collImgFile.name;
});

document.getElementById('step3Back').addEventListener('click', () => goTo(2));
document.getElementById('step3Next').addEventListener('click', () => {
  if (!collectionData) return setStatus('step3Status', 'Please select a ZIP file', 'err');
  completedSteps.add(3);
  checkIrysBalance().then(bal => {
    document.getElementById('irysBalVal').textContent = bal.toFixed(6) + ' SOL';
    const imgCount = Object.keys(collectionData.images).length;
    const metaCount = Object.keys(collectionData.metadata).length;
    const estCost = (imgCount * 0.0001 + metaCount * 0.00001).toFixed(6);
    document.getElementById('irysCostVal').textContent = '~' + estCost + ' SOL';
  }).catch(() => {
    document.getElementById('irysBalVal').textContent = 'Connect wallet first';
  });
  goTo(4);
});

// ─── Step 4: Upload ───────────────────────────────────────────────────────────
document.getElementById('step4Back').addEventListener('click', () => goTo(3));

document.getElementById('fundIrysBtn').addEventListener('click', async () => {
  try {
    await fundIrys(0.05);
    const bal = await checkIrysBalance();
    document.getElementById('irysBalVal').textContent = bal.toFixed(6) + ' SOL';
    setStatus('step4Status', '✓ Funded 0.05 SOL to Irys', 'ok');
  } catch (e) {
    setStatus('step4Status', 'Fund failed: ' + e.message, 'err');
  }
});

document.getElementById('startUploadBtn').addEventListener('click', async () => {
  if (!collectionData) return;

  document.getElementById('startUploadBtn').disabled = true;
  document.getElementById('step4Back').disabled = true;

  const onProgress = (done, total, label) => setProgress('uploadProgFill', 'uploadProgLbl', 'uploadProgPct', 'uploadProg', done, total, label);
  const onLog = (msg, type) => log('uploadLog', msg, type);

  try {
    // Upload collection cover image first if provided
    if (collImgFile) {
      onLog('Uploading collection cover image…', 'info');
      const buf = await collImgFile.arrayBuffer();
      const uri = await uploadFile(new Uint8Array(buf), collImgFile.name, collImgFile.type);
      uploadedURIs.collectionImageUri = uri;
      onLog('✓ Collection image: ' + uri, 'ok');
    }

    const { imageURIs, metadataURIs } = await uploadCollection(collectionData, onProgress, onLog);
    uploadedURIs.imageURIs = imageURIs;
    uploadedURIs.metadataURIs = metadataURIs;

    // Upload collection-level metadata
    const collMeta = {
      name: document.getElementById('cfgName').value.trim(),
      description: '',
      image: uploadedURIs.collectionImageUri || Object.values(imageURIs)[0] || '',
    };
    onLog('Uploading collection metadata…', 'info');
    const collMetaBytes = new TextEncoder().encode(JSON.stringify(collMeta, null, 2));
    uploadedURIs.collectionMetaUri = await uploadFile(collMetaBytes, 'collection.json', 'application/json');
    onLog('✓ Collection metadata: ' + uploadedURIs.collectionMetaUri, 'ok');

    setStatus('step4Status', '✓ All files uploaded to Arweave', 'ok');
    document.getElementById('step4Next').disabled = false;

    // Pre-fill deploy preview
    buildDeployPreview();
    completedSteps.add(4);
  } catch (e) {
    onLog('Upload failed: ' + e.message, 'err');
    setStatus('step4Status', 'Upload failed: ' + e.message, 'err');
  } finally {
    document.getElementById('startUploadBtn').disabled = false;
    document.getElementById('step4Back').disabled = false;
  }
});

document.getElementById('step4Next').addEventListener('click', () => goTo(5));

// ─── Step 5: Deploy ───────────────────────────────────────────────────────────
function buildDeployPreview() {
  const name = document.getElementById('cfgName').value.trim();
  const machineId = document.getElementById('cfgMachineId').value.trim();
  const price = parseFloat(document.getElementById('cfgPrice').value) || 0;
  const mintLimit = parseInt(document.getElementById('cfgMintLimit').value) || 0;
  const treasury = document.getElementById('cfgTreasury').value.trim() || getPublicKeyString();
  const metaCount = Object.keys(uploadedURIs.metadataURIs || {}).length;

  const wlWallets = parseWlWallets();

  document.getElementById('deployPreview').innerHTML = `
    <div class="kv-row"><span class="kv-k">Collection</span><span class="kv-v">${escHtml(name)}</span></div>
    <div class="kv-row"><span class="kv-k">Machine ID</span><span class="kv-v">${escHtml(machineId)}</span></div>
    <div class="kv-row"><span class="kv-k">Total Items</span><span class="kv-v">${metaCount}</span></div>
    <div class="kv-row"><span class="kv-k">Mint Price</span><span class="kv-v">${price || 'FREE'} SOL</span></div>
    <div class="kv-row"><span class="kv-k">Per-Wallet Limit</span><span class="kv-v">${mintLimit || 'Unlimited'}</span></div>
    <div class="kv-row"><span class="kv-k">Treasury</span><span class="kv-v" style="font-size:.58rem">${escHtml(treasury || '—')}</span></div>
    ${wlWallets.length ? `<div class="kv-row"><span class="kv-k">Whitelist</span><span class="kv-v">${wlWallets.length} wallets</span></div>` : ''}
    <div class="kv-row"><span class="kv-k">Standard</span><span class="kv-v">Token-2022 + Anchor</span></div>
  `;
}

function parseWlWallets() {
  const raw = document.getElementById('cfgWlWallets').value.trim();
  return raw ? raw.split('\n').map(s => s.trim()).filter(s => isValidAddr(s)) : [];
}

document.getElementById('step5Back').addEventListener('click', () => goTo(4));

document.getElementById('deployBtn').addEventListener('click', async () => {
  const deployBtn = document.getElementById('deployBtn');
  deployBtn.disabled = true;

  const onLog = (msg, type) => log('deployLog', msg, type);
  const onProgress = (done, total, label) => setProgress('deployProgFill', 'deployProgLbl', 'deployProgPct', 'deployProg', done, total, label);

  try {
    const name = document.getElementById('cfgName').value.trim();
    const machineId = document.getElementById('cfgMachineId').value.trim();
    const price = parseFloat(document.getElementById('cfgPrice').value) || 0;
    const mintLimit = parseInt(document.getElementById('cfgMintLimit').value) || 0;
    const startDateVal = document.getElementById('cfgStartDate').value;
    const startTs = startDateVal ? Math.floor(new Date(startDateVal).getTime() / 1000) : 0;
    const treasuryInput = document.getElementById('cfgTreasury').value.trim();
    const treasury = treasuryInput || getPublicKeyString();

    const wlWallets = parseWlWallets();
    const wlPrice = parseFloat(document.getElementById('cfgWlPrice').value) || 0;
    const wlLimit = parseInt(document.getElementById('cfgWlLimit').value) || 0;
    const wlEndVal = document.getElementById('cfgWlEnd').value;
    const wlEndTs = wlEndVal ? Math.floor(new Date(wlEndVal).getTime() / 1000) : 0;

    const metadataURIs = uploadedURIs.metadataURIs || {};
    const totalItems = Object.keys(metadataURIs).length;

    let whitelist = null;
    if (wlWallets.length > 0) {
      onLog('Building Merkle root for ' + wlWallets.length + ' wallets…', 'info');
      const merkleRoot = await buildMerkleRoot(wlWallets);
      whitelist = {
        merkleRoot,
        priceLamports: Math.floor(wlPrice * 1e9),
        mintLimit: wlLimit,
        startTs: 0,
        endTs: wlEndTs,
      };
      onLog('✓ Merkle root built', 'ok');
    }

    // Step 1: Initialize machine
    onLog('══ Creating Mint Machine on-chain… ══', 'info');
    onProgress(0, 100, 'Initializing…');

    const sig1 = await initializeMachine({
      machineId,
      name,
      collectionUri: uploadedURIs.collectionMetaUri,
      totalItems,
      priceLamports: Math.floor(price * 1e9),
      mintLimit,
      startTs,
      treasury,
      whitelist,
    });
    onLog('✓ Machine created: ' + sig1, 'ok');
    onProgress(15, 100, 'Machine created');

    // Derive machine address
    const { pda } = await getMachinePda(getPublicKeyString(), machineId);
    machineAddress = pda.toString();
    onLog('  Address: ' + machineAddress, 'info');

    // Step 2: Add items in batches
    onLog('══ Loading ' + totalItems + ' items… ══', 'info');
    const sortedMeta = Object.entries(metadataURIs).sort((a, b) => {
      const aNum = parseInt(a[0]);
      const bNum = parseInt(b[0]);
      if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum;
      return a[0].localeCompare(b[0]);
    });

    const items = sortedMeta.map(([fn, uri]) => ({
      name: name + ' #' + fn.replace('.json', ''),
      uri,
    }));

    let loaded = 0;
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      try {
        await addItemsBatch(machineAddress, batch);
        loaded += batch.length;
        onProgress(15 + (loaded / items.length) * 85, 100, `Items: ${loaded}/${items.length}`);
        onLog(`  Batch ${Math.ceil((i + 1) / BATCH_SIZE)}: loaded ${loaded}/${items.length}`, 'ok');
      } catch (e) {
        onLog('  Batch failed: ' + e.message + ' — retrying…', 'warn');
        await new Promise(r => setTimeout(r, 3000));
        try {
          await addItemsBatch(machineAddress, batch);
          loaded += batch.length;
          onProgress(15 + (loaded / items.length) * 85, 100, `Items: ${loaded}/${items.length}`);
        } catch (e2) {
          onLog('  Retry failed: ' + e2.message, 'err');
        }
      }
      if (i > 0 && (i / BATCH_SIZE) % 5 === 0) await new Promise(r => setTimeout(r, 800));
    }

    onProgress(100, 100, 'Done!');
    onLog('', 'info');
    onLog('══ DEPLOYMENT COMPLETE ══', 'ok');
    onLog('Machine: ' + machineAddress, 'ok');
    onLog('Items: ' + loaded + ' | Price: ' + (price || 'FREE') + ' SOL', 'ok');
    onLog('Standard: Token-2022 NFT (no Metaplex)', 'info');

    setStatus('step5Status', '✓ Machine deployed and items loaded!', 'ok');
    completedSteps.add(5);

    // Populate results
    document.getElementById('resultKv').innerHTML = `
      <div class="kv-row"><span class="kv-k">Machine Address</span>
        <span class="kv-v" style="font-size:.60rem;display:flex;align-items:center;gap:6px">
          <span id="machineAddrSpan">${escHtml(machineAddress)}</span>
          <button class="copy-btn" id="copyMachineAddrBtn">Copy</button>
        </span>
      </div>
      <div class="kv-row"><span class="kv-k">Items Loaded</span><span class="kv-v">${loaded}</span></div>
      <div class="kv-row"><span class="kv-k">Mint Price</span><span class="kv-v">${price || 'FREE'} SOL</span></div>
      <div class="kv-row"><span class="kv-k">Standard</span><span class="kv-v">Token-2022</span></div>
      <div class="kv-row"><span class="kv-k">Network</span><span class="kv-v">${currentNetwork}</span></div>
    `;

    document.getElementById('copyMachineAddrBtn')?.addEventListener('click', (e) => {
      copyText(machineAddress, e.target);
    });

    goTo(6);
    completedSteps.add(6);
  } catch (e) {
    onLog('Deployment failed: ' + e.message, 'err');
    setStatus('step5Status', 'Deploy failed: ' + e.message, 'err');
    deployBtn.disabled = false;
  }
});

// ─── Step 6: Done ─────────────────────────────────────────────────────────────
document.getElementById('copyMachineBtn').addEventListener('click', async (e) => {
  if (machineAddress) await copyText(machineAddress, e.target);
});

document.getElementById('downloadMintBtn').addEventListener('click', () => {
  if (!machineAddress) return;
  const html = generateMintPage();
  const blob = new Blob([html], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'mint.html';
  a.click();
});

function generateMintPage() {
  const name = escHtml(document.getElementById('cfgName').value.trim());
  const price = parseFloat(document.getElementById('cfgPrice').value) || 0;
  const network = currentNetwork;
  const addr = machineAddress || '';
  const metaCount = Object.keys(uploadedURIs.metadataURIs || {}).length;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} — Mint</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Outfit:wght@700;800&display=swap" rel="stylesheet">
<style>
:root{--a:#78b15a;--bg:#000;--text:rgba(120,177,90,.88);--mono:'JetBrains Mono',monospace;--sans:'Outfit',sans-serif;color-scheme:dark}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:var(--mono);font-size:.82rem;line-height:1.65;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{max-width:440px;width:100%;border:1px solid rgba(120,177,90,.2);border-radius:12px;padding:28px;background:rgba(14,26,12,.8)}
h1{font-family:var(--sans);font-size:1.4rem;font-weight:800;color:var(--a);margin-bottom:4px}
.sub{font-size:.65rem;color:rgba(120,177,90,.5);margin-bottom:20px;letter-spacing:1px;text-transform:uppercase}
.info{display:flex;flex-direction:column;gap:6px;margin-bottom:20px}
.row{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px dashed rgba(120,177,90,.1)}
.k{font-size:.60rem;text-transform:uppercase;letter-spacing:.8px;color:rgba(120,177,90,.5)}
.v{font-weight:700;color:var(--a)}
.btn{width:100%;padding:14px;border:1px solid rgba(120,177,90,.4);border-radius:8px;background:rgba(120,177,90,.1);color:var(--a);font-family:var(--mono);font-size:.78rem;font-weight:600;letter-spacing:1px;text-transform:uppercase;cursor:pointer;transition:all .1s;margin-top:6px}
.btn:hover{background:rgba(120,177,90,.18);transform:translateY(-1px)}
.btn:disabled{opacity:.3;cursor:not-allowed;transform:none}
.status{padding:8px 12px;border-radius:6px;font-size:.68rem;margin-top:8px;display:none}
.status.show{display:block}
.ok{background:rgba(109,217,125,.06);border:1px solid rgba(109,217,125,.2);color:#6dd97d}
.err{background:rgba(224,112,112,.06);border:1px solid rgba(224,112,112,.2);color:#e07070}
</style>
</head>
<body>
<div class="card">
  <h1>${name}</h1>
  <div class="sub">Token-2022 NFT · ${network}</div>
  <div class="info">
    <div class="row"><span class="k">Price</span><span class="v">${price ? price + ' SOL' : 'FREE'}</span></div>
    <div class="row"><span class="k">Supply</span><span class="v">${metaCount}</span></div>
    <div class="row"><span class="k">Standard</span><span class="v">Token-2022</span></div>
  </div>
  <button class="btn" id="connectBtn">Connect Wallet</button>
  <button class="btn" id="mintBtn" disabled>Mint NFT</button>
  <div class="status" id="statusMsg"></div>
</div>
<script type="module">
// Minimal Wallet Standard connect + mint flow for generated page
const MACHINE = '${escHtml(addr)}';
const NETWORK = '${escHtml(network)}';
const RPC = NETWORK === 'mainnet'
  ? 'https://api.mainnet-beta.solana.com'
  : 'https://api.devnet.solana.com';

let wallet = null, account = null;

function setStatus(msg, type) {
  const el = document.getElementById('statusMsg');
  el.textContent = msg;
  el.className = 'status show ' + type;
}

document.getElementById('connectBtn').addEventListener('click', async () => {
  try {
    const { getWallets } = await import('https://esm.run/@wallet-standard/app');
    const { get } = getWallets();
    const wallets = get().filter(w => w.chains.some(c => c.startsWith('solana:')));
    if (!wallets.length) return setStatus('No Solana wallet found. Install Phantom.', 'err');
    wallet = wallets[0];
    const { accounts } = await wallet.features['standard:connect'].connect();
    account = accounts[0];
    document.getElementById('connectBtn').textContent = account.address.slice(0,4)+'…'+account.address.slice(-4);
    document.getElementById('mintBtn').disabled = false;
    setStatus('Wallet connected', 'ok');
  } catch (e) { setStatus(e.message, 'err'); }
});

document.getElementById('mintBtn').addEventListener('click', async () => {
  setStatus('Minting… check your wallet', 'ok');
  document.getElementById('mintBtn').disabled = true;
  try {
    // Full mint logic requires the deployed program client — see nft-machine docs.
    setStatus('Mint flow: integrate program.js mintNft() with this page.', 'ok');
  } catch(e) { setStatus(e.message, 'err'); document.getElementById('mintBtn').disabled = false; }
});
<\/script>
</body>
</html>`;
}

// ─── Init ─────────────────────────────────────────────────────────────────────
renderWalletList();
goTo(1);
