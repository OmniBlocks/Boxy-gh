import crypto from "node:crypto";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/**
 * Encodes a buffer into Base58 format.
 * @param {Buffer} buffer - Data buffer to encode.
 * @returns {string} Base58-encoded string.
 */
export function base58Encode(buffer) {
  const digits = [0];
  for (let i = 0; i < buffer.length; i++) {
    for (let j = 0; j < digits.length; j++) {
      digits[j] <<= 8;
    }
    digits[0] += buffer[i];
    let carry = 0;
    for (let j = 0; j < digits.length; ++j) {
      digits[j] += carry;
      carry = (digits[j] / 58) | 0;
      digits[j] %= 58;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let leadingZeros = 0;
  for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
    leadingZeros++;
  }
  let result = "";
  for (let i = 0; i < leadingZeros; i++) {
    result += "1";
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    result += ALPHABET[digits[i]];
  }
  return result;
}

/**
 * Decodes a Base58-encoded string into a Buffer.
 * @param {string} string - Base58 string.
 * @returns {Buffer} Decoded buffer.
 */
export function base58Decode(string) {
  const bytes = [0];
  for (let i = 0; i < string.length; i++) {
    const char = string[i];
    const value = ALPHABET.indexOf(char);
    if (value === -1) {
      throw new Error(`Invalid Base58 character: ${char}`);
    }
    for (let j = 0; j < bytes.length; j++) {
      bytes[j] *= 58;
    }
    bytes[0] += value;
    let carry = 0;
    for (let j = 0; j < bytes.length; ++j) {
      bytes[j] += carry;
      carry = bytes[j] >> 8;
      bytes[j] &= 0xff;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeros = 0;
  for (let i = 0; i < string.length && string[i] === "1"; i++) {
    leadingZeros++;
  }
  const prefix = Buffer.alloc(leadingZeros, 0);
  return Buffer.concat([prefix, Buffer.from(bytes.reverse())]);
}

/**
 * Computes double SHA-256 hash of a buffer.
 * @param {Buffer} buffer - Input data.
 * @returns {Buffer} Double SHA-256 hash.
 */
export function doubleSha256(buffer) {
  const first = crypto.createHash("sha256").update(buffer).digest();
  return crypto.createHash("sha256").update(first).digest();
}

/**
 * Encodes payload into Base58Check with a version byte.
 * @param {Buffer} payload - Payload buffer.
 * @param {number} version - Network version byte.
 * @returns {string} Base58Check string.
 */
export function base58CheckEncode(payload, version = 0) {
  const versionBuffer = Buffer.from([version]);
  const data = Buffer.concat([versionBuffer, payload]);
  const checksum = doubleSha256(data).subarray(0, 4);
  return base58Encode(Buffer.concat([data, checksum]));
}

/**
 * Decodes and validates a Base58Check string.
 * @param {string} string - Base58Check string.
 * @returns {{ version: number, payload: Buffer }} Decoded version and payload.
 */
export function base58CheckDecode(string) {
  const decoded = base58Decode(string);
  if (decoded.length < 5) {
    throw new Error("Base58Check data too short");
  }
  const version = decoded[0];
  const payload = decoded.subarray(1, decoded.length - 4);
  const checksum = decoded.subarray(decoded.length - 4);
  const expectedChecksum = doubleSha256(decoded.subarray(0, decoded.length - 4)).subarray(0, 4);
  if (!checksum.equals(expectedChecksum)) {
    throw new Error("Invalid Base58Check checksum");
  }
  return { version, payload };
}

/**
 * Computes the internal Bech32 polymod checksum.
 * @param {number[]} values - Input 5-bit values.
 * @returns {number} Polymod result.
 */
function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((b >> i) & 1) {
        chk ^= GEN[i];
      }
    }
  }
  return chk;
}

/**
 * Expands human readable part for Bech32 checksum computation.
 * @param {string} hrp - Human readable part.
 * @returns {number[]} Expanded array.
 */
