import { Wallet, JsonRpcProvider, formatUnits } from "ethers";
import { encodeAddress } from "@polkadot/util-crypto";
import { connectSubstrate } from "../lib/finality.js";
import { loadEnv } from "../lib/env.js";
import { CHAIN_ID, SS58_PREFIX, TOKEN_DECIMALS } from "../lib/endpoints.js";

function explain(err) {
  return [err.shortMessage, err.reason, err.code, err.message]
    .filter(Boolean)
    .filter((item, index, all) => all.indexOf(item) === index)
    .join(" | ");
}

const env = loadEnv();
if (!env.privateKey || env.privateKey === "0x") {
  console.error("map-account: set PRIVATE_KEY in .env");
  process.exit(1);
}

const wallet = new Wallet(env.privateKey);
const api = await connectSubstrate(env.substrateWs);
try {
  const mapped = await api.call.reviveApi.accountId(wallet.address);
  const bytes = mapped.toU8a();
  if (bytes.length !== 32) {
    throw new Error(`reviveApi.accountId returned ${bytes.length} bytes, expected 32`);
  }
  const ss58 = encodeAddress(bytes, SS58_PREFIX);
  const account = await api.query.system.account(ss58);
  const free = account.data.free.toString();
  const provider = new JsonRpcProvider(env.evmRpc, CHAIN_ID);
  const chain = await provider.getNetwork();
  if (Number(chain.chainId) !== CHAIN_ID) {
    throw new Error(`EVM chain id ${chain.chainId} did not match ${CHAIN_ID}`);
  }
  const evmBalance = await provider.getBalance(wallet.address);
  const ed = api.consts.balances.existentialDeposit.toString();
  const perByte = api.consts.revive.depositPerByte.toString();
  console.log(JSON.stringify({
    evmAddress: wallet.address,
    mappedAccountId: mapped.toHex(),
    ss58,
    ss58Prefix: SS58_PREFIX,
    nativeFree: free,
    nativeFreePot: formatUnits(free, TOKEN_DECIMALS),
    evmBalanceWei: evmBalance.toString(),
    evmBalancePot: formatUnits(evmBalance, 18),
    existentialDeposit: ed,
    depositPerByte: perByte,
    nativeToEthRatio: api.consts.revive.nativeToEthRatio.toString(),
    chainId: Number(chain.chainId),
  }, null, 2));
} catch (err) {
  console.error(`map-account: ${explain(err)}`);
  process.exitCode = 1;
} finally {
  await api.disconnect();
}
