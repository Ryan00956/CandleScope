import { useSyncExternalStore } from "react";
import { getLocale, subscribeLocale, type LocaleId } from "./locale.js";

export function useLocale(): LocaleId {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}
