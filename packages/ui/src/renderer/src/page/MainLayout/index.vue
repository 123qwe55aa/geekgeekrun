<template>
  <div class="app-shell">
    <aside class="aside-nav">
      <div class="brand-row">
        <div>
          <div class="brand-kicker">GGR</div>
          <div class="brand-name">求职工作台</div>
        </div>
        <el-button
          class="theme-toggle"
          circle
          text
          :title="isNight ? '切换明亮模式' : '切换夜晚模式'"
          @click="toggleTheme"
          ><Moon v-if="!isNight" /><Sunny v-else
        /></el-button>
      </div>
      <div class="nav-list">
        <RouterLink v-show="false" to="./TaskManager">任务管理</RouterLink>
        <BossPart />
        <hr class="group-divider" />
        <GlobalConfigPart />
        <hr class="group-divider" />
        <RunDataRecordPart />
      </div>
      <div class="sidebar-footer">
        <div v-if="updateStore.availableNewRelease" mb16px>
          <div
            :style="{
              display: 'flex',
              alignItems: 'center'
            }"
          >
            最新版本: {{ updateStore.availableNewRelease.releaseVersion }}
            <img
              h12px
              ml10px
              :style="{
                filter: `saturate(1.5) brightness(1.5)`,
                transform: `translateY(-10px)`
              }"
              src="./resources/new.gif"
            />
          </div>
          <div class="update-button-area flex flex-items-center mt-8px">
            <el-button type="text" size="small" @click="handleDownloadNewReleaseClick"
              >从GitHub下载</el-button
            >
            |
            <el-button type="text" size="small" @click="handleViewNewReleaseClick"
              >了解更新内容</el-button
            >
          </div>
        </div>
        <div>
          <div>当前版本: {{ buildInfo.version }}({{ buildInfo.buildVersion }})</div>
          <div class="feedback-button-area flex flex-items-center mt-8px">
            <el-button type="text" size="small" @click="handleGotoProjectPageClick"
              >项目首页</el-button
            >
            |
            <el-button type="text" size="small" @click="handleFeedbackClick">反馈问题</el-button>
          </div>
        </div>
        <BackendUpdatePanel />
      </div>
    </aside>
    <main class="router-view-wrap">
      <RouterView v-slot="{ Component }" class="flex-1 of-hidden">
        <KeepAlive>
          <component :is="Component" />
        </KeepAlive>
      </RouterView>
    </main>
  </div>
</template>

<script lang="ts" setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { Moon, Sunny } from '@element-plus/icons-vue'
import useBuildInfo from '@renderer/hooks/useBuildInfo'
import { gtagRenderer } from '@renderer/utils/gtag'
import { useUpdateStore, useTaskManagerStore } from '../../store/index'
import BossPart from './LeftNavBar/BossPart.vue'
import GlobalConfigPart from './LeftNavBar/GlabalConfigPart.vue'
import RunDataRecordPart from './LeftNavBar/RunDataRecordPart.vue'
import BackendUpdatePanel from '../../components/BackendUpdatePanel.vue'

useRouter()

const { buildInfo } = useBuildInfo()
const isNight = ref(document.documentElement.dataset.theme === 'night')
function toggleTheme() {
  isNight.value = !isNight.value
  document.documentElement.dataset.theme = isNight.value ? 'night' : 'light'
  document.documentElement.classList.toggle('dark', isNight.value)
  localStorage.setItem('ggr-ui-theme', isNight.value ? 'night' : 'light')
}
const handleFeedbackClick = () => {
  gtagRenderer('goto_feedback_clicked')
  electron.ipcRenderer.send('send-feed-back-to-github-issue')
}
const handleGotoProjectPageClick = () => {
  gtagRenderer('goto_project_github_clicked')
  electron.ipcRenderer.send('open-external-link', 'https://github.com/geekgeekrun/geekgeekrun')
}

const updateStore = useUpdateStore()
function handleDownloadNewReleaseClick() {
  gtagRenderer('click_download_release_form_nav')
  electron.ipcRenderer.send('open-external-link', updateStore.availableNewRelease!.assetUrl)
}
function handleViewNewReleaseClick() {
  gtagRenderer('click_view_release_form_nav')
  electron.ipcRenderer.send('open-external-link', updateStore.availableNewRelease!.releasePageUrl)
}

const taskManagerStore = useTaskManagerStore()
void taskManagerStore
</script>

<style lang="scss" scoped>
.app-shell {
  display: flex;
  min-height: 100vh;
  background: var(--ggr-bg);
}
.aside-nav {
  display: flex;
  flex: 0 0 244px;
  flex-direction: column;
  box-sizing: border-box;
  padding: 22px 18px 16px;
  overflow: hidden;
  background: linear-gradient(160deg, var(--ggr-sidebar), var(--ggr-sidebar-strong));
  border-right: 1px solid var(--ggr-border);
  .brand-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 8px 18px;
  }
  .brand-kicker {
    color: var(--ggr-accent);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.18em;
  }
  .brand-name {
    color: var(--ggr-text);
    font-size: 17px;
    font-weight: 700;
    letter-spacing: 0.02em;
    margin-top: 2px;
  }
  .theme-toggle {
    color: var(--ggr-text-muted);
    &:hover {
      color: var(--ggr-accent);
      background: var(--ggr-accent-soft);
    }
  }
  .nav-list {
    flex: 1;
    overflow: auto;
    padding: 0 4px;
  }
  .nav-list {
    hr.group-divider {
      width: 100%;
      border: 0 solid;
      height: 1px;
      background-color: var(--ggr-border);
      margin: 10px 0;
      margin-right: 0;
    }
  }
  .sidebar-footer {
    padding: 14px 8px 0;
    color: var(--ggr-text-muted);
    font-size: 12px;
    border-top: 1px solid var(--ggr-border);
  }
  .feedback-button-area,
  .update-button-area {
    :deep(.el-button) {
      height: fit-content;
      padding: 0;
      margin-left: 0;
    }
  }
}
.router-view-wrap {
  display: flex;
  flex: 1;
  height: 100%;
  min-width: 0;
  background: var(--ggr-surface);
  box-shadow: -4px 1px 24px rgb(3 18 28 / 8%);
}
</style>
