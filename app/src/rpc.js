/** RPC endpoints. Helius used for enhanced data. */
export const RPC_ENDPOINTS = {
  mainnet: 'https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY',
  devnet:  'https://devnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY',
  localnet: 'http://127.0.0.1:8899',
};

export const WS_ENDPOINTS = {
  mainnet: 'wss://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY',
  devnet:  'wss://devnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY',
  localnet: 'ws://127.0.0.1:8900',
};

export let currentNetwork = 'devnet';

export function setNetwork(n) {
  currentNetwork = n;
}

export function getRpcUrl() {
  return RPC_ENDPOINTS[currentNetwork];
}

export function getWsUrl() {
  return WS_ENDPOINTS[currentNetwork];
}
