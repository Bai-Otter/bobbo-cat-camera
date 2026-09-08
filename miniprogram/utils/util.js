// 格式化时间
export const formatTime = (date) => {
	const year = date.getFullYear();
	const month = date.getMonth() + 1;
	const day = date.getDate();
	const hour = date.getHours();
	const minute = date.getMinutes();
	const second = date.getSeconds();
	return `${[year, month, day].map(formatNumber).join('/')} ${[hour, minute, second].map(formatNumber).join(':')}`;
};
export const formatDate = (date, start = false, end = false) => {
	const year = date.getFullYear();
	const month = date.getMonth() + 1;
	const day = date.getDate();
	const hour = date.getHours();
	const minute = date.getMinutes();
	const second = date.getSeconds();
	if (start) {
		return `${[year, month, day].map(formatNumber).join('-')} 00:00:00`;
	}
	if (end) {
		return `${[year, month, day].map(formatNumber).join('-')} 23:59:59`;
	}
	return `${[year, month, day].map(formatNumber).join('-')} ${[hour, minute, second].map(formatNumber).join(':')}`;
};
const formatNumber = (n) => {
	n = n.toString();
	return n[1] ? n : `0${n}`;
};
// 设备状态判断
export function getStatus(status) {
	//在线 休眠 深度休眠 准备休眠中 离线
	let json = {
		'online': '在线',
		'dormancy': '浅休眠',
		'sleeping': '准备休眠中',
		'deep': '深度休眠',
		'offLine': '离线',
	}
	let state = status.status === 'online' ?
		(status.wakeUpStatus === '0' ?
			(status.wakeUpEnable === '0' ? 'deep' : 'dormancy') :
			status.wakeUpStatus === '2' ? 'sleeping' : 'online') :
		'offLine'
	let data = {
		status: state,
		statusDesc: json[state]
	}
	return data
};
//提示语
export function showMsg(title) {
	uni.showToast({
		title: title,
		icon: 'none'
	})
}
// ArrayBuffer转16进度字符串示例
export function ab2hex(buffer) {
	const hexArr = Array.prototype.map.call(
		new Uint8Array(buffer),
		function(bit) {
			return ('00' + bit.toString(16)).slice(-2)
		}
	)
	return hexArr.join('')
}
// 16进制字符串转IP地址
export function hexStringToIP(hexString) {
	let parts = ''
	if (hexString.includes('0x')) {
		let hexStr = hexString.substring(2)
		parts = hexStr.match(/.{1,2}/g);
	} else {
		parts = hexString.match(/.{1,2}/g);
	}
	const ipParts = parts.map(part => parseInt(part, 16)); // 将每组字符转换为十进制数字  
	return ipParts.join('.'); // 连接数字并添加点号分隔符  
}


