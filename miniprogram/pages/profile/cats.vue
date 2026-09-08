<template>
	<view class="cats-page">
		<bobbo-nav-bar title="猫咪档案" title-align="left" />

		<view class="cats-content">
			<view class="archive-intro">
				<text class="archive-title">家庭猫咪</text>
				<text class="archive-meta">自己的档案可编辑，共享档案由设备主人维护</text>
			</view>

			<view v-for="cat in cats" :key="catKey(cat)" :data-profile-key="catKey(cat)" class="cat-card" @click="openExistingCat">
				<image class="cat-card-avatar" :src="cat.avatar || defaultAvatar" mode="aspectFill" />
				<view class="cat-card-copy">
					<view class="cat-title-line">
						<text class="cat-card-name">{{ cat.name }}</text>
						<text v-if="cat.source === 'shared'" class="demo-tag">共享查看</text>
						<text v-else-if="cat.demo" class="demo-tag">演示数据</text>
					</view>
					<text class="cat-detail">{{ displayAge(cat) || '年龄未填' }} · {{ cat.breed || '品种未填' }} · {{ cat.sex || '性别未填' }}</text>
					<text v-if="cat.health" class="health-detail">健康记录 · {{ cat.health }}</text>
					<view class="recognition-line">
						<view class="status-dot" :class="{ pending: cat.statusTone === 'pending' }"></view>
						<text class="recognition-status" :class="{ pending: cat.statusTone === 'pending' }">{{ cat.status || '待补充猫脸' }}</text>
					</view>
				</view>
				<text class="card-arrow">›</text>
			</view>

			<view class="add-row" @click="openNewCat">
				<view class="add-row-icon"><text>＋</text></view>
				<view class="add-row-copy">
					<text class="add-row-title">添加猫咪</text>
					<text class="add-row-note">新建一份自己的猫咪档案</text>
				</view>
			</view>
		</view>

		<view v-if="editorVisible" class="editor-mask" @click="closeEditor">
			<view class="editor-sheet" @click.stop>
				<view class="editor-heading">
					<view>
						<text class="editor-title">{{ editingTarget ? '编辑猫咪' : '添加猫咪' }}</text>
						<text class="editor-note">{{ editorReadOnly ? '只读档案' : '家庭同步' }}</text>
					</view>
					<button class="close-button" aria-label="关闭" @click="closeEditor">×</button>
				</view>
				<button class="photo-picker" :disabled="editorReadOnly || saving || deleting" @click="chooseCatPhoto">
					<view class="photo-preview-wrap">
						<image class="photo-preview" :src="draft.avatar || defaultAvatar" mode="aspectFill" />
						<view class="photo-edit-dot"><cat-icon name="camera" :size="22" color="#FFFFFF" :stroke="1.8" /></view>
					</view>
					<view class="photo-picker-copy">
						<text class="photo-picker-title">猫咪照片</text>
						<text class="photo-picker-note">点击拍摄或从相册选择</text>
					</view>
					<text class="photo-picker-action">{{ draft.avatar && draft.avatar !== defaultAvatar ? '更换' : '选择' }}</text>
				</button>
				<label class="field-label">昵称</label>
				<input class="field-input" v-model="draft.name" :disabled="editorReadOnly" maxlength="12" placeholder="必填" />
				<view class="field-grid">
					<view class="field-half">
						<label class="field-label">生日</label>
						<picker class="field-picker" mode="date" :value="birthdayPickerValue" start="1900-01-01" :end="todayDate" :disabled="editorReadOnly" @change="onBirthdayChange">
							<view class="field-select"><text :class="{ placeholder: !draft.birthday }">{{ draft.birthday || '请选择' }}</text><text class="field-select-arrow">⌄</text></view>
						</picker>
					</view>
					<view class="field-half">
						<label class="field-label">品种</label>
						<input class="field-input" v-model="draft.breed" :disabled="editorReadOnly" maxlength="40" placeholder="例如 英短、橘猫" />
					</view>
				</view>
				<label class="field-label">性别</label>
				<picker class="field-picker" mode="selector" :range="sexOptions" :value="pickerIndex(draft.sex, sexOptions)" :disabled="editorReadOnly" @change="onPickerChange('sex', sexOptions, $event)">
					<view class="field-select"><text :class="{ placeholder: !draft.sex }">{{ draft.sex || '请选择' }}</text><text class="field-select-arrow">⌄</text></view>
				</picker>
				<label class="field-label">疾病 / 健康情况</label>
				<input class="field-input" v-model="draft.health" :disabled="editorReadOnly" maxlength="40" placeholder="选填，例如过敏、肾病早期" />
				<button v-if="!editorReadOnly" class="save-button" :disabled="saving || deleting" @click="saveCat">{{ saving ? '保存中...' : '保存档案' }}</button>
				<button v-if="editingTarget && !editorReadOnly" class="delete-button" :disabled="saving || deleting" @click="confirmDeleteCat">{{ deleting ? '删除中...' : '删除猫咪档案' }}</button>
			</view>
		</view>
	</view>