function hrpExpand(hrp) {
  const ret = [];
  for (let i = 0; i < hrp.length; i++) {
    ret.push(hrp.charCodeAt(i) >> 5);
  }
  ret.push(0);
  for (let i = 0; i < hrp.length; i++) {
    ret.push(hrp.charCodeAt(i) & 31);
  }
  return ret;
}

/**
 * Converts bit width between arrays of numbers.
 * @param {number[]|Buffer} data - Input data.
 * @param {number} fromBits - Source bit width.
 * @param {number} toBits - Target bit width.
 * @param {boolean} pad - Whether to pad trailing bits.
 * @returns {number[]|null} Converted bits array.
 */
export function convertBits(data, fromBits, toBits, pad) {
  let acc = 0;
  let bits = 0;
  const ret = [];
  const maxv = (1 << toBits) - 1;
  for (let i = 0; i < data.length; i++) {
    acc = (acc << fromBits) | data[i];
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) {
      ret.push((acc << (toBits - bits)) & maxv);
    }
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
    return null;
  }
  return ret;
}

/**
 * Encodes a Native SegWit address according to BIP-173.
 * @param {string} hrp - Human readable part ('bc' or 'tb').
 * @param {number} version - Witness version (0 for P2WPKH).
 * @param {Buffer|number[]} program - Witness program bytes.
 * @returns {string} SegWit address.
 */
export function encodeSegwitAddress(hrp, version, program) {
  const dataWords = convertBits(program, 8, 5, true);
  const words = [version, ...dataWords];
  const expandedHrp = hrpExpand(hrp);
  const checksumValues = [...expandedHrp, ...words, 0, 0, 0, 0, 0, 0];
  const mod = bech32Polymod(checksumValues) ^ 1;
  const checksum = [];
  for (let i = 0; i < 6; i++) {
    checksum.push((mod >> (5 * (5 - i))) & 31);
  }
  let address = `${hrp}1`;
  for (const b of [...words, ...checksum]) {
    address += BECH32_CHARSET[b];
  }
  return address;
}

/**
 * Decodes a Bech32 SegWit address according to BIP-173.
 * @param {string} address - SegWit address string.
 * @returns {{ hrp: string, version: number, program: Buffer }} Decoded SegWit data.
 */
export function decodeSegwitAddress(address) {
  const lower = address.toLowerCase();
  const sep = lower.lastIndexOf("1");
  if (sep < 1 || sep + 7 > lower.length || lower.length > 90) {
    throw new Error("Invalid Bech32 format or length");
  }
  const hrp = lower.substring(0, sep);
  const data = [];
  for (let i = sep + 1; i < lower.length; i++) {
    const idx = BECH32_CHARSET.indexOf(lower[i]);
    if (idx === -1) {
      throw new Error(`Invalid Bech32 character: ${lower[i]}`);
    }
    data.push(idx);
  }
  const expandedHrp = hrpExpand(hrp);
  const polymodCheck = bech32Polymod([...expandedHrp, ...data]);
  if (polymodCheck !== 1) {
    throw new Error("Invalid Bech32 checksum");
  }
  const version = data[0];
  const programWords = data.slice(1, -6);
  const programBits = convertBits(programWords, 5, 8, false);
  if (!programBits) {
    throw new Error("Failed to convert bits for witness program");
  }
  return {
    hrp,
    version,
    program: Buffer.from(programBits)
  };
}

/**
 * Computes RIPEMD-160(SHA-256(buffer)), commonly known as HASH160.
 * @param {Buffer} buffer - Input data buffer.
 * @returns {Buffer} 20-byte hash160.
 */
export function hash160(buffer) {
  const sha = crypto.createHash("sha256").update(buffer).digest();
  return crypto.createHash("ripemd160").update(sha).digest();
}

