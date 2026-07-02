export function buildSettingsPanelViewModel({ view, actions }) {
  return {
    appearance: view.appearance,
    network: {
      ...view.proxy,
      ...actions.proxy,
    },
    exchanges: {
      ...view.exchanges,
      ...actions.exchanges,
    },
    data: {
      cacheLimits: {
        ...view.cacheLimits,
        ...actions.cacheLimits,
      },
      cacheDiagnostics: {
        ...view.cacheDiagnostics,
        ...actions.cacheDiagnostics,
      },
      maintenance: {
        ...view.maintenance,
        ...actions.maintenance,
      },
    },
    database: view.database,
    about: {},
  };
}