</template>

<script>
	const {
		DEFAULT_CAT_AVATAR: DEFAULT_AVATAR,
		catProfileKey,
		createCatEditorTarget,
		findCatProfileByKey,
		readCatProfiles,
		refreshCatProfiles,
		writeCatProfiles
	} = require('@/utils/catProfiles.js')
	const { uploadCatAvatar } = require('@/utils/catAvatarUpload.js')
	const { callBackend, getBackendErrorMessage } = require('@/utils/backendClient.js')
	const { formatCatAge } = require('@/utils/catAge.js')
	const { readAppAuthState } = require('@/utils/appAuth.js')

	function emptyDraft() {
		return { name: '', birthday: '', breed: '', sex: '', health: '', avatar: '' }
	}

	function formatDateValue(date) {
		const value = date instanceof Date ? date : new Date(date)
		if (Number.isNaN(value.getTime())) return ''
		const year = value.getFullYear()
		const month = String(value.getMonth() + 1).padStart(2, '0')
		const day = String(value.getDate()).padStart(2, '0')
		return `${year}-${month}-${day}`
	}

	export default {
		name: 'profile-cats',
		data() {
			return {
				cats: [],
				defaultAvatar: DEFAULT_AVATAR,
				sexOptions: ['未填写', '公', '母'],
				todayDate: formatDateValue(new Date()),
				editorVisible: false,
				editingTarget: null,
				draft: emptyDraft(),
				pendingAvatarPath: '',
				saving: false,
				deleting: false,
				devices: []
			}
		},
		computed: {
			editorReadOnly() {
				return !!(this.editingTarget && this.editingTarget.readOnly)
			},
			birthdayPickerValue() {
				return this.draft.birthday || this.todayDate
			}
		},
		onShow() {
			this.loadCats()
		},
		methods: {
			catKey(cat) { return catProfileKey(cat) },
			async loadCats() {
				const cached = readCatProfiles(uni)
				this.cats = cached
				try {
					const devicesPayload = await callBackend('/api/devices')
					this.devices = devicesPayload.devices || []
					const result = await refreshCatProfiles({
						storage: uni,
						callBackend,
						accountId: readAppAuthState(uni).openid,
						devices: this.devices,
						prepareImport: (profiles) => Promise.all(profiles.map(async (profile) => ({
							...profile,
							avatar: await uploadCatAvatar({ filePath: profile.avatar, catId: profile.id })
						})))
					})
					this.cats = result.cats
				} catch (error) { console.log('[cats] 云端档案读取失败', error) }
			},
			openExistingCat(event) {
				const profileKey = String(event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.profileKey || '').trim()
				const cat = findCatProfileByKey(this.cats, profileKey)
				if (!cat) {
					console.log('[cats] 档案卡片定位失败', { profileKey, catCount: this.cats.length })
					uni.showToast({ title: '档案正在刷新，请重试', icon: 'none' })
					return
				}
				this.openEditorForProfile(cat)
			},
			openNewCat() {
				this.openEditorForProfile(null)
			},
			openEditorForProfile(cat) {
				this.discardPendingAvatar()
				if (!cat) {
					this.editingTarget = null
					this.draft = emptyDraft()
					this.editorVisible = true
					return
				}
				const target = createCatEditorTarget(cat)
				if (!target) {
					console.log('[cats] 档案编辑目标无效', { hasId: !!cat.id, profileKey: catProfileKey(cat) })
					uni.showToast({ title: '档案暂时无法打开', icon: 'none' })
					return
				}
				const profile = target.profile
				this.editingTarget = target
				this.draft = {
					name: profile.name || '',
					birthday: profile.birthday || '',
					breed: profile.breed || '',
					sex: profile.sex || '',
					health: profile.health || '',
					avatar: profile.avatar || ''
				}
				this.editorVisible = true
			},
			displayAge(cat) {
				return formatCatAge(cat && cat.birthday, cat && cat.age)
			},
			pickerIndex(value, options) {
				const index = options.indexOf(value || '未填写')
				return index >= 0 ? index : 0
			},
			onPickerChange(field, options, event) {
				const selected = options[Number(event && event.detail && event.detail.value) || 0] || '未填写'
				this.draft[field] = selected === '未填写' ? '' : selected
			},
			onBirthdayChange(event) {
				const value = event && event.detail && event.detail.value
				if (value && value <= this.todayDate) this.draft.birthday = value
			},
			closeEditor() {
				this.discardPendingAvatar()
				this.editorVisible = false
				this.editingTarget = null
				this.draft = emptyDraft()
			},
			chooseCatPhoto() {
				if (this.editorReadOnly) return
				uni.chooseImage({
					count: 1,
					sizeType: ['compressed'],
					sourceType: ['album', 'camera'],
					success: (result) => {
						const tempPath = result && result.tempFilePaths && result.tempFilePaths[0]
						if (tempPath) this.persistCatPhoto(tempPath)
					}
				})
			},
			persistCatPhoto(tempPath) {
				this.draft.avatar = tempPath
				if (typeof uni.saveFile !== 'function') return
				uni.saveFile({
					tempFilePath: tempPath,
					success: (result) => {
						this.discardPendingAvatar()
						this.pendingAvatarPath = result.savedFilePath
						this.draft.avatar = result.savedFilePath
					},
					fail: () => uni.showToast({ title: '照片暂存失败，请重新选择', icon: 'none' })
				})
			},
			discardPendingAvatar() {
				const filePath = this.pendingAvatarPath
				this.pendingAvatarPath = ''
				if (!filePath || typeof uni.removeSavedFile !== 'function') return
				uni.removeSavedFile({ filePath, fail: () => {} })
			},
			removeUnusedAvatar(filePath, excludingKey) {
				if (!filePath || filePath === DEFAULT_AVATAR || typeof uni.removeSavedFile !== 'function') return
				const stillUsed = this.cats.some((cat) => catProfileKey(cat) !== excludingKey && cat.avatar === filePath)
				if (!stillUsed) uni.removeSavedFile({ filePath, fail: () => {} })
			},
			async saveCat() {
				if (this.editorReadOnly || this.saving) return
				const name = String(this.draft.name || '').trim()
				if (!name) {
					uni.showToast({ title: '请填写猫咪昵称', icon: 'none' })
					return
				}
				const existing = this.editingTarget ? this.editingTarget.profile : null
				const avatar = this.draft.avatar || (existing && existing.avatar) || ''
				if (!avatar || avatar === DEFAULT_AVATAR) {
					uni.showToast({ title: '请上传猫咪照片', icon: 'none' })
					return
				}
				const previousAvatar = existing && existing.avatar
				const selectedBreed = String(this.draft.breed || '').trim()
				this.saving = true
				try {
					const existingId = existing && existing.id
					const catId = existingId || `cat-${Date.now()}`
					const requestId = 'cat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10)
					const cloudAvatar = await uploadCatAvatar({ filePath: avatar, catId })
					const profile = Object.assign({}, existing || {}, {
					id: catId,
					name,
					birthday: String(this.draft.birthday || '').trim(),
					age: formatCatAge(this.draft.birthday, existing && existing.age),
					breed: selectedBreed,
					sex: String(this.draft.sex || '').trim(),
					health: String(this.draft.health || '').trim(),
					avatar: cloudAvatar,
					status: (existing && existing.status) || '待补充猫脸',
					statusTone: (existing && existing.statusTone) || 'pending',
					demo: existing ? !!existing.demo : false
					})
					delete profile.notes
					await callBackend(`/api/cats/${encodeURIComponent(profile.id)}`, {
						method: 'PUT',
						data: profile,
						requestId,
						syncSource: 'cat-editor'
					})
					const devicesNeedingPrimary = this.devices.filter((device) => device.role !== 'member' && !device.primaryCatId)
					await Promise.all(devicesNeedingPrimary.map((device) => callBackend(`/api/devices/${encodeURIComponent(device.sn)}/primary-cat`, { method: 'PUT', data: { catId: profile.id } })))
					const result = await refreshCatProfiles({ storage: uni, callBackend, accountId: readAppAuthState(uni).openid, devices: this.devices })
					this.cats = result.cats
					this.pendingAvatarPath = ''
					if (previousAvatar && previousAvatar !== profile.avatar) {
						this.removeUnusedAvatar(previousAvatar, this.editingTarget && this.editingTarget.key)
					}
					this.closeEditor()
					uni.showToast({ title: '档案已保存', icon: 'success' })
				} catch (error) {
					console.log('[cats] 档案保存失败', error)
					const message = String(error && (error.code || error.message) || '')
					const title = message.includes('UPLOAD')
						? '照片上传失败'
						: message.includes('CAT_PROFILE_READ_ONLY')
							? '共享档案仅可查看'
							: '档案保存失败'
					uni.showToast({ title, icon: 'none', duration: 2600 })
				} finally { this.saving = false }
			},
			confirmDeleteCat() {
				const target = this.editingTarget
				const cat = target && target.profile
				if (!cat || target.readOnly || this.deleting || this.saving) return
				uni.showModal({
					title: '删除猫咪档案',
					content: `确认删除“${cat.name}”吗？此操作无法撤销。`,
					confirmText: '删除',
					confirmColor: '#9A4A40',
					success: async (result) => {
						if (!result.confirm) return
						this.deleting = true
						uni.showLoading({ title: '删除中...' })
						try {
							const requestId = 'cat_delete_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10)
							await callBackend(`/api/cats/${encodeURIComponent(target.id)}`, {
								method: 'DELETE',
								requestId,
								syncSource: 'cat-editor'
							})
							const result = await refreshCatProfiles({
								storage: uni,
								callBackend,
								accountId: readAppAuthState(uni).openid,
								devices: this.devices
							})
							this.cats = result.refreshed
								? result.cats
								: writeCatProfiles(this.cats.filter((item) => catProfileKey(item) !== target.key), uni)
							try {
								const devicesPayload = await callBackend('/api/devices')
								this.devices = devicesPayload.devices || []
							} catch (error) { console.log('[cats] 设备关联刷新失败', error) }
							this.discardPendingAvatar()
							this.removeUnusedAvatar(cat.avatar, target.key)
							this.closeEditor()
							uni.showToast({ title: '猫咪档案已删除', icon: 'success' })
						} catch (error) {
							console.log('[cats] 档案删除失败', { code: error && error.code, requestId: error && error.requestId })
							uni.showToast({ title: getBackendErrorMessage(error, '档案删除失败，请重试'), icon: 'none', duration: 2600 })
						} finally {
							uni.hideLoading()
							this.deleting = false
						}
					}
				})
			}
		}
	}
