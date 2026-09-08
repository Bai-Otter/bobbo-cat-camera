/**
 * 杰峰 OpenAPI HTTP 封装
 * - 自动注入签名相关 Header (uuid/appKey/timeMillis/signature)
 * - 基于 https 原生模块,无额外依赖
 */
const https = require("https");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { getTimeMillis, getSignature } = require("./crypto");

function getHttpsProxyUrl(env = process.env) {
  return String(
    env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || ""
  ).trim().slice(0, 2048);
}

function buildRequestOptions({ endpoint, path, auth, timeMillis, proxyUrl = getHttpsProxyUrl() }) {
  const options = {
    hostname: endpoint,
    port: 443,
    path,
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "uuid": auth.uuid,
      "appKey": auth.appKey,
      "timeMillis": timeMillis,
      "signature": auth.signature,
    },
  };
  if (proxyUrl) options.agent = new HttpsProxyAgent(proxyUrl);
  return options;
}

/**
 * 发送带签名的 POST 请求到杰峰 OpenAPI
 * @param {object} opts
 * @param {string} opts.endpoint - 如 api-cn.jftechws.com
 * @param {string} opts.path     - 如 /gwp/v3/rtc/device/bind
 * @param {object} opts.auth     - {uuid, appKey, appSecret, moveCard}
 * @param {object} [opts.body]   - 请求体对象(会 JSON 序列化)
 * @returns {Promise<{code:number, msg:string, data:any}>}
 */
async function jfPost(opts) {
  const { endpoint, path, auth, body } = opts;
  const { uuid, appKey, appSecret, moveCard } = auth;

  const timeMillis = getTimeMillis();
  const signature = getSignature(uuid, appKey, appSecret, timeMillis, Number(moveCard));

  const bodyStr = body ? JSON.stringify(body) : "{}";

  return new Promise((resolve, reject) => {
    const requestOptions = buildRequestOptions({
      endpoint,
      path,
      auth: { uuid, appKey, signature },
      timeMillis,
    });
    const req = https.request(
      requestOptions,
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (e) {
            reject(new Error("响应 JSON 解析失败: " + e.message + "\n原始内容: " + data));
          }
        });
      }
    );
    req.on("error", (e) => reject(new Error("请求失败: " + e.message)));
    req.write(bodyStr);
    req.end();
  });
}

/**
 * 发送带签名的 POST 请求(路径带 deviceToken)
 * @param {object} opts
 * @param {string} opts.endpoint
 * @param {string} opts.pathTemplate - 如 /gwp/v3/rtc/device/login/{deviceToken}
 * @param {string} opts.deviceToken
 * @param {object} opts.auth
 * @param {object} [opts.body]
 */
async function jfPostWithToken(opts) {
  const path = opts.pathTemplate.replace("{deviceToken}", opts.deviceToken);
  return jfPost({ ...opts, path });
}

module.exports = {
  buildRequestOptions,
  getHttpsProxyUrl,
  jfPost,
  jfPostWithToken,
};
