/**
 * 杰峰开放平台签名与时间戳算法
 * 依据:签名算法.pdf、时间戳算法.pdf
 */

const crypto = require("crypto");

// ===== 时间戳算法 =====
let counter = 0n;
function getCounter() {
  counter++;
  if (counter < 10n) return "000000" + counter.toString();
  if (counter < 100n) return "00000" + counter.toString();
  if (counter < 1000n) return "0000" + counter.toString();
  if (counter < 10000n) return "000" + counter.toString();
  if (counter < 100000n) return "00" + counter.toString();
  if (counter < 1000000n) return "0" + counter.toString();
  if (counter < 10000000n) return counter.toString();
  // 溢出重置
  counter = 1n;
  return "0000001";
}

function getTimeMillis() {
  return getCounter() + Date.now().toString();
}

// ===== 签名算法辅助函数 =====
function fnStr2Byte(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let char = str.charCodeAt(i);
    if (char >= 0x010000 && char <= 0x10ffff) {
      bytes.push(((char >> 18) & 0x07) | 0xf0);
      bytes.push(((char >> 12) & 0x3f) | 0x80);
      bytes.push(((char >> 6) & 0x3f) | 0x80);
      bytes.push((char & 0x3f) | 0x80);
    } else if (char >= 0x000800 && char <= 0x00ffff) {
      bytes.push(((char >> 12) & 0x0f) | 0xe0);
      bytes.push(((char >> 6) & 0x3f) | 0x80);
      bytes.push((char & 0x3f) | 0x80);
    } else if (char >= 0x000080 && char <= 0x0007ff) {
      bytes.push(((char >> 6) & 0x1f) | 0xc0);
      bytes.push((char & 0x3f) | 0x80);
    } else {
      bytes.push(char & 0xff);
    }
  }
  return bytes;
}

function fnChange(encryptStr, moveCard) {
  const arr = fnStr2Byte(encryptStr);
  const len = arr.length;
  // 注意:官方JS版是修改原数组,这里我们按逻辑来做
  for (let idx = 0; idx < len; idx++) {
    const condition = (idx % moveCard) > ((len - idx) % moveCard);
    let tmp;
    if (condition) {
      tmp = arr[idx];
    } else {
      tmp = arr[len - (idx + 1)];
    }
    arr[idx] = arr[len - (idx + 1)];
    arr[len - (idx + 1)] = tmp;
  }
  return arr;
}

function fnMerge(encryptByte, changeByte) {
  const len = encryptByte.length;
  const temp = new Array(len * 2);
  for (let i = 0; i < len; i++) {
    temp[i] = encryptByte[i];
    temp[len * 2 - 1 - i] = changeByte[i];
  }
  return temp;
}

function md5Hex(bytes) {
  const buf = Buffer.from(bytes);
  return crypto.createHash("md5").update(buf).digest("hex");
}

// ===== 主签名函数 =====
function getSignature(uuid, appKey, appSecret, timeMillis, moveCard) {
  const encryptStr = uuid + appKey + appSecret + timeMillis;
  const arrEncrypt = fnStr2Byte(encryptStr);
  const arrEncryptChange = fnChange(encryptStr, moveCard);
  const arrMerge = fnMerge(arrEncrypt, arrEncryptChange);
  return md5Hex(arrMerge);
}

module.exports = {
  getTimeMillis,
  getSignature,
  fnStr2Byte,
  fnChange,
  fnMerge,
};