</script>

<style>
	.cats-page { min-height: 100vh; background: #FBFBFA; color: #141414; }
	.close-button::after, .photo-picker::after, .save-button::after, .delete-button::after { border: 0; }
	.cats-content { padding: 36rpx 32rpx calc(72rpx + env(safe-area-inset-bottom)); }
	.archive-intro { margin-bottom: 26rpx; }
	.archive-title { display: block; font-size: 40rpx; line-height: 54rpx; font-weight: 700; }
	.archive-meta { display: block; margin-top: 4rpx; color: #989893; font-size: 24rpx; line-height: 36rpx; }
	.cat-card { display: flex; min-height: 152rpx; box-sizing: border-box; align-items: center; padding: 20rpx 24rpx; margin-bottom: 18rpx; border: 2rpx solid #EDEDEB; border-radius: 36rpx; background: #FFFFFF; }
	.cat-card-avatar { flex: 0 0 112rpx; width: 112rpx; height: 112rpx; border-radius: 56rpx; background: #EFEEEC; }
	.cat-card-copy { min-width: 0; flex: 1; margin-left: 22rpx; }
	.cat-title-line { display: flex; align-items: center; min-width: 0; }
	.cat-card-name { overflow: hidden; font-size: 31rpx; line-height: 42rpx; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
	.demo-tag { flex: 0 0 auto; margin-left: 12rpx; padding: 3rpx 9rpx; border-radius: 6rpx; background: #F1F1EF; color: #989893; font-size: 18rpx; line-height: 28rpx; }
	.cat-detail { display: block; margin-top: 3rpx; overflow: hidden; color: #5A5A56; font-size: 23rpx; line-height: 34rpx; text-overflow: ellipsis; white-space: nowrap; }
	.health-detail { display: block; margin-top: 3rpx; overflow: hidden; color: #9A4A40; font-size: 21rpx; line-height: 30rpx; text-overflow: ellipsis; white-space: nowrap; }
	.recognition-line { display: flex; align-items: center; margin-top: 5rpx; }
	.status-dot { width: 10rpx; height: 10rpx; margin-right: 9rpx; border-radius: 50%; background: #2FA35C; }
	.status-dot.pending { background: #C9A24B; }
	.recognition-status { color: #2FA35C; font-size: 21rpx; line-height: 30rpx; }
	.recognition-status.pending { color: #9A4A40; }
	.card-arrow { margin-left: 12rpx; color: #C4C4C0; font-size: 44rpx; line-height: 1; }
	.add-row { display: flex; min-height: 132rpx; box-sizing: border-box; align-items: center; padding: 20rpx 24rpx; border: 2rpx dashed #B4B4B0; border-radius: 36rpx; }
	.add-row-icon { display: flex; align-items: center; justify-content: center; width: 88rpx; height: 88rpx; border-radius: 44rpx; background: #F1F1EF; color: #5A5A56; }
	.add-row-icon text { font-size: 38rpx; line-height: 1; }
	.add-row-copy { margin-left: 22rpx; }
	.add-row-title { display: block; font-size: 28rpx; line-height: 40rpx; font-weight: 600; }
	.add-row-note { display: block; color: #989893; font-size: 22rpx; line-height: 32rpx; }
	.editor-mask { position: fixed; z-index: 20; inset: 0; display: flex; align-items: flex-end; background: rgba(11,11,12,0.42); }
	.editor-sheet { width: 100%; max-height: 88vh; box-sizing: border-box; overflow-y: auto; padding: 34rpx 32rpx calc(32rpx + env(safe-area-inset-bottom)); border-top: 2rpx solid #E8E8E5; border-radius: 36rpx 36rpx 0 0; background: #FBFBFA; }
	.editor-heading { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 24rpx; }
	.editor-title { display: block; font-size: 36rpx; line-height: 48rpx; font-weight: 700; }
	.editor-note { display: block; color: #989893; font-size: 22rpx; line-height: 32rpx; }
	.close-button { display: flex; align-items: center; justify-content: center; width: 64rpx; height: 64rpx; padding: 0; margin: 0; border: 0; border-radius: 50%; background: #F1F1EF; color: #141414; font-size: 38rpx; line-height: 64rpx; }
	.photo-picker { display: flex; width: 100%; min-height: 112rpx; box-sizing: border-box; align-items: center; padding: 12rpx 0; margin: 0 0 10rpx; border: 0; background: transparent; text-align: left; }
	.photo-preview-wrap { position: relative; flex: 0 0 96rpx; width: 96rpx; height: 96rpx; }
	.photo-preview { display: block; width: 96rpx; height: 96rpx; border-radius: 48rpx; background: #EFEEEC; }
	.photo-edit-dot { position: absolute; right: -2rpx; bottom: -2rpx; display: flex; width: 34rpx; height: 34rpx; align-items: center; justify-content: center; border: 4rpx solid #FBFBFA; border-radius: 50%; background: #141414; }
	.photo-picker-copy { min-width: 0; flex: 1; margin-left: 22rpx; }
	.photo-picker-title { display: block; color: #141414; font-size: 27rpx; line-height: 38rpx; font-weight: 600; }
	.photo-picker-note { display: block; margin-top: 2rpx; color: #989893; font-size: 21rpx; line-height: 30rpx; }
	.photo-picker-action { flex: 0 0 auto; margin-left: 16rpx; color: #5A5A56; font-size: 22rpx; line-height: 32rpx; }
	.field-label { display: block; margin: 12rpx 0 8rpx; color: #5A5A56; font-size: 22rpx; line-height: 30rpx; }
	.field-input { width: 100%; height: 80rpx; box-sizing: border-box; padding: 0 20rpx; border: 2rpx solid #D8D8D5; border-radius: 12rpx; background: #FFFFFF; color: #141414; font-size: 27rpx; }
	.field-picker { width: 100%; }
	.field-select { display: flex; width: 100%; height: 80rpx; box-sizing: border-box; align-items: center; justify-content: space-between; padding: 0 20rpx; border: 2rpx solid #D8D8D5; border-radius: 12rpx; background: #FFFFFF; color: #141414; font-size: 27rpx; }
	.field-select .placeholder { color: #989893; }
	.field-select-arrow { margin-left: 12rpx; color: #989893; font-size: 30rpx; line-height: 1; }
	.field-grid { display: flex; gap: 18rpx; }
	.field-half { min-width: 0; flex: 1; }
	.save-button { height: 84rpx; margin: 28rpx 0 0; border-radius: 42rpx; background: #141414; color: #FFFFFF; font-size: 27rpx; line-height: 84rpx; font-weight: 600; }
	.delete-button { height: 72rpx; margin: 12rpx 0 0; border: 0; background: transparent; color: #9A4A40; font-size: 24rpx; line-height: 72rpx; }
</style>
