import React from "react";
import {
  loadAlertsPanel,
  loadIndicatorPanel,
  loadSettingsModal,
} from "./lazySurfaceLoaders";
import type { AlertsPanelProps } from "../components/alerts/AlertsPanel.js";
import type { IndicatorPanelProps } from "../features/indicators/IndicatorPanel.js";
import type { SettingsModalProps } from "../features/settings/SettingsModal.js";

export interface LazyFeatureSurfaceModels {
  indicatorPanel: IndicatorPanelProps;
  alertsPanel: AlertsPanelProps;
  settingsModal: SettingsModalProps;
}

export interface LazyFeatureSurfacesProps {
  surfaces: LazyFeatureSurfaceModels;
}

const SettingsModal = React.lazy(loadSettingsModal);
const IndicatorPanel = React.lazy(loadIndicatorPanel);
const AlertsPanel = React.lazy(loadAlertsPanel);

export default function LazyFeatureSurfaces({ surfaces }: LazyFeatureSurfacesProps) {
  const { indicatorPanel, alertsPanel, settingsModal } = surfaces;

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
