export const SETTINGS_ACTION_TYPE = {
  MOCK: "mock",
  LOCAL_ONLY: "local_only",
  BACKEND_ENDPOINT: "backend_endpoint",
};

export const SETTINGS_ACTION_TYPES = {
  chartAppearance: {
    type: SETTINGS_ACTION_TYPE.LOCAL_ONLY,
    label: "本地 only",
    description: "Theme, colors, and timezone are persisted in browser storage and applied to the document/chart view.",
  },
  cacheLimitSync: {
    type: SETTINGS_ACTION_TYPE.BACKEND_ENDPOINT,
    label: "真实 backend endpoint",
    description: "Cache limit changes are persisted locally and synchronized through /settings/cache-limits.",
  },
  proxySettings: {
    type: SETTINGS_ACTION_TYPE.BACKEND_ENDPOINT,
    label: "真实 backend endpoint",
    description: "Proxy load, save, and test actions call the backend proxy settings endpoints.",
  },
  exchangeRegistry: {
    type: SETTINGS_ACTION_TYPE.BACKEND_ENDPOINT,
    label: "真实 backend endpoint",
    description: "Exchange registry refresh reads backend exchange plugin metadata.",
  },
  storageRepair: {
    type: SETTINGS_ACTION_TYPE.BACKEND_ENDPOINT,
    label: "真实 backend endpoint",
    description: "Storage repair and gap scan actions call backend maintenance endpoints.",
  },
  databaseTools: {
    type: SETTINGS_ACTION_TYPE.MOCK,
    label: "mock",
    description: "Database inventory, scan, backfill, and delete actions use the current mock database tool service.",
  },
};