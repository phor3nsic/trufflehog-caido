<script setup lang="ts">
import Button from "primevue/button";
import Card from "primevue/card";
import InputText from "primevue/inputtext";
import Message from "primevue/message";
import Tab from "primevue/tab";
import TabList from "primevue/tablist";
import TabPanel from "primevue/tabpanel";
import TabPanels from "primevue/tabpanels";
import Tabs from "primevue/tabs";
import Tag from "primevue/tag";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { useSDK } from "@/plugins/sdk";

type Settings = {
  binaryPath: string;
  onlyVerified: boolean;
};

type Stats = {
  binaryOk: boolean;
  binaryVersion: string;
  binaryError: string;
  lastScanAt: number | undefined;
  lastScanFiles: number;
  totalFindings: number;
  pendingFiles: number;
  scanning: boolean;
  settings: Settings;
};

const STATS_POLL_MS = 3_000;

const sdk = useSDK();

const activeTab = ref("status");

const binaryPath = ref("");
const onlyVerified = ref(true);

const binaryOk = ref(false);
const binaryVersion = ref("");
const binaryError = ref("");
const pendingFiles = ref(0);
const totalFindings = ref(0);
const lastScanAt = ref<number | undefined>(undefined);
const lastScanFiles = ref(0);
const scanning = ref(false);

const verifying = ref(false);
const saving = ref(false);

let pollTimer: ReturnType<typeof setInterval> | undefined;

const toast = (
  message: string,
  variant: "success" | "error" | "warning" | "info",
) => {
  sdk.window.showToast(message, { variant, duration: 3500 });
};

const applyStats = (stats: Stats) => {
  binaryOk.value = stats.binaryOk;
  binaryVersion.value = stats.binaryVersion;
  binaryError.value = stats.binaryError;
  pendingFiles.value = stats.pendingFiles;
  totalFindings.value = stats.totalFindings;
  lastScanAt.value = stats.lastScanAt;
  lastScanFiles.value = stats.lastScanFiles;
  scanning.value = stats.scanning;
};

const refreshStats = async () => {
  try {
    const stats = (await sdk.backend.getStats()) as Stats;
    applyStats(stats);
  } catch {
    /* ignore transient errors */
  }
};

const loadSettingsFromBackend = async () => {
  try {
    const current = (await sdk.backend.getSettings()) as Settings;
    binaryPath.value = current.binaryPath;
    onlyVerified.value = current.onlyVerified;
  } catch (err) {
    toast(`Failed to load settings: ${String(err)}`, "error");
  }
};

const onBinaryPathSave = async () => {
  const value = binaryPath.value.trim();
  if (value.length === 0) {
    toast("Please enter a TruffleHog binary path.", "warning");
    return;
  }

  saving.value = true;
  try {
    const result = await sdk.backend.setBinaryPath(value);
    await refreshStats();
    if (result.ok) {
      toast(
        `Binary saved (${result.version.length > 0 ? result.version : "unknown version"}).`,
        "success",
      );
    } else {
      toast(`Verification failed: ${result.error}`, "error");
    }
  } catch (err) {
    toast(`Failed to save the binary path: ${String(err)}`, "error");
  } finally {
    saving.value = false;
  }
};

const onVerifyBinary = async () => {
  verifying.value = true;
  try {
    const result = await sdk.backend.verifyBinary();
    await refreshStats();
    if (result.ok) {
      toast(
        `Binary verified (${result.version.length > 0 ? result.version : "unknown version"}).`,
        "success",
      );
    } else {
      toast(`Verification failed: ${result.error}`, "error");
    }
  } catch (err) {
    toast(`Verification failed: ${String(err)}`, "error");
  } finally {
    verifying.value = false;
  }
};

const onOnlyVerifiedChange = async (next: boolean) => {
  onlyVerified.value = next;
  try {
    await sdk.backend.setOnlyVerified(next);
    toast(`Verified-only findings ${next ? "enabled" : "disabled"}.`, "info");
  } catch (err) {
    toast(`Failed to update the filter: ${String(err)}`, "error");
  }
};

const lastScanLabel = computed(() => {
  if (lastScanAt.value === undefined) return "never";
  const seconds = Math.max(
    0,
    Math.round((Date.now() - lastScanAt.value) / 1000),
  );
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
});

const binaryStatusLabel = computed(() => {
  if (binaryOk.value) {
    return binaryVersion.value.length > 0 ? binaryVersion.value : "ready";
  }
  return binaryError.value.length > 0 ? "error" : "not verified";
});

const binaryStatusSeverity = computed(() =>
  binaryOk.value ? "success" : "danger",
);

const scannerStateLabel = computed(() => {
  if (!binaryOk.value) return "idle";
  if (scanning.value) return "scanning";
  return "waiting";
});

const scannerStateSeverity = computed(() => {
  if (!binaryOk.value) return "secondary";
  if (scanning.value) return "info";
  return "success";
});

onMounted(async () => {
  await loadSettingsFromBackend();
  await refreshStats();
  pollTimer = setInterval(() => {
    void refreshStats();
  }, STATS_POLL_MS);
});

onBeforeUnmount(() => {
  if (pollTimer !== undefined) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
});
</script>

