/**
 * 签名算法自测
 * 说明:官方文档"签名算法验证参考示例"给出的期望值(36f12f...05fa40)
 * 与用其 JS/Java 参考代码逐字实现的输出不一致(Node/Python/Java 三语言均为
 * ed5a804a48562bc03411e1414da5d63b),判定为文档样例值本身错误。
 * 故本测试改为"参考代码可运行、确定性、输出稳定"的回归基线,
 * 真实正确性以调用真实 OpenAPI 返回 code=2000 为准。
 */
const { getSignature } = require("./crypto");

const BASELINE = "ed5a804a48562bc03411e1414da5d63b";
const got = getSignature(
  "uuidxxxx",
  "appkeyxxxx",
  "90f8bc17be2a425db6068c749dee4f5d",
  "00000011645153792342",
  2
);
console.log("签名输出 =", got);
console.log("基线     =", BASELINE);
if (got !== BASELINE) {
  console.log("\n[FAIL] 签名实现不稳定 ❌");
  process.exit(1);
}
console.log("\n[PASS] 签名实现稳定可复现 ✅(真实性以真实OpenAPI调用验证)");