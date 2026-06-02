export function buildIntervalSelectorViewModel({ sessionActions, sessionView }) {
  const {
    interval,
    nativeIntervals,
    intervalGroups,
    customIntervalRecords,
    savedCustomIntervals,
    intervalNotice,
  } = sessionView;

  return {
    interval,
    nativeIntervals,
    intervalGroups,
    customIntervalRecords,
    savedCustomIntervals,
    onSelectInterval: sessionActions.selectInterval,
    onCreateCustomInterval: sessionActions.createCustomInterval,
    onRemoveCustomInterval: sessionActions.removeCustomInterval,
    onRestoreCustomInterval: sessionActions.restoreCustomInterval,
    onTogglePinCustomInterval: sessionActions.togglePinCustomInterval,
    onClearCustomIntervals: sessionActions.clearCustomIntervals,
    intervalNotice,
  };
}