/**
 * Generates a secp256k1 keypair using Node.js crypto.
 * @returns {{ privateKeyHex: string, publicKeyHex: string, privateKeyBytes: Buffer, publicKeyBytes: Buffer }} Keypair data.
 */
export function generateSecp256k1KeyPair() {
  const ecdh = crypto.createECDH("secp256k1");
  ecdh.generateKeys();
  const privateKeyBytes = ecdh.getPrivateKey();
  const publicKeyBytes = ecdh.getPublicKey(null, "compressed");
  return {
    privateKeyHex: privateKeyBytes.toString("hex"),
    publicKeyHex: publicKeyBytes.toString("hex"),
    privateKeyBytes,
    publicKeyBytes
  };
}

/**
 * Derives the compressed public key from a secp256k1 private key.
 * @param {Buffer|string} privateKey - 32-byte private key.
 * @returns {Buffer} Compressed public key buffer.
 */
export function getPublicKeyFromPrivateKey(privateKey) {
  const privBuf = Buffer.isBuffer(privateKey) ? privateKey : Buffer.from(privateKey, "hex");
  const ecdh = crypto.createECDH("secp256k1");
  ecdh.setPrivateKey(privBuf);
  return ecdh.getPublicKey(null, "compressed");
}

/**
 * Encodes a private key into standard Bitcoin WIF format.
 * @param {Buffer|string} privateKey - 32-byte private key.
 * @param {string} network - 'mainnet' or 'testnet'.
 * @returns {string} WIF-encoded string.
 */
export function privateKeyToWif(privateKey, network = "mainnet") {
  const privBuf = Buffer.isBuffer(privateKey) ? privateKey : Buffer.from(privateKey, "hex");
  const version = network === "testnet" ? 0xef : 0x80;
  const payload = Buffer.concat([privBuf, Buffer.from([0x01])]);
  return base58CheckEncode(payload, version);
}

/**
 * Decodes a Bitcoin WIF private key.
 * @param {string} wif - WIF string.
 * @returns {{ privateKey: Buffer, network: string, compressed: boolean }} Decoded key.
 */
export function wifToPrivateKey(wif) {
  const { version, payload } = base58CheckDecode(wif);
  const network = version === 0xef ? "testnet" : "mainnet";
  const compressed = payload.length === 33 && payload[32] === 0x01;
  const privateKey = compressed ? payload.subarray(0, 32) : payload;
  return { privateKey, network, compressed };
}

/**
 * Derives a Legacy P2PKH address from a public key.
 * @param {Buffer|string} publicKey - Public key buffer or hex string.
 * @param {string} network - 'mainnet' or 'testnet'.
 * @returns {string} P2PKH address.
 */
export function publicKeyToLegacyAddress(publicKey, network = "mainnet") {
  const pubBuf = Buffer.isBuffer(publicKey) ? publicKey : Buffer.from(publicKey, "hex");
  const h160 = hash160(pubBuf);
  const version = network === "testnet" ? 0x6f : 0x00;
  return base58CheckEncode(h160, version);
}

/**
 * Derives a Native SegWit P2WPKH address from a public key.
 * @param {Buffer|string} publicKey - Public key buffer or hex string.
 * @param {string} network - 'mainnet' or 'testnet'.
 * @returns {string} SegWit address.
 */
export function publicKeyToSegwitAddress(publicKey, network = "mainnet") {
  const pubBuf = Buffer.isBuffer(publicKey) ? publicKey : Buffer.from(publicKey, "hex");
  const h160 = hash160(pubBuf);
  const hrp = network === "testnet" ? "tb" : "bc";
  return encodeSegwitAddress(hrp, 0, h160);
}

/**
 * Validates a Bitcoin address format.
 * @param {string} address - Address string to validate.
 * @returns {{ valid: boolean, type?: string, network?: string, error?: string }} Validation result.
 */
