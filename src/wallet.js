import { loadWallet, saveWallet } from "./fs.js";
import {
  generateSecp256k1KeyPair,
  privateKeyToWif,
  wifToPrivateKey,
  publicKeyToLegacyAddress,
  publicKeyToSegwitAddress,
  validateBitcoinAddress,
  fetchAddressBalance,
  signBitcoinMessage,
  verifyBitcoinMessage
} from "./bitcoin.js";

/**
 * Initializes or loads Boxy's persistent Bitcoin wallet.
 * @param {object} options - Initialization options.
 * @param {string} [options.network='mainnet'] - Bitcoin network ('mainnet' or 'testnet').
 * @returns {Promise<object>} Initialized wallet record.
 */
export async function initBoxyWallet(options = {}) {
  const network = options.network || process.env.BOXY_BITCOIN_NETWORK || "mainnet";
  const existing = await loadWallet();
  if (existing && existing.address && existing.wif) {
    return existing;
  }

  const keyPair = generateSecp256k1KeyPair();
  const legacyAddress = publicKeyToLegacyAddress(keyPair.publicKeyBytes, network);
  const segwitAddress = publicKeyToSegwitAddress(keyPair.publicKeyBytes, network);
  const wif = privateKeyToWif(keyPair.privateKeyBytes, network);

  const walletData = {
    version: 1,
    network,
    createdAt: new Date().toISOString(),
    address: segwitAddress,
    legacyAddress,
    publicKey: keyPair.publicKeyHex,
    wif,
    label: "Boxy Autonomous Bitcoin Wallet",
    description: "Official Bitcoin wallet for Boxy (@OmniBlocks/boxy)"
  };

  await saveWallet(walletData);
  return walletData;
}

/**
 * Retrieves Boxy's wallet information and optional live balance.
 * @param {object} [options] - Options for wallet retrieval.
 * @param {boolean} [options.fetchBalance=true] - Whether to fetch live chain balance.
 * @returns {Promise<object>} Boxy wallet summary.
 */
export async function getBoxyWallet(options = {}) {
  const wallet = await initBoxyWallet(options);
  const shouldFetchBalance = options.fetchBalance !== false;

  let balanceData = {
    balanceSatoshis: 0,
    balanceBtc: "0.00000000",
    txCount: 0,
    explorerUrl: wallet.network === "testnet"
      ? `https://mempool.space/testnet/address/${wallet.address}`
      : `https://mempool.space/address/${wallet.address}`
  };

  if (shouldFetchBalance) {
    balanceData = await fetchAddressBalance(wallet.address, wallet.network);
  }

  return {
    label: wallet.label,
    network: wallet.network,
    address: wallet.address,
    legacyAddress: wallet.legacyAddress,
    publicKey: wallet.publicKey,
    createdAt: wallet.createdAt,
    balanceSatoshis: balanceData.balanceSatoshis,
    balanceBtc: balanceData.balanceBtc,
    txCount: balanceData.txCount,
    explorerUrl: balanceData.explorerUrl,
    queryWarning: balanceData.queryWarning || null
  };
}

/**
 * Queries the balance and transaction stats of any Bitcoin address or Boxy's address.
 * @param {string} [targetAddress] - Bitcoin address to check (defaults to Boxy's address).
 * @param {string} [targetNetwork] - Network to check ('mainnet' or 'testnet').
 * @returns {Promise<object>} Balance and validation details.
 */
export async function checkBitcoinBalance(targetAddress, targetNetwork) {
  let address = targetAddress;
  let network = targetNetwork;

  if (!address) {
    const boxyWallet = await initBoxyWallet();
    address = boxyWallet.address;
    network = network || boxyWallet.network;
  }

  const validation = validateBitcoinAddress(address);
  if (!validation.valid) {
    return {
      error: `Invalid Bitcoin address: ${validation.error}`,
      address
    };
  }

  const resolvedNetwork = network || validation.network || "mainnet";
  const balanceInfo = await fetchAddressBalance(address, resolvedNetwork);

  return {
    address,
    type: validation.type,
    network: resolvedNetwork,
    balanceSatoshis: balanceInfo.balanceSatoshis,
    balanceBtc: balanceInfo.balanceBtc,
    txCount: balanceInfo.txCount,
    fundedSatoshis: balanceInfo.fundedSatoshis,
    spentSatoshis: balanceInfo.spentSatoshis,
    explorerUrl: balanceInfo.explorerUrl,
    queryWarning: balanceInfo.queryWarning || null
  };
}

/**
 * Signs an arbitrary message using Boxy's Bitcoin private key.
 * @param {string} message - Text message to endorse.
 * @returns {Promise<object>} Signature and verification metadata.
 */
export async function signWithBoxyWallet(message) {
  if (typeof message !== "string" || message.length === 0) {
    throw new Error("Message cannot be empty");
  }
  const wallet = await initBoxyWallet();
  const { privateKey } = wifToPrivateKey(wallet.wif);
  const signature = signBitcoinMessage(message, privateKey);
  const verified = verifyBitcoinMessage(message, signature.signatureHex, wallet.publicKey);

  return {
    message,
    address: wallet.address,
    legacyAddress: wallet.legacyAddress,
    publicKey: wallet.publicKey,
    signatureHex: signature.signatureHex,
    signatureBase64: signature.signatureBase64,
    signature: signature.signatureHex,
    verified
  };
}