<template>
  <div class="h-full p-4">
    <Card class="h-full bg-surface-700">
      <template #title>
        <div class="flex items-center gap-3">
          <i class="fas fa-dog text-secondary-400" />
          <span>TruffleHog Scanner</span>
        </div>
      </template>
      <template #subtitle>
        <span class="text-surface-400">
          Passive scanner that pipes intercepted HTTP responses through the
          TruffleHog binary and emits findings into Caido.
        </span>
      </template>
      <template #content>
        <Tabs v-model:value="activeTab">
          <TabList>
            <Tab value="status">
              <div class="flex items-center gap-2">
                <i class="fas fa-chart-line" />
                <span>Status</span>
              </div>
            </Tab>
            <Tab value="settings">
              <div class="flex items-center gap-2">
                <i class="fas fa-sliders-h" />
                <span>Settings</span>
              </div>
            </Tab>
          </TabList>
          <TabPanels>
            <TabPanel value="status">
              <div class="flex flex-col gap-4 p-2">
                <Message v-if="!binaryOk" severity="warn" :closable="false">
                  TruffleHog binary not verified. Open the
                  <strong>Settings</strong> tab and configure a valid path.
                </Message>

                <div
                  class="grid gap-3"
                  style="
                    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
                  "
                >
                  <div
                    class="flex flex-col gap-1 rounded-md bg-surface-800 p-3 border border-surface-700"
                  >
                    <span
                      class="text-xs uppercase tracking-wide text-surface-400"
                    >
                      Binary
                    </span>
                    <Tag
                      :value="binaryStatusLabel"
                      :severity="binaryStatusSeverity"
                      class="self-start"
                    />
                  </div>
                  <div
                    class="flex flex-col gap-1 rounded-md bg-surface-800 p-3 border border-surface-700"
                  >
                    <span
                      class="text-xs uppercase tracking-wide text-surface-400"
                    >
                      State
                    </span>
                    <Tag
                      :value="scannerStateLabel"
                      :severity="scannerStateSeverity"
                      class="self-start"
                    />
                  </div>
                  <div
                    class="flex flex-col gap-1 rounded-md bg-surface-800 p-3 border border-surface-700"
                  >
                    <span
                      class="text-xs uppercase tracking-wide text-surface-400"
                    >
                      Findings
                    </span>
                    <span class="text-xl font-semibold text-surface-100">
                      {{ totalFindings }}
                    </span>
                  </div>
                  <div
                    class="flex flex-col gap-1 rounded-md bg-surface-800 p-3 border border-surface-700"
                  >
                    <span
                      class="text-xs uppercase tracking-wide text-surface-400"
                    >
                      Pending
                    </span>
                    <span class="text-xl font-semibold text-surface-100">
                      {{ pendingFiles }}
                    </span>
                  </div>
                  <div
                    class="flex flex-col gap-1 rounded-md bg-surface-800 p-3 border border-surface-700"
                  >
                    <span
                      class="text-xs uppercase tracking-wide text-surface-400"
                    >
                      Last scan
                    </span>
                    <span class="text-base font-medium text-surface-100">
                      {{ lastScanLabel }}
                    </span>
                  </div>
                  <div
                    class="flex flex-col gap-1 rounded-md bg-surface-800 p-3 border border-surface-700"
                  >
                    <span
                      class="text-xs uppercase tracking-wide text-surface-400"
                    >
                      Last batch
                    </span>
                    <span class="text-base font-medium text-surface-100">
                      {{ lastScanFiles }}
                    </span>
                  </div>
                </div>
              </div>
            </TabPanel>

            <TabPanel value="settings">
              <div class="flex flex-col gap-6 p-2">
                <section class="flex flex-col gap-3">
                  <div class="flex flex-col gap-1">
                    <h3 class="text-base font-semibold text-surface-100 m-0">
                      Binary Path
                    </h3>
                    <p class="text-sm text-surface-400 m-0">
                      Full path to the TruffleHog binary, or just
                      <code class="text-surface-200">trufflehog</code> if it is
                      on PATH.
                    </p>
                  </div>
                  <div class="flex flex-wrap items-center gap-2">
                    <InputText
                      v-model="binaryPath"
                      placeholder="trufflehog"
                      class="flex-1 min-w-[240px]"
                    />
                    <Button
                      label="Save"
                      icon="fas fa-save"
                      :loading="saving"
                      @click="onBinaryPathSave"
                    />
                    <Button
                      label="Verify"
                      icon="fas fa-check-circle"
                      severity="secondary"
                      :loading="verifying"
                      @click="onVerifyBinary"
                    />
                  </div>
                  <Message v-if="binaryOk" severity="success" :closable="false">
                    TruffleHog
                    {{ binaryVersion.length > 0 ? binaryVersion : "ready" }}
                    detected.
                  </Message>
                  <Message
                    v-else-if="binaryError.length > 0"
                    severity="error"
                    :closable="false"
                  >
                    {{ binaryError }}
                  </Message>
                </section>

                <section class="flex flex-col gap-3">
                  <div class="flex flex-col gap-1">
                    <h3 class="text-base font-semibold text-surface-100 m-0">
                      Filtering
                    </h3>
                    <p class="text-sm text-surface-400 m-0">
                      Control which findings are emitted during the scan.
                    </p>
                  </div>
                  <div
                    class="flex items-center justify-between gap-4 rounded-md bg-surface-800 border border-surface-700 p-3"
                  >
                    <div class="flex flex-col gap-1">
                      <span class="text-sm font-medium text-surface-100">
                        Only verified findings
                      </span>
                      <span class="text-xs text-surface-400">
                        Emit only findings TruffleHog could verify live. Disable
                        to include unverified matches.
                      </span>
                    </div>
                    <ToggleSwitch
                      :model-value="onlyVerified"
                      @update:model-value="onOnlyVerifiedChange"
                    />
                  </div>
                </section>
              </div>
            </TabPanel>
          </TabPanels>
        </Tabs>
      </template>
    </Card>
  </div>
</template>