export function validateBitcoinAddress(address) {
  if (typeof address !== "string" || address.trim().length === 0) {
    return { valid: false, error: "Address cannot be empty" };
  }
  const clean = address.trim();

  if (clean.startsWith("bc1") || clean.startsWith("tb1")) {
    try {
      const decoded = decodeSegwitAddress(clean);
      const network = decoded.hrp === "bc" ? "mainnet" : "testnet";
      const type = decoded.program.length === 20 ? "P2WPKH (Native SegWit)" : "P2WSH/P2TR (Native SegWit)";
      return { valid: true, type, network };
    } catch (err) {
      return { valid: false, error: `Invalid SegWit address: ${err.message}` };
    }
  }

  try {
    const { version, payload } = base58CheckDecode(clean);
    if (payload.length !== 20) {
      return { valid: false, error: "Invalid Base58Check payload length" };
    }
    if (version === 0x00) {
      return { valid: true, type: "P2PKH (Legacy)", network: "mainnet" };
    }
    if (version === 0x05) {
      return { valid: true, type: "P2SH", network: "mainnet" };
    }
    if (version === 0x6f) {
      return { valid: true, type: "P2PKH (Legacy)", network: "testnet" };
    }
    if (version === 0xc4) {
      return { valid: true, type: "P2SH", network: "testnet" };
    }
    return { valid: false, error: `Unrecognized Base58 version byte: ${version}` };
  } catch (err) {
    return { valid: false, error: `Invalid Bitcoin address format: ${err.message}` };
  }
}

const SECP256K1_P = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F");

/**
 * Computes modular exponentiation for BigInt.
 * @param {bigint} base - Base number.
 * @param {bigint} exp - Exponent.
 * @param {bigint} mod - Modulus.
 * @returns {bigint} Result.
 */
function modPow(base, exp, mod) {
  let res = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp % 2n === 1n) {
      res = (res * base) % mod;
    }
    base = (base * base) % mod;
    exp /= 2n;
  }
  return res;
}

/**
 * Decompresses a 33-byte secp256k1 public key into x and y coordinates.
 * @param {Buffer} compPub - Compressed public key buffer.
 * @returns {{ x: Buffer, y: Buffer }} Coordinates.
 */
export function decompressPublicKey(compPub) {
  if (compPub.length === 65 && compPub[0] === 0x04) {
    return {
      x: compPub.subarray(1, 33),
      y: compPub.subarray(33, 65)
    };
  }
  if (compPub.length !== 33 || (compPub[0] !== 0x02 && compPub[0] !== 0x03)) {
    throw new Error("Invalid compressed public key format");
  }
  const prefix = compPub[0];
  const x = BigInt(`0x${compPub.subarray(1, 33).toString("hex")}`);
  const ySq = (modPow(x, 3n, SECP256K1_P) + 7n) % SECP256K1_P;
  let y = modPow(ySq, (SECP256K1_P + 1n) / 4n, SECP256K1_P);
  const isEven = prefix === 0x02;
  if ((y % 2n === 0n) !== isEven) {
    y = SECP256K1_P - y;
  }
  const xBuf = Buffer.from(x.toString(16).padStart(64, "0"), "hex");
  const yBuf = Buffer.from(y.toString(16).padStart(64, "0"), "hex");
  return { x: xBuf, y: yBuf };
}

/**
 * Signs an arbitrary message using a secp256k1 private key.
 * @param {string} message - Text message to sign.
 * @param {Buffer|string} privateKey - 32-byte private key.
 * @returns {{ signatureHex: string, signatureBase64: string }} Signature representations.
 */
