export interface ReplayOrderCtaStateInput {
  readonly permanentlyUnavailable: boolean;
  readonly transientlyBlocked: boolean;
  readonly submitting: boolean;
}

export interface ReplayOrderCtaState {
  readonly disabled: boolean;
  readonly ariaDisabled: boolean;
}

/**
 * Keep the order CTA visually stable while an unrelated replay command or
 * advisory refresh is in flight. Those transient states still block activation
 * through aria-disabled and the click guard, but only a real order submission
 * or a durable validation failure uses the native disabled appearance.
 */
export function replayOrderCtaState({
  permanentlyUnavailable,
  transientlyBlocked,
  submitting,
}: ReplayOrderCtaStateInput): ReplayOrderCtaState {
  const disabled = permanentlyUnavailable || submitting;
  return {
    disabled,
    ariaDisabled: disabled || transientlyBlocked,
  };
}
