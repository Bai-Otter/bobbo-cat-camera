<template>
	<view class="page" :style="{ paddingTop: statusBarHeight + 'px' }">
		<view class="nav" :style="{ paddingRight: headerRightInset + 'px' }">
			<text class="back" @click="back">‹</text><text class="nav-title">快速自定义</text><text class="total">{{ durationLabel }}</text>
		</view>
		<scroll-view class="content" scroll-y>
			<view class="preview">
				<image class="preview-image" :src="previewCover" mode="aspectFill" />
				<view class="preview-play"><cat-icon name="play" :size="38" color="#FFFFFF" /></view>
				<text class="preview-note">预览随选择实时更新</text>
			</view>
			<view class="section-heading"><text class="section-title">成片顺序</text><text class="section-note">拖动排序 · 调整两端裁剪</text></view>
			<scroll-view class="selected-scroll" scroll-x :show-scrollbar="false">
				<view class="selected-track">
					<view v-for="(clip,index) in editor.selected" :key="clip.id" class="selected-card" @touchstart="beginDrag(index,$event)" @touchend="finishDrag(index,$event)">
						<image class="selected-image" :src="coverFor(clip,index)" mode="aspectFill" />
						<text class="selected-duration">{{ formatDuration(clip.trimEndSec-clip.trimStartSec) }}</text>
						<text class="remove" @click.stop="remove(clip.id)">×</text>
					</view>
					<view v-if="!editor.selected.length" class="selected-placeholder"><text>从素材中添加片段</text></view>
				</view>
			</scroll-view>
			<view v-if="editor.selected.length" class="trim-row">
				<text class="trim-label">当前片段裁剪</text><button class="trim-btn" @click="nudgeTrim('start',.5)">开头 +0.5s</button><button class="trim-btn" @click="nudgeTrim('end',-.5)">结尾 -0.5s</button>
			</view>
			<view class="add-row" @click="sheet='clips'">
				<view class="plus">＋</view><view class="add-copy"><text class="add-title">添加片段</text><text class="add-note">每顿视频 + 精选片段，已选 {{ editor.selected.length }} 个</text></view><text class="chevron">⌃</text>
			</view>
			<view class="divider"></view>
			<view class="tools">
				<view class="tool" @click="sheet='music'"><text class="tool-name">音乐</text><text class="tool-value active">{{ musicName }}</text></view>
				<view class="tool disabled" @click="notReady"><text class="tool-name">文字</text><text class="tool-value">未实现</text></view>
				<view class="tool" @click="toggleFrame"><text class="tool-name">画面</text><text class="tool-value active">{{ editor.frameMode==='source'?'原画面':'居中裁剪' }}</text></view>
				<view class="tool disabled" @click="notReady"><text class="tool-name">特效</text><text class="tool-value">未实现</text></view>
			</view>
			<view class="content-spacer"></view>
		</scroll-view>
		<view class="export-bar"><view class="export" :class="{disabled:!exportable||exporting}" @click="exportVideo"><text>{{ exportText }}</text></view></view>

		<view v-if="sheet" class="sheet-wrap"><view class="mask" @click="closeSheet"></view>
			<view v-if="sheet==='clips'" class="sheet">
				<view class="handle"></view><view class="sheet-heading"><text>添加片段</text><text>已选 {{ editor.selected.length }} 个 · 点击切换</text></view>
				<text class="group-title">每顿视频</text><view class="material-grid"><view v-for="(item,index) in mealMaterials" :key="item.id" class="material" @click="toggleMaterial(item)"><view class="material-image-wrap"><image class="material-image" :src="coverFor(item,index)" mode="aspectFill"/><text v-if="isSelected(item.id)" class="check">✓</text></view><text>{{ materialTitle(item,index) }} · {{ formatDuration(item.durationSec) }}</text></view></view>
				<text class="group-title">精选片段</text><view class="material-grid"><view v-for="(item,index) in segmentMaterials" :key="item.id" class="material" @click="toggleMaterial(item)"><view class="material-image-wrap"><image class="material-image" :src="coverFor(item,index+2)" mode="aspectFill"/><text v-if="isSelected(item.id)" class="check">✓</text></view><text>精选 {{ index+1 }} · {{ formatDuration(item.durationSec) }}</text></view><text v-if="!segmentMaterials.length" class="no-material">暂无精选片段</text></view>
				<view class="sheet-done" @click="closeSheet">完成 · 已选 {{ editor.selected.length }} 个</view>
			</view>
			<view v-else class="sheet music-sheet">
				<view class="handle"></view><view class="sheet-heading"><text>音乐</text><text>点击试听，完成后停止播放</text></view>
				<view class="music-list"><view v-for="track in tracks" :key="track.id" class="music" :class="{selected:bgmId===track.id}" @click="pickMusic(track)"><view><text class="music-title">{{ track.title }}</text><text class="music-artist">{{ track.artist }}</text></view><text>{{ playingId===track.id?'暂停':'试听' }}</text></view></view>
				<view class="volume"><text>音乐音量</text><slider class="slider" :value="Math.round(bgmVolume*100)" min="20" max="100" activeColor="#141414" backgroundColor="#E8E8E5" @changing="changeVolume" @change="changeVolume"/><text>{{ Math.round(bgmVolume*100) }}%</text></view>
				<view class="sheet-done" @click="closeSheet">完成</view>
			</view>
		</view>
	</view>
