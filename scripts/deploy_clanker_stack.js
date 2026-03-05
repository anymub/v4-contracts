#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { ethers } = require("ethers");

const CREATE2_DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const HOOK_MASK = (1n << 14n) - 1n;
const HOOK_FLAGS = 0x28ccn; // beforeInit + beforeAddLiquidity + beforeSwap + afterSwap + beforeSwapDelta + afterSwapDelta

const RETRIES = Number(process.env.DEPLOY_RETRIES || 5);
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_SECONDS || 2) * 1000;

const PROJECT_ROOT = process.env.ROOT_DIR
  ? path.resolve(process.env.ROOT_DIR)
  : path.resolve(__dirname, "..", "..");
const V4_ROOT = path.resolve(__dirname, "..");
const DEPLOYMENTS_DIR = path.join(PROJECT_ROOT, "deployments", "clanker-stack");

const ARTIFACTS = {
  ClankerDeployer: path.join(V4_ROOT, "out", "ClankerDeployer.sol", "ClankerDeployer.json"),
  ClankerPoolExtensionAllowlist: path.join(
    V4_ROOT,
    "out",
    "ClankerPoolExtensionAllowlist.sol",
    "ClankerPoolExtensionAllowlist.json"
  ),
  Clanker: path.join(V4_ROOT, "out", "Clanker.sol", "Clanker.json"),
  ClankerFeeLocker: path.join(V4_ROOT, "out", "ClankerFeeLocker.sol", "ClankerFeeLocker.json"),
  ClankerLpLockerFeeConversion: path.join(
    V4_ROOT,
    "out",
    "ClankerLpLockerFeeConversion.sol",
    "ClankerLpLockerFeeConversion.json"
  ),
  ClankerHookStaticFeeV2: path.join(
    V4_ROOT,
    "out",
    "ClankerHookStaticFeeV2.sol",
    "ClankerHookStaticFeeV2.json"
  ),
  ClankerMevBlockDelay: path.join(V4_ROOT, "out", "ClankerMevBlockDelay.sol", "ClankerMevBlockDelay.json"),
};

function req(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing env var: ${name}`);
  }
  return v;
}

function isAddress(v) {
  return /^0x[a-fA-F0-9]{40}$/.test(v || "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowTs() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function loadArtifact(name) {
  const file = ARTIFACTS[name];
  if (!fs.existsSync(file)) {
    throw new Error(`Missing artifact for ${name}: ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function ensureArtifacts() {
  const missing = Object.values(ARTIFACTS).filter((f) => !fs.existsSync(f));
  if (missing.length === 0) {
    return;
  }

  console.log("[preflight] Missing artifacts, running forge build in v4-contracts");
  execSync("forge build", {
    cwd: V4_ROOT,
    stdio: "inherit",
    env: process.env,
  });

  const stillMissing = Object.values(ARTIFACTS).filter((f) => !fs.existsSync(f));
  if (stillMissing.length > 0) {
    throw new Error(`Artifacts still missing after forge build: ${stillMissing.join(", ")}`);
  }
}

function linkBytecode(bytecodeObject, linkReferences, libraries) {
  if (!linkReferences || Object.keys(linkReferences).length === 0) {
    return bytecodeObject;
  }

  let hex = bytecodeObject.startsWith("0x") ? bytecodeObject.slice(2) : bytecodeObject;

  for (const [file, libs] of Object.entries(linkReferences)) {
    for (const [libName, refs] of Object.entries(libs)) {
      const keyA = `${file}:${libName}`;
      const libAddress = libraries[keyA] || libraries[libName];
      if (!libAddress) {
        throw new Error(`Missing library address for ${keyA}`);
      }
      const addr = libAddress.toLowerCase().replace(/^0x/, "");
      if (addr.length !== 40) {
        throw new Error(`Invalid library address ${libAddress} for ${keyA}`);
      }
      for (const ref of refs) {
        const start = ref.start * 2;
        const length = ref.length * 2;
        hex = `${hex.slice(0, start)}${addr}${hex.slice(start + length)}`;
      }
    }
  }

  return `0x${hex}`;
}

function isRetryableError(error) {
  const msg = String(error?.message || error || "").toLowerCase();
  const code = String(error?.code || "");
  return (
    code === "NONCE_EXPIRED" ||
    msg.includes("nonce too low") ||
    msg.includes("replacement transaction underpriced") ||
    msg.includes("transaction underpriced") ||
    msg.includes("already known") ||
    msg.includes("eoa nonce changed unexpectedly") ||
    msg.includes("timeout") ||
    msg.includes("temporarily unavailable")
  );
}

async function sendWithRetry(label, sendTx) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const tx = await sendTx();
      const rc = await tx.wait();
      if (!rc || Number(rc.status) !== 1) {
        throw new Error(`${label} tx failed (status=${rc?.status ?? "unknown"})`);
      }
      return { txHash: tx.hash, receipt: rc };
    } catch (error) {
      if (!isRetryableError(error) || attempt >= RETRIES) {
        throw error;
      }
      console.warn(
        `Retryable tx error for ${label} (attempt ${attempt}/${RETRIES}): ${String(error?.message || error)}`
      );
      await sleep(RETRY_DELAY_MS);
    }
  }
}

