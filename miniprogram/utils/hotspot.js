/**
 * 摄像头热点检测工具
 * 用于：用户连上摄像头WiFi热点后，小程序自动识别并引导绑定流程
 */

// 摄像头热点 SSID 匹配规则
const CAMERA_PATTERNS = [
  /^IPC[-_ ]/i,
  /^JF[-_ ]/i,
  /^_JF/i,
  /^CAM[-_ ]/i,
  /^DVR[-_ ]/i,
  /^NVR[-_ ]/i,
  /^EZVIZ/i,
  /^Hikvision/i,
  /^Imou/i,
  /^Tapo/i,
  /camera/i,
  /wireless[-_]?cam/i
]

// 摄像头 MAC OUI
const CAMERA_OUIS = [
  'CC:81:DA','7C:7A:91','9C:54:DA','50:C7:BF',
  'AC:84:C6','E8:48:B8','64:64:4A','28:6C:07',
  '00:18:DD','A4:77:33','78:D3:81','FC:CF:62'
]

/**
 * 判断当前环境是否支持 WiFi API
 */
function isSupported() {
  return typeof wx !== 'undefined' && typeof wx.getWifiList === 'function'
}

function canReadConnectedWifi() {
  return typeof wx !== 'undefined'
    && typeof wx.startWifi === 'function'
    && typeof wx.getConnectedWifi === 'function'
}

/**
 * 判断一个 WiFi 是否是摄像头热点
 */
function isCameraHotspot(ssid, bssid) {
  let confidence = 0
  for (const p of CAMERA_PATTERNS) {
    if (p.test(ssid || '')) { confidence += 60; break }
  }
  const oui = (bssid || '').substring(0, 8).toUpperCase()
  if (CAMERA_OUIS.includes(oui)) { confidence += 30 }
  return {
    isCamera: confidence >= 40,
    confidence: Math.min(confidence, 100),
    ssid, bssid
  }
}

/**
 * 扫描附近 WiFi，返回识别出的摄像头热点列表
 * callback(err, matchedList)
 */
function scan(callback) {
  if (!isSupported()) return callback({ errMsg: '不支持WiFi扫描' }, null)
  wx.startWifi({
    success: () => {
      wx.getWifiList({
        success: () => {
          const handler = (res) => {
            wx.offGetWifiList(handler)
            if (!res || !res.wifiList) return callback(null, [])
            const list = res.wifiList
              .map(w => ({ ...isCameraHotspot(w.SSID, w.BSSID), ssid: w.SSID, bssid: w.BSSID, signal: w.signalStrength || 0 }))
              .filter(w => w.isCamera)
              .sort((a, b) => b.confidence - a.confidence)
            callback(null, list)
          }
          wx.onGetWifiList(handler)
        },
        fail: callback
      })
    },
    fail: callback
  })
}

/**
 * 检测当前已连接的 WiFi 是否是摄像头热点
 */
function checkConnected() {
  return new Promise((resolve) => {
    if (!canReadConnectedWifi()) {
      return resolve({ connected: false, ssid: '', bssid: '', confidence: 0 })
    }
    wx.startWifi({
      success: () => {
        wx.getConnectedWifi({
          partialInfo: false,
          success: (res) => {
            const wifi = res.wifi || {}
            const check = isCameraHotspot(wifi.SSID, wifi.BSSID)
            resolve({
              connected: check.isCamera,
              ssid: wifi.SSID || '',
              bssid: wifi.BSSID || '',
              confidence: check.confidence
            })
          },
          fail: () => resolve({ connected: false, ssid: '', bssid: '', confidence: 0 })
        })
      },
      fail: () => resolve({ connected: false, ssid: '', bssid: '', confidence: 0 })
    })
  })
}

/**
 * 打开系统 WiFi 设置
 */
function openWifiSettings() {
  wx.openSystemSetting({ success: () => {} })
}

/**
 * 停止 WiFi 扫描
 */
function stopScan() {
  try { wx.stopWifi({}) } catch (e) {}
}

export default {
  isSupported,
  isCameraHotspot,
  scan,
  checkConnected,
  openWifiSettings,
  stopScan
}