</template>

<script>
	import catIcon from '@/components/cat-icon/cat-icon.vue'
	const { callBackend } = require('@/utils/backendClient.js')
	const { selectDeviceBySn } = require('@/utils/todayDeviceState.js')
	const editorUtils = require('@/utils/foodcastEditor.js')
	const { createMusicPreviewController } = require('@/utils/foodcastMusic.js')

	export default {
		components:{catIcon},
		data(){return{statusBarHeight:24,headerRightInset:16,device:null,materials:[],tracks:[],editor:editorUtils.emptyState(),bgmId:'',bgmVolume:.8,playingId:'',sheet:'',dragStart:null,activeTrimIndex:0,exporting:false,job:null,musicController:null}},
		computed:{
			mealMaterials(){return this.materials.filter(item=>item.kind==='meal')},segmentMaterials(){return this.materials.filter(item=>item.kind==='daily_segment')},
			selectedDuration(){return editorUtils.selectedDuration(this.editor)},durationLabel(){return this.formatDuration(this.selectedDuration)},
			previewCover(){return this.editor.selected.length?this.coverFor(this.editor.selected[0],0):'/static/images/clip-4.svg'},
			musicName(){const item=this.tracks.find(track=>track.id===this.bgmId);return item?item.title:'请选择'},
			exportable(){return editorUtils.canExport(this.editor,{bgmId:this.bgmId})},
			exportText(){if(this.exporting)return '正在生成成片';return `导出成片 · ${this.editor.selected.length} 个片段 ${this.durationLabel}`}
		},
		onLoad(){const info=typeof wx!=='undefined'&&wx.getWindowInfo?wx.getWindowInfo():{statusBarHeight:24,windowWidth:375};const menu=typeof wx!=='undefined'&&wx.getMenuButtonBoundingClientRect?wx.getMenuButtonBoundingClientRect():null;this.statusBarHeight=Number(info.statusBarHeight)||24;this.headerRightInset=menu&&menu.left?Math.max(16,Number(info.windowWidth)-Number(menu.left)+8):16;this.musicController=createMusicPreviewController({createAudioContext:()=>uni.createInnerAudioContext(),onPlayingChange:id=>{this.playingId=id},onError:()=>uni.showToast({title:'音乐试听失败',icon:'none'})});this.loadData()},
		onHide(){this.stopMusic()},onUnload(){this.stopMusic()},
		methods:{
			async loadData(){try{const devicesResult=await callBackend('/api/devices');const devices=Array.isArray(devicesResult.devices)?devicesResult.devices:[];this.device=selectDeviceBySn(devices,uni.getStorageSync('lastViewedDeviceSn')||'');if(!this.device)return;const [materials,bgm]=await Promise.all([callBackend('/api/foodcasts/materials',{query:{deviceSn:this.device.sn}}),callBackend('/api/foodcasts/bgm')]);this.materials=Array.isArray(materials.materials)?materials.materials:[];this.tracks=(Array.isArray(bgm.tracks)?bgm.tracks:[]).filter(track=>track&&track.id&&track.previewUrl);if(this.tracks[0])this.bgmId=this.tracks[0].id}catch(error){uni.showToast({title:'素材加载失败',icon:'none'})}},
			back(){uni.navigateBack()},closeSheet(){this.sheet='';this.stopMusic()},notReady(){uni.showToast({title:'功能暂未开放',icon:'none'})},toggleFrame(){this.editor={...this.editor,frameMode:this.editor.frameMode==='source'?'center_crop':'source'}},
			coverFor(item,index){return item.coverUrl||`/static/images/clip-${(index%5)+1}.svg`},formatDuration(value){const sec=Math.max(0,Math.round(Number(value)||0));return `${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`},
			materialTitle(item,index){return item.kind==='meal'?`第${index+1}顿`:'精选片段'},isSelected(id){return this.editor.selected.some(item=>item.id===id)},
			toggleMaterial(item){if(this.isSelected(item.id)){this.editor=editorUtils.removeMaterial(this.editor,item.id);return}const next=editorUtils.addMaterial(this.editor,item);if(next===this.editor){uni.showToast({title:'最多选择 10 个片段',icon:'none'});return}this.editor=next},remove(id){this.editor=editorUtils.removeMaterial(this.editor,id)},
			beginDrag(index,event){this.activeTrimIndex=index;this.dragStart={index,x:Number(event.touches&&event.touches[0]&&event.touches[0].clientX)||0}},finishDrag(index,event){if(!this.dragStart)return;const x=Number(event.changedTouches&&event.changedTouches[0]&&event.changedTouches[0].clientX)||0;const steps=Math.round((x-this.dragStart.x)/90);this.editor=editorUtils.reorderMaterial(this.editor,index,index+steps);this.activeTrimIndex=Math.max(0,Math.min(this.editor.selected.length-1,index+steps));this.dragStart=null},
			nudgeTrim(side,delta){const item=this.editor.selected[this.activeTrimIndex];if(!item)return;const start=side==='start'?item.trimStartSec+delta:item.trimStartSec;const end=side==='end'?item.trimEndSec+delta:item.trimEndSec;this.editor=editorUtils.trimMaterial(this.editor,item.id,start,end)},
			pickMusic(track){this.bgmId=track.id;this.musicController.toggle(track)},changeVolume(event){this.bgmVolume=this.musicController.setVolume(Number(event.detail.value)/100)},stopMusic(){if(this.musicController)this.musicController.stop()},
			async exportVideo(){if(!this.exportable||this.exporting){if(!this.bgmId)uni.showToast({title:'请选择音乐',icon:'none'});return}this.stopMusic();this.exporting=true;try{const request=editorUtils.buildCustomRequest(this.editor,{deviceSn:this.device.sn,bgmId:this.bgmId,bgmVolume:this.bgmVolume});const result=await callBackend('/api/foodcasts/custom',{method:'POST',data:request});this.job=result.job;this.pollJob()}catch(error){this.exporting=false;uni.showToast({title:'提交失败，请重试',icon:'none'})}},
			async pollJob(){if(!this.job||!this.job.id)return;try{const result=await callBackend('/api/foodcasts/custom/'+encodeURIComponent(this.job.id));this.job=result.job;if(this.job.status==='ready'){this.exporting=false;uni.showToast({title:'成片已生成',icon:'success'});return}if(this.job.status==='failed'){this.exporting=false;uni.showToast({title:'生成失败',icon:'none'});return}setTimeout(()=>this.pollJob(),1800)}catch(error){this.exporting=false;uni.showToast({title:'查询生成进度失败',icon:'none'})}}
		}
	}