export function getParameter(name) {
	let data = {}
	// 查询设备日志
	if (name == 'OPLogQuery') {
		data = {
			"Name": name,
			"OPLogQuery": {
				"Type": "LogAll",
				"LogPosition": 0,
				"BeginTime": formatDate(new Date(), true),
				"EndTime": formatDate(new Date(), false, true)
			},

		}
	}
	// 清空设备日志
	if (name == 'OPLogManager') {
		data = {
			"Name": name,
			"OPLogManager": {
				"Action": "RemoveAll"
			}
		}
	}
	// 系统时间查询
	if (name == 'OPTimeQuery') {
		data = {
			"Name": name,
		}
	}
	// 同步系统时间
	if (name == 'OPTimeSetting') {
		data = {
			"Name": name,
			"OPTimeSetting": formatDate(new Date())
		}
	}
	// 同步UTC时间
	if (name == 'OPUTCTimeSetting') {
		data = {
			"Name": name,
			"OPUTCTimeSetting": formatDate(new Date())
		}
	}
	return data
}
export function APIList(hexString) {
	let list = [{
			id: 'account',
			name: '账号管理',
			open: false,
			pages: [{
					name: '手机号注册',
					id: 'selfWechatRegister'
				},
				{
					name: '登录',
					id: 'selfWechatLogin'
				},
				// {name:'手机短信重置密码',id:'phoneResetPassword'},
			]
		}, {
			id: 'deviceInfo',
			name: '获取设备信息',
			open: false,
			pages: [{
				name: '获取4G信号信息',
				id: '4GInfo'
			}, {
				name: '获取NVR全通道RTMP信息',
				id: 'NetWork.RTMPALL'
			}, {
				name: '磁盘管理',
				id: 'StorageInfo'
			}]
		}, {
			id: 'ability',
			name: '获取设备能力集',
			open: false,
			pages: [{
				name: '系统能力',
				id: 'SystemFunction '
			}, {
				name: '编码能力',
				id: 'EncodeCapability'
			}, {
				name: '区域遮挡能力',
				id: 'BlindCapability'
			}, {
				name: '移动侦测属性能力',
				id: 'MotionArea'
			}, {
				name: '摄像机参数能力',
				id: 'Camera'
			}, {
				name: '对讲音频属性能力',
				id: 'TalkAudioFormat'
			}, {
				name: '支持语言能力',
				id: 'MultiLanguage'
			}, {
				name: '智能分析能力',
				id: 'Intelligent'
			}]
		}, {
			id: 'mediaConfig',
			name: '媒体组件配置',
			open: false,
			pages: [{
				name: '编码配置',
				id: 'AVEnc.Encode'
			}, {
				name: '录像配置',
				id: 'Record'
			}, {
				name: '视频遮挡配置',
				id: 'Detect.BlindDetect',
				config: ''
			}, {
				name: '视频丢失配置',
				id: 'Detect.LossDetect'
			}, {
				name: '移动侦测配置',
				id: 'Detect.MotionDetect'
			}, {
				name: '设备通道配置',
				id: 'ChannelTitle'
			}]
		}, {
			id: 'serialPortConfig',
			name: '串口组件配置',
			open: false,
			pages: [{
				name: '外部报警设置',
				id: 'Alarm.LocalAlarm '
			}, {
				name: '报警输出配置',
				id: 'Alarm.AlarmOut'
			}, {
				name: '串口配置',
				id: 'Uart.Comm'
			}, {
				name: '外接云台配置',
				id: 'Uart.PTZ'
			}, {
				name: '外接云台预置点配置',
				id: 'Uart.PTZPreset'
			}]
		}, {
			id: 'networkConfig',
			name: '网络组件配置',
			open: false,
			pages: [{
				name: '网络基础配置',
				id: 'NetWork.NetCommon '
			}, {
				name: '动态域名解析配置',
				id: 'NetWork.NetDDNS'
			}, {
				name: '网络时间同步服务器相关配置',
				id: '"NetWork.NetNTP'
			}, {
				name: 'DNS配置',
				id: 'NetWork.NetDNS'
			}, {
				name: '主动注册',
				id: 'NetWork.NetNTP'
			}, {
				name: '手机推送功能',
				id: 'NetWork.PMS'
			}, {
				name: 'Wifi配置',
				id: 'NetWork.Wifi'
			}]
		}, {
			id: 'captureConfig',
			name: '抓图&存储组件配置',
			open: false,
			pages: [{
				name: '存储相关配置',
				id: 'Storage.StoragePosition'
			}, {
				name: '抓图配置',
				id: 'Storage.Snapshot'
			}]
		}, {
			id: 'generalConfig',
			name: '设备通用配置',
			open: false,
			pages: [{
				name: '通用配置',
				id: 'General.General '
			}, {
				name: '时区/时间格式配置',
				id: 'General.Location'
			}, {
				name: '获取网络连接状态信',
				id: 'Status.NatInfo'
			}]
		}, {
			id: 'cameraConfig',
			name: '摄像机参数',
			open: false,
			pages: [{
				name: '基本参数',
				id: 'Camera.Param'
			}, {
				name: '扩展功能参数',
				id: 'Camera.ParamEx'
			}, {
				name: '报警音',
				id: 'Ability.VoiceTipType'
			}]
		}, {
			id: 'opdev',
			name: '设备控制',
			open: false,
			pages: [{
				name: '查询设备日志',
				id: 'OPLogQuery'
			}, {
				name: '清空设备日志',
				id: 'OPLogManager'
			}, {
				name: '系统时间查询',
				id: 'OPTimeQuery'
			}, {
				name: '同步系统时间',
				id: 'OPTimeSetting'
			}, {
				name: '同步UTC时间',
				id: 'OPUTCTimeSetting'
			}]
		}, {
			id: 'lowPowerConfig',
			name: '低功耗设备控制',
			open: false,
			pages: [{
				name: '灯光模式',
				id: 'Dev.LP4GLedParameter'
			}, {
				name: '工作模式',
				id: 'LPDev.WorkMode'
			}]
		}, {
			id: 'tailoredConfig',
			name: '低功耗设备配置',
			open: false,
			pages: [{
				name: '获取离线服务配置',
				id: 'getTailoredConfig'
			}, {
				name: '设置设备离线配置',
				id: 'setTailoredConfig'
			}]
		}, {
			id: 'IoT',
			name: 'IoT功能',
			open: false,
			pages: [{
				name: '喂食器',
				id: 'feeder'
			}, {
				name: '智能门锁',
				id: 'lock'
			}]
		},{
			id: 'twecall',
			name: '微信视频电话功能',
			open: false,
			pages: [{
				name: '微信视频电话',
				id: 'twecall'
			}]
		}


	]
	return list
}