async function deployContract({ name, signer, provider, args = [], libraries = {}, existingAddress }) {
  if (existingAddress && isAddress(existingAddress)) {
    const code = await provider.getCode(existingAddress);
    if (code && code !== "0x") {
      return { address: ethers.getAddress(existingAddress), txHash: null, reused: true };
    }
  }

  const artifact = loadArtifact(name);
  const bytecode = linkBytecode(artifact.bytecode.object, artifact.bytecode.linkReferences, libraries);
  const factory = new ethers.ContractFactory(artifact.abi, bytecode, signer);

  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const contract = await factory.deploy(...args);
      const deployTx = contract.deploymentTransaction();
      if (!deployTx) {
        throw new Error(`No deployment transaction returned for ${name}`);
      }
      const rc = await deployTx.wait();
      if (!rc || Number(rc.status) !== 1) {
        throw new Error(`Deployment failed for ${name} (status=${rc?.status ?? "unknown"})`);
      }
      const address = await contract.getAddress();
      return { address, txHash: deployTx.hash, reused: false };
    } catch (error) {
      if (!isRetryableError(error) || attempt >= RETRIES) {
        throw error;
      }
      console.warn(
        `Retryable deploy error for ${name} (attempt ${attempt}/${RETRIES}): ${String(error?.message || error)}`
      );
      await sleep(RETRY_DELAY_MS);
    }
  }
}

function computeCreate2Address(saltHex, initCodeHash) {
  return ethers.getCreate2Address(CREATE2_DEPLOYER, saltHex, initCodeHash);
}

function mineHookSalt(initCodeHash, maxIterations = 2_000_000) {
  for (let i = 0; i < maxIterations; i += 1) {
    const saltHex = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const predicted = computeCreate2Address(saltHex, initCodeHash);
    if ((BigInt(predicted) & HOOK_MASK) === HOOK_FLAGS) {
      return { saltHex, predicted, iterations: i + 1 };
    }
  }
  throw new Error(`Failed to mine hook CREATE2 salt within ${maxIterations} iterations`);
}

