<template>
  <div class="geek-auto-start-chat-with-boss__running-status">
    <FlyingCompanyLogoList class="flying-company-logo-list" />
    <div class="tip">
      <article>
        <h1>{{ isRunning ? '👋 自动开聊正在运行' : '自动开聊状态' }}</h1>
        <p v-if="isRunning">💬 正在为你开聊BOSS，请静候佳音</p>
        <p v-else>自动开聊由后端安全策略统一管理。</p>
        <p>📱 你可以在<b>手机</b> / <b>平板电脑</b>上，使用BOSS直聘App与为你开聊的BOSS聊天</p>
      </article>

      <section v-if="policyStatus.status === 'PAUSED_RISK'" class="safety-panel safety-panel--risk" aria-live="polite">
        <h2>风险暂停</h2>
        <p>{{ policyStatus.reason || '后端检测到平台风险或登录异常，自动开聊已停止。' }}</p>
        <p v-if="policyStatus.pausedUntil">冷却至：{{ policyStatus.pausedUntil }}</p>
        <el-button :loading="isResuming" @click="handleResumeSafety">完成登录/验证检查后恢复</el-button>
      </section>

      <section v-else-if="policyStatus.status === 'PAUSED_QUOTA'" class="safety-panel safety-panel--quota" aria-live="polite">
        <h2>配额暂停</h2>
        <p>{{ policyStatus.reason || '已达到后端配置的使用配额。' }}</p>
        <p>配额使用：{{ quotaSummary }}</p>
      </section>

      <section class="safety-panel" aria-live="polite">
        <h2>安全策略</h2>
        <p>状态：{{ policyStatus.status }}</p>
        <p v-if="policyStatus.reason">原因：{{ policyStatus.reason }}</p>
        <p>可执行：{{ startDisabled ? '否' : '是' }}</p>
        <p>配额使用：{{ quotaSummary }}</p>
      </section>

      <section v-if="pendingApprovals.length" class="approval-panel" aria-live="polite">
        <h2>待确认开聊</h2>
        <article v-for="approval in pendingApprovals" :key="approval.id" class="approval-item">
          <p>{{ approvalSummary(approval) }}</p>
          <el-button size="small" type="primary" @click="approveAutoChatApproval(approval.id)">批准开聊</el-button>
          <el-button size="small" @click="rejectAutoChatApproval(approval.id)">拒绝</el-button>
        </article>
      </section>

      <el-button v-if="isRunning" :disabled="isStopping" @click="handleStopButtonClick">停止开聊</el-button>
      <el-button v-else :disabled="startDisabled || isStarting" :loading="isStarting" @click="handleStartButtonClick">开始开聊</el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onUnmounted, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import FlyingCompanyLogoList from '../../features/FlyingCompanyLogoList/index.vue'
import { ElMessage } from 'element-plus'
import { gtagRenderer } from '@renderer/utils/gtag'

type QuotaCounter = { used: number; limit: number }
type SafetyStatus = {
  status?: string
  reason?: string | null
  pausedUntil?: string | null
  quota?: {
    browsePerDay?: QuotaCounter
    chatPerHour?: QuotaCounter
    chatPerDay?: QuotaCounter
  }
}
type AgentSafetyStatus = { policy?: SafetyStatus; tasks?: Array<{ workerId?: string }> }
type Approval = { id: string; context?: Record<string, unknown>; expiresAt?: string | null }

const BOSS_WORKER_ID = 'geekAutoStartWithBossMain'
const { ipcRenderer } = electron
const router = useRouter()
const safetyStatus = ref<AgentSafetyStatus>({ policy: { status: 'IDLE' }, tasks: [] })
const pendingApprovals = ref<Approval[]>([])
const isStopping = ref(false)
const isStarting = ref(false)
const isResuming = ref(false)

const policyStatus = computed(() => safetyStatus.value.policy ?? { status: 'IDLE' })
const startDisabled = computed(() => ['PAUSED_RISK', 'PAUSED_QUOTA'].includes(policyStatus.value.status ?? 'IDLE'))
const isRunning = computed(() => safetyStatus.value.tasks?.some((task) => task.workerId === BOSS_WORKER_ID) ?? false)
const quotaSummary = computed(() => {
  const quota = policyStatus.value.quota
  if (!quota) return '后端暂未提供明细'
  return [
    ['浏览', quota.browsePerDay],
    ['每小时开聊', quota.chatPerHour],
    ['每日开聊', quota.chatPerDay]
  ].flatMap(([label, counter]) => {
    const value = counter as QuotaCounter | undefined
    return value ? [`${label} ${value.used}/${value.limit}`] : []
  }).join('；') || '后端暂未提供明细'
})