</script>

<style>
	.page{height:100vh;box-sizing:border-box;background:#FBFBFA;color:#141414;overflow:hidden}.nav{height:76rpx;padding:0 48rpx;display:flex;align-items:center;gap:20rpx}.back{width:30rpx;font-size:54rpx;line-height:60rpx;font-weight:300}.nav-title{flex:1;font-size:30rpx;font-weight:650}.total{font-size:24rpx;color:#989893}.content{height:calc(100vh - 224rpx - env(safe-area-inset-bottom))}.preview{position:relative;height:372rpx;margin-top:12rpx}.preview-image{width:100%;height:100%}.preview-play{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:96rpx;height:96rpx;border-radius:50%;background:rgba(255,255,255,.45);display:flex;align-items:center;justify-content:center}.preview-note{position:absolute;top:20rpx;left:48rpx;padding:8rpx 20rpx;border-radius:28rpx;background:rgba(30,30,32,.4);font-size:22rpx;color:#fff}.section-heading{padding:28rpx 48rpx 14rpx;display:flex;align-items:baseline;justify-content:space-between}.section-title{font-size:27rpx;font-weight:650}.section-note{font-size:22rpx;color:#989893}.selected-scroll{width:100%;white-space:nowrap}.selected-track{display:inline-flex;gap:12rpx;padding:0 48rpx;min-width:calc(100% - 96rpx)}.selected-card{position:relative;width:230rpx;height:96rpx;border-radius:20rpx;overflow:hidden}.selected-image{width:100%;height:100%}.selected-duration{position:absolute;right:10rpx;bottom:5rpx;font-size:19rpx;color:#fff;text-shadow:0 1px 5px #000}.remove{position:absolute;right:8rpx;top:6rpx;width:34rpx;height:34rpx;border-radius:50%;background:rgba(20,20,20,.65);text-align:center;line-height:32rpx;color:#fff}.selected-placeholder{width:654rpx;height:96rpx;border:2rpx dashed #D8D8D5;border-radius:20rpx;display:flex;align-items:center;justify-content:center;font-size:23rpx;color:#989893}.trim-row{height:66rpx;padding:0 48rpx;display:flex;align-items:center;gap:10rpx}.trim-label{flex:1;font-size:21rpx;color:#989893}.trim-btn{margin:0;padding:0 14rpx;height:44rpx;line-height:42rpx;border:0;border-radius:22rpx;background:#F1F1EF;font-size:19rpx}.add-row{height:116rpx;margin:10rpx 48rpx 0;display:flex;align-items:center;gap:24rpx}.plus{width:76rpx;height:76rpx;border-radius:50%;background:#F1F1EF;display:flex;align-items:center;justify-content:center;font-size:34rpx}.add-copy{flex:1}.add-title{display:block;font-size:30rpx;font-weight:650}.add-note{display:block;margin-top:2rpx;font-size:22rpx;color:#989893}.chevron{font-size:28rpx;color:#C4C4C0}.divider{height:2rpx;margin:0 48rpx 24rpx;background:#E8E8E5}.tools{padding:0 48rpx;display:flex;gap:14rpx}.tool{flex:1;padding:20rpx 18rpx;border:2rpx solid #EDEDEB;border-radius:28rpx;background:#fff}.tool.disabled{opacity:.5}.tool-name,.tool-value{display:block;font-size:24rpx}.tool-name{font-weight:650}.tool-value{margin-top:6rpx;font-size:20rpx;color:#989893}.tool-value.active{color:#2FA35C}.content-spacer{height:50rpx}.export-bar{position:fixed;left:0;right:0;bottom:0;padding:24rpx 48rpx calc(28rpx + env(safe-area-inset-bottom));border-top:2rpx solid rgba(0,0,0,.06);background:rgba(251,251,250,.94);z-index:10}.export{height:104rpx;border-radius:54rpx;background:#141414;display:flex;align-items:center;justify-content:center}.export.disabled{opacity:.38}.export text{font-size:28rpx;font-weight:650;color:#fff}.sheet-wrap{position:fixed;inset:0;z-index:30}.mask{position:absolute;inset:0;background:rgba(20,20,20,.25)}.sheet{position:absolute;left:0;right:0;bottom:0;max-height:72vh;overflow-y:auto;padding:22rpx 48rpx calc(34rpx + env(safe-area-inset-bottom));border-radius:48rpx 48rpx 0 0;background:#FBFBFA}.handle{width:72rpx;height:9rpx;margin:0 auto 22rpx;border-radius:6rpx;background:#D8D8D5}.sheet-heading{display:flex;align-items:baseline;justify-content:space-between}.sheet-heading text:first-child{font-size:31rpx;font-weight:650}.sheet-heading text:last-child{font-size:22rpx;color:#989893}.group-title{display:block;margin:28rpx 0 14rpx;font-size:24rpx;font-weight:650}.material-grid{display:flex;flex-wrap:wrap;gap:18rpx}.material{width:calc((100% - 36rpx)/3);font-size:20rpx;color:#5A5A56;text-align:center}.material-image-wrap{position:relative}.material-image{width:100%;height:126rpx;border-radius:20rpx}.check{position:absolute;right:10rpx;top:10rpx;width:40rpx;height:40rpx;border-radius:50%;background:#141414;color:#fff;line-height:40rpx}.no-material{font-size:22rpx;color:#989893}.sheet-done{height:96rpx;margin-top:30rpx;border-radius:48rpx;background:#141414;color:#fff;font-size:27rpx;font-weight:650;display:flex;align-items:center;justify-content:center}.music-list{margin-top:24rpx}.music{min-height:88rpx;padding:0 22rpx;border-bottom:2rpx solid #E8E8E5;display:flex;align-items:center;justify-content:space-between;font-size:22rpx;color:#989893}.music.selected{background:#F1F1EF;color:#141414}.music-title{display:block;font-size:25rpx;font-weight:650;color:#141414}.music-artist{display:block;margin-top:3rpx;font-size:20rpx;color:#989893}.volume{height:88rpx;display:flex;align-items:center;gap:16rpx;font-size:22rpx}.slider{flex:1}
</style>