async function deployHookCreate2({ signer, provider, args, existingAddress }) {
  if (existingAddress && isAddress(existingAddress)) {
    const code = await provider.getCode(existingAddress);
    if (code && code !== "0x") {
      return { address: ethers.getAddress(existingAddress), txHash: null, reused: true, mined: false };
    }
  }

  const artifact = loadArtifact("ClankerHookStaticFeeV2");
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, signer);
  const unsigned = await factory.getDeployTransaction(...args);
  const initCode = unsigned.data;
  if (!initCode) {
    throw new Error("Failed to build init code for ClankerHookStaticFeeV2");
  }

  const deployerCode = await provider.getCode(CREATE2_DEPLOYER);
  if (!deployerCode || deployerCode === "0x") {
    throw new Error(`Deterministic deployment proxy missing on chain: ${CREATE2_DEPLOYER}`);
  }

  const initCodeHash = ethers.keccak256(initCode);
  const { saltHex, predicted, iterations } = mineHookSalt(initCodeHash);
  console.log(`Mined hook salt in ${iterations} iterations: ${saltHex}`);
  console.log(`HOOK_ADDRESS ${predicted}`);

  const existing = await provider.getCode(predicted);
  if (existing && existing !== "0x") {
    return { address: predicted, txHash: null, reused: true, mined: true };
  }

  const data = ethers.concat([saltHex, initCode]);
  const { txHash } = await sendWithRetry("deployHookStaticFeeV2(create2)", () =>
    signer.sendTransaction({ to: CREATE2_DEPLOYER, data, gasLimit: 12_000_000n })
  );

  const code = await provider.getCode(predicted);
  if (!code || code === "0x") {
    throw new Error(`Hook deployment failed, no code at predicted address ${predicted}`);
  }

  return { address: predicted, txHash, reused: false, mined: true };
}

function abiEncode(types, values) {
  return ethers.AbiCoder.defaultAbiCoder().encode(types, values);
}

