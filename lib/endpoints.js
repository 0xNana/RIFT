export const SUBSTRATE_WS = "wss://test-node-v3.portaldot.dev";
export const EVM_RPC = "https://test-evm-rpc-v3.portaldot.dev";
export const CHAIN_ID = 420420777;
export const EXPECTED_CHAIN = "PortaldotV3 Test";
export const EXPECTED_SPEC = "portaldot-v3";
// Observed on the public V3 testnet endpoint. Confirm this value with Portaldot
// before using it as an independently trusted network identity.
export const EXPECTED_GENESIS = "0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd";
export const SS58_PREFIX = 42;
export const SCANNER = "https://scanner-testnet-v3.portaldot.dev";
export const NODE_CONSOLE = "https://node-console.portaldot.dev/";
export const TOKEN_DECIMALS = 14;

export const DEFAULT_THRESHOLDS = {
  grandpaLag: 6,
  beefyLag: 24,
  headStaleSeconds: 30,
};
