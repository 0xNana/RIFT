import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ContractFactory, JsonRpcProvider, Wallet, formatUnits } from "ethers";
import { loadEnv } from "../lib/env.js";
import { CHAIN_ID } from "../lib/endpoints.js";

function explain(err) {
  return [err.shortMessage, err.reason, err.code, err.message]
    .filter(Boolean)
    .filter((item, index, all) => all.indexOf(item) === index)
    .join(" | ");
}

const env = loadEnv();
if (!env.privateKey || env.privateKey === "0x") {
  console.error("deploy: set PRIVATE_KEY in .env");
  process.exit(1);
}

const artifact = JSON.parse(
  readFileSync("out/FinalityRegistry.sol/FinalityRegistry.json", "utf8"),
);
const bytecode = artifact.bytecode.object.startsWith("0x")
  ? artifact.bytecode.object
  : `0x${artifact.bytecode.object}`;
const provider = new JsonRpcProvider(env.evmRpc, CHAIN_ID);
const wallet = new Wallet(env.privateKey, provider);

try {
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== CHAIN_ID) {
    throw new Error(`EVM chain id ${network.chainId} did not match ${CHAIN_ID}`);
  }
  const balance = await provider.getBalance(wallet.address);
  const factory = new ContractFactory(artifact.abi, bytecode, wallet);
  const unsigned = await factory.getDeployTransaction();
  const estimated = await provider.estimateGas({ ...unsigned, from: wallet.address });
  const fee = await provider.getFeeData();
  const gasPrice = fee.gasPrice ?? fee.maxFeePerGas ?? 0n;
  const estimatedWei = estimated * gasPrice;
  console.error(JSON.stringify({
    step: "estimate",
    deployer: wallet.address,
    balanceWei: balance.toString(),
    balancePot: formatUnits(balance, 18),
    estimatedGas: estimated.toString(),
    gasPrice: gasPrice.toString(),
    estimatedFeeWei: estimatedWei.toString(),
    estimatedFeePot: formatUnits(estimatedWei, 18),
  }));
  if (balance < estimatedWei) {
    throw new Error(
      `balance ${balance.toString()} wei is below estimated fee ${estimatedWei.toString()} wei`,
    );
  }
  const contract = await factory.deploy();
  const tx = contract.deploymentTransaction();
  console.error(`deploy: submitted ${tx.hash}`);
  const receipt = await tx.wait();
  const address = await contract.getAddress();
  const record = {
    chainId: CHAIN_ID,
    address,
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    deployer: wallet.address,
    gasUsed: receipt.gasUsed.toString(),
    status: receipt.status,
    solc: "0.8.19",
    evmVersion: "paris",
  };
  mkdirSync("deployments", { recursive: true });
  writeFileSync("deployments/testnet.json", `${JSON.stringify(record, null, 2)}\n`);
  mkdirSync("web/public", { recursive: true });
  writeFileSync(
    "web/public/config.json",
    `${JSON.stringify({ registry: address, chainId: CHAIN_ID }, null, 2)}\n`,
  );
  console.log(JSON.stringify(record, null, 2));
} catch (err) {
  console.error(`deploy: ${explain(err)}`);
  process.exitCode = 1;
}
