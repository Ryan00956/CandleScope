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
      maintenance: {
        ...view.maintenance,
        ...actions.maintenance,
      },
    },
    database: view.database,
    about: {},
  };
}
