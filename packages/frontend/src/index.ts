import { Classic } from "@caido/primevue";
import PrimeVue from "primevue/config";
import { createApp } from "vue";

import { SDKPlugin } from "./plugins/sdk";
import "./styles/index.css";

import type { FrontendSDK } from "./types";
import App from "./views/App.vue";

const pluginId = "trufflehog-caido";
const STYLES_ID = "trufflehog-caido-theme";

const ensureStyles = () => {
  if (document.getElementById(STYLES_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = STYLES_ID;
  style.textContent = `
    .cr-page {
      --cr-bg-1: #f4efe6;
      --cr-bg-2: #f6f1dc;
      --cr-ink-1: #1f1d1a;
      --cr-ink-2: #5a534a;
      --cr-accent-1: #c67a3a;
      --cr-accent-2: #315d6a;
      min-height: 100%;
      padding: 28px;
      color: var(--cr-ink-1);
      font-family: "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
      background:
        radial-gradient(1200px 400px at 10% -10%, rgba(198, 122, 58, 0.2), transparent 60%),
        radial-gradient(800px 300px at 90% 0%, rgba(49, 93, 106, 0.18), transparent 55%),
        linear-gradient(135deg, var(--cr-bg-1), var(--cr-bg-2));
    }

    .cr-shell {
      max-width: 900px;
      margin: 0 auto;
      display: grid;
      gap: 18px;
    }

    .cr-hero {
      display: grid;
      gap: 6px;
    }

    .cr-title {
      margin: 0;
      font-size: 28px;
      letter-spacing: 0.4px;
    }

    .cr-subtitle {
      margin: 0;
      color: var(--cr-ink-2);
      font-size: 14px;
      max-width: 520px;
    }

    .cr-topbar {
      font-weight: 600;
      letter-spacing: 0.3px;
    }

    .cr-status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      width: fit-content;
      background: rgba(255, 255, 255, 0.65);
      border: 1px solid rgba(0, 0, 0, 0.06);
      box-shadow: 0 10px 24px rgba(31, 29, 26, 0.12);
      animation: cr-rise 280ms ease both;
    }

    .cr-status--info {
      color: var(--cr-accent-2);
    }

    .cr-status--success {
      color: #2f6b3c;
    }

    .cr-status--warning {
      color: #9a5b1b;
    }

    .cr-status--error {
      color: #b4432a;
    }

    .cr-grid {
      display: grid;
      gap: 16px;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    }

    .cr-card {
      background: rgba(255, 255, 255, 0.76);
      border: 1px solid rgba(0, 0, 0, 0.05);
      border-radius: 18px;
      padding: 18px 20px;
      box-shadow: 0 18px 38px rgba(31, 29, 26, 0.12);
      backdrop-filter: blur(8px);
      animation: cr-rise 320ms ease both;
    }

    .cr-card__header h2 {
      margin: 0;
      font-size: 16px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .cr-card__header p {
      margin: 8px 0 0;
      font-size: 13px;
      color: var(--cr-ink-2);
    }

    .cr-card__body {
      margin-top: 14px;
      display: grid;
      gap: 12px;
    }

    .cr-option {
      display: grid;
      grid-template-columns: 20px 1fr;
      gap: 12px;
      align-items: start;
      padding: 10px 0;
      border-bottom: 1px dashed rgba(0, 0, 0, 0.1);
      cursor: pointer;
    }

    .cr-option:last-child {
      border-bottom: none;
      padding-bottom: 0;
    }

    .cr-option input {
      margin-top: 4px;
      width: 16px;
      height: 16px;
      accent-color: var(--cr-accent-1);
    }

    .cr-option__text {
      display: grid;
      gap: 4px;
    }

    .cr-option__title {
      font-weight: 600;
      font-size: 14px;
    }

    .cr-option__hint {
      font-size: 12px;
      color: var(--cr-ink-2);
    }

    @keyframes cr-rise {
      from {
        opacity: 0;
        transform: translateY(10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    @media (max-width: 640px) {
      .cr-page {
        padding: 20px;
      }

      .cr-title {
        font-size: 24px;
      }
    }
  `;

  document.head.appendChild(style);
};

export const init = (sdk: FrontendSDK) => {
  ensureStyles();
  const app = createApp(App);

  app.use(PrimeVue, {
    unstyled: true,
    pt: Classic,
  });

  app.use(SDKPlugin, sdk);

  const root = document.createElement("div");
  Object.assign(root.style, {
    height: "100%",
    width: "100%",
  });

  root.id = `plugin--${pluginId}`;
  app.mount(root);

  sdk.navigation.addPage("/trufflehog", {
    body: root,
  });

  sdk.sidebar.registerItem("TruffleHog", "/trufflehog", {
    icon: "fas fa-dog",
  });
};