export function signBitcoinMessage(message, privateKey) {
  const privBuf = Buffer.isBuffer(privateKey) ? privateKey : Buffer.from(privateKey, "hex");
  const ecdh = crypto.createECDH("secp256k1");
  ecdh.setPrivateKey(privBuf);
  const pub = ecdh.getPublicKey();
  const x = pub.subarray(1, 33);
  const y = pub.subarray(33, 65);

  const privKeyObject = crypto.createPrivateKey({
    key: {
      kty: "EC",
      crv: "secp256k1",
      d: privBuf.toString("base64url"),
      x: x.toString("base64url"),
      y: y.toString("base64url")
    },
    format: "jwk"
  });
  const signer = crypto.createSign("SHA256");
  signer.update(Buffer.from(message, "utf-8"));
  const sig = signer.sign(privKeyObject);
  return {
    signatureHex: sig.toString("hex"),
    signatureBase64: sig.toString("base64")
  };
}

/**
 * Verifies a message signature using a secp256k1 public key.
 * @param {string} message - Original text message.
 * @param {Buffer|string} signature - Signature buffer or hex/base64 string.
 * @param {Buffer|string} publicKey - Public key buffer or hex string.
 * @returns {boolean} True if signature is valid.
 */
export function verifyBitcoinMessage(message, signature, publicKey) {
  try {
    const pubBuf = Buffer.isBuffer(publicKey) ? publicKey : Buffer.from(publicKey, "hex");
    const { x, y } = decompressPublicKey(pubBuf);
    const pubKeyObject = crypto.createPublicKey({
      key: {
        kty: "EC",
        crv: "secp256k1",
        x: x.toString("base64url"),
        y: y.toString("base64url")
      },
      format: "jwk"
    });
    const sigBuf = Buffer.isBuffer(signature)
      ? signature
      : signature.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(signature)
        ? Buffer.from(signature, "hex")
        : Buffer.from(signature, "base64");
    const verifier = crypto.createVerify("SHA256");
    verifier.update(Buffer.from(message, "utf-8"));
    return verifier.verify(pubKeyObject, sigBuf);
  } catch {
    return false;
  }
}

/**
 * Queries a public Bitcoin explorer to retrieve balance and UTXO stats.
 * @param {string} address - Bitcoin address.
 * @param {string} network - 'mainnet' or 'testnet'.
 * @param {number} timeoutMs - Request timeout in milliseconds.
 * @returns {Promise<{ address: string, balanceSatoshis: number, balanceBtc: string, txCount: number, fundedSatoshis: number, spentSatoshis: number, network: string, explorerUrl: string }>} Balance details.
 */
export async function fetchAddressBalance(address, network = "mainnet", timeoutMs = 7000) {
  const isTestnet = network === "testnet";
  const baseUrl = isTestnet
    ? "https://mempool.space/testnet/api/address"
    : "https://mempool.space/api/address";
  const explorerUrl = isTestnet
    ? `https://mempool.space/testnet/address/${address}`
    : `https://mempool.space/address/${address}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/${address}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" }
    });
    if (!res.ok) {
      throw new Error(`Explorer returned HTTP ${res.status}`);
    }
    const data = await res.json();
    const chainStats = data.chain_stats || {};
    const mempoolStats = data.mempool_stats || {};
    const funded = (chainStats.funded_txo_sum || 0) + (mempoolStats.funded_txo_sum || 0);
    const spent = (chainStats.spent_txo_sum || 0) + (mempoolStats.spent_txo_sum || 0);
    const balanceSatoshis = Math.max(0, funded - spent);
    const balanceBtc = (balanceSatoshis / 1e8).toFixed(8);
    const txCount = (chainStats.tx_count || 0) + (mempoolStats.tx_count || 0);

    return {
      address,
      network,
      balanceSatoshis,
      balanceBtc,
      txCount,
      fundedSatoshis: funded,
      spentSatoshis: spent,
      explorerUrl
    };
  } catch (err) {
    return {
      address,
      network,
      balanceSatoshis: 0,
      balanceBtc: "0.00000000",
      txCount: 0,
      fundedSatoshis: 0,
      spentSatoshis: 0,
      explorerUrl,
      queryWarning: `Unable to query live explorer: ${err.message}`
    };
  } finally {
    clearTimeout(timer);
  }
}
