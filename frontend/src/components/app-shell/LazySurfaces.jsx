import React from "react";
import {
  loadAlertsPanel,
  loadIndicatorPanel,
  loadSettingsModal,
} from "./lazySurfaceLoaders";

const SettingsModal = React.lazy(loadSettingsModal);
const IndicatorPanel = React.lazy(loadIndicatorPanel);
const AlertsPanel = React.lazy(loadAlertsPanel);

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
