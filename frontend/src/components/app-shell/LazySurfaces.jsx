import React from "react";

const SettingsModal = React.lazy(() => import("../SettingsModal"));
const IndicatorPanel = React.lazy(() => import("../IndicatorPanel"));
const AlertsPanel = React.lazy(() => import("../alerts/AlertsPanel"));

export default function LazySurfaces({
  indicatorPanel,
  alertsPanel,
  settingsModal,
}) {
  return (
    <>
      {indicatorPanel.isOpen && (
        <React.Suspense fallback={null}>
          <IndicatorPanel {...indicatorPanel} />
        </React.Suspense>
      )}

      {alertsPanel.isOpen && (
        <React.Suspense fallback={null}>
          <AlertsPanel {...alertsPanel} />
        </React.Suspense>
      )}

      {settingsModal.isOpen && (
        <React.Suspense fallback={null}>
          <SettingsModal {...settingsModal} />
        </React.Suspense>
      )}
    </>
  );
}