async function refreshSafety() {
  const [status, approvals] = await Promise.all([
    ipcRenderer.invoke('get-agent-safety-status'),
    ipcRenderer.invoke('list-auto-chat-approvals')
  ])
  safetyStatus.value = status as AgentSafetyStatus
  pendingApprovals.value = Array.isArray(approvals) ? approvals as Approval[] : []
}

const handleStartButtonClick = async () => {
  if (startDisabled.value) return
  isStarting.value = true
  try {
    await ipcRenderer.invoke('run-geek-auto-start-chat-with-boss')
    await refreshSafety()
  } catch (err) {
    console.error(err)
    ElMessage.error('自动开聊无法启动，请查看后端安全状态。')
  } finally {
    isStarting.value = false
  }
}

const handleStopButtonClick = async () => {
  gtagRenderer('gascwb_stop_button_clicked')
  await ipcRenderer.invoke('stop-geek-auto-start-chat-with-boss')
}

async function handleResumeSafety() {
  isResuming.value = true
  try {
    await ipcRenderer.invoke('resume-agent-safety')
    await refreshSafety()
  } catch (err) {
    console.error(err)
    ElMessage.error('后端健康检查尚未允许恢复自动开聊。')
  } finally {
    isResuming.value = false
  }
}

async function approveAutoChatApproval(id: string) {
  await ipcRenderer.invoke('approve-auto-chat-approval', { id })
  await refreshSafety()
}

async function rejectAutoChatApproval(id: string) {
  await ipcRenderer.invoke('reject-auto-chat-approval', { id })
  await refreshSafety()
}

function approvalSummary(approval: Approval) {
  const context = approval.context ?? {}
  const company = typeof context.companyName === 'string' ? context.companyName : '待确认岗位'
  return approval.expiresAt ? `${company}（有效期至 ${approval.expiresAt}）` : company
}

const handleStopping = () => {
  gtagRenderer('gascwb_become_stopping')
  isStopping.value = true
}
ipcRenderer.once('geek-auto-start-chat-with-boss-stopping', handleStopping)

const handleStopped = () => {
  gtagRenderer('gascwb_become_stopped')
  router.replace('/main-layout/GeekAutoStartChatWithBoss')
}
ipcRenderer.once('geek-auto-start-chat-with-boss-stopped', handleStopped)

const handleAgentSafetyUpdated = () => {
  void refreshSafety().catch((error) => console.error(error))
}

onUnmounted(() => {
  ipcRenderer.removeListener('geek-auto-start-chat-with-boss-stopped', handleStopped)
  ipcRenderer.removeListener('geek-auto-start-chat-with-boss-stopping', handleStopping)
  ipcRenderer.removeListener('agent-safety-updated', handleAgentSafetyUpdated)
})

onMounted(async () => {
  ipcRenderer.on('agent-safety-updated', handleAgentSafetyUpdated)
  try {
    await refreshSafety()
    if (!isRunning.value && !startDisabled.value) await handleStartButtonClick()
  } catch (err) {
    if (err instanceof Error && err.message.includes('NEED_TO_CHECK_RUNTIME_DEPENDENCIES')) {
      gtagRenderer('gascwb_cannot_run_for_corrupt')
      ElMessage.error({ message: '核心组件损坏，正在尝试修复' })
      router.replace('/')
    }
    console.error(err)
    gtagRenderer('gascwb_cannot_run_for_unknown_error', { err })
  }
})
</script>

<style scoped lang="scss">
.geek-auto-start-chat-with-boss__running-status {
  width: 100%;
  height: 100%;
  overflow: auto;
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  .tip {
    margin: 0 auto;
    margin-top: -8vh;
    max-width: 640px;
  }
  .flying-company-logo-list {
    position: absolute;
    inset: 0;
    z-index: -1;
    opacity: 0.25;
  }
}

.safety-panel,
.approval-panel {
  margin: 16px 0;
  padding: 12px 16px;
  border-radius: 8px;
  background: rgb(255 255 255 / 78%);
}

.safety-panel--risk { border-left: 4px solid #f56c6c; }
.safety-panel--quota { border-left: 4px solid #e6a23c; }
.approval-item + .approval-item { margin-top: 12px; }
</style>
