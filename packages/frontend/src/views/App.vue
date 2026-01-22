<script setup lang="ts">
import { onMounted, ref } from "vue";

import Button from "primevue/button";
import InputText from "primevue/inputtext";

import { useSDK } from "@/plugins/sdk";

type StoredSettings = {
  binaryPath?: string;
  onlyVerified?: boolean;
};

const sdk = useSDK();

const binaryPath = ref("");
const onlyVerified = ref(true);
const statusMessage = ref("");
const statusTone = ref<"info" | "success" | "warning" | "error">("info");

const setStatus = (
  message: string,
  tone: "info" | "success" | "warning" | "error"
) => {
  statusMessage.value = message;
  statusTone.value = tone;
};

const parseSettings = (value: unknown): StoredSettings => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  const settings: StoredSettings = {};

  if (typeof record.binaryPath === "string") {
    settings.binaryPath = record.binaryPath;
  }

  if (typeof record.onlyVerified === "boolean") {
    settings.onlyVerified = record.onlyVerified;
  }

  return settings;
};

const applySettings = (settings: StoredSettings) => {
  if (settings.binaryPath !== undefined) {
    binaryPath.value = settings.binaryPath;
  }

  if (settings.onlyVerified !== undefined) {
    onlyVerified.value = settings.onlyVerified;
  }
};

const persistSettings = async () => {
  await sdk.storage.set({
    binaryPath: binaryPath.value.trim(),
    onlyVerified: onlyVerified.value,
  });
};

const syncBackend = async (settings: StoredSettings) => {
  if (typeof settings.binaryPath === "string") {
    const value = settings.binaryPath.trim();
    if (value.length > 0) {
      await sdk.backend.setBinaryPath(value);
    }
  }

  if (typeof settings.onlyVerified === "boolean") {
    await sdk.backend.setOnlyVerified(settings.onlyVerified);
  }
};

const onBinaryPathSave = async () => {
  const value = binaryPath.value.trim();
  if (!value) {
    setStatus("Please enter a TruffleHog binary path.", "warning");
    return;
  }

  try {
    await sdk.backend.setBinaryPath(value);
    await persistSettings();
    setStatus(`Binary path saved: ${value}`, "success");
  } catch (err) {
    setStatus(`Failed to save the binary path: ${String(err)}`, "error");
  }
};

const onOnlyVerifiedChange = async () => {
  try {
    await sdk.backend.setOnlyVerified(onlyVerified.value);
    await persistSettings();
    setStatus(
      `Verified-only findings ${onlyVerified.value ? "enabled" : "disabled"}.`,
      "info"
    );
  } catch (err) {
    setStatus(`Failed to update the filter: ${String(err)}`, "error");
  }
};

const storedSettings = parseSettings(sdk.storage.get());
applySettings(storedSettings);

sdk.storage.onChange((value) => {
  applySettings(parseSettings(value));
});

onMounted(() => {
  void syncBackend(storedSettings);
});
</script>

<template>
  <div class="cr-page">
    <div class="cr-shell">
      <div class="cr-hero">
        <div class="cr-topbar">TruffleHog</div>
        <h1 class="cr-title">TruffleHog Scanner</h1>
        <p class="cr-subtitle">
          Connect your TruffleHog binary and choose how findings are filtered.
        </p>
      </div>

      <div
        v-if="statusMessage"
        :class="['cr-status', `cr-status--${statusTone}`]"
      >
        {{ statusMessage }}
      </div>

      <div class="cr-grid">
        <section class="cr-card">
          <div class="cr-card__header">
            <h2>Binary Path</h2>
            <p>Set the full path to the TruffleHog binary on this host.</p>
          </div>
          <div class="cr-card__body">
            <div class="flex gap-2 items-center">
              <InputText
                v-model="binaryPath"
                placeholder="/opt/homebrew/bin/trufflehog"
                class="flex-1"
              />
              <Button
                label="Save Path"
                icon="pi pi-save"
                @click="onBinaryPathSave"
              />
            </div>
          </div>
        </section>

        <section class="cr-card">
          <div class="cr-card__header">
            <h2>Filtering</h2>
            <p>Control which findings are emitted during the scan.</p>
          </div>
          <div class="cr-card__body">
            <label class="cr-option">
              <input
                v-model="onlyVerified"
                type="checkbox"
                @change="onOnlyVerifiedChange"
              />
              <span class="cr-option__text">
                <span class="cr-option__title">Only verified findings</span>
                <span class="cr-option__hint">
                  Emit findings that TruffleHog marked as verified.
                </span>
              </span>
            </label>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
