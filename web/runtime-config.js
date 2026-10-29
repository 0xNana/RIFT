import { CHAIN_ID, EVM_RPC } from "../lib/endpoints.js";

const injected = typeof __PORTALDOT_EVM_CONFIG__ === "undefined"
  ? null
  : __PORTALDOT_EVM_CONFIG__;

export const evmRpc = injected?.rpc || EVM_RPC;
export const evmChainId = Number(injected?.chainId || CHAIN_ID);