async function main() {
  ensureArtifacts();

  const rpcUrl = req("RPC_URL");
  const privateKey = req("PRIVATE_KEY");
  const owner = ethers.getAddress(req("OWNER"));
  const teamFeeRecipient = ethers.getAddress(req("TEAM_FEE_RECIPIENT"));

  const poolManager = ethers.getAddress(req("POOL_MANAGER"));
  const positionManager = ethers.getAddress(req("POSITION_MANAGER"));
  const permit2 = ethers.getAddress(req("PERMIT2"));
  const universalRouter = ethers.getAddress(req("UNIVERSAL_ROUTER"));
  const weth = ethers.getAddress(req("WETH"));
  const blockDelay = Number(req("BLOCK_DELAY"));
  const envName = process.env.ENV_NAME || process.env.NETWORK_NAME || "unknown";

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);
  const network = await provider.getNetwork();

  if (process.env.CHAIN_ID && Number(process.env.CHAIN_ID) !== Number(network.chainId)) {
    throw new Error(
      `CHAIN_ID mismatch: env=${process.env.CHAIN_ID}, provider=${network.chainId.toString()}`
    );
  }

  fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  const latestFile = path.join(DEPLOYMENTS_DIR, `${envName}-latest.json`);
  const latest = fs.existsSync(latestFile) ? JSON.parse(fs.readFileSync(latestFile, "utf8")) : null;

  const existingContracts = latest?.contracts || {};

  const txHashes = {};
  const contracts = {};

  console.log("[0/7] Deploy ClankerDeployer (library)");
  {
    const result = await deployContract({
      name: "ClankerDeployer",
      signer,
      provider,
      existingAddress: existingContracts.ClankerDeployer,
    });
    contracts.ClankerDeployer = result.address;
    txHashes.ClankerDeployer = result.txHash;
  }

  console.log("[1/7] Deploy ClankerPoolExtensionAllowlist");
  {
    const result = await deployContract({
      name: "ClankerPoolExtensionAllowlist",
      signer,
      provider,
      args: [owner],
      existingAddress: existingContracts.ClankerPoolExtensionAllowlist,
    });
    contracts.ClankerPoolExtensionAllowlist = result.address;
    txHashes.ClankerPoolExtensionAllowlist = result.txHash;
  }

  console.log("[2/7] Deploy Clanker");
  {
    const result = await deployContract({
      name: "Clanker",
      signer,
      provider,
      args: [owner],
      libraries: {
        "src/utils/ClankerDeployer.sol:ClankerDeployer": contracts.ClankerDeployer,
      },
      existingAddress: process.env.CLANKER_FACTORY_ADDRESS || existingContracts.Clanker,
    });
    contracts.Clanker = result.address;
    txHashes.Clanker = result.txHash;
  }

  console.log("[3/7] Deploy ClankerFeeLocker");
  {
    const result = await deployContract({
      name: "ClankerFeeLocker",
      signer,
      provider,
      args: [owner],
      existingAddress: existingContracts.ClankerFeeLocker,
    });
    contracts.ClankerFeeLocker = result.address;
    txHashes.ClankerFeeLocker = result.txHash;
  }

  console.log("[4/7] Deploy ClankerLpLockerFeeConversion");
  {
    const result = await deployContract({
      name: "ClankerLpLockerFeeConversion",
      signer,
      provider,
      args: [
        owner,
        contracts.Clanker,
        contracts.ClankerFeeLocker,
        positionManager,
        permit2,
        universalRouter,
        poolManager,
      ],
      existingAddress: process.env.CLANKER_LOCKER_ADDRESS || existingContracts.ClankerLpLockerFeeConversion,
    });
    contracts.ClankerLpLockerFeeConversion = result.address;
    txHashes.ClankerLpLockerFeeConversion = result.txHash;
  }

  console.log("[5/7] Deploy ClankerHookStaticFeeV2 (mined CREATE2 address)");
  {
    const result = await deployHookCreate2({
      signer,
      provider,
      args: [poolManager, contracts.Clanker, contracts.ClankerPoolExtensionAllowlist, weth],
      existingAddress: process.env.CLANKER_HOOK_ADDRESS || existingContracts.ClankerHookStaticFeeV2,
    });
    contracts.ClankerHookStaticFeeV2 = result.address;
    txHashes.ClankerHookStaticFeeV2 = result.txHash;
  }

  console.log("[6/7] Deploy ClankerMevBlockDelay");
  {
    const result = await deployContract({
      name: "ClankerMevBlockDelay",
      signer,
      provider,
      args: [blockDelay],
      existingAddress: process.env.CLANKER_MEV_MODULE_ADDRESS || existingContracts.ClankerMevBlockDelay,
    });
    contracts.ClankerMevBlockDelay = result.address;
    txHashes.ClankerMevBlockDelay = result.txHash;
  }

  const clankerArtifact = loadArtifact("Clanker");
  const feeLockerArtifact = loadArtifact("ClankerFeeLocker");
  const clanker = new ethers.Contract(contracts.Clanker, clankerArtifact.abi, signer);
  const feeLocker = new ethers.Contract(contracts.ClankerFeeLocker, feeLockerArtifact.abi, signer);

  console.log("Configure Clanker modules");
  {
    const currentTeamFeeRecipient = await clanker.teamFeeRecipient();
    if (ethers.getAddress(currentTeamFeeRecipient) !== teamFeeRecipient) {
      const { txHash } = await sendWithRetry("setTeamFeeRecipient(address)", () =>
        clanker.setTeamFeeRecipient(teamFeeRecipient)
      );
      txHashes.setTeamFeeRecipient = txHash;
    }

    {
      const { txHash } = await sendWithRetry("setHook(address,bool)", () =>
        clanker.setHook(contracts.ClankerHookStaticFeeV2, true)
      );
      txHashes.setHook = txHash;
    }

    const lockerEnabled = await clanker.enabledLockers(
      contracts.ClankerLpLockerFeeConversion,
      contracts.ClankerHookStaticFeeV2
    );
    if (!lockerEnabled) {
      const { txHash } = await sendWithRetry("setLocker(address,address,bool)", () =>
        clanker.setLocker(contracts.ClankerLpLockerFeeConversion, contracts.ClankerHookStaticFeeV2, true)
      );
      txHashes.setLocker = txHash;
    }

    {
      const { txHash } = await sendWithRetry("setMevModule(address,bool)", () =>
        clanker.setMevModule(contracts.ClankerMevBlockDelay, true)
      );
      txHashes.setMevModule = txHash;
    }

    const hasDepositor = await feeLocker.allowedDepositors(contracts.ClankerLpLockerFeeConversion);
    if (!hasDepositor) {
      const { txHash } = await sendWithRetry("addDepositor(address)", () =>
        feeLocker.addDepositor(contracts.ClankerLpLockerFeeConversion)
      );
      txHashes.addDepositor = txHash;
    }

    const deprecated = await clanker.deprecated();
    if (deprecated) {
      const { txHash } = await sendWithRetry("setDeprecated(bool)", () => clanker.setDeprecated(false));
      txHashes.setDeprecated = txHash;
    }
  }

  console.log("Post-deploy validation");
  for (const [k, v] of Object.entries(contracts)) {
    const code = await provider.getCode(v);
    if (!code || code === "0x") {
      throw new Error(`Validation failed: ${k} has no code at ${v}`);
    }
  }

  const finalLockerEnabled = await clanker.enabledLockers(
    contracts.ClankerLpLockerFeeConversion,
    contracts.ClankerHookStaticFeeV2
  );
  if (!finalLockerEnabled) {
    throw new Error("Validation failed: Clanker locker not enabled for hook");
  }

  const finalDepositor = await feeLocker.allowedDepositors(contracts.ClankerLpLockerFeeConversion);
  if (!finalDepositor) {
    throw new Error("Validation failed: fee locker depositor not configured");
  }

  const finalDeprecated = await clanker.deprecated();
  if (finalDeprecated) {
    throw new Error("Validation failed: Clanker remains deprecated=true");
  }

  const deployment = {
    network: envName,
    chainId: Number(network.chainId),
    timestamp: new Date().toISOString(),
    deployer: signer.address,
    contracts,
    constructorArgsHex: {
      ClankerDeployer: "0x",
      ClankerPoolExtensionAllowlist: abiEncode(["address"], [owner]),
      Clanker: abiEncode(["address"], [owner]),
      ClankerFeeLocker: abiEncode(["address"], [owner]),
      ClankerLpLockerFeeConversion: abiEncode(
        ["address", "address", "address", "address", "address", "address", "address"],
        [
          owner,
          contracts.Clanker,
          contracts.ClankerFeeLocker,
          positionManager,
          permit2,
          universalRouter,
          poolManager,
        ]
      ),
      ClankerHookStaticFeeV2: abiEncode(
        ["address", "address", "address", "address"],
        [poolManager, contracts.Clanker, contracts.ClankerPoolExtensionAllowlist, weth]
      ),
      ClankerMevBlockDelay: abiEncode(["uint256"], [blockDelay]),
    },
    txHashes,
  };

  const versionedFile = path.join(DEPLOYMENTS_DIR, `${envName}-${nowTs()}.json`);
  fs.writeFileSync(versionedFile, `${JSON.stringify(deployment, null, 2)}\n`);
  fs.writeFileSync(latestFile, `${JSON.stringify(deployment, null, 2)}\n`);

  console.log("Done");
  console.log(`- ${versionedFile}`);
  console.log(`- ${latestFile}`);
  console.log("");
  console.log("Use these env values for Tokr clanker deployment:");
  console.log(`CLANKER_FACTORY_ADDRESS=${contracts.Clanker}`);
  console.log(`CLANKER_HOOK_ADDRESS=${contracts.ClankerHookStaticFeeV2}`);
  console.log(`CLANKER_LOCKER_ADDRESS=${contracts.ClankerLpLockerFeeConversion}`);
  console.log(`CLANKER_MEV_MODULE_ADDRESS=${contracts.ClankerMevBlockDelay}`);
  console.log(`CLANKER_PAIRED_TOKEN=${weth}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
