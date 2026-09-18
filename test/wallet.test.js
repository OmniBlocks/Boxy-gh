import { describe, test, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import {
  generateSecp256k1KeyPair,
  getPublicKeyFromPrivateKey,
  publicKeyToSegwitAddress,
  publicKeyToLegacyAddress,
  privateKeyToWif,
  wifToPrivateKey,
  signBitcoinMessage,
  verifyBitcoinMessage,
  base58CheckEncode,
  base58CheckDecode,
  encodeSegwitAddress,
  decodeSegwitAddress
} from "../src/bitcoin.js";
import {
  initBoxyWallet,
  getBoxyWallet,
  signWithBoxyWallet
} from "../src/wallet.js";
import { executeTool } from "../src/tools.js";
import { WALLET_FILE } from "../src/fs.js";

describe("Bitcoin Cryptographic Primitives", () => {
  test("Base58Check encode and decode round-trip", () => {
    const payload = Buffer.from("hello bitcoin world", "utf8");
    const encoded = base58CheckEncode(payload, 0x00);
    const decoded = base58CheckDecode(encoded);
    assert.strictEqual(decoded.version, 0x00);
    assert.deepStrictEqual(decoded.payload, payload);
  });

  test("Base58Check throws on corrupted checksum", () => {
    const payload = Buffer.from("tamper test", "utf8");
    const encoded = base58CheckEncode(payload, 0x00);
    const corrupted = encoded.slice(0, -1) + (encoded.endsWith("A") ? "B" : "A");
    assert.throws(() => base58CheckDecode(corrupted));
  });

  test("BIP-173 Bech32 matches official SegWit test vector", () => {
    const hash160Buffer = Buffer.from("751e76e8199196d454941c45d1b3a323f1433bd6", "hex");
    const p2wpkh = encodeSegwitAddress("bc", 0, hash160Buffer);
    assert.strictEqual(p2wpkh, "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");

    const decoded = decodeSegwitAddress(p2wpkh);
    assert.strictEqual(decoded.hrp, "bc");
    assert.strictEqual(decoded.version, 0);
    assert.deepStrictEqual(decoded.program, hash160Buffer);
  });

  test("P2PKH matches official generator point test vector", () => {
    const hash160Buffer = Buffer.from("751e76e8199196d454941c45d1b3a323f1433bd6", "hex");
    const p2pkh = base58CheckEncode(hash160Buffer, 0x00);
    assert.strictEqual(p2pkh, "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH");
  });

  test("WIF export matches official private key 0x01 vector", () => {
    const key1 = Buffer.alloc(32);
    key1[31] = 0x01;
    const wif = privateKeyToWif(key1, "mainnet");
    assert.strictEqual(wif, "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn");

    const parsed = wifToPrivateKey(wif);
    assert.deepStrictEqual(parsed.privateKey, key1);
    assert.strictEqual(parsed.network, "mainnet");
    assert.strictEqual(parsed.compressed, true);
  });

  test("Keypair generation derives valid compressed public key and addresses", () => {
    const keypair = generateSecp256k1KeyPair();
    const priv = keypair.privateKeyBytes;
    assert.strictEqual(priv.length, 32);

    const pub = getPublicKeyFromPrivateKey(priv);
    assert.strictEqual(pub.length, 33);
    assert.ok(pub[0] === 0x02 || pub[0] === 0x03);

    const segwit = publicKeyToSegwitAddress(pub, "mainnet");
    assert.ok(segwit.startsWith("bc1q"));

    const legacy = publicKeyToLegacyAddress(pub, "mainnet");
    assert.ok(legacy.startsWith("1"));
  });

  test("ECDSA message signing and verification", () => {
    const keypair = generateSecp256k1KeyPair();
    const priv = keypair.privateKeyBytes;
    const pub = keypair.publicKeyBytes;
    const message = "Boxy Bitcoin Wallet Proof of Ownership";

    const { signatureHex } = signBitcoinMessage(message, priv);
    assert.ok(typeof signatureHex === "string");
    assert.ok(signatureHex.length > 0);

    const isValid = verifyBitcoinMessage(message, signatureHex, pub);
    assert.strictEqual(isValid, true);

    const isTamperedValid = verifyBitcoinMessage("Tampered Message", signatureHex, pub);
    assert.strictEqual(isTamperedValid, false);
  });
});

describe("Boxy Autonomous Wallet Service", () => {
  let originalWalletBackup = null;

  before(async () => {
    try {
      originalWalletBackup = await fs.readFile(WALLET_FILE, "utf8");
    } catch {
      originalWalletBackup = null;
    }
  });

  after(async () => {
    if (originalWalletBackup) {
      await fs.writeFile(WALLET_FILE, originalWalletBackup, "utf8");
    } else {
      try {
        await fs.unlink(WALLET_FILE);
      } catch {}
    }
  });

  test("Initializes wallet and saves to disk", async () => {
    try {
      await fs.unlink(WALLET_FILE);
    } catch {}

    const wallet = await initBoxyWallet();
    assert.ok(wallet.address.startsWith("bc1q"));
    assert.ok(wallet.legacyAddress.startsWith("1"));
    assert.ok(wallet.publicKey);
    assert.ok(wallet.wif);

    const fileContent = await fs.readFile(WALLET_FILE, "utf8");
    const parsed = JSON.parse(fileContent);
    assert.strictEqual(parsed.address, wallet.address);
  });

  test("getBoxyWallet reuses persisted wallet without regeneration", async () => {
    const firstCall = await getBoxyWallet({ fetchBalance: false });
    const secondCall = await getBoxyWallet({ fetchBalance: false });
    assert.strictEqual(firstCall.address, secondCall.address);
    assert.strictEqual(firstCall.legacyAddress, secondCall.legacyAddress);
    assert.strictEqual(firstCall.publicKey, secondCall.publicKey);
  });

  test("signWithBoxyWallet signs and verifies statement", async () => {
    const wallet = await getBoxyWallet({ fetchBalance: false });
    const statement = "I am Boxy, autonomous mascot of OmniBlocks.";
    const result = await signWithBoxyWallet(statement);

    assert.strictEqual(result.address, wallet.address);
    assert.strictEqual(result.message, statement);
    assert.strictEqual(result.verified, true);

    const pubKeyBuf = Buffer.from(wallet.publicKey, "hex");
    const isManualValid = verifyBitcoinMessage(statement, result.signature, pubKeyBuf);
    assert.strictEqual(isManualValid, true);
  });
});

describe("Boxy Tool Dispatcher Integration", () => {
  const fakeContext = {
    repo: () => ({ owner: "OmniBlocks", repo: "Boxy-gh" })
  };

  test("get_bitcoin_wallet returns wallet information", async () => {
    const toolCall = {
      name: "get_bitcoin_wallet",
      args: { fetch_balance: false }
    };
    const result = await executeTool(toolCall, fakeContext, null, [], "MEMBER");
    assert.ok(result.address.startsWith("bc1q"));
    assert.ok(result.legacyAddress.startsWith("1"));
    assert.strictEqual(result.network, "mainnet");
    assert.ok(result.explorerUrl.includes("mempool.space"));
  });

  test("check_bitcoin_balance checks address", async () => {
    const toolCall = {
      name: "check_bitcoin_balance",
      args: { address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", network: "mainnet" }
    };
    const result = await executeTool(toolCall, fakeContext, null, [], "NONE");
    assert.strictEqual(result.address, "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
    assert.strictEqual(result.network, "mainnet");
  });

  test("sign_bitcoin_message blocks unauthenticated callers", async () => {
    const toolCall = {
      name: "sign_bitcoin_message",
      args: { message: "Malicious command execution request" }
    };
    const result = await executeTool(toolCall, fakeContext, null, [], "NONE");
    assert.strictEqual(result.blocked, true);
    assert.ok(result.error.includes("Permission denied"));
  });

  test("sign_bitcoin_message permits authorized members", async () => {
    const toolCall = {
      name: "sign_bitcoin_message",
      args: { message: "Official release confirmation" }
    };
    const result = await executeTool(toolCall, fakeContext, null, [], "MEMBER");
    assert.strictEqual(result.verified, true);
    assert.ok(result.signature.length > 0);
  });
});
